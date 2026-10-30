import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent as solidEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { act } from 'react';
import { For } from 'solid-js';
// Resolve the real React dependency before any interaction query deadline.
import '../../chat/ChatMount';
import Layout from '../../components/Layout';
import { sessionStore } from '../../stores/session';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';
import { terminalStore } from '../../stores/terminal';
import type { Session } from '../../types';

// These are shell composition tests, not tests of xterm, imported ChatView,
// question widgets, or Dashboard cards. Keep real Layout/Header/TerminalArea,
// session/workspace stores, Chat mount and HTTP client. Only heavyweight sibling
// views are replaced. The terminal fixture exposes mounted ownership; native
// PTY/socket disposal remains covered by the existing Terminal suites.
vi.mock('../../components/Terminal', () => ({ default: (props: any) => {
  // Public attachment contract at the heavyweight renderer boundary, not a
  // private call-count assertion. Real URL forwarding is covered by the store suite.
  const url = new URL(`/api/terminal/${props.sessionId}-${props.terminalId}/ws`, window.location.origin);
  if (props.takePrimaryHandoff?.()) url.searchParams.set('primary', '1');
  return <section aria-label={`Terminal ${props.sessionId} ${props.terminalId}`}>
    <a href={url.href}>Terminal attachment</a>
  </section>;
} }));
vi.mock('../../components/Dashboard', () => ({ default: (props: any) =>
  <section aria-label="Session dashboard"><For each={props.sessions}>{(session: Session) => <>
    <button onClick={() => props.onOpenSessionById(session.id)}>Select {session.name}</button>
    <button onClick={() => props.onOpenChatSession?.(session.id)}>Open {session.name} in Chat</button>
    <button onClick={() => props.onOpenTerminalSession?.(session.id)}>Open {session.name} in Terminal</button>
  </>}</For></section> }));
vi.mock('../../components/SplashCursor', () => ({ default: () => null }));
vi.mock('../../components/SettingsPanel', () => ({ default: () => null }));
vi.mock('../../components/StoragePanel', () => ({ default: () => null }));

// Network boundary only. The frame collector asserts Codeflare's routing, not
// upstream reducer behavior. No mocked Chat component or new session framework.
class ChatWire extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static wires: ChatWire[] = [];
  readyState = ChatWire.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  frames: Record<string, unknown>[] = [];
  constructor(public url: string | URL) {
    super(); ChatWire.wires.push(this);
    queueMicrotask(() => {
      if (this.readyState !== ChatWire.CONNECTING) return;
      this.readyState = ChatWire.OPEN;
      const event = new Event('open'); this.onopen?.(event); this.dispatchEvent(event);
    });
  }
  send(data: string) { this.frames.push(JSON.parse(data)); }
  receive(message: Record<string, unknown>) {
    const event = new MessageEvent('message', { data: JSON.stringify(message) });
    this.onmessage?.(event); this.dispatchEvent(event);
  }
  close(code = 1000, reason = '') {
    this.readyState = ChatWire.CLOSED;
    const event = new CloseEvent('close', { code, reason });
    this.onclose?.(event); this.dispatchEvent(event);
  }
}

const fireEvent = {
  click: async (...args: Parameters<typeof solidEvent.click>) => { await act(async () => { solidEvent.click(...args); }); },
  change: async (...args: Parameters<typeof solidEvent.change>) => { await act(async () => { solidEvent.change(...args); }); },
  input: async (...args: Parameters<typeof solidEvent.input>) => { await act(async () => { solidEvent.input(...args); }); },
};

const firstId = 'abcdef0123456789';
const secondId = 'fedcba9876543210';
const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: firstId, name: 'Primary Pi', agentType: 'pi', workspace: 'terminal',
  terminalMode: 'classic', status: 'running', generation: 7, revision: 1,
  createdAt: '2026-10-29T00:00:00Z', lastAccessedAt: '2026-10-29T00:00:00Z',
  tabConfig: [{ id: '1', command: 'pi', label: 'Pi' }, { id: '2', command: 'bash', label: 'Shell' }],
  ...overrides,
});

