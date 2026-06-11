/**
 * Terminal transcript player — Termynal-derived (github.com/ines/termynal).
 * Pure sequencing engine: all DOM access, timing sources, and pause state
 * are injected through the adapter so the playback contract is unit-testable
 * with a fake clock. The DOM adapter lives in TerminalDemo.astro.
 */

export interface TerminalLine {
  /** cmd: typed char-by-char · spin: spinner then settle · line: printed whole */
  kind: 'cmd' | 'spin' | 'line';
  text: string;
  /** Extra pause before this line plays. */
  waitMs?: number;
}

export interface PlayerAdapter {
  write(index: number, text: string): void;
  reveal(index: number): void;
  setCursor(index: number, visible: boolean): void;
  sleep(ms: number): Promise<void>;
  isPaused(): boolean;
  now(): number;
  /** Optional: fired once per line, after the line has fully settled. */
  onLineCommit?(index: number): void;
}

export interface PlayerTimings {
  typeMs: number;
  lineMs: number;
  spinMs: number;
  spinFrameMs: number;
  pausePollMs: number;
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const DEFAULT_TIMINGS: PlayerTimings = {
  typeMs: 38,
  lineMs: 320,
  spinMs: 1100,
  spinFrameMs: 90,
  pausePollMs: 150,
};

/** Plays the transcript once, line by line, honoring pauses and waits. */
export async function playTranscript(
  lines: readonly TerminalLine[],
  adapter: PlayerAdapter,
  timings: PlayerTimings = DEFAULT_TIMINGS
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    while (adapter.isPaused()) {
      await adapter.sleep(timings.pausePollMs);
    }
    if (line.waitMs) {
      await adapter.sleep(line.waitMs);
    }
    adapter.reveal(index);

    if (line.kind === 'cmd') {
      adapter.setCursor(index, true);
      let typed = '';
      for (const char of line.text) {
        typed += char;
        adapter.write(index, typed);
        await adapter.sleep(timings.typeMs);
      }
      adapter.setCursor(index, false);
    } else if (line.kind === 'spin') {
      const start = adapter.now();
      while (adapter.now() - start < timings.spinMs) {
        const frameIndex = Math.floor((adapter.now() - start) / timings.spinFrameMs) % SPINNER_FRAMES.length;
        adapter.write(index, line.text.replace('✻', SPINNER_FRAMES[frameIndex]));
        await adapter.sleep(timings.spinFrameMs);
      }
      adapter.write(index, line.text);
    } else {
      await adapter.sleep(timings.lineMs);
    }

    adapter.onLineCommit?.(index);
  }
}
