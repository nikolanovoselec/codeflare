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

describe('LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)', () => {
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
    // CF-007: PUT now probes the provider (validateOpenAIKey/validateGeminiKey)
    // before storing. Stub fetch as OK so the key-storage happy-path tests
    // exercise the storage path rather than the live provider call.
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;
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
      const stored = await mockKV.get('llm-keys:test-bucket', 'json') as Record<string, unknown>;
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

  describe('PUT /api/llm-keys - encryption', () => {
    // Generate key ONCE so PUT and GET share the same key
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const stableBase64Key = btoa(String.fromCharCode(...rawKey));

    function createEncryptedTestApp() {
      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as any);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });
      app.use('*', async (c, next) => {
        (c.env as any) = { KV: mockKV, ENCRYPTION_KEY: stableBase64Key };
        return next();
      });
      app.route('/api/llm-keys', llmKeysRoutes);
      return app;
    }

    it('stores encrypted value with v1: prefix when ENCRYPTION_KEY set', async () => {
      const app = createEncryptedTestApp();
      await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: 'sk-encrypted-test' }),
      });

      const rawStored = mockKV._store.get('llm-keys:test-bucket');
      expect(rawStored).toBeDefined();
      expect(rawStored!.startsWith('v1:')).toBe(true);
      expect(() => JSON.parse(rawStored!)).toThrow();
    });

    it('GET decrypts correctly when ENCRYPTION_KEY set', async () => {
      const app = createEncryptedTestApp();

      // First store via PUT (encrypted)
      await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: 'sk-roundtrip-test1234' }),
      });

      // Then read via GET (should decrypt and mask)
      const res = await app.request('/api/llm-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('****1234');
    });

    it('GET returns empty for corrupted KV data with encryption key', async () => {
      // Store invalid (non-encrypted) data directly in KV
      mockKV._store.set('llm-keys:test-bucket', 'corrupted-data-not-encrypted');

      const app = createEncryptedTestApp();
      const res = await app.request('/api/llm-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      // Should return undefined keys (not crash)
      expect(body.openaiApiKey).toBeUndefined();
      expect(body.geminiApiKey).toBeUndefined();
    });

    it('GET migrates plaintext to encrypted', async () => {
      // Pre-populate with plaintext JSON (legacy pre-encryption entry)
      mockKV._set('llm-keys:test-bucket', {
        openaiApiKey: 'sk-migrate-test1234',
        geminiApiKey: 'AIza-migrate-test',
      } satisfies LlmKeys);

      const app = createEncryptedTestApp();

      // GET should return masked keys (migration happens transparently)
      const res = await app.request('/api/llm-keys');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.openaiApiKey).toBe('****1234');
      expect(body.geminiApiKey).toBe('****test');

      // Wait for fire-and-forget migration write-back
      await new Promise(resolve => setTimeout(resolve, 50));

      // The raw KV value should now be encrypted (v1: prefix)
      const rawStored = mockKV._store.get('llm-keys:test-bucket');
      expect(rawStored).toBeDefined();
      expect(rawStored!.startsWith('v1:')).toBe(true);
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

  // REQ-AGENT-031 AC6 / REQ-AGENT-009 + REQ-AGENT-020 enterprise constraint:
  // per-user LLM keys do not exist in enterprise mode (models route through the
  // managed AI Gateway BYOK). Every method is rejected with 403 BEFORE touching KV.
  describe('enterprise mode (REQ-AGENT-031 AC6)', () => {
    function createEnterpriseTestApp() {
      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as any);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });
      app.use('*', async (c, next) => {
        (c.env as any) = { KV: mockKV, ENTERPRISE_MODE: 'active' };
        return next();
      });
      app.route('/api/llm-keys', llmKeysRoutes);
      return app;
    }

    it('GET returns 403 and never reads KV', async () => {
      const app = createEnterpriseTestApp();
      const res = await app.request('/api/llm-keys');
      expect(res.status).toBe(403);
      expect(mockKV.get).not.toHaveBeenCalled();
    });

    it('PUT returns 403 and never writes KV', async () => {
      const app = createEnterpriseTestApp();
      const res = await app.request('/api/llm-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: 'sk-should-not-store' }),
      });
      expect(res.status).toBe(403);
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('DELETE returns 403 and never deletes KV', async () => {
      const app = createEnterpriseTestApp();
      const res = await app.request('/api/llm-keys', { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(mockKV.delete).not.toHaveBeenCalled();
    });
  });
});
