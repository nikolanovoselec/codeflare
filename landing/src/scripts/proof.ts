/**
 * Proof-artifact activator. The body of the page carries "proof artifacts"
 * (the self-healing enforcement gate, the parallel review board, the boundary
 * data-path, the cost ledger) that tell their story through a short, one-shot
 * CSS sequence. Markup renders the FINAL, resolved state by default, so the
 * artifact is fully legible with no JavaScript at all.
 *
 * This module adds `.is-live` to each `[data-proof]` element the first time it
 * scrolls into view, which is the only thing that arms the CSS keyframes. The
 * sequence plays once, then the element is unobserved.
 *
 * Some artifacts carry a [data-roll] list. Ordinary proof lists move the top
 * row to the bottom on a slow loop. Transcript simulations first reveal eight
 * complete rows in authored order, then append typed events into a clipped,
 * fixed-height log using the established cadence. Pinned terminal chrome never moves.
 *
 * Reduced motion: do nothing. The default (no `.is-live`) markup is already the
 * resolved state, so leaving it untouched is the correct motionless result.
 * Arming the sequence here would be wrong: the reduced-motion CSS collapses each
 * animation's duration but not its delay or `backwards` fill, so an armed row
 * would render invisible during its delay window and then snap in (a flash).
 *
 * No IntersectionObserver (old browser, not reduced): arm ordinary proofs at
 * once and leave bounded Transcript feeds in their resolved static state.
 */
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const artifacts = Array.from(document.querySelectorAll<HTMLElement>('[data-proof]'));

const ROLL_FIRST_MS = 3000;
const ROLL_EVERY_MS = 2600;
const PHASE_MS = 420;
const TYPE_MS = 58;
const FEED_HOLD_MS = 1700;

const FEED_TONES = new Set(['cmd', 'agent', 'info', 'ok', 'dim', 'warn', 'deny']);

interface FeedLine {
  tone: 'cmd' | 'agent' | 'info' | 'ok' | 'dim' | 'warn' | 'deny';
  text: string;
}

/** Track which rolling artifacts are currently on-screen, so ticks pause off-screen. */
const visible = new WeakSet<HTMLElement>();

/** One slow line-roll cycle on a [data-roll] list: the top child slides out and
 *  re-enters at the bottom, with the list height frozen so nothing jumps. */
function rollOnce(list: HTMLElement, onReordered?: (row: HTMLElement) => void): void {
  const children = Array.from(list.children) as HTMLElement[];
  if (children.length < 3) return;
  // Re-entrancy guard: one cycle spans two PHASE_MS timeouts, so skip a tick
  // that lands mid-cycle (e.g. a burst of throttled timers after a background
  // tab foregrounds) rather than freezing then unfreezing the height twice.
  if (list.dataset.rolling === '1') return;
  list.dataset.rolling = '1';

  const first = children[0];
  const startHeight = list.getBoundingClientRect().height;
  // Freeze the list height so removing the top row does not collapse the box.
  list.style.height = `${startHeight}px`;

  first.classList.add('roll-anim', 'roll-up');
  window.setTimeout(() => {
    // Move the faded-out top row to the bottom, primed to roll back down.
    list.appendChild(first);
    first.classList.remove('roll-up');
    first.classList.add('roll-down');
    onReordered?.(first);
    // Force a reflow so the roll-down transition runs from its start state.
    void first.getBoundingClientRect();
    first.classList.remove('roll-down');
    // Measure the replacement at its natural wrapped height, not through the
    // stale inline constraint captured before the top row moved. Both style
    // writes occur in one task, so only the correctly reserved height paints.
    list.style.height = '';
    const endHeight = list.getBoundingClientRect().height;
    list.style.height = `${endHeight}px`;
    window.setTimeout(() => {
      first.classList.remove('roll-anim');
      list.style.height = '';
      delete list.dataset.rolling;
    }, PHASE_MS);
  }, PHASE_MS);
}

/** Parse a Transcript feed data attribute. DOM attributes are an external
 *  boundary even though Astro authored them, so malformed lines fail closed. */
