/**
 * DEC 2026 synchronized-output frame assembly for the terminal write path.
 *
 * Agent TUIs (Pi, Claude Code, Codex) author redraws as atomic frames wrapped
 * in `ESC[?2026h` … `ESC[?2026l`. A full Pi replay additionally clears the
 * screen and scrollback (`CSI 2J`/`CSI H`/`CSI 3J`) before rewriting the whole
 * transcript — hundreds of kilobytes spread over ~100 WebSocket messages. The
 * host forwards raw PTY chunks, so without reassembly the frontend feeds xterm
 * a frame incrementally: xterm arms a 1,000 ms synchronized-output safety
 * timeout at the first buffered row (RenderService), and network arrival plus
 * write batching can outlast it. On timeout xterm abandons atomicity and
 * paints the partially rebuilt transcript — the viewport visibly walks through
 * scrollback and snaps back.
 *
 * The assembler restores the boundary the application authored: ordinary
 * bytes pass straight through, while everything from a begin marker to the
 * first end marker (DEC 2026 is a set/reset mode — xterm treats a redundant
 * begin as idempotent and the first end marker ends synchronization) is
 * parked here and emitted as ONE unit for a single terminal.write() call. xterm parses one write chunk synchronously
 * (WriteBuffer checks its time budget only BETWEEN chunks), so the timeout
 * callback can never interleave with a coalesced frame — the end marker
 * clears the timer in the same task that armed it. This atomicity contract
 * also means no asynchronous parser handlers may ever be registered on the
 * terminal.
 *
 * Malformed streams fail open: a frame that stalls (no new bytes) past
 * FRAME_STALL_TIMEOUT_MS, or grows past FRAME_MAX_CHARS, is released as-is —
 * exactly the pre-assembly behavior — rather than deferring output forever.
 */

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
// Both markers share this 7-char prefix; only the final byte differs. A chunk
// ending inside a marker carries at most these 7 chars into the next ingest.
const MARKER_PREFIX = '\x1b[?2026';

// Fail-open bound on a stalled frame: measured full replays arrive in well
// under a second of continuous chunks; a frame idle this long is a dead or
// malformed stream, and releasing it merely restores pre-assembly behavior.
export const FRAME_STALL_TIMEOUT_MS = 2_000;

// Fail-open memory ceiling per frame (~10x the largest observed Pi replay).
export const FRAME_MAX_CHARS = 4_000_000;

export interface FrameAssembler {
  /**
   * Feed one incoming chunk; returns the completed atomic units it unlocked,
   * in stream order. A unit is either a run of ordinary bytes or one complete
   * synchronized frame. Bytes of a still-open frame stay parked inside.
   */
  ingest(chunk: string, now: number): string[];
  /** Fail-open reaper: release a stalled frame or idle marker carry. */
  reap(now: number): string[];
  /** True while bytes are parked here (keeps flush ticks alive). */
  hasPending(): boolean;
}

/** Longest suffix of `s` that is a proper prefix of a sync marker (0 if none). */
function holdableTailLen(s: string): number {
  const max = Math.min(MARKER_PREFIX.length, s.length);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(MARKER_PREFIX.slice(0, k))) return k;
  }
  return 0;
}

export function createFrameAssembler(): FrameAssembler {
  let mode: 'pass' | 'frame' = 'pass';
  let held: string[] = [];
  let heldChars = 0;
  let carry = '';
  let lastIngestAt = 0;

  const releaseHeld = (out: string[]): void => {
    if (held.length > 0) out.push(held.join(''));
    held = [];
    heldChars = 0;
    mode = 'pass';
  };

  return {
    ingest(chunk: string, now: number): string[] {
      lastIngestAt = now;
      const out: string[] = [];
      let rest = carry + chunk;
      carry = '';

      while (rest.length > 0) {
        if (mode === 'pass') {
          const i = rest.indexOf(BSU);
          if (i === -1) {
            const tail = holdableTailLen(rest);
            const emit = rest.slice(0, rest.length - tail);
            carry = tail > 0 ? rest.slice(rest.length - tail) : '';
            if (emit.length > 0) out.push(emit);
            rest = '';
          } else {
            if (i > 0) out.push(rest.slice(0, i));
            mode = 'frame';
            held = [BSU];
            heldChars = BSU.length;
            rest = rest.slice(i + BSU.length);
          }
        } else {
          // DEC 2026 is a set/reset MODE, not a nesting scope: xterm applies a
          // redundant begin marker idempotently and the FIRST end marker ends
          // synchronization. The frame therefore closes at the first end
          // marker — holding past it would defer bytes xterm no longer treats
          // as synchronized. Redundant begin markers ride along as held bytes.
          const ie = rest.indexOf(ESU);
          if (ie === -1) {
            const tail = holdableTailLen(rest);
            const keep = rest.slice(0, rest.length - tail);
            if (keep.length > 0) {
              held.push(keep);
              heldChars += keep.length;
            }
            carry = tail > 0 ? rest.slice(rest.length - tail) : '';
            rest = '';
          } else {
            const end = ie + ESU.length;
            held.push(rest.slice(0, end));
            heldChars += end;
            rest = rest.slice(end);
            releaseHeld(out);
          }
          if (mode === 'frame' && heldChars > FRAME_MAX_CHARS) {
            // Ceiling breached mid-frame: fail open. The released begin marker
            // re-enters xterm's own timeout regime — pre-assembly behavior.
            releaseHeld(out);
          }
        }
      }
      return out;
    },

    reap(now: number): string[] {
      if (now - lastIngestAt < FRAME_STALL_TIMEOUT_MS) return [];
      const out: string[] = [];
      if (mode === 'frame') releaseHeld(out);
      if (carry.length > 0) {
        out.push(carry);
        carry = '';
      }
      return out;
    },

    hasPending(): boolean {
      return mode === 'frame' || carry.length > 0;
    },
  };
}
