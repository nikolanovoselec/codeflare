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
