// @vitest-environment happy-dom
/**
 * Behavioral integration coverage for REQ-LANDING-011 motion and
 * REQ-LANDING-012 accessibility. Execution composes the shared Transcript feed
 * with proof.ts: populated opening rows reveal top-down while complete context
 * stays retained, then events append into a fixed scrolling log that settles
 * with its full history and blinking cursor.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXECUTION } from '../content/site';

const globalCss = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
const ROLL_FIRST_MS = 3_000;
const PHASE_MS = 420;
const TYPE_MS = 58;
const FEED_HOLD_MS = 1_700;
const VIEWPORT_ROWS = 8;

interface FeedLine {
  tone: 'cmd' | 'agent' | 'info' | 'ok' | 'dim' | 'warn' | 'deny';
  text: string;
  href?: string;
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
  const run = EXECUTION[name];
  const context: FeedLine[] = run.context.map((line) => ({ ...line }));
  const events: FeedLine[] = run.events.map((line) => ({ ...line }));
  const face = document.createElement('section');
  face.className = 'terminal';
  face.dataset.proof = '';
  face.dataset.executionFace = name;
  const list = document.createElement('div');
  list.dataset.roll = '';
  list.dataset.feedContext = JSON.stringify(context);
  list.dataset.feedEvents = JSON.stringify(events);
  list.dataset.feedState = 'resolved';
  for (const line of events.slice(-VIEWPORT_ROWS)) {
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
    (line) => line.querySelector<HTMLElement>('[data-feed-live] [data-feed-text]')?.textContent
      ?? line.textContent
      ?? '',
  );
}

function installGlobalStyles(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = globalCss;
  document.head.appendChild(style);
  return style;
}

function delaySeconds(value: string): number {
  const duration = value.match(/^(\d+(?:\.\d+)?|\.\d+)(m?s)$/);
  if (duration) return Number(duration[1]) / (duration[2] === 'ms' ? 1_000 : 1);

  const calculated = value.match(
    /^calc\(\s*(\d+(?:\.\d+)?|\.\d+)\s*\*\s*(\d+(?:\.\d+)?|\.\d+)s\s*\)$/,
  );
  if (calculated) return Number(calculated[1]) * Number(calculated[2]);

  return Number.NaN;
}

function advanceThroughEvents(list: HTMLElement, events: FeedLine[]): void {
  events.forEach((event, index) => {
    const waitBeforeRoll = index === 0 ? ROLL_FIRST_MS : FEED_HOLD_MS;
    vi.advanceTimersByTime(waitBeforeRoll + PHASE_MS + TYPE_MS * event.text.length);
    expect(visibleLines(list).at(-1)).toBe(event.text);
  });
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
  it('prepares populated opening rows and retains complete context histories', async () => {
    const fixture = buildFixture();
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    const style = installGlobalStyles();
    await import('../scripts/proof');

    expect(observer.observe).toHaveBeenCalledWith(fixture.software);
    expect(observer.observe).toHaveBeenCalledWith(fixture.infrastructure);
    expect(visibleLines(fixture.softwareList)).toEqual(fixture.softwareContext.map((line) => line.text));
    expect(visibleLines(fixture.infrastructureList)).toEqual(
      fixture.infrastructureContext.map((line) => line.text),
    );
    expect(fixture.softwareList.children).toHaveLength(fixture.softwareContext.length);
    expect(fixture.infrastructureList.children).toHaveLength(fixture.infrastructureContext.length);
    expect(
      Array.from(fixture.softwareList.children).map((row) =>
        (row as HTMLElement).style.getPropertyValue('--i'),
      ),
    ).toEqual(Array.from({ length: fixture.softwareContext.length }, (_, index) => String(index)));

    observer.intersect(fixture.software, 'prearm');
    expect(fixture.software.classList.contains('is-live')).toBe(true);
    expect(fixture.softwareList.dataset.feedState).toBe('ready');

    const entranceStyles = Array.from(fixture.softwareList.children, (row) =>
      getComputedStyle(row),
    );
    for (const entranceStyle of entranceStyles) {
      const animationTokens = entranceStyle.animation.trim().split(/\s+/);
      expect(animationTokens).toContain('term-type');
      const duration = animationTokens.map(delaySeconds).find(Number.isFinite)
        ?? Number.NaN;
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThan(0);
    }
    const delays = entranceStyles.map((entranceStyle) =>
      delaySeconds(entranceStyle.animationDelay),
    );
    expect(delays.every(Number.isFinite)).toBe(true);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index - 1]).toBeLessThan(delays[index]);
    }
    style.remove();
  });

  it('types the simulation to completion in a fixed scrolling log with final cursor', async () => {
    const fixture = buildFixture();
    const scrollTo = vi.fn();
    fixture.softwareList.scrollTo = scrollTo;
    Object.defineProperties(fixture.softwareList, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 200 },
    });
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    const style = installGlobalStyles();
    await import('../scripts/proof');
    observer.intersect(fixture.software, 'prearm');
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS + TYPE_MS * 2);
    expect(fixture.softwareList.dataset.feedState).toBe('ready');
    expect(visibleLines(fixture.softwareList)).toEqual(fixture.softwareContext.map((line) => line.text));

    observer.intersect(fixture.software, 'feed');
    expect(fixture.software.classList.contains('is-rolling')).toBe(false);
    vi.advanceTimersByTime(ROLL_FIRST_MS - 1);
    expect(fixture.software.classList.contains('is-rolling')).toBe(false);
    vi.advanceTimersByTime(1 + PHASE_MS + TYPE_MS - 1);
    expect(fixture.software.classList.contains('is-rolling')).toBe(true);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe('');
    vi.advanceTimersByTime(1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text.slice(0, 1));
    const typingRow = fixture.softwareList.lastElementChild as HTMLElement;
    const reserve = typingRow.querySelector<HTMLElement>('[data-feed-reserve]')!;
    const live = typingRow.querySelector<HTMLElement>('[data-feed-live]')!;
    expect(typingRow.classList.contains('t-cmd')).toBe(false);
    expect(typingRow.classList.contains('t-feed-command')).toBe(true);
    for (const layer of [reserve, live]) {
      const prompt = layer.querySelector<HTMLElement>('.t-feed-prompt')!;
      expect(prompt.textContent).toBe('❯ ');
      expect(prompt.getAttribute('aria-hidden')).toBe('true');
      expect(layer.firstElementChild).toBe(prompt);
      expect(prompt.nextElementSibling?.hasAttribute('data-feed-text')).toBe(true);
    }
    vi.advanceTimersByTime(TYPE_MS - 1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text.slice(0, 1));
    vi.advanceTimersByTime(1);
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text.slice(0, 2));
    expect(visibleLines(fixture.softwareList)[0]).toBe(fixture.softwareContext[0].text);
    expect(fixture.softwareList.children).toHaveLength(VIEWPORT_ROWS + 1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' });
    expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'auto' });
    expect(visibleLines(fixture.infrastructureList)).toEqual(
      fixture.infrastructureContext.map((line) => line.text),
    );

    vi.advanceTimersByTime(180_000);
    expect(visibleLines(fixture.softwareList)).toEqual(
      [...fixture.softwareContext, ...fixture.softwareEvents].map((line) => line.text),
    );
    expect(fixture.softwareList.dataset.feedState).toBe('complete');
    const finalCaret = fixture.softwareList.lastElementChild?.querySelector<HTMLElement>('.t-caret');
    expect(finalCaret).not.toBeNull();
    expect(fixture.softwareList.children).toHaveLength(
      fixture.softwareContext.length + fixture.softwareEvents.length,
    );
    const prLink = fixture.softwareList.querySelector<HTMLAnchorElement>('.terminal-inline-link');
    expect(prLink?.textContent).toBe(
      'https://github.com/nikolanovoselec/codeflare-inference-mesh/pull/1',
    );
    expect(prLink?.href).toBe(
      'https://github.com/nikolanovoselec/codeflare-inference-mesh/pull/1',
    );
    expect(prLink?.target).toBe('_blank');
    expect(prLink?.rel).toContain('noopener');

    expect(getComputedStyle(finalCaret!).animation).toContain('caret');
    expect(getComputedStyle(finalCaret!).animation).toContain('infinite');

    Object.defineProperty(fixture.softwareList, 'scrollHeight', {
      configurable: true,
      value: 500,
    });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: 'auto' });
    style.remove();
  });

  it.each(['missing', 'throwing'] as const)(
    'finishes typing with a %s scrollTo implementation',
    async (scrollToMode) => {
      const fixture = buildFixture();
      Object.defineProperties(fixture.softwareList, {
        scrollHeight: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 200 },
        scrollTo: {
          configurable: true,
          value: scrollToMode === 'throwing'
            ? vi.fn(() => { throw new TypeError('unsupported scroll options'); })
            : undefined,
        },
      });
      mockMatchMedia(false);
      const observer = installIntersectionObserver();

      await import('../scripts/proof');
      observer.intersect(fixture.software, 'feed');
      vi.advanceTimersByTime(120_000);

      expect(fixture.softwareList.dataset.feedState).toBe('complete');
      expect(fixture.softwareList.scrollTop).toBe(200);
      expect(fixture.softwareList.children).toHaveLength(
        fixture.softwareContext.length + fixture.softwareEvents.length,
      );
    },
  );

  it('keeps wrapped row geometry reserved inside the fixed scrolling viewport', async () => {
    const fixture = buildFixture();
    fixture.softwareEvents[0].text = 'software-event-that-wraps-across-several-narrow-viewport-lines';
    fixture.softwareList.dataset.feedEvents = JSON.stringify(fixture.softwareEvents);
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software, 'feed');
    vi.advanceTimersByTime(ROLL_FIRST_MS + PHASE_MS + TYPE_MS);

    const typingRow = fixture.softwareList.lastElementChild as HTMLElement;
    expect(typingRow.querySelector('[data-feed-reserve] [data-feed-text]')?.textContent).toBe(
      fixture.softwareEvents[0].text,
    );
    expect(typingRow.querySelector('[data-feed-live] [data-feed-text]')?.textContent).toBe(
      fixture.softwareEvents[0].text.slice(0, 1),
    );
    expect(typingRow.classList.contains('is-feed-typing')).toBe(true);
    expect(fixture.softwareList.style.height).toBe('');
    expect(fixture.softwareList.children).toHaveLength(VIEWPORT_ROWS + 1);

    vi.advanceTimersByTime(TYPE_MS * (fixture.softwareEvents[0].text.length - 1));
    expect(visibleLines(fixture.softwareList).at(-1)).toBe(fixture.softwareEvents[0].text);
    expect(fixture.softwareList.lastElementChild?.querySelector('[data-feed-reserve]')).toBeNull();
    expect(fixture.softwareList.lastElementChild?.classList.contains('t-feed-command')).toBe(false);
    expect(fixture.softwareList.lastElementChild?.classList.contains('t-cmd')).toBe(true);
    expect(fixture.softwareList.style.height).toBe('');
  });

  it('rejects a feed link outside the owned GitHub organization', async () => {
    const fixture = buildFixture();
    const softwareResolved = visibleLines(fixture.softwareList);
    fixture.softwareEvents[3] = {
      ...fixture.softwareEvents[3],
      text: 'PR opened\nhttps://github.com/attacker/repository/pull/1',
      href: 'https://github.com/attacker/repository/pull/1',
    };
    fixture.softwareList.dataset.feedEvents = JSON.stringify(fixture.softwareEvents);
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software, 'feed');
    vi.advanceTimersByTime(60_000);

    expect(visibleLines(fixture.softwareList)).toEqual(softwareResolved);
    expect(fixture.softwareList.dataset.feedState).toBe('resolved');
    expect(fixture.softwareList.querySelector('.terminal-inline-link')).toBeNull();
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

  it('completes both authored simulations independently and never restarts them', async () => {
    const fixture = buildFixture();
    expect(fixture.softwareEvents).toHaveLength(12);
    expect(fixture.infrastructureEvents).toHaveLength(8);
    mockMatchMedia(false);
    const observer = installIntersectionObserver();

    await import('../scripts/proof');
    observer.intersect(fixture.software);
    advanceThroughEvents(fixture.softwareList, fixture.softwareEvents);
    expect(fixture.softwareList.dataset.feedState).toBe('complete');
    expect(visibleLines(fixture.softwareList)).toEqual(
      [...fixture.softwareContext, ...fixture.softwareEvents].map((line) => line.text),
    );
    expect(fixture.softwareList.lastElementChild?.querySelector('.t-caret')).not.toBeNull();
    expect(fixture.infrastructureList.dataset.feedState).toBe('ready');

    const settled = visibleLines(fixture.softwareList);
    observer.intersect(fixture.software);
    vi.advanceTimersByTime(5_000);
    expect(visibleLines(fixture.softwareList)).toEqual(settled);

    observer.intersect(fixture.infrastructure);
    advanceThroughEvents(fixture.infrastructureList, fixture.infrastructureEvents);
    expect(fixture.infrastructureList.dataset.feedState).toBe('complete');
    expect(visibleLines(fixture.infrastructureList)).toEqual(
      [...fixture.infrastructureContext, ...fixture.infrastructureEvents].map((line) => line.text),
    );
    expect(fixture.infrastructureList.lastElementChild?.querySelector('.t-caret')).not.toBeNull();
  });

  it('keeps the complete resolved event viewports under reduced motion', async () => {
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
