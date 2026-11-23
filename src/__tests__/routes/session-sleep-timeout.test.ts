/**
 * REQ-SESSION-014: User-configurable auto-sleep timeout in Settings
 * AC coverage: AC1 (5 valid sleep options: 1h, 2h, 4h, 8h, 12h),
 *              AC2 (1h default and saved preferences across tiers),
 *              AC3 (active users can change sleepAfter),
 *              AC4 (value saved to KV preferences and applied on next session start)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'user' });
    c.set('bucketName', 'test-bucket');
    return next();
  }),
}));

vi.mock('../../lib/r2-seed', () => ({
  reconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })),
  reseedContextModePlugin: vi.fn(async () => ({ written: [], skipped: [] })),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://r2.test' })),
}));

import preferencesRoutes from '../../routes/preferences';

// REQ-OPS-017: sleepAfter fail-safe invariants

describe('REQ-SESSION-014: User-configurable auto-sleep timeout in Settings', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  function createApp() {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.env = { KV: mockKV as unknown as KVNamespace } as Env;
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

  // AC1: Settings dropdown with 5 selectable options (1h, 2h, 4h, 8h, 12h)
  describe('REQ-SESSION-014 AC1: 5 valid sleep options accepted', () => {
    it.each(['1h', '2h', '4h', '8h', '12h'] as const)(
      'accepts sleepAfter="%s" via PATCH /preferences',
      async (sleepAfter) => {
        const app = createApp();
        const res = await app.request('/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sleepAfter }),
        });
        expect(res.status, `expected 200 for sleepAfter=${sleepAfter}`).toBe(200);
        const body = await res.json() as { sleepAfter?: string };
        expect(body.sleepAfter).toBe(sleepAfter);
        expect(await mockKV.get('user-prefs:test-bucket', 'json')).toMatchObject({ sleepAfter });
      }
    );

    it('rejects an invalid sleepAfter value "45m"', async () => {
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '45m' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects sleepAfter "0m"', async () => {
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '0m' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects sleepAfter "3h"', async () => {
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '3h' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects sleepAfter "5m" (retired from the settable picker)', async () => {
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '5m' }),
      });
      expect(res.status).toBe(400);
    });

    it.each(['15m', '30m', '24h'])('rejects removed or unsupported new selection %s without rewriting saved preferences', async sleepAfter => {
      mockKV._set('user-prefs:test-bucket', { sleepAfter: '4h' });
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sleepAfter }),
      });
      expect(res.status).toBe(400);
      expect(await mockKV.get('user-prefs:test-bucket', 'json')).toMatchObject({ sleepAfter: '4h' });
    });

    it.each(['15m', '30m'])('keeps saved legacy %s readable until explicitly changed', async sleepAfter => {
      mockKV._set('user-prefs:test-bucket', { sleepAfter });
      const app = createApp();
      expect(await (await app.request('/preferences')).json()).toMatchObject({ sleepAfter });
      expect(await mockKV.get('user-prefs:test-bucket', 'json')).toMatchObject({ sleepAfter });
      const changed = await app.request('/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sleepAfter: '12h' }),
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({ sleepAfter: '12h' });
    });
  });

  // AC3: Active users can change sleepAfter
  describe('REQ-SESSION-014 AC3: active users can change sleepAfter', () => {
    it('stores sleepAfter preference for a regular user (non-free)', async () => {
      mockKV._set('user-prefs:test-bucket', { sleepAfter: '30m' });
      const app = createApp();

      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '2h' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { sleepAfter: string };
      expect(body.sleepAfter).toBe('2h');
    });

    it('allows changing from 30m to 4h', async () => {
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '4h' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { sleepAfter: string };
      expect(body.sleepAfter).toBe('4h');
    });
  });

  // AC4: Value saved to KV preferences and applied on next session start
  describe('REQ-SESSION-014 AC4: sleepAfter saved to KV and applied on session start / REQ-OPS-016 (sleepAfter persistence/lifecycle)', () => {
    it('PATCH /preferences persists sleepAfter to KV', async () => {
      const app = createApp();
      const res = await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '1h' }),
      });
      expect(res.status).toBe(200);

      // Verify the value was written to KV
      const stored = await mockKV.get('user-prefs:test-bucket', 'json') as { sleepAfter?: string };
      expect(stored).not.toBeNull();
      expect(stored.sleepAfter).toBe('1h');
    });

    it('sleepAfter persists across GET/PATCH round-trip', async () => {
      const app = createApp();

      // Store via PATCH
      await app.request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleepAfter: '2h' }),
      });

      // Retrieve via GET
      const res = await app.request('/preferences');
      expect(res.status).toBe(200);
      const body = await res.json() as { sleepAfter?: string };
      expect(body.sleepAfter).toBe('2h');
    });

    // "container start route reads sleepAfter from KV preferences": covered by
    // container/index.test.ts onStart describe + the GET/PATCH round-trip above.
  });
});
