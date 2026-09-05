import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { ADMIN_CONFIGURATION_KEYS, SETUP_KEYS } from '../../lib/kv-keys';

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

import configurationPreviewRoutes from '../../routes/admin/configuration-previews';

function createApp(envOverrides: Partial<Env> = {}) {
  const kv = createMockKV();
  const env = { KV: kv as unknown as KVNamespace, ...envOverrides } as Env;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.env = env;
    return next();
  });
  app.route('/admin/configuration-previews', configurationPreviewRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    return c.json({ error: String(err) }, 500);
  });
  return { app, kv };
}

function post(app: ReturnType<typeof createApp>['app'], body: unknown): Promise<Response> {
  return Promise.resolve(app.request('/admin/configuration-previews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const enterpriseAiValues = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  replacementToken: '',
  dynamicRoutes: ['claude'],
  defaultRoute: { route: 'claude', reasoning: 'medium' },
  routeContextWindows: { claude: 200000 },
  routeReasoningProfiles: { claude: 'workers-ai-gpt-oss' },
  groupRouting: [],
};

describe('POST /admin/configuration-previews (REQ-SETUP-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'admin';
    mockAuthReject = false;
  });

  it('rejects unauthenticated and non-admin requests', async () => {
    const { app } = createApp();
    mockAuthReject = true;
    expect((await post(app, { section: 'domain', baseRevision: 0, values: { customDomain: 'admin.example.com' } })).status).toBe(401);

    mockAuthReject = false;
    mockRole = 'user';
    expect((await post(app, { section: 'domain', baseRevision: 0, values: { customDomain: 'admin.example.com' } })).status).toBe(403);
  });

  it('returns typed conflicts before validation work and persists nothing', async () => {
    const { app, kv } = createApp();
    await kv.put(ADMIN_CONFIGURATION_KEYS.REVISION, '8');
    vi.mocked(kv.put).mockClear();

    const response = await post(app, {
      section: 'domain',
      baseRevision: 7,
      values: { customDomain: 'admin.example.com' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'configuration_revision_conflict',
      currentRevision: 8,
    });
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('rejects unknown, inapplicable, and incomplete section aggregates before writes', async () => {
    const { app, kv } = createApp();

    expect((await post(app, { section: 'unknown', baseRevision: 0, values: {} })).status).toBe(400);
    expect((await post(app, { section: 'aiRouting', baseRevision: 0, values: enterpriseAiValues })).status).toBe(400);
    expect((await post(app, { section: 'access', baseRevision: 0, values: { adminUsers: ['not-an-email'] } })).status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('normalizes an Access aggregate and expands only Access work', async () => {
    const { app, kv } = createApp();

    const response = await post(app, {
      section: 'access',
      baseRevision: 0,
      values: {
        adminUsers: [' Admin@Example.com ', 'admin@example.com'],
        allowedUsers: ['USER@example.com', 'admin@example.com'],
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      section: 'access',
      baseRevision: 0,
      currentRevision: 0,
      tasks: [
        { id: 'store_access_users', dependsOn: [] },
        { id: 'create_access_app', dependsOn: ['store_access_users'] },
      ],
    });
    expect(body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'adminUsers', after: ['admin@example.com'] }),
      expect.objectContaining({ field: 'allowedUsers', after: ['admin@example.com', 'user@example.com'] }),
    ]));
    expect(body.exclusions).toEqual(expect.arrayContaining(['derive_r2_credentials', 'set_secrets', 'finalize']));
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('expands Enterprise Access work and rejects removal of a routing owner', async () => {
    const { app, kv } = createApp({ ENTERPRISE_MODE: 'active' });
    await kv.put(SETUP_KEYS.GROUP_ROUTING, JSON.stringify({
      engineering: { routes: ['claude'], defaultRoute: 'claude', reasoning: 'medium' },
    }));
    vi.mocked(kv.put).mockClear();

    const invalid = await post(app, {
      section: 'access',
      baseRevision: 0,
      values: {
        adminUsers: ['admin@example.com'],
        userAccessGroups: [],
        adminAccessGroups: ['administrators'],
      },
    });
    expect(invalid.status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();

    const accepted = await post(app, {
      section: 'access',
      baseRevision: 0,
      values: {
        adminUsers: ['admin@example.com'],
        userAccessGroups: ['engineering'],
        adminAccessGroups: ['administrators'],
      },
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as any).tasks).toEqual([
      { id: 'store_access_users', dependsOn: [] },
      { id: 'configure_access_groups', dependsOn: ['store_access_users'] },
      { id: 'create_access_app', dependsOn: ['configure_access_groups'] },
    ]);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-031 AC4: requires one supported reasoning profile for every route', async () => {
    const { app, kv } = createApp({ ENTERPRISE_MODE: 'active', AIG_TOKEN: 'deployment-token' });

    const missing = await post(app, {
      section: 'aiRouting',
      baseRevision: 0,
      values: { ...enterpriseAiValues, routeReasoningProfiles: {} },
    });
    expect(missing.status).toBe(400);

    const unknown = await post(app, {
      section: 'aiRouting',
      baseRevision: 0,
      values: { ...enterpriseAiValues, routeReasoningProfiles: { claude: 'arbitrary-transform' } },
    });
    expect(unknown.status).toBe(400);

    const missingContext = await post(app, {
      section: 'aiRouting',
      baseRevision: 0,
      values: { ...enterpriseAiValues, routeContextWindows: {} },
    });
    expect(missingContext.status).toBe(400);

    for (const contextWindow of [0, -1]) {
      const nonPositive = await post(app, {
        section: 'aiRouting',
        baseRevision: 0,
        values: { ...enterpriseAiValues, routeContextWindows: { claude: contextWindow } },
      });
      expect(nonPositive.status).toBe(400);
    }
    expect(kv.put).not.toHaveBeenCalledWith(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, expect.anything());
  });

  it('resolves AI Gateway URL and token independently across Administration and deployment sources', async () => {
    const administrationUrl = createApp({ ENTERPRISE_MODE: 'active', AIG_TOKEN: 'deployment-token' });
    await administrationUrl.kv.put(SETUP_KEYS.AIG_GATEWAY_URL, enterpriseAiValues.gatewayUrl);
    vi.mocked(administrationUrl.kv.put).mockClear();
    expect((await post(administrationUrl.app, {
      section: 'aiRouting', baseRevision: 0, values: enterpriseAiValues,
    })).status).toBe(200);

    const administrationToken = createApp({
      ENTERPRISE_MODE: 'active',
      AIG_GATEWAY_URL: enterpriseAiValues.gatewayUrl,
    });
    await administrationToken.kv.put(SETUP_KEYS.AIG_TOKEN, JSON.stringify({ encrypted: 'administration-token' }));
    vi.mocked(administrationToken.kv.put).mockClear();
    expect((await post(administrationToken.app, {
      section: 'aiRouting', baseRevision: 0, values: enterpriseAiValues,
    })).status).toBe(200);
    expect(administrationToken.kv.put).not.toHaveBeenCalled();
  });

  it('preserves an effective AI token, redacts secret values, and requires effective credentials', async () => {
    const { app, kv } = createApp({ ENTERPRISE_MODE: 'active', AIG_TOKEN: 'deployment-token-must-not-leak' });

    const accepted = await post(app, { section: 'aiRouting', baseRevision: 0, values: enterpriseAiValues });
    expect(accepted.status).toBe(200);
    const acceptedText = await accepted.text();
    expect(acceptedText).not.toContain('deployment-token-must-not-leak');
    expect(JSON.parse(acceptedText).changes).toEqual(expect.arrayContaining([
      { field: 'replacementToken', secret: { willReplace: false } },
    ]));
    expect(kv.put).not.toHaveBeenCalled();

    const missing = createApp({ ENTERPRISE_MODE: 'active' });
    const rejected = await post(missing.app, { section: 'aiRouting', baseRevision: 0, values: enterpriseAiValues });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await rejected.json())).not.toContain('replacementToken');
    expect(missing.kv.put).not.toHaveBeenCalled();
  });

  it('rejects unsafe strict-egress transitions before writes', async () => {
    const { app, kv } = createApp({ ENTERPRISE_MODE: 'active' });
    const response = await post(app, {
      section: 'securityEgress', baseRevision: 0, values: { strictGatewayEgress: true },
    });
    expect(response.status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('keeps Browser Run optional but rejects incomplete effective pairs', async () => {
    const empty = createApp({ ENTERPRISE_MODE: 'active' });
    expect((await post(empty.app, {
      section: 'browserRendering', baseRevision: 0, values: { accountId: '', replacementToken: '' },
    })).status).toBe(200);

    const incomplete = createApp({ ENTERPRISE_MODE: 'active' });
    expect((await post(incomplete.app, {
      section: 'browserRendering', baseRevision: 0, values: { accountId: 'account-1', replacementToken: '' },
    })).status).toBe(400);

    const saved = createApp({ ENTERPRISE_MODE: 'active' });
    await saved.kv.put(SETUP_KEYS.BROWSER_RENDER_TOKEN, JSON.stringify({ encrypted: 'saved-secret' }));
    vi.mocked(saved.kv.put).mockClear();
    const accepted = await post(saved.app, {
      section: 'browserRendering', baseRevision: 0, values: { accountId: 'account-1', replacementToken: '' },
    });
    expect(accepted.status).toBe(200);
    const text = await accepted.text();
    expect(text).not.toContain('saved-secret');
    expect(JSON.parse(text).changes).toEqual(expect.arrayContaining([
      { field: 'replacementToken', secret: { willReplace: false } },
    ]));
    expect(saved.kv.put).not.toHaveBeenCalled();
  });
});