describe('Codeflare session-local Chat composition', () => {
  let sessions: Session[];
  let preferences: { sessionMode: 'default' | 'advanced'; defaultWorkspace: 'terminal' | 'vscode' };
  let requests: Request[];
  let attachStatus: number;
  let attachFailure: { error: string; code?: string };
  let releaseAttach: (() => void) | undefined;
  let deferAttach: boolean;
  let expiredPolling: boolean;
  const viewport = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  beforeEach(async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    await act(async () => { cleanup(); });
    sessionStore.stopAllPolling();
    sessionStore.stopSessionListPolling();
    sessionStore._resetAuthExpired();
    sessionStore.setActiveSession(null);
    terminalWorkspaceStore.setDashboardWorkspace();
    localStorage.setItem('codeflare:normal-view', 'terminal');
    sessions = [];
    preferences = { sessionMode: 'advanced', defaultWorkspace: 'terminal' };
    requests = [];
    attachStatus = 200;
    attachFailure = { error: 'Session expired', code: 'AUTH_FAILED' };
    releaseAttach = undefined;
    deferAttach = false;
    expiredPolling = false;
    ChatWire.wires = [];
    vi.stubGlobal('WebSocket', ChatWire);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.origin), init);
      requests.push(request.clone());
      const path = new URL(request.url).pathname;
      if (request.method === 'DELETE' && /^\/api\/sessions\/[a-f0-9]{16}$/.test(path)) {
        sessions = sessions.filter(session => session.id !== path.split('/')[3]);
        return Response.json({ success: true });
      }
      if (path === '/api/sessions') return Response.json({ sessions });
      if (path === '/api/preferences') return Response.json(preferences);
      if (path === '/api/sessions/batch-status' && expiredPolling) return Response.json({ error: 'Session expired' }, { status: 401 });
      if (path === '/api/sessions/batch-status') return Response.json({ statuses: Object.fromEntries(sessions.map(s => [s.id, {
        status: s.status, generation: s.generation, revision: s.revision,
      }])) });
      if (path === '/api/sessions/ancillary-status') return Response.json({ maxSessions: 3 });
      if (path.endsWith('/attach')) {
        const sessionId = path.split('/')[3];
        const generation = sessions.find(session => session.id === sessionId)?.generation;
        if (deferAttach) await new Promise<void>(resolve => { releaseAttach = resolve; });
        return Response.json(attachStatus === 200
          ? { sessionId: 'bound-primary-pi', generation }
          : attachFailure, { status: attachStatus });
      }
      if (path.includes('gravatar')) return new Response(null, { status: 404 });
      return new Response('{}', { status: 404 });
    });
    // A missing KV-list row cannot revoke a locally owned lifecycle. Delete the
    // prior disposable sessions through the public boundary before reusing IDs.
    await act(async () => {
      for (const session of [...sessionStore.sessions]) await sessionStore.deleteSession(session.id);
    });
    requests = [];
    sessions = [makeSession()];
    await act(async () => { await sessionStore.loadSessions(); });
    await sessionStore.loadPreferences();
    window.history.replaceState(null, '', '/app/');
  });
  afterEach(async () => {
    await act(async () => {
      cleanup(); terminalStore.disposeAll(); sessionStore.stopAllPolling(); sessionStore.stopSessionListPolling(); sessionStore.setActiveSession(null);
      terminalWorkspaceStore.setDashboardWorkspace();
    });
    // Dispose fixture-owned resize callbacks before restoring the browser globals.
    vi.clearAllTimers();
    vi.useRealTimers();
    if (viewport) Object.defineProperty(window, 'innerWidth', viewport);
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  async function renderLayout() {
    await act(async () => { render(() => <Layout userName="owner@example.test" />); });
    await waitFor(() => expect(sessionStore.loading).toBe(false));
    await screen.findByRole('region', { name: 'Session dashboard' });
  }
  async function openTerminalSession() {
    await renderLayout();
    await fireEvent.click(await screen.findByRole('button', { name: 'Select Primary Pi' }));
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
  }
  async function chooseView(value: string) {
    await fireEvent.change(await screen.findByRole('combobox', { name: 'View' }), { target: { value } });
  }
  async function enterChat() {
    await chooseView('chat');
    return screen.findByRole('textbox');
  }
  const attachRequests = () => requests.filter(r => new URL(r.url).pathname.endsWith('/attach'));
  const openWires = () => ChatWire.wires.filter(w => w.readyState === ChatWire.OPEN);

  it.each([null, 'invalid', 'vscode-unavailable'] as const)('REQ-AGENT-224: fresh or invalid Normal preference %s opens usable Chat', async value => {
    if (value === null) localStorage.removeItem('codeflare:normal-view');
    else localStorage.setItem('codeflare:normal-view', value);
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    expect(await screen.findByRole('textbox')).toBeEnabled();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(sessionStore.getActiveSession()).toMatchObject({ workspace: 'terminal', generation: 7 });
    expect(requests.filter(r => new URL(r.url).pathname === '/api/preferences' && r.method !== 'GET')).toEqual([]);
  });

  it('REQ-AGENT-224: unavailable remembered VS Code falls back to Chat for Standard Pi', async () => {
    localStorage.setItem('codeflare:normal-view', 'vscode');
    preferences.sessionMode = 'default'; await sessionStore.loadPreferences();
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    expect(await screen.findByRole('textbox')).toBeEnabled();
    expect(screen.queryByRole('option', { name: 'VS Code' })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-224: denied browser storage still permits Chat-first entry and switching', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    expect(await screen.findByRole('textbox')).toBeEnabled();
    await chooseView('terminal');
    expect(await screen.findByRole('region', { name: `Terminal ${firstId} 1` })).toBeInTheDocument();
  });

  it('REQ-AGENT-224: remembered Terminal opens without Chat attachment on a fresh shell', async () => {
    await openTerminalSession();
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveValue('terminal');
    expect(attachRequests()).toEqual([]);
  });

  it('REQ-AGENT-224: remembered VS Code opens externally without restamping a Normal session', async () => {
    localStorage.setItem('codeflare:normal-view', 'vscode');
    const opened = { closed: false, opener: {}, focus() {} };
    const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(`/api/vscode/${firstId}/`, `codeflare-vscode-${firstId}`));
    expect(sessionStore.getActiveSession()).toMatchObject({ workspace: 'terminal', generation: 7 });
    expect(sessionStore.preferences.defaultWorkspace).toBe('terminal');
    expect(opened.opener).toBeNull();
  });

  it('REQ-AGENT-224: blocked external View keeps the Chat draft and reports the popup failure', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Keep this draft' } });
    await chooseView('vscode');
    expect(await screen.findByText(/pop.?up.*block|allow.*pop.?up/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
    expect(sessionStore.getActiveSession()?.workspace).toBe('terminal');
  });

  it.each([undefined, 'claude-code', 'codex', 'bash'] as const)('REQ-AGENT-224: configured primary Pi exposes working Chat when the legacy creation agent is %s', async agentType => {
    sessions = [makeSession({ agentType })];
    await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession();
    const input = await enterChat();
    await fireEvent.input(input, { target: { value: 'Continue the configured primary' } });
    await fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    await waitFor(() => expect(openWires().some(w => w.frames.some(frame =>
      frame.type === 'send_prompt' && frame.sessionId === 'bound-primary-pi'
      && frame.text === 'Continue the configured primary'))).toBe(true));
    expect(sessionStore.getActiveSession()?.agentType).toBe(agentType);
    expect(sessionStore.getActiveSession()?.tabConfig?.[0].command).toBe('pi');
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: failed Chat attachment preserves the mounted %s Terminal and permits retry', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession();
    const terminal = screen.getByRole('region', { name: `Terminal ${firstId} 1` });
    const path = window.location.pathname;
    attachStatus = 404;
    attachFailure = { error: 'Not found' };
    await chooseView('chat');
    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: `Terminal ${firstId} 1` })).toBe(terminal);
    expect(screen.queryByRole('region', { name: 'Pi Chat' })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    await chooseView('terminal');
    expect(screen.getByRole('region', { name: `Terminal ${firstId} 1` })).toBe(terminal);
    expect(window.location.pathname).toBe(path);
    expect(sessionStore.getActiveSession()).toMatchObject({ workspace: 'terminal', terminalMode, generation: 7 });
    attachStatus = 200;
    await enterChat();
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(requests.filter(r => !['GET', 'HEAD'].includes(r.method) && !new URL(r.url).pathname.endsWith('/attach'))).toEqual([]);
  });

  it.each([
    { status: 404, body: { error: 'Session not found', code: 'SESSION_NOT_FOUND' } },
    { status: 503, body: { error: 'Chat Host unavailable' } },
  ])('REQ-AGENT-224: rejected Chat entry ($status) keeps the dashboard and does not select a fallback session', async ({ status, body }) => {
    sessions = [makeSession()]; await act(async () => { await sessionStore.loadSessions(); });
    await renderLayout();
    attachStatus = status;
    attachFailure = body;
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Chat' }));
    expect(await screen.findByText(body.error)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument();
    expect(sessionStore.activeSessionId).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pi Chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    expect(requests.filter(r => !['GET', 'HEAD'].includes(r.method) && !new URL(r.url).pathname.endsWith('/attach'))).toEqual([]);
  });

  it('REQ-AGENT-224: Chat entry retains Terminal ownership until its primary binding is confirmed', async () => {
    await openTerminalSession();
    const terminal = screen.getByRole('region', { name: `Terminal ${firstId} 1` });
    deferAttach = true;
    await chooseView('chat');
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    expect(screen.getByRole('region', { name: `Terminal ${firstId} 1` })).toBe(terminal);
    expect(screen.queryByRole('region', { name: 'Pi Chat' })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    deferAttach = false;
    await act(async () => { releaseAttach!(); });
    await screen.findByRole('textbox');
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    // One explicit-entry handshake is the wire contract: rendering the confirmed
    // binding must not initiate another primary-adoption request.
    expect(attachRequests().map(r => new URL(r.url).pathname)).toEqual([`/api/chat/${firstId}/attach`]);
  });

  it('REQ-AGENT-224: Chat-first pending entry keeps Terminal selectable as a distinct native choice', async () => {
    localStorage.removeItem('codeflare:normal-view');
    deferAttach = true;
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    const terminal = screen.getByRole('region', { name: `Terminal ${firstId} 1` });
    // The native picker must actually differ from Terminal before selecting it:
    // browsers do not emit change when users choose the already selected option.
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveValue('chat');
    const finishChatEntry = releaseAttach!;
    await chooseView('terminal');
    await act(async () => { finishChatEntry(); });
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveValue('terminal');
    expect(screen.getByRole('region', { name: `Terminal ${firstId} 1` })).toBe(terminal);
    expect(screen.queryByRole('region', { name: 'Pi Chat' })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
  });

  it('REQ-AGENT-224: choosing the visible Terminal cancels pending Chat entry even if its response arrives late', async () => {
    await openTerminalSession();
    const terminal = screen.getByRole('region', { name: `Terminal ${firstId} 1` });
    deferAttach = true;
    await chooseView('chat');
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    const finishChatEntry = releaseAttach!;
    await chooseView('terminal');
    await act(async () => { finishChatEntry(); });
    expect(await screen.findByRole('region', { name: `Terminal ${firstId} 1` })).toBe(terminal);
    expect(screen.queryByRole('region', { name: 'Pi Chat' })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    expect(window.location.pathname).toBe(`/app/session/${firstId}`);
  });

  it('REQ-AGENT-224: a generation change during pending Chat entry cannot select or attach the replacement primary', async () => {
    await openTerminalSession();
    deferAttach = true;
    await chooseView('chat');
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    sessions = [makeSession({ generation: 8, revision: 2 })];
    await act(async () => { await sessionStore.loadSessions(); });
    await act(async () => { releaseAttach!(); });
    expect(screen.getByRole('region', { name: `Terminal ${firstId} 1` })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pi Chat' })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    expect(sessionStore.getActiveSession()?.generation).toBe(8);
    expect(await Promise.all(attachRequests().map(r => r.json()))).toEqual([{ generation: 7 }]);
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: %s surface switches unmount hidden ownership without stopping or restamping the session', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession();
    const selected = sessionStore.getActiveSession()!;
    const stamp = { workspace: selected.workspace, terminalMode: selected.terminalMode, generation: selected.generation };
    const path = window.location.pathname;
    await enterChat();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    await waitFor(() => expect(openWires().some(w => String(w.url).includes(`/api/chat/${firstId}/ws`))).toBe(true));
    await chooseView('terminal');
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toEqual([]);
    expect(sessionStore.getActiveSession()).toMatchObject(stamp);
    expect(window.location.pathname).toBe(path);
    expect(requests.filter(r => !['GET', 'HEAD'].includes(r.method) && !new URL(r.url).pathname.endsWith('/attach'))).toEqual([]);
  });

  it('REQ-AGENT-224: Chat on a secondary classic tab returns to primary without resetting tab order or tiling', async () => {
    await openTerminalSession();
    sessionStore.addTerminalTab(firstId);
    sessionStore.setActiveTerminalTab(firstId, '2');
    sessionStore.setTilingLayout(firstId, '2-split');
    const tabs = sessionStore.getTerminalsForSession(firstId);
    const order = sessionStore.getTabOrder(firstId);
    const tiling = sessionStore.getTilingForSession(firstId);
    await enterChat();
    await chooseView('terminal');
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(sessionStore.getTerminalsForSession(firstId)?.tabs).toEqual(tabs?.tabs);
    expect(sessionStore.getTabOrder(firstId)).toEqual(order);
    expect(sessionStore.getTilingForSession(firstId)).toEqual(tiling);
  });

  it('REQ-AGENT-224: the mount sends to the attached primary and does not resend a handed prompt when the surface reconnects', async () => {
    await openTerminalSession();
    sessionStore.addTerminalTab(firstId);
    sessionStore.setActiveTerminalTab(firstId, '2');
    await fireEvent.input(await enterChat(), { target: { value: 'Continue the current primary task' } });
    await fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    await waitFor(() => expect(ChatWire.wires.flatMap(w => w.frames).filter(f => f.type === 'send_prompt'))
      .toEqual([expect.objectContaining({ sessionId: 'bound-primary-pi', text: 'Continue the current primary task' })]));
    await chooseView('terminal');
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    await enterChat();
    await waitFor(() => expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toHaveLength(1));
    expect(ChatWire.wires.flatMap(w => w.frames).filter(f => f.type === 'send_prompt'))
      .toEqual([expect.objectContaining({ sessionId: 'bound-primary-pi', text: 'Continue the current primary task' })]);
    const subscriptions = ChatWire.wires.flatMap(w => w.frames).filter(f => f.type === 'subscribe');
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every(f => f.sessionId === 'bound-primary-pi')).toBe(true);
  });

  it('REQ-AGENT-224: Pi Stop emits only the bound-primary abort, never container Stop or IDE termination', async () => {
    await openTerminalSession(); await enterChat();
    await waitFor(() => expect(openWires().length).toBeGreaterThan(0));
    const wire = openWires().find(w => String(w.url).includes('/api/chat/'))!;
    await act(async () => {
      wire.receive({ type: 'event', sessionId: 'bound-primary-pi', seq: 1,
        event: { eventType: 'agent_start', timestamp: Date.now(), data: { type: 'agent_start' } } });
      wire.receive({ type: 'session_updated', sessionId: 'bound-primary-pi', updates: { status: 'streaming' } });
    });
    await fireEvent.click(await screen.findByRole('button', { name: /^Stop$/i }));
    expect(ChatWire.wires.flatMap(w => w.frames).filter(f => f.type === 'abort'))
      .toEqual([{ type: 'abort', sessionId: 'bound-primary-pi' }]);
    expect(requests.filter(r => /\/container\/(stop|destroy)|\/api\/vscode\//.test(new URL(r.url).pathname))).toEqual([]);
    expect(sessionStore.getActiveSession()?.status).toBe('running');
  });

  it('REQ-AGENT-224: drafts survive surface unmount but are session-local and not persisted', async () => {
    sessions.push(makeSession({ id: secondId, name: 'Other Pi' })); await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Unsent draft from primary' } });
    await chooseView('terminal');
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(await enterChat()).toHaveValue('Unsent draft from primary');
    localStorage.setItem('codeflare:normal-view', 'terminal');
    await act(async () => { sessionStore.setActiveSession(secondId); });
    await screen.findByRole('region', { name: `Terminal ${secondId} 1` });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // A never-visited session keeps its own Terminal default. Enter Chat
    // explicitly before checking its independent composer and remembered choice.
    expect(await enterChat()).toHaveValue('');
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Other session draft' } });
    await act(async () => { sessionStore.setActiveSession(firstId); });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Unsent draft from primary'));
    await act(async () => { sessionStore.setActiveSession(secondId); });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Other session draft'));
    const persisted = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!));
    expect(persisted.join('\n')).not.toContain('Unsent draft from primary');
  });

  it('REQ-AGENT-224: deleting a session clears its unsent draft before that identity is reused', async () => {
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Discard on deletion' } });
    // Explicit deletion, not a transient missing KV row, revokes local ownership.
    await act(async () => { await sessionStore.deleteSession(firstId); });
    sessions = [makeSession({ generation: 8, revision: 2 })]; await act(async () => { await sessionStore.loadSessions(); });
    await act(async () => { sessionStore.setActiveSession(firstId); });
    await chooseView('chat');
    expect(await screen.findByRole('textbox')).toHaveValue('');
  });

  it('REQ-AGENT-224: the mount keeps Send and omits management and advanced stop affordances', async () => {
    await openTerminalSession(); await enterChat();
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeInTheDocument();
    for (const name of [/force.?kill/i, /provider settings/i, /thinking level/i, /inline terminal/i,
      /plugin management/i, /new dashboard session/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // The choice and draft are UI-local, not a new global/default-workspace preference.
    expect(requests.filter(r => new URL(r.url).pathname === '/api/preferences' && r.method !== 'GET')).toEqual([]);
  });

  it.each(['claude-code', 'codex', 'bash'] as const)('REQ-AGENT-224: %s sessions retain Terminal and never open Pi Chat', async agentType => {
    sessions = [makeSession({ agentType, tabConfig: [{ id: '1', command: agentType, label: agentType }] })];
    await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession();
    expect(screen.queryByRole('button', { name: /^Chat$/i })).not.toBeInTheDocument();
    expect(attachRequests()).toEqual([]);
    expect(screen.getByRole('region', { name: `Terminal ${firstId} 1` })).toBeInTheDocument();
  });

  it('REQ-AGENT-224: Standard Pi may use Chat but cannot acquire the advanced VS Code entitlement', async () => {
    preferences.sessionMode = 'default'; await sessionStore.loadPreferences();
    await openTerminalSession(); await enterChat();
    expect(screen.queryByRole('button', { name: /Open editor \(VS Code\)/i })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-224: VS Code opens its existing authenticated named window without replacing Chat or its conversation', async () => {
    const opened = { closed: false, opener: {}, focus() {} };
    const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Independent in-app draft' } });
    await chooseView('vscode');
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveValue('vscode');
    expect(localStorage.getItem('codeflare:normal-view')).toBe('vscode');
    expect(open).toHaveBeenCalledWith(`/api/vscode/${firstId}/`, `codeflare-vscode-${firstId}`);
    expect(opened.opener).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('Independent in-app draft');
    expect(attachRequests().map(r => new URL(r.url).pathname)).toEqual([`/api/chat/${firstId}/attach`]);
  });

  it.each(['classic', 'herdr'] as const)('REQ-IDE-048 / REQ-IDE-049 / REQ-TERM-035: exclusive %s VS Code selection opens the authenticated editor without in-app ownership', async terminalMode => {
    const opened = { closed: false, opener: {}, focus() {} };
    const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window);
    sessions = [makeSession({ workspace: 'vscode', terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    expect(open).toHaveBeenCalledWith(`/api/vscode/${firstId}/`, `codeflare-vscode-${firstId}`);
    expect(opened.opener).toBeNull();
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument();
    expect(attachRequests()).toEqual([]);
    expect(ChatWire.wires).toEqual([]);
    expect(sessionStore.sessions[0].workspace).toBe('vscode');
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: exclusive %s VS Code rejects Chat and Terminal entry', async terminalMode => {
    sessions = [makeSession({ workspace: 'vscode', terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Chat' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    expect(attachRequests()).toEqual([]);
    expect(ChatWire.wires).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(sessionStore.sessions[0]).toMatchObject({ workspace: 'vscode', terminalMode, generation: 7 });
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: explicit %s Terminal-created entry confirms the primary over HTTP before mounting', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    deferAttach = true;
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument();
    expect(await attachRequests()[0].json()).toEqual({ generation: 7 });
    await act(async () => { releaseAttach!(); });
    const terminal = await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(new URL(terminal.querySelector('a')!.href).searchParams.get('primary')).toBe('1');
    expect(sessionStore.getActiveSession()).toMatchObject({ workspace: 'terminal', terminalMode, generation: 7 });
    expect(requests.filter(r => !['GET', 'HEAD'].includes(r.method) && !new URL(r.url).pathname.endsWith('/attach'))).toEqual([]);
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: failed explicit %s Terminal-created confirmation shows an error without mounting a fallback', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    attachStatus = 401;
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    expect(attachRequests()).toHaveLength(1);
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: fenced-generation %s Terminal return waits for HTTP confirmation of the replacement primary', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession();
    expect(attachRequests()).toEqual([]); // Ordinary Terminal card routing stays unchanged.
    await enterChat();
    sessions = [makeSession({ terminalMode, generation: 8, revision: 2 })]; await act(async () => { await sessionStore.loadSessions(); });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(attachRequests()).toHaveLength(1); // Polling must not confirm a replacement.
    deferAttach = true;
    await chooseView('terminal');
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(await attachRequests()[1].json()).toEqual({ generation: 8 });
    await act(async () => { releaseAttach!(); });
    const terminal = await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(new URL(terminal.querySelector('a')!.href).searchParams.get('primary')).toBe('1');
    expect(openWires()).toEqual([]);
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: failed fenced-generation %s Terminal confirmation preserves the fence and visible error', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession(); await enterChat();
    sessions = [makeSession({ terminalMode, generation: 8, revision: 2 })]; await act(async () => { await sessionStore.loadSessions(); });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    attachStatus = 401;
    await chooseView('terminal');
    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    expect(screen.getByText(/Pi session changed/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(openWires()).toEqual([]);
    expect(attachRequests()).toHaveLength(2);
  });

  it.each(['stopped', 'stopping'] as const)('REQ-AGENT-224: explicit entries cannot wake or attach a %s Pi', async status => {
    sessions = [makeSession({ status })]; await act(async () => { await sessionStore.loadSessions(); });
    await renderLayout();
    // The Dashboard fixture deliberately exposes callbacks even when the real
    // card hides them: the Layout boundary must independently refuse no-wake entry.
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Chat' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    expect(attachRequests()).toEqual([]);
    expect(ChatWire.wires).toEqual([]);
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(requests.filter(r => !['GET', 'HEAD'].includes(r.method))).toEqual([]);
  });

  it('REQ-AGENT-224: a non-Pi configured tab one never exposes Chat even when the session agent label is Pi', async () => {
    sessions = [makeSession({ tabConfig: [{ id: '1', command: 'bash', label: 'Shell' }, { id: '2', command: 'pi', label: 'Pi' }] })];
    await act(async () => { await sessionStore.loadSessions(); }); await openTerminalSession();
    expect(screen.queryByRole('button', { name: /^Chat$/i })).not.toBeInTheDocument();
    expect(attachRequests()).toEqual([]);
  });

  it.each(['stopped', 'stopping', 'generation'] as const)('REQ-AGENT-224: %s invalidates visible Chat without automatically attaching its replacement', async change => {
    await openTerminalSession(); await enterChat();
    sessions = [makeSession(change === 'generation' ? { generation: 8, revision: 2 } : { status: change, revision: 2 })];
    await act(async () => { await sessionStore.loadSessions(); });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toEqual([]);
    expect(attachRequests()).toHaveLength(1);
    if (change !== 'generation') {
      // Recovery/polling is not a new entry gesture, even if a backend projection
      // still carries the prior generation. The old binding must stay fenced.
      sessions = [makeSession({ revision: 3 })]; await act(async () => { await sessionStore.loadSessions(); });
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(attachRequests()).toHaveLength(1);
    }
    expect(await enterChat()).toHaveValue('');
    expect(await attachRequests()[1].json()).toEqual({ generation: change === 'generation' ? 8 : 7 });
  });

  it('REQ-AGENT-224: stale pending Normal entry cannot mount a replacement generation', async () => {
    sessions = [makeSession()]; await act(async () => { await sessionStore.loadSessions(); });
    deferAttach = true;
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    sessions = [makeSession({ generation: 8, revision: 2 })]; await act(async () => { await sessionStore.loadSessions(); });
    await act(async () => { releaseAttach!(); });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(attachRequests()).toHaveLength(1);
  });

  it('REQ-AGENT-224: a pending explicit entry cannot steal selection after another session is selected', async () => {
    sessions = [makeSession(), makeSession({ id: secondId, name: 'Other Pi' })];
    await act(async () => { await sessionStore.loadSessions(); });
    deferAttach = true;
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    // Use the public selection boundary, not a private entry-controller spy.
    await act(async () => { sessionStore.setActiveSession(secondId); });
    await screen.findByRole('region', { name: `Terminal ${secondId} 1` });
    await act(async () => { releaseAttach!(); });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sessionStore.activeSessionId).toBe(secondId);
    expect(screen.getByRole('region', { name: `Terminal ${secondId} 1` })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-224: a failed explicit Normal Terminal attach keeps dashboard ownership and a useful error without retrying', async () => {
    sessions = [makeSession()]; await act(async () => { await sessionStore.loadSessions(); });
    attachStatus = 401;
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(ChatWire.wires).toEqual([]);
    expect(attachRequests()).toHaveLength(1);
  });

  it('REQ-AGENT-224: MultiView stays terminal-only and has no Chat controls even after remembering Chat', async () => {
    sessions.push(makeSession({ id: secondId, name: 'Other Pi' })); await act(async () => { await sessionStore.loadSessions(); });
    await openTerminalSession(); await enterChat();
    expect(terminalWorkspaceStore.createOrUpdateMultiView([firstId, secondId], sessionStore.sessions, 'desktop')).toBe(true);
    await act(async () => {
      terminalWorkspaceStore.openMultiView(sessionStore.sessions);
      sessionStore.setActiveSession(null);
    });
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(screen.getByRole('region', { name: `Terminal ${secondId} 1` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Chat$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toEqual([]);
  });

  it('REQ-AGENT-224: visibility return in Chat never reconnects a cached terminal owner', async () => {
    await openTerminalSession(); await enterChat();
    // A retained disconnected xterm is exactly what the Layout recovery loop
    // must exclude while Chat owns the surface. No terminal fixture runs it.
    terminalStore.setTerminal(firstId, '1', {
      cols: 80, rows: 24, onData: () => ({ dispose() {} }),
      dispose() {}, write() {},
    } as any);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());
    expect(ChatWire.wires.filter(w => String(w.url).includes('/api/terminal/'))).toEqual([]);
    expect(sessionStore.activeSessionId).toBe(firstId);
  });

  it('REQ-AGENT-224: public logout disposes Chat and clears transient surface/draft state before navigation', async () => {
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Discard on logout' } });
    await fireEvent.click(screen.getByTitle('User menu'));
    await fireEvent.click(await screen.findByRole('button', { name: 'Logout' }));
    await screen.findByRole('region', { name: 'Session dashboard' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(openWires().filter(wire => String(wire.url).includes('/api/chat/'))).toEqual([]);
    // JSDOM does not navigate the external logout URL. Re-enter within this
    // disposable shell to observe that neither the choice nor draft survived.
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(await enterChat()).toHaveValue('');
  });

  it('REQ-AGENT-224: unmount retains browser view preference but clears composer draft before a fresh shell', async () => {
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Discard with shell' } });
    await act(async () => { cleanup(); sessionStore.setActiveSession(null); terminalWorkspaceStore.setDashboardWorkspace(); });
    window.history.replaceState(null, '', '/app/');
    await renderLayout();
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    expect(await screen.findByRole('textbox')).toHaveValue('');
    expect(localStorage.getItem('codeflare:normal-view')).toBe('chat');
  });

  it('REQ-AGENT-224: returning to Terminal makes an explicit primary handoff without manual autostart suppression', async () => {
    await openTerminalSession();
    expect(new URL(screen.getByRole('link', { name: 'Terminal attachment' }).getAttribute('href')!).searchParams.has('primary')).toBe(false);
    await enterChat();
    await chooseView('terminal');
    const url = new URL((await screen.findByRole('link', { name: 'Terminal attachment' })).getAttribute('href')!);
    expect(url.searchParams.get('primary')).toBe('1');
    expect(url.searchParams.has('manual')).toBe(false);
  });

  it('REQ-AGENT-224: auth expiry during explicit entry is visible and does not leave a hidden terminal or retry loop', async () => {
    attachStatus = 401;
    await openTerminalSession();
    await chooseView('chat');
    expect(await screen.findByText(/session expired|sign in|log in/i)).toBeInTheDocument();
    expect(openWires()).toEqual([]);
    expect(attachRequests().map(r => new URL(r.url).pathname)).toEqual([`/api/chat/${firstId}/attach`]);
  });

  it('REQ-AGENT-224: background auth expiry disposes Chat without falling through to a terminal attachment', async () => {
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Clear on auth expiry' } });
    expiredPolling = true;
    await sessionStore.refreshSessionStatuses();
    await screen.findByTestId('auth-expired-banner');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(openWires()).toEqual([]);
    expect(attachRequests()).toHaveLength(1);
  });

  it('REQ-AGENT-224: View remains a native keyboard-focusable control at phone width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    await openTerminalSession();
    const view = screen.getByRole('combobox', { name: 'View' });
    view.focus(); expect(document.activeElement).toBe(view);
    await chooseView('chat');
    expect(await screen.findByRole('textbox')).toBeEnabled();
    await chooseView('terminal');
    expect(await screen.findByRole('region', { name: `Terminal ${firstId} 1` })).toBeInTheDocument();
  });
});
