/**
 * REQ-ENTERPRISE-009: Enterprise Backend Route Hardening.
 *
 * Every SaaS/admin surface hidden by the frontend (REQ-ENTERPRISE-008) must also
 * fail closed server-side so it cannot be reached by direct API call. Each block
 * below proves the guard fires when ENTERPRISE_MODE='active' (AC1-6) and is a
 * byte-identical no-op when the flag is unset (AC7).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { resetTierConfigCache } from '../../lib/subscription';

// ---------------------------------------------------------------------------
// Mocks — keep the real modules but override the network/identity boundaries.
// ---------------------------------------------------------------------------
let mockAuthUser: AccessUser = {
  email: 'user@example.com', authenticated: true, role: 'admin',
  accessTier: 'advanced', subscriptionTier: 'unlimited',
} as AccessUser;

vi.mock('../../lib/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/access')>();
  return {
    ...actual,
    authenticateRequest: vi.fn(async () => ({ user: { ...mockAuthUser }, bucketName: 'codeflare-user' })),
  };
});

vi.mock('../../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/email')>();
  return {
    ...actual,
    sendSubscriptionEmail: vi.fn(async () => {}),
    sendSubscriptionAdminNotification: vi.fn(async () => {}),
    sendAccessRequestNotification: vi.fn(async () => {}),
    sendTierChangeNotification: vi.fn(async () => {}),
  };
});

vi.mock('../../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stripe')>();
  return {
    ...actual,
    fetchSubscription: vi.fn(async () => null),
    verifyWebhookSignature: vi.fn(async () => true),
    createCheckoutSession: vi.fn(async () => ({ id: 'cs', url: 'https://stripe/checkout' })),
    createPortalSession: vi.fn(async () => ({ id: 'bps', url: 'https://stripe/portal' })),
    createSwitchPortalSession: vi.fn(async () => ({ id: 'bps', url: 'https://stripe/switch' })),
  };
});

// Keep the preferences sessionMode-change reconcile off the network.
vi.mock('../../lib/r2-seed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r2-seed')>()),
  reconcileAgentConfigs: vi.fn(async () => ({ written: [], deleted: [] })),
}));
vi.mock('../../lib/r2-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r2-config')>()),
  getR2Config: vi.fn(async () => ({ endpoint: 'https://r2.example', accessKeyId: 'k', secretAccessKey: 's', accountId: 'a' })),
}));

// Import routers after mocks
import usersRoutes from '../../routes/users';
import billingRoutes from '../../routes/billing';
import stripeWebhookRoute from '../../routes/stripe-webhook';
import authRoutes from '../../routes/auth';
import tiersRoutes from '../../routes/admin/tiers';
import preferencesRoutes from '../../routes/preferences';
import { fetchSubscription, verifyWebhookSignature } from '../../lib/stripe';
import { sendSubscriptionEmail, sendAccessRequestNotification } from '../../lib/email';

const ENTERPRISE: Partial<Env> = { ENTERPRISE_MODE: 'active' };

function createApp(envOverrides: Partial<Env> = {}) {
  resetTierConfigCache();
  const mockKV = createMockKV();
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      CLOUDFLARE_WORKER_NAME: 'codeflare',
      ...envOverrides,
    } as Env;
    return next();
  });

  app.route('/api/users', usersRoutes);
  app.route('/api/billing', billingRoutes);
  app.route('/public/stripe', stripeWebhookRoute);
  app.route('/api/auth', authRoutes);
  app.route('/api/admin/tiers', tiersRoutes);
  app.route('/api/preferences', preferencesRoutes);

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    return c.json({ error: String(err) }, 500);
  });

  return { app, mockKV };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthUser = {
    email: 'user@example.com', authenticated: true, role: 'admin',
    accessTier: 'advanced', subscriptionTier: 'unlimited',
  } as AccessUser;
});

// ---------------------------------------------------------------------------
// AC1 — user-management routes fail closed, no mutation
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC1: /api/users fails closed in enterprise mode', () => {
  it('GET /api/users returns 403', async () => {
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/users');
    expect(res.status).toBe(403);
  });

  it('PUT /api/users/max-users returns 403', async () => {
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/users/max-users', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUsers: 5 }),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/users/:email returns 403 and performs no mutation', async () => {
    const { app, mockKV } = createApp(ENTERPRISE);
    mockKV._set('user:victim@example.com', { email: 'victim@example.com', role: 'user' });

    const res = await app.request('/api/users/victim@example.com', { method: 'DELETE' });
    expect(res.status).toBe(403);

    // The user record is untouched — the guard ran before any cleanup.
    const still = await mockKV.get('user:victim@example.com', 'json');
    expect(still).not.toBeNull();
  });

  it('PATCH /api/users/:email returns 403', async () => {
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/users/someone@example.com', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionTier: 'max' }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// AC2 — billing action routes 403; status returns empty state without Stripe
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC2: /api/billing is disabled in enterprise mode', () => {
  it('POST /api/billing/checkout returns 403', async () => {
    const { app } = createApp({ ...ENTERPRISE, STRIPE_SECRET_KEY: 'sk_test' } as Partial<Env>);
    const res = await app.request('/api/billing/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/billing/portal returns 403', async () => {
    const { app } = createApp({ ...ENTERPRISE, STRIPE_SECRET_KEY: 'sk_test' } as Partial<Env>);
    const res = await app.request('/api/billing/portal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/billing/switch returns 403', async () => {
    const { app } = createApp({ ...ENTERPRISE, STRIPE_SECRET_KEY: 'sk_test' } as Partial<Env>);
    const res = await app.request('/api/billing/switch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'advanced', mode: 'default' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/billing/status returns 200 all-null without contacting Stripe', async () => {
    const { app, mockKV } = createApp({ ...ENTERPRISE, STRIPE_SECRET_KEY: 'sk_test' } as Partial<Env>);
    // Even with a stored subscription id, enterprise must not call Stripe.
    mockKV._set('user:user@example.com', { stripeSubscriptionId: 'sub_x', stripeCustomerId: 'cus_x', billingStatus: 'active' });

    const res = await app.request('/api/billing/status');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stripeCustomerId).toBeNull();
    expect(body.stripeSubscriptionId).toBeNull();
    expect(body.billingStatus).toBeNull();
    expect(fetchSubscription).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3 — self-serve subscribe / request-access 403, no email
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC3: self-serve auth routes 403 with no email', () => {
  it('POST /api/auth/subscribe returns 403 and sends no email', async () => {
    mockAuthUser = { email: 'pending@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser;
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/auth/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    });
    expect(res.status).toBe(403);
    expect(sendSubscriptionEmail).not.toHaveBeenCalled();
  });

  it('POST /api/auth/request-access returns 403 and sends no email', async () => {
    mockAuthUser = { email: 'pending@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser;
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/auth/request-access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'tok' }),
    });
    expect(res.status).toBe(403);
    expect(sendAccessRequestNotification).not.toHaveBeenCalled();
  });

  it('GET /api/auth/status never reports userCapacityReached in enterprise mode', async () => {
    mockAuthUser = { email: 'pending@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser;
    const { app, mockKV } = createApp(ENTERPRISE);
    // Cap of 1 that would otherwise be "reached" — enterprise ignores it.
    mockKV._store.set('setup:max_users', '1');

    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    const body = await res.json() as { userCapacityReached: boolean };
    expect(body.userCapacityReached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Stripe webhook acks without mutating state
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC4: Stripe webhook is a no-op in enterprise mode', () => {
  it('acks {received:true} without verifying the signature or mutating KV', async () => {
    const { app, mockKV } = createApp({ ...ENTERPRISE, STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec' } as Partial<Env>);
    mockKV._set('user:buyer@example.com', { subscriptionTier: 'unlimited', billingStatus: null });

    // No Stripe-Signature header — a SaaS deploy would 400; enterprise acks first.
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { received: boolean };
    expect(body.received).toBe(true);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();

    const userData = await mockKV.get('user:buyer@example.com', 'json') as Record<string, unknown>;
    expect(userData.subscriptionTier).toBe('unlimited');
    expect(userData.billingStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC5 — admin tier configuration routes 403
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC5: admin tier config routes 403 in enterprise mode', () => {
  it('GET /api/admin/tiers returns 403', async () => {
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/admin/tiers');
    expect(res.status).toBe(403);
  });

  it('PUT /api/admin/tiers returns 403', async () => {
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/admin/tiers', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// AC6 — preferences stays available in enterprise mode (NOT fail-closed like the
// other routes); the SaaS advanced-mode entitlement gate is bypassed so any user
// may select Pro. The effective mode is forced to Pro by clampSessionModeToTier
// regardless of the stored value (REQ-ENTERPRISE-001). Detailed entitlement-gate
// coverage lives in preferences-enterprise.test.ts.
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC6: PATCH /api/preferences is not fail-closed in enterprise mode', () => {
  it('accepts a sessionMode change from a non-Pro user without a 403/400', async () => {
    mockAuthUser = { email: 'user@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser;
    const { app } = createApp(ENTERPRISE);
    const res = await app.request('/api/preferences', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'advanced', lastPresetId: 'preset-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sessionMode).toBe('advanced');
    expect(body.lastPresetId).toBe('preset-1');
  });
});

// ---------------------------------------------------------------------------
// AC7 — flag unset: every guarded route behaves as before (no enterprise 403)
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-009 AC7: flag unset is byte-identical to current behavior', () => {
  it('GET /api/users works for an admin (200, not 403)', async () => {
    const { app } = createApp();
    const res = await app.request('/api/users');
    expect(res.status).toBe(200);
    const body = await res.json() as { users: unknown[] };
    expect(Array.isArray(body.users)).toBe(true);
  });

  it('billing action routes reach normal logic, not the enterprise guard', async () => {
    // No STRIPE_SECRET_KEY → the normal "Stripe not configured" 400 (proves the
    // enterprise guard, which runs first, did not fire).
    const { app } = createApp();
    const checkout = await app.request('/api/billing/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard', mode: 'default' }),
    });
    expect(checkout.status).toBe(400);
  });

  it('GET /api/admin/tiers works for an admin (200, not 403)', async () => {
    const { app } = createApp();
    const res = await app.request('/api/admin/tiers');
    expect(res.status).toBe(200);
    const body = await res.json() as { tiers: unknown[] };
    expect(body.tiers.length).toBe(8);
  });

  it('POST /api/auth/subscribe to free tier succeeds and sends email', async () => {
    mockAuthUser = { email: 'pending@example.com', authenticated: true, role: 'user', accessTier: 'pending', subscriptionTier: 'pending' } as AccessUser;
    const { app } = createApp();
    const res = await app.request('/api/auth/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    });
    expect(res.status).toBe(200);
    expect(sendSubscriptionEmail).toHaveBeenCalled();
  });

  it('Stripe webhook without a signature 400s (no enterprise short-circuit)', async () => {
    const { app } = createApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec' } as Partial<Env>);
    const res = await app.request('/public/stripe/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/preferences persists sessionMode when the flag is unset', async () => {
    const { app } = createApp();
    const res = await app.request('/api/preferences', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'advanced', lastPresetId: 'preset-2' }),
    });
    expect(res.status).toBe(200);
    const prefs = await res.json() as Record<string, unknown>;
    expect(prefs.sessionMode).toBe('advanced');
  });
});
