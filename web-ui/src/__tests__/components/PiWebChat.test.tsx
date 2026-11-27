import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PiWebChat from '../../components/PiWebChat';
import PiWebSwitchControls from '../../components/PiWebSwitchControls';

const SESSION_ID = 'abcdef1234567890';
const GENERATION = 7;
const ATTACHMENT = "00000000-0000-4000-8000-000000000001";
const SCOPE = `/api/pi-web/${SESSION_ID}/g/${GENERATION}/a/${ATTACHMENT}/`;
const CHAT_URL = `${SCOPE}?project=project-a&workspace=workspace-a&session=native-pi-a&view=chat`;
const ENTERING_CODE = 'Entering Code mode...';
const active = { phase: 'active' as const, surface: 'chat' as const, chatUrl: CHAT_URL };
const waiting = { ...active, phase: 'waiting' as const, target: 'terminal' as const };
const stopping = { ...waiting, phase: 'stopping' as const };
const cancelled = { ...active, phase: 'cancelled' as const };
const releasing = { ...active, phase: 'releasing' as const };
const opening = { phase: 'opening' as const, surface: null };

function chatFrame(): HTMLIFrameElement {
  const frame = screen.getByTitle(/chat/i);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('The stock Chat view needs its own titled frame');
  return frame;
}

describe('stock Chat theme startup (REQ-AGENT-274 AC5)', () => {
  // Pi Web 1.202611.5 reads this browser preference before applying its gateway default.
  const themeKey = 'pi-web-app-theme';
  const alternate = JSON.stringify({ themeId: 'themes:pi-web-light', auto: true });
  const openChat = () => render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION}
    status={active} onCancel={() => {}} />);

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('lets a fresh browser use the stock gateway theme default', () => {
    openChat();
    expect(chatFrame()).toBeVisible();
    expect(localStorage.getItem(themeKey)).toBeNull();
  });

  it('returns a previously saved alternate theme to the gateway default on first open', () => {
    localStorage.setItem(themeKey, alternate);
    openChat();
    expect(chatFrame()).toBeVisible();
    expect(localStorage.getItem(themeKey)).toBeNull();
  });

  it.each([null, alternate])('keeps a later browser theme choice on reopening Chat (%s)', prior => {
    if (prior !== null) localStorage.setItem(themeKey, prior);
    const first = openChat();
    expect(chatFrame()).toBeVisible();
    expect(localStorage.getItem(themeKey)).toBeNull();
    // Stock Appearance's "Use in this browser" writes this preference.
    localStorage.setItem(themeKey, alternate);
    first.unmount();
    openChat();
    expect(chatFrame()).toBeVisible();
    expect(JSON.parse(localStorage.getItem(themeKey) ?? 'null')).toEqual({ themeId: 'themes:pi-web-light', auto: true });
  });
});

