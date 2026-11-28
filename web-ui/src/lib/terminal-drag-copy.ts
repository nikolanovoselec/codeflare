import type { Terminal } from '@xterm/xterm';

/** Copy only the displayed cells in a trusted drag. Leave Pi's mouse stream alone. */
export function attachTerminalDragCopy(
  screen: HTMLElement,
  terminal: Terminal,
  enabled: () => boolean,
  write: (text: string) => void,
): () => void {
  const point = (event: PointerEvent) => {
    const { left, top, width, height } = screen.getBoundingClientRect();
    const { cols, rows } = terminal;
    const x = event.clientX - left;
    const y = event.clientY - top;
    if (!cols || !rows || width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return;
    return { col: Math.floor(x * cols / width), row: Math.floor(y * rows / height), cols, rows };
  };
  let start: (NonNullable<ReturnType<typeof point>> & { id: number; viewport: number }) | undefined;
  const allowed = (event: PointerEvent) => event.isTrusted && event.isPrimary && event.pointerType === 'mouse'
    && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && enabled() && terminal.buffer.active.type === 'alternate';
  const down = (event: PointerEvent) => {
    start = undefined;
    const cell = allowed(event) ? point(event) : undefined;
    if (cell) start = { ...cell, id: event.pointerId, viewport: terminal.buffer.active.viewportY };
  };
  const cancel = () => { start = undefined; };
  const up = (event: PointerEvent) => {
    const first = start;
    cancel();
    if (!first || first.id !== event.pointerId || !allowed(event)) return;
    const last = point(event);
    const buffer = terminal.buffer.active;
    if (!last || first.cols !== last.cols || first.rows !== last.rows || first.viewport !== buffer.viewportY) return;
    if (first.row === last.row && first.col === last.col) return;
    const forward = first.row * first.cols + first.col < last.row * last.cols + last.col;
    const [from, to] = forward ? [first, last] : [last, first];
    const lines: string[] = [];
    for (let row = from.row; row <= to.row; row++) {
      const line = buffer.getLine(row + buffer.viewportY);
      if (!line) return;
      let begin = row === from.row ? from.col : 0;
      let end = row === to.row ? to.col + 1 : terminal.cols;
      // Include a whole wide glyph when the pointer lands on its continuation cell.
      if (begin > 0 && line.getCell(begin)?.getWidth() === 0) begin--;
      if (end < terminal.cols && line.getCell(end)?.getWidth() === 0) end++;
      lines.push(line.translateToString(true, begin, end));
    }
    const text = lines.join('\n');
    if (text.trim()) write(text);
  };
  screen.addEventListener('pointerdown', down, true);
  screen.addEventListener('pointerup', up, true);
  screen.addEventListener('pointerleave', cancel);
  screen.addEventListener('pointercancel', cancel, true);
  return () => {
    screen.removeEventListener('pointerdown', down, true);
    screen.removeEventListener('pointerup', up, true);
    screen.removeEventListener('pointerleave', cancel);
    screen.removeEventListener('pointercancel', cancel, true);
  };
}
