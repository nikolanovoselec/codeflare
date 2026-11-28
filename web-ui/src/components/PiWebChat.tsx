import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { piWebPrefix, type PiWebStatus } from '../api/pi-web';
import { disableVirtualKeyboardOverlay } from '../lib/mobile';
import PiWebSwitchControls from './PiWebSwitchControls';

export type ChatPanelSize = { compactHeight?: number; expanding?: boolean };

interface PiWebChatProps {
  sessionId: string;
  generation: number;
  status: PiWebStatus;
  onCancel: () => void;
  onRetry?: () => void;
  problem?: string;
  canCancel?: boolean;
  progressInMenu?: boolean;
  switchingTarget?: PiWebStatus['target'];
  onStartupReady?: (ready: boolean, focusPrompt?: () => void) => void;
  recoveryEnabled?: boolean;
  onPanelSize?: (size?: ChatPanelSize) => void;
  onKeyboardInset?: (inset: number) => void;
  fitTabletKeyboard?: boolean;
}

type StockHistory = HTMLElement & {
  sessionId?: string; historyReady?: boolean; messageTotal?: number; messages?: unknown[]; hasMore?: boolean;
  pendingDialogs?: unknown[]; closedDialogs?: unknown[];
};

function focusStockStartupPrompt(frame: HTMLIFrameElement, doc: Document, src: string) {
  // Optional integration with the pinned Pi Web 1.202611.5 components. A
  // changed/inaccessible stock UI must not interfere with the normal Open.
  try {
    if (!frame.isConnected || frame.closest('[inert]') || getComputedStyle(frame).visibility !== 'visible'
      || frame.contentDocument !== doc || doc.documentElement.hasAttribute('data-pi-web-loading')) return;
    const expected = new URL(src);
    const current = new URL(doc.URL);
    if (current.origin !== expected.origin || current.pathname !== expected.pathname
      || ['project', 'workspace', 'session', 'view'].some(key => current.searchParams.get(key) !== expected.searchParams.get(key))
      || expected.searchParams.get('view') !== 'chat') return;
    const sessionId = expected.searchParams.get('session');
    const projectId = expected.searchParams.get('project');
    const workspaceId = expected.searchParams.get('workspace');
    if (!sessionId || !projectId || !workspaceId) return;

    const app = doc.querySelector<HTMLElement & { isChatVisible?(): boolean; isRenderedModalOpen?(): boolean }>('pi-web-app');
    if (app?.isChatVisible?.() !== true || app.isRenderedModalOpen?.() !== false) return;
    const conversation = app.shadowRoot?.querySelector<HTMLElement & { questionActions?: unknown }>('main.chat-view > conversation-layout');
    if (!conversation) return;
    const children = Array.from(conversation.children);
    const history = children.find(child => child.localName === 'chat-view') as StockHistory | undefined;
    if (!history || history.sessionId !== sessionId || history.historyReady !== true || history.messageTotal !== 0
      || history.hasMore !== false || !Array.isArray(history.messages) || history.messages.length !== 0
      || !Array.isArray(history.pendingDialogs) || history.pendingDialogs.length !== 0
      || !Array.isArray(history.closedDialogs) || history.closedDialogs.length !== 0 || conversation.questionActions !== undefined) return;

    const slot = children.find(child => child.slot === 'composer');
    const composer = Array.from(slot?.children ?? []).find(child => child.localName === 'prompt-editor') as (HTMLElement & {
      sessionId?: string; projectId?: string; workspaceId?: string; disabled?: boolean; focusInput?(): void;
    }) | undefined;
    if (!composer || composer.sessionId !== sessionId || composer.projectId !== projectId || composer.workspaceId !== workspaceId
      || composer.disabled !== false || composer.closest('[inert], [hidden]')) return;
    const editable = composer.shadowRoot?.querySelector('.cm-content[contenteditable="true"]');
    if (!editable?.getClientRects().length || doc.defaultView?.getComputedStyle(editable).visibility !== 'visible') return;
    composer.focusInput?.();
  } catch { /* The normal Open already revealed Chat. Never retry focus. */ }
}

