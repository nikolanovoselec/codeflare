/**
 * REQ-SESSION-001: Session creation with name and agent type
 * AC coverage: AC1 (name/agentType acceptance), AC2 (ID generation),
 *              AC3 (KV persistence), AC4 (201 response), AC5 (rate limit)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';

// Mock auth middleware
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'user' });
    c.set('bucketName', 'test-bucket');
    return next();
  }),
}));

// Mock subscription tier checks (non-SaaS path: no storage quota gate)
vi.mock('../../lib/onboarding', () => ({
  isSaasModeActive: vi.fn(() => false),
}));

// Rate limiter: pass-through for all tests except the rate-limit test
const rateLimiterState = vi.hoisted(() => ({ block: false }));
vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (c: any, next: any) => {
    if (rateLimiterState.block) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    return next();
  }),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

import crudRoutes from '../../routes/session/crud';
import { SESSION_ID_PATTERN } from '../../lib/constants';

describe('REQ-SESSION-001: Session creation with name and agent type', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    rateLimiterState.block = false;
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: crudRoutes }],
      mockKV,
    });
  }

  // AC1: POST /api/sessions accepts a name (trimmed, sanitized) and optional agentType
  describe('REQ-SESSION-001 AC1: name and agentType accepted', () => {
    it('accepts a valid name and agentType=claude-code', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Session', agentType: 'claude-code' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session.name).toBe('My Session');
      expect(body.session.agentType).toBe('claude-code');
    });

    it('accepts all valid agentType values', async () => {
      const validTypes = ['claude-code', 'codex', 'gemini', 'opencode', 'copilot', 'bash'] as const;
      for (const agentType of validTypes) {
        const app = createApp();
        const res = await app.request('/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', agentType }),
        });
        expect(res.status, `expected 201 for agentType=${agentType}`).toBe(201);
        const body = await res.json() as { session: Session };
        expect(body.session.agentType).toBe(agentType);
      }
    });

    it('rejects an unknown agentType', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', agentType: 'unknown-agent' }),
      });
      expect(res.status).toBe(400);
    });

    it('trims leading/trailing whitespace from name', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  My Session  ' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      // name is trimmed by sanitizeSessionName
      expect(body.session.name.startsWith(' ')).toBe(false);
      expect(body.session.name.endsWith(' ')).toBe(false);
    });

    it('sanitizes shell metacharacters from name', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad$(rm -rf)' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      // Shell metacharacters stripped by sanitizeSessionName
      expect(body.session.name).not.toContain('$');
      expect(body.session.name).not.toContain('(');
      expect(body.session.name).not.toContain(')');
    });

    it('uses "Terminal" as default name when name is omitted', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session.name).toBe('Terminal');
    });
  });

  // AC2: Unique alphanumeric session ID (8-24 lowercase chars, matching SESSION_ID_PATTERN)
  describe('REQ-SESSION-001 AC2: unique alphanumeric session ID generated', () => {
    it('returns a session ID matching SESSION_ID_PATTERN /^[a-z0-9]{8,24}$/', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(SESSION_ID_PATTERN.test(body.session.id)).toBe(true);
    });

    it('generates distinct IDs for two successive creates', async () => {
      const app = createApp();
      const res1 = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'S1' }),
      });
      const res2 = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'S2' }),
      });
      const b1 = await res1.json() as { session: Session };
      const b2 = await res2.json() as { session: Session };
      expect(b1.session.id).not.toBe(b2.session.id);
    });

    it('session ID contains only lowercase hex characters (a-f0-9)', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });
      const body = await res.json() as { session: Session };
      expect(/^[a-f0-9]{24}$/.test(body.session.id)).toBe(true);
    });
  });

  // AC3: Session record persisted to KV at session:{bucketName}:{sessionId}
  describe('REQ-SESSION-001 AC3: session persisted to KV with correct key', () => {
    it('writes session to KV at session:{bucketName}:{sessionId}', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'KV Test' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      const sessionId = body.session.id;

      // Verify the KV key is exactly session:{bucketName}:{sessionId}
      const expectedKey = `session:test-bucket:${sessionId}`;
      const stored = await mockKV.get(expectedKey, 'json') as Session;
      expect(stored).not.toBeNull();
      expect(stored.id).toBe(sessionId);
      expect(stored.name).toBe('KV Test');
    });

    it('stored session includes userId matching bucketName', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'UserID Test' }),
      });
      const body = await res.json() as { session: Session };
      const stored = await mockKV.get(`session:test-bucket:${body.session.id}`, 'json') as Session;
      expect(stored.userId).toBe('test-bucket');
    });

    it('KV write uses putSessionWithMetadata (list metadata present)', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Meta Test' }),
      });
      const body = await res.json() as { session: Session };
      const sessionId = body.session.id;

      // putSessionWithMetadata stores metadata in the KV put options
      // The mockKV captures metadata; verify the put was called with metadata
      const putCalls = mockKV.put.mock.calls;
      const sessionPut = putCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes(sessionId)
      );
      expect(sessionPut).toBeDefined();
      // Third arg is options object with metadata
      const opts = sessionPut![2] as { metadata?: unknown };
      expect(opts?.metadata).toBeDefined();
    });
  });

  // AC4: Response returns session object with status 201
  describe('REQ-SESSION-001 AC4: response returns session object with status 201', () => {
    it('responds with HTTP 201 and session object', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Response Test', agentType: 'bash' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { session: Session };
      expect(body.session).toBeDefined();
      expect(body.session.id).toBeDefined();
      expect(body.session.name).toBe('Response Test');
      expect(body.session.agentType).toBe('bash');
      expect(body.session.createdAt).toBeDefined();
    });

    it('response session object does NOT include userId (omitted by toApiSession)', async () => {
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No UserId' }),
      });
      const body = await res.json() as { session: Record<string, unknown> };
      expect(body.session.userId).toBeUndefined();
    });
  });

  // AC5: Session creation is rate-limited (10/min per user)
  describe('REQ-SESSION-001 AC5: session creation is rate-limited', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      rateLimiterState.block = true;
      const app = createApp();
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Rate Limited' }),
      });
      expect(res.status).toBe(429);
    });

    it('rate limiter is configured with 10 requests per 60s window', async () => {
      // Verify createRateLimiter was called with the expected config
      const { createRateLimiter } = await import('../../middleware/rate-limit');
      const calls = vi.mocked(createRateLimiter).mock.calls;
      const sessionCreateCall = calls.find((c) => {
        const cfg = c[0] as { maxRequests?: number; windowMs?: number; keyPrefix?: string };
        return cfg.keyPrefix === 'session-create';
      });
      expect(sessionCreateCall).toBeDefined();
      const cfg = sessionCreateCall![0] as { maxRequests: number; windowMs: number };
      expect(cfg.maxRequests).toBe(10);
      expect(cfg.windowMs).toBe(60_000);
    });
  });
});
