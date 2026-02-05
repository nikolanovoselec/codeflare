import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import presetsRoutes from '../../routes/presets';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'user' });
    c.set('bucketName', 'codeflare-test-user');
    return next();
  }),
}));

describe('Presets Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  function createTestApp() {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
      } as Env;
      return next();
    });

    app.route('/presets', presetsRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  describe('GET /presets', () => {
    it('returns empty array when no presets exist', async () => {
      const app = createTestApp();

      const res = await app.request('/presets');

      expect(res.status).toBe(200);
      const body = await res.json() as { presets: unknown[] };
      expect(body.presets).toEqual([]);
    });

    it('returns stored presets', async () => {
      const presets = [
        { id: 'p1', name: 'Dev Setup', tabs: [{ id: '1', command: 'bash', label: 'Shell' }], createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 'p2', name: 'Debug', tabs: [{ id: '1', command: 'htop', label: 'Monitor' }], createdAt: '2024-01-02T00:00:00.000Z' },
      ];
      mockKV._set('presets:codeflare-test-user', presets);

      const app = createTestApp();
      const res = await app.request('/presets');

      expect(res.status).toBe(200);
      const body = await res.json() as { presets: typeof presets };
      expect(body.presets).toHaveLength(2);
      expect(body.presets[0].name).toBe('Dev Setup');
      expect(body.presets[1].name).toBe('Debug');
    });
  });

  describe('POST /presets', () => {
    it('creates a new preset', async () => {
      const app = createTestApp();

      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'My Preset',
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { preset: { id: string; name: string; tabs: unknown[]; createdAt: string } };
      expect(body.preset.name).toBe('My Preset');
      expect(body.preset.id).toBeDefined();
      expect(body.preset.createdAt).toBeDefined();
      expect(body.preset.tabs).toHaveLength(1);
    });

    it('persists the preset in KV', async () => {
      const app = createTestApp();

      await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Saved Preset',
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
        }),
      });

      expect(mockKV.put).toHaveBeenCalledWith(
        'presets:codeflare-test-user',
        expect.stringContaining('"Saved Preset"'),
      );
    });

    it('returns 400 for missing name', async () => {
      const app = createTestApp();

      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for blank name', async () => {
      const app = createTestApp();

      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '   ',
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty tabs array', async () => {
      const app = createTestApp();

      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'No Tabs',
          tabs: [],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid tab id', async () => {
      const app = createTestApp();

      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad Tab',
          tabs: [{ id: '99', command: 'bash', label: 'Shell' }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when exceeding max presets (3)', async () => {
      // Pre-populate with 3 presets
      const existing = [
        { id: 'p1', name: 'A', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
        { id: 'p2', name: 'B', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-02' },
        { id: 'p3', name: 'C', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-03' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Fourth',
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/maximum/i);
    });

    it('rejects extra fields (strict mode)', async () => {
      const app = createTestApp();

      const res = await app.request('/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Strict',
          tabs: [{ id: '1', command: 'bash', label: 'Shell' }],
          extraField: true,
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /presets/:id', () => {
    it('deletes an existing preset', async () => {
      const existing = [
        { id: 'p1', name: 'To Delete', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-01' },
        { id: 'p2', name: 'Keep', tabs: [{ id: '1', command: 'bash', label: 'S' }], createdAt: '2024-01-02' },
      ];
      mockKV._set('presets:codeflare-test-user', existing);

      const app = createTestApp();
      const res = await app.request('/presets/p1', { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; deleted: boolean; id: string };
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(true);
      expect(body.id).toBe('p1');

      // Verify KV was updated without p1
      const putCall = mockKV.put.mock.calls.find(
        (call: string[]) => call[0] === 'presets:codeflare-test-user',
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1]);
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('p2');
    });

    it('returns 404 for non-existent preset', async () => {
      const app = createTestApp();
      const res = await app.request('/presets/nonexistent', { method: 'DELETE' });

      expect(res.status).toBe(404);
      const body = await res.json() as { error: string; code: string };
      expect(body).toHaveProperty('code', 'NOT_FOUND');
    });

    it('returns 404 when preset list is empty', async () => {
      const app = createTestApp();
      const res = await app.request('/presets/some-id', { method: 'DELETE' });

      expect(res.status).toBe(404);
    });
  });
});
