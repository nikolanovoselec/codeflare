import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

const mocks = vi.hoisted(() => ({
  configureManagedEnvironment: vi.fn(async () => ({
    enabled: true,
    active: { sequence: 1, digest: 'd'.repeat(64) },
  })),
  getManagedEnvironmentPrefill: vi.fn(async () => ({
    enabled: true,
    configured: true,
    repository: 'acme/curation',
    personalAccessTokenSet: true,
    publicKeyFingerprint: 'f'.repeat(16),
    activeReleaseTag: 'release-7',
    activeSequence: 7,
    activeDigestPrefix: 'd'.repeat(12),
    freshness: 'fresh',
    lastCheckedAt: '2026-08-18T00:00:00.000Z',
    patExpiryState: 'valid',
  })),
}));

vi.mock('../../lib/remote-curation', () => ({
  configureManagedEnvironment: mocks.configureManagedEnvironment,
  getManagedEnvironmentPrefill: mocks.getManagedEnvironmentPrefill,
}));
vi.mock('../../routes/setup/account', () => ({
  handleGetAccount: vi.fn(async () => 'account-123'),
}));
vi.mock('../../routes/setup/credentials', () => ({
  handleDeriveR2Credentials: vi.fn(async () => ({ accessKeyId: 'r2-access', secretAccessKey: 'r2-secret' })),
}));
vi.mock('../../routes/setup/secrets', () => ({ handleSetSecrets: vi.fn(async () => undefined) }));
vi.mock('../../routes/setup/custom-domain', () => ({ handleConfigureCustomDomain: vi.fn(async () => undefined) }));
vi.mock('../../routes/setup/access', () => ({
  handleCreateAccessApp: vi.fn(async () => undefined),
}));
vi.mock('../../routes/setup/turnstile', () => ({ handleConfigureTurnstile: vi.fn(async () => undefined) }));
vi.mock('../../lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return {
    ...actual,
    resolveBucketName: vi.fn(async (_env: Env, email: string) => `bucket-${email}`),
  };
});

import setupRoutes from '../../routes/setup';

async function terminal(response: Response): Promise<Record<string, unknown>> {
  const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return lines.find((line) => line.done === true) ?? {};
}

describe('REQ-SETUP-013 managed coding environment Setup boundary', () => {
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    kv = createMockKV();
    vi.clearAllMocks();
  });

  function app(overrides: Partial<Env> = {}) {
    const instance = new Hono<{ Bindings: Env }>();
    instance.onError((error, c) => error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as ContentfulStatusCode)
      : c.json({ error: error.message }, 500));
    instance.use('*', async (c, next) => {
      c.env = {
        KV: kv as unknown as KVNamespace,
        CLOUDFLARE_API_TOKEN: 'cloudflare-token',
        CLOUDFLARE_WORKER_NAME: 'codeflare-test',
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        ...overrides,
      } as Env;
      return next();
    });
    instance.route('/api/setup', setupRoutes);
    return instance;
  }

  const managedEnvironment = {
    enabled: true,
    repository: 'acme/curation',
    personalAccessToken: 'github_pat_secret',
    publicKey: 'ab'.repeat(32),
  };

  it.each([
    ['default', {}],
    ['onboarding', { ONBOARDING_LANDING_PAGE: 'active', OAUTH_CLIENT_ID: 'oidc' }],
    ['saas', { SAAS_MODE: 'active', OAUTH_CLIENT_ID: 'oidc' }],
    ['enterprise', { ENTERPRISE_MODE: 'active' }],
  ] as const)('REQ-SETUP-013 AC1: every deployment mode accepts the managed-environment boundary', async (_mode, env) => {
    const body: Record<string, unknown> = {
      customDomain: 'code.example.com',
      allowedUsers: ['admin@example.com'],
      adminUsers: ['admin@example.com'],
      managedEnvironment,
    };
    if ('ENTERPRISE_MODE' in env && env.ENTERPRISE_MODE === 'active') body.dynamicRoutes = ['development'];

    const response = await app(env).request('https://codeflare-test.example.com/api/setup/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect((await terminal(response)).success).toBe(true);
    expect(mocks.configureManagedEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-123',
      workerName: 'codeflare-test',
      endpoint: 'https://account-123.r2.cloudflarestorage.com',
      r2Credentials: { R2_ACCESS_KEY_ID: 'r2-access', R2_SECRET_ACCESS_KEY: 'r2-secret' },
      request: managedEnvironment,
    }));
  });

  it('rejects enabling before streaming when AES-256-GCM encryption is unavailable', async () => {
    const response = await app({ ENCRYPTION_KEY: undefined }).request('https://codeflare-test.example.com/api/setup/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customDomain: 'code.example.com',
        allowedUsers: ['admin@example.com'],
        adminUsers: ['admin@example.com'],
        managedEnvironment,
      }),
    });

    expect(response.status).toBe(400);
    expect(mocks.configureManagedEnvironment).not.toHaveBeenCalled();
  });

  it('REQ-SETUP-014 AC2: prefill returns bounded status without PAT bytes', async () => {
    const response = await app().request('https://codeflare-test.example.com/api/setup/prefill');
    const body = await response.json() as Record<string, unknown>;

    expect(body.managedEnvironment).toEqual(expect.objectContaining({
      enabled: true,
      personalAccessTokenSet: true,
      activeSequence: 7,
      freshness: 'fresh',
    }));
    expect(JSON.stringify(body)).not.toContain('github_pat_secret');
  });

  it('REQ-SETUP-013 AC6: disabling curation does not offboard users or delete cache history', async () => {
    const response = await app().request('https://codeflare-test.example.com/api/setup/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customDomain: 'code.example.com',
        allowedUsers: ['admin@example.com'],
        adminUsers: ['admin@example.com'],
        managedEnvironment: { enabled: false },
      }),
    });

    expect((await terminal(response)).success).toBe(true);
    expect(mocks.configureManagedEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      request: { enabled: false },
    }));
    expect(kv.delete.mock.calls.some(([key]) => String(key).startsWith('user:'))).toBe(false);
    expect(kv.delete.mock.calls.some(([key]) => String(key).includes('managed_environment'))).toBe(false);
  });
});
