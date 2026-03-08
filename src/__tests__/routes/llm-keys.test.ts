import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, LlmKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { AppError } from '../../lib/error-types';

// Hoisted mocks
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  })),
}));

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { email: 'test@example.com', authenticated: true, role: 'user' },
    bucketName: 'test-bucket',
  })),
}));

import llmKeysRoutes from '../../routes/llm-keys';

describe('LLM Keys routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  function createTestApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as any);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });
    app.use('*', async (c, next) => {
      (c.env as any) = { KV: mockKV };
      return next();
    });
    app.route('/api/llm-keys', llmKeysRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = createMockKV();
  });

  describe('GET /api/llm-keys', () => {
    it('returns empty when no keys stored', async () => {
      const app = createTestApp();
      const res = await app.request('/api/llm-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBeUndefined();
      expect(body.geminiApiKey).toBeUndefined();
    });

    it('returns masked keys when keys exist', async () => {
      mockKV._set('llm-keys:test-bucket', {
        openaiApiKey: 'sk-abcdefghijklmnop',
        geminiApiKey: 'AIzaSyBxxxxxxxxxxxxxxx',
      } satisfies LlmKeys);

      const app = createTestApp();
      const res = await app.request('/api/llm-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('****mnop');
      expect(body.geminiApiKey).toBe('****xxxx');
    });

    it('masks short keys correctly', async () => {
      mockKV._set('llm-keys:test-bucket', { openaiApiKey: 'abc' } satisfies LlmKeys);

      const app = createTestApp();
      const res = await app.request('/api/llm-keys');
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('****');
    });

    it('never returns full keys', async () => {
      mockKV._set('llm-keys:test-bucket', { openaiApiKey: 'sk-full-secret-key-1234' } satisfies LlmKeys);

      const app = createTestApp();
      const res = await app.request('/api/llm-keys');
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).not.toContain('sk-full');
      expect(body.openaiApiKey).toMatch(/^\*{4}/);
    });
  });

  describe('PUT /api/llm-keys', () => {
    it('stores a new key and returns masked', async () => {
      const app = createTestApp();
      const res = await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: 'sk-test1234567890' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('****7890');

      // Verify stored in KV
      const stored = await mockKV.get('llm-keys:test-bucket', 'json');
      expect(stored.openaiApiKey).toBe('sk-test1234567890');
    });

    it('clears a key when null is sent', async () => {
      mockKV._set('llm-keys:test-bucket', {
        openaiApiKey: 'sk-existing',
        geminiApiKey: 'AIzaSy-existing',
      });

      const app = createTestApp();
      const res = await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBeUndefined();
      expect(body.geminiApiKey).toMatch(/^\*{4}/);
    });

    it('leaves key unchanged when field is omitted', async () => {
      mockKV._set('llm-keys:test-bucket', { openaiApiKey: 'sk-keep-this' });

      const app = createTestApp();
      const res = await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: 'AIzaSy-new' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('****this');
      expect(body.geminiApiKey).toBe('****-new');
    });

    it('deletes KV entry when both keys cleared', async () => {
      mockKV._set('llm-keys:test-bucket', { openaiApiKey: 'sk-old', geminiApiKey: 'AI-old' });

      const app = createTestApp();
      await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: null, geminiApiKey: null }),
      });

      expect(mockKV.delete).toHaveBeenCalledWith('llm-keys:test-bucket');
    });

    it('rejects unknown fields', async () => {
      const app = createTestApp();
      const res = await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unknownField: 'value' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/llm-keys', () => {
    it('removes all keys from KV', async () => {
      mockKV._set('llm-keys:test-bucket', { openaiApiKey: 'sk-delete-me' });

      const app = createTestApp();
      const res = await app.request('/api/llm-keys', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(mockKV.delete).toHaveBeenCalledWith('llm-keys:test-bucket');
    });
  });
});