function StockChatFrame(props: { src: string; keyboardInset: number; startupQuestion?: boolean; onStartupReady?: PiWebChatProps['onStartupReady']; onStartupFailure?: (failed: boolean) => void; onPanelSize?: PiWebChatProps['onPanelSize'] }) {
  // Pi Web 1.202611.5 prefers a saved browser theme to the gateway default.
  // Return to the Codeflare default once per origin, before the stock frame reads storage.
  try {
    const migrationKey = 'codeflare:pi-web-default-theme-v1';
    if (localStorage.getItem(migrationKey) === null) {
      localStorage.removeItem('pi-web-app-theme');
      localStorage.setItem(migrationKey, '1');
    }
  } catch { /* Stock also tolerates unavailable browser storage. */ }

  // Seed navigation before the same-origin frame starts, preserving existing choices.
  try {
    const key = 'pi-web:navigation-preferences';
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify({ pinnedIds: ['chat', 'files:workspace.files'], mobileCollapsed: false }));
    }
  } catch { /* Stock also tolerates unavailable browser storage. */ }

  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopCompactWatch: (() => void) | undefined;
  let sampleCompactHistory: (() => void) | undefined;
  createEffect(on(() => props.keyboardInset, () => sampleCompactHistory?.()));
  let accentObserver: MutationObserver | undefined;
  let stopBootstrapWatch: (() => void) | undefined;
  let updateBootstrapWatch: (() => void) | undefined;
  createEffect(on(() => props.startupQuestion, () => updateBootstrapWatch?.()));
  const cancel = () => {
    observer?.disconnect(); accentObserver?.disconnect(); clearTimeout(timer);
    stopBootstrapWatch?.(); stopBootstrapWatch = undefined;
    stopCompactWatch?.();
  };
  const [compactHeight, setCompactHeight] = createSignal<number>();
  let expansionTimer: ReturnType<typeof setTimeout> | undefined;
  const compact = (height?: number, animate = false) => {
    if (height === compactHeight()) return;
    clearTimeout(expansionTimer);
    props.onPanelSize?.(height === undefined ? (animate ? { expanding: true } : undefined) : { compactHeight: height });
    setCompactHeight(height);
    if (animate) expansionTimer = setTimeout(() => props.onPanelSize?.(), 300);
  };

  const watchCompactHistory = (frame: HTMLIFrameElement, doc: Document, app: Element) => {
    // Pi Web 1.202611.5 does not reflect historyReady on the DOM. Observe
    // rendered changes and sample only until the selected history is known.
    let checkedChat: StockHistory | null | undefined;
    const controls = (chat: StockHistory | null) => Array.from(chat?.parentElement?.children ?? [])
      .filter((part): part is HTMLElement => part instanceof (doc.defaultView?.HTMLElement ?? HTMLElement)
        && (part.slot === 'composer' || part.slot === 'status'));
    let complete = false;
    let checks = 0;
    let sampling: ReturnType<typeof setInterval> | undefined;
    const dom = new MutationObserver(() => sample());
    const layout = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => sample());
    const stopSampling = () => { clearInterval(sampling); sampling = undefined; };
    const sample = () => {
      if (complete || !frame.isConnected || frame.contentDocument !== doc) return;
      const chat = app.shadowRoot?.querySelector<StockHistory>('main.chat-view > conversation-layout > chat-view') ?? null;
      if (chat !== checkedChat) {
        dom.disconnect();
        if (app.shadowRoot) dom.observe(app.shadowRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
        if (chat?.shadowRoot) dom.observe(chat.shadowRoot, { subtree: true, childList: true });
        layout?.disconnect();
        layout?.observe(frame);
        for (const part of controls(chat)) layout?.observe(part);
        checkedChat = chat;
      }
      if (doc.documentElement.hasAttribute('data-pi-web-loading') || !chat?.historyReady
        || !Array.isArray(chat.messages) || typeof chat.messageTotal !== 'number') {
        compact();
        return;
      }
      stopSampling();
      const visibleMessage = (message: unknown) => !message || typeof message !== 'object'
        || !('role' in message) || message.role !== 'system';
      if (chat.messageTotal > chat.messages.length || chat.messages.some(visibleMessage)) complete = true;
      if (complete || chat.pendingDialogs?.length || chat.closedDialogs?.length) {
        compact(undefined, complete);
        if (complete) { stopSampling(); dom.disconnect(); layout?.disconnect(); }
        return;
      }
      // The inset consumes space inside the outer cap. Measuring and capping
      // again while inset would subtract it repeatedly, eventually clipping Chat.
      if (props.keyboardInset > 0) {
        compact();
        return;
      }
      const remaining = frame.offsetHeight - chat.offsetHeight;
      const parts = controls(chat);
      const composerHeight = parts.find(part => part.slot === 'composer')?.offsetHeight ?? 0;
      const statusHeight = parts.find(part => part.slot === 'status')?.offsetHeight ?? 0;
      // Don't cap a pane whose controls are unmeasurable or wouldn't fit.
      compact(composerHeight > 0 && statusHeight > 0 && remaining >= composerHeight + statusHeight ? remaining : undefined);
    };
    if (app.shadowRoot) dom.observe(app.shadowRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    layout?.observe(frame);
    sampleCompactHistory = sample;
    stopCompactWatch = () => { sampleCompactHistory = undefined; stopSampling(); dom.disconnect(); layout?.disconnect(); };
    sampling = setInterval(() => {
      sample();
      if (++checks >= 50) stopSampling();
    }, 200);
    sample();
  };
  onCleanup(() => { cancel(); clearTimeout(expansionTimer); props.onPanelSize?.(); props.onStartupReady?.(false); props.onStartupFailure?.(false); });

  let firstDocument: Document | undefined;
  const loaded = (frame: HTMLIFrameElement) => {
    cancel();
    props.onStartupReady?.(false);
    clearTimeout(expansionTimer);
    compact();
    props.onPanelSize?.();
    const doc = frame.contentDocument;
    const app = doc?.querySelector('pi-web-app');
    if (!doc || new URL(doc.URL).pathname !== new URL(props.src).pathname || !app) {
      props.onStartupFailure?.(true);
      return;
    }
    firstDocument ??= doc;
    const shell = document.documentElement;
    const updatePromptAccent = () => {
      if (frame.contentDocument !== doc) return;
      doc.documentElement.style.setProperty('--codeflare-prompt-focus', getComputedStyle(shell).getPropertyValue('--color-accent').trim());
    };
    updatePromptAccent();
    accentObserver = new MutationObserver(updatePromptAccent);
    accentObserver.observe(shell, { attributes: true, attributeFilter: ['style'] });
    props.onStartupFailure?.(false);
    if (props.onPanelSize) watchCompactHistory(frame, doc, app);
    if (!props.onStartupReady) return;
    // Publish a handle to this document; only the startup Open gesture calls it.
    const focusPrompt = () => focusStockStartupPrompt(frame, doc, props.src);
    const root = doc.documentElement;
    if (root.hasAttribute('data-pi-web-loading')) {
      // Stock can mount before it is usable. Charge only foreground time
      // outside a Host-confirmed native startup question.
      let remaining = 30_000;
      let started: number | undefined;
      let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
      const update = () => {
        clearTimeout(bootstrapTimer);
        const now = Date.now();
        if (started !== undefined) remaining -= now - started;
        started = undefined;
        if (document.hidden || props.startupQuestion) return;
        started = now;
        bootstrapTimer = setTimeout(() => {
          started = undefined;
          if (!document.hidden && !props.startupQuestion && frame.isConnected && frame.contentDocument === doc
            && root.hasAttribute('data-pi-web-loading')) {
            remaining = 0;
            props.onStartupFailure?.(true);
          }
        }, Math.max(0, remaining));
      };
      stopBootstrapWatch = () => {
        clearTimeout(bootstrapTimer);
        document.removeEventListener('visibilitychange', update);
        updateBootstrapWatch = undefined;
      };
      updateBootstrapWatch = update;
      document.addEventListener('visibilitychange', update);
      update();
    }
    const check = () => {
      clearTimeout(timer);
      if (root.hasAttribute('data-pi-web-loading')) {
        props.onStartupReady?.(false);
      } else {
        stopBootstrapWatch?.();
        stopBootstrapWatch = undefined;
        props.onStartupFailure?.(false);
        timer = setTimeout(() => {
          if (frame.isConnected && frame.contentDocument === doc && !root.hasAttribute('data-pi-web-loading')) {
            if (doc === firstDocument && app.shadowRoot) {
              props.onStartupReady?.(true, focusPrompt);
            } else props.onStartupReady?.(true);
          }
        }, 5000);
      }
    };
    observer = new MutationObserver(check);
    observer.observe(root, { attributes: true, attributeFilter: ['data-pi-web-loading'] });
    check();
  };
  return <iframe class="pi-web-chat__frame" title="Pi Chat" src={props.src}
    onLoad={event => loaded(event.currentTarget)} />;
}

