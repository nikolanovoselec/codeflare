import { Component, Show, createSignal, createEffect } from 'solid-js';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import InitProgress from './InitProgress';
import { isTouchDevice, isIOSDevice, getKeyboardHeight, enableVirtualKeyboardOverlay } from '../lib/mobile';
import { getRemoveFocusGuard, getIframeInput } from '../lib/xterm-internals';
import '../styles/terminal.css';

interface TerminalProps {
  sessionId: string;
  terminalId: string;
  sessionName?: string;
  active: boolean;
  visible?: boolean;
  focused?: boolean;
  connect?: boolean;
  /** When true, always observe resize (used in tiled mode where multiple terminals are visible) */
  alwaysObserveResize?: boolean;
  /** When true, skip rendering the per-terminal InitProgress overlay (used in tiled mode) */
  hideInitProgress?: boolean;
  onError?: (error: string) => void;
  onInitComplete?: () => void;
}

const Terminal: Component<TerminalProps> = (props) => {
  const isVisible = () => props.visible ?? props.active;
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
        visibility: isVisible() ? 'visible' : 'hidden',
        position: isVisible() ? 'relative' : 'absolute',
        height: isVisible() ? '100%' : '0',
        overflow: isVisible() ? undefined : 'hidden',
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
        on:click={() => {
          const term = terminal();
          if (isTouchDevice() && term) {
            getRemoveFocusGuard(term)?.();
            enableVirtualKeyboardOverlay();
            // iOS Safari requires .focus() synchronously in the user-gesture call
            // stack or the virtual keyboard never opens. Android Chrome and Samsung
            // Internet need setTimeout(0) for reliable cross-frame focus timing on
            // iframe inputs. We branch on platform to satisfy both constraints.
            // Uses on:click (direct addEventListener) instead of onClick (SolidJS
            // delegation) so iOS Safari recognizes it as a user gesture.
            const doFocus = () => {
              const t = terminal();
              if (!t) return;
              const input = getIframeInput(t);
              if (input) {
                input.focus({ preventScroll: true });
              } else {
                t.textarea?.focus({ preventScroll: true });
              }
            };
            if (isIOSDevice()) {
              doFocus();
            } else {
              setTimeout(doFocus, 0);
            }
          }
        }}
        style={{
          width: '100%',
          flex: '1',
          'min-height': '0',
          // overflow:hidden prevents xterm's canvas from bleeding into the
          // padding-bottom area during the brief window between keyboard height
          // signal update (which shrinks this container via padding on the wrapper)
          // and the fit() call that resizes the canvas to match.
          overflow: 'hidden',
          'background-color': isInitializing() ? 'transparent' : 'var(--color-terminal-theme-bg)',
          visibility: isInitializing() ? 'hidden' : 'visible',
          'overflow-anchor': 'none',
          '-webkit-user-select': isTouchDevice() ? 'none' : undefined,
          'user-select': isTouchDevice() ? 'none' : undefined,
          'touch-action': isTouchDevice() ? 'none' : undefined,
        }}
      />

    </div>
  );
};

export default Terminal;
