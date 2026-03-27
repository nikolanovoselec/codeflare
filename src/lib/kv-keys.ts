/**
 * KV key utilities for session management
 */
import type { Session } from '../types';
import { NotFoundError } from './error-types';

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
  IDP_LIST: 'setup:idp_list',
  MAX_USERS: 'setup:max_users',
  TURNSTILE_SITE_KEY: 'setup:turnstile_site_key',
  TURNSTILE_SECRET_KEY: 'setup:turnstile_secret_key',
} as const;

/**
 * Resolve the base URL for redirects using custom domain from KV or the request origin.
 */
export async function getBaseUrl(kv: KVNamespace, requestUrl: string): Promise<string> {
  const customDomain = await kv.get(SETUP_KEYS.CUSTOM_DOMAIN);
  return customDomain ? `https://${customDomain}` : new URL(requestUrl).origin;
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
