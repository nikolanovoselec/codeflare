import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { authMiddleware, type AuthVariables } from '../middleware/auth';
import { ValidationError } from '../lib/error-types';
import { getPushSubKey, getPushSubPrefix, listAllKvKeys } from '../lib/kv-keys';
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  type PushSubscriptionRecord,
} from '../lib/push-sender';

const MAX_SUBSCRIPTION_BODY_BYTES = 4 * 1024;
const MAX_ENDPOINT_BYTES = 2 * 1024;
const ALLOWED_PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const P256DH_PATTERN = /^B[A-Za-z0-9_-]{86}$/;
const AUTH_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type NotificationContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

function invalidRequest(): ValidationError {
  return new ValidationError('Invalid notification request');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isAllowedEndpoint(endpoint: string): boolean {
  if (
    endpoint.trim() !== endpoint
    || /[\u0000-\u001f\u007f]/.test(endpoint)
    || new TextEncoder().encode(endpoint).byteLength > MAX_ENDPOINT_BYTES
  ) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:'
      && ALLOWED_PUSH_HOSTS.has(url.hostname)
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.hash === ''
      && url.pathname.length > 1;
  } catch {
    return false;
  }
}

async function parseBoundedJson(c: NotificationContext): Promise<unknown> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw invalidRequest();

  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_SUBSCRIPTION_BODY_BYTES) {
      throw invalidRequest();
    }
  }

  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw invalidRequest();
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SUBSCRIPTION_BODY_BYTES) {
    throw invalidRequest();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest();
  }
}

/** Validate a registration without including capability material in any error. */
async function parsePushSubscription(c: NotificationContext): Promise<PushSubscriptionRecord> {
  const body = await parseBoundedJson(c);
  if (!isRecord(body) || !hasExactKeys(body, ['endpoint', 'keys'])) throw invalidRequest();
  if (typeof body.endpoint !== 'string' || !isAllowedEndpoint(body.endpoint)) throw invalidRequest();
  if (!isRecord(body.keys) || !hasExactKeys(body.keys, ['auth', 'p256dh'])) throw invalidRequest();
  if (typeof body.keys.p256dh !== 'string' || !P256DH_PATTERN.test(body.keys.p256dh)) {
    throw invalidRequest();
  }
  if (typeof body.keys.auth !== 'string' || !AUTH_PATTERN.test(body.keys.auth)) {
    throw invalidRequest();
  }

  return {
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    createdAt: Date.now(),
  };
}

async function parseEndpointForDeletion(c: NotificationContext): Promise<string> {
  const body = await parseBoundedJson(c);
  if (!isRecord(body) || !hasExactKeys(body, ['endpoint'])) throw invalidRequest();
  if (typeof body.endpoint !== 'string' || !isAllowedEndpoint(body.endpoint)) throw invalidRequest();
  return body.endpoint;
}

async function endpointDigest(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function enforceSubscriptionCap(kv: KVNamespace, bucketName: string): Promise<void> {
  const keys = await listAllKvKeys(kv, getPushSubPrefix(bucketName));
  if (keys.length <= MAX_PUSH_SUBSCRIPTIONS_PER_USER) return;

  const ranked = await Promise.all(keys.map(async ({ name }) => {
    const record = await kv.get<PushSubscriptionRecord>(name, 'json');
    return {
      name,
      createdAt: typeof record?.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : Number.NEGATIVE_INFINITY,
    };
  }));
  ranked.sort((left, right) => {
    const createdAtOrder = left.createdAt - right.createdAt;
    if (createdAtOrder !== 0) return createdAtOrder;
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });

  const excess = ranked.length - MAX_PUSH_SUBSCRIPTIONS_PER_USER;
  await Promise.all(ranked.slice(0, excess).map(({ name }) => kv.delete(name)));
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/config', (c) => {
  if (!c.env.VAPID_PUBLIC_KEY?.trim()) {
    return c.json({ error: 'Notification service unavailable' }, 503);
  }
  return c.json({ vapidPublicKey: c.env.VAPID_PUBLIC_KEY });
});

app.post('/subscription', async (c) => {
  const subscription = await parsePushSubscription(c);
  const bucketName = c.get('bucketName');
  const key = getPushSubKey(bucketName, await endpointDigest(subscription.endpoint));
  await c.env.KV.put(key, JSON.stringify(subscription));
  await enforceSubscriptionCap(c.env.KV, bucketName);
  return c.json({ success: true });
});

app.delete('/subscription', async (c) => {
  const endpoint = await parseEndpointForDeletion(c);
  const key = getPushSubKey(c.get('bucketName'), await endpointDigest(endpoint));
  await c.env.KV.delete(key);
  return c.json({ success: true });
});

export default app;
