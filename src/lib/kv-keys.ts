/**
 * KV key utilities for session management
 */
import type { Session } from '../types';
import { NotFoundError } from './error-types';
import { createLogger } from './logger';

/**
 * Compressed metadata embedded in KV list keys for session status.
 * batch-status reads this instead of N individual KV.get calls.
 * Must fit within Cloudflare KV's 1024-byte metadata limit (~195 bytes worst case).
 */
export interface SessionListMetadata {
  /** status: 'r' = running, 's' = stopped */
  s?: 'r' | 's';
  /** lastActiveAt ISO string */
  la?: string;
  /** lastStartedAt ISO string */
  sa?: string;
  /** metrics */
  m?: {
    /** cpu */
    c?: string;
    /** mem */
    e?: string;
    /** hdd */
    h?: string;
    /** syncStatus */
    y?: string;
    /**
     * updatedAt: wall-clock heartbeat re-stamped by collectMetrics every tick
     * regardless of PTY input. For the metrics-staleness display ONLY - it is
     * NOT a liveness signal (it freezes whenever the collectMetrics alarm loop
     * is not running, e.g. during DO/container hibernation). Liveness comes from
     * the authoritative KV `status`, written by the container lifecycle hooks
     * (src/container/index.ts onStart/onStop/onError). A heartbeat-age heuristic
     * here previously caused false "stopped" kicks; removed in codeflare#153.
     */
    u?: string;
  };
}

/** Build compressed list metadata from a Session object. */
export function buildSessionMetadata(session: Session): SessionListMetadata {
  const meta: SessionListMetadata = {
    s: session.status === 'running' ? 'r' : 's',
    la: session.lastActiveAt,
    sa: session.lastStartedAt,
  };
  if (session.metrics) {
    meta.m = {
      ...(session.metrics.cpu && { c: session.metrics.cpu }),
      ...(session.metrics.mem && { e: session.metrics.mem }),
      ...(session.metrics.hdd && { h: session.metrics.hdd }),
      ...(session.metrics.syncStatus && { y: session.metrics.syncStatus }),
      ...(session.metrics.updatedAt && { u: session.metrics.updatedAt }),
    };
  }
  return meta;
}

/** Expand compressed metadata to the shape batch-status returns. */
export function expandSessionMetadata(meta: SessionListMetadata): {
  status: string;
  ptyActive: boolean;
  lastActiveAt: string | null;
  lastStartedAt: string | null;
  metrics?: Session['metrics'];
} {
  const isRunning = meta.s === 'r';
  return {
    status: isRunning ? 'running' : 'stopped',
    ptyActive: isRunning,
    lastActiveAt: meta.la || null,
    lastStartedAt: meta.sa || null,
    ...(meta.m && {
      metrics: {
        ...(meta.m.c && { cpu: meta.m.c }),
        ...(meta.m.e && { mem: meta.m.e }),
        ...(meta.m.h && { hdd: meta.m.h }),
        ...(meta.m.y && { syncStatus: meta.m.y }),
        ...(meta.m.u && { updatedAt: meta.m.u }),
      },
    }),
  };
}

/**
 * Write a session to KV with synchronized list metadata.
 * All session KV.put calls MUST use this to keep metadata in sync.
 */
export async function putSessionWithMetadata(
  kv: KVNamespace,
  key: string,
  session: Session,
): Promise<void> {
  const metadata = buildSessionMetadata(session);
  await kv.put(key, JSON.stringify(session), { metadata });
}

/**
 * Extract the email address from a KV key like "user:alice@example.com"
 */
export function emailFromKvKey(keyName: string): string {
  return keyName.replace('user:', '');
}

/** Maximum number of pagination iterations for listAllKvKeys to prevent infinite loops */
const MAX_KV_LIST_ITERATIONS = 100;

/**
 * Sanitize a session name to prevent shell injection and XSS.
 * Allows only: alphanumeric, spaces, hyphens, underscores, and '#'.
 * Rejects all shell metacharacters ($, `, |, ;, &, <, >, etc.) and special chars.
 * Example: "Claude Code #1" → "Claude Code #1", "Bad$(rm -rf)" → "Badrmrf"
 */
