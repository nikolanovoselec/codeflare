/**
 * container-metrics — Metrics collection, idle detection, and Timekeeper pings.
 *
 * Extracted from Container DO (index.ts) to reduce file size.
 * All functions receive explicit state/context parameters instead of `this`.
 */
import type { Env, Session } from '../types';
import { TERMINAL_SERVER_PORT } from '../lib/constants';
import { createLogger } from '../lib/logger';
import { D1SessionRepository, type D1Session } from '../lib/session-repository';
import { normalizeTrackedClones } from '../lib/clone-targets';
import { isSaasModeActive } from '../lib/onboarding';
import {
  AGENT_EVENT_PUSH_BUDGET_MS,
  sendAgentEventPushes,
  type AgentEventForPush,
} from '../lib/push-sender';

const SESSION_ID_KEY = '_sessionId';
export const FINAL_SYNC_AUDIT_KEY = 'finalSyncAudit';
const logger = createLogger('container-metrics');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable state fields that metrics collection needs to read/write. */
export interface MetricsState {
  _bucketName: string | null;
  _sessionId: string | null;
  _userEmail: string | null;
  _containerAuthToken: string | null;
  _usageSeconds: number;
  containerStartedAt: number;
  lastSeenInputAt: number | null;
}

/** Callbacks provided by the Container class for idle detection + scheduling. */
export interface MetricsCallbacks {
  stop: (signal: number | string) => Promise<void>;
  schedule: (delaySec: number, method: string) => Promise<unknown>;
  /** Cached value from class field. collectMetrics re-reads storage as the
   *  authoritative source on every tick to avoid drift from stale caches. */
  idleTimeoutPref: string;
  /** Update the in-memory cache after a fresh storage read. */
  setIdleTimeoutPref: (next: string) => void;
  terminateUnreachable: (session: D1Session, execution: MetricsExecution) => Promise<boolean>;
}

/** SDK schedule payload: an old alarm is never rebound to the latest D1 generation. */
export interface MetricsPin {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly generation: number;
}
export interface MetricsExecution extends MetricsPin {
  readonly runtime: NonNullable<DurableObjectState['container']>;
  readonly sequence: number;
  readonly authToken: string | null;
  readonly isCurrent: () => boolean;
  readonly onHostResponse?: () => Promise<void>;
}

/** Reserve observation order before any host or D1 observation can yield. */
export async function captureMetricsExecution(ctx: DurableObjectState, expected?: MetricsPin,
  isCurrent: () => boolean = () => true): Promise<MetricsExecution | null> {
  const runtime = ctx.container;
  if (!runtime) return null;
  return ctx.storage.transaction(async txn => {
    const ownerKey = await txn.get<string>('bucketName');
    const sessionId = await txn.get<string>(SESSION_ID_KEY);
    const generation = await txn.get<number>('lifecycleGeneration');
    if (!ownerKey || !sessionId || !Number.isSafeInteger(generation) || generation === undefined
      || !isCurrent() || (expected && (expected.ownerKey !== ownerKey || expected.sessionId !== sessionId
        || expected.generation !== generation))) return null;
    const previous = await txn.get<number>('observationSequence') ?? -1;
    const authToken = await txn.get<string>('containerAuthToken') ?? null;
    if (!Number.isSafeInteger(previous) || previous < -1 || !isCurrent()) return null;
    const sequence = previous + 1;
    await txn.put('observationSequence', sequence);
    return { ownerKey, sessionId, generation, sequence, runtime, authToken,
      isCurrent: () => ctx.container === runtime && isCurrent() };
  });
}

// ---------------------------------------------------------------------------
// parseSleepAfterMs
// ---------------------------------------------------------------------------

/** Parse configured hour durations and retained legacy minute durations to milliseconds.
 *
 * Fail-safe direction: an unrecognized or malformed string returns the maximum
 * supported timeout (12h) rather than the minimum. A short fallback would cause
 * the container to die early when the pref is missing/corrupted; a long
 * fallback only causes the container to live slightly longer than the user
 * expected. Errs on the side of preserving user work over saving compute.
 *
 * The validated regex `/^(5m|15m|30m|1h|2h|4h|8h|12h)$/` at the storage write site means
 * this fallback should only ever fire on truly broken input. Log it loudly
 * (caller logs). NOTE: '5m' is retired from the settable picker
 * (REQ-SESSION-014) but stays in the accept-set so a pre-existing 5m pref keeps
 * its original timeout instead of resetting to the fail-safe.
 *
 */
// DO-storage key holding the wall-clock ms at which the container first read
// not-running in an unbroken streak. Persisted (not in-memory) so it survives
// the DO hibernation/reset that itself triggers the transient false reading.
const NOT_RUNNING_SINCE_KEY = 'metricsNotRunningSince';
// DO-storage key marking that a deliberate stop (destroy(), user Stop/Delete)
// is in flight. The self-heal reads it to tell a falsely-stopped live session
// (heal it back to running) from a deliberately-stopping one (leave it
// stopped). PERSISTED, not an in-memory field, for the same reason the
// not-running window is: destroy() can be interrupted by a DO eviction whose
// reconstructed instance would reset any in-memory flag to 0, and the surviving
// metrics alarm would then resurrect a session the user just stopped. destroy()
// sets this before it clears identifiers; onStart() clears it on a fresh start.
export const SHUTDOWN_REQUESTED_KEY = 'shutdownRequested';
// The not-running timestamp is diagnostic only. Even a long sequence of false
// SDK readings after DO reconstruction cannot prove the process exited.

// A running process is not proof that the Durable Object can still reach it.
// Cloudflare's Containers SDK already resets the DO during startup when the
// Worker is stuck with a failed connection to container services. The running
// proxy path does not: it can leave ctx.container.running=true while every port
// fetch times out forever. Persist the streak across DO hibernation and reset
// the DO after three ticks where neither route on the shared host server responds.
export const TRANSPORT_FAILURE_STREAK_KEY = 'metricsTransportFailureStreak';
export const TRANSPORT_RECOVERY_KEY = 'metricsTransportRecovery';
const TRANSPORT_FAILURE_ABORT_THRESHOLD = 3;
const TRANSPORT_FAILURE_RETRY_SECONDS = 5;
const TRANSPORT_RECOVERY_MAX_ATTEMPTS = 2;
const TRANSPORT_ABORT_REASON = 'container transport unresponsive after 3 complete probe failures';

// Budget the DO gives the in-container final sync (drainFinalSync) to complete
// before a stop (REQ-SESSION-011 AC4). 120s pairs with the 135s teardown
// hard-cap in destroy() (120s sync + 15s for the actual stop). The host
// server's /internal/final-sync poll cap (INTERNAL_TIMEOUT_MS, 125s) MUST stay
// strictly ABOVE this budget so the DO's AbortSignal — not the host loop — is
// the authoritative ceiling (see host/src/server.ts). Raising this budget
// requires raising that host cap in lockstep; final-sync-endpoint.test.js guards
// the host > DO ordering against a silent re-inversion.
export const FINAL_SYNC_BUDGET_MS = 120_000;

