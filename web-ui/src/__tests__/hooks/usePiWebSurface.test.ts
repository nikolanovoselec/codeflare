import { createRoot } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createPiWebSurface } from '../../hooks/usePiWebSurface';
import type { PiWebStatus } from '../../api/pi-web';

const sessionId = 'abcdef1234567890';
const generation = 7;
const base = `/api/pi-web/${sessionId}/`;

afterEach(() => vi.unstubAllGlobals());

function fixture(send: (action: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  let next: PiWebStatus = { phase: 'active', surface: 'terminal' };
  const mutations: Array<{ action: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === `${base}_switch?generation=${generation}` && !init.method) return Response.json(next);
    expect(url.startsWith(base)).toBe(true);
    expect(init.credentials).toBe('same-origin');
    const action = url.slice(base.length);
    const body = JSON.parse(String(init.body));
    mutations.push({ action, body });
    return send(action, body);
  });
  return createRoot(dispose => ({ observer: createPiWebSurface(sessionId, generation), dispose, mutations,
    status(value: PiWebStatus) { next = value; return Response.json(value); },
  }));
}

it('observes passively, offers cancellation only for the waiting attempt, and sends its exact identity', async () => {
  const f = fixture((action, body): Response => f.status({ surface: 'terminal', target: 'chat',
    phase: action === '_cancel' ? 'cancelled' : 'waiting', requestId: body.requestId as string }));
  const { observer, mutations } = f;
  try {
    await vi.waitFor(() => expect(observer.status()?.phase).toBe('active'));
    observer.cancel();
    observer.select('terminal');
    expect(mutations).toEqual([]);
    observer.select('chat');
    observer.select('chat');
    await vi.waitFor(() => expect(observer.status()?.phase).toBe('waiting'));
    const id = observer.status()?.requestId;
    expect(mutations).toEqual([{ action: '_switch', body: { generation, requestId: id, target: 'chat' } }]);
    observer.cancel();
    await vi.waitFor(() => expect(observer.status()?.phase).toBe('cancelled'));
    expect(mutations[1]).toEqual({ action: '_cancel', body: { generation, requestId: id } });
    expect(observer.canRetry()).toBe(false);
  } finally { f.dispose(); }
});

it('retries a failed opening of Chat with the original target and request, then observes the confirmed writer', async () => {
  const f = fixture((_, body): Response => f.status({ surface: f.mutations.length === 1 ? null : 'chat', target: 'chat',
    phase: f.mutations.length === 1 ? 'failed' : 'complete', requestId: body.requestId as string }));
  const { observer, mutations } = f;
  try {
    await vi.waitFor(() => expect(observer.status()?.phase).toBe('active'));
    observer.select('chat');
    await vi.waitFor(() => expect(observer.canRetry()).toBe(true));
    observer.select('terminal');
    expect(mutations).toHaveLength(1);
    observer.retry();
    await vi.waitFor(() => expect(observer.status()?.surface).toBe('chat'));
    expect(mutations).toEqual([mutations[0], mutations[0]]);
    expect(observer.canRetry()).toBe(false);
  } finally { f.dispose(); }
});

it.each([[409, 'The Pi switch was not accepted.', false], [503, 'Could not confirm the switch.', true]] as const)(
  'distinguishes rejected and unconfirmed switch outcomes (HTTP %s)', async (status, message, retryable) => {
    const f = fixture(() => Response.json({ error: 'fixture failure' }, { status }));
    const { observer, mutations } = f;
    try {
      await vi.waitFor(() => expect(observer.status()?.surface).toBe('terminal'));
      observer.select('chat');
      await vi.waitFor(() => expect(observer.mutationError()).toBe(message));
      expect(observer.canRetry()).toBe(retryable);
      observer.retry();
      expect(mutations).toHaveLength(retryable ? 2 : 1);
      if (retryable) expect(mutations[1]).toEqual(mutations[0]);
    } finally { f.dispose(); }
  },
);

it('explains restore-blocked Terminal switching and keeps Chat active', async () => {
  const f = fixture(() => Response.json({ error: 'blocked', code: 'PI_REPOSITORY_RESTORE_PENDING' }, { status: 409 }));
  try {
    f.status({ phase: 'complete', surface: 'chat' });
    await vi.waitFor(() => expect(f.observer.status()?.surface).toBe('chat'));
    f.observer.select('terminal');
    await vi.waitFor(() => expect(f.observer.mutationError()).toBe('Wait for repository restore, then try again.'));
    expect(f.observer.status()?.surface).toBe('chat');
    expect(f.observer.canRetry()).toBe(false);
  } finally { f.dispose(); }
});
