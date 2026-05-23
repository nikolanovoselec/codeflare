/**
 * Security-gap tests for access.ts auth gate
 *
 *   REQ-SEC-014 AC1  — cf-access-client-id header only trusted when !isSaasModeActive()
 *   REQ-SEC-014 AC2  — In SaaS mode the header is ignored (attacker-controlled)
 *   REQ-SEC-016 AC1  — pendingAuthConfigFetch sentinel wraps the fetch
 *   REQ-SEC-016 AC2  — Two concurrent cold-start requests reuse the in-flight fetch
 *   REQ-SEC-016 AC3  — resetAuthConfigCache() clears the sentinel
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoggerWarn, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: mockLoggerError,
    debug: vi.fn(),
    warn: mockLoggerWarn,
  })),
}));

const { mockSendWelcomeEmail } = vi.hoisted(() => ({
  mockSendWelcomeEmail: vi.fn(async () => true),
}));
vi.mock('../../lib/email', () => ({
  sendWelcomeEmail: mockSendWelcomeEmail,
}));

import {
  getUserFromRequest,
  resetAuthConfigCache,
} from '../../lib/access';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}, kv?: ReturnType<typeof createMockKV>): Env {
  const mockKV = kv ?? createMockKV();
  return { KV: mockKV as unknown as KVNamespace, ...overrides } as Env;
}

// ── REQ-SEC-014: cf-access-client-id ignored in SaaS mode ────────────────────

describe('REQ-SEC-014 AC1/AC2: cf-access-client-id is NOT trusted in SaaS mode', () => {
  beforeEach(() => {
    resetAuthConfigCache();
    vi.clearAllMocks();
  });

  it('REQ-SEC-014 AC1: cf-access-client-id IS trusted in non-SaaS mode (baseline)', async () => {
    // Verify the header works in non-SaaS to confirm the test exercises the right code path
    const request = new Request('http://localhost/test', {
      headers: { 'cf-access-client-id': 'abc123.access.token' },
    });
    const env = makeEnv(); // no SAAS_MODE
    const user = await getUserFromRequest(request, env);

    // Non-SaaS: header trusted — user is authenticated
    expect(user.authenticated).toBe(true);
    expect(user.email).toContain('service-abc123');
  });

  it('REQ-SEC-014 AC2: cf-access-client-id is ignored when SAAS_MODE=active (attacker-controlled)', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'cf-access-client-id': 'attacker-controlled-id' },
    });
    const env = makeEnv({ SAAS_MODE: 'active' } as Partial<Env>);
    const user = await getUserFromRequest(request, env);

    // SaaS mode: no CF Access edge, so this header MUST be ignored
    expect(user.authenticated).toBe(false);
    expect(user.email).toBe('');
  });

  it('REQ-SEC-014 AC2: SaaS mode with cf-access-client-id AND no codeflare_session cookie is unauthenticated', async () => {
    // No session cookie + attacker-injected cf-access-client-id must not authenticate
    const request = new Request('http://localhost/test', {
      headers: {
        'cf-access-client-id': 'evil-client-id',
        // No Cookie header
      },
    });
    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client-id',
      OAUTH_JWT_SECRET: 'some-secret',
    } as Partial<Env>);
    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(false);
  });

  it('REQ-SEC-014 AC2: Injecting cf-access-client-id in SaaS mode does not produce a service email identity', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'cf-access-client-id': 'evil@attacker.com' },
    });
    const env = makeEnv({ SAAS_MODE: 'active' } as Partial<Env>);
    const user = await getUserFromRequest(request, env);

    // Must not produce an email identity from the injected header
    expect(user.email).toBe('');
    expect(user.authenticated).toBe(false);
  });
});

// ── REQ-SEC-016: pendingAuthConfigFetch concurrent dedup sentinel ─────────────

describe('REQ-SEC-016 AC1/AC2: concurrent cold-start requests deduplicate KV reads', () => {
  beforeEach(() => {
    resetAuthConfigCache();
    vi.clearAllMocks();
  });

  it('REQ-SEC-016 AC2: two concurrent getUserFromRequest calls issue only ONE KV read for auth config', async () => {
    const mockKV = createMockKV();

    // Simulate a slow KV response to make concurrency observable
    let resolveKv!: (value: string | null) => void;
    const kvPromise = new Promise<string | null>((resolve) => {
      resolveKv = resolve;
    });
    mockKV.get = vi.fn().mockReturnValueOnce(kvPromise).mockResolvedValue(null);

    const env = makeEnv({}, mockKV);

    const req1 = new Request('http://localhost/test');
    const req2 = new Request('http://localhost/test');

    // Fire both concurrently before the first KV read resolves
    const [p1, p2] = [
      getUserFromRequest(req1, env),
      getUserFromRequest(req2, env),
    ];

    // Now let the KV resolve
    resolveKv(null);

    await Promise.all([p1, p2]);

    // KV.get for auth_domain should have been called exactly once despite two concurrent requests
    const authDomainCalls = (mockKV.get as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: string[]) => call[0] === 'setup:auth_domain'
    );
    expect(authDomainCalls.length).toBe(1);
  });

  it('REQ-SEC-016 AC2: sequential requests after cache is warm do not re-read KV', async () => {
    const mockKV = createMockKV();
    const env = makeEnv({}, mockKV);

    const req1 = new Request('http://localhost/test');
    const req2 = new Request('http://localhost/test');

    // First request warms the cache
    await getUserFromRequest(req1, env);
    const callsAfterFirst = (mockKV.get as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second request should NOT re-read KV for auth config
    await getUserFromRequest(req2, env);
    const callsAfterSecond = (mockKV.get as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('REQ-SEC-016 AC3: resetAuthConfigCache clears the sentinel so next request re-reads KV', async () => {
    const mockKV = createMockKV();
    const env = makeEnv({}, mockKV);

    // Warm the cache
    await getUserFromRequest(new Request('http://localhost/test'), env);
    const callsAfterWarm = (mockKV.get as ReturnType<typeof vi.fn>).mock.calls.length;

    // Reset the cache
    resetAuthConfigCache();

    // Next request must re-read KV
    await getUserFromRequest(new Request('http://localhost/test'), env);
    const callsAfterReset = (mockKV.get as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callsAfterReset).toBeGreaterThan(callsAfterWarm);
  });
});
