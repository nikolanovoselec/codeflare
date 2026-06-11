/**
 * Single source of "which section is active": drives the prompt-label LEDs,
 * the nav highlight, and the status-bar path segment from one computation.
 * Ratios come from an IntersectionObserver; this stays pure for testing.
 */
const JITTER_EPSILON = 0.01;

export function activeSection(
  order: readonly string[],
  ratios: Record<string, number>
): string | null {
  let winner: string | null = null;
  let winnerRatio = 0;

  for (const id of order) {
    const ratio = ratios[id] ?? 0;
    // Strictly-greater-with-epsilon keeps document order stable under jitter.
    if (ratio > winnerRatio + JITTER_EPSILON) {
      winner = id;
      winnerRatio = ratio;
    }
  }

  return winner;
}