/**
 * Ceiling on a single in-container poll (/activity, /health) from the metrics
 * alarm.
 *
 * These awaits used to be unbounded, and that is how a wedged container killed
 * the watchdog built to notice it. The re-arm is the LAST statement of
 * doCollectMetrics and schedule() is one-shot, so a poll that never settles
 * never re-arms, and nothing else does: onStart only runs on a fresh container
 * start, and onError only fires when the SDK monitor sees the container exit —
 * neither happens for a container that is wedged but still `running`. Observed
 * in prod 2026-07-27: the 12:33:53 tick entered and emitted neither its success
 * log nor the 'activity check failed' warning the catch below produces, proving
 * it hung rather than threw; the session then ran 28 minutes with no idle
 * detection and no health loop until the DO was aborted outright.
 *
 * A bound converts that hang into a rejection, which the existing catch already
 * routes to the re-arm at the foot of the function. Well above a healthy
 * container's sub-second answer, well under the 60s alarm cadence, so a slow
 * poll costs one skipped reading rather than the loop.
 */
export const CONTAINER_POLL_BUDGET_MS = 10_000;

/**
 * Issue one in-container poll under the budget above.
 *
 * Aborting is enough on its own here: drainFinalSync bounds the SAME
 * getTcpPort(8080).fetch path the same way (AbortController + timer, which is
 * what AbortSignal.timeout is), and that path is production-proven under
 * REQ-SESSION-011. So no second racing timer — a backstop against a mechanism
 * the codebase already depends on would be speculative, and it would also make
 * the test pass for the wrong reason.
 */
function pollContainer(
  port: { fetch: (url: string, init?: RequestInit) => Promise<Response> },
  url: string,
  budgetMs: number,
  containerAuthToken: string | null,
): Promise<Response> {
  const headers = containerAuthToken ? { Authorization: `Bearer ${containerAuthToken}` } : undefined;
  return port.fetch(url, { signal: AbortSignal.timeout(budgetMs), headers });
}

/**
 * Resolve to null if `work` has not settled within the budget.
 *
 * For callees whose transport is not established to honour an abort signal, a
 * timer is the only bound that certainly holds. The abandoned work keeps running;
 * what matters is that the alarm stops waiting on it and reaches its re-arm.
 */
export function raceBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  // A rejection arriving after the timer already won is not a failure of this
  // tick — mark it handled so it cannot surface as an unhandled rejection.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  return Promise.race([work, budget]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Open the not-running confirmation window without writing 'stopped'.
 *
 * Called by onError (container-lifecycle.ts) after a not-running observation.
 * The marker supports logging and retry cadence only; it never authorizes a
 * D1 stopped write. A later successful probe clears the marker.
 */
export async function openNotRunningConfirmation(ctx: DurableObjectState): Promise<void> {
  const since = await ctx.storage.get<number>(NOT_RUNNING_SINCE_KEY);
  if (typeof since !== 'number') {
    await ctx.storage.put(NOT_RUNNING_SINCE_KEY, Date.now());
  }
}

export const SLEEP_AFTER_FALLBACK_MS = 43_200_000; // 12h (the maximum supported sleepAfter option)
export function parseSleepAfterMs(s: string): number {
  if (s.endsWith('h')) {
    const h = parseInt(s, 10);
    if (!Number.isNaN(h) && h > 0) return h * 3_600_000;
  }
  if (s.endsWith('m')) {
    const m = parseInt(s, 10);
    if (!Number.isNaN(m) && m > 0) return m * 60_000;
  }
  logger.warn('parseSleepAfterMs: unrecognized value, falling back to 12h', { input: s });
  return SLEEP_AFTER_FALLBACK_MS;
}

// ---------------------------------------------------------------------------
// drainFinalSync
// ---------------------------------------------------------------------------

/**
 * Drain a final R2 sync while the container is still fully alive, BEFORE any
 * stop (REQ-SESSION-011). Calls the in-container POST /internal/final-sync,
 * which triggers a fresh bisync and blocks until it reaches a terminal status;
 * we await that up to budgetMs via an AbortController.
 *
 * Why this exists: the old design relied on the entrypoint's SIGTERM trap to
 * run the final bisync, but the platform kills the container ~3s after SIGTERM -
 * far short of a bisync that can take up to ~2min under the 15-min cadence - so
 * the trap was cut off and the last edits never reached R2. Syncing here, while
 * the container is alive and the DO holds the teardown open, removes the
 * dependency on the kill grace entirely. Best-effort: any non-OK/timeout/error
 * is logged and swallowed so the caller still proceeds to stop (the 135s
 * teardown hard-cap is the backstop). Mirrors the /health probe's port (8080).
 */
