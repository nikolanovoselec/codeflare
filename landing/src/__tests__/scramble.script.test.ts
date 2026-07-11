// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for scramble.ts.
 *
 * The script's public entry point is initScramble(), which calls
 * setupElement() on every [data-scramble] element.  setupElement() splits the
 * element's text into per-word <span> elements and calls animateWord() on each,
 * which runs a setInterval(TICK_MS)-based loop through: hold -> scramble ->
 * decrypt -> swap -> hold.
 *
 * The convergence invariant: after the decrypt+swap phase completes (frame>12),
 * current is reset to chars.slice() — the original characters.  The span's
 * textContent is therefore ALWAYS the target word when the swap phase ends.
 * Tests advance timers far enough to pass through at least one full cycle and
 * assert on the convergence.
 *
 * Because scramble.ts calls requestAnimationFrame (via fonts.ready) and
 * setInterval, each test MUST: build the DOM, mock matchMedia and
 * document.fonts BEFORE importing the module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// From the script: one interval tick is TICK_MS=50ms.
// hold: frame>60 (60 ticks * 50ms = 3000ms min)
// scramble: frame>26 (26 ticks = 1300ms)
// decrypt+swap: frame>12 (12 ticks = 600ms)
// Total minimum per cycle: ~4900ms — use 8000ms for a comfortable margin.
const ONE_CYCLE_MS = 8_000;

function buildScrambleFixture(targetText: string): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-scramble', '');
  el.textContent = targetText;
  document.body.appendChild(el);
  return el;
}

