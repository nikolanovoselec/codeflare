/**
 * Page-wide flare-fluid signature: a cursor-reactive WebGL fluid simulation
 * pinned to the Codeflare flare palette, mounted in a fixed full-viewport layer
 * behind every section. It reacts to the cursor anywhere on the page (the
 * pointer listeners are bound to window) and behaves like a fixed background.
 * It is vivid behind the hero and recedes to a calm, legible wash behind the
 * text-dense sections below (a scroll-linked veil plus near-opaque glass panels;
 * see global.css). Paused while the tab is hidden so it never burns the GPU.
 *
 * Gated to desktop pointers and disabled under prefers-reduced-motion. Pure
 * progressive enhancement: with no JS, on touch devices, or under reduced
 * motion, no canvas is created, html.flare-on is never set, and the page renders
 * from its static markup with solid (non-glass) panels.
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

  // Switch the page onto its glass surfaces only now that the fluid is actually
  // live: the veil and the translucent panels key off html.flare-on, so a
  // no-WebGL / reduced-motion / touch visitor keeps the solid default styles.
  document.documentElement.classList.add('flare-on');

  // Pause on a hidden tab so a backgrounded page does no GPU work.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sim.pause();
    else sim.resume();
  });
}

initFlareFluid();
