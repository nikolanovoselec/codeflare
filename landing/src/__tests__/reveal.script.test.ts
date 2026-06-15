// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for reveal.ts (entrance wiring + the
 * open-page flicker fix). The module runs at import time, so the DOM and the
 * 'motion' mock are configured BEFORE importing it; vi.resetModules() per test
 * gives a clean instance.
 *
 * 'motion' is mocked: inView records which elements it is asked to observe (and
 * lets the test fire their callbacks); animate records which elements were
 * animated. The load-bearing behavior is the flicker fix: an element already in
 * the initial viewport must NOT be observed or animated (animating it from
 * opacity 0 would flash), while a below-the-fold element must be observed and,
 * once in view, animated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { inViewCalls, animateCalls } = vi.hoisted(() => ({
  inViewCalls: [] as Array<{ el: Element; cb: () => void }>,
  animateCalls: [] as Element[],
}));

vi.mock('motion', () => ({
  inView: (el: Element, cb: () => void) => {
    inViewCalls.push({ el, cb });
    return () => {};
  },
  animate: (el: Element) => {
    animateCalls.push(el);
    return { finished: Promise.resolve() };
  },
}));

function mockMatchMedia(prefersReducedMotion: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: prefersReducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

/** Place an element at a fixed viewport rect so inInitialView is deterministic. */
function placeAt(el: HTMLElement, top: number, height = 100): void {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      width: 300,
      left: 0,
      right: 300,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
  inViewCalls.length = 0;
  animateCalls.length = 0;
  // The script gates on IntersectionObserver capability; provide a stub so the
  // reveal loop runs (it uses motion's inView, not IO, for the actual reveal).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 800 });
});

afterEach(() => {
  vi.resetModules();
});

describe('reveal.ts (REQ-LANDING-001)', () => {
  it('arms the entrance only for below-the-fold .reveal elements (above-the-fold ones are skipped, no flicker)', async () => {
    const above = document.createElement('div');
    above.className = 'reveal';
    placeAt(above, 50); // inside the initial viewport
    const below = document.createElement('div');
    below.className = 'reveal';
    placeAt(below, 2000); // far below the fold
    document.body.append(above, below);

    mockMatchMedia(false);
    await import('../scripts/reveal');

    const observed = inViewCalls.map((c) => c.el);
    expect(observed).toContain(below);
    expect(observed).not.toContain(above);

    // The scroll-in flash fix: the below-fold target is hidden up front (at setup,
    // while still off-screen) so it never paints at full opacity and then snaps to
    // 0 when armed. The above-fold one is left visible (it plays no entrance).
    expect(below.style.opacity).toBe('0');
    expect(above.style.opacity).toBe('');
  });

  it('animates a below-the-fold element only once it scrolls into view, and never the above-the-fold one', async () => {
    const above = document.createElement('div');
    above.className = 'reveal';
    placeAt(above, 10);
    const below = document.createElement('div');
    below.className = 'reveal';
    placeAt(below, 3000);
    document.body.append(above, below);

    mockMatchMedia(false);
    await import('../scripts/reveal');

    // Nothing animated yet: the reveal fires from inView's callback, not at import.
    expect(animateCalls).toHaveLength(0);
    // But the below-fold element is already hidden (pre-hidden at setup), so when
    // it scrolls in it fades up from hidden rather than flashing visible-then-0.
    expect(below.style.opacity).toBe('0');
    expect(above.style.opacity).toBe('');

    // Simulate the below-fold element scrolling into view.
    const entry = inViewCalls.find((c) => c.el === below);
    expect(entry).toBeDefined();
    entry!.cb();

    expect(animateCalls).toContain(below);
    expect(animateCalls).not.toContain(above);
  });

  it('does nothing under prefers-reduced-motion (no element is observed or animated)', async () => {
    const below = document.createElement('div');
    below.className = 'reveal';
    placeAt(below, 3000);
    document.body.append(below);

    mockMatchMedia(true);
    await import('../scripts/reveal');

    expect(inViewCalls).toHaveLength(0);
    expect(animateCalls).toHaveLength(0);
  });

  it("staggers a [data-stagger] grid's children in when it enters view (children hidden first, then animated)", async () => {
    const grid = document.createElement('div');
    grid.setAttribute('data-stagger', '');
    placeAt(grid, 3000);
    const a = document.createElement('div');
    const b = document.createElement('div');
    grid.append(a, b);
    document.body.append(grid);

    mockMatchMedia(false);
    await import('../scripts/reveal');

    // Children are hidden up front, at setup (before the grid is in view), so they
    // never paint at their final position and then snap hidden — the flash fix.
    // (Reverting the pre-hide back into the callback fails here.)
    expect(a.style.opacity).toBe('0');
    expect(b.style.opacity).toBe('0');

    const entry = inViewCalls.find((c) => c.el === grid);
    expect(entry).toBeDefined();
    entry!.cb();

    // Each child is then animated in (the cascade).
    expect(animateCalls).toContain(a);
    expect(animateCalls).toContain(b);
  });
});
