import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';

const sendNotificationMock = vi.hoisted(() => vi.fn());
vi.mock('edgepush', () => ({
  sendNotification: sendNotificationMock,
}));

import {
  MAX_AGENT_EVENTS_PER_SEND,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  sendAgentEventPushes,
  type AgentEventForPush,
  type PushSubscriptionRecord,
} from '../../lib/push-sender';
import { getPushSubKey } from '../../lib/kv-keys';
import type { Session } from '../../types';

const VAPID = Object.freeze({
  subject: 'mailto:ops@codeflare.example',
  publicKey: 'public-vapid-key',
  privateKey: 'private-vapid-key',
});

const SESSION: Session = Object.freeze({
  id: 'abcdef0123456789',
  name: 'Pi #1',
  userId: 'user@example.com',
  createdAt: '2026-08-21T00:00:00.000Z',
  lastAccessedAt: '2026-08-21T00:00:00.000Z',
  agentType: 'pi',
});

function event(id: string, kind: AgentEventForPush['kind'] = 'input-required'): AgentEventForPush {
  return Object.freeze({
    schemaVersion: 1,
    eventId: id,
    kind,
    createdAt: 1_700_000_000_000,
  });
}

function subscription(endpoint: string, createdAt: number): PushSubscriptionRecord {
  return Object.freeze({
    endpoint,
    keys: {
      p256dh: 'B'.repeat(87),
      auth: 'A'.repeat(22),
    },
    createdAt,
  });
}

async function storeSubscription(
  kv: ReturnType<typeof createMockKV>,
  bucketName: string,
  digest: string,
  value: PushSubscriptionRecord,
): Promise<string> {
  const key = getPushSubKey(bucketName, digest);
  kv._set(key, value);
  return key;
}

describe('REQ-TERM-023 AC5 / REQ-SEC-023 AC4-AC7: Web Push sender', () => {
  let kv: ReturnType<typeof createMockKV>;
  const bucketName = 'codeflare-user-example-com';

  beforeEach(() => {
    kv = createMockKV();
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ status: 201, expired: false, body: '' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends only the fixed seven-field payload enriched from the DO-owned Session', async () => {
    await storeSubscription(kv, bucketName, 'digest-a', subscription(
      'https://fcm.googleapis.com/fcm/send/device-a',
      1,
    ));

    const result = await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('event-a')],
      vapid: VAPID,
    });

    expect(result.sentEventIds).toEqual(['event-a']);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [target, payload, options] = sendNotificationMock.mock.calls[0] as [
      PushSubscriptionRecord,
      string,
      Record<string, unknown>,
    ];
    expect(target).toEqual(expect.objectContaining({
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-a',
      keys: expect.any(Object),
    }));
    expect(JSON.parse(payload)).toEqual({
      v: 1,
      eventId: 'event-a',
      kind: 'input-required',
      sessionPath: '/app/session/abcdef0123456789',
      sessionName: 'Pi #1',
      agent: 'Pi',
      createdAt: 1_700_000_000_000,
    });
    expect(options).toEqual(expect.objectContaining({
      vapid: VAPID,
      ttl: 3_600,
      urgency: 'high',
    }));
  });

  it('uses normal urgency for completion and failure while retaining one-hour TTL', async () => {
    await storeSubscription(kv, bucketName, 'digest-a', subscription(
      'https://updates.push.services.mozilla.com/wpush/v2/device-a',
      1,
    ));

    await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('completed', 'task-completed'), event('failed', 'task-failed')],
      vapid: VAPID,
    });

    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    for (const call of sendNotificationMock.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ ttl: 3_600, urgency: 'normal' }));
    }
  });

  it('deletes 404/410 subscriptions and treats that terminal outcome as processed', async () => {
    const expiredKey = await storeSubscription(kv, bucketName, 'digest-expired', subscription(
      'https://web.push.apple.com/device-expired',
      1,
    ));
    sendNotificationMock.mockResolvedValueOnce({ status: 410, expired: true, body: '' });

    const result = await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('event-a')],
      vapid: VAPID,
    });

    expect(kv.delete).toHaveBeenCalledWith(expiredKey);
    expect(result.sentEventIds).toEqual(['event-a']);
  });

  it('retains transient failures for re-offer and never deletes their subscription', async () => {
    const retainedKey = await storeSubscription(kv, bucketName, 'digest-retained', subscription(
      'https://fcm.googleapis.com/fcm/send/device-retained',
      1,
    ));
    sendNotificationMock.mockRejectedValueOnce(new Error(
      'push service returned 503: endpoint=https://capability.example/secret',
    ));

    const result = await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('event-a')],
      vapid: VAPID,
    });

    expect(result.sentEventIds).toEqual([]);
    expect(kv.delete).not.toHaveBeenCalledWith(retainedKey);
    expect(JSON.stringify(result)).not.toContain('capability.example');
  });

  it('acknowledges an event only after every live subscription is sent or removed as expired', async () => {
    await storeSubscription(kv, bucketName, 'digest-a', subscription(
      'https://fcm.googleapis.com/fcm/send/device-a',
      1,
    ));
    await storeSubscription(kv, bucketName, 'digest-b', subscription(
      'https://updates.push.services.mozilla.com/wpush/v2/device-b',
      2,
    ));
    sendNotificationMock
      .mockResolvedValueOnce({ status: 201, expired: false, body: '' })
      .mockRejectedValueOnce(new Error('temporary'));

    const result = await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('event-a')],
      vapid: VAPID,
    });

    expect(result.sentEventIds).toEqual([]);
  });

  it('does not clear an event when the user has no subscriptions', async () => {
    const result = await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('event-a')],
      vapid: VAPID,
    });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(result.sentEventIds).toEqual([]);
  });

  it('aborts a provider request that never settles and retains the event for re-offer', async () => {
    vi.useFakeTimers();
    await storeSubscription(kv, bucketName, 'digest-stalled', subscription(
      'https://fcm.googleapis.com/fcm/send/device-stalled',
      1,
    ));
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        observedSignal = init?.signal ?? undefined;
        observedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      },
    ));
    vi.stubGlobal('fetch', fetchMock);
    sendNotificationMock.mockImplementation(
      async (_target: PushSubscriptionRecord, _payload: string, options: { fetch?: typeof fetch }) => {
        if (!options.fetch) throw new Error('bounded transport missing');
        await options.fetch('https://push.example.test/message', { method: 'POST' });
        return { status: 201, expired: false, body: '' };
      },
    );

    const delivery = sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events: [event('event-stalled')],
      vapid: VAPID,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(delivery).resolves.toEqual({ sentEventIds: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('bounds events, subscriptions, and total fan-out', async () => {
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER + 2; i++) {
      await storeSubscription(kv, bucketName, `digest-${i}`, subscription(
        `https://fcm.googleapis.com/fcm/send/device-${i}`,
        i,
      ));
    }
    const events = Array.from(
      { length: MAX_AGENT_EVENTS_PER_SEND + 2 },
      (_, index) => event(`event-${index}`),
    );

    await sendAgentEventPushes({
      kv: kv as unknown as KVNamespace,
      bucketName,
      session: SESSION,
      events,
      vapid: VAPID,
    });

    expect(sendNotificationMock).toHaveBeenCalledTimes(
      MAX_PUSH_SUBSCRIPTIONS_PER_USER * MAX_AGENT_EVENTS_PER_SEND,
    );
  });
});
