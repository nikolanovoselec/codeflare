// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for agentfoot.ts.
 *
 * The script runs two setInterval loops at import time (when
 * prefers-reduced-motion is false):
 *   1. ctx tick: every 3600ms, increments pct (12..41) and writes
 *      "context N%" into [data-tf-ctx].
 *   2. compaction beat: every 24000ms, adds .is-compacting to the foot and
 *      writes "⟳ compacting…" into [data-tf-reason]; 2800ms later removes
 *      the class and restores the original reason text.
 *
 * Each test builds the DOM and mocks matchMedia BEFORE importing the module.
 * vi.resetModules() + vi.useFakeTimers() are coordinated in beforeEach/afterEach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CTX_TICK_MS = 3_600;
const COMPACTION_EVERY_MS = 24_000;
const COMPACTION_HOLD_MS = 2_800;

function buildFootFixture(initialCtx = 'context 18%', initialReason = 'reasoning high'): {
  foot: HTMLElement;
  ctxEl: HTMLElement;
  reasonEl: HTMLElement;
} {
  const foot = document.createElement('div');
  foot.setAttribute('data-agentfoot', '');

  const ctxEl = document.createElement('span');
  ctxEl.setAttribute('data-tf-ctx', '');
  ctxEl.textContent = initialCtx;
  foot.appendChild(ctxEl);

  const reasonEl = document.createElement('span');
  reasonEl.setAttribute('data-tf-reason', '');
  reasonEl.textContent = initialReason;
  foot.appendChild(reasonEl);

  document.body.appendChild(foot);
  return { foot, ctxEl, reasonEl };
}

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

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('agentfoot.ts (REQ-LANDING-001)', () => {
  it('REQ-LANDING-001: ctx tick increments the context percentage after CTX_TICK_MS', async () => {
    const { ctxEl } = buildFootFixture('context 18%');
    mockMatchMedia(false);

    await import('../scripts/agentfoot');

    // Before any tick the value is the server-rendered initial.
    expect(ctxEl.textContent).toBe('context 18%');

    // Advance one tick interval.
    vi.advanceTimersByTime(CTX_TICK_MS);

    // After one tick the percentage must have changed to 19%.
    expect(ctxEl.textContent).toBe('context 19%');
  });

  it('REQ-LANDING-001: ctx tick wraps from 41 back to 12 (stays in realistic band, never races to 100)', async () => {
    const { ctxEl } = buildFootFixture('context 41%');
    mockMatchMedia(false);

    // Patch the initial pct to 41 by adjusting the initial text — but pct is
    // a local variable in the IIFE, initialised to 18.  To test wrapping, we
    // advance 23 ticks (18+23=41) and then one more.
    await import('../scripts/agentfoot');

    // 23 ticks to reach pct=41.
    vi.advanceTimersByTime(CTX_TICK_MS * 23);
    expect(ctxEl.textContent).toBe('context 41%');

    // One more tick: pct >= 41 so it wraps to 12.
    vi.advanceTimersByTime(CTX_TICK_MS);
    expect(ctxEl.textContent).toBe('context 12%');
  });

  it('REQ-LANDING-001: compaction beat adds is-compacting class and changes reason text, then removes both after COMPACTION_HOLD_MS', async () => {
    const { foot, reasonEl } = buildFootFixture('context 18%', 'reasoning high');
    mockMatchMedia(false);

    await import('../scripts/agentfoot');

    // Advance to the compaction beat.
    vi.advanceTimersByTime(COMPACTION_EVERY_MS);

    // During the beat: is-compacting must be present and reason text updated.
    expect(foot.classList.contains('is-compacting')).toBe(true);
    expect(reasonEl.textContent).toBe('⟳ compacting…');

    // Advance through the hold period.
    vi.advanceTimersByTime(COMPACTION_HOLD_MS);

    // After hold: is-compacting must be removed and reason restored.
    expect(foot.classList.contains('is-compacting')).toBe(false);
    expect(reasonEl.textContent).toBe('reasoning high');
  });

  it('REQ-LANDING-001: compaction beat restores the ORIGINAL reason text, not a hardcoded string', async () => {
    // If the script hardcodes "reasoning high" instead of reading baseReason,
    // a foot with a different initial reason would show the wrong text after
    // compaction.  This test catches that regression.
    const customReason = 'reasoning max';
    const { foot, reasonEl } = buildFootFixture('context 18%', customReason);
    mockMatchMedia(false);

    await import('../scripts/agentfoot');

    vi.advanceTimersByTime(COMPACTION_EVERY_MS);
    expect(reasonEl.textContent).toBe('⟳ compacting…');

    vi.advanceTimersByTime(COMPACTION_HOLD_MS);

    // Must restore to the custom initial reason, not "reasoning high".
    expect(reasonEl.textContent).toBe(customReason);
    expect(foot.classList.contains('is-compacting')).toBe(false);
  });

  it('REQ-LANDING-001: under prefers-reduced-motion the foot is static — no ctx mutation, no is-compacting', async () => {
    const { foot, ctxEl, reasonEl } = buildFootFixture('context 18%', 'reasoning high');
    mockMatchMedia(true); // reduced motion = true

    await import('../scripts/agentfoot');

    // Advance well past both intervals.
    vi.advanceTimersByTime(COMPACTION_EVERY_MS + COMPACTION_HOLD_MS + CTX_TICK_MS * 30);

    // Under reduced motion the script does nothing — all values stay at their
    // server-rendered initial state.
    expect(ctxEl.textContent).toBe('context 18%');
    expect(reasonEl.textContent).toBe('reasoning high');
    expect(foot.classList.contains('is-compacting')).toBe(false);
  });
});
