import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachWheelScrolling } from '../../lib/terminal-wheel';

// pxPerLine = max(12, round(14 * 1.2)) = 17 — mirrors getScrollPxPerLine.
const PX_PER_LINE = 17;

function makeWheelTerminal(overrides: Record<string, unknown> = {}) {
  const scrollLines = vi.fn();
  const terminal = {
    rows: 25,
    options: { fontSize: 14, lineHeight: 1.2 },
    refresh: vi.fn(),
    scrollLines: vi.fn(),
    buffer: { active: { type: 'normal', viewportY: 500, baseY: 1000 } },
    _core: { _bufferService: { scrollLines } },
    ...overrides,
  } as any;
  return { terminal, scrollLines };
}

function wheel(deltaY: number, init: WheelEventInit = {}): WheelEvent {
  return new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true, ...init });
}

describe('terminal-wheel / REQ-TERM-014 AC7 buffer-authoritative wheel scrolling', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
  });

  it('converts pixel deltas to whole lines through the buffer service and repaints', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    const event = wheel(PX_PER_LINE * 3);
    container.dispatchEvent(event);

    expect(scrollLines).toHaveBeenCalledWith(3);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 24);
    expect(event.defaultPrevented).toBe(true);
    // The public viewport-relative path must never be exercised.
    expect(terminal.scrollLines).not.toHaveBeenCalled();
  });

  it('accumulates sub-line pixel deltas across events until a full line is reached', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    container.dispatchEvent(wheel(-10));
    expect(scrollLines).not.toHaveBeenCalled();
    container.dispatchEvent(wheel(-10));
    expect(scrollLines).toHaveBeenCalledWith(-1);
  });

  it('owns sub-line wheel events so no tick leaks into the DOM-relative path', () => {
    const { terminal } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    const event = wheel(2);
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('treats line-mode deltas as lines directly', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    container.dispatchEvent(wheel(-3, { deltaMode: WheelEvent.DOM_DELTA_LINE }));
    expect(scrollLines).toHaveBeenCalledWith(-3);
  });

  it('converts page-mode deltas to rows-1 lines per page', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    container.dispatchEvent(wheel(1, { deltaMode: WheelEvent.DOM_DELTA_PAGE }));
    expect(scrollLines).toHaveBeenCalledWith(24);
  });

  it('passes alternate-buffer wheel events through to xterm untouched', () => {
    const { terminal, scrollLines } = makeWheelTerminal({
      buffer: { active: { type: 'alternate', viewportY: 0, baseY: 0 } },
    });
    attachWheelScrolling(container, terminal);

    const event = wheel(PX_PER_LINE * 2);
    container.dispatchEvent(event);

    expect(scrollLines).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('passes ctrl-modified wheel (browser zoom / pinch) through untouched', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    const event = wheel(PX_PER_LINE * 2, { ctrlKey: true });
    container.dispatchEvent(event);

    expect(scrollLines).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores pure horizontal wheel events', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    attachWheelScrolling(container, terminal);

    const event = wheel(0, { deltaX: 40 });
    container.dispatchEvent(event);

    expect(scrollLines).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('cleanup detaches the listener', () => {
    const { terminal, scrollLines } = makeWheelTerminal();
    const cleanup = attachWheelScrolling(container, terminal);
    cleanup();

    container.dispatchEvent(wheel(PX_PER_LINE * 3));
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
