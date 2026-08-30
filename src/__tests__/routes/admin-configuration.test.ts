import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';

let mockRole = 'admin';
let mockAuthReject = false;

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (mockAuthReject) throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    c.set('user', { email: 'admin@example.com', authenticated: true, role: mockRole });
    c.set('bucketName', 'codeflare-admin');
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => {
    if (c.get('user')?.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
}));

import adminConfigurationRoutes from '../../routes/admin/configuration';

function createApp(envOverrides: Partial<Env> = {}) {
  const kv = createMockKV();
  const env = {
    KV: kv as unknown as KVNamespace,
    ...envOverrides,
  } as Env;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.env = env;
    return next();
  });
  app.route('/admin/configuration', adminConfigurationRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    return c.json({ error: String(err) }, 500);
  });
  return { app, kv };
}

const commonSections = ['access', 'domain', 'managedEnvironment', 'github', 'cloudflareConnection', 'usageReports'];
const enterpriseSections = [
  'access', 'domain', 'aiRouting', 'codingAgents', 'browserRendering', 'securityEgress',
  'dataGovernance', 'managedEnvironment', 'github', 'usageReports',
];

describe('GET /admin/configuration (REQ-SETUP-017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'admin';
    mockAuthReject = false;
  });

  it('rejects unauthenticated and non-admin requests', async () => {
    const { app } = createApp();
    mockAuthReject = true;
    expect((await app.request('/admin/configuration')).status).toBe(401);

    mockAuthReject = false;
    mockRole = 'user';
    expect((await app.request('/admin/configuration')).status).toBe(403);
  });

  it.each([
    [{}, 'default'],
    [{ ONBOARDING_LANDING_PAGE: 'active' }, 'onboarding'],
    [{ SAAS_MODE: 'active' }, 'saas'],
  ] as const)('returns one non-enterprise mode contract for %s', async (overrides, expectedMode) => {
    const { app, kv } = createApp(overrides as Partial<Env>);
    await kv.put(SETUP_KEYS.CUSTOM_DOMAIN, 'admin.example.com');
    await kv.put('admin:configuration:revision', '3');

    const response = await app.request('/admin/configuration');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.mode).toBe(expectedMode);
    expect(body.revision).toBe(3);
    expect(body.applicableSections).toEqual(commonSections);
    expect(body.sections.domain).toEqual({ customDomain: 'admin.example.com' });
    expect(body.sections.aiRouting).toBeUndefined();
    expect(body.sections.cloudflareConnection).toBeDefined();
  });

  it('returns enterprise credential sources without exposing secret bytes', async () => {
    const { app, kv } = createApp({
      ENTERPRISE_MODE: 'active',
      AIG_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/deploy-account/deploy-gateway',
      AIG_TOKEN: 'deployment-secret-must-not-leak',
    });
    await kv.put(SETUP_KEYS.AIG_GATEWAY_URL, 'https://gateway.ai.cloudflare.com/v1/admin-account/admin-gateway');
    await kv.put(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, 'browser-account');
    await kv.put('admin:configuration:active-run', JSON.stringify({ runId: 'run-1' }));

    const response = await app.request('/admin/configuration');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.mode).toBe('enterprise');
    expect(body.applicableSections).toEqual(enterpriseSections);
    expect(body.sections.aiRouting).toMatchObject({
      gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/admin-account/admin-gateway',
      tokenState: 'deployment',
    });
    expect(body.sections.browserRendering).toEqual({
      configured: false,
      accountId: 'browser-account',
      tokenState: 'none',
    });
    expect(body.activeRunId).toBe('run-1');
    expect(JSON.stringify(body)).not.toContain('deployment-secret-must-not-leak');
    expect(body.sections.cloudflareConnection).toBeUndefined();
  });

  it('prefers Administration secret state and reads direct latest summaries without listing Activity', async () => {
    const { app, kv } = createApp({ ENTERPRISE_MODE: 'active', AIG_TOKEN: 'deployment-token' });
    await kv.put(SETUP_KEYS.AIG_TOKEN, JSON.stringify({ encrypted: 'admin-token-ciphertext' }));
    await kv.put(SETUP_KEYS.BROWSER_RENDER_TOKEN, JSON.stringify({ encrypted: 'browser-token-ciphertext' }));
    await kv.put(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, 'browser-account');
    await kv.put('admin:configuration:latest:aiRouting', JSON.stringify({ runId: 'latest-ai', state: 'succeeded' }));

    const response = await app.request('/admin/configuration');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.sections.aiRouting.tokenState).toBe('administration');
    expect(body.sections.browserRendering).toEqual({
      configured: true,
      accountId: 'browser-account',
      tokenState: 'administration',
    });
    expect(body.latest.aiRouting).toEqual({ runId: 'latest-ai', state: 'succeeded' });
    expect(kv.list).not.toHaveBeenCalledWith(expect.objectContaining({ prefix: 'admin:configuration:run:' }));
    expect(JSON.stringify(body)).not.toContain('ciphertext');
  });
});
