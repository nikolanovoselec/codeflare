import { createSignal, createEffect, on, onCleanup, type Accessor } from 'solid-js';

const SCRAMBLE_CHARS = '█▓░/\\|─┤┘┐';
const CHARS_PER_FRAME = 1;

const FOUR_PHASE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>{}[]|/\\~';
const FOUR_PHASE_TICK_MS = 50;

type FourPhase = 'hold' | 'scramble' | 'decrypt' | 'swap';

export function useScrambleText(
  text: Accessor<string>,
  enabled: Accessor<boolean> = () => true,
  opts?: { animateOnMount?: boolean; fourPhase?: boolean },
): Accessor<string> {
  const [display, setDisplay] = createSignal(opts?.animateOnMount ? '' : text());
  let isFirst = !opts?.animateOnMount;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Opt-in 4-phase animation: a perpetual hold→scramble→decrypt→swap loop that
  // preserves the original ScrambleText component's continuous idle effect.
  if (opts?.fourPhase) {
    const randomChar = () =>
      FOUR_PHASE_CHARS[Math.floor(Math.random() * FOUR_PHASE_CHARS.length)];

    createEffect(
      on(text, (next) => {
        setDisplay(next);

        if (!enabled() || prefersReducedMotion) {
          return;
        }

        let phase: FourPhase = 'hold';
        let frame = 0;
        let current = next.split('');

        const timer = setInterval(() => {
          frame++;

          if (phase === 'hold') {
            if (frame > 60) { phase = 'scramble'; frame = 0; }
            return;
          }

          if (phase === 'scramble') {
            current = current.map((_, i) =>
              Math.random() < 0.4 ? randomChar() : next[i]
            );
            if (frame > 30) { phase = 'decrypt'; frame = 0; }
          }

          else if (phase === 'decrypt') {
            current = current.map((_, i) =>
              Math.random() < frame / 25 ? next[i] : randomChar()
            );
            if (frame > 25) { phase = 'swap'; frame = 0; current = next.split(''); }
          }

          else if (phase === 'swap') {
            const a = Math.floor(Math.random() * current.length);
            const b = Math.floor(Math.random() * current.length);
            [current[a], current[b]] = [current[b], current[a]];
            if (frame > 15) { phase = 'hold'; frame = 0; current = next.split(''); }
          }

          setDisplay(current.join(''));
        }, FOUR_PHASE_TICK_MS);

        onCleanup(() => clearInterval(timer));
      }),
    );

    return display;
  }

  createEffect(
    on(text, (next) => {
      // Skip animation on first mount, when disabled, or reduced motion
      if (isFirst) {
        isFirst = false;
        setDisplay(next);
        return;
      }

      if (!enabled() || prefersReducedMotion) {
        setDisplay(next);
        return;
      }

      let resolved = 0;
      let rafId: number;
      let frameCount = 0;
      const FRAMES_PER_CHAR = 3;

      const step = () => {
        frameCount++;
        if (frameCount % FRAMES_PER_CHAR === 0) {
          resolved = Math.min(resolved + CHARS_PER_FRAME, next.length);
        }

        const out = next
          .split('')
          .map((ch, i) => {
            if (i < resolved) return ch;
            if (ch === ' ') return ' ';
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join('');

        setDisplay(out);

        if (resolved < next.length) {
          rafId = requestAnimationFrame(step);
        }
      };

      rafId = requestAnimationFrame(step);

      onCleanup(() => {
        if (rafId) cancelAnimationFrame(rafId);
      });
    }),
  );

  return display;
}
