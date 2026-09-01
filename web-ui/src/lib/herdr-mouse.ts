import type { Terminal } from '@xterm/xterm';
import type { TerminalLinkController } from './terminal-link-provider';

export type TerminalInputSender = (sequence: string) => void;

function modifierBits(event: MouseEvent | WheelEvent): number {
  return (event.shiftKey ? 4 : 0)
    + (event.altKey ? 8 : 0)
    + (event.ctrlKey ? 16 : 0);
}

export function terminalCell(
  screen: HTMLElement,
  terminal: Terminal,
  clientX: number,
  clientY: number,
): { column: number; row: number } | null {
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return null;
  const column = Math.min(terminal.cols, Math.max(1, Math.floor(((clientX - rect.left) / rect.width) * terminal.cols) + 1));
  const row = Math.min(terminal.rows, Math.max(1, Math.floor(((clientY - rect.top) / rect.height) * terminal.rows) + 1));
  return { column, row };
}

function sgrMouse(code: number, column: number, row: number, release = false): string {
  return `\x1b[<${code};${column};${row}${release ? 'm' : 'M'}`;
}

/** Send one touch tap using one geometry snapshot for both mouse reports. */
export function sendHerdrTap(
  screen: HTMLElement,
  terminal: Terminal,
  send: TerminalInputSender,
  clientX: number,
  clientY: number,
): void {
  const cell = terminalCell(screen, terminal, clientX, clientY);
  if (!cell) return;
  send(sgrMouse(0, cell.column, cell.row));
  send(sgrMouse(0, cell.column, cell.row, true));
}

/**
 * Send Herdr browser pointer input directly as SGR mouse reports.
 *
 * Herdr always enables mouse capture in Codeflare, but browser-hosted xterm
 * does not reliably expose native mouse reporting across desktop and
 * synthesized touch events. Owning the screen events here avoids depending on
 * xterm's private mouse service while preserving Herdr's terminal protocol.
 */
export function attachHerdrMouseInput(
  screen: HTMLElement,
  terminal: Terminal,
  send: TerminalInputSender,
  links?: Pick<TerminalLinkController, 'hasLinkAt' | 'activateLinkAt'>,
): () => void {
  let pressedButton: number | null = null;
  let linkPress: { column: number; row: number; canceled: boolean } | null = null;
  const document = screen.ownerDocument;

  const own = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button < 0 || event.button > 2) return;
    const cell = terminalCell(screen, terminal, event.clientX, event.clientY);
    if (!cell) return;
    if (
      event.button === 0
      && (event.ctrlKey || event.metaKey)
      && links?.hasLinkAt(cell.column, cell.row)
    ) {
      linkPress = { ...cell, canceled: false };
      own(event);
      return;
    }
    pressedButton = event.button;
    send(sgrMouse(event.button + modifierBits(event), cell.column, cell.row));
    terminal.focus();
    own(event);
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (linkPress) {
      const cell = terminalCell(screen, terminal, event.clientX, event.clientY);
      if (!cell || cell.column !== linkPress.column || cell.row !== linkPress.row) {
        linkPress.canceled = true;
      }
      own(event);
      return;
    }
    if (pressedButton === null || event.buttons === 0) return;
    const cell = terminalCell(screen, terminal, event.clientX, event.clientY);
    if (!cell) return;
    send(sgrMouse(pressedButton + 32 + modifierBits(event), cell.column, cell.row));
    own(event);
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (linkPress) {
      const cell = terminalCell(screen, terminal, event.clientX, event.clientY);
      const start = linkPress;
      linkPress = null;
      if (!start.canceled && cell?.column === start.column && cell.row === start.row) {
        links?.activateLinkAt(start.column, start.row);
      }
      own(event);
      return;
    }
    if (pressedButton === null) return;
    const cell = terminalCell(screen, terminal, event.clientX, event.clientY);
    if (cell) {
      send(sgrMouse(pressedButton + modifierBits(event), cell.column, cell.row, true));
    }
    pressedButton = null;
    own(event);
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    const cell = terminalCell(screen, terminal, event.clientX, event.clientY);
    if (!cell) return;
    const button = event.deltaY < 0 ? 64 : 65;
    send(sgrMouse(button + modifierBits(event), cell.column, cell.row));
    own(event);
  };

  const onContextMenu = (event: MouseEvent): void => own(event);

  screen.addEventListener('mousedown', onMouseDown, { capture: true });
  document.addEventListener('mousemove', onMouseMove, { capture: true });
  document.addEventListener('mouseup', onMouseUp, { capture: true });
  screen.addEventListener('wheel', onWheel, { capture: true, passive: false });
  screen.addEventListener('contextmenu', onContextMenu, { capture: true });

  return () => {
    pressedButton = null;
    linkPress = null;
    screen.removeEventListener('mousedown', onMouseDown, { capture: true });
    document.removeEventListener('mousemove', onMouseMove, { capture: true });
    document.removeEventListener('mouseup', onMouseUp, { capture: true });
    screen.removeEventListener('wheel', onWheel, { capture: true });
    screen.removeEventListener('contextmenu', onContextMenu, { capture: true });
  };
}
