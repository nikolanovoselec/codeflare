// @vitest-environment happy-dom
/**
 * Behavioral DOM integration tests for REQ-LANDING-011 motion and REQ-LANDING-012 accessibility.
 *
 * The server-rendered fixture begins complete and readable. The motion-enabled
 * enhancement masks the visual copy, fills recent context, appends new events,
 * scrolls old history, flips once, and settles. Reduced motion must leave the
 * resolved server render untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Fixture {
  root: HTMLElement;
  software: HTMLElement;
  infrastructure: HTMLElement;
  softwareLines: HTMLElement[];
  infrastructureLines: HTMLElement[];
}

function addFace(
  root: HTMLElement,
  name: 'software' | 'infrastructure',
  contextCount = 3,
  eventCount = 6,
): { face: HTMLElement; lines: HTMLElement[] } {
  const face = document.createElement('section');
  face.dataset.executionFace = name;
  const log = document.createElement('div');
  log.dataset.executionLog = '';

  const lines: HTMLElement[] = [];
  for (let index = 0; index < contextCount + eventCount; index += 1) {
    const line = document.createElement('div');
    line.dataset.executionLine = index < contextCount ? 'context' : 'event';
    line.dataset.executionIndex = String(index);
    const text = document.createElement('span');
    text.dataset.executionText = '';
    text.dataset.fullText = `${name}-line-${index}`;
    text.textContent = text.dataset.fullText;
    line.appendChild(text);
    log.appendChild(line);
    lines.push(line);
  }

  const caret = document.createElement('span');
  caret.dataset.executionCaret = '';
  face.append(log, caret);
  root.appendChild(face);
  return { face, lines };
}

function buildFixture(): Fixture {
  const root = document.createElement('div');
  root.dataset.executionReel = '';
  root.dataset.executionState = 'resolved';
  const software = addFace(root, 'software');
  const infrastructure = addFace(root, 'infrastructure');
  document.body.appendChild(root);
  return {
    root,
    software: software.face,
    infrastructure: infrastructure.face,
    softwareLines: software.lines,
    infrastructureLines: infrastructure.lines,
  };
}

function mockMatchMedia(prefersReducedMotion: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
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

function installIntersectionObserver(): {
  intersect: (target: Element) => void;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
} {
  let callback: IntersectionObserverCallback = () => undefined;
  const observe = vi.fn();
  const unobserve = vi.fn();
  class MockIntersectionObserver {
    constructor(next: IntersectionObserverCallback) {
      callback = next;
    }
    observe = observe;
    unobserve = unobserve;
    disconnect = vi.fn();
    takeRecords = vi.fn().mockReturnValue([]);
    root = null;
    rootMargin = '0px';
    thresholds = [0];
  }
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: MockIntersectionObserver,
  });
  return {
    intersect: (target: Element) =>
      callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    observe,
    unobserve,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('execution-reel.ts (REQ-LANDING-011/REQ-LANDING-012)', () => {
  it('enhances on entry, fills context, then appends software events while scrolling old history', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/execution-reel');

    expect(fixture.root.classList.contains('is-enhanced')).toBe(true);
    expect(fixture.root.dataset.executionState).toBe('software');
    expect(fixture.softwareLines.every((line) => !line.classList.contains('is-visible'))).toBe(true);

    const firstText = fixture.softwareLines[0].querySelector<HTMLElement>('[data-execution-text]')!;
    const fullText = firstText.dataset.fullText!;
    expect(firstText.textContent).toBe('');
    vi.advanceTimersByTime(20);
    expect(firstText.textContent!.length).toBeGreaterThan(0);
    expect(firstText.textContent!.length).toBeLessThan(fullText.length);
    vi.advanceTimersByTime(500);
    expect(firstText.textContent).toBe(fullText);

    vi.advanceTimersByTime(1_000);
    expect(
      fixture.softwareLines.slice(0, 3).every((line) => line.classList.contains('is-visible')),
    ).toBe(true);

    vi.advanceTimersByTime(4_500);
    expect(
      fixture.softwareLines.slice(3).some((line) => line.classList.contains('is-visible')),
    ).toBe(true);
    expect(
      fixture.softwareLines.some((line) => line.classList.contains('is-history')),
    ).toBe(true);
  });

  it('waits for intersection, starts once, and never restarts on later intersections', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/execution-reel');

    expect(observer.observe).toHaveBeenCalledWith(fixture.root);
    expect(fixture.root.classList.contains('is-ready')).toBe(true);
    expect(fixture.root.classList.contains('is-enhanced')).toBe(false);

    observer.intersect(fixture.root);
    expect(fixture.root.classList.contains('is-enhanced')).toBe(true);
    expect(observer.unobserve).toHaveBeenCalledWith(fixture.root);

    vi.advanceTimersByTime(8_000);
    expect(fixture.root.dataset.executionFlips).toBe('1');

    observer.intersect(fixture.root);
    vi.advanceTimersByTime(20_000);
    expect(fixture.root.dataset.executionFlips).toBe('1');
  });

  it('prepares infrastructure context off-face, flips exactly once, and appends its execution events', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/execution-reel');

    vi.advanceTimersByTime(6_500);
    expect(
      fixture.infrastructureLines.slice(0, 3).every((line) => line.classList.contains('is-visible')),
    ).toBe(true);
    expect(fixture.root.dataset.executionFlips).toBe('0');

    vi.advanceTimersByTime(1_500);
    expect(fixture.root.dataset.executionFlips).toBe('1');
    expect(fixture.root.dataset.executionState).toBe('infrastructure');

    vi.advanceTimersByTime(4_000);
    expect(
      fixture.infrastructureLines.slice(3).some((line) => line.classList.contains('is-visible')),
    ).toBe(true);
  });

  it('settles after one bounded run with only the infrastructure cursor active', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/execution-reel');
    vi.advanceTimersByTime(16_000);

    expect(fixture.root.dataset.executionState).toBe('complete');
    expect(fixture.root.dataset.executionFlips).toBe('1');
    expect(fixture.software.querySelector('[data-execution-caret]')?.getAttribute('data-active')).toBe('false');
    expect(
      fixture.infrastructure.querySelector('[data-execution-caret]')?.getAttribute('data-active'),
    ).toBe('true');
    expect(
      fixture.infrastructureLines.every((line) =>
        line.classList.contains('is-visible') || line.classList.contains('is-history'),
      ),
    ).toBe(true);
  });

  it('does not arm the JavaScript enhancement under reduced motion', async () => {
    const fixture = buildFixture();
    mockMatchMedia(true);
    removeIntersectionObserver();

    await import('../scripts/execution-reel');
    vi.advanceTimersByTime(30_000);

    expect(fixture.root.classList.contains('is-ready')).toBe(false);
    expect(fixture.root.classList.contains('is-enhanced')).toBe(false);
    expect(fixture.root.dataset.executionState).toBe('resolved');
    expect(fixture.root.dataset.executionFlips).toBeUndefined();
    expect(fixture.root.querySelector('[data-active="true"]')).toBeNull();
  });

  it('preserves both server-rendered transcripts under reduced motion', async () => {
    const fixture = buildFixture();
    const originalSoftware = fixture.software.textContent;
    const originalInfrastructure = fixture.infrastructure.textContent;
    mockMatchMedia(true);
    removeIntersectionObserver();

    await import('../scripts/execution-reel');
    vi.advanceTimersByTime(30_000);

    expect(fixture.software.textContent).toBe(originalSoftware);
    expect(fixture.infrastructure.textContent).toBe(originalInfrastructure);
  });
});
