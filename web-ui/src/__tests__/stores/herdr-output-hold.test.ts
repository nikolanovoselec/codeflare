import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  clearAllOutput,
  scheduleWrite,
  setHerdrScrollState,
  releaseTrailingOutput,
} from '../../stores/terminal-output';

const frame = (text: string) => `\x1b[?2026h${text}\x1b[?2026l`;

function terminal() {
  return {
    write: vi.fn(),
    buffer: { active: { type: 'alternate', viewportY: 0, baseY: 0 } },
  } as unknown as Terminal;
}

describe('Herdr output hold reuses the standard terminal buffer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearAllOutput();
    vi.useRealTimers();
  });

  it('publishes one forced full frame, then holds unrelated output', () => {
    const term = terminal();
    setHerdrScrollState('s:1', term, true, true);
    scheduleWrite('s:1', term, 'stale differential');
    scheduleWrite('s:1', term, frame('scrolled viewport'));
    vi.advanceTimersByTime(40);
    expect(term.write).toHaveBeenCalledOnce();
    expect(term.write).toHaveBeenLastCalledWith(frame('scrolled viewport'));

    scheduleWrite('s:1', term, frame('agent output'));
    vi.advanceTimersByTime(40);
    expect(term.write).toHaveBeenCalledOnce();
  });

  it('publishes each requested viewport and resumes from a full bottom frame', () => {
    const term = terminal();
    setHerdrScrollState('s:1', term, true, true);
    scheduleWrite('s:1', term, frame('first viewport'));
    vi.advanceTimersByTime(40);
    scheduleWrite('s:1', term, frame('held output'));
    vi.advanceTimersByTime(40);

    setHerdrScrollState('s:1', term, true, true);
    scheduleWrite('s:1', term, frame('second viewport'));
    vi.advanceTimersByTime(40);
    expect(term.write).toHaveBeenNthCalledWith(2, frame('second viewport'));

    setHerdrScrollState('s:1', term, true, false);
    scheduleWrite('s:1', term, frame('live bottom'));
    vi.advanceTimersByTime(40);
    scheduleWrite('s:1', term, 'following output');
    vi.advanceTimersByTime(40);
    expect(term.write).toHaveBeenNthCalledWith(3, frame('live bottom'));
    expect(term.write).toHaveBeenNthCalledWith(4, 'following output');
  });

  it('discards a held Herdr stream at final close without looping', () => {
    const term = terminal();
    setHerdrScrollState('s:1', term, true, true);
    scheduleWrite('s:1', term, frame('viewport'));
    vi.advanceTimersByTime(40);
    scheduleWrite('s:1', term, frame('held'));
    vi.advanceTimersByTime(40);
    releaseTrailingOutput('s:1', term);
    expect(term.write).toHaveBeenCalledOnce();
  });

  it('fails open when the Herdr query is unavailable', () => {
    const term = terminal();
    setHerdrScrollState('s:1', term, true, true);
    scheduleWrite('s:1', term, frame('held'));
    vi.advanceTimersByTime(40);
    scheduleWrite('s:1', term, frame('queued'));
    vi.advanceTimersByTime(40);

    setHerdrScrollState('s:1', term, false, false);
    vi.advanceTimersByTime(40);
    expect(term.write).toHaveBeenCalledTimes(2);
  });
});
