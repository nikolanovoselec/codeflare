import { sendNotification } from 'edgepush';
import { getPushSubPrefix } from './kv-keys';
import type { Session } from '../types';

export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_AGENT_EVENTS_PER_SEND = 8;

const PUSH_TTL_SECONDS = 3_600;
const MAX_SESSION_NAME_BYTES = 64;
const SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/;
const AGENT_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const P256DH_PATTERN = /^B[A-Za-z0-9_-]{86}$/;
const AUTH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ALLOWED_PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

type AgentEventKind = 'input-required' | 'task-completed' | 'task-failed';
type PushAgentName = 'Pi' | 'Claude Code';

export interface AgentEventForPush {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly kind: AgentEventKind;
  readonly createdAt: number;
}

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
  readonly createdAt: number;
}

interface VapidConfiguration {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface SendAgentEventPushesOptions {
  readonly kv: KVNamespace;
  readonly bucketName: string;
  readonly session: Session;
  readonly events: readonly AgentEventForPush[];
  readonly vapid: VapidConfiguration;
}

export interface SendAgentEventPushesResult {
  readonly sentEventIds: readonly string[];
}

interface SelectedSubscription {
  readonly key: string;
  readonly record: PushSubscriptionRecord | undefined;
}

function containsControlCharacter(value: string): boolean {
  return /\p{Cf}/u.test(value) || [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function resolveSessionIdentity(session: Session): {
  readonly agent: PushAgentName;
  readonly sessionName: string;
  readonly sessionPath: string;
} | undefined {
  const agent: PushAgentName | undefined = session.agentType === 'pi'
    ? 'Pi'
    : session.agentType === 'claude-code'
      ? 'Claude Code'
      : undefined;
  if (
    !agent
    || typeof session.id !== 'string'
    || !SESSION_ID_PATTERN.test(session.id)
    || typeof session.name !== 'string'
    || session.name.length === 0
    || containsControlCharacter(session.name)
    || new TextEncoder().encode(session.name).byteLength > MAX_SESSION_NAME_BYTES
  ) {
    return undefined;
  }
  return {
    agent,
    sessionName: session.name,
    sessionPath: `/app/session/${session.id}`,
  };
}

function isAgentEvent(value: AgentEventForPush): boolean {
  return typeof value === 'object'
    && value !== null
    && value.schemaVersion === 1
    && AGENT_EVENT_ID_PATTERN.test(value.eventId)
    && (
      value.kind === 'input-required'
      || value.kind === 'task-completed'
      || value.kind === 'task-failed'
    )
    && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0;
}

function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return endpoint.trim() === endpoint
      && !/[\u0000-\u001f\u007f]/.test(endpoint)
      && new TextEncoder().encode(endpoint).byteLength <= 2 * 1024
      && url.protocol === 'https:'
      && ALLOWED_PUSH_HOSTS.has(url.hostname)
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.hash === ''
      && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function isPushSubscriptionRecord(value: unknown): value is PushSubscriptionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PushSubscriptionRecord>;
  return typeof candidate.endpoint === 'string'
    && isAllowedEndpoint(candidate.endpoint)
    && typeof candidate.keys === 'object'
    && candidate.keys !== null
    && typeof candidate.keys.p256dh === 'string'
    && P256DH_PATTERN.test(candidate.keys.p256dh)
    && typeof candidate.keys.auth === 'string'
    && AUTH_PATTERN.test(candidate.keys.auth)
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt);
}

async function readSelectedSubscriptions(
  kv: KVNamespace,
  bucketName: string,
): Promise<SelectedSubscription[]> {
  const prefix = getPushSubPrefix(bucketName);
  let listedKeys: KVNamespaceListKey<unknown>[];
  try {
    const listed = await kv.list({ prefix, limit: MAX_PUSH_SUBSCRIPTIONS_PER_USER });
    listedKeys = listed.keys;
  } catch {
    return [];
  }

  const names = [...new Set(listedKeys.map(({ name }) => name))]
    .filter((name) => name.startsWith(prefix))
    .sort()
    .slice(0, MAX_PUSH_SUBSCRIPTIONS_PER_USER);
  const selected: SelectedSubscription[] = [];
  for (const key of names) {
    let value: unknown;
    try {
      value = await kv.get(key, 'json');
    } catch {
      value = undefined;
    }
    selected.push({
      key,
      record: isPushSubscriptionRecord(value) ? value : undefined,
    });
  }
  selected.sort((left, right) => {
    if (!left.record || !right.record) {
      if (left.record) return -1;
      if (right.record) return 1;
    } else {
      const createdAtOrder = left.record.createdAt - right.record.createdAt;
      if (createdAtOrder !== 0) return createdAtOrder;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  return selected;
}

function selectEvents(events: readonly AgentEventForPush[]): AgentEventForPush[] {
  const selected: AgentEventForPush[] = [];
  const seen = new Set<string>();
  for (const candidate of events.slice(0, MAX_AGENT_EVENTS_PER_SEND)) {
    if (!isAgentEvent(candidate) || seen.has(candidate.eventId)) continue;
    seen.add(candidate.eventId);
    selected.push(candidate);
  }
  return selected;
}

async function processSubscription(
  kv: KVNamespace,
  subscription: SelectedSubscription,
  payload: string,
  event: AgentEventForPush,
  vapid: VapidConfiguration,
): Promise<'processed' | 'expired' | 'transient'> {
  if (!subscription.record) return 'transient';

  try {
    const result = await sendNotification(subscription.record, payload, {
      vapid,
      ttl: PUSH_TTL_SECONDS,
      urgency: event.kind === 'input-required' ? 'high' : 'normal',
    });
    if (result.expired || result.status === 404 || result.status === 410) {
      try {
        await kv.delete(subscription.key);
      } catch {
        // The provider's terminal response still processes this event. A later
        // delivery can retry best-effort cleanup without exposing capability data.
      }
      return 'expired';
    }
    return result.status >= 200 && result.status < 300 ? 'processed' : 'transient';
  } catch {
    // edgepush errors may include provider response or endpoint capability data.
    // Keep the subscription and event unacknowledged without logging the error.
    return 'transient';
  }
}

export async function sendAgentEventPushes(
  options: SendAgentEventPushesOptions,
): Promise<SendAgentEventPushesResult> {
  const identity = resolveSessionIdentity(options.session);
  const events = selectEvents(options.events);
  if (!identity || events.length === 0) return { sentEventIds: [] };

  const subscriptions = await readSelectedSubscriptions(options.kv, options.bucketName);
  if (subscriptions.length === 0) return { sentEventIds: [] };

  const sentEventIds: string[] = [];
  const expiredSubscriptionKeys = new Set<string>();
  for (const event of events) {
    const payload = JSON.stringify({
      v: 1,
      eventId: event.eventId,
      kind: event.kind,
      sessionPath: identity.sessionPath,
      sessionName: identity.sessionName,
      agent: identity.agent,
      createdAt: event.createdAt,
    });
    let fullyProcessed = true;
    for (const subscription of subscriptions) {
      if (expiredSubscriptionKeys.has(subscription.key)) continue;
      const outcome = await processSubscription(
        options.kv,
        subscription,
        payload,
        event,
        options.vapid,
      );
      if (outcome === 'expired') expiredSubscriptionKeys.add(subscription.key);
      if (outcome === 'transient') fullyProcessed = false;
    }
    if (fullyProcessed) sentEventIds.push(event.eventId);
  }
  return { sentEventIds };
}
