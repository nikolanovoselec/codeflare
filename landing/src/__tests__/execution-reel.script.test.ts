// @vitest-environment happy-dom
/**
 * Behavioral integration coverage for REQ-LANDING-011 motion and
 * REQ-LANDING-012 accessibility. Execution composes the shared Transcript feed
 * with proof.ts: a full five-line viewport rolls once per typed event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROLL_FIRST_MS = 3_000;
const PHASE_MS = 420;
const TYPE_MS = 58;

interface FeedLine {
  tone: 'cmd' | 'agent' | 'ok' | 'dim' | 'warn' | 'deny';
  text: string;
}

interface FeedFixture {
  root: HTMLElement;
  software: HTMLElement;
  infrastructure: HTMLElement;
  softwareList: HTMLElement;
  infrastructureList: HTMLElement;
  softwareContext: FeedLine[];
  softwareEvents: FeedLine[];
  infrastructureContext: FeedLine[];
  infrastructureEvents: FeedLine[];
}

function addFeed(
  root: HTMLElement,
  name: 'software' | 'infrastructure',
): { face: HTMLElement; list: HTMLElement; context: FeedLine[]; events: FeedLine[] } {
  const context = Array.from({ length: 5 }, (_, index): FeedLine => ({
    tone: index % 2 === 0 ? 'cmd' : 'dim',
    text: `${name}-context-${index}`,
  }));
  const events = Array.from({ length: 5 }, (_, index): FeedLine => ({
    tone: index % 2 === 0 ? 'ok' : 'warn',
    text: `${name}-event-${index}`,
  }));
  const face = document.createElement('section');
  face.dataset.proof = '';
  face.dataset.executionFace = name;
  const list = document.createElement('div');
  list.dataset.roll = '';
  list.dataset.feedContext = JSON.stringify(context);
  list.dataset.feedEvents = JSON.stringify(events);
  list.dataset.feedState = 'resolved';
  for (const line of events) {
    const row = document.createElement('span');
    row.className = `t-line t-${line.tone}`;
    row.textContent = line.text;
    list.appendChild(row);
  }
  face.appendChild(list);
  root.appendChild(face);
  return { face, list, context, events };
}

function buildFixture(): FeedFixture {
  const root = document.createElement('div');
  root.dataset.executionReel = '';
  const software = addFeed(root, 'software');
  const infrastructure = addFeed(root, 'infrastructure');
  document.body.appendChild(root);
  return {
    root,
    software: software.face,
    infrastructure: infrastructure.face,
    softwareList: software.list,
    infrastructureList: infrastructure.list,
    softwareContext: software.context,
    softwareEvents: software.events,
    infrastructureContext: infrastructure.context,
    infrastructureEvents: infrastructure.events,
  };
}

function visibleLines(list: HTMLElement): string[] {
  return Array.from(list.children).map(
    (line) => line.querySelector<HTMLElement>('[data-feed-live]')?.textContent ?? line.textContent ?? '',
  );
}

function removeIntersectionObserver(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).IntersectionObserver;
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

function installIntersectionObserver(): {
  intersect: (target: Element, phase?: 'all' | 'prearm' | 'feed') => void;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
} {
  const observers: Array<{
    callback: IntersectionObserverCallback;
    options?: IntersectionObserverInit;
  }> = [];
  const observe = vi.fn();
  const unobserve = vi.fn();
  class MockIntersectionObserver {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      observers.push({ callback, options });
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
    intersect: (target: Element, phase = 'all') => {
      for (const observer of observers) {
        const isPrearm = observer.options?.rootMargin === '0px 0px 100px 0px';
        const isFeed = observer.options?.threshold === 0.01;
        if (phase === 'prearm' && !isPrearm) continue;
        if (phase === 'feed' && !isFeed) continue;
        observer.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      }
    },
    observe,
    unobserve,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
  Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    height: 150,
    width: 500,
    top: 0,
    left: 0,
    right: 500,
    bottom: 150,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('shared transcript feed (REQ-LANDING-011/REQ-LANDING-012)', () => {
  it('prepares both terminals as full five-line context viewports', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');

    expect(observer.observe).toHaveBeenCalledWith(fixture.software);
    expect(observer.observe).toHaveBeenCalledWith(fixture.infrastructure);
    expect(visibleLines(fixture.softwareList)).toEqual(fixture.softwareContext.map((line) => line.text));
    expect(visibleLines(fixture.infrastructureList)).toEqual(
      fixture.infrastructureContext.map((line) => line.text),
    );
    expect(fixture.softwareList.children).toHaveLength(5);
    expect(fixture.infrastructureList.children).toHaveLength(5);
  });

  it('slowly types five events while each event pushes the oldest visible line out', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software, 'prearm');
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS + TYPE_MS * 2);
    expect(fixture.softwareList.dataset.feedState).toBe('ready');
    expect(visibleLines(fixture.softwareList)).toEqual(fixture.softwareContext.map((line) => line.text));

    observer.intersect(fixture.software, 'feed');
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS + TYPE_MS - 1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe('');
    vi.advanceTimersByTime(1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text.slice(0, 1));
    vi.advanceTimersByTime(TYPE_MS - 1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text.slice(0, 1));
    vi.advanceTimersByTime(1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text.slice(0, 2));
    expect(visibleLines(fixture.softwareList)[0]).toBe(fixture.softwareContext[1].text);
    expect(visibleLines(fixture.infrastructureList)).toEqual(
      fixture.infrastructureContext.map((line) => line.text),
    );

    vi.advanceTimersByTime(60_000);
    expect(visibleLines(fixture.softwareList)).toEqual(fixture.softwareEvents.map((line) => line.text));
    expect(fixture.softwareList.dataset.feedState).toBe('complete');
    expect(fixture.softwareList.querySelector('.t-caret')).toBeNull();
    expect(fixture.softwareList.children).toHaveLength(5);
  });

  it('keeps wrapped row geometry reserved for the complete event while typing', async () => {
    const fixture = buildFixture();
    fixture.softwareEvents[0].text = 'software-event-that-wraps-across-several-narrow-viewport-lines';
    fixture.softwareList.dataset.feedEvents = JSON.stringify(fixture.softwareEvents);
    fixture.softwareList.getBoundingClientRect = vi.fn().mockImplementation(() => {
      const constrainedHeight = Number.parseFloat(fixture.softwareList.style.height);
      const lastRowText = fixture.softwareList.lastElementChild?.textContent ?? '';
      const naturalHeight = lastRowText.length > 40 ? 220 : 150;
      const height = Number.isNaN(constrainedHeight) ? naturalHeight : constrainedHeight;
      return {
        height,
        width: 320,
        top: 0,
        left: 0,
        right: 320,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software, 'feed');
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS + TYPE_MS);

    const typingRow = fixture.softwareList.lastElementChild as HTMLElement;
    expect(typingRow.querySelector('[data-feed-reserve]')?.textContent).toBe(
      fixture.softwareEvents[0].text,
    );
    expect(typingRow.querySelector('[data-feed-live]')?.textContent).toBe(
      fixture.softwareEvents[0].text.slice(0, 1),
    );
    expect(typingRow.classList.contains('is-feed-typing')).toBe(true);
    expect(fixture.softwareList.style.height).toBe('220px');
    const reservedHeight = fixture.softwareList.getBoundingClientRect().height;

    vi.advanceTimersByTime(PHASE_MS);
    expect(fixture.softwareList.style.height).toBe('');
    expect(fixture.softwareList.getBoundingClientRect().height).toBe(reservedHeight);

    vi.advanceTimersByTime(TYPE_MS * (fixture.softwareEvents[0].text.length - 1));
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text);
    expect(fixture.softwareList.lastElementChild?.querySelector('[data-feed-reserve]')).toBeNull();
    expect(fixture.softwareList.getBoundingClientRect().height).toBe(reservedHeight);
  });

  it('rejects either malformed feed payload without replacing or animating the resolved viewport', async () => {
    const fixture = buildFixture();
    const softwareResolved = visibleLines(fixture.softwareList);
    const infrastructureResolved = visibleLines(fixture.infrastructureList);
    fixture.softwareList.dataset.feedContext = '{';
    fixture.infrastructureEvents[2] = { tone: 'ok', text: '' };
    fixture.infrastructureList.dataset.feedEvents = JSON.stringify(fixture.infrastructureEvents);
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software, 'feed');
    observer.intersect(fixture.infrastructure, 'feed');
    vi.advanceTimersByTime(60_000);

    expect(visibleLines(fixture.softwareList)).toEqual(softwareResolved);
    expect(visibleLines(fixture.infrastructureList)).toEqual(infrastructureResolved);
    expect(fixture.softwareList.dataset.feedState).toBe('resolved');
    expect(fixture.infrastructureList.dataset.feedState).toBe('resolved');
    expect(fixture.softwareList.dataset.feedStarted).toBeUndefined();
    expect(fixture.infrastructureList.dataset.feedStarted).toBeUndefined();
  });

  it('leaves resolved feed viewports static when intersection observation is unavailable', async () => {
    const fixture = buildFixture();
    const softwareResolved = visibleLines(fixture.softwareList);
    const infrastructureResolved = visibleLines(fixture.infrastructureList);
    mockMatchMedia(false);
    removeIntersectionObserver();

    await import('../scripts/proof');
    vi.advanceTimersByTime(60_000);

    expect(visibleLines(fixture.softwareList)).toEqual(softwareResolved);
    expect(visibleLines(fixture.infrastructureList)).toEqual(infrastructureResolved);
    expect(fixture.softwareList.dataset.feedState).toBe('resolved');
    expect(fixture.infrastructureList.dataset.feedState).toBe('resolved');
  });

  it('starts each stacked terminal independently and never restarts a completed feed', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software);
    vi.advanceTimersByTime(60_000);
    expect(fixture.softwareList.dataset.feedState).toBe('complete');
    expect(fixture.infrastructureList.dataset.feedState).toBe('ready');

    const settled = visibleLines(fixture.softwareList);
    observer.intersect(fixture.software);
    vi.advanceTimersByTime(5_000);
    expect(visibleLines(fixture.softwareList)).toEqual(settled);

    observer.intersect(fixture.infrastructure);
    vi.advanceTimersByTime(60_000);
    expect(fixture.infrastructureList.dataset.feedState).toBe('complete');
    expect(visibleLines(fixture.infrastructureList)).toEqual(
      fixture.infrastructureEvents.map((line) => line.text),
    );
  });

  it('keeps the complete resolved five-line event viewports under reduced motion', async () => {
    const fixture = buildFixture();
    const softwareResolved = visibleLines(fixture.softwareList);
    const infrastructureResolved = visibleLines(fixture.infrastructureList);
    mockMatchMedia(true);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    vi.advanceTimersByTime(60_000);

    expect(observer.observe).not.toHaveBeenCalled();
    expect(visibleLines(fixture.softwareList)).toEqual(softwareResolved);
    expect(visibleLines(fixture.infrastructureList)).toEqual(infrastructureResolved);
    expect(fixture.softwareList.dataset.feedState).toBe('resolved');
    expect(fixture.infrastructureList.dataset.feedState).toBe('resolved');
  });
});
