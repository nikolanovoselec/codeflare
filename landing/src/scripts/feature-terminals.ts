/**
 * Feature-terminal live prompt. Each feature terminal's bottom command line
 * types a short command, holds, deletes it, then moves to the next and loops,
 * so the row reads as live agent sessions instead of four cursors blinking in
 * lockstep (which looked fake). One terminal carries no loop and just blinks
 * (the single idle cursor). Each terminal's start is staggered so they are
 * never in phase with one another.
 *
 * Reduced motion: do nothing. The server-rendered prompt (each typing
 * terminal's first command; empty for the idle one) plus the CSS caret blink is
 * the resolved state, fully legible and calm. No JS, no change.
 */
const TYPE_MS = 58;
const DELETE_MS = 32;
const HOLD_MS = 1700;
const GAP_MS = 360;

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelectorAll<HTMLElement>('[data-ft-loop]').forEach((term, idx) => {
    const typed = term.querySelector<HTMLElement>('[data-ft-typed]');
    let loop: string[] = [];
    try {
      loop = JSON.parse(term.getAttribute('data-ft-loop') ?? '[]');
    } catch {
      loop = [];
    }
    if (!typed || loop.length === 0) return;

    let wi = 0;
    let ci = loop[0].length;
    let phase: 'hold' | 'delete' | 'type' = 'hold';
    typed.textContent = loop[0];

    const step = () => {
      const word = loop[wi];
      if (phase === 'hold') {
        phase = 'delete';
        window.setTimeout(step, HOLD_MS + idx * 120);
        return;
      }
      if (phase === 'delete') {
        ci -= 1;
        typed.textContent = word.slice(0, Math.max(0, ci));
        if (ci <= 0) {
          wi = (wi + 1) % loop.length;
          ci = 0;
          phase = 'type';
          window.setTimeout(step, GAP_MS);
        } else {
          window.setTimeout(step, DELETE_MS);
        }
        return;
      }
      // type
      ci += 1;
      typed.textContent = loop[wi].slice(0, ci);
      if (ci >= loop[wi].length) phase = 'hold';
      window.setTimeout(step, TYPE_MS);
    };

    // Stagger each terminal's start so they never type in sync.
    window.setTimeout(step, 1100 + idx * 520);
  });
}
