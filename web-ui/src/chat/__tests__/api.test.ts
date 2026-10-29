import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachChatSession } from '../api';

afterEach(() => vi.unstubAllGlobals());
describe('REQ-AGENT-224 explicit primary entry shared HTTP attachment', () => {
  it('returns the bound upstream identity to either explicit surface caller using the same exact POST contract', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push(new Request(new URL(url, window.location.origin), init));
      return Response.json({ sessionId: 'upstream-primary', generation: 7 });
    });
    expect(await attachChatSession('cf/session', 7)).toEqual({ sessionId: 'upstream-primary', generation: 7 });
    expect(requests.map(r => [new URL(r.url).pathname, r.method])).toEqual([['/api/chat/cf%2Fsession/attach', 'POST']]);
    expect(await requests[0].json()).toEqual({ generation: 7 });
  });
  it('preserves HTTP status for root auth/lifecycle handling', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Session expired' }, { status: 401 }));
    await expect(attachChatSession('cf', 7)).rejects.toMatchObject({ status: 401, message: 'Session expired' });
  });
});