export async function drainFinalSync(ctx: DurableObjectState, budgetMs: number): Promise<void> {
  if (!ctx.container) return;
  if (!ctx.container.running) {
    // Same rationale as the delete path (#516): running can read transiently
    // false on a DO wake / deploy-roll while the container is alive, and
    // skipping the drain there silently drops the last edits on idle/quota
    // stop. Attempt anyway - a genuinely-dead container refuses the connection
    // fast, which is swallowed below.
    logger.warn('drainFinalSync: container reads not-running, attempting drain anyway (possible transient)', { budgetMs });
  }
  const deadline = Date.now() + budgetMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    // Raw port.fetch bypasses the DO's public fetch override (the only place
    // the auth header is injected) and the in-container host 401s /internal/*
    // without a Bearer token - the idle/quota-stop drain failed that way on
    // every stop until this header was added. Unlike the delete path, storage
    // is intact here, so read the token directly.
    let authToken: string | null = null;
    let unavailable = false;
    try {
      const read = await raceBudget(ctx.storage.get<string>('containerAuthToken').then(value => ({ value })), remaining());
      if (read) authToken = read.value ?? null;
      else unavailable = true;
    } catch { unavailable = true; }
    if (!authToken || controller.signal.aborted) {
      const event = { outcome: 'errored', at: Date.now(), running: ctx.container.running,
        reason: unavailable ? 'auth-token-unavailable' : controller.signal.aborted
          ? 'teardown-deadline-exhausted' : 'missing-auth-token' };
      logger.warn('drainFinalSync: authentication unavailable, suppressing final-sync request', event);
      try {
        const audit = await raceBudget(ctx.storage.put(FINAL_SYNC_AUDIT_KEY, event), remaining());
        if (audit === null) logger.warn('drainFinalSync: credential-refusal audit unavailable');
      } catch { logger.warn('drainFinalSync: credential-refusal audit unavailable'); }
      return;
    }
    const port = ctx.container.getTcpPort(8080);
    const res = await port.fetch('http://localhost/internal/final-sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
    if (res.ok) {
      logger.info('drainFinalSync: final sync completed before stop');
    } else {
      logger.warn('drainFinalSync: final sync did not complete, proceeding to stop', { status: res.status });
    }
  } catch (err) {
    logger.warn('drainFinalSync: final sync errored/timed out, proceeding to stop', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface AgentEventDrainRequest {
  readonly ackEventIds: readonly string[];
  readonly final?: true;
}

export interface AgentEventDrainResponse {
  readonly hostNow: number;
  readonly events: readonly AgentEventForPush[];
}

const AGENT_EVENT_DRAIN_MAX = 8;
const AGENT_EVENT_MAX_AGE_MS = 15 * 60_000;
const AGENT_EVENT_DRAIN_RESPONSE_MAX_BYTES = 4 * 1024;
const AGENT_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_EVENT_KINDS = new Set<AgentEventForPush['kind']>([
  'input-required',
  'task-completed',
  'task-failed',
]);

type TrustedTickSession = {
  readonly sessionId: string | undefined;
  readonly bucketName: string | null;
  readonly session: Session | null;
  readonly error?: unknown;
};

type AgentEventDeliveryState = {
  readonly pendingAckIds: Set<string>;
};

// Delivery state is deliberately instance-local and non-durable. The host
// remains the source of truth until its ACK drain succeeds; this cache only
// prevents the same live DO instance from sending an event again while that
// ACK is being retried.
const agentEventDeliveryStates = new WeakMap<MetricsState, AgentEventDeliveryState>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/**
 * Validate the complete host response before any event reaches display-facing
 * code. One invalid or over-cap event rejects the whole batch rather than
 * truncating attacker-controlled input into an apparently valid prefix.
 */
function validateAgentEvents(value: unknown): AgentEventDrainResponse | null {
  if (!isRecord(value)
      || !hasExactKeys(value, ['hostNow', 'events'])
      || typeof value.hostNow !== 'number'
      || !Number.isSafeInteger(value.hostNow)
      || value.hostNow < 0
      || !Array.isArray(value.events)
      || value.events.length > AGENT_EVENT_DRAIN_MAX) {
    return null;
  }

  const hostNow = value.hostNow;
  const events: AgentEventForPush[] = [];
  const eventIds = new Set<string>();
  for (const item of value.events) {
    if (!isRecord(item)
        || !hasExactKeys(item, ['schemaVersion', 'eventId', 'kind', 'createdAt'])
        || item.schemaVersion !== 1
        || typeof item.eventId !== 'string'
        || !AGENT_EVENT_ID_PATTERN.test(item.eventId)
        || eventIds.has(item.eventId)
        || typeof item.kind !== 'string'
        || !AGENT_EVENT_KINDS.has(item.kind as AgentEventForPush['kind'])
        || typeof item.createdAt !== 'number'
        || !Number.isSafeInteger(item.createdAt)) {
      return null;
    }
    const ageMs = hostNow - item.createdAt;
    if (ageMs < 0 || ageMs > AGENT_EVENT_MAX_AGE_MS) return null;

    eventIds.add(item.eventId);
    events.push({
      schemaVersion: 1,
      eventId: item.eventId,
      kind: item.kind as AgentEventForPush['kind'],
      createdAt: item.createdAt,
    });
  }

  return { hostNow, events };
}

async function readBoundedDrainResponse(response: Response): Promise<unknown | null> {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)
        || parsedLength < 0
        || parsedLength > AGENT_EVENT_DRAIN_RESPONSE_MAX_BYTES) {
      return null;
    }
  }

  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > AGENT_EVENT_DRAIN_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Bearer-authenticated, bounded raw-port drain from the running host. */
export async function drainAgentEvents(
  ctx: DurableObjectState,
  budgetMs: number,
  request: AgentEventDrainRequest,
  capturedAuthToken?: string | null,
): Promise<AgentEventDrainResponse | null> {
  const container = ctx.container;
  if (!container || budgetMs <= 0) return null;

  const startedAt = Date.now();
  const remainingBudget = (): number => Math.max(0, budgetMs - (Date.now() - startedAt));
  let authToken = capturedAuthToken ?? null;
  if (capturedAuthToken === undefined) {
    const credentialBudgetMs = remainingBudget();
    if (credentialBudgetMs <= 0) return null;
    try {
      authToken = (await raceBudget(
        ctx.storage.get<string>('containerAuthToken'),
        credentialBudgetMs,
      )) ?? null;
    } catch {
      return null;
    }
  }
  if (!authToken) return null;

  try {
    const fetchBudgetMs = remainingBudget();
    if (fetchBudgetMs <= 0) return null;
    const port = container.getTcpPort(TERMINAL_SERVER_PORT);
    const response = await raceBudget(port.fetch('http://localhost/internal/agent-events/drain', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(fetchBudgetMs),
    }), fetchBudgetMs);
    if (!response?.ok) return null;
    const bodyBudgetMs = remainingBudget();
    if (bodyBudgetMs <= 0) return null;
    const parsed = await raceBudget(readBoundedDrainResponse(response), bodyBudgetMs);
    return validateAgentEvents(parsed);
  } catch {
    return null;
  }
}

async function loadTrustedTickSession(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
): Promise<TrustedTickSession> {
  try {
    const sessionId = await ctx.storage.get<string>(SESSION_ID_KEY);
    const bucketName = state._bucketName || await ctx.storage.get<string>('bucketName') || null;
    const authoritative = sessionId && bucketName
      ? await new D1SessionRepository(env.USAGE_DB).getSession(bucketName, sessionId)
      : null;
    const session: Session | null = authoritative ? {
      id: authoritative.sessionId, name: authoritative.name, userId: authoritative.ownerKey,
      createdAt: authoritative.createdAt, lastAccessedAt: authoritative.lastAccessedAt,
      status: authoritative.lifecycleState === 'running' ? 'running' : 'stopped',
      agentType: authoritative.agentType, workspace: authoritative.workspace,
      terminalMode: authoritative.terminalMode, tabConfig: authoritative.tabConfig, clone: authoritative.clone,
    } : null;
    return { sessionId, bucketName, session };
  } catch (error) {
    return { sessionId: undefined, bucketName: state._bucketName, session: null, error };
  }
}

function deliveryStateFor(state: MetricsState): AgentEventDeliveryState {
  const existing = agentEventDeliveryStates.get(state);
  if (existing) return existing;
  const created: AgentEventDeliveryState = { pendingAckIds: new Set() };
  agentEventDeliveryStates.set(state, created);
  return created;
}

