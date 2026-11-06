import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireActiveUser, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

/** Exercise the real secret validator and tier gate, not a mocked identity. */
function protectedApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', requireActiveUser);
  app.get('/protected', requireAdmin, c => c.json({ allowed: true }));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.statusCode as 400 | 401 | 403 | 404);
    }
    return c.json({ error: 'Unexpected error' }, 500);
  });
  return app;
}

function serviceEnv(flags: Partial<Env>): Env {
  return {
    KV: createMockKV() as unknown as KVNamespace,
    CONTAINER: {
      idFromName: (name: string) => name,
      get: () => ({ claimBucketOwner: async () => 'owned' as const }),
    } as unknown as Env['CONTAINER'],
    OAUTH_CLIENT_ID: 'test-oauth-client',
    SERVICE_AUTH_SECRET: 'test-service-key',
    ...flags,
  } as Env;
}

const modes: Array<[string, Partial<Env>]> = [
  ['SaaS', { SAAS_MODE: 'active' }],
  ['onboarding', { ONBOARDING_LANDING_PAGE: 'active' }],
];

describe('REQ-AUTH-004: service automation reaches active-user APIs', () => {
  it.each(modes)('allows a valid service identity through the tier and admin gates in %s mode', async (_mode, flags) => {
    const env = serviceEnv(flags);
    const response = await protectedApp().request('/protected', {
      headers: { 'X-Service-Auth': 'test-service-key' },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true });
  });

  it.each(modes)('rejects an incorrect service credential in %s mode', async (_mode, flags) => {
    const env = serviceEnv(flags);
    const response = await protectedApp().request('/protected', {
      headers: { 'X-Service-Auth': 'fake-service-key' },
    }, env);

    expect(response.status).toBe(401);
  });

  it.each(modes)('does not grant service access when its secret is unconfigured in %s mode', async (_mode, flags) => {
    const env = serviceEnv({ ...flags, SERVICE_AUTH_SECRET: undefined });
    const response = await protectedApp().request('/protected', {
      headers: { 'X-Service-Auth': 'test-service-key' },
    }, env);

    expect(response.status).toBe(401);
  });
});
