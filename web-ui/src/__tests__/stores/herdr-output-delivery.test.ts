import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { clearAllOutput, scheduleWrite } from '../../stores/terminal-output';

const frame = (text: string) => `\x1b[?2026h${text}\x1b[?2026l`;

function terminal() {
  return {
    write: vi.fn(),
    buffer: { active: { type: 'alternate', viewportY: 0, baseY: 0 } },
  } as unknown as Terminal;
}

describe('Herdr differential output delivery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearAllOutput();
    vi.useRealTimers();
  });

  it('delivers every complete frame immediately and in order', () => {
    const term = terminal();
    scheduleWrite('s:1', term, frame('first differential'));
    vi.advanceTimersByTime(40);
    scheduleWrite('s:1', term, frame('second differential'));
    vi.advanceTimersByTime(40);

    expect(term.write).toHaveBeenNthCalledWith(1, frame('first differential'));
    expect(term.write).toHaveBeenNthCalledWith(2, frame('second differential'));
  });
});
