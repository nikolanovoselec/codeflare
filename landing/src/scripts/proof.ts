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
 * Reduced motion / no IntersectionObserver: `.is-live` is added immediately and
 * the global reduced-motion rules collapse every animation to its end state, so
 * the artifact simply appears in its resolved form with no motion.
 */
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const artifacts = Array.from(document.querySelectorAll<HTMLElement>('[data-proof]'));

if (reduced || !('IntersectionObserver' in window)) {
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
