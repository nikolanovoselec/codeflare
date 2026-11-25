import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { piWebPrefix, type PiWebStatus } from '../api/pi-web';
import { disableVirtualKeyboardOverlay } from '../lib/mobile';
import PiWebSwitchControls from './PiWebSwitchControls';

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
  onStartupReady?: (ready: boolean) => void;
  onStartupFailure?: (failed: boolean) => void;
}

function StockChatFrame(props: { src: string; onStartupReady?: (ready: boolean) => void; onStartupFailure?: (failed: boolean) => void }) {
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { observer?.disconnect(); clearTimeout(timer); };
  onCleanup(() => { cancel(); props.onStartupReady?.(false); props.onStartupFailure?.(false); });

  const loaded = (frame: HTMLIFrameElement) => {
    cancel();
    props.onStartupReady?.(false);
    const doc = frame.contentDocument;
    if (!doc || new URL(doc.URL).pathname !== new URL(props.src).pathname || !doc.querySelector('pi-web-app')) {
      props.onStartupFailure?.(true);
      return;
    }
    props.onStartupFailure?.(false);
    if (!props.onStartupReady) return;
    const root = doc.documentElement;
    const check = () => {
      clearTimeout(timer);
      if (root.hasAttribute('data-pi-web-loading')) {
        props.onStartupReady?.(false);
      } else {
        timer = setTimeout(() => {
          if (frame.isConnected && frame.contentDocument === doc && !root.hasAttribute('data-pi-web-loading')) {
            props.onStartupReady?.(true);
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
  const [frameRevision, setFrameRevision] = createSignal(0);
  const [frameFailed, setFrameFailed] = createSignal(false);
  onMount(() => {
    disableVirtualKeyboardOverlay();
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Keyboard resizing often affects only the top-level visual viewport, not
    // the iframe. Do not treat pinch zoom as a keyboard.
    const fitViewport = () => setKeyboardInset(viewport.scale === 1
      ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      : 0);
    fitViewport();
    viewport.addEventListener('resize', fitViewport);
    viewport.addEventListener('scroll', fitViewport);
    onCleanup(() => {
      viewport.removeEventListener('resize', fitViewport);
      viewport.removeEventListener('scroll', fitViewport);
    });
  });

  const frameUrl = createMemo(() => {
    const { surface, target, phase, chatUrl } = props.status;
    if (!chatUrl || (surface !== 'chat' && !(phase === 'opening' && target === 'chat'))) return undefined;
    try {
      const url = new URL(chatUrl, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== `${piWebPrefix(props.sessionId)}g/${props.generation}/`
        || url.username || url.password) return undefined;
      return url.href;
    } catch {
      return undefined;
    }
  });

  const frame = createMemo(() => {
    const src = frameUrl();
    // A generation change always remounts the frame, even for the same deep link.
    return src ? { src, generation: props.generation, revision: frameRevision() } : undefined;
  });

  return (
    <section class="pi-web-chat" aria-label="Pi Chat" style={{ 'margin-block-end': `${keyboardInset()}px` }}>
      <Show when={frameUrl() && frameFailed()}>
        <div class="pi-web-controls">
          <button type="button" class="pi-web-action" onClick={() => setFrameRevision(value => value + 1)}>Reload Chat</button>
        </div>
      </Show>
      <PiWebSwitchControls progressInMenu={props.progressInMenu} phase={props.status.phase} target={props.switchingTarget ?? props.status.target}
        switching={!!props.switchingTarget} problem={props.problem}
        canCancel={props.canCancel} onCancel={props.onCancel} onRetry={props.onRetry} />
      <div class="pi-web-chat__space">
        <Show when={frame()} keyed
          fallback={<p role="status">{props.status.chatUrl ? 'Chat could not be opened.' : 'Preparing Chat…'}</p>}>
          {source => <StockChatFrame src={source.src} onStartupReady={props.onStartupReady} onStartupFailure={failed => {
            setFrameFailed(failed);
            props.onStartupFailure?.(failed);
          }} />}
        </Show>
      </div>
    </section>
  );
}