function mockMatchMedia(prefersReducedMotion: boolean, wideViewport = true): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    // Query-aware: the reduced-motion query returns prefersReducedMotion; the
    // min-width gate returns wideViewport (default true = desktop, where the churn runs).
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? prefersReducedMotion : wideViewport,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function mockFontsReady(): void {
  // Resolve fonts.ready immediately so setupElement runs without waiting.
  Object.defineProperty(document, 'fonts', {
    writable: true,
    value: {
      ready: Promise.resolve(),
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('scramble.ts (REQ-LANDING-001)', () => {
  it('REQ-LANDING-001: the span scrambles away from the target and then converges back to the exact target', async () => {
    // A real convergence proof: the span must both DEVIATE (the animation ran) and
    // then RETURN to the exact target (the swap phase resets current=chars.slice()).
    // toContain(target) alone would be theater - setupElement writes the target
    // synchronously, so it is present before any animation runs. We require an
    // actual deviation followed by an exact return to target.
    const target = 'governed';
    buildScrambleFixture(target);
    mockMatchMedia(false);
    mockFontsReady();

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();

    let sawDeviation = false;
    let convergedAfterDeviation = false;
    for (let t = 0; t < ONE_CYCLE_MS * 2; t += 50) {
      vi.advanceTimersByTime(50);
      const span = document.querySelector<HTMLElement>('.scramble-word');
      if (!span || !span.textContent) continue;
      if (span.textContent !== target) {
        sawDeviation = true;
      } else if (sawDeviation) {
        convergedAfterDeviation = true;
        break;
      }
    }
    // The animation actually ran (deviated) AND the swap phase restored the target.
    expect(sawDeviation).toBe(true);
    expect(convergedAfterDeviation).toBe(true);
  });

  it('REQ-LANDING-001: the word span actually deviates from the target during the scramble phase', async () => {
    // Behavioral: if the animation is no-opped (or only the static structure is
    // built), the span always reads the target. The scramble phase replaces the
    // chars with random glyphs, so at some frame the span text MUST differ from
    // the target. We sample across a full cycle and require at least one
    // deviation. (Probability of a random 8-char scramble coinciding with the
    // exact target is ~26^-8, negligible.)
    const target = 'abcdefgh'; // single word -> one .scramble-word span
    buildScrambleFixture(target);
    mockMatchMedia(false);
    mockFontsReady();

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();

    let sawScramble = false;
    // Sample every 50ms across a full hold->scramble->decrypt->swap cycle.
    for (let t = 0; t < ONE_CYCLE_MS; t += 50) {
      vi.advanceTimersByTime(50);
      const span = document.querySelector<HTMLElement>('.scramble-word');
      if (span && span.textContent && span.textContent !== target) {
        sawScramble = true;
        break;
      }
    }

    // The span must have been created (setupElement ran) AND deviated (the
    // animation actually mutated it). A no-opped script fails both ways:
    // no span -> condition never true; static span -> always equals target.
    expect(sawScramble).toBe(true);
  });

  it('REQ-LANDING-001: under prefers-reduced-motion the element text is NOT mutated', async () => {
    const target = 'autonomous';
    const el = buildScrambleFixture(target);
    mockMatchMedia(true); // reduced motion = true

    await import('../scripts/scramble');

    await Promise.resolve();
    vi.runAllTicks();

    // Advance well past a full cycle — should be a no-op.
    vi.advanceTimersByTime(ONE_CYCLE_MS);

    // Under reduced motion the script returns early, no spans are created,
    // and the element content remains the original text.
    expect(el.textContent).toBe(target);
    // No scramble-word spans should exist.
    expect(document.querySelectorAll('.scramble-word').length).toBe(0);
  });

  it('REQ-LANDING-001: below the layout split breakpoint the accent stays static (no churn spans)', async () => {
    const target = 'assistant';
    const el = buildScrambleFixture(target);
    // Motion is allowed, but the viewport is narrow (< 820px): the churn must NOT run,
    // because a full-width churning headline reflows between one and two lines and
    // shoves the page (the reported mobile flicker).
    mockMatchMedia(false, false);
    mockFontsReady();

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();
    vi.advanceTimersByTime(ONE_CYCLE_MS);

    // The server-rendered gradient stands, untouched: no word spans, text intact.
    expect(el.textContent).toBe(target);
    expect(document.querySelectorAll('.scramble-word').length).toBe(0);
  });

  it('REQ-LANDING-001: each churning word paints on an out-of-flow .scramble-word overlay above a hidden resting-width ghost, so churn neither clips a glyph nor reflows the phrase', async () => {
    // The reported mobile flicker: churn glyphs are wider than the resting letters, so a
    // content-sized word grows and re-wraps the phrase every frame, shoving the page down.
    // Width-locking the word instead clipped wide glyphs (the rejected "cut off"). The fix
    // reserves each word's resting box with an invisible .scramble-ghost and paints the
    // churn on an out-of-flow .scramble-word overlay: churn never resizes the box (no
    // reflow) and is never width-constrained (no clip).
    buildScrambleFixture('coding assistant'); // two words
    mockMatchMedia(false);
    mockFontsReady();

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();

    const boxes = [...document.querySelectorAll<HTMLElement>('.scramble-box')];
    expect(boxes.length).toBe(2); // one layout-reserving box per word
    const ghost = boxes[0].querySelector<HTMLElement>('.scramble-ghost');
    const live = boxes[0].querySelector<HTMLElement>('.scramble-word');
    expect(ghost).not.toBeNull();
    expect(live).not.toBeNull();
    // The ghost holds the resting text and reserves the box; the churning overlay is a
    // separate .scramble-word sibling, so the two never share a width.
    const restingText = ghost!.textContent;

    // The overlay churns; the ghost text (the fixed layout reservation) never changes.
    let liveDeviated = false;
    for (let t = 0; t < ONE_CYCLE_MS; t += 50) {
      vi.advanceTimersByTime(50);
      if (live!.textContent && live!.textContent !== restingText) liveDeviated = true;
      expect(ghost!.textContent).toBe(restingText);
    }
    expect(liveDeviated).toBe(true); // the overlay actually animated
  });

  it('REQ-LANDING-006: the hover-decode sign-in CTA locks each word span to its resting width so the header never reflows', async () => {
    const el = document.createElement('a');
    el.setAttribute('data-scramble-hover', '');
    el.textContent = 'Enter Matrix';
    document.body.appendChild(el);
    mockMatchMedia(false);
    mockFontsReady();
    // happy-dom has no layout engine, so stub the resting width the lock measures.
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 42,
      height: 0,
      top: 0,
      left: 0,
      right: 42,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();
    vi.advanceTimersByTime(50); // fire the rAF that runs the width lock

    const spans = el.querySelectorAll<HTMLElement>('.scramble-word');
    // "Enter" + "Matrix" -> two word boxes, each pinned to its measured resting width
    // so the per-frame glyph churn cannot resize the button and shove the nav.
    expect(spans.length).toBe(2);
    for (const span of spans) {
      expect(span.style.display).toBe('inline-block');
      expect(span.style.width).toBe('42px');
    }
    rectSpy.mockRestore();
  });

  it('REQ-LANDING-001: element with no text content is handled without error', async () => {
    const el = document.createElement('span');
    el.setAttribute('data-scramble', '');
    el.textContent = '';
    document.body.appendChild(el);
    mockMatchMedia(false);
    mockFontsReady();

    // Must not throw.
    await expect(import('../scripts/scramble')).resolves.toBeDefined();

    await Promise.resolve();
    vi.runAllTicks();
    vi.advanceTimersByTime(ONE_CYCLE_MS);

    // Empty element must stay empty — no crash.
    expect(el.textContent).toBe('');
  });
});
