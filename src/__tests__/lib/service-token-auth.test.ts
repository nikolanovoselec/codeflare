import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUserFromRequest } from '../../lib/access';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

/**
 * REQ-AUTH-004: Service Token Authentication for E2E
 *
 * Exercises the X-Service-Auth header path in getUserFromRequest:
 *   AC1: X-Service-Auth header is checked FIRST across all auth modes.
 *   AC2: Header value compared against SERVICE_AUTH_SECRET using
 *        constant-time comparison.
 *   AC3: Successful service token auth returns admin user mapped to
 *        SERVICE_TOKEN_EMAIL (or fallback fixture).
 *   AC5: When the secret is not set, service auth is disabled.
 */
describe('Service Token Authentication / REQ-AUTH-004 AC1/AC2/AC3/AC5 (X-Service-Auth header checked first, constant-time compare, admin role, disabled when secret unset)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return { KV: mockKV as unknown as KVNamespace, ...overrides } as Env;
  }

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
  });

  it('AC1+AC3: returns admin user mapped to SERVICE_TOKEN_EMAIL when X-Service-Auth matches SERVICE_AUTH_SECRET', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'shared-secret-123' },
    });
    const user = await getUserFromRequest(
      request,
      makeEnv({
        SERVICE_AUTH_SECRET: 'shared-secret-123',
        SERVICE_TOKEN_EMAIL: 'svc@company.com',
      } as Partial<Env>)
    );
    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('svc@company.com');
    expect(user.role).toBe('admin');
  });

  it('AC3: falls back to a fixture service email when SERVICE_TOKEN_EMAIL is not set', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'another-secret' },
    });
    const user = await getUserFromRequest(
      request,
      makeEnv({ SERVICE_AUTH_SECRET: 'another-secret' } as Partial<Env>)
    );
    expect(user.authenticated).toBe(true);
    expect(user.role).toBe('admin');
    expect(user.email).toMatch(/@/); // some non-empty email
  });

  it('AC2: rejects when header value does not match secret (constant-time compare returns false)', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'wrong-value-same-length' },
    });
    const user = await getUserFromRequest(
      request,
      makeEnv({ SERVICE_AUTH_SECRET: 'right-value-same-length' } as Partial<Env>)
    );
    expect(user.authenticated).toBe(false);
  });

  it('AC2: rejects on length mismatch (constant-time compare requires equal byte length)', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'short' },
    });
    const user = await getUserFromRequest(
      request,
      makeEnv({ SERVICE_AUTH_SECRET: 'much-longer-secret-value' } as Partial<Env>)
    );
    expect(user.authenticated).toBe(false);
  });

  it('AC5: disabled when SERVICE_AUTH_SECRET is not set in env (X-Service-Auth header ignored)', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'any-value' },
    });
    const user = await getUserFromRequest(request, makeEnv() /* no SERVICE_AUTH_SECRET */);
    // Without the secret configured, the service-auth branch is skipped
    // entirely; no auth source available -> unauthenticated.
    expect(user.authenticated).toBe(false);
  });

  it('AC1: service token wins over CF Access header (resolution order)', async () => {
    const request = new Request('http://localhost/test', {
      headers: {
        'X-Service-Auth': 'service-secret',
        'cf-access-authenticated-user-email': 'someone@example.com',
      },
    });
    const user = await getUserFromRequest(
      request,
      makeEnv({
        SERVICE_AUTH_SECRET: 'service-secret',
        SERVICE_TOKEN_EMAIL: 'svc@company.com',
      } as Partial<Env>)
    );
    // Service token must beat the CF Access header (priority order AC1).
    expect(user.email).toBe('svc@company.com');
    expect(user.role).toBe('admin');
  });
});
