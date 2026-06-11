/**
 * Deterministic interleaving for the post-split fleet playback. Slots model
 * the concurrency cap (2 typers on desktop, 1 on mobile); panes hand off
 * round-robin after each line so the fleet reads as scheduling, not as four
 * synchronized animations. The schedule terminates by construction — every
 * pane cursor only advances.
 */
import type { PlayerTimings, TerminalLine } from './terminal-player';

export interface PaneEvent {
  pane: number;
  line: number;
  /** Start offset in ms from playback begin. */
  at: number;
  duration: number;
}

export interface ScheduleOptions {
  maxConcurrentTypers: number;
}

function lineDuration(line: TerminalLine, timings: PlayerTimings): number {
  const wait = line.waitMs ?? 0;
  if (line.kind === 'cmd') {
    return wait + line.text.length * timings.typeMs;
  }
  if (line.kind === 'spin') {
    return wait + timings.spinMs;
  }
  return wait + timings.lineMs;
}

export function schedulePanes(
  panes: readonly (readonly TerminalLine[])[],
  timings: PlayerTimings,
  options: ScheduleOptions
): PaneEvent[] {
  const cap = Math.max(1, options.maxConcurrentTypers);
  const slotFreeAt = new Array<number>(cap).fill(0);
  const paneFreeAt = new Array<number>(panes.length).fill(0);
  const cursors = new Array<number>(panes.length).fill(0);

  // Round-robin queue: a pane re-enters at the back after playing one line.
  const queue = panes.map((_, index) => index).filter((index) => panes[index].length > 0);
  const events: PaneEvent[] = [];

  while (queue.length > 0) {
    const pane = queue.shift()!;
    const lineIndex = cursors[pane];
    const line = panes[pane][lineIndex];

    // Earliest slot under the cap; the pane itself must also be free.
    let slot = 0;
    for (let s = 1; s < cap; s++) {
      if (slotFreeAt[s] < slotFreeAt[slot]) {
        slot = s;
      }
    }
    const at = Math.max(slotFreeAt[slot], paneFreeAt[pane]);
    const duration = lineDuration(line, timings);

    events.push({ pane, line: lineIndex, at, duration });
    slotFreeAt[slot] = at + duration;
    paneFreeAt[pane] = at + duration;

    cursors[pane] += 1;
    if (cursors[pane] < panes[pane].length) {
      queue.push(pane);
    }
  }

  return events;
}