export default function PiWebChat(props: PiWebChatProps) {
  const [keyboardInset, setKeyboardInset] = createSignal(0);
  const [tablet, setTablet] = createSignal(false);
  const fitWorkspace = () => tablet() && props.fitTabletKeyboard;
  const innerKeyboardInset = () => fitWorkspace() ? 0 : keyboardInset();
  createEffect(() => props.onKeyboardInset?.(fitWorkspace() ? keyboardInset() : 0));
  const [frameRetry, setFrameRetry] = createSignal<{ src: string; attempts: number }>();
  const [frameFailed, setFrameFailed] = createSignal(false);
  const [foreground, setForeground] = createSignal(!document.hidden);
  const syncVisibility = () => setForeground(!document.hidden);
  onMount(() => {
    document.addEventListener('visibilitychange', syncVisibility);
    onCleanup(() => document.removeEventListener('visibilitychange', syncVisibility));
  });
  onMount(() => {
    disableVirtualKeyboardOverlay();
    const media = window.matchMedia?.('(width > 640px) and (pointer: coarse)');
    const updateTablet = () => setTablet(media?.matches ?? false);
    updateTablet();
    media?.addEventListener?.('change', updateTablet);
    onCleanup(() => media?.removeEventListener?.('change', updateTablet));
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Keyboard resizing often affects only the top-level visual viewport, not
    // the iframe. Do not treat pinch zoom as a keyboard.
    const fitViewport = () => setKeyboardInset(viewport.scale === 1
      ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      : 0);
    // A resumed document may not get a visualViewport event for the new size.
    const fitOnVisibilityReturn = () => { if (document.visibilityState === 'visible') fitViewport(); };
    const fitOnPageRestore = (event: PageTransitionEvent) => { if (event.persisted) fitOnVisibilityReturn(); };
    fitViewport();
    viewport.addEventListener('resize', fitViewport);
    viewport.addEventListener('scroll', fitViewport);
    document.addEventListener('visibilitychange', fitOnVisibilityReturn);
    window.addEventListener('pageshow', fitOnPageRestore);
    onCleanup(() => {
      viewport.removeEventListener('resize', fitViewport);
      viewport.removeEventListener('scroll', fitViewport);
      document.removeEventListener('visibilitychange', fitOnVisibilityReturn);
      window.removeEventListener('pageshow', fitOnPageRestore);
    });
  });

  const frameUrl = createMemo(() => {
    const { surface, target, phase, chatUrl } = props.status;
    if (!chatUrl || (surface !== 'chat' && !(phase === 'opening' && target === 'chat'))) return undefined;
    try {
      const url = new URL(chatUrl, window.location.origin);
      const prefix = `${piWebPrefix(props.sessionId)}g/${props.generation}/`;
      if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)
        || !/^a\/[a-f0-9-]{36}\/$/.test(url.pathname.slice(prefix.length))
        || url.username || url.password) return undefined;
      return url.href;
    } catch {
      return undefined;
    }
  });

  const frame = createMemo(() => {
    const src = frameUrl();
    // A generation change always remounts the frame, even for the same deep link.
    const retry = frameRetry();
    return src ? { src, generation: props.generation, attempts: retry?.src === src ? retry.attempts : 0 } : undefined;
  });

  createEffect(() => {
    const source = frame();
    if (!source || source.attempts >= 2 || !frameFailed() || !foreground() || props.recoveryEnabled === false || props.status.startupQuestion) return;
    const retry = setTimeout(() => {
      if (frame() === source && !document.hidden) setFrameRetry({ src: source.src, attempts: source.attempts + 1 });
    }, 1000);
    onCleanup(() => clearTimeout(retry));
  });

  return (
    <section class="pi-web-chat" aria-label="Pi Chat" style={{ 'margin-block-end': `${innerKeyboardInset()}px` }}>
      <PiWebSwitchControls progressInMenu={props.progressInMenu} phase={props.status.phase} target={props.switchingTarget ?? props.status.target}
        switching={!!props.switchingTarget} problem={props.problem}
        canCancel={props.canCancel} onCancel={props.onCancel} onRetry={props.onRetry} />
      <div class="pi-web-chat__space">
        <Show when={frame()} keyed
          fallback={<p role="status">{props.status.chatUrl ? 'Chat could not be opened.' : 'Preparing Chat…'}</p>}>
          {source => <StockChatFrame src={source.src} keyboardInset={innerKeyboardInset()} startupQuestion={props.status.startupQuestion} onPanelSize={props.onPanelSize} onStartupReady={props.onStartupReady} onStartupFailure={setFrameFailed} />}
        </Show>
      </div>
    </section>
  );
}
