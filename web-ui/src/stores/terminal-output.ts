/**
 * Terminal output pipeline: write batching, DEC 2026 synchronized-frame
 * reassembly, and scrollback read-hold (AD104/AD105/AD110/AD111), extracted
 * from the terminal store. Owns the per-key write buffers, flush timers, and
 * frame assemblers; the store calls in at the WebSocket message/close/dispose
 * seams. Keyed by the store's `sessionId:terminalId` compound key.
 */
import type { Terminal } from '@xterm/xterm';
import { recordFlush } from '../lib/ws-debug';
import { createFrameAssembler, type FrameAssembler } from '../lib/terminal-frames';
import { cleanupMapByPrefix } from '../lib/map-utils';

// Write batching — coalesce rapid WebSocket messages into a single terminal.write()
// at 30fps (every ~33ms). At 60fps each frame triggers a render pass with layout
// invalidation; halving to 30fps cuts renderRows style recalcs roughly in half
// during burst output while keeping latency imperceptible (~33ms vs ~16ms).
const WRITE_FLUSH_INTERVAL_MS = 33;
const writeBuffers = new Map<string, string[]>();
const pendingFlushes = new Map<string, number>();

// DEC 2026 synchronized frames are reassembled at ingest so a full-screen
// agent redraw split across WebSocket messages reaches xterm as ONE write —
// keeping the frame inside xterm's synchronized-output window instead of
// letting its 1,000 ms safety timeout paint a partially rebuilt transcript.
// The queue below therefore holds atomic units: ordinary chunk runs or whole
// frames (see lib/terminal-frames.ts).
const frameAssemblers = new Map<string, FrameAssembler>();
interface HerdrOutputGate {
  holding: boolean;
  publishNext: 'hold' | 'resume' | null;
}
const herdrOutputGates = new Map<string, HerdrOutputGate>();
const nextSynchronizedFrameCallbacks = new Map<string, () => void>();
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

// Cap on output held while the user reads scrollback. Beyond this the OLDEST
// held chunks are dropped (ring semantics) so held PTY output cannot grow
// memory without bound. Dropped bytes were destined for scrollback trimming
// anyway — writing them through a reader would drag the viewport to the top
// line by line (xterm pins a scrolled-up viewport at ydisp 0 while a full
// buffer trims).
export const READ_HOLD_MAX_CHARS = 2_000_000;

// Bound on characters released per flush tick once the viewport returns to
// the bottom. Releasing the entire hold in one write() leaves xterm parsing
// the backlog for seconds — a reader who scrolls up again mid-parse is
// dragged to the top by the continuing trims. Bounded slices re-check the
// reading state between ticks, so scrolling up mid-release re-defers the
// remainder within one interval.
export const RELEASE_SLICE_MAX_CHARS = 65_536;

/**
 * Whether the user is reading normal-buffer scrollback (viewport above the
 * live bottom). Alternate-buffer applications have no scrollback to read, so
 * they never defer.
 */
function isReadingScrollback(terminal: Terminal): boolean {
  const active = terminal.buffer.active;
  return active.type === 'normal' && active.viewportY < active.baseY;
}

