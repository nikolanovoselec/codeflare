/**
 * container-metrics — Metrics collection, idle detection, and Timekeeper pings.
 *
 * Extracted from Container DO (index.ts) to reduce file size.
 * All functions receive explicit state/context parameters instead of `this`.
 */
import type { Env, Session } from '../types';
import { TERMINAL_SERVER_PORT } from '../lib/constants';
import { toError } from '../lib/error-types';
import { getSessionKey, putSessionWithMetadata } from '../lib/kv-keys';
import { createLogger } from '../lib/logger';
import type { ActivityState } from '../lib/activity-policy';
import { isSaasModeActive } from '../lib/onboarding';
import {
  AGENT_EVENT_PUSH_BUDGET_MS,
  sendAgentEventPushes,
  type AgentEventForPush,
} from '../lib/push-sender';

const SESSION_ID_KEY = '_sessionId';
const logger = createLogger('container-metrics');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable state fields that metrics collection needs to read/write. */
export interface MetricsState {
  _bucketName: string | null;
  _sessionId: string | null;
  _userEmail: string | null;
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
}

// ---------------------------------------------------------------------------
// parseSleepAfterMs
// ---------------------------------------------------------------------------

/** Parse sleepAfter string ('15m', '30m', '1h', '2h', '4h') to milliseconds.
 *
 * Fail-safe direction: an unrecognized or malformed string returns the maximum
 * supported timeout (4h) rather than the minimum. A short fallback would cause
 * the container to die early when the pref is missing/corrupted; a long
 * fallback only causes the container to live slightly longer than the user
 * expected. Errs on the side of preserving user work over saving compute.
 *
 * The validated regex `/^(5m|15m|30m|1h|2h|4h)$/` at the storage write site means
 * this fallback should only ever fire on truly broken input. Log it loudly
 * (caller logs). NOTE: '5m' is retired from the settable picker
 * (REQ-SESSION-014) but stays in the accept-set so a pre-existing 5m pref keeps
 * its short timeout instead of resetting to the 2h fallback.
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
// A container must read not-running continuously for at least this long before
// collectMetrics writes 'stopped'. Spans more than one 60s alarm tick so a
// single transient `ctx.container.running === false` (DO hibernation wake or
// deploy-roll, while the container is actually alive) cannot flip a live
// session to stopped. This catch-all covers exits the SDK never surfaces as
// onError; onError itself now feeds the SAME window rather than writing stopped
// directly (openNotRunningConfirmation), so a transient error that fires onError
// while the container is actually alive can no longer flip a live session to
// stopped (REQ-SESSION-018 AC3).
const NOT_RUNNING_CONFIRM_MS = 90_000;

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
const MONITOR_TRANSPORT_ABORT_REASON = 'container monitor lost its connection to container services';

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
): Promise<Response> {
  return port.fetch(url, { signal: AbortSignal.timeout(budgetMs) });
}

/**
 * Resolve to null if `work` has not settled within the budget.
 *
 * For callees whose transport is not established to honour an abort signal, a
 * timer is the only bound that certainly holds. The abandoned work keeps running;
 * what matters is that the alarm stops waiting on it and reaches its re-arm.
 */
function raceBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
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
 * Called by onError (container-lifecycle.ts) on a not-running reading so the
 * stopped decision is deferred to collectMetrics' confirmation window instead
 * of being written immediately on a single, possibly-transient reading. Sets
 * the marker only if not already open, so an in-progress streak is not reset.
 * The caller re-arms a collectMetrics tick so the window gets evaluated.
 */
export async function openNotRunningConfirmation(ctx: DurableObjectState): Promise<void> {
  const since = await ctx.storage.get<number>(NOT_RUNNING_SINCE_KEY);
  if (typeof since !== 'number') {
    await ctx.storage.put(NOT_RUNNING_SINCE_KEY, Date.now());
  }
}

