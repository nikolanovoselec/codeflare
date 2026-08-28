import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(resolve(process.cwd(), 'public/agent-notifications-sw.js'), 'utf8');

function loadWorker(
  clients: Array<{ url: string; focus: () => Promise<void> }> = [],
  notifications: Array<{ data?: { eventId?: string } }> = [],
) {
  const listeners = new Map<string, (event: any) => void>();
  const registration = {
    showNotification: vi.fn(async () => undefined),
    getNotifications: vi.fn(async () => notifications),
  };
  const self = {
    location: { origin: 'https://codeflare.example' },
    registration,
    clients: { matchAll: vi.fn(async () => clients), openWindow: vi.fn(async () => null) },
    addEventListener: vi.fn((type: string, listener: (event: any) => void) => listeners.set(type, listener)),
  };
  runInNewContext(workerSource, { self, URL });
  return { listeners, self, registration };
}

function dispatchPush(listener: ((event: any) => void) | undefined, payload: unknown) {
  let work: Promise<void> | undefined;
  listener?.({
    data: { json: () => payload },
    waitUntil: (promise: Promise<void>) => { work = promise; },
  });
  return work;
}

const VALID_PUSH = Object.freeze({
  v: 1,
  eventId: 'event-a',
  kind: 'input-required',
  sessionPath: '/app/session/abcdef0123456789',
  sessionName: 'Pi #1',
  agent: 'Pi',
  createdAt: 1_700_000_000_000,
});

describe('REQ-TERM-027 AC1-AC2 / REQ-SEC-024 AC4: agent notification service worker push', () => {
  it('shows one fixed, tagged, user-visible notification for a valid payload', async () => {
    const { listeners, registration } = loadWorker();
    const work = dispatchPush(listeners.get('push'), VALID_PUSH);
    await work;

    expect(registration.showNotification).toHaveBeenCalledWith('Pi · Pi #1', {
      body: 'Needs your input',
      tag: 'codeflare-agent:/app/session/abcdef0123456789',
      renotify: true,
      data: {
        eventId: 'event-a',
        sessionUrl: 'https://codeflare.example/app/session/abcdef0123456789',
      },
    });
  });

  it('REQ-TERM-039 AC3: labels Pi Push completion as ready for input', async () => {
    const pi = loadWorker();
    await dispatchPush(pi.listeners.get('push'), { ...VALID_PUSH, kind: 'task-completed' });
    expect(pi.registration.showNotification).toHaveBeenCalledWith(
      'Pi · Pi #1',
      expect.objectContaining({ body: 'Ready for input' }),
    );
  });

  it('REQ-TERM-039 AC5: keeps Claude Push completion copy task-oriented', async () => {
    const claude = loadWorker();
    await dispatchPush(claude.listeners.get('push'), {
      ...VALID_PUSH,
      kind: 'task-completed',
      agent: 'Claude Code',
      sessionName: 'Claude #1',
    });
    expect(claude.registration.showNotification).toHaveBeenCalledWith(
      'Claude Code · Claude #1',
      expect.objectContaining({ body: 'Task completed' }),
    );
  });

  it('re-shows an at-least-once duplicate visibly with renotify:false', async () => {
    const { listeners, registration } = loadWorker([], [{ data: { eventId: 'event-a' } }]);
    await dispatchPush(listeners.get('push'), VALID_PUSH);

    expect(registration.showNotification).toHaveBeenCalledWith(
      'Pi · Pi #1',
      expect.objectContaining({ renotify: false }),
    );
    expect(registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no data', null],
    ['bad version', { ...VALID_PUSH, v: 2 }],
    ['bad kind', { ...VALID_PUSH, kind: 'arbitrary' }],
    ['absolute URL', { ...VALID_PUSH, sessionPath: 'https://attacker.example/app/session/abcdef0123456789' }],
    ['protocol-relative URL', { ...VALID_PUSH, sessionPath: '//attacker.example/app/session/abcdef0123456789' }],
    ['noncanonical path', { ...VALID_PUSH, sessionPath: '/app/' }],
    ['control name', { ...VALID_PUSH, sessionName: 'bad\nname' }],
    ['unknown agent', { ...VALID_PUSH, agent: 'Attacker' }],
    ['extra field', { ...VALID_PUSH, url: 'https://attacker.example' }],
  ])('silently rejects %s', async (_name, payload) => {
    const { listeners, registration } = loadWorker();
    await dispatchPush(listeners.get('push'), payload);
    expect(registration.showNotification).not.toHaveBeenCalled();
  });

  it('registers no fetch, cache, or sync handlers', () => {
    const { listeners } = loadWorker();
    expect(listeners.has('push')).toBe(true);
    expect(listeners.has('notificationclick')).toBe(true);
    expect(listeners.has('fetch')).toBe(false);
    expect(listeners.has('sync')).toBe(false);
    expect(listeners.has('periodicsync')).toBe(false);
  });
});

describe('REQ-TERM-027 AC3: canonical notification click navigation', () => {
  it('focuses only the existing client at the exact canonical session pathname', async () => {
    const otherFocus = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const { listeners } = loadWorker([
      { url: 'https://codeflare.example/app/session/fedcba9876543210', focus: otherFocus },
      { url: 'https://codeflare.example/app/session/abcdef0123456789?warm=1', focus },
    ]);
    const close = vi.fn();
    let work: Promise<void> | undefined;

    listeners.get('notificationclick')?.({
      notification: {
        data: { eventId: 'event-a', sessionUrl: 'https://codeflare.example/app/session/abcdef0123456789' },
        close,
      },
      waitUntil: (promise: Promise<void>) => { work = promise; },
    });
    await work;

    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(otherFocus).not.toHaveBeenCalled();
  });

  it('opens the canonical session path when no exact client exists', async () => {
    const focus = vi.fn(async () => undefined);
    const { listeners, self } = loadWorker([
      { url: 'https://codeflare.example/app/', focus },
    ]);
    let work: Promise<void> | undefined;

    listeners.get('notificationclick')?.({
      notification: {
        data: { eventId: 'event-a', sessionUrl: 'https://codeflare.example/app/session/abcdef0123456789' },
        close: vi.fn(),
      },
      waitUntil: (promise: Promise<void>) => { work = promise; },
    });
    await work;

    expect(focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith(
      'https://codeflare.example/app/session/abcdef0123456789',
    );
  });

  it('does not focus or open malformed or cross-origin targets', async () => {
    for (const sessionUrl of [
      'https://attacker.example/app/session/abcdef0123456789',
      'https://codeflare.example/app/',
      'not a URL',
    ]) {
      const focus = vi.fn(async () => undefined);
      const { listeners, self } = loadWorker([
        { url: 'https://codeflare.example/app/session/abcdef0123456789', focus },
      ]);
      let work: Promise<void> | undefined;
      listeners.get('notificationclick')?.({
        notification: { data: { eventId: 'event-a', sessionUrl }, close: vi.fn() },
        waitUntil: (promise: Promise<void>) => { work = promise; },
      });
      await work;
      expect(focus).not.toHaveBeenCalled();
      expect(self.clients.openWindow).not.toHaveBeenCalled();
    }
  });
});
