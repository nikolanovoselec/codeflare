/**
 * Layout-mode decision for the dashboard right-column panels (GitHub + Storage
 * adaptive split).
 *
 * The actual SPLIT allocation — which panel gets how much height — is done by the
 * flex engine, not here: both faces render as `flex: 1 1 0` with a JS-measured
 * `max-height` equal to their natural content height, inside a column that uses
 * `justify-content: space-between`. The flex "freeze a maxed item, redistribute
 * its freed space to the others" algorithm then yields the anchoring behaviour:
 *
 *   - both panels short  → each sits at its natural height; the slack falls in the
 *     MIDDLE (space-between), GitHub pinned to the top, Storage to the bottom.
 *   - one short, one tall → the short one freezes at its content height and the
 *     tall one absorbs all the freed space (and scrolls).
 *   - both tall          → neither max binds before 50%, so each gets H/2 and both
 *     scroll, meeting in the middle.
 *
 * If the measured max-heights are missing/zero the faces stay `flex: 1 1 0`, i.e.
 * a plain 50/50 split — a safe default, never a collapsed panel.
 *
 * This module owns only the discrete SPLIT-vs-FLIP decision (the part worth
 * unit-testing); the pixel allocation is the browser's job.
 */
export type PanelLayoutMode = 'split' | 'flip';

export interface LayoutModeInput {
  /** Available width of the right column (px). */
  width: number;
  /** Available height of the right column (px). */
  height: number;
  /**
   * Minimum height a single panel needs to stay usable in a split: its fixed
   * chrome (header/search) plus the minimum number of rows. A split needs room
   * for TWO of these stacked.
   */
  minPanelHeight: number;
  /** Below this width the column always flips (mobile). Default 600. */
  narrowWidth?: number;
}

/**
 * Decide whether the two panels stack as an adaptive SPLIT or collapse to a
 * single FLIP face. FLIP when the column is narrow (mobile) OR too short to give
 * both panels their minimum usable height; SPLIT otherwise.
 *
 * Unmeasured dimensions (`0`) never force a flip — the pre-measurement default is
 * SPLIT so the desktop layout does not flash the single-face mode on first paint.
 */
export function decidePanelLayoutMode(input: LayoutModeInput): PanelLayoutMode {
  const { width, height, minPanelHeight, narrowWidth = 600 } = input;
  if (width > 0 && width < narrowWidth) return 'flip';
  // Too short to stack two usable panels — but only once we actually have a
  // measured width AND height; a partial/zero measurement must not flash flip.
  if (width > 0 && height > 0 && height < minPanelHeight * 2) return 'flip';
  return 'split';
}
