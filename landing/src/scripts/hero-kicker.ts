import {
  getHeroKickerOpacity,
  getHeroKickerPosition,
  HERO_KICKER_INTERVAL_MS,
} from '../lib/hero-kicker';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function activateHeroKicker(root: HTMLElement): void {
  const reel = root.querySelector<HTMLElement>('.hero-kicker-reel');
  const words = Array.from(root.querySelectorAll<HTMLElement>('[data-hero-kicker-word]'));
  if (!reel || words.length === 0) return;

  let activeIndex = Math.max(0, words.findIndex((word) => word.dataset.active === 'true'));

  const measureActiveWord = () => {
    const activeWord = words[activeIndex];
    const width = activeWord.getBoundingClientRect().width;
    if (width > 0) reel.style.setProperty('--hero-kicker-width', `${Math.ceil(width)}px`);
  };

  const render = (resetIndex: number | null = null) => {
    words.forEach((word, index) => {
      const position = getHeroKickerPosition(index, activeIndex, words.length);
      if (index === resetIndex) {
        word.dataset.resetting = 'true';
      } else {
        delete word.dataset.resetting;
      }
      word.style.setProperty('--ticker-offset', String(position));
      word.style.opacity = getHeroKickerOpacity(position);
      word.dataset.active = position === 0 ? 'true' : 'false';
    });
    measureActiveWord();

    if (resetIndex !== null) {
      window.requestAnimationFrame(() => {
        delete words[resetIndex].dataset.resetting;
      });
    }
  };

  render();
  document.fonts?.ready.then(measureActiveWord).catch(() => {});
  window.addEventListener('resize', measureActiveWord, { passive: true });

  if (reduceMotion || words.length < 2) return;

  window.setInterval(() => {
    const previousIndex = activeIndex;
    activeIndex = (activeIndex + 1) % words.length;
    render(previousIndex);
  }, HERO_KICKER_INTERVAL_MS);
}

document.querySelectorAll<HTMLElement>('[data-hero-kicker]').forEach(activateHeroKicker);
