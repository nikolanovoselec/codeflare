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
 * row to the bottom on a slow loop. Transcript feeds reuse that exact row motion
 * once per event, replacing the moved row through the established typing cadence
 * and settling after five events. Pinned terminal chrome never moves.
 *
 * Reduced motion: do nothing. The default (no `.is-live`) markup is already the
 * resolved state, so leaving it untouched is the correct motionless result.
 * Arming the sequence here would be wrong: the reduced-motion CSS collapses each
 * animation's duration but not its delay or `backwards` fill, so an armed row
 * would render invisible during its delay window and then snap in (a flash).
 *
 * No IntersectionObserver (old browser, not reduced): arm everything at once.
 */
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const artifacts = Array.from(document.querySelectorAll<HTMLElement>('[data-proof]'));

const ROLL_FIRST_MS = 3000;
const ROLL_EVERY_MS = 2600;
const PHASE_MS = 420;
const TYPE_MS = 58;
const FEED_HOLD_MS = 1700;

const FEED_TONES = new Set(['cmd', 'agent', 'ok', 'dim', 'warn', 'deny']);

interface FeedLine {
  tone: 'cmd' | 'agent' | 'ok' | 'dim' | 'warn' | 'deny';
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
    return value.filter((line): line is FeedLine => {
      if (!line || typeof line !== 'object') return false;
      const candidate = line as { tone?: unknown; text?: unknown };
      return typeof candidate.tone === 'string'
        && FEED_TONES.has(candidate.tone)
        && typeof candidate.text === 'string'
        && candidate.text.length > 0;
    });
  } catch {
    return [];
  }
}

function feedRow(line: FeedLine): HTMLElement {
  const row = document.createElement('span');
  row.className = `t-line t-${line.tone}`;
  row.textContent = line.text;
  return row;
}

/** Normal motion starts from five populated context rows. The server-rendered
 *  final five events remain untouched for no-JS and reduced-motion visitors. */
function prepareFeed(list: HTMLElement): void {
  const context = parseFeed(list, 'feedContext');
  const events = parseFeed(list, 'feedEvents');
  if (context.length !== 5 || events.length !== 5) return;
  list.replaceChildren(...context.map(feedRow));
  list.dataset.feedState = 'ready';
}

function typeFeedRow(row: HTMLElement, line: FeedLine, onComplete: () => void): void {
  for (const tone of FEED_TONES) row.classList.remove(`t-${tone}`);
  row.classList.add(`t-${line.tone}`);
  const text = document.createElement('span');
  const caret = document.createElement('span');
  caret.className = 't-caret';
  caret.setAttribute('aria-hidden', 'true');
  row.replaceChildren(text, caret);

  let offset = 0;
  const tick = () => {
    offset += 1;
    text.textContent = line.text.slice(0, offset);
    if (offset < line.text.length) {
      window.setTimeout(tick, TYPE_MS);
      return;
    }
    onComplete();
  };
  window.setTimeout(tick, TYPE_MS);
}

/** One bounded Transcript feed: every typed event reuses the shared rolling-row
 *  transition, pushing the oldest populated line out while keeping five rows. */
function startFeed(list: HTMLElement): void {
  if (list.dataset.feedStarted === 'true') return;
  const events = parseFeed(list, 'feedEvents');
  if (events.length !== 5 || list.children.length !== 5) return;
  list.dataset.feedStarted = 'true';
  list.dataset.feedState = 'running';
  let index = 0;

  const advance = () => {
    if (index >= events.length) {
      list.querySelector('.t-caret')?.remove();
      list.dataset.feedState = 'complete';
      return;
    }
    list.querySelector('.t-caret')?.remove();
    rollOnce(list, (row) => {
      typeFeedRow(row, events[index], () => {
        index += 1;
        if (index >= events.length) {
          list.querySelector('.t-caret')?.remove();
          list.dataset.feedState = 'complete';
          return;
        }
        window.setTimeout(advance, FEED_HOLD_MS);
      });
    });
  };

  window.setTimeout(advance, ROLL_FIRST_MS);
}

/** Begin the shared slow roll loop or bounded Transcript feed on an artifact. */
function startRoll(el: HTMLElement): void {
  const lists = Array.from(el.querySelectorAll<HTMLElement>('[data-roll]')).filter(
    (list) => list.children.length >= 3
  );
  if (lists.length === 0) return;

  el.classList.add('is-rolling');
  const feeds = lists.filter((list) => list.hasAttribute('data-feed-events'));
  for (const feed of feeds) startFeed(feed);
  const loops = lists.filter((list) => !list.hasAttribute('data-feed-events'));
  if (loops.length === 0) return;

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

if (reduced) {
  // Static markup is already the resolved artifact; no motion to arm.
} else if (!('IntersectionObserver' in window)) {
  for (const el of artifacts) {
    for (const feed of el.querySelectorAll<HTMLElement>('[data-feed-events]')) prepareFeed(feed);
  }
  for (const el of artifacts) {
    el.classList.add('is-live');
    visible.add(el);
    startRoll(el);
  }
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

  // Tracks on-screen state so the roll loop pauses when the artifact leaves view.
  const visibleObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
      else visible.delete(entry.target as HTMLElement);
    }
  });

  for (const el of artifacts) {
    armObserver.observe(el);
    if (el.querySelector('[data-roll]')) visibleObserver.observe(el);
  }
}
