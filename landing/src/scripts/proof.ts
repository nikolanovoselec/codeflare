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

if (reduced) {
  // Static markup is already the resolved artifact; no motion to arm.
} else if (!('IntersectionObserver' in window)) {
  for (const el of artifacts) el.classList.add('is-live');
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-live');
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '-80px 0px -80px 0px' }
  );
  for (const el of artifacts) io.observe(el);
}
