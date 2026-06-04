/**
 * REQ-ENTERPRISE-001 / REQ-ENTERPRISE-003: PATCH /api/preferences under ENTERPRISE_MODE.
 *
 * Enterprise deploys grant every user advanced mode (so the SaaS advanced-mode
 * availability gate is bypassed) and restrict the agent set to the enterprise
 * allowlist (so lastAgentType outside the allowlist is rejected). When the flag
 * is unset, both behaviors are byte-identical to today.
 *
 * AC1. Enterprise: a non-Pro user may PATCH sessionMode='advanced' (no 400).
 * AC2. Enterprise: lastAgentType outside the allowlist (e.g. 'codex') is rejected 400.
 * AC3. Enterprise: an allowlisted lastAgentType (e.g. 'pi') is accepted.
 * AC4. flag-off regression: non-Pro SaaS user is still 400 for sessionMode='advanced';
 *      any of the 7 agents is still accepted for lastAgentType.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import preferencesRoutes from '../../routes/preferences';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'user' });
    c.set('bucketName', 'codeflare-test-user');
    return next();
  }),
}));

const { mockReconcileAgentConfigs } = vi.hoisted(() => ({
  mockReconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })),
}));
vi.mock('../../lib/r2-seed', () => ({ reconcileAgentConfigs: mockReconcileAgentConfigs }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://r2.test' })) }));

describe('Preferences Routes under ENTERPRISE_MODE / REQ-ENTERPRISE-001 + REQ-ENTERPRISE-003', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    mockReconcileAgentConfigs.mockClear();
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.env = { KV: mockKV as unknown as KVNamespace, ...envOverrides } as Env;
      return next();
    });
    app.route('/preferences', preferencesRoutes);
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      return c.json({ error: 'Unexpected error' }, 500);
    });
    return app;
  }

  // ── AC1: enterprise bypasses the SaaS advanced-mode availability gate ──
  it('AC1: non-Pro user may PATCH sessionMode=advanced when ENTERPRISE_MODE=active (SAAS_MODE also active)', async () => {
    const app = createApp({ SAAS_MODE: 'active', ENTERPRISE_MODE: 'active' });
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'advanced' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionMode?: string };
    expect(body.sessionMode).toBe('advanced');
  });

  // ── AC2: enterprise rejects lastAgentType outside the allowlist ──
  it("AC2: lastAgentType='codex' (not allowlisted) is rejected 400 when ENTERPRISE_MODE=active", async () => {
    const app = createApp({ ENTERPRISE_MODE: 'active' });
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastAgentType: 'codex' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    // The rejected agent must not be persisted.
    const stored = await mockKV.get('user-prefs:codeflare-test-user', 'json') as { lastAgentType?: string } | null;
    expect(stored?.lastAgentType).toBeUndefined();
  });

  it("AC2: lastAgentType='opencode' (not allowlisted) is rejected 400 when ENTERPRISE_MODE=active", async () => {
    const app = createApp({ ENTERPRISE_MODE: 'active' });
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastAgentType: 'opencode' }),
    });
    expect(res.status).toBe(400);
  });

  // ── AC3: enterprise accepts an allowlisted agent ──
  it("AC3: lastAgentType='pi' (allowlisted) is accepted when ENTERPRISE_MODE=active", async () => {
    const app = createApp({ ENTERPRISE_MODE: 'active' });
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastAgentType: 'pi' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lastAgentType?: string };
    expect(body.lastAgentType).toBe('pi');
  });

  // ── AC4: flag-off regression ──
  it('flag-off: non-Pro SaaS user is still 400 for sessionMode=advanced when ENTERPRISE_MODE unset', async () => {
    const app = createApp({ SAAS_MODE: 'active' });
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'advanced' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it("flag-off: lastAgentType='codex' is accepted when ENTERPRISE_MODE unset (all 7 agents allowed)", async () => {
    const app = createApp();
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastAgentType: 'codex' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lastAgentType?: string };
    expect(body.lastAgentType).toBe('codex');
  });

  it("flag-off: lastAgentType='opencode' is accepted when ENTERPRISE_MODE unset", async () => {
    const app = createApp();
    const res = await app.request('/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastAgentType: 'opencode' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lastAgentType?: string };
    expect(body.lastAgentType).toBe('opencode');
  });
});
