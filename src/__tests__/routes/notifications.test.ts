import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { AppError, AuthError } from '../../lib/error-types';
import { getPushSubPrefix } from '../../lib/kv-keys';
import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from '../../lib/push-sender';

const authState = vi.hoisted(() => ({
  bucketName: 'bucket-a',
}));
const authenticateRequestMock = vi.hoisted(() => vi.fn());
const logState = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../lib/access', () => ({
  authenticateRequest: authenticateRequestMock,
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({ ...logState, child: () => logState })),
}));

import notificationRoutes from '../../routes/notifications';

const VALID_KEYS = Object.freeze({
  p256dh: 'B'.repeat(87),
  auth: 'A'.repeat(22),
});

function createTestApp(
  kv: ReturnType<typeof createMockKV>,
  vapidPublicKey = 'public-vapid-key',
  vapidSubject = 'mailto:ops@codeflare.example',
  vapidPrivateKey = 'private-vapid-key',
) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toJSON(), error.statusCode as never);
    return c.json({ error: 'Unexpected error' }, 500);
  });
  app.use('*', async (c, next) => {
    (c.env as Partial<Env>) = {
      KV: kv as unknown as KVNamespace,
      VAPID_SUBJECT: vapidSubject,
      VAPID_PUBLIC_KEY: vapidPublicKey,
      VAPID_PRIVATE_KEY: vapidPrivateKey,
    };
    return next();
  });
  app.route('/api/notifications', notificationRoutes);
  return app;
}

async function subscriptionKeys(kv: ReturnType<typeof createMockKV>, bucketName: string) {
  return (await kv.list({ prefix: getPushSubPrefix(bucketName) })).keys.map((entry) => entry.name).sort();
}

async function postSubscription(app: ReturnType<typeof createTestApp>, endpoint: string, keys = VALID_KEYS) {
  return app.request('/api/notifications/subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, keys }),
  });
}

