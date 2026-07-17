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
import { readFileSync } from 'node:fs';

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
    // Query-aware: the reduced-motion query returns prefersReducedMotion. Any other query
    // (a hypothetical min-width gate) returns wideViewport; the churn must run regardless of
    // it -- it is gated only on reduced-motion, never on viewport width. Passing
    // wideViewport=false simulates a narrow/mobile viewport as a regression guard: if a
    // width gate is ever re-added, the churn would stop and the mobile test below would fail.
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

  it('REQ-LANDING-001: the churn runs at narrow (mobile) viewport width too — gated only on reduced-motion, never on width', async () => {
    const target = 'assistant';
    buildScrambleFixture(target);
    // Motion is allowed and the viewport is narrow (a min-width query reports false). The
    // footprint-stable ghost/overlay means the churn no longer reflows the headline, so it
    // runs on mobile as well — width is not a gate. If a width gate is ever reintroduced the
    // churn would stop under this mock and this assertion would fail.
    mockMatchMedia(false, false);
    mockFontsReady();

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();

    // The churn overlay is created and actually mutates even at mobile width.
    const live = document.querySelector<HTMLElement>('.scramble-word');
    expect(live).not.toBeNull();
    let sawScramble = false;
    for (let t = 0; t < ONE_CYCLE_MS; t += 50) {
      vi.advanceTimersByTime(50);
      if (live!.textContent && live!.textContent !== target) {
        sawScramble = true;
        break;
      }
    }
    expect(sawScramble).toBe(true);
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

  it('REQ-LANDING-006: the hover-decode sign-in CTA holds a resting-width ghost box per word so the header never reflows', async () => {
    const el = document.createElement('a');
    el.setAttribute('data-scramble-hover', '');
    el.textContent = 'Enter The Matrix';
    document.body.appendChild(el);
    mockMatchMedia(false);
    mockFontsReady();

    await import('../scripts/scramble');
    await Promise.resolve();
    vi.runAllTicks();

    // "Enter" + "The" + "Matrix" -> three centered ghost/overlay boxes. The in-flow
    // ghost IS the footprint (no measured pixel lock exists to be captured while the
    // nav is hidden and go stale), so churn can never resize the button.
    const boxes = el.querySelectorAll<HTMLElement>('.scramble-box');
    expect(boxes.length).toBe(3);
    const labels: string[] = [];
    for (const box of Array.from(boxes)) {
      expect(box.classList.contains('scramble-box--center')).toBe(true);
      const ghost = box.querySelector<HTMLElement>('.scramble-ghost');
      const live = box.querySelector<HTMLElement>('.scramble-word');
      expect(ghost).not.toBeNull();
      expect(live).not.toBeNull();
      expect(live!.style.width).toBe(''); // no stale inline pixel lock
      expect(live!.textContent).toBe(ghost!.textContent);
      labels.push(ghost!.textContent ?? '');
    }
    expect(labels).toEqual(['Enter', 'The', 'Matrix']);

    // The decode animates the overlay only; the ghost (the layout box) never mutates.
    el.dispatchEvent(new Event('mouseenter'));
    const live = boxes[0].querySelector<HTMLElement>('.scramble-word')!;
    const ghost = boxes[0].querySelector<HTMLElement>('.scramble-ghost')!;
    // Sample several early frames (settle probability is 0 before frame 8): the
    // overlay must actually churn away from the label, or the decode is a no-op.
    let liveDeviated = false;
    for (let tick = 0; tick < 6; tick++) {
      vi.advanceTimersByTime(50);
      if (live.textContent !== 'Enter') liveDeviated = true;
      expect(ghost.textContent).toBe('Enter'); // the layout box never mutates
    }
    expect(liveDeviated).toBe(true);
    // After the full decode pass the overlay settles back to the exact label.
    vi.advanceTimersByTime(30 * 50);
    expect(live.textContent).toBe('Enter');
  });

  it('REQ-LANDING-006 AC4: the CTA box grows with over-wide churn frames instead of clipping (in-flow grid stacking)', () => {
    const css = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');
    // The button never clips: no overflow DECLARATION on the CTA rule (comments
    // may mention the word; the contract is that no clip is declared).
    const cta = css.match(/\.nav-signin--matrix\s*\{([^}]*)\}/);
    expect(cta).not.toBeNull();
    expect(cta![1]).not.toMatch(/overflow\s*:/);
    // The centered variant stacks ghost + live word in one IN-FLOW grid cell, so
    // the box (and the button around it) sizes to max(resting label, churn frame)
    // per tick — the dynamic-accommodation contract.
    const center = css.match(/\.scramble-box--center\s*\{([^}]*)\}/);
    expect(center).not.toBeNull();
    expect(center![1]).toMatch(/display:\s*inline-grid/);
    const stacked = css.match(
      /\.scramble-box--center\s+\.scramble-ghost,\s*\.scramble-box--center\s+\.scramble-word\s*\{([^}]*)\}/,
    );
    expect(stacked).not.toBeNull();
    expect(stacked![1]).toMatch(/grid-area:\s*1\s*\/\s*1/);
    // The live word contributes width in flow — it must not be the absolute overlay.
    // (matchAll: the first regex hit lands inside the combined ghost+word selector;
    // the standalone override rule is a later match.)
    const wordBlocks = [...css.matchAll(/\.scramble-box--center\s+\.scramble-word\s*\{([^}]*)\}/g)];
    expect(wordBlocks.some((m) => /position:\s*static/.test(m[1]))).toBe(true);
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
