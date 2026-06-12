/**
 * Hero flare-fluid signature: a cursor-reactive WebGL fluid simulation pinned to
 * the Codeflare flare palette, mounted behind the hero only (the page's single
 * "drenched" moment per the brand register; the rest of the page stays calm and
 * legible). It is paused whenever the hero scrolls out of view or the tab is
 * hidden, so it never burns the GPU off-screen.
 *
 * Gated to desktop pointers and disabled under prefers-reduced-motion. Pure
 * progressive enhancement: with no JS, on touch devices, or under reduced
 * motion, no canvas is created and the hero renders from its static markup.
 */
import { createSplashSimulation, type SplashConfig } from '../lib/splash-cursor-logic';

const FLARE_CONFIG: SplashConfig = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 1024,
  CAPTURE_RESOLUTION: 512,
  DENSITY_DISSIPATION: 3.5,
  VELOCITY_DISSIPATION: 2,
  PRESSURE: 0.1,
  PRESSURE_ITERATIONS: 20,
  CURL: 2.5,
  SPLAT_RADIUS: 0.22,
  SPLAT_FORCE: 6000,
  SHADING: true,
  COLOR_UPDATE_SPEED: 8,
  PAUSED: false,
  BACK_COLOR: { r: 0.039, g: 0.039, b: 0.047 },
  TRANSPARENT: true,
};

function isHeroVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

function initFlareFluid(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Cursor effect: desktop (fine) pointers only. Coarse / touch pointers skip it
  // entirely so mobile stays clean, fast, and scroll-friendly.
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (reduced || !finePointer) return;

  const host = document.querySelector<HTMLElement>('[data-flare-fluid]');
  if (!host) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'flare-fluid-canvas';
  host.appendChild(canvas);

  const sim = createSplashSimulation(canvas, { ...FLARE_CONFIG });
  if (!sim) {
    // WebGL unavailable: remove the empty canvas so nothing renders.
    canvas.remove();
    return;
  }
  sim.start();

  // The fluid only lives in the hero: pause it once the hero leaves the viewport.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) sim.resume();
          else sim.pause();
        }
      },
      { threshold: 0 },
    );
    io.observe(host);
  }

  // Pause on a hidden tab so a backgrounded page does no GPU work.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.pause();
    else if (isHeroVisible(host)) sim.resume();
  });
}

initFlareFluid();
