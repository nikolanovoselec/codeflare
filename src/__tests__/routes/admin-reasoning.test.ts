import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

let role = 'admin';
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'admin@example.com', authenticated: true, role });
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => role === 'admin' ? next() : c.json({ error: 'Forbidden' }, 403)),
}));

async function createApp(envOverrides: Partial<Env> = {}) {
  const modulePath = '../../routes/admin/reasoning';
  const { default: routes } = await import(modulePath);
  const kv = createMockKV();
  const env = { KV: kv as unknown as KVNamespace, ENTERPRISE_MODE: 'active', ...envOverrides } as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => { c.env = env; return next(); });
  app.route('/admin/reasoning', routes);
  return { app, kv };
}

describe('REQ-ENTERPRISE-031 Administration reasoning API', () => {
  beforeEach(() => { role = 'admin'; vi.restoreAllMocks(); });

  it('exposes only the three approved admin endpoints', async () => {
    const { app } = await createApp();
    expect((await app.request('/admin/reasoning/catalog')).status).toBe(200);
    expect((await app.request('/admin/reasoning/routes/codeflare-mesh/inventory')).status).not.toBe(404);
    expect((await app.request('/admin/reasoning/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).not.toBe(404);
    expect((await app.request('/admin/reasoning/profiles', { method: 'POST' })).status).toBe(404);
  });

  it('rejects non-admin callers for catalog, inventory, and discovery', async () => {
    const { app } = await createApp();
    role = 'user';
    expect((await app.request('/admin/reasoning/catalog')).status).toBe(403);
    expect((await app.request('/admin/reasoning/routes/codeflare-mesh/inventory')).status).toBe(403);
    expect((await app.request('/admin/reasoning/discover', { method: 'POST' })).status).toBe(403);
  });

  it('catalog returns six executable profiles and non-assignable notices without secrets', async () => {
    const { app } = await createApp({ AIG_TOKEN: 'must-not-leak' });
    const response = await app.request('/admin/reasoning/catalog');
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.profiles).toHaveLength(6);
    expect(body.notices.every((notice: any) => notice.assignable === false)).toBe(true);
    expect(text).not.toContain('must-not-leak');
  });

  it('inventory returns all reachable leg summaries and accepts administrator-owned custom-provider provenance', async () => {
    const { app } = await createApp();
    const response = await app.request('/admin/reasoning/routes/codeflare-mesh/inventory');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.legs).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'custom-codeflare-inference-mesh', declaredModel: 'codeflare-mesh' }),
      expect.objectContaining({ provider: 'workers-ai' }),
    ]));
    expect(body).not.toHaveProperty('graph');
  });

  it('discovery accepts one target, persists nothing, and returns no generated content or arbitrary error body', async () => {
    const { app, kv } = await createApp();
    vi.mocked(kv.put).mockClear();
    const response = await app.request('/admin/reasoning/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'codeflare-mesh', profileRef: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1 }, maxCompletionTokens: 32 }),
    });
    expect(response.status).not.toBe(404);
    const text = await response.text();
    expect(text).not.toMatch(/assistant content|prompt|credential|authorization/i);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
