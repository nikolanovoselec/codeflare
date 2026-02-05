/**
 * Shared mock factories for backend tests.
 *
 * Provides factory functions that return fully valid default objects with
 * optional partial overrides. Using spread merging keeps tests concise
 * while remaining explicit about what each test cares about.
 */
import { vi } from 'vitest';
import type { Env, Session, AccessUser, TabConfig } from '../../types';

// ── Mock User ─────────────────────────────────────────────────────────────────

/**
 * Create a mock AccessUser with sensible defaults.
 *
 * @example
 *   createMockUser()                          // default test user
 *   createMockUser({ role: 'admin' })         // admin user
 *   createMockUser({ email: 'a@b.com' })      // custom email
 */
export function createMockUser(overrides?: Partial<AccessUser>): AccessUser {
  return {
    email: 'test@example.com',
    authenticated: true,
    ...overrides,
  };
}

// ── Mock Session ──────────────────────────────────────────────────────────────

/**
 * Create a mock Session object with sensible defaults.
 *
 * @example
 *   createMockSession()                                   // running session
 *   createMockSession({ status: 'stopped' })              // stopped session
 *   createMockSession({ id: 'custom', name: 'Custom' })   // named session
 */
export function createMockSession(overrides?: Partial<Session>): Session {
  const now = new Date().toISOString();
  return {
    id: 'test-session-1',
    name: 'Test Session',
    userId: 'test@example.com',
    createdAt: now,
    lastAccessedAt: now,
    status: 'running',
    ...overrides,
  };
}

// ── Mock Env ──────────────────────────────────────────────────────────────────

/**
 * Create a mock Env (Cloudflare bindings) with all required fields.
 *
 * Pass a mock KV namespace and optional overrides for secrets/tokens.
 *
 * @example
 *   createMockEnv({ KV: mockKV })
 *   createMockEnv({ KV: mockKV, CLOUDFLARE_API_TOKEN: 'custom-token' })
 */
export function createMockEnv(overrides?: Partial<Env>): Env {
  return {
    ASSETS: {} as Fetcher,
    KV: {} as KVNamespace,
    CONTAINER: {} as any,
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    CLOUDFLARE_API_TOKEN: 'test-token',
    ...overrides,
  } as Env;
}

// ── Mock R2 Client ────────────────────────────────────────────────────────────

/**
 * Create mock R2 client functions (fetch, sign, etc.) using vi.hoisted()-compatible fns.
 *
 * Returns mock fns suitable for `vi.mock('../../lib/r2-client', ...)`.
 *
 * @example
 *   const r2 = createMockR2Client();
 *   r2.mockFetch.mockResolvedValue(new Response('', { status: 200 }));
 */
export function createMockR2Client() {
  const mockFetch = vi.fn();
  const mockSign = vi.fn();

  const mockCreateR2Client = vi.fn(() => ({ fetch: mockFetch, sign: mockSign }));
  const mockGetR2Url = vi.fn(
    (endpoint: string, bucket: string, key?: string) =>
      key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`,
  );

  return { mockFetch, mockSign, mockCreateR2Client, mockGetR2Url };
}

// ── Mock R2 Config ────────────────────────────────────────────────────────────

/**
 * Create the default mock return value for getR2Config().
 */
export function createMockR2Config(overrides?: {
  accountId?: string;
  endpoint?: string;
}) {
  return {
    accountId: overrides?.accountId ?? 'test-account',
    endpoint:
      overrides?.endpoint ?? 'https://test.r2.cloudflarestorage.com',
  };
}

// ── Mock Tab Config ───────────────────────────────────────────────────────────

/**
 * Create a mock TabConfig entry.
 */
export function createMockTabConfig(overrides?: Partial<TabConfig>): TabConfig {
  return {
    id: '1',
    command: '',
    label: 'Terminal 1',
    ...overrides,
  };
}