export const SLEEP_AFTER_FALLBACK_MS = 14_400_000; // 4h (the maximum supported sleepAfter option)
export function parseSleepAfterMs(s: string): number {
  if (s.endsWith('h')) {
    const h = parseInt(s, 10);
    if (!Number.isNaN(h) && h > 0) return h * 3_600_000;
  }
  if (s.endsWith('m')) {
    const m = parseInt(s, 10);
    if (!Number.isNaN(m) && m > 0) return m * 60_000;
  }
  logger.warn('parseSleepAfterMs: unrecognized value, falling back to 4h', { input: s });
  return SLEEP_AFTER_FALLBACK_MS;
}

// ---------------------------------------------------------------------------
// updateKvStatus
// ---------------------------------------------------------------------------

/**
 * Update a timestamp field on the KV session record (best-effort).
 * Optionally sets session.status (e.g. 'stopped' on hibernation).
 */
export type KvStatusUpdateResult = 'written' | 'absent' | 'failed';

export async function updateKvStatus(
  ctx: DurableObjectState,
  env: Env,
  bucketNameOverride: string | null,
  status: 'running' | 'stopped' | null,
  field: 'lastStartedAt' | 'lastActiveAt',
): Promise<KvStatusUpdateResult> {
  try {
    const sessionId = await ctx.storage.get<string>(SESSION_ID_KEY);
    // Fallback: if _bucketName isn't set on the instance, try loading from storage
    const bucketName = bucketNameOverride || await ctx.storage.get<string>('bucketName') || null;
    if (!sessionId || !bucketName) {
      logger.info('updateKvStatus: missing identifiers', { status, field, sessionId: !!sessionId, bucketName: !!bucketName });
      return 'failed';
    }
    const key = getSessionKey(bucketName, sessionId);
    const session = await env.KV.get<Session>(key, 'json');
    if (!session) {
      logger.info('updateKvStatus: session not found in KV', { key, status, field });
      return 'absent';
    }
    const timestamp = new Date().toISOString();
    const updated = {
      ...session,
      ...(status !== null ? { status } : {}),
      [field]: timestamp,
      // A start owns both timestamps. Publishing them from this same snapshot
      // prevents an immediate second KV read from restoring pre-start status.
      ...(status === 'running' && field === 'lastStartedAt' ? { lastActiveAt: timestamp } : {}),
    };
    await putSessionWithMetadata(env.KV, key, updated);
    logger.info('updateKvStatus: wrote to KV', { key, status, field });
    return 'written';
  } catch (err) {
    logger.error('Failed to update KV status', toError(err));
    return 'failed';
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const port = ctx.container.getTcpPort(8080);
    // Raw port.fetch bypasses the DO's public fetch override (the only place
    // the auth header is injected) and the in-container host 401s /internal/*
    // without a Bearer token - the idle/quota-stop drain failed that way on
    // every stop until this header was added. Unlike the delete path, storage
    // is intact here, so read the token directly.
    let authToken: string | null = null;
    try { authToken = (await ctx.storage.get<string>('containerAuthToken')) ?? null; } catch { authToken = null; }
    const res = await port.fetch('http://localhost/internal/final-sync', {
      method: 'POST',
      ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
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
    const session = sessionId && bucketName
      ? await env.KV.get<Session>(getSessionKey(bucketName, sessionId), 'json')
      : null;
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
  trusted: TrustedTickSession,
): Promise<void> {
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
  if (events.length === 0
      || trusted.error !== undefined
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
 * two attempts. If both probes still fail on the next tick, converge the stale
 * running record to stopped instead of monitoring and billing it forever. The
 * Containers SDK constructor has a running-container reattachment path;
 * reconnecting through it remains a deployed smoke check rather than a
 * unit-tested contract.
 */
type TransportReconciliation = {
  nextDelaySec: number;
  recordUsage: boolean;
  terminalUnavailable?: true;
  recovery?: TransportRecoveryRecord;
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

async function scheduleTerminalConvergenceRetry(
  ctx: DurableObjectState,
  callbacks: MetricsCallbacks,
): Promise<void> {
  try {
    await callbacks.schedule(60, 'collectMetrics');
  } catch (err) {
    logger.error('collectMetrics: failed to schedule terminal convergence retry', undefined, {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function continueTerminalConvergence(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
  callbacks: MetricsCallbacks,
  recovery: TransportRecoveryRecord,
): Promise<void> {
  let ownedRecovery = recovery;
  if (ownedRecovery.status === 'terminal-status-pending') {
    const stoppedUpdate = await updateKvStatus(ctx, env, state._bucketName, 'stopped', 'lastActiveAt');
    if (stoppedUpdate === 'failed') {
      await scheduleTerminalConvergenceRetry(ctx, callbacks);
      return;
    }
    ownedRecovery = { ...ownedRecovery, status: 'terminal-stop-pending' };
    try {
      await persistTransportRecovery(ctx, ownedRecovery);
    } catch (err) {
      logger.error('collectMetrics: failed to persist terminal stop ownership', undefined, {
        durableObjectId: ctx.id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      await scheduleTerminalConvergenceRetry(ctx, callbacks);
      return;
    }
  }

  try {
    await callbacks.stop('SIGTERM');
  } catch (err) {
    logger.warn('collectMetrics: terminal container stop failed; retaining recovery for retry', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    await scheduleTerminalConvergenceRetry(ctx, callbacks);
    return;
  }

  try {
    await clearTransportRecoveryState(ctx);
  } catch (err) {
    logger.warn('collectMetrics: failed to clear exhausted recovery after terminal stop', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function monitorNetworkLossProbes(): TransportProbeObservations {
  const error = new Error('Network connection lost.');
  return {
    activity: failedProbeObservation(error, Date.now()),
    health: failedProbeObservation(error, Date.now()),
  };
}

type MonitorRecoveryStart = 'recovering' | 'fallback' | 'suppressed';

/**
 * Bridge the SDK monitor's Network connection lost error into the same durable,
 * bounded recovery incident used by failed host probes. The SDK applies this
 * ctx.abort workaround only in its startup path; monitor rejection otherwise
 * marks its private state stopped before invoking onError, so waiting for the
 * running-only probes permanently misses the reattachment opportunity.
 */
export async function beginMonitorTransportRecovery(
  ctx: DurableObjectState,
  scheduleConfirmation: () => Promise<unknown>,
): Promise<MonitorRecoveryStart> {
  const probes = monitorNetworkLossProbes();
  let shutdownRequested: number | undefined;
  try {
    shutdownRequested = await ctx.storage.get<number>(SHUTDOWN_REQUESTED_KEY);
  } catch (err) {
    logger.warn('container monitor recovery: failed to read shutdown marker; suppressing reconstruction', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return 'suppressed';
  }
  if (typeof shutdownRequested === 'number') {
    try { await clearTransportRecoveryState(ctx); } catch { /* teardown remains authoritative */ }
    return 'suppressed';
  }

  let storedRecovery: unknown;
  try {
    storedRecovery = await ctx.storage.get<unknown>(TRANSPORT_RECOVERY_KEY);
  } catch (err) {
    logger.warn('container monitor recovery: failed to read transport recovery state', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return 'suppressed';
  }
  if (storedRecovery != null) {
    if (!isTransportRecoveryRecord(storedRecovery)) {
      logger.error('container monitor recovery: invalid recovery record; suppressing reconstruction', undefined, {
        durableObjectId: ctx.id.toString(),
        valueType: typeof storedRecovery,
      });
      try { await ctx.storage.delete(TRANSPORT_RECOVERY_KEY); } catch { /* remain fail-closed */ }
      return 'suppressed';
    }
    if (storedRecovery.status === 'exhausted') return 'fallback';
    await scheduleConfirmation();
    return 'recovering';
  }

  const now = Date.now();
  const recovery: TransportRecoveryRecord = {
    attemptId: crypto.randomUUID(),
    startedAt: now,
    lastAttemptAt: now,
    attemptCount: 1,
    postResetFailureCount: 0,
    totalFailureCount: TRANSPORT_FAILURE_ABORT_THRESHOLD,
    status: 'resetting',
  };
  try {
    await ctx.storage.put(TRANSPORT_FAILURE_STREAK_KEY, TRANSPORT_FAILURE_ABORT_THRESHOLD);
    await persistTransportRecovery(ctx, recovery);
    await scheduleConfirmation();
  } catch (err) {
    logger.warn('container monitor recovery: failed to persist and arm reconstruction', {
      ...transportRecoveryLogContext(ctx, recovery, probes),
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await clearTransportRecoveryState(ctx);
      return 'fallback';
    } catch {
      // The valid partial incident still owns the lifecycle. Keep its recovery
      // cadence armed rather than starting exit confirmation beside it.
      try {
        await scheduleConfirmation();
      } catch (scheduleErr) {
        logger.error('container monitor recovery: failed to re-arm retained recovery', toError(scheduleErr), {
          ...transportRecoveryLogContext(ctx, recovery, probes),
        });
      }
      return 'suppressed';
    }
  }

  logger.warn('container monitor recovery: resetting Durable Object to reconstruct container transport', {
    ...transportRecoveryLogContext(ctx, recovery, probes),
    consecutiveFailures: TRANSPORT_FAILURE_ABORT_THRESHOLD,
  });
  ctx.abort(MONITOR_TRANSPORT_ABORT_REASON);
  return 'recovering';
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
): Promise<TransportReconciliation> {
  if (recovery.status === 'exhausted') {
    // Two coordinator reconstructions plus another complete probe failure are
    // durable evidence that the recorded session is unavailable. The SDK can
    // leave container.running stuck true on this path, so waiting for the
    // not-running branch would leave KV and usage falsely running forever.
    return { nextDelaySec: 0, recordUsage: false, terminalUnavailable: true, recovery };
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
  ctx.abort(TRANSPORT_ABORT_REASON);
  return { nextDelaySec: TRANSPORT_FAILURE_RETRY_SECONDS, recordUsage: false };
}

async function reconcileNotRunningTransportRecovery(
  ctx: DurableObjectState,
): Promise<TransportReconciliation | 'none' | 'suppressed'> {
  const probes = monitorNetworkLossProbes();
  let shutdownRequested: number | undefined;
  try {
    shutdownRequested = await ctx.storage.get<number>(SHUTDOWN_REQUESTED_KEY);
  } catch (err) {
    logger.warn('collectMetrics: failed to read shutdown marker; suppressing not-running recovery', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return 'suppressed';
  }
  if (typeof shutdownRequested === 'number') return 'suppressed';

  let storedRecovery: unknown;
  try {
    storedRecovery = await ctx.storage.get<unknown>(TRANSPORT_RECOVERY_KEY);
  } catch (err) {
    logger.warn('collectMetrics: failed to read not-running transport recovery state', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return 'suppressed';
  }
  if (storedRecovery == null) return 'none';
  if (!isTransportRecoveryRecord(storedRecovery)) {
    logger.error('collectMetrics: invalid not-running transport recovery record; suppressing reconstruction', undefined, {
      durableObjectId: ctx.id.toString(),
      valueType: typeof storedRecovery,
    });
    try { await ctx.storage.delete(TRANSPORT_RECOVERY_KEY); } catch { /* remain fail-closed */ }
    return 'suppressed';
  }
  // Once both reconstruction attempts are exhausted, the ordinary persisted
  // not-running window decides whether the container really vanished.
  if (storedRecovery.status === 'exhausted') return 'none';
  return reconcileActiveTransportRecovery(ctx, storedRecovery, probes);
}

async function reconcileContainerTransport(
  ctx: DurableObjectState,
  probes: TransportProbeObservations,
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
      recordUsage: recovery?.status === 'exhausted' || (currentStreak === 0 && recovery === null),
    };
  }

  if (recovery) {
    return reconcileActiveTransportRecovery(ctx, recovery, probes);
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
    ctx.abort(TRANSPORT_ABORT_REASON);
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
    recordUsage: currentStreak === 0,
  };
}

/**
 * Collect health metrics, detect idle state, ping Timekeeper, and re-arm the schedule.
 *
 * Mutates `state` (lastSeenInputAt, _usageSeconds) in place.
 *
 * ALARM-LOOP LIFECYCLE: this runs as a one-shot DO alarm that re-arms itself
 * after 60s normally or 5s while confirming a complete transport failure,
 * ONLY while ctx.container.running. If the
 * container is not running on entry, the loop marks the session stopped (the
 * authoritative catch-all for an exit the SDK surfaced as onError, not onStop)
 * and returns WITHOUT re-arming; onStart() restarts the loop on the next start.
 * Consequences worth knowing: (a) DO alarms can fire late (observed ~60s drift
 * in prod); (b) the loop does NOT run while the DO/container is hibernated, so
 * the metrics heartbeat (m.u) can go stale on a perfectly healthy session.
 * That staleness is why a heartbeat-age heuristic is NOT a valid liveness
 * signal - KV status must come from the lifecycle hooks (see the contract above
 * container/index.ts::onStart). Removing that heuristic is codeflare#153.
 *
 * TIMESTAMP TAXONOMY (four distinct clocks - do not conflate):
 *   lastInputAt        in-container /activity: wall-clock of the latest
 *                      classified PTY input or client-to-server Browser IDE
 *                      frame. Does NOT advance on terminal output, server-to-client
 *                      editor traffic, vault/SilverBullet activity, or an
 *                      autonomously-working agent. The idle reference:
 *                      idleMs = Date.now() - (lastInputAt ?? containerStartedAt).
 *   lastSeenInputAt    MetricsState's cached copy of lastInputAt for this tick.
 *   lastActiveAt (KV)  mirrors lastInputAt (input-driven). Feeds the dashboard
 *                      sleep-timer countdown. NOT a liveness signal.
 *   metrics.updatedAt  KV meta m.u: wall-clock re-stamped here EVERY tick
 *     (m.u)            regardless of input. Metrics-staleness display only; it
 *                      freezes whenever this loop is not running (see above), so
 *                      it must not be used to infer liveness.
 */
export async function collectMetrics(
  state: MetricsState,
  ctx: DurableObjectState,
  env: Env,
  callbacks: MetricsCallbacks,
): Promise<void> {
  // Terminal convergence is a durable lifecycle phase, not transport recovery.
  // Handle it before probes, KV self-healing, or usage accounting so a later
  // host response cannot resurrect a session whose terminal stop already began.
  let storedRecovery: unknown;
  try {
    storedRecovery = await ctx.storage.get<unknown>(TRANSPORT_RECOVERY_KEY);
  } catch (err) {
    logger.warn('collectMetrics: failed to read terminal recovery ownership', {
      durableObjectId: ctx.id.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    await scheduleRecoveryOwnershipReadRetry(ctx, callbacks);
    return;
  }
  if (isTransportRecoveryRecord(storedRecovery)) {
    if (storedRecovery.status === 'terminal-status-pending'
        || storedRecovery.status === 'terminal-stop-pending') {
      await continueTerminalConvergence(state, ctx, env, callbacks, storedRecovery);
      return;
    }

    // Upgrade compatibility: the preceding implementation could write KV
    // stopped and retain only exhausted ownership when its stop request failed. Do not let
    // a newly responsive probe self-heal that terminal session.
    if (storedRecovery.status === 'exhausted') {
      let sessionId: string | undefined;
      let bucketName: string | null;
      let session: Session | null;
      try {
        sessionId = await ctx.storage.get<string>(SESSION_ID_KEY);
        bucketName = state._bucketName || await ctx.storage.get<string>('bucketName') || null;
        session = sessionId && bucketName
          ? await env.KV.get<Session>(getSessionKey(bucketName, sessionId), 'json')
          : null;
      } catch (err) {
        logger.warn('collectMetrics: failed to resolve pre-upgrade terminal ownership', {
          durableObjectId: ctx.id.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
        await scheduleRecoveryOwnershipReadRetry(ctx, callbacks);
        return;
      }
      if (sessionId && bucketName
          && (session?.status === 'stopped' || (!session && ctx.container?.running))) {
        const terminalRecovery: TransportRecoveryRecord = {
          ...storedRecovery,
          status: 'terminal-stop-pending',
        };
        try {
          await persistTransportRecovery(ctx, terminalRecovery);
        } catch (err) {
          logger.error('collectMetrics: failed to migrate pre-upgrade terminal ownership', undefined, {
            durableObjectId: ctx.id.toString(),
            error: err instanceof Error ? err.message : String(err),
          });
          await scheduleTerminalConvergenceRetry(ctx, callbacks);
          return;
        }
        await continueTerminalConvergence(state, ctx, env, callbacks, terminalRecovery);
        return;
      }
    }
  }

  // Container reads as not-running. This is EITHER a genuine exit (crash,
  // deploy-roll, platform idle-reap) that the SDK never surfaced as onError,
  // OR a transient false reading: `ctx.container.running` momentarily reports
  // false when an alarm wakes a hibernated DO or during a deploy-roll, while
  // the container is actually alive. Writing 'stopped' on a single such tick
  // both flips a live session to stopped (kicking the user to the dashboard)
  // AND kills the alarm loop (the re-arm at the foot of this function only
  // fires while running), freezing metrics until the next onStart. So require
  // the not-running reading to persist across NOT_RUNNING_CONFIRM_MS before
  // treating it as a real exit, re-arming meanwhile so the streak can be
  // observed (REQ-SESSION-018). The marker lives in DO storage so it survives
  // the hibernation/reset that causes the false reading.
  if (!ctx.container?.running) {
    const recovery = await reconcileNotRunningTransportRecovery(ctx);
    if (recovery === 'suppressed') return;
    if (recovery !== 'none') {
      try { await callbacks.schedule(recovery.nextDelaySec, 'collectMetrics'); } catch { /* DO shutting down */ }
      return;
    }

    const now = Date.now();
    const since = await ctx.storage.get<number>(NOT_RUNNING_SINCE_KEY);
    // No marker yet (real DO storage returns undefined; some mocks null): open
    // the window and re-arm without writing stopped.
    if (typeof since !== 'number') {
      await ctx.storage.put(NOT_RUNNING_SINCE_KEY, now);
      logger.info('collectMetrics: container not running, opening confirmation window', {
        confirmMs: NOT_RUNNING_CONFIRM_MS,
      });
      try { await callbacks.schedule(60, 'collectMetrics'); } catch { /* DO shutting down */ }
      return;
    }
    if (now - since < NOT_RUNNING_CONFIRM_MS) {
      logger.info('collectMetrics: container not running, within confirmation window', {
        elapsedMs: now - since, confirmMs: NOT_RUNNING_CONFIRM_MS,
      });
      // Re-arm so the streak is re-checked; onStart's deleteSchedules dedupes
      // if the container recovers and restarts the loop concurrently.
      try { await callbacks.schedule(60, 'collectMetrics'); } catch { /* DO shutting down */ }
      return;
    }
    logger.info('collectMetrics: container not running past confirmation window, marking stopped', {
      elapsedMs: now - since,
    });
    const stoppedUpdate = await updateKvStatus(ctx, env, state._bucketName, 'stopped', 'lastActiveAt');
    if (stoppedUpdate === 'failed') {
      // Keep the confirmation marker and recovery evidence until the
      // authoritative status write succeeds; retry without recording usage.
      try { await callbacks.schedule(60, 'collectMetrics'); } catch { /* DO shutting down */ }
      return;
    }
    await ctx.storage.delete(NOT_RUNNING_SINCE_KEY);
    try {
      await clearTransportRecoveryState(ctx);
    } catch (err) {
      // Recovery evidence is operational cleanup, while the stopped KV write is
      // authoritative lifecycle state. Never let stale evidence strand a dead
      // container as running when cleanup itself fails.
      logger.warn('collectMetrics: failed to clear transport recovery after confirmed exit', {
        durableObjectId: ctx.id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  // Container is running - clear any pending not-running confirmation marker so
  // a future transient blip starts a fresh streak.
  await ctx.storage.delete(NOT_RUNNING_SINCE_KEY);

  // Resolve trusted identity before either host probe for agent delivery. The
  // metrics write fresh-reads session state after the probes so a slow health
  // response cannot roll back a concurrent lifecycle or readiness update.
  const trustedTickSession = await loadTrustedTickSession(state, ctx, env);
  try {
    await deliverRunningAgentEvents(state, ctx, env, trustedTickSession);
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
  let idleTimeoutPref = '4h';
  try {
    const stored = await ctx.storage.get<string>('sleepAfter');
    if (stored && /^(5m|15m|30m|1h|2h|4h)$/.test(stored)) {
      idleTimeoutPref = stored;
    } else {
      logger.warn('collectMetrics: sleepAfter missing or invalid; selecting fail-safe 4h', { stored });
    }
  } catch (err) {
    logger.warn('collectMetrics: failed to read sleepAfter; selecting fail-safe 4h', {
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
  const activityProbeStartedAt = Date.now();
  let activityProbe: ProbeObservation = { responded: false, durationMs: 0 };
  let healthProbe: ProbeObservation = { responded: false, durationMs: 0 };

  try {
    const activityPort = ctx.container.getTcpPort(TERMINAL_SERVER_PORT);
    const activityRes = await pollContainer(activityPort, 'http://localhost/activity', CONTAINER_POLL_BUDGET_MS);
    activityProbe = {
      responded: true,
      durationMs: Math.max(0, Date.now() - activityProbeStartedAt),
      status: activityRes.status,
    };
    if (!activityRes.ok) {
      logger.warn('collectMetrics: /activity returned non-OK', { status: activityRes.status });
    } else {
      const activity = await activityRes.json() as ActivityState;

      state.lastSeenInputAt = activity.lastInputAt;

      // Explicit idle-stop: stop the container when idle exceeds the
      // user-configured threshold. Fall back to containerStartedAt when
      // no classified terminal or Browser IDE input has arrived (lastInputAt null).
      const referenceTime = activity.lastInputAt ?? state.containerStartedAt;
      const idleMs = Date.now() - referenceTime;
      if (idleMs > sleepMs) {
        logger.info('collectMetrics: idle exceeded threshold, stopping', {
          idleMs, sleepMs, idleTimeoutPref, referenceTime, lastInputAt: activity.lastInputAt,
        });
        // Write KV status before stop — DO state can be lost during shutdown
        await updateKvStatus(ctx, env, state._bucketName, 'stopped', 'lastActiveAt');
        // Final notification delivery and R2 sync are independent best-effort
        // drains. Both run while the host is alive and before SIGTERM.
        await drainAgentEventsBeforeStop(
          state,
          ctx,
          env,
          CONTAINER_POLL_BUDGET_MS,
        );
        await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
        await callbacks.stop('SIGTERM');
        return;
      }

      logger.info('collectMetrics: activity check', {
        lastInputAt: activity.lastInputAt,
        lastSeenInputAt: state.lastSeenInputAt,
        connectedClients: activity.connectedClients,
        hasActiveConnections: activity.hasActiveConnections,
        idleMs, sleepMs, idleTimeoutPref,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!activityProbe.responded) {
      activityProbe = failedProbeObservation(err, activityProbeStartedAt);
    }
    logger.warn('collectMetrics: activity check failed', { error });
  }

  const healthProbeStartedAt = Date.now();
  try {
    const tcpPort = ctx.container.getTcpPort(8080);
    const res = await pollContainer(tcpPort, 'http://localhost/health', CONTAINER_POLL_BUDGET_MS);
    healthProbe = {
      responded: true,
      durationMs: Math.max(0, Date.now() - healthProbeStartedAt),
      status: res.status,
    };

    if (!res.ok) {
      // Health endpoint returned non-200 (e.g. container still booting).
      // Don't parse — just log and re-arm below.
      logger.info('collectMetrics: health non-OK', { status: res.status });
    } else {
      const health = await res.json() as { cpu?: string; mem?: string; hdd?: string; syncStatus?: string; editorReady?: boolean };

      if (health.syncStatus === 'failed' || health.syncStatus === 'timeout') {
        // Surface in-container bisync failures in Workers logs: the integration
        // bisync death of 2026-05-31 ran invisible for 11 days because the sync
        // daemon's state never left the container (sync.log is not shipped
        // anywhere). One warn per metrics tick (60s) while the condition
        // persists - cheap, queryable, alertable.
        logger.warn('collectMetrics: container R2 sync unhealthy', { syncStatus: health.syncStatus });
      }

      if (trustedTickSession.error !== undefined) throw trustedTickSession.error;
      const { sessionId, bucketName } = trustedTickSession;

      if (!sessionId || !bucketName) {
        logger.info('collectMetrics: missing identifiers, not re-arming (zombie DO)', { sessionId: !!sessionId, bucketName: !!bucketName });
        return; // Don't re-arm schedule — zombie DO, let it die
      } else if (ctx.container?.running) {
        const key = getSessionKey(bucketName, sessionId);
        // Fresh-read after every host probe, then merge only fields owned by
        // this metrics tick. No concern overlay or prefix scan is introduced.
        const session = await env.KV.get<Session>(key, 'json');
        if (session) {
          const metrics = {
            cpu: health.cpu,
            mem: health.mem,
            hdd: health.hdd,
            syncStatus: health.syncStatus,
            updatedAt: new Date().toISOString(),
          };
          const lastActiveAt = state.lastSeenInputAt
            ? new Date(state.lastSeenInputAt).toISOString()
            : session.lastActiveAt;
          let nextSession: Session = { ...session, metrics, lastActiveAt };
          if (session.workspace === 'vscode' && health.editorReady === true) {
            const { editorReadyError: _staleEditorError, ...withoutEditorError } = nextSession;
            nextSession = { ...withoutEditorError, editorReady: true };
          }

          // destroy() persists this marker before draining or deleting the
          // session. Read it after the awaited primary-record read and directly
          // before the write, closing the Stop/Delete interleaving without KV
          // overlays, CAS machinery, or a list-prefix read.
          const shutdownRequested = await ctx.storage.get<number>(SHUTDOWN_REQUESTED_KEY);
          if (typeof shutdownRequested === 'number') {
            logger.info('collectMetrics: shutdown in flight, skipping primary session write', { key });
          } else if (session.status !== 'running') {
            // Self-heal FALSE stopped and legacy/missing status
            // (REQ-SESSION-018 AC5): shutdown was ruled out and the container
            // is alive, so verified liveness converges KV back to running.
            logger.warn('collectMetrics: container running but KV not running, re-asserting running (self-heal)', { key });
            await putSessionWithMetadata(env.KV, key, { ...nextSession, status: 'running' as const });
          } else {
            await putSessionWithMetadata(env.KV, key, nextSession);
          }
        }
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!healthProbe.responded) {
      healthProbe = failedProbeObservation(err, healthProbeStartedAt);
    }
    logger.warn('collectMetrics: fetch/write failed', { error });
  }

  const transportReconciliation = await reconcileContainerTransport(ctx, {
    activity: activityProbe,
    health: healthProbe,
  });
  if (transportReconciliation === null) {
    // Deliberate teardown owns the lifecycle, or its ownership cannot be read.
    // Fail closed: do not re-arm or reset the Durable Object.
    return;
  }
  if (transportReconciliation.terminalUnavailable) {
    logger.error('collectMetrics: exhausted transport remains unreachable, beginning terminal convergence', undefined, {
      durableObjectId: ctx.id.toString(),
      containerRunning: ctx.container?.running ?? false,
      probes: { activity: activityProbe, health: healthProbe },
    });
    const terminalRecovery: TransportRecoveryRecord = {
      ...transportReconciliation.recovery!,
      status: 'terminal-status-pending',
    };
    try {
      await persistTransportRecovery(ctx, terminalRecovery);
    } catch (err) {
      logger.error('collectMetrics: failed to persist terminal status ownership', undefined, {
        durableObjectId: ctx.id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      await scheduleTerminalConvergenceRetry(ctx, callbacks);
      return;
    }
    await continueTerminalConvergence(state, ctx, env, callbacks, terminalRecovery);
    return;
  }

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
        if (quotaExceeded && isSaasModeActive(env.SAAS_MODE)) {
          logger.warn('Quota exceeded — stopping container', { bucketName: state._bucketName });
          // Final notification delivery and R2 sync are independent
          // best-effort drains, both completed before SIGTERM.
          await drainAgentEventsBeforeStop(
            state,
            ctx,
            env,
            CONTAINER_POLL_BUDGET_MS,
          );
          await drainFinalSync(ctx, FINAL_SYNC_BUDGET_MS);
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

  // Re-arm only if still running. schedule() is one-shot — if we don't
  // re-arm, onStart() will restart the loop on next container start.
  if (ctx.container?.running) {
    try {
      await callbacks.schedule(transportReconciliation.nextDelaySec, 'collectMetrics');
    } catch {
      // DO is shutting down or destroyed
    }
  }
}
