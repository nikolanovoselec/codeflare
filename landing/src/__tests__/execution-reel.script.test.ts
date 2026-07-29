// @vitest-environment happy-dom
/**
 * Behavioral DOM integration tests for REQ-LANDING-011 motion and
 * REQ-LANDING-012 accessibility. Each terminal owns one readable, one-shot
 * timeline; reduced motion and unsupported observers keep the complete SSR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Fixture {
  root: HTMLElement;
  software: HTMLElement;
  infrastructure: HTMLElement;
  softwareContext: HTMLElement[];
  softwareEvents: HTMLElement[];
  infrastructureEvents: HTMLElement[];
}

function addFace(root: HTMLElement, name: 'software' | 'infrastructure') {
  const face = document.createElement('section');
  face.dataset.executionFace = name;
  face.dataset.executionState = 'resolved';
  const context: HTMLElement[] = [];
  const events: HTMLElement[] = [];

  for (let index = 0; index < 10; index += 1) {
    const line = document.createElement('div');
    line.dataset.executionLine = index < 5 ? 'context' : 'event';
    const text = document.createElement('span');
    text.dataset.executionText = '';
    text.dataset.fullText = `${name}-line-${index}`;
    text.textContent = text.dataset.fullText;
    line.appendChild(text);
    face.appendChild(line);
    (index < 5 ? context : events).push(line);
  }

  const caret = document.createElement('span');
  caret.dataset.executionCaret = '';
  caret.dataset.active = 'false';
  face.appendChild(caret);
  root.appendChild(face);
  return { face, context, events };
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
    softwareContext: software.context,
    softwareEvents: software.events,
    infrastructureEvents: infrastructure.events,
  };
}

function text(line: HTMLElement): HTMLElement {
  return line.querySelector<HTMLElement>('[data-execution-text]')!;
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
    intersect: (target: Element) => callback(
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
  it('arms both terminals while preserving five readable context lines', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/execution-reel');

    expect(observer.observe).toHaveBeenCalledTimes(2);
    expect(observer.observe).toHaveBeenCalledWith(fixture.software);
    expect(observer.observe).toHaveBeenCalledWith(fixture.infrastructure);
    expect(fixture.root.classList.contains('is-ready')).toBe(true);
    expect(fixture.softwareContext.map((line) => text(line).textContent)).toEqual(
      fixture.softwareContext.map((line) => text(line).dataset.fullText),
    );
    expect(fixture.softwareEvents.every((line) => text(line).textContent === '')).toBe(true);
  });

  it('types exactly five software events once without starting or clearing infrastructure', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/execution-reel');
    observer.intersect(fixture.software);

    expect(observer.unobserve).toHaveBeenCalledWith(fixture.software);
    vi.advanceTimersByTime(30);
    const first = text(fixture.softwareEvents[0]);
    expect(first.textContent!.length).toBeGreaterThan(0);
    expect(first.textContent!.length).toBeLessThan(first.dataset.fullText!.length);

    vi.advanceTimersByTime(15_000);
    expect(fixture.software.dataset.executionState).toBe('complete');
    expect(fixture.softwareEvents.map((line) => text(line).textContent)).toEqual(
      fixture.softwareEvents.map((line) => text(line).dataset.fullText),
    );
    expect(fixture.software.querySelectorAll('.is-history')).toHaveLength(0);
    expect(fixture.infrastructureEvents.every((line) => text(line).textContent === '')).toBe(true);

    const settledTranscript = fixture.softwareEvents.map((line) => text(line).textContent);
    const settledTimers = vi.getTimerCount();
    observer.intersect(fixture.software);
    vi.advanceTimersByTime(30);
    expect(fixture.softwareEvents.map((line) => text(line).textContent)).toEqual(settledTranscript);
    expect(fixture.software.dataset.executionState).toBe('complete');
    expect(fixture.software.querySelector('[data-execution-caret]')?.getAttribute('data-active')).toBe('false');
    expect(vi.getTimerCount()).toBe(settledTimers);
  });

  it('starts the stacked infrastructure terminal only when that terminal enters view', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/execution-reel');
    observer.intersect(fixture.software);
    vi.advanceTimersByTime(15_000);
    expect(fixture.root.dataset.executionState).toBe('running');

    observer.intersect(fixture.infrastructure);
    vi.advanceTimersByTime(15_000);
    expect(fixture.infrastructure.dataset.executionState).toBe('complete');
    expect(fixture.root.dataset.executionState).toBe('complete');
    expect(fixture.root.dataset.executionFlips).toBeUndefined();
    expect(fixture.root.querySelector('[data-active="true"]')).toBeNull();
  });

  it('preserves both complete server-rendered transcripts under reduced motion', async () => {
    const fixture = buildFixture();
    const original = fixture.root.textContent;
    mockMatchMedia(true);
    const observer = installIntersectionObserver();

    await import('../scripts/execution-reel');
    vi.advanceTimersByTime(30_000);

    expect(observer.observe).not.toHaveBeenCalled();
    expect(fixture.root.classList.contains('is-ready')).toBe(false);
    expect(fixture.root.textContent).toBe(original);
    expect(fixture.root.dataset.executionState).toBe('resolved');
  });

  it('keeps the complete static transcripts when intersection observation is unavailable', async () => {
    const fixture = buildFixture();
    const original = fixture.root.textContent;
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/execution-reel');
    vi.advanceTimersByTime(30_000);

    expect(fixture.root.classList.contains('is-ready')).toBe(false);
    expect(fixture.root.textContent).toBe(original);
  });
});
