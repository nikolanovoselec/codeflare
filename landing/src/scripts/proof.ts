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
 * Some lower artifacts additionally carry a [data-roll] list: once armed, the
 * top row slides out and re-enters at the bottom on a slow loop, so the artifact
 * reads as a live feed. The loop pauses when its artifact is off-screen or the
 * tab is hidden. Pinned chrome (titlebars, verdict, totals) never moves, so the
 * resolved claim stays on screen.
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

/** Track which rolling artifacts are currently on-screen, so ticks pause off-screen. */
const visible = new WeakSet<HTMLElement>();

/** One slow line-roll cycle on a [data-roll] list: the top child slides out and
 *  re-enters at the bottom, with the list height frozen so nothing jumps. */
function rollOnce(list: HTMLElement): void {
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

/** Begin the slow roll loop on an armed artifact's [data-roll] lists. */
function startRoll(el: HTMLElement): void {
  const lists = Array.from(el.querySelectorAll<HTMLElement>('[data-roll]')).filter(
    (list) => list.children.length >= 3
  );
  if (lists.length === 0) return;

  el.classList.add('is-rolling');

  const tick = () => {
    if (document.hidden || !visible.has(el)) return;
    for (const list of lists) rollOnce(list);
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
    el.classList.add('is-live');
    visible.add(el);
    startRoll(el);
  }
} else {
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
