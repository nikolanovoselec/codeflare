/**
 * Builds the assistant-vs-engine diff from the two comparison columns.
 * The Shift section renders this as a unified (mobile) or split (desktop)
 * diff; both renderings consume the same pair-aligned line list so the
 * comparison can never drift between breakpoints.
 */
import type { ComparisonColumn } from '../content/site';

export interface DiffLine {
  sign: '-' | '+';
  text: string;
  /** Index of the assistant/engine pair this line belongs to. */
  pairIndex: number;
}

export function buildDiff(assistant: ComparisonColumn, engine: ComparisonColumn): DiffLine[] {
  if (assistant.points.length !== engine.points.length) {
    throw new Error(
      `diff columns must pair 1:1 — got ${assistant.points.length} assistant and ${engine.points.length} engine points`
    );
  }

  return assistant.points.flatMap((point, pairIndex) => [
    { sign: '-' as const, text: point, pairIndex },
    { sign: '+' as const, text: engine.points[pairIndex], pairIndex },
  ]);
}
