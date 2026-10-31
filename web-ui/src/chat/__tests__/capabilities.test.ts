import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import { createComponent, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMountProps } from '../ChatMount';
import ChatArea from '../../components/ChatArea';

// Public Solid → React ownership port only; no imported widget behavior.
vi.mock('../ChatMount', () => ({
  mountChat(container: HTMLElement, initial: ChatMountProps) {
    const output = document.createElement('output');
    output.setAttribute('aria-label', 'Mounted Chat binding'); container.append(output);
    const update = (props: ChatMountProps) => { output.textContent = JSON.stringify({
      boundSessionId: props.boundSessionId, generation: props.generation,
      controlsAvailable: props.controlsAvailable, draft: props.draft,
    }); };
    update(initial);
    return { update, dispose() { output.remove(); } };
  },
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const scope = { sessionId: 'cf-primary', generation: 7, boundSessionId: 'native-primary' };
function install(respond: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(input instanceof Request ? input.url : String(input), window.location.origin), init);
    requests.push(request); return respond(request);
  });
  return requests;
}
function mounted() { return JSON.parse(screen.getByRole('status', { name: 'Mounted Chat binding' }).textContent!); }

describe('REQ-AGENT-224 release compatibility: protected pre-mount capability probe', () => {
  it.each([
    { status: 200, body: { success: true, data: { controls: true } }, available: true },
    { status: 404, body: { error: 'Not found' }, available: false },
    { status: 503, body: { error: 'Runtime unavailable' }, available: false },
    { status: 200, body: { success: true, data: { controls: false } }, available: false },
    { status: 200, body: { success: true, data: { controls: 'true' } }, available: false },
    { status: 200, body: { controls: true }, available: false },
  ])('passes controls=$available for HTTP $status without another attach', async ({ status, body, available }) => {
    const requests = install(async () => Response.json(body, { status }));
    render(() => createComponent(ChatArea, { ...scope, draft: 'Keep my draft' }));
    await waitFor(() => expect(mounted()).toEqual({ boundSessionId: 'native-primary', generation: 7, controlsAvailable: available, draft: 'Keep my draft' }));
    expect(requests.map(request => [new URL(request.url).pathname, request.method])).toEqual([
      ['/api/chat/cf-primary/api/capabilities', 'GET'],
    ]);
    expect(new URL(requests[0].url).searchParams.get('generation')).toBe('7');
    expect(requests[0].credentials).toBe('same-origin');
  });

  it('attaches only once when no binding was supplied, then probes before mounting', async () => {
    let finish!: (response: Response) => void;
    const requests = install(async request => new URL(request.url).pathname.endsWith('/attach')
      ? Response.json({ sessionId: 'confirmed-primary', generation: 7 })
      : new Promise<Response>(resolve => { finish = resolve; }));
    render(() => createComponent(ChatArea, { sessionId: scope.sessionId, generation: 7 }));
    await waitFor(() => expect(requests.map(request => request.method)).toEqual(['POST', 'GET']));
    expect(screen.queryByRole('status', { name: 'Mounted Chat binding' })).toBeNull();
    finish(Response.json({ success: true, data: { controls: true } }));
    await waitFor(() => expect(mounted().boundSessionId).toBe('confirmed-primary'));
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/api/chat/cf-primary/attach', '/api/chat/cf-primary/api/capabilities',
    ]);
    expect(await requests[0].json()).toEqual({ generation: 7 });
  });

  it.each([401, 403, 409])('fails closed on probe authority rejection %s even with a supplied binding', async status => {
    let authError = '';
    install(async () => Response.json({ error: 'Chat authority rejected' }, { status }));
    render(() => createComponent(ChatArea, { ...scope, onAuthError: message => { authError = message; } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chat authority rejected');
    expect(screen.queryByRole('status', { name: 'Mounted Chat binding' })).toBeNull();
    expect(authError).toBe('Chat authority rejected');
  });

  it('does not mount on an unexpected probe server failure', async () => {
    install(async () => Response.json({ error: 'Probe failed' }, { status: 500 }));
    render(() => createComponent(ChatArea, scope));
    expect(await screen.findByRole('alert')).toHaveTextContent('Probe failed');
    expect(screen.queryByRole('status', { name: 'Mounted Chat binding' })).toBeNull();
  });

  it('retains base Chat when the probe is unavailable on the network', async () => {
    install(async () => { throw new TypeError('Network unavailable'); });
    render(() => createComponent(ChatArea, scope));
    await waitFor(() => expect(mounted().controlsAvailable).toBe(false));
  });

  it('discards generation-stale probe results and does not attach an already bound replacement', async () => {
    let finishOld!: (response: Response) => void;
    const requests = install(async request => new URL(request.url).searchParams.get('generation') === '7'
      ? new Promise<Response>(resolve => { finishOld = resolve; })
      : Response.json({ success: true, data: { controls: false } }));
    const [generation, setGeneration] = createSignal(7);
    render(() => createComponent(ChatArea, { sessionId: scope.sessionId,
      get generation() { return generation(); }, get boundSessionId() { return `native-${generation()}`; } }));
    await waitFor(() => expect(requests).toHaveLength(1));
    setGeneration(8);
    await waitFor(() => expect(mounted()).toMatchObject({ boundSessionId: 'native-8', generation: 8, controlsAvailable: false }));
    finishOld(Response.json({ success: true, data: { controls: true } }));
    await Promise.resolve(); await Promise.resolve();
    expect(mounted()).toMatchObject({ boundSessionId: 'native-8', generation: 8, controlsAvailable: false });
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('aborts the probe on unmount and ignores its late successful response', async () => {
    let finish!: (response: Response) => void;
    const requests = install(() => new Promise<Response>(resolve => { finish = resolve; }));
    const view = render(() => createComponent(ChatArea, scope));
    await waitFor(() => expect(requests).toHaveLength(1));
    view.unmount();
    finish(Response.json({ success: true, data: { controls: true } }));
    await Promise.resolve(); await Promise.resolve();
    expect(requests[0].signal.aborted).toBe(true);
    expect(screen.queryByRole('status', { name: 'Mounted Chat binding' })).toBeNull();
  });
});
