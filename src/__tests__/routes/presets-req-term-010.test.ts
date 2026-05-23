import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import presetsRoutes from '../../routes/presets';

/**
 * REQ-TERM-010: Session presets (saved tab configurations).
 *
 * Per-AC coverage at the Worker route layer.
 * AC1 - preset shape: name + tabs saved and returned
 * AC2 - max 3 presets per user enforced
 * AC3 - /api/presets CRUD (GET, POST, DELETE, PATCH)
 * AC4 - applying a preset populates tabConfig (store-layer; covered in web-ui tests)
 * AC5 - delete preset removes it
 *
 * Note: AC4 is a frontend store concern tested in
 * web-ui/src/__tests__/stores/session-presets-ac-coverage.test.ts.
 */

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'user' });
    c.set('bucketName', 'codeflare-test-user');
    return next();
  }),
}));

describe('REQ-TERM-010: Session presets CRUD at /api/presets', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  function createTestApp() {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = { KV: mockKV as unknown as KVNamespace } as Env;
      return next();
    });

    app.route('/api/presets', presetsRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  // --------------------------------------------------------------------------
  // AC1: Users can save current tab configuration as a preset (name + tabs)
  // --------------------------------------------------------------------------

  describe('AC1: preset saved with name and tabs fields', () => {
    it('REQ-TERM-010 AC1: POST /api/presets creates preset with name and tabs and returns 201', async () => {
      const app = createTestApp();

      const res = await app.request('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Dev Tools',
          tabs: [
            { id: '1', command: 'claude --dangerously-skip-permissions', label: 'Claude' },
            { id: '2', command: 'htop', label: 'Monitor' },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { preset: { id: string; name: string; tabs: unknown[]; createdAt: string } };
      expect(body.preset.name).toBe('Dev Tools');
      expect(body.preset.tabs).toHaveLength(2);
      expect(body.preset.id).toBeTruthy();
      expect(body.preset.createdAt).toBeTruthy();
    });

    it('REQ-TERM-010 AC1: GET /api/presets returns stored preset with name and tabs', async () => {
      const existing = [
        {
          id: 'p1',
          name: 'Saved Config',
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/api/presets');

      expect(res.status).toBe(200);
      const body = await res.json() as { presets: typeof existing };
      expect(body.presets[0].name).toBe('Saved Config');
      expect(body.presets[0].tabs).toHaveLength(1);
      expect(body.presets[0].tabs[0].command).toBe('bash');
    });
  });

  // --------------------------------------------------------------------------
  // AC2: Max 3 presets per user
  // --------------------------------------------------------------------------

  describe('AC2: maximum 3 presets per user enforced', () => {
    it('REQ-TERM-010 AC2: creating a 4th preset returns 400 with "maximum" error', async () => {
      const existing = [
        { id: 'p1', name: 'A', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
        { id: 'p2', name: 'B', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-02' },
        { id: 'p3', name: 'C', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-03' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fourth', tabs: [{ id: '1', command: 'bash', label: 'S' }] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error.toLowerCase()).toMatch(/maximum/);
    });

    it('REQ-TERM-010 AC2: exactly 3 presets are allowed (the 3rd create succeeds)', async () => {
      const existing = [
        { id: 'p1', name: 'A', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
        { id: 'p2', name: 'B', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-02' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Third OK', tabs: [{ id: '1', command: 'bash', label: 'S' }] }),
      });

      expect(res.status).toBe(201);
    });
  });

  // --------------------------------------------------------------------------
  // AC3: Presets stored via /api/presets CRUD
  // --------------------------------------------------------------------------

  describe('AC3: /api/presets CRUD endpoints exist and persist to KV', () => {
    it('REQ-TERM-010 AC3: GET /api/presets returns 200 with presets array', async () => {
      const app = createTestApp();
      const res = await app.request('/api/presets');
      expect(res.status).toBe(200);
      const body = await res.json() as { presets: unknown[] };
      expect(Array.isArray(body.presets)).toBe(true);
    });

    it('REQ-TERM-010 AC3: POST /api/presets persists preset to KV storage', async () => {
      const app = createTestApp();
      await app.request('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Persist Test', tabs: [{ id: '1', command: 'bash', label: 'S' }] }),
      });

      expect(mockKV.put).toHaveBeenCalledWith(
        'presets:codeflare-test-user',
        expect.stringContaining('"Persist Test"'),
      );
    });

    it('REQ-TERM-010 AC3: PATCH /api/presets/:id renames a preset', async () => {
      const existing = [
        { id: 'p1', name: 'Old Name', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/api/presets/p1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'New Name' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { preset: { name: string } };
      expect(body.preset.name).toBe('New Name');
    });

    it('REQ-TERM-010 AC3: DELETE /api/presets/:id removes the preset', async () => {
      const existing = [
        { id: 'p1', name: 'Remove Me', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/api/presets/p1', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; id: string };
      expect(body.success).toBe(true);
      expect(body.id).toBe('p1');
    });
  });

  // --------------------------------------------------------------------------
  // AC5: Delete preset removes it
  // --------------------------------------------------------------------------

  describe('AC5: delete preset removes it from storage', () => {
    it('REQ-TERM-010 AC5: deleting a preset removes it and leaves remaining presets intact', async () => {
      const existing = [
        { id: 'pa', name: 'Keep A', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
        { id: 'pb', name: 'Delete B', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-02' },
        { id: 'pc', name: 'Keep C', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-03' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/api/presets/pb', { method: 'DELETE' });

      expect(res.status).toBe(200);

      // Verify remaining presets written to KV do not contain 'pb'
      const putCall = mockKV.put.mock.calls.find(
        (call: unknown[]) => call[0] === 'presets:codeflare-test-user',
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1] as string) as { id: string }[];
      expect(stored).toHaveLength(2);
      expect(stored.map((p) => p.id)).not.toContain('pb');
      expect(stored.map((p) => p.id)).toContain('pa');
      expect(stored.map((p) => p.id)).toContain('pc');
    });

    it('REQ-TERM-010 AC5: deleting a non-existent preset returns 404', async () => {
      const app = createTestApp();
      const res = await app.request('/api/presets/ghost-id', { method: 'DELETE' });

      expect(res.status).toBe(404);
    });
  });
});
