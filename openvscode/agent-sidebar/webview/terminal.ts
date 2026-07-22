import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export function mountClaudeTerminal(root: HTMLElement, api: VsCodeApi = acquireVsCodeApi()): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.append(
    button('New conversation', () => api.postMessage({ type: 'newConversation' })),
    button('Send Ctrl+C', () => api.postMessage({ type: 'abort' })),
  );

  const container = document.createElement('div');
  container.className = 'terminal';
  container.setAttribute('aria-label', 'Claude Code terminal');
  root.replaceChildren(toolbar, container);

  const colors = getComputedStyle(document.documentElement);
  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    scrollback: 5_000,
    fontFamily: colors.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace',
    fontSize: 13,
    theme: {
      background: colors.getPropertyValue('--vscode-sideBar-background').trim() || '#1e1e1e',
      foreground: colors.getPropertyValue('--vscode-foreground').trim() || '#cccccc',
      cursor: colors.getPropertyValue('--vscode-terminal-ansiWhite').trim() || '#ffffff',
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);

  terminal.onData((data) => api.postMessage({ type: 'terminal.input', data }));
  const resize = (): void => {
    try {
      fit.fit();
      if (terminal.cols > 0 && terminal.rows > 0) {
        api.postMessage({ type: 'terminal.resize', columns: terminal.cols, rows: terminal.rows });
      }
    } catch {
      // The view can be detached while ResizeObserver has a queued callback.
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  requestAnimationFrame(resize);

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isRecord(message) || typeof message.type !== 'string') return;
    if (message.type === 'terminal.output' && typeof message.data === 'string') {
      terminal.write(message.data);
      return;
    }
    if (message.type === 'conversation.reset') terminal.clear();
  });

  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    terminal.dispose();
  }, { once: true });
  terminal.focus();
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const root = document.getElementById('app');
if (root) mountClaudeTerminal(root);
