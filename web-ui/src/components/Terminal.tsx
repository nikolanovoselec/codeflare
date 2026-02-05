import { Component, Show } from 'solid-js';
import '@xterm/xterm/css/xterm.css';
import { useTerminal } from '../hooks/useTerminal';
import InitProgress from './InitProgress';
import { isTouchDevice, isVirtualKeyboardOpen, getKeyboardHeight, enableVirtualKeyboardOverlay } from '../lib/mobile';
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

  let containerEl: HTMLDivElement | undefined;

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
      <Show when={!isInitializing() && connectionState() !== 'connected'}>
        <div class="terminal-connection-status">
          <div class="terminal-connection-spinner" />
          <span>{retryMessage() || 'Connecting...'}</span>
        </div>
      </Show>

      <div
        ref={(el) => { containerEl = el; containerRef(el); }}
        class="terminal-container"
        onPointerDown={(e: PointerEvent) => {
          const term = terminal();
          if (isTouchDevice() && term) {
            const target = e.target as HTMLElement;
            const isLink = target?.closest('.xterm-link') || target?.classList?.contains('xterm-link');
            if (!isLink) {
              e.preventDefault();
            }
            (term as any).__removeFocusGuard?.();
            enableVirtualKeyboardOverlay();
            const iframeInput = (term as any).__iframeInput as HTMLInputElement | undefined;
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
          'overflow-anchor': 'none',
          'touch-action': (isTouchDevice() && isVirtualKeyboardOpen()) ? 'none' : undefined,
        }}
      />

    </div>
  );
};

export default Terminal;
