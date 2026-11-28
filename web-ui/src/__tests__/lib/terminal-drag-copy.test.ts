import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalDragCopy } from '../../lib/terminal-drag-copy';

// Exercise the event boundary with browser event records; real clipboard permission is browser-owned.
function fixture({ rows = ['alpha', 'bravo'], wrapped = false, tracking = true } = {}) {
  const screen = document.createElement('div');
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 50, 20));
  const terminal = { cols: 5, rows: 2, modes: { mouseTrackingMode: tracking ? 'drag' : 'none' }, options: {}, buffer: { active: { type: 'alternate', viewportY: 0,
    getLine: (row: number) => ({ isWrapped: row === 1 && wrapped, translateToString: (_trim: boolean, start: number, end: number) => rows[row].slice(start, end),
      getCell: () => ({ getWidth: () => 1 }) }),
  } } } as unknown as Terminal;
  const write = vi.fn<(text: string) => void>();
  const handlers = new Map<string, EventListener>();
  const listen = (type: string, listener: EventListenerOrEventListenerObject) => handlers.set(type, listener as EventListener);
  vi.spyOn(screen, 'addEventListener').mockImplementation(listen);
  const cleanup = attachTerminalDragCopy(screen, terminal, () => true, write);
  const event = (type: string, x: number, y: number, trusted = true) => handlers.get(type)?.({
    isTrusted: trusted, isPrimary: true, pointerType: 'mouse', pointerId: 1, button: 0,
    clientX: x, clientY: y, preventDefault: () => { throw new Error('Pi must still receive mouse input'); },
    stopPropagation: () => { throw new Error('Pi must still receive mouse input'); },
  } as unknown as PointerEvent);
  return { cleanup, event, write };
}

describe('Classic fullscreen browser clipboard', () => {
  it('copies the displayed cells across rows from an ordinary trusted drag', () => {
    const { cleanup, event, write } = fixture();
    try {
      event('pointerdown', 12, 5);
      event('pointerup', 22, 15);
      expect(write).toHaveBeenCalledWith('lpha\nbra');
    } finally { cleanup(); }
  });

  it('joins soft-wrapped rows without inserting a newline', () => {
    const { cleanup, event, write } = fixture({ rows: ['https', '://a/'], wrapped: true });
    try {
      event('pointerdown', 2, 5);
      event('pointerup', 42, 15);
      expect(write).toHaveBeenCalledWith('https://a/');
    } finally { cleanup(); }
  });

  it.each([{ tracking: false }, { rows: ['     ', '     '] }])('leaves the clipboard alone for an ineligible or blank drag (%j)', options => {
    const { cleanup, event, write } = fixture(options);
    try {
      event('pointerdown', 12, 5);
      event('pointerup', 22, 15);
      expect(write).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('leaves clicks, out-of-pane releases and synthetic gestures alone', () => {
    const { cleanup, event, write } = fixture();
    try {
      event('pointerdown', 12, 5);
      event('pointerup', 12, 5);
      event('pointerdown', 12, 5);
      event('pointerup', 51, 15);
      event('pointerdown', 12, 5, false);
      event('pointerup', 22, 15);
      expect(write).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
