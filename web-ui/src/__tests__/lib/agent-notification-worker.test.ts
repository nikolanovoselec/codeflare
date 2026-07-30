import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(new URL('../../../public/agent-notifications-sw.js', import.meta.url), 'utf8');

function loadWorker(clients: Array<{ url: string; focus: () => Promise<void> }>) {
  const listeners = new Map<string, (event: any) => void>();
  const self = {
    location: { origin: 'https://codeflare.example' },
    clients: { matchAll: vi.fn(async () => clients) },
    addEventListener: vi.fn((type: string, listener: (event: any) => void) => listeners.set(type, listener)),
  };
  runInNewContext(workerSource, { self, URL });
  return { listeners, self };
}

describe('agent notification service worker / REQ-TERM-023', () => {
  it('focuses an existing same-origin client selected by a notification click', async () => {
    const focus = vi.fn(async () => undefined);
    const { listeners } = loadWorker([
      { url: 'https://codeflare.example/session', focus },
    ]);
    const close = vi.fn();
    let work: Promise<void> | undefined;

    listeners.get('notificationclick')?.({
      notification: { data: { sessionUrl: 'https://codeflare.example/session#terminal' }, close },
      waitUntil: (promise: Promise<void>) => { work = promise; },
    });
    await work;

    expect(close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('does not focus a cross-origin client or open a new window', async () => {
    const focus = vi.fn(async () => undefined);
    const { listeners, self } = loadWorker([
      { url: 'https://attacker.example/session', focus },
    ]);
    let work: Promise<void> | undefined;

    listeners.get('notificationclick')?.({
      notification: { data: { sessionUrl: 'https://attacker.example/session' }, close: vi.fn() },
      waitUntil: (promise: Promise<void>) => { work = promise; },
    });
    await work;

    expect(focus).not.toHaveBeenCalled();
    expect(self.clients.matchAll).not.toHaveBeenCalled();
    expect((self.clients as any).openWindow).toBeUndefined();
  });
});