function parseFeed(list: HTMLElement, key: 'feedContext' | 'feedEvents'): FeedLine[] {
  try {
    const value: unknown = JSON.parse(list.dataset[key] ?? '[]');
    if (!Array.isArray(value)) return [];
    const valid = value.every((line) => {
      if (!line || typeof line !== 'object') return false;
      const candidate = line as { tone?: unknown; text?: unknown };
      return typeof candidate.tone === 'string'
        && FEED_TONES.has(candidate.tone)
        && typeof candidate.text === 'string'
        && candidate.text.length > 0;
    });
    return valid ? value as FeedLine[] : [];
  } catch {
    return [];
  }
}

function feedRow(line: FeedLine, index: number): HTMLElement {
  const row = document.createElement('span');
  row.className = `t-line t-${line.tone}`;
  row.style.setProperty('--i', String(index));
  row.textContent = line.text;
  return row;
}

/** Normal motion starts from eight populated context rows. The server-rendered
 *  final event viewport remains untouched for no-JS and reduced-motion visitors. */
function prepareFeed(list: HTMLElement): void {
  const context = parseFeed(list, 'feedContext');
  const events = parseFeed(list, 'feedEvents');
  if (context.length !== 8 || events.length < context.length) return;
  list.replaceChildren(...context.map(feedRow));
  list.closest<HTMLElement>('.terminal-body')?.classList.add('is-feed-prepared');
  list.dataset.feedState = 'ready';
}

function scrollFeedToEnd(list: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  const top = Math.max(0, list.scrollHeight - list.clientHeight);
  if (typeof list.scrollTo === 'function') {
    list.scrollTo({ top, behavior });
    return;
  }
  list.scrollTop = top;
}

function typeFeedRow(
  row: HTMLElement,
  line: FeedLine,
  onComplete: () => void,
  startDelay = TYPE_MS,
): void {
  for (const tone of FEED_TONES) row.classList.remove(`t-${tone}`);
  row.classList.remove('t-feed-command');
  row.classList.add(line.tone === 'cmd' ? 't-feed-command' : `t-${line.tone}`, 'is-feed-typing');

  // Keep the completed line in flow but invisible while the live copy types over
  // it. On narrow screens this reserves the final wrapped height from character
  // one, so neither the terminal nor the surrounding page grows mid-line.
  const reserve = document.createElement('span');
  reserve.dataset.feedReserve = '';
  reserve.setAttribute('aria-hidden', 'true');
  const reserveText = document.createElement('span');
  reserveText.dataset.feedText = '';
  reserveText.textContent = line.text;
  const live = document.createElement('span');
  live.dataset.feedLive = '';
  const text = document.createElement('span');
  text.dataset.feedText = '';
  const caret = document.createElement('span');
  caret.className = 't-caret';
  caret.setAttribute('aria-hidden', 'true');
  if (line.tone === 'cmd') {
    for (const layer of [reserve, live]) {
      const prompt = document.createElement('span');
      prompt.className = 't-feed-prompt';
      prompt.setAttribute('aria-hidden', 'true');
      prompt.textContent = '❯ ';
      layer.appendChild(prompt);
    }
  }
  reserve.appendChild(reserveText);
  live.append(text, caret);
  row.replaceChildren(reserve, live);

  let offset = 0;
  const tick = () => {
    offset += 1;
    text.textContent = line.text.slice(0, offset);
    if (row.parentElement) scrollFeedToEnd(row.parentElement);
    if (offset < line.text.length) {
      window.setTimeout(tick, TYPE_MS);
      return;
    }
    row.classList.remove('is-feed-typing', 't-feed-command');
    row.classList.add(`t-${line.tone}`);
    row.textContent = line.text;
    onComplete();
  };
  window.setTimeout(tick, startDelay);
}

function settleFeed(list: HTMLElement): void {
  list.querySelector('.t-caret')?.remove();
  const caret = document.createElement('span');
  caret.className = 't-caret';
  caret.setAttribute('aria-hidden', 'true');
  list.lastElementChild?.appendChild(caret);
  list.dataset.feedState = 'complete';
}

/** One bounded Transcript feed: each typed event is appended to a fixed-height,
 *  clipped terminal log. Native scrolling keeps the newest work in view without
 *  deleting history, stretching row gaps, or changing the outer frame. */
