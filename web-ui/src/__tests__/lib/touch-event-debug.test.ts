import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTouchEventDebug } from '../../lib/touch-event-debug';

describe('touch event debug trace', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records final cancellation state, touch origin, targets, and move count', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(120)
      .mockReturnValueOnce(130);
    const traces: Array<readonly string[]> = [];
    const cleanup = attachTouchEventDebug(window, (lines) => traces.push(lines));
    const target = document.createElement('div');
    target.id = 'terminal-trace-target';
    document.body.appendChild(target);

    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(click, 'sourceCapabilities', {
      value: { firesTouchEvents: true },
    });
    target.addEventListener('click', (event) => event.preventDefault(), { once: true });
    target.dispatchEvent(click);
    await Promise.resolve();

    const lines = traces[traces.length - 1] ?? [];
    expect(lines.some((line) => line.includes('touchend') && line.includes('moves=2'))).toBe(true);
    expect(lines.some((line) => line.includes('click')
      && line.includes('prevented=1')
      && line.includes('touchSource=1')
      && line.includes('target=div#terminal-trace-target'))).toBe(true);

    cleanup();
    target.remove();
  });
});