describe('REQ-TERM-025 AC1-AC6 / REQ-SEC-023 AC1-AC4/AC7: notification routes', () => {
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    kv = createMockKV();
    authState.bucketName = 'bucket-a';
    authenticateRequestMock.mockReset();
    authenticateRequestMock.mockImplementation(async () => ({
      user: { email: 'test@example.com', authenticated: true, role: 'user' },
      bucketName: authState.bucketName,
    }));
    for (const fn of Object.values(logState)) fn.mockReset();
  });

  it('requires authentication for config, subscribe, and unsubscribe', async () => {
    authenticateRequestMock.mockRejectedValue(new AuthError());
    const app = createTestApp(kv);
    for (const [path, init] of [
      ['/api/notifications/config', undefined],
      ['/api/notifications/subscription', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: VALID_KEYS }),
      }],
      ['/api/notifications/subscription', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/a' }),
      }],
    ] as const) {
      const response = await app.request(path, init);
      expect(response.status).toBe(401);
    }
    expect(await subscriptionKeys(kv, 'bucket-a')).toEqual([]);
  });

  it('returns only the public VAPID key from authenticated config', async () => {
    const app = createTestApp(kv, 'configured-public-key');
    const response = await app.request('/api/notifications/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vapidPublicKey: 'configured-public-key' });
  });

  it.each([
    ['subject', 'configured-public-key', '', 'configured-private-key'],
    ['public key', '', 'mailto:ops@codeflare.example', 'configured-private-key'],
    ['private key', 'configured-public-key', 'mailto:ops@codeflare.example', ''],
  ])('reports config unavailable when the %s is absent', async (_field, publicKey, subject, privateKey) => {
    const app = createTestApp(kv, publicKey, subject, privateKey);
    const response = await app.request('/api/notifications/config');
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/private|secret/i);
  });

  it('stores a validated subscription under an endpoint digest without echoing capability material', async () => {
    const app = createTestApp(kv);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-secret';
    const response = await postSubscription(app, endpoint);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });
    expect(JSON.stringify(body)).not.toContain(endpoint);
    expect(JSON.stringify(body)).not.toContain(VALID_KEYS.p256dh);

    const keys = await subscriptionKeys(kv, 'bucket-a');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^pushsub:bucket-a:[a-f0-9]{64}$/);
    expect(keys[0]).not.toContain('device-secret');
    const stored = await kv.get(keys[0], 'json') as Record<string, unknown>;
    expect(stored).toEqual(expect.objectContaining({ endpoint, keys: VALID_KEYS, createdAt: expect.any(Number) }));
  });

  it('replaces the same endpoint digest instead of creating a duplicate', async () => {
    const app = createTestApp(kv);
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/device-a';
    expect((await postSubscription(app, endpoint)).status).toBe(200);
    expect((await postSubscription(app, endpoint, { ...VALID_KEYS, auth: 'C'.repeat(22) })).status).toBe(200);

    const keys = await subscriptionKeys(kv, 'bucket-a');
    expect(keys).toHaveLength(1);
    expect(await kv.get(keys[0], 'json')).toEqual(expect.objectContaining({
      keys: expect.objectContaining({ auth: 'C'.repeat(22) }),
    }));
  });

  it('evicts the oldest subscription deterministically beyond the per-user cap', async () => {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now++;
    try {
      const app = createTestApp(kv);
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1; i++) {
        expect((await postSubscription(
          app,
          `https://fcm.googleapis.com/fcm/send/device-${i}`,
        )).status).toBe(200);
      }
    } finally {
      Date.now = realNow;
    }

    const keys = await subscriptionKeys(kv, 'bucket-a');
    expect(keys).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    const records = await Promise.all(keys.map((key) => kv.get(key, 'json') as Promise<{ endpoint: string }>));
    expect(records.map((record) => record.endpoint)).not.toContain(
      'https://fcm.googleapis.com/fcm/send/device-0',
    );
  });

  it('deletes only the authenticated user subscription identified by endpoint digest', async () => {
    const app = createTestApp(kv);
    const endpoint = 'https://web.push.apple.com/device-a';
    await postSubscription(app, endpoint);

    authState.bucketName = 'bucket-b';
    await postSubscription(app, endpoint);
    expect(await subscriptionKeys(kv, 'bucket-a')).toHaveLength(1);
    expect(await subscriptionKeys(kv, 'bucket-b')).toHaveLength(1);

    const response = await app.request('/api/notifications/subscription', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await subscriptionKeys(kv, 'bucket-a')).toHaveLength(1);
    expect(await subscriptionKeys(kv, 'bucket-b')).toHaveLength(0);
  });

  it('rejects unknown providers, insecure endpoints, malformed keys, extra fields, and oversized bodies', async () => {
    const app = createTestApp(kv);
    const invalid = [
      { endpoint: 'http://fcm.googleapis.com/fcm/send/a', keys: VALID_KEYS },
      { endpoint: 'https://attacker.example/collect', keys: VALID_KEYS },
      { endpoint: 'https://fcm.googleapis.com.evil.example/fcm/send/a', keys: VALID_KEYS },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { ...VALID_KEYS, auth: 'short' } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { ...VALID_KEYS, p256dh: '!!!!' } },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: VALID_KEYS, recipient: 'other@example.com' },
    ];
    for (const body of invalid) {
      const response = await app.request('/api/notifications/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    expect(await subscriptionKeys(kv, 'bucket-a')).toEqual([]);
  });

  it('does not log or return endpoint and key capability material on validation failure', async () => {
    const app = createTestApp(kv);
    const endpoint = 'https://attacker.example/private-capability';
    const response = await postSubscription(app, endpoint, {
      p256dh: 'secret-public-key',
      auth: 'secret-auth-key',
    });
    const body = await response.text();
    const logs = JSON.stringify(Object.values(logState).flatMap((fn) => fn.mock.calls));
    expect(body).not.toContain(endpoint);
    expect(body).not.toContain('secret-public-key');
    expect(logs).not.toContain(endpoint);
    expect(logs).not.toContain('secret-public-key');
    expect(logs).not.toContain('secret-auth-key');
  });
});
