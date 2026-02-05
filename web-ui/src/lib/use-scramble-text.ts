import { createSignal, createEffect, on, onCleanup, type Accessor } from 'solid-js';

const SCRAMBLE_CHARS = '█▓░/\\|─┤┘┐';
const CHARS_PER_FRAME = 1;

export function useScrambleText(
  text: Accessor<string>,
  enabled: Accessor<boolean> = () => true,
): Accessor<string> {
  const [display, setDisplay] = createSignal(text());
  let isFirst = true;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
