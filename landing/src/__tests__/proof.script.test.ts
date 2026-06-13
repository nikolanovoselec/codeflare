// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for proof.ts.
 *
 * The script runs top-level code at import time (querySelectorAll, matchMedia,
 * IntersectionObserver).  Each test MUST configure the DOM and window mocks
 * BEFORE importing the module.  vi.resetModules() per afterEach gives each
 * case a clean module instance.
 *
 * The no-IntersectionObserver path (the immediate-arm fallback) is the
 * reliable test target: delete window.IntersectionObserver before import and
 * the script arms every [data-proof] element immediately without needing a
 * real intersection event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ROLL_FIRST_MS = 3000;
const ROLL_EVERY_MS = 2600;
const PHASE_MS = 420;

function buildProofArtifact(childCount = 4): { proof: HTMLElement; roll: HTMLElement } {
  const proof = document.createElement('div');
  proof.setAttribute('data-proof', '');

  const roll = document.createElement('ul');
  roll.setAttribute('data-roll', '');
  for (let i = 0; i < childCount; i++) {
    const li = document.createElement('li');
    li.textContent = `row-${i}`;
    roll.appendChild(li);
  }
  proof.appendChild(roll);
  document.body.appendChild(proof);
  return { proof, roll };
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

function removeIntersectionObserver(): void {
  // Deleting IntersectionObserver makes the script take the immediate-arm path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).IntersectionObserver;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('proof.ts (REQ-LANDING-001)', () => {
  it('REQ-LANDING-001: arms proof artifacts immediately when IntersectionObserver is absent (no-IO fallback)', async () => {
    const { proof } = buildProofArtifact();
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/proof');

    // The no-IO fallback must add is-live synchronously at import time.
    expect(proof.classList.contains('is-live')).toBe(true);
  });

  it('REQ-LANDING-001: roll cycle moves the first child to the bottom after ROLL_FIRST_MS', async () => {
    const { proof, roll } = buildProofArtifact(4);
    mockMatchMedia(false);
    removeIntersectionObserver();

    // Capture the original first-child text before any rolling.
    const originalFirst = roll.children[0].textContent;

    await import('../scripts/proof');

    // Advance past the first roll trigger.
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS * 2 + 100);

    // The original first child must now be the LAST child (moved to bottom).
    const lastChild = roll.children[roll.children.length - 1];
    expect(lastChild.textContent).toBe(originalFirst);
    // The new first child must be different from the original first.
    expect(roll.children[0].textContent).not.toBe(originalFirst);
  });

  it('REQ-LANDING-001: re-entrancy guard - a second rollOnce while a cycle is in flight starts no new cycle', async () => {
    // The production interval (2600ms) never lands inside a cycle (~840ms), so the
    // guard can only be exercised directly. Drive rollOnce twice synchronously via
    // the test seam: the first arms a cycle (rolling=1, one scheduled timeout); the
    // second must early-return on the guard and schedule nothing. The list is
    // standalone (not inside [data-proof]) so the module's own auto-roll never runs
    // on it and cannot pollute the scheduled-timeout count.
    const list = document.createElement('ul');
    for (let i = 0; i < 4; i++) {
      const li = document.createElement('li');
      li.textContent = `row-${i}`;
      list.appendChild(li);
    }
    document.body.appendChild(list);
    mockMatchMedia(false);
    removeIntersectionObserver();
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      height: 120, width: 300, top: 0, left: 0, right: 300, bottom: 120, x: 0, y: 0, toJSON: () => ({}),
    });

    const mod = await import('../scripts/proof');
    const rollOnce = mod.__rollTest.rollOnce;

    const spy = vi.spyOn(window, 'setTimeout');
    rollOnce(list);
    expect(list.dataset.rolling).toBe('1'); // first call armed a cycle
    const scheduledAfterFirst = spy.mock.calls.length;
    rollOnce(list); // guarded: rolling==='1' -> early return, schedules nothing
    const scheduledAfterSecond = spy.mock.calls.length;
    // If the guard were removed, the second call would schedule another cycle.
    expect(scheduledAfterSecond).toBe(scheduledAfterFirst);
    spy.mockRestore();
  });

  it('REQ-LANDING-001: a [data-roll] list with fewer than 3 children is not rolled', async () => {
    // The script requires >= 3 children to roll (short lists would look broken).
    const proof = document.createElement('div');
    proof.setAttribute('data-proof', '');
    const roll = document.createElement('ul');
    roll.setAttribute('data-roll', '');
    for (let i = 0; i < 2; i++) {
      const li = document.createElement('li');
      li.textContent = `row-${i}`;
      roll.appendChild(li);
    }
    proof.appendChild(roll);
    document.body.appendChild(proof);

    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/proof');

    const originalOrder = Array.from(roll.children).map((c) => c.textContent);
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS * 2 + 100);

    expect(Array.from(roll.children).map((c) => c.textContent)).toEqual(originalOrder);
  });

  it('REQ-LANDING-001: under prefers-reduced-motion no is-live class is added and list order is unchanged', async () => {
    const { proof, roll } = buildProofArtifact(4);
    mockMatchMedia(true); // reduced motion = true
    removeIntersectionObserver();

    const originalOrder = Array.from(roll.children).map((c) => c.textContent);

    await import('../scripts/proof');

    // Advance well past all timers.
    vi.advanceTimersByTime(ROLL_FIRST_MS + 10_000);

    // Under reduced motion: no is-live, no roll.
    expect(proof.classList.contains('is-live')).toBe(false);
    expect(Array.from(roll.children).map((c) => c.textContent)).toEqual(originalOrder);
  });
});
