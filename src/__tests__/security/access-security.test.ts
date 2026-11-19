/**
 * Security-gap tests for access.ts auth gate
 *
 *   REQ-SEC-014 AC1  — cf-access-client-id header only trusted when !isSaasModeActive()
 *   REQ-SEC-014 AC2  — In SaaS mode the header is ignored (attacker-controlled)
 *   REQ-SEC-016 AC1/2 — Independent requests do not share pending storage I/O
 *   REQ-SEC-016 AC3   — Completed caches are reusable and explicitly invalidated
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

// ── REQ-SEC-016: request-independent completed configuration cache ──────────

describe('REQ-SEC-016: independent auth requests and completed cache reuse', () => {
  beforeEach(() => {
    resetAuthConfigCache();
    vi.clearAllMocks();
  });

  const request = () => new Request('http://localhost/test', {
    headers: { 'cf-access-authenticated-user-email': 'setup@example.test' },
  });

  it('REQ-SEC-016 AC1/AC2: held storage I/O cannot stall a second authentication request', async () => {
    const mockKV = createMockKV();
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-123');
    const get = mockKV.get;
    let resolveHeld!: (value: string | null) => void;
    let markStarted!: () => void;
    let hold = true;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const held = new Promise<string | null>(resolve => { resolveHeld = resolve; });
    mockKV.get = vi.fn(async (key, type) => {
      if (key === 'setup:auth_domain' && hold) {
        hold = false;
        markStarted();
        return held;
      }
      return get(key, type);
    });
    const env = makeEnv({}, mockKV);
    const first = getUserFromRequest(request(), env);
    await started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const second = await Promise.race([
        getUserFromRequest(request(), env),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Independent request stalled')), 2000);
        }),
      ]);
      expect(second).toMatchObject({ authenticated: false, email: '' });
    } finally {
      clearTimeout(timer);
      resolveHeld('team.cloudflareaccess.com');
      expect(await first).toMatchObject({ authenticated: false, email: '' });
    }
  });

  it('REQ-SEC-016 AC1: completed configuration remains usable during a storage outage', async () => {
    const mockKV = createMockKV();
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-123');
    const env = makeEnv({}, mockKV);
    expect((await getUserFromRequest(request(), env)).authenticated).toBe(false);
    mockKV.get.mockRejectedValue(new Error('Storage unavailable'));
    expect((await getUserFromRequest(request(), env)).authenticated).toBe(false);
  });

  it('REQ-SEC-016 AC3: reset makes newly configured authentication visible', async () => {
    const mockKV = createMockKV();
    const env = makeEnv({}, mockKV);
    expect((await getUserFromRequest(request(), env)).authenticated).toBe(true);
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-123');
    resetAuthConfigCache();
    expect(await getUserFromRequest(request(), env)).toMatchObject({ authenticated: false, email: '' });
  });
});
