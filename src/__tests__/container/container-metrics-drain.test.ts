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
  function makeCtx(token: string | undefined, fetchSpy: ReturnType<typeof vi.fn>) {
    return {
      container: { running: true, getTcpPort: () => ({ fetch: fetchSpy }) },
      storage: { get: vi.fn(async (key: string) => (key === 'containerAuthToken' ? token : undefined)) },
    } as unknown as Parameters<typeof drainFinalSync>[0];
  }

  it('sends the stored container token as a Bearer header on the drain request', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ synced: true }), { status: 200 }));
    await drainFinalSync(makeCtx('tok-idle-789', fetchSpy), 1_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer tok-idle-789');
  });

  it('still drains (headerless) when no token is stored - best-effort, never blocks the stop', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 401 }));
    await expect(drainFinalSync(makeCtx(undefined, fetchSpy), 1_000)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
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