export function sanitizeSessionName(name: string): string {
  // Allowlist: a-z A-Z 0-9 space hyphen underscore hash
  // Uses replace (not regex alternation) to ensure single-pass filtering
  return name.replace(/[^a-zA-Z0-9 #_-]/g, '').trim() || 'Untitled';
}

/**
 * Get KV key for a session
 */
export function getSessionKey(bucketName: string, sessionId: string): string {
  return `session:${bucketName}:${sessionId}`;
}

/**
 * Get KV prefix for user sessions
 */
export function getSessionPrefix(bucketName: string): string {
  return `session:${bucketName}:`;
}

/**
 * Generate a cryptographically secure random session ID.
 *
 * Produces 96 bits of entropy (12 random bytes) encoded as 24 lowercase hex
 * characters. Matches SESSION_ID_PATTERN validation regex: `/^[a-z0-9]{8,24}$/`
 *
 * @returns 24-character hex string (e.g., "a1b2c3d4e5f6a7b8c9d0e1f2")
 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch a session from KV or throw NotFoundError if it doesn't exist.
 */
export async function getSessionOrThrow(kv: KVNamespace, key: string): Promise<Session> {
  const session = await kv.get<Session>(key, 'json');
  if (!session) {
    throw new NotFoundError('Session');
  }
  return session;
}

/**
 * Get KV key for user presets
 */
export function getPresetsKey(bucketName: string): string {
  return `presets:${bucketName}`;
}

/**
 * Get KV key for user preferences
 */
export function getPreferencesKey(bucketName: string): string {
  return `user-prefs:${bucketName}`;
}

/**
 * Get KV key for user LLM API keys
 */
export function getLlmKeysKey(bucketName: string): string {
  return `llm-keys:${bucketName}`;
}

/**
 * Get KV key for user deploy credentials (GitHub + Cloudflare tokens)
 */
export function getDeployKeysKey(bucketName: string): string {
  return `deploy-keys:${bucketName}`;
}

/**
 * Get KV key for subscription tier configuration
 */
export function getTiersConfigKey(): string {
  return 'tiers:config';
}

/**
 * Get KV key for a user's Timekeeper usage record
 */
export function getTimekeeperKey(bucketName: string): string {
  return `timekeeper:${bucketName}`;
}

/**
 * Get UTC date string in YYYY-MM-DD format
 */
export function getUtcDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Get UTC month string in YYYY-MM format
 */
export function getUtcMonthString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Return Unix timestamp (seconds) for the next 1st of UTC month at 00:00:00.
 * Used to anchor Stripe subscriptions so the billing cycle matches the monthly
 * quota reset boundary.
 *
 */
export function getNextUtcMonthStart(now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.floor(next.getTime() / 1000);
}

/**
 * Get the ISO week start (Monday) date string for a given date.
 * ISO weeks start on Monday. Returns YYYY-MM-DD of the Monday.
 */
export function getIsoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay() returns 0=Sun, 1=Mon, ..., 6=Sat
  // Convert to Mon=0, Tue=1, ..., Sun=6
  const dayOfWeek = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOfWeek);
  return getUtcDateString(d);
}

/**
 * Centralized setup KV key constants. Eliminates raw 'setup:*' strings across 17+ files.
 */
export const SETUP_KEYS = {
  COMPLETE: 'setup:complete',
  COMPLETED_AT: 'setup:completed_at',
  CONFIGURING: 'setup:configuring',
  ACCOUNT_ID: 'setup:account_id',
  R2_ENDPOINT: 'setup:r2_endpoint',
  CUSTOM_DOMAIN: 'setup:custom_domain',
  ALLOWED_ORIGINS: 'setup:allowed_origins',
  ONBOARDING_LANDING_PAGE: 'setup:onboarding_landing_page',
  AUTH_DOMAIN: 'setup:auth_domain',
  ACCESS_AUD: 'setup:access_aud',
  ACCESS_AUD_LIST: 'setup:access_aud_list',
  ACCESS_APP_ID: 'setup:access_app_id',
  ACCESS_GROUP_ADMIN_ID: 'setup:access_group_admin_id',
  ACCESS_GROUP_USER_ID: 'setup:access_group_user_id',
  ACCESS_GROUP_ADMIN_NAME: 'setup:access_group_admin_name',
  ACCESS_GROUP_USER_NAME: 'setup:access_group_user_name',
  ENTERPRISE_ACCESS_GROUP: 'setup:enterprise_access_group',
  IDP_LIST: 'setup:idp_list',
  MAX_USERS: 'setup:max_users',
  TURNSTILE_SITE_KEY: 'setup:turnstile_site_key',
  TURNSTILE_SECRET_KEY: 'setup:turnstile_secret_key',
} as const;

/**
 * Strict hostname validation for the KV-stored custom domain (CF-018).
 * Accepts only a bare hostname: one or more DNS labels separated by single
 * dots, each label 1-63 chars of [a-z0-9-] not starting/ending with a hyphen.
 * Rejects schemes, paths, ports, userinfo, consecutive dots ('..'), and any
 * other character - so a poisoned KV value can never inject into the redirect
 * base URL.
 */
const CUSTOM_DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

function isValidCustomDomain(domain: string): boolean {
  return CUSTOM_DOMAIN_PATTERN.test(domain);
}

const baseUrlLogger = createLogger('kv-keys');

/**
 * Resolve the base URL for redirects using custom domain from KV or the request origin.
 * The custom domain is validated as a bare hostname (CF-018); an invalid value
 * falls back to the request origin rather than producing a malformed/poisoned URL.
 */
export async function getBaseUrl(kv: KVNamespace, requestUrl: string): Promise<string> {
  const customDomain = await kv.get(SETUP_KEYS.CUSTOM_DOMAIN);
  if (customDomain && isValidCustomDomain(customDomain)) {
    return `https://${customDomain}`;
  }
  if (customDomain) {
    baseUrlLogger.warn('Ignoring invalid custom_domain, falling back to request origin', { customDomain });
  }
  return new URL(requestUrl).origin;
}

/**
 * Fetch all KV keys matching a prefix, handling pagination safely.
 *
 * Cloudflare KV returns a maximum of 1000 keys per call. This function
 * iterates through all pages using cursor-based pagination, with a safety
 * limit to prevent infinite loops.
 *
 * @param kv - KV namespace binding
 * @param prefix - Key prefix to list (e.g., "user:" or "session:bucket:")
 * @returns Array of all matching keys across all pages
 * @throws If more than MAX_KV_LIST_ITERATIONS pages are encountered (indicates infinite pagination)
 */
export async function listAllKvKeys(kv: KVNamespace, prefix: string): Promise<KVNamespaceListKey<unknown>[]> {
  const keys: KVNamespaceListKey<unknown>[] = [];
  let cursor: string | undefined;
  let iterations = 0;
  do {
    const result = await kv.list({ prefix, cursor });
    keys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor;
    iterations++;
  } while (cursor && iterations < MAX_KV_LIST_ITERATIONS);
  return keys;
}
