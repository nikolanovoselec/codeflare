/**
 * FLIP math for the fleet split: the hero pane is measured in its final
 * grid cell (last), then transformed so it appears at its original full
 * size (first) and animates to identity. Full transform strings keep the
 * animation hardware-accelerated (Motion's x/y shorthands are not).
 */
export interface DOMRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function flipTransform(first: DOMRectLike, last: DOMRectLike): string {
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = last.width === 0 ? 1 : first.width / last.width;
  const sy = last.height === 0 ? 1 : first.height / last.height;

  const round = (value: number) => Math.round(value * 1000) / 1000;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx)}, ${round(sy)})`;
}
