/**
 * Feature-terminal live prompt. Each feature terminal's bottom command line
 * types a short command, holds, deletes it, then moves to the next and loops,
 * so the row reads as live agent sessions instead of four cursors blinking in
 * lockstep (which looked fake). All four terminals type; each terminal's start
 * is staggered so they are never in phase with one another.
 *
 * Reduced motion: do nothing. The server-rendered prompt (each terminal's
 * first command) plus the CSS caret blink is the resolved state, fully legible
 * and calm. No JS, no change.
 */
const TYPE_MS = 58;
const DELETE_MS = 32;
const HOLD_MS = 1700;
const GAP_MS = 360;

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelectorAll<HTMLElement>('[data-ft-loop]').forEach((term, idx) => {
    const typed = term.querySelector<HTMLElement>('[data-ft-typed]');
    // Play-once mode (the hero): type through the sequence and rest on the final
    // beat instead of deleting and cycling. The feature terminals omit this and
    // keep looping.
    const once = term.hasAttribute('data-ft-once');
    // Shuffle mode (the hero): randomise the beat order on each load so the reel
    // reads differently every visit. Opt-in via data-ft-shuffle; the feature tiles
    // omit it and keep their authored order.
    const shuffle = term.hasAttribute('data-ft-shuffle');
    let loop: string[] = [];
    try {
      loop = JSON.parse(term.getAttribute('data-ft-loop') ?? '[]');
    } catch {
      loop = [];
    }
    if (!typed || loop.length === 0) return;

    if (shuffle && loop.length > 1) {
      // Fisher-Yates over a copy so the original attribute order is untouched.
      loop = loop.slice();
      for (let i = loop.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [loop[i], loop[j]] = [loop[j], loop[i]];
      }
      // Reflect the shuffled head as the resting/initial beat so the first paint
      // matches what types next.
      typed.textContent = loop[0];
    }

    let wi = 0;
    let ci = loop[0].length;
    let phase: 'hold' | 'delete' | 'type' = 'hold';
    typed.textContent = loop[0];

    const step = () => {
      const word = loop[wi];
      if (phase === 'hold') {
        // Play-once: the final beat is the resting state; do not delete or cycle.
        if (once && wi === loop.length - 1) return;
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