describe('Pi web Chat wrapper (REQ-AGENT-272)', () => {
  it('REQ-AGENT-272 AC4: embeds the bound stock Chat deep link in the same-origin Codeflare session scope', () => {
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}} />);

    const frame = chatFrame();
    const location = new URL(frame.src);
    expect(location.origin).toBe(window.location.origin);
    expect(location.pathname).toBe(SCOPE);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      project: 'project-a', workspace: 'workspace-a', session: 'native-pi-a', view: 'chat',
    });
    expect(frame).toBeVisible();
    expect(screen.queryByRole('button', { name: /terminal/i })).not.toBeInTheDocument();
  });

  it.each([null, '{"pinnedIds":["chat"],"mobileCollapsed":true}'])('seeds stock navigation only when no browser preference exists (%s)', saved => {
    // Stock Pi Web 1.202611.5 reads this browser-storage contract on mount.
    const key = 'pi-web:navigation-preferences';
    localStorage.removeItem(key);
    if (saved !== null) localStorage.setItem(key, saved);
    try {
      render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}} />);
      expect(chatFrame()).toBeVisible();
      expect(localStorage.getItem(key)).toBe(saved ?? '{"pinnedIds":["chat","files:workspace.files"],"mobileCollapsed":false}');
    } finally { localStorage.removeItem(key); }
  });

  it('waits five seconds after the stock loader disappears, not after iframe load', async () => {
    vi.useFakeTimers();
    try {
      const loaded = vi.fn();
      render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active}
        onCancel={() => {}} onStartupReady={loaded} />);
      const frame = chatFrame();
      const doc = document.implementation.createHTMLDocument();
      Object.defineProperty(doc, 'URL', { value: frame.src });
      doc.body.innerHTML = '<div id="pi-web-startup"></div><pi-web-app></pi-web-app>';
      doc.documentElement.setAttribute('data-pi-web-loading', '');
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
      await vi.advanceTimersByTimeAsync(5000);
      expect(loaded).not.toHaveBeenCalledWith(true);
      doc.documentElement.removeAttribute('data-pi-web-loading');
      await Promise.resolve(); // Deliver the document's mutation before advancing the grace period.
      await vi.advanceTimersByTimeAsync(4999);
      expect(loaded).not.toHaveBeenCalledWith(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(loaded).toHaveBeenLastCalledWith(true);
      expect(chatFrame()).toBe(frame);
    } finally { vi.useRealTimers(); }
  });

  it('compacts only ready empty history and expands in place on the first message', async () => {
    vi.useFakeTimers();
    try {
      const [height, setHeight] = createSignal<number>();
      render(() => <div style={{ 'max-height': height() === undefined ? undefined : `${height()}px` }} data-testid="chat-panel">
        <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}}
          onPanelSize={size => setHeight(size?.compactHeight)} />
      </div>);
      const panel = screen.getByTestId('chat-panel');
      const frame = chatFrame();
      const doc = document.implementation.createHTMLDocument();
      Object.defineProperty(doc, 'URL', { value: frame.src });
      doc.body.innerHTML = '<pi-web-app></pi-web-app>';
      const shell = doc.querySelector('pi-web-app')!.attachShadow({ mode: 'open' });
      shell.innerHTML = '<main class="chat-view"><conversation-layout><chat-view></chat-view></conversation-layout></main>';
      const chat = Object.assign(shell.querySelector('chat-view')!, { historyReady: false, messageTotal: 0, messages: [], pendingDialogs: [] });
      const history = chat.attachShadow({ mode: 'open' });
      Object.defineProperty(chat, 'offsetHeight', { value: 400 });
      Object.defineProperty(frame, 'offsetHeight', { value: 560 });
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
      expect(panel.style.maxHeight).toBe('');
      chat.historyReady = true;
      await vi.advanceTimersByTimeAsync(200);
      expect(panel.style.maxHeight).toBe('160px');
      Object.assign(chat, { pendingDialogs: [{}] });
      history.innerHTML = '<div role="dialog"></div>';
      await Promise.resolve();
      expect(panel.style.maxHeight).toBe('');
      Object.assign(chat, { pendingDialogs: [], messageTotal: 1, messages: [{ role: 'system' }] });
      history.innerHTML = '<article class="system"></article>';
      await Promise.resolve();
      expect(panel.style.maxHeight).toBe('160px');
      Object.assign(chat, { messageTotal: 2, messages: [{ role: 'system' }, { role: 'user' }] });
      history.innerHTML = '<article class="system"></article><article class="user"></article>';
      await Promise.resolve();
      expect(chatFrame()).toBe(frame);
      expect(panel.style.maxHeight).toBe('');
    } finally { vi.useRealTimers(); }
  });

  it('starts the grace period when stock Chat already removed the loader before load', async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn();
      render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active}
        onCancel={() => {}} onStartupReady={ready} />);
      const frame = chatFrame();
      const doc = document.implementation.createHTMLDocument();
      Object.defineProperty(doc, 'URL', { value: frame.src });
      doc.body.innerHTML = '<pi-web-app></pi-web-app>';
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5000);
      expect(ready).toHaveBeenLastCalledWith(true);
    } finally { vi.useRealTimers(); }
  });

  it('reloads the same Chat frame only after a failed navigation, without switching writers', async () => {
    const onRetry = () => { throw new Error('Reload must not dispatch a handoff'); };
    const [status, setStatus] = createSignal<typeof active | (typeof opening & { target: 'chat'; chatUrl: string })>(
      { ...opening, target: 'chat', chatUrl: CHAT_URL });
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={status()}
      onCancel={() => {}} onRetry={onRetry} />);
    const failedFrame = chatFrame();
    expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
    const errorDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(errorDocument, 'URL', { value: failedFrame.src });
    Object.defineProperty(failedFrame, 'contentDocument', { value: errorDocument });
    fireEvent.load(failedFrame);
    await fireEvent.click(screen.getByRole('button', { name: 'Reload Chat' }));
    expect(failedFrame).not.toBeInTheDocument();
    expect(chatFrame().src).toBe(failedFrame.src);
    expect(chatFrame()).toBeVisible();
    setStatus(active);
    expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-273 AC1: announces the destination without replacing the source frame', async () => {
    const [status, setStatus] = createSignal<typeof active | typeof waiting | typeof stopping>(active);
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={status()}
      onCancel={() => {}} />);
    const source = chatFrame();
    const sourceUrl = source.src;
    expect(screen.queryByText(ENTERING_CODE, { exact: true })).not.toBeInTheDocument();

    const expectStoppingInPlace = () => {
      const announced = screen.getByRole('status');
      expect(announced.textContent).toBe(ENTERING_CODE);
      expect(announced).toBeVisible();
      expect(chatFrame()).toBe(source);
      expect(source.src).toBe(sourceUrl);
      expect(source).toBeVisible();
    };
    setStatus(waiting);
    expectStoppingInPlace();
    setStatus(stopping);
    expectStoppingInPlace();
  });

  it('REQ-AGENT-272 AC7: mounts the known stock row during startup without admitting another switch', () => {
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION}
      status={{ phase: 'opening', target: 'chat', surface: null, chatUrl: CHAT_URL }}
      onCancel={() => {}} />);
    expect(chatFrame()).toBeVisible();
    expect(new URL(chatFrame().src).searchParams.get('session')).toBe('native-pi-a');
    expect(screen.queryByRole('button', { name: /terminal/i })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-272 AC6: offers Cancel switch only before Abort is committed', async () => {
    const [status, setStatus] = createSignal<typeof waiting | typeof cancelled | typeof stopping | typeof releasing | typeof opening>(waiting);
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={status()}
      onCancel={() => setStatus(cancelled)} />);
    const source = chatFrame();
    const cancel = screen.getByRole('button', { name: 'Cancel switch' });
    expect(cancel).toBeEnabled();

    await fireEvent.click(cancel);
    expect(screen.queryByText(ENTERING_CODE, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel switch' })).not.toBeInTheDocument();
    expect(chatFrame()).toBe(source);
    expect(source).toBeVisible();

    setStatus(waiting);
    expect(screen.getByRole('button', { name: 'Cancel switch' })).toBeEnabled();
    setStatus(stopping);
    expect(screen.queryByRole('button', { name: 'Cancel switch' })).not.toBeInTheDocument();
    for (const phase of [releasing, opening]) {
      setStatus(phase);
      expect(screen.queryByRole('button', { name: 'Cancel switch' })).not.toBeInTheDocument();
      expect(screen.queryByText(ENTERING_CODE, { exact: true })).not.toBeInTheDocument();
    }
  });
});

