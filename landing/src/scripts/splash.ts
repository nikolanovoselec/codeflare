/**
 * Page-wide flare-fluid signature: a cursor-reactive WebGL fluid simulation
 * pinned to the Codeflare flare palette, mounted in a fixed full-viewport layer
 * behind every section. It reacts to the cursor anywhere on the page (the
 * pointer listeners are bound to window) and behaves like a fixed background.
 * It is vivid behind the hero and recedes to a calm, legible wash behind the
 * text-dense sections below (a scroll-linked veil plus near-opaque glass panels;
 * see global.css). Paused while the tab is hidden so it never burns the GPU.
 *
 * Runs on both desktop and touch devices, disabled only under
 * prefers-reduced-motion. Desktop fine pointers drive the fluid with the cursor;
 * touch devices have no cursor, so the fluid is driven by page scroll (a virtual
 * pointer sweeps a gentle path across the canvas as the page moves). Pure
 * progressive enhancement: with no JS, no WebGL, or under reduced motion, no
 * canvas is created, and the page renders from server-stable markup without a
 * late visual-mode class flip.
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

function initFlareFluid(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Disabled only under reduced motion. Desktop fine pointers drive the fluid
  // with the cursor; touch devices (coarse pointers) drive it from scroll below.
  if (reduced) return;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

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

  // The landing layout renders html.flare-on on the server. Do not add or remove
  // page-wide visual classes here; late class flips repaint every section and are
  // visible as a load twitch on slower devices.

  // Touch devices have no cursor, so drive the fluid from page scroll: a virtual
  // pointer sweeps a gentle Lissajous path across the canvas as the page moves,
  // so the flare lives and streams while reading. rAF-throttled; the first call
  // only primes the pointer (no splat).
  if (!finePointer) {
    // While a finger is actually on the screen, the simulation's own touch
    // handlers already drive the flare from the finger position (clientX/Y minus
    // the canvas rect — the same path the SPA uses). The scroll sweep below is
    // only an ambient fallback for when no finger is down (momentum / programmatic
    // scroll). Without this guard a swipe fires both at once and the Lissajous
    // splat — which is unrelated to the finger — wins, so the flare lands at the
    // wrong coordinates instead of under the finger. Suppress the sweep during an
    // active touch so the finger is the sole driver, matching the SPA.
    let touchActive = false;
    const endTouch = () => { touchActive = false; };
    window.addEventListener('touchstart', () => { touchActive = true; }, { passive: true });
    window.addEventListener('touchend', endTouch, { passive: true });
    window.addEventListener('touchcancel', endTouch, { passive: true });

    let queued = false;
    const sweep = () => {
      queued = false;
      if (touchActive) return; // finger drives the flare during an active swipe
      const y = window.scrollY;
      const xFrac = 0.5 + 0.32 * Math.sin(y / 320);
      const yFrac = 0.5 + 0.3 * Math.cos(y / 240);
      sim.pointerMove(xFrac, yFrac);
    };
    sweep(); // prime
    sim.pointerMove(0.62, 0.46); // one seed splat so the hero shows flare on load
    window.addEventListener(
      'scroll',
      () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(sweep);
      },
      { passive: true }
    );
  }

  // Pause on a hidden tab so a backgrounded page does no GPU work.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.pause();
    else sim.resume();
  });
}

initFlareFluid();
