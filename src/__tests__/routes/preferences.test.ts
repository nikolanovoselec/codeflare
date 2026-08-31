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

// Mock r2-seed and r2-config for preseed reconciliation tests
const { mockReconcileAgentConfigs, managedReleaseState } = vi.hoisted(() => ({
  mockReconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })),
  managedReleaseState: {
    active: null as any,
    cachedByDigest: new Map<string, { compressed: Uint8Array; release: { sequence: number } }>(),
  },
}));
vi.mock('../../lib/r2-seed', async () => {
  const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
  return { ...actual, reconcileAgentConfigs: mockReconcileAgentConfigs };
});
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://r2.test' })) }));
vi.mock('../../lib/managed-release-active', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/managed-release-active')>()),
  getActiveManagedRelease: vi.fn(async () => managedReleaseState.active ? ({
    digest: managedReleaseState.active.digest,
    pointer: { sequence: managedReleaseState.active.release.sequence },
    resourcePolicy: 'mutable',
  }) : null),
  getActiveVerifiedManagedRelease: vi.fn(async () => managedReleaseState.active),
  getCachedManagedReleaseByDigest: vi.fn(async (_env: Env, digest: string) => managedReleaseState.cachedByDigest.get(digest) ?? null),
}));

// REQ-AGENT-012: Fast CLI Start (Configurable)

