/**
 * Entrance + nav-chrome wiring (extracted from BaseLayout so it is a real,
 * testable module like the other page scripts).
 *
 * .reveal elements fade up the first time they scroll into view; [data-stagger]
 * grids cascade their children in. Content is visible by default: JS applies the
 * hidden state and immediately animates, never a CSS opacity:0 default, so no-JS
 * and reduced-motion visitors see everything.
 *
 * The flicker fix (REQ-LANDING, owner round 3): elements already in the initial
 * viewport (the hero, the login card) must NOT play the entrance. Animating
 * opacity from 0 snaps them invisible for a frame first, which reads as a
 * flicker on page open. They are marked revealed and left visible; only
 * below-the-fold content arms the reveal.
 *
 * The sticky nav gains a depth seam (.is-scrolled) once scrolled past the hero
 * top: a movement-free state toggle, safe under reduced motion.
 */
import { inView, animate } from 'motion';

const EASE_OUT_STRONG: [number, number, number, number] = [0.23, 1, 0.32, 1];
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!prefersReduced && 'IntersectionObserver' in window) {
  // Each element reveals exactly once. Motion's inView re-fires its callback
  // every time an element re-enters the viewport; without this guard, scrolling
  // up then down re-ran the entrance (blank to visible), which read as a flash
  // on mobile. The WeakSet makes the reveal one-shot and we disconnect after.
  const revealed = new WeakSet<HTMLElement>();

  // Elements already in the initial viewport must not play the entrance (see the
  // flicker fix above): leave them visible and only arm below-fold content.
  const inInitialView = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  };

  for (const el of document.querySelectorAll<HTMLElement>('.reveal')) {
    if (inInitialView(el)) {
      revealed.add(el);
      continue;
    }
    // Hide below-the-fold targets up front, while they are still off-screen, so
    // they never paint at full opacity and then snap to 0 when armed. That snap,
    // visible because inView fires only once the element is already on screen, is
    // the scroll-in flash; from this hidden state they fade up cleanly on entry.
    el.style.opacity = '0';
    const stop = inView(
      el,
      () => {
        if (revealed.has(el)) return;
        revealed.add(el);
        animate(
          el,
          { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] },
          { duration: 0.4, ease: EASE_OUT_STRONG }
        );
        stop?.();
      },
      { margin: '-60px' }
    );
  }

  // Grids cascade their children in (a short stagger) instead of fading as one
  // block. Children are hidden synchronously on enter, then animated. Also
  // one-shot, for the same reason.
  for (const grid of document.querySelectorAll<HTMLElement>('[data-stagger]')) {
    if (inInitialView(grid)) {
      revealed.add(grid);
      continue;
    }
    const items = Array.from(grid.children) as HTMLElement[];
    // Pre-hide the children up front for the same reason as .reveal above: hiding
    // them inside the callback ran after they had already painted on entry, which
    // flashed. Off-screen now, they cascade up from hidden when the grid enters.
    for (const item of items) item.style.opacity = '0';
    const stop = inView(
      grid,
      () => {
        if (revealed.has(grid)) return;
        revealed.add(grid);
        items.forEach((item, i) => {
          animate(
            item,
            { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] },
            { duration: 0.4, ease: EASE_OUT_STRONG, delay: i * 0.06 }
          );
        });
        stop?.();
      },
      { margin: '-60px' }
    );
  }
}

// The sticky nav gains a depth seam once scrolled past the hero top (a
// movement-free state toggle, safe under reduced motion).
const nav = document.querySelector('.site-nav');
let ticking = false;
const syncScroll = () => {
  const y = window.scrollY;
  if (nav) nav.classList.toggle('is-scrolled', y > 12);
  ticking = false;
};
const requestSync = () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(syncScroll);
  }
};
window.addEventListener('scroll', requestSync, { passive: true });
syncScroll();
