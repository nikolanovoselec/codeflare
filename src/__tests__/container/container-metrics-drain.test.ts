import { describe, it, expect, vi } from 'vitest';
import { drainFinalSync } from '../../container/container-metrics';

/**
 * The idle/quota-stop final-sync drain talks to the in-container host over a raw
 * port.fetch, which bypasses the DO's public fetch override - the only place the
 * Authorization header is injected. The host 401s any /internal/* request without
 * a Bearer token (auth-check exempts only /health and /activity), so a headerless
 * drain dies at the auth gate in ~100ms on every idle stop and the last edits
 * never reach R2. These tests pin the header to the stored containerAuthToken.
 */
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
