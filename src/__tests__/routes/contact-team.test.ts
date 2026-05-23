/**
 * Integration tests for POST /auth/contact-team — REQ-SUB-017: Enterprise tier contact flow.
 *
 * Covers:
 *   AC2: Clicking sends an inquiry email to admins via POST /api/auth/contact-team
 *   AC4: Rate-limited to 1 request per hour per user
 *   AC5: When RESEND_API_KEY is not configured, endpoint returns success but no email is sent
 *   (AC1/AC3 are frontend-only; AC3 tested via disabled-state mutation, not covered here)
 *
 * Deleting the contact-team route or removing sendAccessRequestNotification wiring breaks
 * the AC2 test; removing the rate limiter breaks AC4.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// Auth mock
// ---------------------------------------------------------------------------
const mockAuthResult = {
  user: {
    email: 'enterprise@example.com',
    authenticated: true,
    role: 'user',
    accessTier: 'pending',
    subscriptionTier: 'pending',
  } as AccessUser,
  bucketName: 'codeflare-enterprise',
};
let mockAuthShouldReject = false;

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => {
    if (mockAuthShouldReject) {
      throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    }
    return { ...mockAuthResult, user: { ...mockAuthResult.user } };
  }),
}));

// ---------------------------------------------------------------------------
// Email mock — track calls without sending real email
// ---------------------------------------------------------------------------
// vi.mock() factories are hoisted ABOVE all top-level code, so any
// referenced helpers must also be hoisted via vi.hoisted(); otherwise
// the factory hits a ReferenceError at module-init time.
const { mockSendAccessRequestNotification } = vi.hoisted(() => ({
  mockSendAccessRequestNotification: vi.fn(
    async (_opts: Record<string, unknown>): Promise<boolean> => true
  ),
}));
vi.mock('../../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/email')>();
  return {
    ...actual,
    sendAccessRequestNotification: mockSendAccessRequestNotification,
  };
});

// Admin emails mock
vi.mock('../../lib/access-policy', () => ({
  getAdminEmails: vi.fn(async () => ['admin@example.com']),
  getAllUsers: vi.fn(async () => []),
}));

import authRoutes from '../../routes/auth';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function createApp(envOverrides: Partial<Env> = {}) {
  const mockKV = createMockKV();
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      ...envOverrides,
    } as Env;
    return next();
  });

  app.route('/auth', authRoutes);

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: String(err) }, 500);
  });

  return { app, mockKV };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /auth/contact-team — REQ-SUB-017: Enterprise tier contact flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = {
      email: 'enterprise@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'pending',
      subscriptionTier: 'pending',
    };
  });

  // AC2: endpoint returns success and calls email notification
  it('REQ-SUB-017 AC2: returns { success: true } and calls sendAccessRequestNotification', async () => {
    const { app } = createApp();

    const res = await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockSendAccessRequestNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userEmail: 'enterprise@example.com',
        adminEmails: ['admin@example.com'],
      }),
    );
  });

  it('REQ-SUB-017 AC2: passes the plan name in the notification', async () => {
    const { app } = createApp();

    await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });

    expect(mockSendAccessRequestNotification).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'Custom' }),
    );
  });

  it('REQ-SUB-017 AC2: defaults plan to "Custom" when not provided in body', async () => {
    const { app } = createApp();

    await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(mockSendAccessRequestNotification).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'Custom' }),
    );
  });

  // AC4: rate-limited to 1 request per hour
  it('REQ-SUB-017 AC4: returns 429 on second request within rate-limit window', async () => {
    const { app } = createApp();

    // First request — succeeds
    const res1 = await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });
    expect(res1.status).toBe(200);

    // Second request within the same 1-hour window — should be rate-limited
    const res2 = await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });
    expect(res2.status).toBe(429);
  });

  // AC5: returns success even when email delivery fails (RESEND_API_KEY not set)
  it('REQ-SUB-017 AC5: returns success even when email notification throws (no RESEND key)', async () => {
    mockSendAccessRequestNotification.mockRejectedValueOnce(new Error('Resend not configured'));

    const { app } = createApp();

    const res = await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });

    // Must still return 200 — email failure is non-fatal
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  // Authentication requirement
  it('REQ-SUB-017: returns 401 for unauthenticated requests', async () => {
    mockAuthShouldReject = true;
    const { app } = createApp();

    const res = await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });

    expect(res.status).toBe(401);
  });

  // Plan name is included in the notification (AC2 includes user email)
  it('REQ-SUB-017 AC2: includes user email in the notification payload', async () => {
    const { app } = createApp();

    await app.request('/auth/contact-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Custom' }),
    });

    const callArg = mockSendAccessRequestNotification.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.userEmail).toBe('enterprise@example.com');
  });
});
