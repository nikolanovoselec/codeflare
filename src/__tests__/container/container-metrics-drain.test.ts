import { describe, it, expect, vi } from 'vitest';
import { drainAgentEvents, drainFinalSync } from '../../container/container-metrics';

/**
 * The idle/quota-stop final-sync drain talks to the in-container host over a raw
 * port.fetch, which bypasses the DO's public fetch override - the only place the
 * Authorization header is injected. The host 401s any /internal/* request without
 * a Bearer token (auth-check exempts only /health and /activity), so a headerless
 * drain dies at the auth gate in ~100ms on every idle stop and the last edits
 * never reach R2. These tests pin the header to the stored containerAuthToken.
 */
// REQ-SESSION-019: Final-sync drain endpoint authentication
describe('drainFinalSync (idle/quota-stop path) container auth', () => {
  function makeCtx(token?: string) {
    const records = new Map<string, unknown>();
    if (token !== undefined) records.set('containerAuthToken', token);
    const requests: Request[] = [];
    const storage = {
      get: async (key: string): Promise<unknown> => records.get(key),
      put: async (key: string, value: unknown): Promise<void> => { records.set(key, value); },
    };
    const ctx = {
      container: { running: true, getTcpPort: () => ({ fetch: async (url: string, init?: RequestInit) => {
        requests.push(new Request(url, init));
        return Response.json({ synced: true });
      } }) },
      storage,
    } as unknown as Parameters<typeof drainFinalSync>[0];
    return { ctx, storage, requests };
  }

  it('sends the stored container token as a Bearer header on the drain request', async () => {
    const f = makeCtx('tok-idle-789');
    await drainFinalSync(f.ctx, 1_000);
    // Intentional internal-request authentication contract, not mock calls.
    expect(f.requests.map(request => ({ method: request.method, url: request.url,
      authorization: request.headers.get('Authorization') }))).toEqual([
      { method: 'POST', url: 'http://localhost/internal/final-sync', authorization: 'Bearer tok-idle-789' },
    ]);
  });

  it.each(['absent', 'empty', 'unreadable'] as const)('REQ-SESSION-019 AC1: %s credentials suppress the request and retain a bounded audit', async kind => {
    const f = makeCtx(kind === 'empty' ? '' : undefined);
    if (kind === 'unreadable') {
      const get = f.storage.get;
      f.storage.get = async key => { if (key === 'containerAuthToken') throw new Error('Token storage unavailable'); return get(key); };
    }
    const began = Date.now();
    await expect(drainFinalSync(f.ctx, 1_000)).resolves.toBeUndefined();
    expect(f.requests).toEqual([]);
    const audit = await f.storage.get('finalSyncAudit') as { at: number };
    expect(audit).toMatchObject({ outcome: 'errored', running: true,
      reason: kind === 'unreadable' ? 'auth-token-unavailable' : 'missing-auth-token' });
    expect(audit.at).toBeGreaterThanOrEqual(began);
    expect(audit.at).toBeLessThanOrEqual(began + 1_000);
  });

  it.each(['rejected', 'pending'] as const)('REQ-SESSION-019 AC1: %s audit storage cannot wedge the best-effort drain', async failure => {
    vi.useFakeTimers();
    try {
      const f = makeCtx();
      f.storage.put = async () => {
        if (failure === 'rejected') throw new Error('Audit unavailable');
        return new Promise<void>(() => {});
      };
      const pending = drainFinalSync(f.ctx, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeUndefined();
      expect(f.requests).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('REQ-SESSION-019 AC1: a late credential read cannot issue a request after the drain budget', async () => {
    vi.useFakeTimers();
    try {
      const f = makeCtx();
      let release!: (token: string) => void;
      const token = new Promise<string>(resolve => { release = resolve; });
      const get = f.storage.get;
      f.storage.get = key => key === 'containerAuthToken' ? token : get(key);
      const pending = drainFinalSync(f.ctx, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeUndefined();
      release('late-token');
      await Promise.resolve();
      await Promise.resolve();
      expect(f.requests).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('REQ-SEC-022 AC5 / D1: agent-event raw-port drain authentication', () => {
  function makeCtx(token: string | undefined, fetchSpy: ReturnType<typeof vi.fn>) {
    return {
      container: { running: true, getTcpPort: () => ({ fetch: fetchSpy }) },
      storage: { get: vi.fn(async (key: string) => (key === 'containerAuthToken' ? token : undefined)) },
    } as unknown as Parameters<typeof drainAgentEvents>[0];
  }

  it('POSTs the exact request with the stored lifecycle Bearer and bounded signal', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      hostNow: 1_700_000_000_000,
      events: [],
    }), { status: 200 }));

    const result = await drainAgentEvents(makeCtx('agent-token-123', fetchSpy), 1_000, {
      ackEventIds: ['event-sent'],
      final: true,
    });

    expect(result).toEqual({ hostNow: 1_700_000_000_000, events: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost/internal/agent-events/drain');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer agent-token-123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ ackEventIds: ['event-sent'], final: true });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails closed without issuing a headerless internal request when the token is absent', async () => {
    const fetchSpy = vi.fn();
    const result = await drainAgentEvents(makeCtx(undefined, fetchSpy), 1_000, { ackEventIds: [] });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on 401, invalid JSON, or transport failure without throwing into metrics', async () => {
    for (const response of [
      () => Promise.resolve(new Response(null, { status: 401 })),
      () => Promise.resolve(new Response('{bad-json', { status: 200 })),
      () => Promise.reject(new Error('transport failed')),
    ]) {
      const fetchSpy = vi.fn(response);
      await expect(drainAgentEvents(makeCtx('tok', fetchSpy), 10, { ackEventIds: [] })).resolves.toBeNull();
    }
  });
});
