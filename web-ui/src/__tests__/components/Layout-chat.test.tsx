import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { For } from 'solid-js';
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
  let releaseAttach: (() => void) | undefined;
  let deferAttach: boolean;
  const viewport = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  beforeEach(async () => {
    cleanup();
    sessionStore.stopAllPolling();
    sessionStore.stopSessionListPolling();
    sessionStore.setActiveSession(null);
    terminalWorkspaceStore.setDashboardWorkspace();
    sessions = [];
    preferences = { sessionMode: 'advanced', defaultWorkspace: 'terminal' };
    requests = [];
    attachStatus = 200;
    releaseAttach = undefined;
    deferAttach = false;
    ChatWire.wires = [];
    vi.stubGlobal('WebSocket', ChatWire);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.origin), init);
      requests.push(request.clone());
      const path = new URL(request.url).pathname;
      if (path === '/api/sessions') return Response.json({ sessions });
      if (path === '/api/preferences') return Response.json(preferences);
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
          : { error: 'Session expired', code: 'AUTH_FAILED' }, { status: attachStatus });
      }
      if (path.includes('gravatar')) return new Response(null, { status: 404 });
      return new Response('{}', { status: 404 });
    });
    // Drain prior list ownership through the existing public loader, not private
    // reset hooks. Every test starts with an authoritative disposable catalog.
    await sessionStore.loadSessions();
    sessions = [makeSession()];
    await sessionStore.loadSessions();
    await sessionStore.loadPreferences();
    window.history.replaceState(null, '', '/app/');
  });
  afterEach(() => {
    cleanup(); terminalStore.disposeAll(); sessionStore.stopAllPolling(); sessionStore.stopSessionListPolling(); sessionStore.setActiveSession(null);
    terminalWorkspaceStore.setDashboardWorkspace();
    if (viewport) Object.defineProperty(window, 'innerWidth', viewport);
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  async function openTerminalSession() {
    render(() => <Layout userName="owner@example.test" />);
    await fireEvent.click(await screen.findByRole('button', { name: 'Select Primary Pi' }));
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
  }
  async function enterChat() {
    await fireEvent.click(await screen.findByRole('button', { name: /^Chat$/i }));
    return screen.findByRole('textbox');
  }
  const attachRequests = () => requests.filter(r => new URL(r.url).pathname.endsWith('/attach'));
  const openWires = () => ChatWire.wires.filter(w => w.readyState === ChatWire.OPEN);

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: %s surface switches unmount hidden ownership without stopping or restamping the session', async terminalMode => {
    sessions = [makeSession({ terminalMode })]; await sessionStore.loadSessions();
    await openTerminalSession();
    const selected = sessionStore.getActiveSession()!;
    const stamp = { workspace: selected.workspace, terminalMode: selected.terminalMode, generation: selected.generation };
    const path = window.location.pathname;
    await enterChat();
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    await waitFor(() => expect(openWires().some(w => String(w.url).includes(`/api/chat/${firstId}/ws`))).toBe(true));
    await fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
    await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toEqual([]);
    expect(sessionStore.getActiveSession()).toMatchObject(stamp);
    expect(window.location.pathname).toBe(path);
    expect(requests.filter(r => r.method !== 'GET' && !new URL(r.url).pathname.endsWith('/attach'))).toEqual([]);
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
    await fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
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
    await fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
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
    wire.receive({ type: 'event', sessionId: 'bound-primary-pi', seq: 1,
      event: { eventType: 'agent_start', timestamp: Date.now(), data: { type: 'agent_start' } } });
    wire.receive({ type: 'session_updated', sessionId: 'bound-primary-pi', updates: { status: 'streaming' } });
    await fireEvent.click(await screen.findByRole('button', { name: /^Stop$/i }));
    expect(ChatWire.wires.flatMap(w => w.frames).filter(f => f.type === 'abort'))
      .toEqual([{ type: 'abort', sessionId: 'bound-primary-pi' }]);
    expect(requests.filter(r => /\/container\/(stop|destroy)|\/api\/vscode\//.test(new URL(r.url).pathname))).toEqual([]);
    expect(sessionStore.getActiveSession()?.status).toBe('running');
  });

  it('REQ-AGENT-224: drafts survive surface unmount but are session-local and not persisted', async () => {
    sessions.push(makeSession({ id: secondId, name: 'Other Pi' })); await sessionStore.loadSessions();
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Unsent draft from primary' } });
    await fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
    expect(await enterChat()).toHaveValue('Unsent draft from primary');
    sessionStore.setActiveSession(secondId);
    await screen.findByRole('region', { name: `Terminal ${secondId} 1` });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // A never-visited session keeps its own Terminal default. Enter Chat
    // explicitly before checking its independent composer and remembered choice.
    expect(await enterChat()).toHaveValue('');
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Other session draft' } });
    sessionStore.setActiveSession(firstId);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Unsent draft from primary'));
    sessionStore.setActiveSession(secondId);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Other session draft'));
    const persisted = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!));
    expect(persisted.join('\n')).not.toContain('Unsent draft from primary');
  });

  it('REQ-AGENT-224: deleting a session clears its unsent draft before that identity is reused', async () => {
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Discard on deletion' } });
    // The authoritative catalog deletion path already owns terminal cleanup.
    sessions = []; await sessionStore.loadSessions();
    sessions = [makeSession({ generation: 8, revision: 2 })]; await sessionStore.loadSessions();
    sessionStore.setActiveSession(firstId);
    await fireEvent.click(await screen.findByRole('button', { name: /^Chat$/i }));
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
    sessions = [makeSession({ agentType })]; await sessionStore.loadSessions();
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
    await fireEvent.click(screen.getByRole('button', { name: /Open editor \(VS Code\)/i }));
    expect(open).toHaveBeenCalledWith(`/api/vscode/${firstId}/`, `codeflare-vscode-${firstId}`);
    expect(opened.opener).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('Independent in-app draft');
    expect(attachRequests().map(r => new URL(r.url).pathname)).toEqual([`/api/chat/${firstId}/attach`]);
  });

  it.each(['classic', 'herdr'] as const)('REQ-IDE-048 / REQ-IDE-049 / REQ-TERM-035: normal %s VS Code selection stays editor-first until explicit surface entry', async terminalMode => {
    sessions = [makeSession({ workspace: 'vscode', terminalMode })]; await sessionStore.loadSessions();
    render(() => <Layout />);
    await fireEvent.click(screen.getByRole('button', { name: 'Select Primary Pi' }));
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument();
    expect(attachRequests()).toEqual([]);
    expect(ChatWire.wires).toEqual([]);
    expect(sessionStore.sessions[0].workspace).toBe('vscode');
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: explicit %s VS Code Terminal entry waits for HTTP adoption and hands off only the primary', async terminalMode => {
    sessions = [makeSession({ workspace: 'vscode', terminalMode })]; await sessionStore.loadSessions();
    deferAttach = true;
    render(() => <Layout />);
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    await waitFor(() => expect(attachRequests().map(r => new URL(r.url).pathname)).toEqual([`/api/chat/${firstId}/attach`]));
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(openWires()).toEqual([]);
    releaseAttach!();
    const terminal = await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    const url = new URL(terminal.querySelector('a')!.href);
    expect(url.pathname).toBe(`/api/terminal/${firstId}-1/ws`);
    expect(url.searchParams.get('primary')).toBe('1');
    expect(url.searchParams.has('manual')).toBe(false);
    expect(sessionStore.sessions[0]).toMatchObject({ workspace: 'vscode', terminalMode, generation: 7 });
    expect(terminalWorkspaceStore.isTerminalSession(sessionStore.sessions[0])).toBe(false);
    expect(terminalWorkspaceStore.validateMultiViewMemberIds([firstId], sessionStore.sessions, 'desktop')).toEqual([]);
    expect(requests.filter(r => /\/container\/(start|stop|restart)/.test(new URL(r.url).pathname))).toEqual([]);
  });

  it.each(['classic', 'herdr'] as const)('REQ-AGENT-224: explicit %s VS Code Chat entry owns no terminal and returns to the primary', async terminalMode => {
    sessions = [makeSession({ workspace: 'vscode', terminalMode })]; await sessionStore.loadSessions();
    render(() => <Layout />);
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Chat' }));
    await screen.findByRole('textbox');
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
    const terminal = await screen.findByRole('region', { name: `Terminal ${firstId} 1` });
    expect(new URL(terminal.querySelector('a')!.href).searchParams.get('primary')).toBe('1');
    expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toEqual([]);
    expect(sessionStore.sessions[0].workspace).toBe('vscode');
  });

  it.each(['stopped', 'stopping'] as const)('REQ-AGENT-224: explicit entries cannot wake or attach a %s Pi', async status => {
    sessions = [makeSession({ workspace: 'vscode', status })]; await sessionStore.loadSessions();
    render(() => <Layout />);
    // The Dashboard fixture deliberately exposes callbacks even when the real
    // card hides them: the Layout boundary must independently refuse no-wake entry.
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Chat' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    expect(attachRequests()).toEqual([]);
    expect(ChatWire.wires).toEqual([]);
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(requests.filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('REQ-AGENT-224: a non-Pi configured tab one never exposes Chat even when the session agent label is Pi', async () => {
    sessions = [makeSession({ tabConfig: [{ id: '1', command: 'bash', label: 'Shell' }, { id: '2', command: 'pi', label: 'Pi' }] })];
    await sessionStore.loadSessions(); await openTerminalSession();
    expect(screen.queryByRole('button', { name: /^Chat$/i })).not.toBeInTheDocument();
    expect(attachRequests()).toEqual([]);
  });

  it.each(['stopped', 'stopping', 'generation'] as const)('REQ-AGENT-224: %s invalidates visible Chat without automatically attaching its replacement', async change => {
    await openTerminalSession(); await enterChat();
    sessions = [makeSession(change === 'generation' ? { generation: 8, revision: 2 } : { status: change, revision: 2 })];
    await sessionStore.loadSessions();
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(openWires().filter(w => String(w.url).includes('/api/chat/'))).toEqual([]);
    expect(attachRequests()).toHaveLength(1);
    if (change === 'generation') {
      expect(await enterChat()).toHaveValue('');
      expect(await attachRequests()[1].json()).toEqual({ generation: 8 });
    }
  });

  it('REQ-AGENT-224: stale pending VS Code entry cannot mount a replacement generation', async () => {
    sessions = [makeSession({ workspace: 'vscode' })]; await sessionStore.loadSessions();
    deferAttach = true;
    render(() => <Layout />);
    await fireEvent.click(screen.getByRole('button', { name: 'Open Primary Pi in Terminal' }));
    await waitFor(() => expect(releaseAttach).toBeTypeOf('function'));
    sessions = [makeSession({ workspace: 'vscode', generation: 8, revision: 2 })]; await sessionStore.loadSessions();
    releaseAttach!();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: `Terminal ${firstId} 1` })).not.toBeInTheDocument();
    expect(attachRequests()).toHaveLength(1);
  });

  it('REQ-AGENT-224: MultiView stays terminal-only and has no Chat controls even after remembering Chat', async () => {
    sessions.push(makeSession({ id: secondId, name: 'Other Pi' })); await sessionStore.loadSessions();
    await openTerminalSession(); await enterChat();
    expect(terminalWorkspaceStore.createOrUpdateMultiView([firstId, secondId], sessionStore.sessions, 'desktop')).toBe(true);
    terminalWorkspaceStore.openMultiView(sessionStore.sessions);
    sessionStore.setActiveSession(null);
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

  it('REQ-AGENT-224: unmount clears remembered choice and composer draft before a fresh shell', async () => {
    await openTerminalSession();
    await fireEvent.input(await enterChat(), { target: { value: 'Discard with shell' } });
    cleanup(); sessionStore.setActiveSession(null); terminalWorkspaceStore.setDashboardWorkspace();
    window.history.replaceState(null, '', '/app/');
    await openTerminalSession();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(await enterChat()).toHaveValue('');
  });

  it('REQ-AGENT-224: returning to Terminal makes an explicit primary handoff without manual autostart suppression', async () => {
    await openTerminalSession();
    expect(new URL(screen.getByRole('link', { name: 'Terminal attachment' }).getAttribute('href')!).searchParams.has('primary')).toBe(false);
    await enterChat();
    await fireEvent.click(screen.getByRole('button', { name: /^Terminal$/i }));
    const url = new URL((await screen.findByRole('link', { name: 'Terminal attachment' })).getAttribute('href')!);
    expect(url.searchParams.get('primary')).toBe('1');
    expect(url.searchParams.has('manual')).toBe(false);
  });

  it('REQ-AGENT-224: auth expiry during explicit entry is visible and does not leave a hidden terminal or retry loop', async () => {
    attachStatus = 401;
    await openTerminalSession();
    await fireEvent.click(screen.getByRole('button', { name: /^Chat$/i }));
    expect(await screen.findByText(/session expired|sign in|log in/i)).toBeInTheDocument();
    expect(openWires()).toEqual([]);
    expect(attachRequests().map(r => new URL(r.url).pathname)).toEqual([`/api/chat/${firstId}/attach`]);
  });

  it('REQ-AGENT-224: surface controls remain native keyboard-focusable buttons at phone width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    await openTerminalSession();
    const chat = screen.getByRole('button', { name: /^Chat$/i });
    chat.focus(); expect(document.activeElement).toBe(chat);
    await fireEvent.click(chat);
    const terminal = screen.getByRole('button', { name: /^Terminal$/i });
    terminal.focus(); expect(document.activeElement).toBe(terminal);
    expect(terminal).toBeEnabled();
    // No imported composer keyboard/viewport regression is re-tested here.
  });
});
