import { describe, it, expect } from 'vitest';
import {
  playTranscript,
  SPINNER_FRAMES,
  type PlayerAdapter,
  type TerminalLine,
} from '../scripts/terminal-player';

/**
 * Recording adapter: resolves sleeps immediately while advancing a fake
 * clock, so spin-frame timing is deterministic and tests run in
 * milliseconds. Captures every adapter call in order.
 */
function createRecordingAdapter(options: { pausedPolls?: number } = {}) {
  let clock = 0;
  let pausedPolls = options.pausedPolls ?? 0;
  const events: Array<{ op: string; index?: number; text?: string; ms?: number }> = [];

  const adapter: PlayerAdapter = {
    write(index, text) {
      events.push({ op: 'write', index, text });
    },
    reveal(index) {
      events.push({ op: 'reveal', index });
    },
    setCursor(index, visible) {
      events.push({ op: visible ? 'cursor-on' : 'cursor-off', index });
    },
    async sleep(ms) {
      clock += ms;
      events.push({ op: 'sleep', ms });
    },
    isPaused() {
      if (pausedPolls > 0) {
        pausedPolls -= 1;
        return true;
      }
      return false;
    },
    now() {
      return clock;
    },
  };

  return { adapter, events };
}

const TIMINGS = { typeMs: 10, lineMs: 20, spinMs: 270, spinFrameMs: 90, pausePollMs: 50 };

describe('terminal-player', () => {
  it('reveals lines strictly in transcript order', async () => {
    const lines: TerminalLine[] = [
      { kind: 'line', text: 'first' },
      { kind: 'line', text: 'second' },
      { kind: 'line', text: 'third' },
    ];
    const { adapter, events } = createRecordingAdapter();

    await playTranscript(lines, adapter, TIMINGS);

    const reveals = events.filter((e) => e.op === 'reveal').map((e) => e.index);
    expect(reveals).toEqual([0, 1, 2]);
  });

  it('types cmd lines character by character with the cursor on while typing', async () => {
    const lines: TerminalLine[] = [{ kind: 'cmd', text: 'git push' }];
    const { adapter, events } = createRecordingAdapter();

    await playTranscript(lines, adapter, TIMINGS);

    const writes = events.filter((e) => e.op === 'write').map((e) => e.text);
    // Accumulating prefixes: 'g', 'gi', 'git', ... up to the full command
    expect(writes[0]).toBe('g');
    expect(writes.at(-1)).toBe('git push');
    expect(writes).toHaveLength('git push'.length);

    const cursorOn = events.findIndex((e) => e.op === 'cursor-on');
    const firstWrite = events.findIndex((e) => e.op === 'write');
    const cursorOff = events.findIndex((e) => e.op === 'cursor-off');
    expect(cursorOn).toBeLessThan(firstWrite);
    expect(cursorOff).toBeGreaterThan(firstWrite);
  });

  it('animates spin lines through spinner frames and settles on the original text', async () => {
    const lines: TerminalLine[] = [{ kind: 'spin', text: '✻ planning' }];
    const { adapter, events } = createRecordingAdapter();

    await playTranscript(lines, adapter, TIMINGS);

    const writes = events.filter((e) => e.op === 'write').map((e) => e.text);
    // spinMs 270 / frame 90 = 3 spinner writes + 1 final settle write
    expect(writes).toHaveLength(4);
    expect(writes[0]).toBe(`${SPINNER_FRAMES[0]} planning`);
    expect(writes.at(-1)).toBe('✻ planning');
  });

  it('honors per-line waitMs before revealing the line', async () => {
    const lines: TerminalLine[] = [{ kind: 'line', text: 'delayed', waitMs: 700 }];
    const { adapter, events } = createRecordingAdapter();

    await playTranscript(lines, adapter, TIMINGS);

    const revealAt = events.findIndex((e) => e.op === 'reveal');
    const waitSleep = events.findIndex((e) => e.op === 'sleep' && e.ms === 700);
    expect(waitSleep).toBeGreaterThanOrEqual(0);
    expect(waitSleep).toBeLessThan(revealAt);
  });

  it('polls while paused and resumes playback when unpaused', async () => {
    const lines: TerminalLine[] = [{ kind: 'line', text: 'after pause' }];
    const { adapter, events } = createRecordingAdapter({ pausedPolls: 3 });

    await playTranscript(lines, adapter, TIMINGS);

    const pausePolls = events.filter((e) => e.op === 'sleep' && e.ms === TIMINGS.pausePollMs);
    expect(pausePolls).toHaveLength(3);
    expect(events.filter((e) => e.op === 'reveal')).toHaveLength(1);
  });
});
