/**
 * Typed last line (styler 1, "cursor" mode). A proof terminal's last transcript
 * line is wrapped in a [data-typeline] span by Transcript.astro. This module
 * types that line in character by character the first time the terminal scrolls
 * into view, then leaves it on the full line with its blinking caret. It reads
 * as a live session finishing its last command instead of a frozen screenshot.
 *
 * The server-rendered markup is the full, resolved line, so no-JS and
 * reduced-motion visitors see the finished line with no typing. The clear +
 * type is armed ahead of the viewport (a generous bottom rootMargin) so the
 * line is emptied while still off-screen: it types in as it arrives, never
 * flashing the full text first. If the observer never fires the full line
 * simply stands, so nothing is ever stuck blank.
 *
 * Cadence matches feature-terminals.ts (TYPE_MS) so all typing on the page
 * shares one rhythm.
 */
const TYPE_MS = 58;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lines = Array.from(document.querySelectorAll<HTMLElement>('[data-typeline]'));

/** Type `el`'s text in from empty, one character per TYPE_MS, then stop. */
function typeIn(el: HTMLElement): void {
  const full = el.textContent ?? '';
  if (full.length === 0) return;
  el.textContent = '';
  let i = 0;
  const step = () => {
    i += 1;
    el.textContent = full.slice(0, i);
    if (i < full.length) window.setTimeout(step, TYPE_MS);
  };
  window.setTimeout(step, TYPE_MS);
}

if (reduced || lines.length === 0) {
  // Resolved markup already shows the full line; nothing to animate.
} else if (!('IntersectionObserver' in window)) {
  for (const el of lines) typeIn(el);
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          typeIn(entry.target as HTMLElement);
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px 240px 0px' }
  );
  for (const el of lines) observer.observe(el);
}
