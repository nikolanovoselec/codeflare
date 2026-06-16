export const HERO_KICKER_INTERVAL_MS = 1800;

export function getHeroKickerPosition(index: number, activeIndex: number, count: number): number {
  if (count <= 0) return 0;
  return (index - activeIndex + count) % count;
}

export function getHeroKickerOpacity(position: number): string {
  if (position === 0) return '1';
  return Math.max(0.14, 0.42 - position * 0.055).toFixed(2);
}

export function buildHeroKickerLabel(prefix: string, words: string[], suffix: string): string {
  if (words.length === 0) return `${prefix} ${suffix}`.trim();
  if (words.length === 1) return `${prefix} ${words[0]} ${suffix}`;
  const head = words.slice(0, -1).join(', ');
  const tail = words[words.length - 1];
  return `${prefix} ${head}, and ${tail} ${suffix}`;
}
