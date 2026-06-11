/**
 * Per-digit steps for the status-bar session odometer (hud-tick). Each
 * changed column rolls as a vertical glyph column; unchanged columns stay
 * put. Column 0 is the most significant digit of the wider value.
 */
export interface DigitStep {
  column: number;
  from: number;
  to: number;
}

export function odometerSteps(prev: number, next: number): DigitStep[] {
  if (prev === next) {
    return [];
  }

  const width = Math.max(String(prev).length, String(next).length);
  const prevDigits = String(prev).padStart(width, '0');
  const nextDigits = String(next).padStart(width, '0');

  const steps: DigitStep[] = [];
  for (let column = 0; column < width; column++) {
    const from = Number(prevDigits[column]);
    const to = Number(nextDigits[column]);
    if (from !== to) {
      steps.push({ column, from, to });
    }
  }
  return steps;
}
