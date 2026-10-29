/** @jsxImportSource react */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionState } from '../upstream/client/src/hooks/useSessionState';
import { useWebSocket } from '../upstream/client/src/hooks/useWebSocket';
import { useThemeContext } from '../upstream/client/src/components/settings/ThemeProvider';
import { EmbedProviders } from '../upstream/client/src/chat-embed/EmbedProviders';
import { DialogPortal } from '../upstream/client/src/components/primitives/DialogPortal';
import { LayerHostProvider } from '@blackbelt-technology/pi-dashboard-client-utils/LayerPortal';
import { DialogPortal as PublicDialogPortal } from '@blackbelt-technology/pi-dashboard-client-utils/DialogPortal';
import { answerQuestion, fetchQuestionDetail, setQuestionTransport } from '../upstream/client/src/lib/questions/questions-api';
import { setGlobalApiBase } from '../upstream/client/src/lib/api/api-context';
import { QuestionStack } from '../upstream/client/src/components/questions/QuestionStack';
import { QuestionStackStore } from '../upstream/client/src/lib/questions/question-store';

// Only the changed embed seams are covered here, not upstream protocol/reducer/UI internals.
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  container?.remove(); root = undefined; container = undefined;
  setQuestionTransport(undefined); setGlobalApiBase('');
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(element: React.ReactNode) {
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(() => root!.render(element));
}
class Wire {
  static OPEN = 1; static instances: Wire[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  frames: string[] = [];
  constructor(public url: string) { Wire.instances.push(this); }
  send(data: string) { this.frames.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

describe('Codeflare host-authenticated upstream embed seams', () => {
  it('uses only the supplied cookie-authenticated URL and reconnects without replaying a handed prompt', async () => {
    vi.useFakeTimers(); Wire.instances = []; vi.stubGlobal('WebSocket', Wire);
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { requests.push(url); throw new Error('unexpected auth endpoint'); });
    let connection: ReturnType<typeof useWebSocket>;
    function Probe() { connection = useWebSocket('wss://cf.test/api/chat/cf/ws?generation=7', undefined, { hostAuthenticated: true }); return <span>{connection.status}</span>; }
    await mount(<Probe />);
    const first = Wire.instances[0];
    expect(first.url).toBe('wss://cf.test/api/chat/cf/ws?generation=7');
    await act(() => { first.readyState = 1; first.onopen?.(); });
    await act(() => { connection.send({ type: 'send_prompt', sessionId: 'bound', text: 'once' }); first.close(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const second = Wire.instances[1];
    await act(() => { second.readyState = 1; second.onopen?.(); });
    expect(container?.textContent).toBe('connected');
    expect(Wire.instances.flatMap(w => w.frames).map(s => JSON.parse(s))).toEqual([{ type: 'send_prompt', sessionId: 'bound', text: 'once' }]);
    expect(requests).toEqual([]);
  });

  it.each([4001, 1008])('stops retrying host auth/policy rejection %s and exposes auth_required', async code => {
    vi.useFakeTimers(); Wire.instances = []; vi.stubGlobal('WebSocket', Wire);
    function Probe() { const c = useWebSocket('wss://cf.test/scoped', undefined, { hostAuthenticated: true }); return <span>{c.status}</span>; }
    await mount(<Probe />);
    await act(() => Wire.instances[0].onclose?.({ code }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(container?.textContent).toBe('auth_required');
    expect(Wire.instances.map(w => w.url)).toEqual(['wss://cf.test/scoped']);
  });

  it('lets upstream session actions write optimistic pending input into the same replay accumulator', async () => {
    let session: ReturnType<typeof useSessionState>;
    function Probe() { session = useSessionState('bound'); return <span>{session.state.pendingPrompt?.status ?? 'none'}</span>; }
    await mount(<Probe />);
    await act(() => session.update(state => ({ ...state, pendingPrompt: { text: 'Continue', status: 'sending' } })));
    expect(container?.textContent).toBe('sending');
    await act(() => session.apply({ type: 'prompt_received', sessionId: 'bound', fresh: true }));
    expect(container?.textContent).toBe('sent');
    await act(() => session.apply({ type: 'session_state_reset', sessionId: 'bound' }));
    expect(container?.textContent).toBe('sent');
  });

  it('accepts a host theme without altering the shell theme or persisting Dashboard preferences', async () => {
    const before = document.documentElement.outerHTML.split('<body')[0];
    const stored = { ...localStorage };
    function Probe() { return <span>{useThemeContext().resolved}</span>; }
    await mount(<EmbedProviders apiBase="/api/chat/cf" theme={{ preference: 'dark', resolved: 'dark', themeName: 'base', setPreference() {}, setThemeName() {} }}><Probe /></EmbedProviders>);
    expect(container?.textContent).toBe('dark');
    expect(document.documentElement.outerHTML.split('<body')[0]).toBe(before);
    expect({ ...localStorage }).toEqual(stored);
  });

  it.each([{ name: 'client shim', Portal: DialogPortal }, { name: 'public client-utils portal', Portal: PublicDialogPortal }])('keeps $name modal content in the presentation host without changing shell scroll ownership', async ({ Portal }) => {
    const host = document.createElement('div'); document.body.append(host);
    const overflow = document.body.style.overflow;
    try {
      await mount(<LayerHostProvider host={host}><Portal><div role="dialog">Scoped question</div></Portal></LayerHostProvider>);
      expect(host.querySelector('[role="dialog"]')?.textContent).toBe('Scoped question');
      expect(document.body.style.overflow).toBe(overflow);
    } finally { host.remove(); }
  });

  it('keeps the question list overlay in the supplied presentation host', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const store = new QuestionStackStore();
    store.set([{ id: 'q1', sessionId: 'bound', sessionLabel: 'Primary', preview: 'Choose next step', type: 'select', askedAt: Date.now(), briefStatus: 'provided' }]);
    try {
      await mount(<LayerHostProvider host={host}><QuestionStack sessions={[]} onOpenSession={() => {}} store={store} /></LayerHostProvider>);
      await act(() => { container?.querySelector('button')?.click(); });
      expect(host.querySelector('[role="region"]')?.textContent).toContain('Choose next step');
    } finally { host.remove(); }
  });

  it('supports a scoped question transport without changing answer bodies or losing HTTP errors', async () => {
    const requests: { url: string; body?: string | null }[] = [];
    setGlobalApiBase('/api/chat/cf');
    setQuestionTransport(async (input, init) => {
      const url = new URL(String(input), 'https://cf.test'); url.searchParams.set('generation', '7');
      requests.push({ url: url.pathname + url.search, body: init?.body as string | undefined });
      return Response.json({ error: 'answered' }, { status: 409 });
    });
    await fetchQuestionDetail('question/1');
    expect(await answerQuestion('question/1', { answer: 'First option' })).toEqual({ ok: false, status: 409, error: 'answered', reason: undefined });
    expect(requests).toEqual([
      { url: '/api/chat/cf/api/questions/question%2F1?generation=7', body: undefined },
      { url: '/api/chat/cf/api/questions/question%2F1/answer?generation=7', body: '{"answer":"First option"}' },
    ]);
  });
});
