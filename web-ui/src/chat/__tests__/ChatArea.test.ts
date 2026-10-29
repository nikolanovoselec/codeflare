import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import { createComponent } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatArea from '../../components/ChatArea';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('REQ-AGENT-224 Codeflare explicit Chat attachment boundary', () => {
  it('attaches with exactly the numeric generation and reports an expired login without opening a socket', async () => {
    const requests: Request[] = [];
    const connections: string[] = [];
    let authError = '';
    vi.stubGlobal('WebSocket', class { constructor(url: string) { connections.push(url); } });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      requests.push(new Request(new URL(input, window.location.origin), init));
      return Response.json({ error: 'Session expired' }, { status: 401 });
    });
    render(() => createComponent(ChatArea, { sessionId: 'cf-primary', generation: 7, onAuthError: message => { authError = message; } }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/session expired/i);
    expect(requests.map(r => [new URL(r.url).pathname, r.method])).toEqual([['/api/chat/cf-primary/attach', 'POST']]);
    expect(await requests[0].json()).toEqual({ generation: 7 });
    expect(authError).toMatch(/session expired/i);
    expect(connections).toEqual([]);
  });

  it.each([
    { sessionId: 'bound-primary', generation: 8 },
    { sessionId: '', generation: 7 },
    { sessionId: 'bound-primary', generation: '7' },
  ])('fails closed on an invalid/stale binding response %j', async binding => {
    const connections: string[] = [];
    vi.stubGlobal('WebSocket', class { constructor(url: string) { connections.push(url); } });
    vi.stubGlobal('fetch', async () => Response.json(binding));
    render(() => createComponent(ChatArea, { sessionId: 'cf-primary', generation: 7 }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/binding|generation/i);
    expect(connections).toEqual([]);
  });

  it('discards a late attach response after the surface is disposed', async () => {
    let resolve!: (r: Response) => void;
    let signal: AbortSignal | undefined;
    const connections: string[] = [];
    vi.stubGlobal('WebSocket', class { constructor(url: string) { connections.push(url); } });
    vi.stubGlobal('fetch', (_input: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(r => { resolve = r; });
    });
    const view = render(() => createComponent(ChatArea, { sessionId: 'cf-primary', generation: 7 }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    resolve(Response.json({ sessionId: 'bound-primary', generation: 7 }));
    await Promise.resolve(); await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(connections).toEqual([]);
  });
});
