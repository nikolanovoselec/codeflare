import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { piWebPrefix, type PiWebStatus } from '../api/pi-web';
import { isPiWebSwitchPending } from '../hooks/usePiWebSurface';
import { disableVirtualKeyboardOverlay } from '../lib/mobile';
import PiWebSwitchControls from './PiWebSwitchControls';

interface PiWebChatProps {
  sessionId: string;
  generation: number;
  status: PiWebStatus;
  onTerminal: () => void;
  onCancel: () => void;
  onRetry?: () => void;
  problem?: string;
  canCancel?: boolean;
  switching?: boolean;
}

export default function PiWebChat(props: PiWebChatProps) {
  const [keyboardInset, setKeyboardInset] = createSignal(0);
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
      if (url.origin !== window.location.origin || url.pathname !== piWebPrefix(props.sessionId)
        || url.username || url.password) return undefined;
      return url.href;
    } catch {
      return undefined;
    }
  });

  const frame = createMemo(() => {
    const src = frameUrl();
    // A generation change always remounts the frame, even for the same deep link.
    return src ? { src, generation: props.generation } : undefined;
  });

  return (
    <section class="pi-web-chat" aria-label="Pi Chat" style={{ 'margin-block-end': `${keyboardInset()}px` }}>
      <div class="pi-web-controls">
        <button type="button" class="pi-web-action" disabled={!frameUrl() || props.switching || isPiWebSwitchPending(props.status)}
          onClick={() => props.onTerminal()}>Switch to Terminal</button>
      </div>
      <PiWebSwitchControls phase={props.status.phase} problem={props.problem}
        canCancel={props.canCancel} onCancel={props.onCancel} onRetry={props.onRetry} />
      <div class="pi-web-chat__space">
        <Show when={frame()} keyed
          fallback={<p role="status">{props.status.chatUrl ? 'Chat could not be opened.' : 'Preparing Chat…'}</p>}>
          {source => <iframe class="pi-web-chat__frame" title="Pi Chat" src={source.src} />}
        </Show>
      </div>
    </section>
  );
}
