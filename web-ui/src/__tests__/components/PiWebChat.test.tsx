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

describe('stock Chat theme startup (REQ-AGENT-288 AC1–3)', () => {
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

  it('updates the retained Stock Chat document when the shell accent changes', async () => {
    const style = document.documentElement.style;
    const original = style.getPropertyValue('--color-accent');
    try {
      style.setProperty('--color-accent', 'rgb(0, 186, 255)');
      render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}} />);
      const frame = chatFrame();
      const doc = document.implementation.createHTMLDocument();
      Object.defineProperty(doc, 'URL', { value: frame.src });
      doc.body.appendChild(doc.createElement('pi-web-app'));
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
      expect(doc.documentElement.style.getPropertyValue('--codeflare-prompt-focus')).toBe('rgb(0, 186, 255)');
      style.setProperty('--color-accent', 'rgb(255, 120, 0)');
      await Promise.resolve();
      expect(doc.documentElement.style.getPropertyValue('--codeflare-prompt-focus')).toBe('rgb(255, 120, 0)');
      expect(chatFrame()).toBe(frame);
      expect(frame.contentDocument).toBe(doc);
    } finally {
      if (original) style.setProperty('--color-accent', original);
      else style.removeProperty('--color-accent');
    }
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

  it('recovers a stalled Chat client after its foreground bootstrap budget', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const setHidden = (value: boolean) => {
      hidden.mockReturnValue(value);
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const stockDocument = (frame: HTMLIFrameElement, loading: boolean) => {
      const doc = document.implementation.createHTMLDocument();
      Object.defineProperty(doc, 'URL', { value: frame.src });
      doc.body.appendChild(doc.createElement('pi-web-app')).attachShadow({ mode: 'open' });
      doc.documentElement.toggleAttribute('data-pi-web-loading', loading);
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
    };
    const ready = vi.fn();
    const [question, setQuestion] = createSignal(false);
    const view = render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={{ ...active, startupQuestion: question() }}
      onCancel={() => {}} onStartupReady={ready} />);
    try {
      const first = chatFrame();
      stockDocument(first, true);
      await vi.advanceTimersByTimeAsync(10_000);
      setHidden(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      setHidden(false);
      await vi.advanceTimersByTimeAsync(10_000);
      setQuestion(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      setQuestion(false);
      await vi.advanceTimersByTimeAsync(9999);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      expect(chatFrame()).toBe(first);
      await vi.advanceTimersByTimeAsync(1);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(1000);
      const replacement = chatFrame();
      expect(replacement).not.toBe(first);
      expect(replacement.src).toBe(first.src);
      stockDocument(replacement, false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(ready).toHaveBeenLastCalledWith(true);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
    } finally {
      view.unmount();
      hidden.mockRestore();
      vi.useRealTimers();
    }
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
      let historyHeight = 400;
      let controlsMeasurable = true;
      const conversation = chat.parentElement!;
      for (const [slot, size] of [['composer', 100], ['status', 20]] as const) {
        const control = conversation.appendChild(doc.createElement('div'));
        control.slot = slot;
        Object.defineProperty(control, 'offsetHeight', { get: () => controlsMeasurable ? size : 0 });
      }
      Object.defineProperty(chat, 'offsetHeight', { get: () => historyHeight });
      Object.defineProperty(frame, 'offsetHeight', { value: 560 });
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
      expect(panel.style.maxHeight).toBe('');
      chat.historyReady = true;
      await vi.advanceTimersByTimeAsync(200);
      expect(panel.style.maxHeight).toBe('160px');

      // A foreground relayout briefly reports history almost as tall as the frame.
      // That cannot be a usable cap: it would clip even the existing composer.
      historyHeight = 559;
      history.appendChild(doc.createElement('div'));
      await Promise.resolve();
      expect(panel.style.maxHeight).toBe('');
      expect(chatFrame()).toBe(frame);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      historyHeight = 400;
      controlsMeasurable = false;
      history.replaceChildren();
      await Promise.resolve();
      expect(panel.style.maxHeight).toBe('');
      controlsMeasurable = true;
      history.appendChild(doc.createElement('div'));
      await Promise.resolve();
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

  it('fits tablet Chat outside the frame through keyboard open, close and reopen', () => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
    try {
      const [inset, setInset] = createSignal(0);
      render(() => <div aria-label="Workspace" role="group" style={{ 'padding-block-end': `${inset()}px` }}>
        <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}}
          fitTabletKeyboard onKeyboardInset={setInset} />
      </div>);
      const workspace = screen.getByRole('group', { name: 'Workspace' });
      const frame = chatFrame();
      const url = frame.src;
      for (const loss of [300, 0, 240, 0]) {
        viewport.height = window.innerHeight - loss;
        viewport.dispatchEvent(new Event('resize'));
        expect(workspace.style.paddingBlockEnd).toBe(`${loss}px`);
        expect(screen.getByRole('region', { name: 'Pi Chat' }).style.marginBlockEnd).toBe('0px');
        expect(chatFrame()).toBe(frame);
        expect(frame.src).toBe(url);
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([false, true])('keeps an empty Chat usable when the visual viewport shrinks (tablet: %s)', tablet => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: tablet }));
    try {
      const [height, setHeight] = createSignal<number>();
      render(() => <div style={{ 'max-height': height() === undefined ? undefined : `${height()}px` }} data-testid="chat-panel">
        <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}}
          fitTabletKeyboard={tablet} onPanelSize={size => setHeight(size?.compactHeight)} />
      </div>);
      const panel = screen.getByTestId('chat-panel');
      const frame = chatFrame();
      const region = screen.getByRole('region', { name: 'Pi Chat' });
      const doc = document.implementation.createHTMLDocument();
      Object.defineProperty(doc, 'URL', { value: frame.src });
      const app = doc.body.appendChild(doc.createElement('pi-web-app'));
      const shell = app.attachShadow({ mode: 'open' });
      shell.innerHTML = '<main class="chat-view"><conversation-layout><chat-view></chat-view></conversation-layout></main>';
      const chat = Object.assign(shell.querySelector('chat-view')!, { historyReady: true, messageTotal: 0, messages: [] });
      for (const [slot, height] of [['composer', 100], ['status', 20]] as const) {
        const control = chat.parentElement!.appendChild(doc.createElement('div'));
        control.slot = slot;
        Object.defineProperty(control, 'offsetHeight', { value: height });
      }
      // Model only the relevant flex geometry: the keyboard margin takes space
      // inside the outer cap, and only the stock history can flex down to zero.
      Object.defineProperty(frame, 'offsetHeight', { get: () => Math.max(0,
        parseFloat(panel.style.maxHeight || '560') - parseFloat(region.style.marginBlockEnd)) });
      Object.defineProperty(chat, 'offsetHeight', { get: () => Math.max(0, frame.offsetHeight - 160) });
      Object.defineProperty(frame, 'contentDocument', { value: doc });
      fireEvent.load(frame);
      expect(panel.style.maxHeight).toBe('160px');

      viewport.height -= 260;
      viewport.dispatchEvent(new Event('resize'));
      expect(frame.offsetHeight).toBeGreaterThanOrEqual(160);
      if (tablet) expect(panel.style.maxHeight).toBe('160px');

      viewport.height = window.innerHeight;
      viewport.dispatchEvent(new Event('resize'));
      expect(panel.style.maxHeight).toBe('160px');
      expect(chatFrame()).toBe(frame);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['visibilitychange', 'pageshow'] as const)('refits the existing Chat frame on %s without a viewport resize event', event => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight - 260, offsetTop: 0, scale: 1 });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('visualViewport', viewport);
    try {
      render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onCancel={() => {}} />);
      const frame = chatFrame();
      const region = screen.getByRole('region', { name: 'Pi Chat' });
      expect(region.style.marginBlockEnd).toBe('260px');
      if (event === 'visibilitychange') {
        visibility.mockReturnValue('hidden');
        document.dispatchEvent(new Event(event));
      }
      viewport.height = window.innerHeight;
      visibility.mockReturnValue('visible');
      if (event === 'visibilitychange') document.dispatchEvent(new Event(event));
      else window.dispatchEvent(new PageTransitionEvent(event, { persisted: true }));
      expect(region.style.marginBlockEnd).toBe('0px');
      expect(chatFrame()).toBe(frame);
    } finally {
      visibility.mockRestore();
      vi.unstubAllGlobals();
    }
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

  it('recovers failed navigation at the same Chat URL without switching writers', async () => {
    vi.useFakeTimers();
    try {
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
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(1000);
      expect(failedFrame).not.toBeInTheDocument();
      expect(chatFrame().src).toBe(failedFrame.src);
      expect(chatFrame()).toBeVisible();
      setStatus(active);
      expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
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