async function deliverRunningAgentEvents(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
): Promise<void> {
  if (!env.VAPID_SUBJECT || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const deliveryState = deliveryStateFor(state);
  const priorAckIds = [...deliveryState.pendingAckIds].slice(0, AGENT_EVENT_DRAIN_MAX);
  const drained = await drainAgentEvents(ctx, CONTAINER_POLL_BUDGET_MS, {
    ackEventIds: priorAckIds,
  });
  if (!drained) return;

  // A valid 2xx response means the host applied the ACK request. Keep the IDs
  // in this tick's filter as defense in depth if a compromised host re-offers
  // them in the same response.
  for (const eventId of priorAckIds) deliveryState.pendingAckIds.delete(eventId);
  const priorAckSet = new Set(priorAckIds);
  const events = drained.events.filter((event) => !priorAckSet.has(event.eventId));
  if (events.length === 0) return;
  const trusted = await loadTrustedTickSession(state, ctx, env);
  if (trusted.error !== undefined
      || !trusted.sessionId
      || !trusted.bucketName
      || !trusted.session
      || !env.VAPID_SUBJECT
      || !env.VAPID_PUBLIC_KEY
      || !env.VAPID_PRIVATE_KEY) {
    return;
  }

  const result = await raceBudget(sendAgentEventPushes({
    kv: env.KV,
    bucketName: trusted.bucketName,
    // The path identity is owned by this DO; display name and agent identity
    // come only from the trusted KV Session record.
    session: { ...trusted.session, id: trusted.sessionId },
    events,
    vapid: {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
    budgetMs: AGENT_EVENT_PUSH_BUDGET_MS,
  }), AGENT_EVENT_PUSH_BUDGET_MS);
  if (!result) return;

  const offeredIds = new Set(events.map((event) => event.eventId));
  for (const eventId of result.sentEventIds) {
    if (offeredIds.has(eventId)) deliveryState.pendingAckIds.add(eventId);
  }
  if (deliveryState.pendingAckIds.size === 0) return;

  const nextAckIds = [...deliveryState.pendingAckIds].slice(0, AGENT_EVENT_DRAIN_MAX);
  const acknowledged = await drainAgentEvents(ctx, CONTAINER_POLL_BUDGET_MS, {
    ackEventIds: nextAckIds,
  });
  if (!acknowledged) return;
  for (const eventId of nextAckIds) deliveryState.pendingAckIds.delete(eventId);
}

/**
 * Give shutdown-eligible events one final, bounded push attempt before sync and
 * stop. The host atomically promotes pending client decisions on `final:true`;
 * only pushes accepted for every selected subscription are ACKed.
 */
export async function drainAgentEventsBeforeStop(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
  budgetMs: number,
  capturedAuthToken?: string | null,
): Promise<void> {
  if (budgetMs <= 0) return;

  const startedAt = Date.now();
  const remainingBudget = (): number => Math.max(0, budgetMs - (Date.now() - startedAt));
  try {
    const deliveryState = deliveryStateFor(state);
    const priorAckIds = [...deliveryState.pendingAckIds].slice(0, AGENT_EVENT_DRAIN_MAX);
    const drained = await drainAgentEvents(ctx, remainingBudget(), {
      ackEventIds: priorAckIds,
      final: true,
    }, capturedAuthToken);
    if (!drained) return;

    for (const eventId of priorAckIds) deliveryState.pendingAckIds.delete(eventId);
    const priorAckSet = new Set(priorAckIds);
    const events = drained.events.filter((event) => !priorAckSet.has(event.eventId));
    if (events.length === 0) return;

    const trustedBudgetMs = remainingBudget();
    if (trustedBudgetMs <= 0) return;
    const trusted = await raceBudget(
      loadTrustedTickSession(state, ctx, env),
      trustedBudgetMs,
    );
    if (!trusted
        || trusted.error !== undefined
        || !trusted.sessionId
        || !trusted.bucketName
        || !trusted.session
        || !env.VAPID_SUBJECT
        || !env.VAPID_PUBLIC_KEY
        || !env.VAPID_PRIVATE_KEY) {
      return;
    }

    const pushBudgetMs = Math.min(remainingBudget(), AGENT_EVENT_PUSH_BUDGET_MS);
    if (pushBudgetMs <= 0) return;
    const result = await raceBudget(sendAgentEventPushes({
      kv: env.KV,
      bucketName: trusted.bucketName,
      session: { ...trusted.session, id: trusted.sessionId },
      events,
      vapid: {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
      budgetMs: pushBudgetMs,
    }), pushBudgetMs);
    if (!result) return;

    const offeredIds = new Set(events.map((event) => event.eventId));
    for (const eventId of result.sentEventIds) {
      if (offeredIds.has(eventId)) deliveryState.pendingAckIds.add(eventId);
    }
    if (deliveryState.pendingAckIds.size === 0) return;

    const nextAckIds = [...deliveryState.pendingAckIds].slice(0, AGENT_EVENT_DRAIN_MAX);
    const ackBudgetMs = remainingBudget();
    if (ackBudgetMs <= 0) return;
    const acknowledged = await drainAgentEvents(ctx, ackBudgetMs, {
      ackEventIds: nextAckIds,
    }, capturedAuthToken);
    if (!acknowledged) return;
    for (const eventId of nextAckIds) deliveryState.pendingAckIds.delete(eventId);
  } catch {
    logger.warn('drainAgentEventsBeforeStop: final agent event delivery failed');
  }
}

// ---------------------------------------------------------------------------
// collectMetrics
// ---------------------------------------------------------------------------

/**
 * Record whether this tick proved that the DO-to-container transport is alive.
 *
 * Either host route responding is sufficient: an HTTP non-OK or malformed body
 * is an application problem, but it proves the private TCP path works. Both
 * routes share port 8080, the Node process, and its event loop, so total failure
 * does not identify whether the DO attachment, container network, or host is
 * wedged. Persist correlated recovery evidence before resetting the Durable
 * Object, confirm recovery only from a later response, and stop resetting after
 * two attempts. If both probes still fail, retain resource ownership and
 * retry without usage projection: transport failure does not prove exit.
 * The authenticated no-start path separately checks for a surviving workload.
 */
type TransportReconciliation = {
  nextDelaySec: number;
  recordUsage: boolean;
};

type ProbeFailureCategory = 'timeout' | 'network-lost' | 'connection-refused' | 'other';

type ProbeObservation = {
  responded: boolean;
  durationMs: number;
  status?: number;
  error?: string;
  category?: ProbeFailureCategory;
};

type TransportProbeObservations = {
  activity: ProbeObservation;
  health: ProbeObservation;
};

type TransportRecoveryRecord = {
  attemptId: string;
  startedAt: number;
  lastAttemptAt: number;
  attemptCount: number;
  postResetFailureCount: number;
  totalFailureCount: number;
  status: 'resetting' | 'exhausted' | 'terminal-status-pending' | 'terminal-stop-pending';
};

function isTransportRecoveryRecord(value: unknown): value is TransportRecoveryRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.attemptId !== 'string'
      || record.attemptId.length === 0
      || record.attemptId.length > 128
      || !Number.isSafeInteger(record.startedAt)
      || (record.startedAt as number) <= 0
      || !Number.isSafeInteger(record.lastAttemptAt)
      || (record.lastAttemptAt as number) < (record.startedAt as number)
      || !Number.isSafeInteger(record.attemptCount)
      || !Number.isSafeInteger(record.postResetFailureCount)
      || !Number.isSafeInteger(record.totalFailureCount)) {
    return false;
  }

  const attemptCount = record.attemptCount as number;
  const postResetFailureCount = record.postResetFailureCount as number;
  const totalFailureCount = record.totalFailureCount as number;
  if (attemptCount < 1
      || attemptCount > TRANSPORT_RECOVERY_MAX_ATTEMPTS
      || postResetFailureCount < 0
      || totalFailureCount < attemptCount * TRANSPORT_FAILURE_ABORT_THRESHOLD + postResetFailureCount) {
    return false;
  }

  if (record.status === 'resetting') {
    return postResetFailureCount < TRANSPORT_FAILURE_ABORT_THRESHOLD;
  }
  return (record.status === 'exhausted'
      || record.status === 'terminal-status-pending'
      || record.status === 'terminal-stop-pending')
    && attemptCount === TRANSPORT_RECOVERY_MAX_ATTEMPTS
    && postResetFailureCount === TRANSPORT_FAILURE_ABORT_THRESHOLD;
}

function classifyProbeFailure(error: unknown): ProbeFailureCategory {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (name.includes('timeout') || message.includes('timed out') || message.includes('timeout') || message === 'aborted') {
    return 'timeout';
  }
  if (message.includes('network connection lost')) return 'network-lost';
  if (message.includes('connection refused') || message.includes('econnrefused')) return 'connection-refused';
  return 'other';
}

function failedProbeObservation(error: unknown, startedAt: number): ProbeObservation {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return {
    responded: false,
    durationMs: Math.max(0, Date.now() - startedAt),
    error: message.slice(0, 256),
    category: classifyProbeFailure(error),
  };
}

async function persistTransportRecovery(
  ctx: DurableObjectState,
  record: TransportRecoveryRecord,
): Promise<void> {
  await ctx.storage.put(TRANSPORT_RECOVERY_KEY, record);
  await ctx.storage.sync();
}

async function clearTransportRecoveryState(ctx: DurableObjectState): Promise<void> {
  await ctx.storage.delete([
    TRANSPORT_FAILURE_STREAK_KEY,
    TRANSPORT_RECOVERY_KEY,
  ]);
}

async function scheduleRecoveryOwnershipReadRetry(
  ctx: DurableObjectState,
  callbacks: MetricsCallbacks,
): Promise<void> {
  try {
    await callbacks.schedule(60, 'collectMetrics');
  } catch (err) {
    logger.error('collectMetrics: failed to schedule recovery ownership read retry', undefined, {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function transportRecoveryLogContext(
  ctx: DurableObjectState,
  recovery: TransportRecoveryRecord,
  probes: TransportProbeObservations,
) {
  return {
    durableObjectId: ctx.id.toString(),
    recoveryAttemptId: recovery.attemptId,
    recoveryAttempt: recovery.attemptCount,
    totalFailures: recovery.totalFailureCount,
    elapsedMs: Math.max(0, Date.now() - recovery.startedAt),
    containerRunning: ctx.container?.running ?? false,
    probes,
  };
}

async function reconcileActiveTransportRecovery(
  ctx: DurableObjectState,
  recovery: TransportRecoveryRecord,
  probes: TransportProbeObservations,
  execution: MetricsExecution,
  authorizeReset: () => Promise<boolean>,
): Promise<TransportReconciliation> {
  if (recovery.status !== 'resetting') {
    // Exhausted recovery (including an older pending terminal phase) proves
    // neither exit nor permission to kill a possibly surviving workload.
    return { nextDelaySec: 60, recordUsage: false };
  }

  const nextPostResetFailures = recovery.postResetFailureCount + 1;
  const nextTotalFailures = recovery.totalFailureCount + 1;
  if (nextPostResetFailures < TRANSPORT_FAILURE_ABORT_THRESHOLD) {
    const nextRecovery: TransportRecoveryRecord = {
      ...recovery,
      postResetFailureCount: nextPostResetFailures,
      totalFailureCount: nextTotalFailures,
    };
    try {
      await persistTransportRecovery(ctx, nextRecovery);
    } catch (err) {
      logger.warn('collectMetrics: failed to persist post-reconstruction confirmation', {
        ...transportRecoveryLogContext(ctx, recovery, probes),
        error: err instanceof Error ? err.message : String(err),
      });
      return { nextDelaySec: 60, recordUsage: false };
    }
    logger.warn('collectMetrics: post-reconstruction transport confirmation failed', {
      ...transportRecoveryLogContext(ctx, nextRecovery, probes),
      consecutiveFailures: nextPostResetFailures,
    });
    return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
  }

  if (recovery.attemptCount >= TRANSPORT_RECOVERY_MAX_ATTEMPTS) {
    const exhaustedRecovery: TransportRecoveryRecord = {
      ...recovery,
      postResetFailureCount: nextPostResetFailures,
      totalFailureCount: nextTotalFailures,
      status: 'exhausted',
    };
    try {
      await persistTransportRecovery(ctx, exhaustedRecovery);
    } catch (err) {
      logger.warn('collectMetrics: failed to persist transport recovery exhaustion', {
        ...transportRecoveryLogContext(ctx, recovery, probes),
        error: err instanceof Error ? err.message : String(err),
      });
      return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
    }
    logger.error(
      'collectMetrics: container transport recovery exhausted',
      undefined,
      transportRecoveryLogContext(ctx, exhaustedRecovery, probes),
    );
    return { nextDelaySec: 60, recordUsage: false };
  }

  const nextRecovery: TransportRecoveryRecord = {
    ...recovery,
    lastAttemptAt: Date.now(),
    attemptCount: recovery.attemptCount + 1,
    postResetFailureCount: 0,
    totalFailureCount: nextTotalFailures,
  };
  try {
    await persistTransportRecovery(ctx, nextRecovery);
  } catch (err) {
    logger.warn('collectMetrics: failed to persist repeated transport reconstruction', {
      ...transportRecoveryLogContext(ctx, recovery, probes),
      error: err instanceof Error ? err.message : String(err),
    });
    return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
  }
  logger.warn(
    'collectMetrics: resetting Durable Object to retry container transport recovery',
    transportRecoveryLogContext(ctx, nextRecovery, probes),
  );
  if (await authorizeReset() && execution.isCurrent()) ctx.abort(TRANSPORT_ABORT_REASON);
  return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
}

async function reconcileContainerTransport(
  ctx: DurableObjectState,
  probes: TransportProbeObservations,
  execution: MetricsExecution,
  authorizeReset: () => Promise<boolean>,
): Promise<TransportReconciliation | null> {
  const anyProbeResponded = probes.activity.responded || probes.health.responded;
  let shutdownRequested: number | undefined;
  try {
    shutdownRequested = await ctx.storage.get<number>(SHUTDOWN_REQUESTED_KEY);
  } catch (err) {
    logger.warn('collectMetrics: failed to read shutdown marker; suppressing transport reconstruction', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
      probes,
    });
    return null;
  }
  if (typeof shutdownRequested === 'number') {
    try {
      await clearTransportRecoveryState(ctx);
    } catch (err) {
      logger.warn('collectMetrics: failed to clear transport recovery state during shutdown', {
        durableObjectId: ctx.id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  let currentStreak: number;
  let recovery: TransportRecoveryRecord | null;
  try {
    const storedStreak = await ctx.storage.get<number>(TRANSPORT_FAILURE_STREAK_KEY);
    currentStreak = Number.isSafeInteger(storedStreak) && (storedStreak as number) >= 0
      ? storedStreak as number
      : 0;
    const storedRecovery = await ctx.storage.get<unknown>(TRANSPORT_RECOVERY_KEY);
    if (storedRecovery !== undefined && storedRecovery !== null && !isTransportRecoveryRecord(storedRecovery)) {
      logger.error(
        'collectMetrics: invalid transport recovery record; suppressing reconstruction',
        undefined,
        {
          durableObjectId: ctx.id.toString(),
          valueType: typeof storedRecovery,
        },
      );
      await ctx.storage.delete(TRANSPORT_RECOVERY_KEY);
      return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
    }
    recovery = storedRecovery == null ? null : storedRecovery;
  } catch (err) {
    logger.warn('collectMetrics: failed to read transport recovery state', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      nextDelaySec: anyProbeResponded ? 60 : TRANSPORT_FAILURE_RETRY_SECONDS,
      recordUsage: false,
    };
  }

  if (anyProbeResponded) {
    try {
      await clearTransportRecoveryState(ctx);
    } catch (err) {
      logger.warn('collectMetrics: failed to clear transport recovery state', {
        ...(recovery
          ? transportRecoveryLogContext(ctx, recovery, probes)
          : { durableObjectId: ctx.id.toString() }),
        error: err instanceof Error ? err.message : String(err),
      });
      return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
    }
    if (recovery) {
      logger.info(
        'collectMetrics: container transport recovery confirmed',
        transportRecoveryLogContext(ctx, recovery, probes),
      );
    }
    return {
      nextDelaySec: 60,
      recordUsage: currentStreak === 0 && recovery === null,
    };
  }

  if (recovery) {
    return reconcileActiveTransportRecovery(ctx, recovery, probes, execution, authorizeReset);
  }

  const nextStreak = currentStreak + 1;
  try {
    await ctx.storage.put(TRANSPORT_FAILURE_STREAK_KEY, nextStreak);
  } catch (err) {
    logger.warn('collectMetrics: failed to persist transport failure streak', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
  }

  if (nextStreak >= TRANSPORT_FAILURE_ABORT_THRESHOLD) {
    const now = Date.now();
    const nextRecovery: TransportRecoveryRecord = {
      attemptId: crypto.randomUUID(),
      startedAt: now,
      lastAttemptAt: now,
      attemptCount: 1,
      postResetFailureCount: 0,
      totalFailureCount: nextStreak,
      status: 'resetting',
    };
    try {
      await persistTransportRecovery(ctx, nextRecovery);
    } catch (err) {
      logger.warn('collectMetrics: failed to persist transport recovery attempt', {
        ...transportRecoveryLogContext(ctx, nextRecovery, probes),
        error: err instanceof Error ? err.message : String(err),
      });
      return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
    }
    logger.warn('collectMetrics: resetting Durable Object to reconstruct container transport', {
      ...transportRecoveryLogContext(ctx, nextRecovery, probes),
      consecutiveFailures: nextStreak,
    });
    if (await authorizeReset() && execution.isCurrent()) ctx.abort(TRANSPORT_ABORT_REASON);
  }

  logger.warn('collectMetrics: complete container probe failure, retrying quickly', {
    durableObjectId: ctx.id.toString(),
    consecutiveFailures: nextStreak,
    abortThreshold: TRANSPORT_FAILURE_ABORT_THRESHOLD,
    containerRunning: ctx.container?.running ?? false,
    probes,
  });
  return {
    nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS,
    recordUsage: false,
  };
}

/** Collect one pinned observation and re-arm the existing one-shot alarm. */
export async function collectMetrics(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
  callbacks: MetricsCallbacks,
  execution: MetricsExecution,
): Promise<void> {
  const { ownerKey, sessionId, generation, sequence, runtime } = execution;
  const repository = new D1SessionRepository(env.USAGE_DB);
  const readCurrent = async () => {
    const result = await raceBudget(repository.getSession(ownerKey, sessionId).then(session => ({ session })), CONTAINER_POLL_BUDGET_MS);
    if (!result) throw new Error('D1 lifecycle observation deadline exceeded');
    return result.session;
  };
  const sameGeneration = (session: D1Session | null): session is D1Session =>
    execution.isCurrent() && session?.lifecycleGeneration === generation;
  const schedule = async (delay: number) => {
    if (!execution.isCurrent()) return;
    try { await callbacks.schedule(delay, 'collectMetrics'); }
    catch (error) {
      logger.error('collectMetrics: required lifecycle alarm unavailable', undefined, {
        sessionId, lifecycleGeneration: generation, errorClass: 'schedule_failed',
      });
      throw error;
    }
  };
  let shutdown: unknown;
  try { shutdown = await ctx.storage.get(SHUTDOWN_REQUESTED_KEY); }
  catch { return; }
  if (!execution.isCurrent()) return;
  if (typeof shutdown === 'number') {
    // Deliberate Stop keeps its own teardown. Only an already claimed recovery
    // expiry may continue through its shutdown fence on this same alarm.
    let retry = false;
    try {
      const current = await readCurrent();
      if (sameGeneration(current) && current.lifecycleState === 'stopping' && current.unreachableIncidentId) {
        retry = await callbacks.terminateUnreachable(current, execution);
      }
    } catch {
      logger.error('collectMetrics: recovery termination unavailable; retry Stop or KILL', undefined,
        { sessionId, lifecycleGeneration: generation, errorClass: 'termination_failed' });
      retry = true;
    }
    if (retry) await schedule(5);
    return;
  }
  // These existing keys are retry diagnostics only. D1 is re-read before
  // acting on an incident; no deadline or termination authority lives here.
  let recoveryTick = !runtime.running;
  try {
    const recovery = await ctx.storage.get<unknown>(TRANSPORT_RECOVERY_KEY);
    const streak = await ctx.storage.get<number>(TRANSPORT_FAILURE_STREAK_KEY);
    recoveryTick ||= recovery != null || (typeof streak === 'number' && streak > 0);
  } catch {
    await scheduleRecoveryOwnershipReadRetry(ctx, callbacks);
    return;
  }
  if (recoveryTick) {
    let terminationRetry: boolean | undefined;
    try {
      const current = await readCurrent();
      if (!execution.isCurrent() || (current && !sameGeneration(current))) return;
      if (sameGeneration(current) && (current.lifecycleState === 'stopping'
        || (current.lifecycleState === 'unreachable' && current.unreachableDeadlineMs !== undefined
          && Date.now() >= current.unreachableDeadlineMs))) {
        terminationRetry = await callbacks.terminateUnreachable(current, execution);
      }
    } catch {
      logger.warn('collectMetrics: recovery ownership unavailable', { sessionId, lifecycleGeneration: generation, errorClass: 'd1_unavailable' });
      terminationRetry = true;
    }
    if (terminationRetry !== undefined) {
      if (terminationRetry) await schedule(5);
      return;
    }
  }
  if (!runtime.running) await openNotRunningConfirmation(ctx);
  else await ctx.storage.delete(NOT_RUNNING_SINCE_KEY);
  let projectionAccepted = false;
  let projectionFailed = false;
  // Notification delivery owns its exceptional D1 read only when the host
  // actually offers events. The normal metrics path remains one host snapshot
  // plus one generation/sequence-fenced D1 update with no pre-read.
  try {
    await deliverRunningAgentEvents(state, ctx, env);
  } catch {
    // Notification delivery is best-effort and independent from idle, health,
    // usage accounting, and the one-shot schedule re-arm below.
    logger.warn('collectMetrics: agent event delivery failed');
  }

  // User-input-based idle detection. The SDK's sleepAfter timer is pinned to
  // 24h and refreshes on every WebSocket message in both directions, so it
  // would keep a container alive as long as any bytes flow — including
  // background output from `tail -f` or `yes`. collectMetrics polls the
  // in-container /activity endpoint for lastInputAt (classified PTY input or a
  // client-to-server Browser IDE frame) and explicitly stops the container
  // when idle exceeds the user-configured threshold.
  //
  // Re-read the idle-timeout pref from DO storage every tick. The class field
  // cache may be stale if (a) the DO instance was hibernated and re-loaded
  // and the construction's storage read raced with a setBucketName write, or
  // (b) some code path wrote 'sleepAfter' to storage without updating the
  // cache. Storage is the authoritative source.
  let idleTimeoutPref = '12h';
  let policySource: 'stored' | 'missing' | 'invalid' | 'read-failed' = 'missing';
  try {
    const stored = await ctx.storage.get<string>('sleepAfter');
    if (stored && /^(5m|15m|30m|1h|2h|4h|8h|12h)$/.test(stored)) {
      idleTimeoutPref = stored;
      policySource = 'stored';
    } else {
      policySource = stored === undefined ? 'missing' : 'invalid';
      logger.warn('collectMetrics: sleepAfter missing or invalid; selecting fail-safe 12h', { stored });
    }
  } catch (err) {
    policySource = 'read-failed';
    logger.warn('collectMetrics: failed to read sleepAfter; selecting fail-safe 12h', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (idleTimeoutPref !== callbacks.idleTimeoutPref) {
    logger.info('collectMetrics: refreshing idleTimeoutPref from authoritative tick value', {
      cached: callbacks.idleTimeoutPref, resolved: idleTimeoutPref,
    });
    callbacks.setIdleTimeoutPref(idleTimeoutPref);
  }
  const sleepMs = parseSleepAfterMs(idleTimeoutPref);
  const observationStartedAt = Date.now();
  let activityProbe: ProbeObservation = { responded: false, durationMs: 0 };
  let healthProbe: ProbeObservation = { responded: false, durationMs: 0 };
  try {
    const port = runtime.getTcpPort(TERMINAL_SERVER_PORT);
    const response = await pollContainer(
      port,
      'http://localhost/internal/runtime-observation',
      CONTAINER_POLL_BUDGET_MS,
      execution.authToken,
    );
    const observation: ProbeObservation = {
      responded: true,
      durationMs: Math.max(0, Date.now() - observationStartedAt),
      status: response.status,
    };
    activityProbe = observation;
    healthProbe = observation;
    if (execution.isCurrent() && execution.onHostResponse) {
      void execution.onHostResponse().catch(() => {
        logger.warn('collectMetrics: existing runtime monitor attachment unavailable', { sessionId, lifecycleGeneration: generation });
      });
    }
    if (!response.ok) {
      logger.warn('collectMetrics: runtime observation returned non-OK', { status: response.status });
    } else {
      const snapshot = await raceBudget(response.json(), CONTAINER_POLL_BUDGET_MS) as {
        lastInputAt: number | null; cpu?: string; memory?: string; disk?: string;
        syncStatus?: string; editorReady?: boolean; editorReadyError?: boolean; workspaceRepos?: unknown; observedAt: string;
      };
      if (!snapshot || typeof snapshot !== 'object' || !execution.isCurrent()) throw new Error('Runtime snapshot unavailable');
      // Only a finite positive timestamp is usable activity evidence. An
      // invalid value must not become the idle reference or D1 activity.
      const observedInputAt = typeof snapshot.lastInputAt === 'number'
        && Number.isFinite(snapshot.lastInputAt) && snapshot.lastInputAt > 0
        ? snapshot.lastInputAt
        : null;
      state.lastSeenInputAt = observedInputAt;
      let canEnforceIdle = true;
      let containerStartedAt = state.containerStartedAt;
      if (observedInputAt === null && (!Number.isFinite(containerStartedAt) || containerStartedAt <= 0)) {
        let persistedStartedAt: number | undefined;
        try {
          persistedStartedAt = await ctx.storage.get<number>('containerStartedAt');
        } catch (error) {
          // Storage uncertainty cannot turn a successful host observation into
          // transport failure or authorize an idle stop.
          canEnforceIdle = false;
          state.containerStartedAt = 0;
          containerStartedAt = Date.now();
          logger.warn('collectMetrics: failed to read startup idle reference', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (canEnforceIdle && typeof persistedStartedAt === 'number'
            && Number.isFinite(persistedStartedAt) && persistedStartedAt > 0) {
          // A durable baseline already exists; hydration must not rewrite it.
          containerStartedAt = persistedStartedAt;
          state.containerStartedAt = containerStartedAt;
        } else if (canEnforceIdle) {
          // A missing or invalid legacy marker must fail open for idle policy:
          // treating it as epoch zero stops a healthy new container immediately.
          containerStartedAt = Date.now();
          try {
            await ctx.storage.put('containerStartedAt', containerStartedAt);
            state.containerStartedAt = containerStartedAt;
          } catch (error) {
            // Without durable timing evidence another coordinator could see a
            // different baseline. Continue projection, but never stop on it.
            canEnforceIdle = false;
            state.containerStartedAt = 0;
            logger.warn('collectMetrics: failed to persist startup idle reference', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      const referenceTime = observedInputAt ?? containerStartedAt;
      const checkedAt = Date.now();
      const idleMs = checkedAt - referenceTime;
      // Metadata only: distinguish policy fallback from timing uncertainty or
      // genuine activity without adding I/O ahead of a required idle stop.
      logger.info('collectMetrics: idle policy decision', {
        durableObjectId: ctx.id.toString(), sessionId: state._sessionId,
        idleTimeoutPref, policySource, checkedAt, observedInputAt,
        referenceTime: canEnforceIdle ? referenceTime : null,
        canEnforceIdle,
        decision: !canEnforceIdle ? 'timing-unavailable' : idleMs > sleepMs ? 'stop' : 'continue',
      });
      if (canEnforceIdle && idleMs > sleepMs && execution.isCurrent()) {
        logger.info('collectMetrics: idle exceeded threshold, stopping', { idleMs, sleepMs, idleTimeoutPref, referenceTime });
        await drainAgentEventsBeforeStop(state, ctx, env, CONTAINER_POLL_BUDGET_MS);
        if (!execution.isCurrent()) return;
        await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
        if (!execution.isCurrent()) return;
        await callbacks.stop('SIGTERM');
        return;
      }
      if (snapshot.syncStatus === 'failed' || snapshot.syncStatus === 'timeout') {
        logger.warn('collectMetrics: container R2 sync unhealthy', { syncStatus: snapshot.syncStatus });
      }
      if (typeof await ctx.storage.get(SHUTDOWN_REQUESTED_KEY) === 'number') return;
      if (!execution.isCurrent()) return;
      try {
        if (Array.isArray(snapshot.workspaceRepos)) {
          const tracked = await raceBudget(repository.updateTrackedClones(ownerKey, sessionId,
            normalizeTrackedClones(snapshot.workspaceRepos), { generation, sequence }), CONTAINER_POLL_BUDGET_MS);
          if (tracked === null) throw new Error('D1 clone projection deadline exceeded');
          if (!execution.isCurrent()) return;
        }
        const accepted = await raceBudget(repository.project(ownerKey, sessionId, generation, sequence, {
          lifecycleState: 'running',
          lastInputAt: observedInputAt === null ? undefined : new Date(observedInputAt).toISOString(),
          cpu: snapshot.cpu, memory: snapshot.memory, disk: snapshot.disk, syncStatus: snapshot.syncStatus,
          editorReady: snapshot.editorReady, editorReadyError: snapshot.editorReadyError, observedAt: snapshot.observedAt,
        }), CONTAINER_POLL_BUDGET_MS);
        if (accepted === null) throw new Error('D1 metrics projection deadline exceeded');
        projectionAccepted = accepted;
      } catch (error) {
        projectionFailed = true;
        // A D1 outage must not be misclassified as a dead container transport.
        logger.warn('collectMetrics: D1 projection failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (err) {
    const failed = failedProbeObservation(err, observationStartedAt);
    if (!activityProbe.responded) { activityProbe = failed; healthProbe = failed; }
    logger.warn('collectMetrics: runtime observation/projection failed', { error: err instanceof Error ? err.message : String(err) });
  }

  if (!execution.isCurrent()) return;
  let incident: D1Session | null = null;
  const proposedIncidentId = crypto.randomUUID();
  const failureObservedAt = Date.now();
  const responded = activityProbe.responded || healthProbe.responded;
  let terminationRetry: boolean | undefined;
  let recoveredIncident = false;
  try {
    if (!responded) {
      incident = await raceBudget(repository.observeUnreachable(ownerKey, sessionId, generation, sequence,
        proposedIncidentId, failureObservedAt), CONTAINER_POLL_BUDGET_MS);
    } else if (!projectionAccepted && !projectionFailed) {
      incident = await readCurrent();
      if (sameGeneration(incident) && incident.lifecycleState === 'unreachable' && incident.unreachableIncidentId
        && Date.now() < (incident.unreachableDeadlineMs ?? 0)) {
        const recovered = await raceBudget(repository.recoverUnreachable(ownerKey, sessionId, generation, sequence,
          incident.unreachableIncidentId, new Date().toISOString()), CONTAINER_POLL_BUDGET_MS);
        recoveredIncident = recovered === true;
        if (recovered) logger.info('recovery_succeeded', { sessionId, lifecycleGeneration: generation,
          incidentId: incident.unreachableIncidentId });
      }
    }
    if (!execution.isCurrent()) return;
    if (sameGeneration(incident) && (incident.lifecycleState === 'stopping'
        || (incident.unreachableDeadlineMs !== undefined && Date.now() >= incident.unreachableDeadlineMs))) {
      terminationRetry = await callbacks.terminateUnreachable(incident, execution);
    }
  } catch {
    logger.warn('collectMetrics: D1 lifecycle observation unavailable', { sessionId, lifecycleGeneration: generation,
      errorClass: 'd1_unavailable' });
    terminationRetry = true;
  }
  if (terminationRetry !== undefined) {
    if (terminationRetry) await schedule(5);
    return;
  }
  if (incident && !sameGeneration(incident)) return;
  if (responded && incident?.lifecycleState === 'unreachable' && !recoveredIncident) {
    await schedule(5);
    return;
  }
  // No acknowledged, same-generation D1 incident means no reconstruction.
  if (!responded && !sameGeneration(incident)) { await schedule(5); return; }
  if (!responded && incident?.unreachableIncidentId === proposedIncidentId) {
    logger.warn('unreachable_incident_opened', { sessionId, lifecycleGeneration: generation,
      incidentId: incident.unreachableIncidentId, deadlineMs: incident.unreachableDeadlineMs, reason: 'host_transport_loss' });
  }
  const authorizeReset = async () => {
    const current = await readCurrent();
    const authorized = sameGeneration(current) && current.lifecycleState === 'unreachable'
      && current.unreachableIncidentId === incident?.unreachableIncidentId
      && current.unreachableDeadlineMs === incident?.unreachableDeadlineMs
      && Date.now() < (current.unreachableDeadlineMs ?? 0);
    if (authorized) logger.info('reconstruction_started', { sessionId, lifecycleGeneration: generation,
      incidentId: current.unreachableIncidentId });
    return authorized;
  };
  // Re-arm before a possible ctx.abort; a failed required alarm must be visible.
  if (!responded) await schedule(5);
  const transportReconciliation = await reconcileContainerTransport(ctx, {
    activity: activityProbe, health: healthProbe,
  }, execution, authorizeReset);
  if (transportReconciliation === null || !execution.isCurrent()) return;
  if (!responded || incident || projectionFailed || recoveryTick) transportReconciliation.recordUsage = false;
  // Timekeeper records per-user compute consumption in every deployment mode.
  // A tick scheduled after a complete transport failure is a 5-second
  // confirmation, not another usage minute.
  if (transportReconciliation.recordUsage
      && state._bucketName
      && state._userEmail
      && env.TIMEKEEPER) {
    try {
      state._usageSeconds += 60;
      await ctx.storage.put('usageSeconds', state._usageSeconds);

      const tkId = env.TIMEKEEPER.idFromName(state._bucketName);
      const tk = env.TIMEKEEPER.get(tkId);
      // Bounded for the same reason as the container polls above: this await sits
      // before the re-arm, so a Timekeeper DO that does not answer would take the
      // alarm loop with it just as surely as a wedged container did.
      //
      // Unlike those polls, the bound here does NOT rest on the signal alone. The
      // container polls go through getTcpPort().fetch, where drainFinalSync already
      // depends on AbortSignal.timeout in production; a Durable Object stub is a
      // different transport and its abort support is not established here. So the
      // ping is raced against a timer, which holds whether or not the stub honours
      // the signal. The signal stays because it genuinely cancels the request where
      // it IS honoured, rather than leaving it running behind the race.
      const pingRes = await raceBudget(tk.fetch(new Request('http://timekeeper/ping', {
        method: 'POST',
        body: JSON.stringify({
          bucketName: state._bucketName,
          sessionId: state._sessionId,
          totalSeconds: state._usageSeconds,
          email: state._userEmail!,
        }),
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(CONTAINER_POLL_BUDGET_MS),
      })), CONTAINER_POLL_BUDGET_MS);

      if (pingRes?.ok) {
        const { quotaExceeded } = await pingRes.json() as { quotaExceeded: boolean };
        if (quotaExceeded && isSaasModeActive(env.SAAS_MODE) && execution.isCurrent()) {
          logger.warn('Quota exceeded — stopping container', { bucketName: state._bucketName });
          // Final notification delivery and R2 sync are independent
          // best-effort drains, both completed before SIGTERM.
          await drainAgentEventsBeforeStop(
            state,
            ctx,
            env,
            CONTAINER_POLL_BUDGET_MS,
          );
          if (!execution.isCurrent()) return;
          await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
          if (!execution.isCurrent()) return;
          await callbacks.stop('SIGTERM');
          return; // Don't re-arm after stop
        }
      }
    } catch (err) {
      // Non-fatal: log and continue — Timekeeper will catch up on next ping
      logger.warn('Timekeeper ping failed', { error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    logger.info('Timekeeper ping skipped', {
      recordUsage: transportReconciliation.recordUsage,
      saasMode: isSaasModeActive(env.SAAS_MODE),
      bucketName: !!state._bucketName,
      userEmail: !!state._userEmail,
      timekeeper: !!env.TIMEKEEPER,
    });
  }

  // SDK false is not exit: a responding existing host retains the same alarm.
  if (responded && typeof await ctx.storage.get(SHUTDOWN_REQUESTED_KEY) !== 'number') {
    await schedule(transportReconciliation.nextDelaySec);
  }
}
