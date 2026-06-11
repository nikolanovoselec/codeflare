import { describe, it, expect } from 'vitest';
import { schedulePanes, type PaneEvent } from '../scripts/fleet-scheduler';
import type { TerminalLine } from '../scripts/terminal-player';

const TIMINGS = { typeMs: 10, lineMs: 20, spinMs: 270, spinFrameMs: 90, pausePollMs: 50 };

const pane = (...lines: TerminalLine[]) => lines;

/** Count how many events are playing at a given instant. */
function concurrentAt(events: PaneEvent[], at: number): number {
  return events.filter((e) => e.at <= at && at < e.at + e.duration).length;
}

describe('fleet-scheduler', () => {
  const panes = [
    pane({ kind: 'cmd', text: 'fix flaky checkout test' }, { kind: 'line', text: '✓ done' }),
    pane({ kind: 'spin', text: '✻ migrating' }, { kind: 'line', text: '✓ backfilled' }),
    pane({ kind: 'line', text: 'plan: 3 to add' }, { kind: 'line', text: '✓ policies pass' }),
  ];

  it('schedules every line of every pane exactly once', () => {
    const events = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 2 });

    expect(events).toHaveLength(6);
    for (const [paneIndex, lines] of panes.entries()) {
      for (let line = 0; line < lines.length; line++) {
        expect(events.filter((e) => e.pane === paneIndex && e.line === line)).toHaveLength(1);
      }
    }
  });

  it('never exceeds the concurrency cap at any instant', () => {
    const events = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 2 });

    const instants = events.flatMap((e) => [e.at, e.at + e.duration / 2, e.at + e.duration - 1]);
    for (const at of instants) {
      expect(concurrentAt(events, at)).toBeLessThanOrEqual(2);
    }
  });

  it('serializes fully under a cap of 1 (mobile)', () => {
    const events = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 1 });

    const sorted = [...events].sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].at).toBeGreaterThanOrEqual(sorted[i - 1].at + sorted[i - 1].duration);
    }
  });

  it('hands off round-robin: each pane plays one line before any pane plays its second', () => {
    const events = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 1 });

    const order = [...events].sort((a, b) => a.at - b.at).map((e) => e.pane);
    expect(order.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('plays lines of one pane in order and never overlapping themselves', () => {
    const events = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 3 });

    for (let p = 0; p < panes.length; p++) {
      const own = events.filter((e) => e.pane === p).sort((a, b) => a.line - b.line);
      for (let i = 1; i < own.length; i++) {
        expect(own[i].at).toBeGreaterThanOrEqual(own[i - 1].at + own[i - 1].duration);
      }
    }
  });

  it('is deterministic: identical inputs produce identical schedules', () => {
    const a = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 2 });
    const b = schedulePanes(panes, TIMINGS, { maxConcurrentTypers: 2 });
    expect(a).toEqual(b);
  });

  it('accounts for per-line waitMs in the schedule', () => {
    const delayed = [pane({ kind: 'line', text: 'late', waitMs: 500 })];
    const events = schedulePanes(delayed, TIMINGS, { maxConcurrentTypers: 1 });
    expect(events[0].duration).toBe(500 + TIMINGS.lineMs);
  });
});