describe('Preferences Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    mockReconcileAgentConfigs.mockClear();
    managedReleaseState.active = null;
    managedReleaseState.cachedByDigest.clear();
  });

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/preferences', preferencesRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  // REQ-SESSION-014 (preferences endpoint; GET/PATCH for KV-backed user prefs)
  describe('GET /preferences / REQ-SESSION-014 (user-configurable auto-sleep timeout in settings)', () => {
    it('returns empty object when no preferences are stored', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toEqual({});
    });

    it('returns stored preferences including workspaceSyncEnabled and Herdr choice', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'codex',
        workspaceSyncEnabled: true,
        herdrEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; workspaceSyncEnabled?: boolean; herdrEnabled?: boolean };
      expect(body.lastAgentType).toBe('codex');
      expect(body.workspaceSyncEnabled).toBe(true);
      expect(body.herdrEnabled).toBe(true);
    });

    it('omits internal reconciliation targets from client preferences', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        workspaceSyncEnabled: true,
        managedEnvironmentReconciliation: {
          targets: [{ digest: 'a'.repeat(64), sequence: 1, mode: 'default' }],
        },
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceSyncEnabled: true });
    });

    it('omits the removed preset preference from legacy stored records', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastPresetId: 'legacy-preset',
        workspaceSyncEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ workspaceSyncEnabled: true });
    });
  });

  // REQ-SESSION-014 (PATCH merges into KV; rejects invalid types with VALIDATION_ERROR)
  describe('PATCH /preferences', () => {
    it('updates workspaceSyncEnabled and keeps existing fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'antigravity',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; workspaceSyncEnabled?: boolean };
      expect(body.lastAgentType).toBe('antigravity');
      expect(body.workspaceSyncEnabled).toBe(true);
    });

    it('preserves internal reconciliation state without returning it to the client', async () => {
      const pending = {
        targets: [{ digest: 'a'.repeat(64), sequence: 1, mode: 'default' as const }],
      };
      mockKV._set('user-prefs:codeflare-test-user', {
        managedEnvironmentReconciliation: pending,
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: true }),
      });

      expect(await res.json()).toEqual({ workspaceSyncEnabled: true });
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toEqual({
        workspaceSyncEnabled: true,
        managedEnvironmentReconciliation: pending,
      });
    });

    it('persists the Herdr preference without changing unrelated fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', { lastAgentType: 'pi' });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ herdrEnabled: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ lastAgentType: 'pi', herdrEnabled: true });
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toEqual({
        lastAgentType: 'pi',
        herdrEnabled: true,
      });
    });

    it('persists Herdr preference independently of existing session records', async () => {
      const sessionKey = 'session:codeflare-test-user:session12345678';
      const existingSession = { id: 'session12345678', terminalMode: 'classic' };
      mockKV._set(sessionKey, existingSession);
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ herdrEnabled: true }),
      });

      expect(res.status).toBe(200);
      expect(await mockKV.get(sessionKey, 'json')).toEqual(existingSession);
    });

    it('rejects a non-boolean Herdr preference', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ herdrEnabled: 'yes' }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts workspaceSyncEnabled false', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { workspaceSyncEnabled?: boolean };
      expect(body.workspaceSyncEnabled).toBe(false);
    });

    it('returns 400 for invalid workspaceSyncEnabled type', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: 'yes' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects the removed preset preference', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastPresetId: 'legacy-preset' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('removes the legacy preset field while merging current preferences', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'pi',
        lastPresetId: 'legacy-preset',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: true }),
      });

      expect(res.status).toBe(200);
      const expected = { lastAgentType: 'pi', workspaceSyncEnabled: true };
      expect(await res.json()).toEqual(expected);
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toEqual(expected);
    });

    it('REQ-IDE-048 AC1: stores a Terminal default while preserving unrelated preferences', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'pi',
        sessionMode: 'advanced',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspace: 'terminal' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        lastAgentType: 'pi',
        sessionMode: 'advanced',
        defaultWorkspace: 'terminal',
      });
    });

    it('REQ-IDE-048 AC1: accepts VS Code only for an Advanced preference', async () => {
      mockKV._set('user-prefs:codeflare-test-user', { sessionMode: 'advanced' });
      const app = createTestApp();

      const accepted = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspace: 'vscode' }),
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ defaultWorkspace: 'vscode' });

      mockKV._set('user-prefs:codeflare-test-user', { sessionMode: 'default' });
      const rejected = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspace: 'vscode' }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('REQ-IDE-048 AC1: rejects a stale Advanced preference after entitlement loss', async () => {
      mockKV._set('user-prefs:codeflare-test-user', { sessionMode: 'advanced' });
      const app = createTestApp({ SAAS_MODE: 'active' });

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspace: 'vscode' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('REQ-IDE-048 AC1: resets VS Code default atomically when switching to Standard', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'advanced',
        defaultWorkspace: 'vscode',
        workspaceSyncEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'default' }),
      });

      expect(res.status).toBe(200);
      const expected = {
        sessionMode: 'default',
        defaultWorkspace: 'terminal',
        workspaceSyncEnabled: true,
      };
      expect(await res.json()).toMatchObject(expected);
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toMatchObject(expected);
    });

    it('REQ-IDE-048 AC1: rejects invalid workspace values', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultWorkspace: 'browser' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  // REQ-SESSION-008 AC1 (fastStartEnabled persisted across restart; 409 restart path stores it in DO storage)
  describe('fastStartEnabled preference / REQ-SESSION-008 (fast-start preference persists across restart)', () => {
    it('GET returns stored fastStartEnabled', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'codex',
        fastStartEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; fastStartEnabled?: boolean };
      expect(body.lastAgentType).toBe('codex');
      expect(body.fastStartEnabled).toBe(true);
    });

    it('PATCH updates fastStartEnabled and preserves other fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'antigravity',
        workspaceSyncEnabled: true,
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastStartEnabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; workspaceSyncEnabled?: boolean; fastStartEnabled?: boolean };
      expect(body.lastAgentType).toBe('antigravity');
      expect(body.workspaceSyncEnabled).toBe(true);
      expect(body.fastStartEnabled).toBe(true);
    });

    it('PATCH accepts fastStartEnabled: false', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastStartEnabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { fastStartEnabled?: boolean };
      expect(body.fastStartEnabled).toBe(false);
    });

    it('returns 400 for invalid fastStartEnabled type', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastStartEnabled: 'yes' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // REQ-MEM-011 AC2 (sessionMode stored as 'default'|'advanced' in UserPreferences; PATCH validates the literal set)
  describe('sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)', () => {
    it('GET returns stored sessionMode', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'codex',
        sessionMode: 'advanced',
      });
      const app = createTestApp();

      const res = await app.request('/preferences');

      expect(res.status).toBe(200);
      const body = await res.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });

    it('PATCH updates sessionMode to "default" and preserves other fields', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'antigravity',
        sessionMode: 'advanced',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'default' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string; sessionMode?: string };
      expect(body.lastAgentType).toBe('antigravity');
      expect(body.sessionMode).toBe('default');
    });

    it('PATCH updates sessionMode to "advanced"', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });

    // REQ-SEC-015 AC2 (preferences-save side): in SaaS mode a non-Pro,
    // non-admin user PATCHing sessionMode='advanced' is rejected at validation
    // time so the stale preference can never be written to KV. The container
    // start path uses clampSessionModeToTier as a second defense; this test
    // covers the first one.
    it('REQ-SEC-015 AC2 (preferences save): SaaS-mode non-Pro user gets 400 trying to PATCH sessionMode=advanced', async () => {
      const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          SAAS_MODE: 'active',
        } as Env;
        return next();
      });
      app.route('/preferences', preferencesRoutes);
      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string; message?: string };
      expect(body.code).toBe('VALIDATION_ERROR');

      // AC2 guarantee: KV must NOT contain the rejected sessionMode.
      const stored = await mockKV.get('user-prefs:codeflare-test-user', 'json') as { sessionMode?: string } | null;
      expect(stored?.sessionMode).toBeUndefined();
    });

    it('returns 400 for invalid sessionMode "expert"', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'expert' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid sessionMode 123', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 123 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for sessionMode null', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: null }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // REQ-SESSION-014 (strict schema validation: malformed JSON or unknown keys return VALIDATION_ERROR)
  describe('malformed JSON and unknown fields', () => {
    it('PATCH with malformed JSON body returns 400', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('PATCH with empty {} is a 200 no-op merge', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        lastAgentType: 'antigravity',
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { lastAgentType?: string };
      expect(body.lastAgentType).toBe('antigravity');
    });

    it('PATCH with unknown fields returns 400 (strict schema)', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unknownField: true }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Preseed reconciliation on sessionMode change
  // ---------------------------------------------------------------------------
  // REQ-MEM-011 AC3-AC4 (mode change triggers reconcileAgentConfigs to seed/delete mode-appropriate preseed files)
  describe('preseed reconciliation on sessionMode change / REQ-AGENT-016 (advanced-mode preseed reconciliation)', () => {
    it('calls reconcileAgentConfigs when sessionMode changes from default to advanced', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'default' }));

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
        expect.anything(),
        'codeflare-test-user',
        'https://r2.test',
        'advanced',
        { overwrite: true, cleanup: true, contextModeEnabled: false, r2SseDisabled: false },
      );
    });

    it('calls reconcileAgentConfigs when sessionMode changes from advanced to default', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'advanced' }));

      // Mock auth to simulate a user who paid for Pro (so the guard at line 64 passes)
      const { authMiddleware } = await import('../../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('user', { email: 'test@example.com', authenticated: true, role: 'user', subscribedMode: 'advanced' });
        c.set('bucketName', 'codeflare-test-user');
        return next();
      });

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'default' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
        expect.anything(),
        'codeflare-test-user',
        'https://r2.test',
        'default',
        { overwrite: true, cleanup: true, contextModeEnabled: false, r2SseDisabled: false },
      );
    });

    it('does NOT call reconcileAgentConfigs when sessionMode stays the same', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'advanced' }));

      const { authMiddleware } = await import('../../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('user', { email: 'test@example.com', authenticated: true, role: 'user', subscribedMode: 'advanced' });
        c.set('bucketName', 'codeflare-test-user');
        return next();
      });

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).not.toHaveBeenCalled();
    });

    it('does NOT call reconcileAgentConfigs when PATCH has no sessionMode field', async () => {
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceSyncEnabled: true }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).not.toHaveBeenCalled();
    });

    it('reconcileAgentConfigs failure does not break the preferences response', async () => {
      const app = createTestApp();
      const prefsKey = 'user-prefs:codeflare-test-user';
      await mockKV.put(prefsKey, JSON.stringify({ sessionMode: 'default' }));
      mockReconcileAgentConfigs.mockRejectedValueOnce(new Error('R2 timeout'));

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { sessionMode?: string };
      expect(body.sessionMode).toBe('advanced');
    });
  });

  // REQ-SESSION-016 AC1 (PATCH /api/preferences accepts userTimezone, validates IANA, max 64 chars; invalid returns ValidationError)
  describe('userTimezone (REQ-SESSION-016 AC1)', () => {
    it('accepts a valid IANA timezone and persists it', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: 'Europe/Zurich' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { userTimezone?: string };
      expect(body.userTimezone).toBe('Europe/Zurich');
    });

    it('accepts UTC as a special-case valid timezone', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: 'UTC' }),
      });
      expect(res.status).toBe(200);
    });

    it('rejects a syntactically valid but non-existent IANA tz', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: 'Mars/Olympus' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an empty string timezone', async () => {
      const app = createTestApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTimezone: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // REQ-STOR-022: the no-hot-mutation gate applies only while curation is active or a
  // prior curated state must converge; unconfigured baked behavior stays byte-identical.
  describe('PATCH /preferences managed-environment gating / REQ-STOR-022', () => {
    it('REQ-STOR-022: a running session does not block a sessionMode change on an unconfigured deployment', async () => {
      mockKV._set('session:codeflare-test-user:abc', { status: 'running' }, { s: 'r' });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      const stored = await mockKV.get('user-prefs:codeflare-test-user', 'json') as { sessionMode?: string };
      expect(stored.sessionMode).toBe('advanced');
    });

    it('REQ-STOR-022: a running session still blocks a sessionMode change once a managed release is applied', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'default',
        managedEnvironmentApplied: { digest: 'a'.repeat(64), managedExtensionsDigest: 'c'.repeat(64), sequence: 1, mode: 'default', appliedAt: '2026-08-19T00:00:00.000Z' },
      });
      mockKV._set('session:codeflare-test-user:abc', { status: 'running' }, { s: 'r' });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(409);
    });

    it('REQ-STOR-035 AC3: mode-change disable repairs interrupted targets before clearing state', async () => {
      managedReleaseState.cachedByDigest.set('a'.repeat(64), {
        compressed: new Uint8Array(),
        release: { sequence: 1 },
      });
      managedReleaseState.cachedByDigest.set('b'.repeat(64), {
        compressed: new Uint8Array(),
        release: { sequence: 2 },
      });
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'default',
        managedEnvironmentApplied: {
          digest: 'a'.repeat(64), managedExtensionsDigest: 'c'.repeat(64), sequence: 1,
          mode: 'default', appliedAt: '2026-08-19T00:00:00.000Z',
        },
        managedEnvironmentReconciliation: {
          targets: [{ digest: 'b'.repeat(64), sequence: 2, mode: 'default' }],
        },
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(200);
      expect(mockReconcileAgentConfigs).toHaveBeenCalledWith(
        expect.anything(), 'codeflare-test-user', 'https://r2.test', 'advanced',
        expect.objectContaining({
          managedRelease: null,
          interruptedManagedReleases: [expect.objectContaining({ digest: 'b'.repeat(64), mode: 'default' })],
        }),
      );
      const stored = await mockKV.get('user-prefs:codeflare-test-user', 'json') as any;
      expect(stored.managedEnvironmentApplied).toBeUndefined();
      expect(stored.managedEnvironmentReconciliation).toBeUndefined();
    });

    it('REQ-STOR-035 AC2: unavailable interrupted history rejects a mode change and preserves pending state', async () => {
      const pending = {
        targets: [{ digest: 'b'.repeat(64), sequence: 2, mode: 'default' as const }],
      };
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'default',
        managedEnvironmentReconciliation: pending,
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(500);
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toEqual({
        sessionMode: 'default',
        managedEnvironmentReconciliation: pending,
      });
    });

    it('REQ-STOR-035 AC1/AC2: a failed managed mode change records and retains its active target', async () => {
      managedReleaseState.active = {
        digest: 'd'.repeat(64),
        compressed: new Uint8Array(),
        release: { sequence: 9 },
      };
      managedReleaseState.cachedByDigest.set('a'.repeat(64), {
        compressed: new Uint8Array(),
        release: { sequence: 8 },
      });
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'default',
        managedEnvironmentApplied: {
          digest: 'a'.repeat(64), managedExtensionsDigest: 'c'.repeat(64), sequence: 8,
          mode: 'default', appliedAt: '2026-08-19T00:00:00.000Z',
        },
      });
      mockReconcileAgentConfigs.mockRejectedValueOnce(new Error('partial write'));
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(500);
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toMatchObject({
        sessionMode: 'default',
        managedEnvironmentApplied: { digest: 'a'.repeat(64) },
        managedEnvironmentReconciliation: {
          targets: [{ digest: 'd'.repeat(64), sequence: 9, mode: 'advanced' }],
        },
      });
    });

    it('target journaling preserves concurrent preference changes', async () => {
      managedReleaseState.active = {
        digest: 'd'.repeat(64),
        compressed: new Uint8Array(),
        release: { sequence: 9 },
      };
      managedReleaseState.cachedByDigest.set('a'.repeat(64), {
        compressed: new Uint8Array(),
        release: { sequence: 8 },
      });
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'default',
        managedEnvironmentApplied: {
          digest: 'a'.repeat(64), managedExtensionsDigest: 'c'.repeat(64), sequence: 8,
          mode: 'default', appliedAt: '2026-08-19T00:00:00.000Z',
        },
      });
      let releaseLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => { releaseLookupStarted = resolve; });
      let releaseLookupContinue!: () => void;
      const lookupContinue = new Promise<void>((resolve) => { releaseLookupContinue = resolve; });
      const { getActiveVerifiedManagedRelease } = await import('../../lib/managed-release-active');
      vi.mocked(getActiveVerifiedManagedRelease).mockImplementationOnce(async () => {
        releaseLookupStarted();
        await lookupContinue;
        return managedReleaseState.active;
      });
      const app = createTestApp();

      const response = app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });
      await lookupStarted;
      const concurrent = await mockKV.get('user-prefs:codeflare-test-user', 'json') as Record<string, unknown>;
      await mockKV.put('user-prefs:codeflare-test-user', JSON.stringify({ ...concurrent, herdrEnabled: true }));
      releaseLookupContinue();

      expect((await response).status).toBe(200);
      expect(await mockKV.get('user-prefs:codeflare-test-user', 'json')).toMatchObject({
        sessionMode: 'advanced',
        herdrEnabled: true,
        managedEnvironmentApplied: { digest: 'd'.repeat(64) },
      });
    });

    it('REQ-STOR-024: a failed managed reconciliation is reported instead of returning success', async () => {
      mockKV._set('user-prefs:codeflare-test-user', {
        sessionMode: 'default',
        managedEnvironmentApplied: { digest: 'b'.repeat(64), managedExtensionsDigest: 'c'.repeat(64), sequence: 2, mode: 'default', appliedAt: '2026-08-19T00:00:00.000Z' },
      });
      const app = createTestApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionMode: 'advanced' }),
      });

      expect(res.status).toBe(500);
      const stored = await mockKV.get('user-prefs:codeflare-test-user', 'json') as { sessionMode?: string; managedEnvironmentApplied?: unknown };
      // The pre-request document is restored, so a retry re-enters reconciliation instead
      // of short-circuiting on its own half-applied mode.
      expect(stored.sessionMode).toBe('default');
      expect(stored.managedEnvironmentApplied).toEqual({ digest: 'b'.repeat(64), managedExtensionsDigest: 'c'.repeat(64), sequence: 2, mode: 'default', appliedAt: '2026-08-19T00:00:00.000Z' });
    });
  });
});