export function flushWriteBuffer(key: string, terminal: Terminal): void {
  // Clear-then-delete: when invoked directly (the final-close drain loop)
  // rather than as a fired timer callback, a previously armed timer may still
  // be live — a bare map delete would orphan it to fire later against a
  // future session's buffer for the same key. clearTimeout on an
  // already-fired timer is a no-op, so this is safe on the timer path too.
  const armed = pendingFlushes.get(key);
  if (armed !== undefined) clearTimeout(armed);
  pendingFlushes.delete(key);
  const assembler = frameAssemblers.get(key);
  let buffer = writeBuffers.get(key);

  // Fail-open reap: a synchronized frame whose stream stalled, or an idle
  // marker-prefix carry, is released into the queue instead of parking
  // forever inside the assembler.
  const reaped = assembler ? assembler.reap(Date.now()) : [];
  if (reaped.length > 0) {
    if (!buffer) {
      buffer = [];
      writeBuffers.set(key, buffer);
    }
    buffer.push(...reaped);
  }

  if (!buffer || buffer.length === 0) {
    // Nothing queued, but a frame may still be assembling — keep the tick
    // alive so the fail-open reaper runs even if no further bytes arrive.
    if (assembler?.hasPending()) {
      const timerId = window.setTimeout(() => flushWriteBuffer(key, terminal), WRITE_FLUSH_INTERVAL_MS);
      pendingFlushes.set(key, timerId);
    }
    return;
  }

  const herdrGate = herdrOutputGates.get(key);
  if (herdrGate?.holding && herdrGate.publishNext) {
    let frameIndex = -1;
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index].includes(SYNC_BEGIN) && buffer[index].includes(SYNC_END)) {
        frameIndex = index;
        break;
      }
    }
    if (frameIndex !== -1) {
      const frame = buffer[frameIndex];
      buffer.splice(0, frameIndex + 1);
      terminal.write(frame);
      if (herdrGate.publishNext === 'resume') herdrOutputGates.delete(key);
      else herdrGate.publishNext = null;
      if (buffer.length > 0 || assembler?.hasPending()) {
        const timerId = window.setTimeout(() => flushWriteBuffer(key, terminal), WRITE_FLUSH_INTERVAL_MS);
        pendingFlushes.set(key, timerId);
      }
      return;
    }
  }

  // Defer the flush while the user reads scrollback: writing would trim the
  // buffer beneath the reader, dragging the viewport line by line to the top
  // (the "snaps to top during agent output" failure). Output accumulates and
  // each tick re-checks; past the hold cap the oldest units are dropped so
  // a reader is NEVER written through. Whole atomic units are dropped
  // (WebSocket chunk runs or complete synchronized frames — dropping a whole
  // frame is safe: the next full redraw supersedes it); a rare escape
  // sequence split across the drop heals on the application's next repaint.
  if (isReadingScrollback(terminal) || herdrGate?.holding) {
    let heldChars = 0;
    for (const chunk of buffer) heldChars += chunk.length;
    while (heldChars > READ_HOLD_MAX_CHARS && buffer.length > 0) {
      heldChars -= buffer[0].length;
      buffer.shift();
    }
    const timerId = window.setTimeout(() => flushWriteBuffer(key, terminal), WRITE_FLUSH_INTERVAL_MS);
    pendingFlushes.set(key, timerId);
    return;
  }

  // Bounded release: write whole units up to the slice budget and leave the
  // rest for the next tick, which re-checks the reading state first. The
  // budget is checked BEFORE adding each unit, so the first unit always
  // ships regardless of size — a synchronized frame larger than the budget
  // is written whole in one call, never split (splitting would re-open
  // xterm's synchronized-output timeout window mid-frame).
  let sliceChars = 0;
  let sliceCount = 0;
  while (sliceCount < buffer.length && sliceChars < RELEASE_SLICE_MAX_CHARS) {
    sliceChars += buffer[sliceCount].length;
    sliceCount += 1;
  }
  const data = buffer.splice(0, sliceCount).join('');

  recordFlush(key, data.length);

  // xterm owns output-driven scrollback trimming; the write buffer never
  // scrolls or restores a viewport position after a write.
  terminal.write(data);

  if (buffer.length > 0 || assembler?.hasPending()) {
    const timerId = window.setTimeout(() => flushWriteBuffer(key, terminal), WRITE_FLUSH_INTERVAL_MS);
    pendingFlushes.set(key, timerId);
  }
}

