import { Component, Show, createSignal, createEffect } from 'solid-js';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import InitProgress from './InitProgress';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight, enableVirtualKeyboardOverlay } from '../lib/mobile';
import { getRemoveFocusGuard, getIframeInput } from '../lib/xterm-internals';
import '../styles/terminal.css';

interface TerminalProps {
  sessionId: string;
  terminalId: string;
  sessionName?: string;
  active: boolean;
  /** When true, always observe resize (used in tiled mode where multiple terminals are visible) */
  alwaysObserveResize?: boolean;
  /** When true, skip rendering the per-terminal InitProgress overlay (used in tiled mode) */
  hideInitProgress?: boolean;
  onError?: (error: string) => void;
  onInitComplete?: () => void;
}

const Terminal: Component<TerminalProps> = (props) => {
  const {
    containerRef,
    terminal,
    retryMessage,
    connectionState,
    isInitializing,
    initProgress,
  } = useTerminal(props);

  // Once connected the first time, never show the overlay again.
  // This enables transparent reconnection without a flash of "Connecting...".
  const [hasConnected, setHasConnected] = createSignal(false);
  createEffect(() => {
    if (connectionState() === 'connected') setHasConnected(true);
  });

  let _containerEl: HTMLDivElement | undefined;

  return (
    <div
      class="terminal-wrapper"
      style={{
        display: 'flex',
        width: '100%',
        visibility: props.active ? 'visible' : 'hidden',
        position: props.active ? 'relative' : 'absolute',
        height: props.active ? '100%' : '0',
        overflow: props.active ? undefined : 'hidden',
        'flex-direction': 'column',
        'min-height': '0',
        'padding-bottom': isTouchDevice() ? `${getKeyboardHeight()}px` : undefined,
      }}
    >
      {/* Per-session initialization progress overlay (hidden in tiled mode -- rendered at TerminalArea level instead) */}
      <Show when={isInitializing() && !props.hideInitProgress}>
        <div class="terminal-init-overlay">
          <InitProgress
            sessionName={props.sessionName || 'Terminal'}
            progress={initProgress()}
            onOpen={props.onInitComplete}
          />
        </div>
      </Show>

      {/* Connection status overlay - show until actually connected (not just during retries) */}
      {/* This fixes ghost cursor bug on page reload: covers terminal before WebSocket connects */}
      <Show when={!isInitializing() && !hasConnected()}>
        <div class="terminal-connection-status">
          <div class="terminal-connection-spinner" />
          <span>{retryMessage() || 'Connecting...'}</span>
        </div>
      </Show>

      {/* Text selection prevented via user-select CSS instead of
          e.preventDefault() on pointerdown — preventDefault blocks native scroll */}
      <div
        ref={(el) => { _containerEl = el; containerRef(el); }}
        class="terminal-container"
        onClick={() => {
          const term = terminal();
          if (isTouchDevice() && term) {
            getRemoveFocusGuard(term)?.();
            enableVirtualKeyboardOverlay();
            const iframeInput = getIframeInput(term);
            setTimeout(() => {
              if (iframeInput) {
                iframeInput.focus({ preventScroll: true });
              } else {
                term?.textarea?.focus({ preventScroll: true });
              }
            }, 0);
          }
        }}
        style={{
          width: '100%',
          flex: '1',
          'min-height': '0',
          'background-color': isInitializing() ? 'transparent' : 'var(--color-terminal-theme-bg)',
          visibility: isInitializing() ? 'hidden' : 'visible',
          'overflow-anchor': 'none',
          '-webkit-user-select': isTouchDevice() ? 'none' : undefined,
          'user-select': isTouchDevice() ? 'none' : undefined,
          'touch-action': isTouchDevice() ? (isVirtualKeyboardOpen() ? 'none' : 'pan-y') : undefined,
        }}
      />

    </div>
  );
};

export default Terminal;