function startFeed(list: HTMLElement): void {
  if (list.dataset.feedStarted === 'true' || list.dataset.feedState !== 'ready') return;
  const context = parseFeed(list, 'feedContext');
  const events = parseFeed(list, 'feedEvents');
  if (context.length !== 8 || events.length < context.length || list.children.length !== 8) return;
  list.dataset.feedStarted = 'true';
  list.dataset.feedState = 'running';
  let index = 0;

  const advance = () => {
    if (index >= events.length) {
      settleFeed(list);
      return;
    }
    list.closest<HTMLElement>('[data-proof]')?.classList.add('is-rolling');
    list.querySelector('.t-caret')?.remove();
    const row = feedRow(events[index], list.children.length);
    list.appendChild(row);
    typeFeedRow(row, events[index], () => {
      index += 1;
      if (index >= events.length) {
        settleFeed(list);
        return;
      }
      window.setTimeout(advance, FEED_HOLD_MS);
    }, PHASE_MS + TYPE_MS);
    scrollFeedToEnd(list, 'smooth');
  };

  window.setTimeout(advance, ROLL_FIRST_MS);
}

/** Start bounded Transcript feeds only after their terminal actually intersects. */
function startFeeds(el: HTMLElement): void {
  const feeds = Array.from(el.querySelectorAll<HTMLElement>('[data-feed-events]'));
  if (feeds.length === 0) return;
  for (const feed of feeds) startFeed(feed);
}

/** Begin the shared slow loop for ordinary proof-row lists on an armed artifact. */
function startRoll(el: HTMLElement): void {
  const loops = Array.from(el.querySelectorAll<HTMLElement>('[data-roll]')).filter(
    (list) => list.children.length >= 3 && !list.hasAttribute('data-feed-events')
  );
  if (loops.length === 0) return;

  el.classList.add('is-rolling');

  const tick = () => {
    if (document.hidden || !visible.has(el)) return;
    for (const list of loops) rollOnce(list);
  };

  window.setTimeout(() => {
    tick();
    window.setInterval(tick, ROLL_EVERY_MS);
  }, ROLL_FIRST_MS);
}

/** Test seam: the re-entrancy guard fires only when a tick lands inside an
 *  in-flight cycle, which the production interval never does, so the guard can
 *  only be exercised by calling rollOnce directly. Not used at runtime. */
export const __rollTest = { rollOnce };

/** Preserve resolved Transcript feeds while retaining the established immediate
 *  fallback for ordinary proof artifacts in browsers without observation. */
function startWithoutIntersectionObserver(): void {
  for (const el of artifacts) {
    if (el.querySelector('[data-feed-events]')) continue;
    el.classList.add('is-live');
    visible.add(el);
    startRoll(el);
  }
}

if (reduced) {
  // Static markup is already the resolved artifact; no motion to arm.
} else if (!('IntersectionObserver' in window)) {
  startWithoutIntersectionObserver();
} else {
  for (const el of artifacts) {
    for (const feed of el.querySelectorAll<HTMLElement>('[data-feed-events]')) prepareFeed(feed);
  }

  // Arms the one-shot reveal just BEFORE an artifact scrolls in (positive bottom
  // rootMargin), not after. The row keyframes are backwards-filled: adding
  // .is-live snaps the resolved rows to their hidden 'from' state, then animates
  // them in. If that snap lands while the artifact is already on screen it reads
  // as a flash, so arming ~100px ahead keeps the hidden start off-screen and the
  // rows animate in as the artifact arrives.
  const armObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-live');
          startRoll(entry.target as HTMLElement);
          armObserver.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px 100px 0px' }
  );

  // Unlike the generic proof reveal, a Transcript feed must retain its complete
  // initial viewport until the terminal itself enters the viewport.
  const feedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        startFeeds(entry.target as HTMLElement);
        feedObserver.unobserve(entry.target);
      }
    },
    { threshold: 0.01 }
  );

  // Tracks on-screen state so the ordinary roll loop pauses when its artifact leaves view.
  const visibleObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
      else visible.delete(entry.target as HTMLElement);
    }
  });

  for (const el of artifacts) {
    armObserver.observe(el);
    if (el.querySelector('[data-feed-events]')) feedObserver.observe(el);
    if (el.querySelector('[data-roll]:not([data-feed-events])')) visibleObserver.observe(el);
  }
}
