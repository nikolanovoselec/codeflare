// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for feature-terminals.ts.
 *
 * The script runs top-level code at import time (querySelectorAll + forEach),
 * so each test MUST build the fixture DOM and mock window.matchMedia BEFORE
 * importing the module.  vi.resetModules() ensures a clean import per case.
 * vi.useFakeTimers() drives the setTimeout-based type/hold/delete loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The loop constants from the script — must match feature-terminals.ts exactly
// so that if the timing is changed the tests can catch stale values.
const TYPE_MS = 58;
const DELETE_MS = 32;
const HOLD_MS = 1700;
const GAP_MS = 360;
// Stagger offset added per terminal index (idx * 120ms in the hold phase,
// idx * 520ms on the initial start).
const INITIAL_STAGGER_IDX0_MS = 1100;

function buildFixture(loop: string[]): { term: HTMLElement; typed: HTMLElement } {
  const term = document.createElement('div');
  term.setAttribute('data-ft-loop', JSON.stringify(loop));
  const typed = document.createElement('span');
  typed.setAttribute('data-ft-typed', '');
  // Mirror the server-rendered resting state (Astro renders loop[0] into the slot)
  // so the reduced-motion path (script no-ops) correctly leaves loop[0] in place.
  typed.textContent = loop[0];
  term.appendChild(typed);
  document.body.appendChild(term);
  return { term, typed };
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

describe('feature-terminals.ts (REQ-LANDING-001)', () => {
  it('REQ-LANDING-001: types through the hold->delete->type cycle and mutates textContent at each phase', async () => {
    const loop = ['audit 41 calls', 'list approved models'];
    const { typed } = buildFixture(loop);
    mockMatchMedia(false);

    await import('../scripts/feature-terminals');

    // Before the initial stagger fires the typed slot holds the first command.
    expect(typed.textContent).toBe(loop[0]);

    // Fire the initial stagger for terminal at idx=0.
    vi.advanceTimersByTime(INITIAL_STAGGER_IDX0_MS);

    // The first step enters hold phase and schedules the next step after HOLD_MS.
    // Advance through hold into delete: the script deletes one char per DELETE_MS tick.
    const wordLen = loop[0].length;
    vi.advanceTimersByTime(HOLD_MS + wordLen * DELETE_MS + 50);

    // After full deletion the typed element must be shorter than the original word.
    expect(typed.textContent!.length).toBeLessThan(wordLen);

    // Advance through GAP_MS then type the second word char by char.
    const secondWordLen = loop[1].length;
    vi.advanceTimersByTime(GAP_MS + secondWordLen * TYPE_MS + 50);

    // The typed content must now be the second word (or a prefix of it that is
    // different from the first word), proving the loop advanced.
    expect(typed.textContent).not.toBe(loop[0]);
    expect(loop[1].startsWith(typed.textContent!)).toBe(true);
  });

  it('REQ-LANDING-001: textContent converges to the second loop word after a full type cycle', async () => {
    const loop = ['ab', 'cd'];
    const { typed } = buildFixture(loop);
    mockMatchMedia(false);

    await import('../scripts/feature-terminals');

    // Initial stagger + hold + delete 'ab' (2 chars) + gap + type 'cd' (2 chars).
    const totalMs =
      INITIAL_STAGGER_IDX0_MS + // initial stagger
      HOLD_MS + // hold phase
      2 * DELETE_MS + // delete 'a' then 'b'
      GAP_MS + // gap before typing
      2 * TYPE_MS + // type 'c' then 'd'
      200; // buffer

    vi.advanceTimersByTime(totalMs);

    expect(typed.textContent).toBe('cd');
  });

  it('REQ-LANDING-001: under prefers-reduced-motion the typed text is NOT mutated past the initial render', async () => {
    const loop = ['tail egress.log', 'audit 41 calls'];
    const { typed } = buildFixture(loop);
    mockMatchMedia(true); // reduced motion = true

    await import('../scripts/feature-terminals');

    // The script must bail out before registering any timers.
    // Advance well past every possible timeout — text must not change.
    vi.advanceTimersByTime(INITIAL_STAGGER_IDX0_MS + HOLD_MS + 10_000);

    // Under reduced motion the script does nothing — the slot must remain
    // exactly as the server rendered it (loop[0]).
    expect(typed.textContent).toBe(loop[0]);
  });

  it('REQ-LANDING-001: a terminal with an empty loop array is skipped (no mutation, no error)', async () => {
    // Empty loop must not crash and must leave the element untouched.
    const term = document.createElement('div');
    term.setAttribute('data-ft-loop', '[]');
    const typed = document.createElement('span');
    typed.setAttribute('data-ft-typed', '');
    typed.textContent = 'initial';
    term.appendChild(typed);
    document.body.appendChild(term);
    mockMatchMedia(false);

    await import('../scripts/feature-terminals');

    vi.advanceTimersByTime(INITIAL_STAGGER_IDX0_MS + HOLD_MS + 5_000);

    // Empty loop guard fires — element stays at its initial value.
    expect(typed.textContent).toBe('initial');
  });

  it('REQ-LANDING-001: a data-ft-once terminal (play-once mode) types through the run and rests on the final beat, no loop-back', async () => {
    const run = ['one', 'two', 'final'];
    const { typed } = buildFixture(run);
    // The engine's play-once mode (no live terminal uses it now that the hero
    // loops via data-ft-shuffle; this exercises the supported engine branch).
    (document.querySelector('[data-ft-loop]') as HTMLElement).setAttribute('data-ft-once', '');
    mockMatchMedia(false);

    await import('../scripts/feature-terminals');

    // Drain every scheduled timer. If once-mode looped, this never settles (vitest
    // throws on runaway timers); terminating at all is itself proof of no loop-back.
    vi.runAllTimers();

    // Play-once rests on the last beat, legible and final.
    expect(typed.textContent).toBe('final');
  });

  it('REQ-LANDING-001: a data-ft-shuffle terminal randomises the beat order (deterministic with a stubbed RNG)', async () => {
    const run = ['one', 'two', 'final'];
    const { typed } = buildFixture(run);
    const term = document.querySelector('[data-ft-loop]') as HTMLElement;
    term.setAttribute('data-ft-once', '');
    term.setAttribute('data-ft-shuffle', '');
    mockMatchMedia(false);
    // Fisher-Yates with Math.random()===0 maps ['one','two','final'] -> ['two','final','one'].
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0);

    await import('../scripts/feature-terminals');

    // The shuffle runs at import time: the resting/initial beat is the shuffled
    // head ('two'), not the authored loop[0] ('one'). That divergence is the proof
    // the shuffle fired (a no-shuffle run would still read 'one' here).
    expect(typed.textContent).toBe('two');

    // Play-once still holds under shuffle: draining every timer terminates and
    // rests on the shuffled last beat ('one'), never looping back.
    vi.runAllTimers();
    expect(typed.textContent).toBe('one');

    rng.mockRestore();
  });

  it('REQ-LANDING-001: a terminal with invalid JSON in data-ft-loop is skipped gracefully', async () => {
    const term = document.createElement('div');
    term.setAttribute('data-ft-loop', 'not-json');
    const typed = document.createElement('span');
    typed.setAttribute('data-ft-typed', '');
    typed.textContent = 'untouched';
    term.appendChild(typed);
    document.body.appendChild(term);
    mockMatchMedia(false);

    // Must not throw on import.
    await expect(import('../scripts/feature-terminals')).resolves.toBeDefined();

    vi.advanceTimersByTime(5_000);
    expect(typed.textContent).toBe('untouched');
  });
});