export function scheduleWrite(key: string, terminal: Terminal, data: string): void {
  let assembler = frameAssemblers.get(key);
  if (!assembler) {
    assembler = createFrameAssembler();
    frameAssemblers.set(key, assembler);
  }
  const units = assembler.ingest(data, Date.now());
  if (units.some((unit) => unit.includes(SYNC_BEGIN) && unit.includes(SYNC_END))) {
    const callback = nextSynchronizedFrameCallbacks.get(key);
    if (callback) {
      nextSynchronizedFrameCallbacks.delete(key);
      callback();
    }
  }

  let buffer = writeBuffers.get(key);
  if (!buffer) {
    buffer = [];
    writeBuffers.set(key, buffer);
  }
  buffer.push(...units);

  // Arm the tick even when ingest returned no units: a frame mid-assembly
  // needs the tick alive for the fail-open reaper.
  if ((buffer.length > 0 || assembler.hasPending()) && !pendingFlushes.has(key)) {
    const timerId = window.setTimeout(() => flushWriteBuffer(key, terminal), WRITE_FLUSH_INTERVAL_MS);
    pendingFlushes.set(key, timerId);
  }
}

export function afterNextSynchronizedFrame(key: string, callback: () => void): void {
  nextSynchronizedFrameCallbacks.set(key, callback);
}

export function setHerdrScrollState(
  key: string,
  terminal: Terminal,
  available: boolean,
  aboveBottom: boolean,
): void {
  if (!available) {
    herdrOutputGates.delete(key);
    flushWriteBuffer(key, terminal);
    return;
  }

  const timerId = pendingFlushes.get(key);
  if (timerId !== undefined) clearTimeout(timerId);
  pendingFlushes.delete(key);
  // Herdr repaint probes force a complete frame after this control. Discarding
  // older held units is safe because that full frame supersedes them.
  writeBuffers.delete(key);
  frameAssemblers.delete(key);
  herdrOutputGates.set(key, {
    holding: true,
    publishNext: aboveBottom ? 'hold' : 'resume',
  });
}

export function cancelPendingFlush(key: string): void {
  const timerId = pendingFlushes.get(key);
  if (timerId !== undefined) {
    clearTimeout(timerId);
    pendingFlushes.delete(key);
  }
  writeBuffers.delete(key);
  frameAssemblers.delete(key);
  herdrOutputGates.delete(key);
  nextSynchronizedFrameCallbacks.delete(key);
}

/**
 * Drain ALL queued complete units at a final stream boundary. The per-tick
 * release budget exists to re-check reader ownership between ticks; at a
 * final boundary there are no more ticks, so a single budgeted slice would
 * strand every unit after an oversized frame for cancelPendingFlush to
 * discard. Each iteration writes at least one whole unit, so the loop
 * terminates; a reading user keeps the discard semantics — a reader is never
 * written through, even at the end of the stream.
 */
export function releaseTrailingOutput(key: string, terminal: Terminal): void {
  for (
    let queued = writeBuffers.get(key);
    queued && queued.length > 0
      && !isReadingScrollback(terminal)
      && !herdrOutputGates.get(key)?.holding;
    queued = writeBuffers.get(key)
  ) {
    flushWriteBuffer(key, terminal);
  }
  cancelPendingFlush(key);
}

/** Tear down the output pipeline for every key under `prefix` (session dispose). */
export function cleanupOutputByPrefix(prefix: string): void {
  cleanupMapByPrefix(pendingFlushes, prefix, (timerId) => clearTimeout(timerId));
  cleanupMapByPrefix(writeBuffers, prefix);
  cleanupMapByPrefix(frameAssemblers, prefix);
  cleanupMapByPrefix(herdrOutputGates, prefix);
  cleanupMapByPrefix(nextSynchronizedFrameCallbacks, prefix);
}

/** Tear down the whole output pipeline (dispose-all / disconnect-all). */
export function clearAllOutput(): void {
  for (const timerId of pendingFlushes.values()) {
    clearTimeout(timerId);
  }
  pendingFlushes.clear();
  writeBuffers.clear();
  frameAssemblers.clear();
  herdrOutputGates.clear();
  nextSynchronizedFrameCallbacks.clear();
}
