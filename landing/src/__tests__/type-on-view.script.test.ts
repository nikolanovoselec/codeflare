// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for type-on-view.ts.
 *
 * The script runs top-level code at import time (querySelectorAll, matchMedia,
 * IntersectionObserver). Each test configures the DOM and window mocks BEFORE
 * importing the module; vi.resetModules() per afterEach gives a clean instance.
 *
 * Two reliable seams: deleting IntersectionObserver takes the immediate-arm
 * fallback (types every line without an intersection event), and a captured-
 * callback mock IO proves typing is gated on the line scrolling into view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must match TYPE_MS in type-on-view.ts so a stale cadence is caught here.
const TYPE_MS = 58;

function buildLine(text: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 't-line';
  const typeline = document.createElement('span');
  typeline.setAttribute('data-typeline', '');
  // Mirror Astro's server render: the full, resolved line text is present.
  typeline.textContent = text;
  wrap.appendChild(typeline);
  const caret = document.createElement('span');
  caret.className = 't-caret';
  wrap.appendChild(caret);
  document.body.appendChild(wrap);
  return typeline;
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

describe('type-on-view.ts (REQ-LANDING-001)', () => {
  it('REQ-LANDING-001: clears the line then types it back in one char per TYPE_MS (no-IO fallback)', async () => {
    const text = 'hello world';
    const typeline = buildLine(text);
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/type-on-view');

    // Armed immediately on the no-IO path: the line is emptied at import time.
    expect(typeline.textContent).toBe('');

    // One character lands per TYPE_MS, growing toward the full line.
    vi.advanceTimersByTime(TYPE_MS);
    expect(typeline.textContent).toBe('h');
    vi.advanceTimersByTime(TYPE_MS * 4);
    expect(text.startsWith(typeline.textContent!)).toBe(true);
    expect(typeline.textContent!.length).toBeGreaterThan(1);

    // It converges on exactly the full line and then stops (no loop, no overrun).
    vi.advanceTimersByTime(TYPE_MS * text.length + 100);
    expect(typeline.textContent).toBe(text);
  });

  it('REQ-LANDING-001: under prefers-reduced-motion the line is never cleared or mutated', async () => {
    const text = 'resolved line';
    const typeline = buildLine(text);
    mockMatchMedia(true);
    removeIntersectionObserver();

    await import('../scripts/type-on-view');

    // The script bails before touching the DOM: the full line stands.
    vi.advanceTimersByTime(TYPE_MS * 100 + 5_000);
    expect(typeline.textContent).toBe(text);
  });

  it('REQ-LANDING-001: typing is gated on the terminal scrolling into view (IntersectionObserver)', async () => {
    const text = 'on view';
    const typeline = buildLine(text);
    mockMatchMedia(false);

    let ioCallback: IntersectionObserverCallback = () => {};
    const observe = vi.fn();
    const unobserve = vi.fn();
    class MockIO {
      constructor(cb: IntersectionObserverCallback) {
        ioCallback = cb;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = vi.fn();
      takeRecords = () => [];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).IntersectionObserver = MockIO as any;

    await import('../scripts/type-on-view');

    // Observed, not yet intersecting: the full line is untouched.
    expect(observe).toHaveBeenCalledTimes(1);
    expect(typeline.textContent).toBe(text);
    vi.advanceTimersByTime(TYPE_MS * text.length + 100);
    expect(typeline.textContent).toBe(text);

    // Fire the intersection: now it clears and types, then unobserves (once only).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ioCallback([{ isIntersecting: true, target: typeline } as any], {} as any);
    expect(typeline.textContent).toBe('');
    expect(unobserve).toHaveBeenCalledWith(typeline);
    vi.advanceTimersByTime(TYPE_MS * text.length + 100);
    expect(typeline.textContent).toBe(text);
  });

  it('REQ-LANDING-001: an empty [data-typeline] is left untouched, no error', async () => {
    const typeline = buildLine('');
    mockMatchMedia(false);
    removeIntersectionObserver();

    await expect(import('../scripts/type-on-view')).resolves.toBeDefined();

    vi.advanceTimersByTime(5_000);
    expect(typeline.textContent).toBe('');
  });
});