it.each([['chat', 'Entering Vibe mode...'], ['terminal', 'Entering Code mode...']] as const)(
  'announces %s immediately and keeps the same status through the handoff phases', (target, announcement) => {
    const [switching, setSwitching] = createSignal(true);
    const [phase, setPhase] = createSignal<'active' | 'waiting' | 'stopping' | 'releasing' | 'opening' | 'complete'>('active');
    render(() => <PiWebSwitchControls phase={phase()} target={target} switching={switching()} onCancel={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(announcement);
    setSwitching(false);
    for (const pending of ['waiting', 'stopping', 'releasing', 'opening'] as const) {
      setPhase(pending);
      expect(screen.getByRole('status')).toHaveTextContent(announcement);
    }
    setPhase('complete');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  },
);

it('REQ-AGENT-272 AC5: never mounts an old, foreign, or malformed Chat frame for the current generation', () => {
  const [status, setStatus] = createSignal(active);
  const [generation, setGeneration] = createSignal(GENERATION);
  render(() => <PiWebChat sessionId={SESSION_ID} generation={generation()} status={status()}
    onCancel={() => {}} />);
  expect(chatFrame()).toBeVisible();
  setGeneration(GENERATION + 1);
  expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
  expect(screen.getByText('Chat could not be opened.')).toBeVisible();
  const matching = CHAT_URL.replace('/g/7/', '/g/8/');
  for (const chatUrl of [`https://other.example${matching}`, `/unrelated${matching}`, 'http://[invalid']) {
    setStatus({ ...active, chatUrl });
    expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
    expect(screen.getByText('Chat could not be opened.')).toBeVisible();
  }
  setStatus({ ...active, chatUrl: matching });
  expect(new URL(chatFrame().src).pathname).toBe(`/api/pi-web/${SESSION_ID}/g/8/a/${ATTACHMENT}/`);
});

it('offers the existing retry action without presenting an unconfirmed Chat writer', async () => {
  const [retried, setRetried] = createSignal(false);
  render(() => <><PiWebChat sessionId={SESSION_ID} generation={GENERATION}
    status={{ phase: 'failed', surface: null, target: 'chat', chatUrl: CHAT_URL }}
    problem="Chat startup did not settle." onCancel={() => {}} onRetry={() => setRetried(true)} />
    {retried() && <output>Retry requested</output>}</>);
  expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
  expect(screen.getByText('Chat startup did not settle.')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'Retry switch' }));
  expect(screen.getByText('Retry requested')).toBeVisible();
});
