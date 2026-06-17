export const HERO_KICKER_INTERVAL_MS = 1800;

export function getHeroKickerPosition(index: number, activeIndex: number, count: number): number {
  if (count <= 0) return 0;
  return (index - activeIndex + count) % count;
}

export function getHeroKickerOpacity(position: number, count: number): string {
  // The active word (bottom of the stack) stays fully solid; the queued words above
  // it fade linearly upward, reaching fully transparent at the top of the stack — so
  // the column dissolves into nothing instead of leaving a visible ghost block beside
  // the coral text. The fade starts at the word above the active one, never on it.
  if (position <= 0) return '1';
  if (count <= 1) return '0';
  return Math.max(0, 1 - position / (count - 1)).toFixed(2);
}

export function buildHeroKickerLabel(prefix: string, words: string[], suffix: string): string {
  if (words.length === 0) return `${prefix} ${suffix}`.trim();
  if (words.length === 1) return `${prefix} ${words[0]} ${suffix}`;
  const head = words.slice(0, -1).join(', ');
  const tail = words[words.length - 1];
  return `${prefix} ${head}, and ${tail} ${suffix}`;
}
