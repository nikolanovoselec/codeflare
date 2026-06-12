/**
 * Hero flare-word scramble: a vanilla DOM port of the web-ui ScrambleText
 * component (use-scramble-text.ts, fourPhase mode): a perpetual idle loop of
 * hold -> scramble -> decrypt -> swap that keeps the headline accent word
 * gently churning.
 *
 * Two adaptations for a marketing headline that must wrap on small screens:
 *   1. The phrase is split into per-word spans whose widths are measured once
 *      and locked, so glyph churn never reflows the headline (the line breaks
 *      stay exactly where the static text broke).
 *   2. Each word runs its own loop on a staggered start, so the words shimmer
 *      independently instead of pulsing in unison.
 *
 * Disabled entirely under prefers-reduced-motion: the static gradient text is
 * left untouched. Progressive enhancement: with no JS the server-rendered
 * phrase shows as-is.
 */

const SCRAMBLE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*<>{}[]|/\\~';
const TICK_MS = 50;

type Phase = 'hold' | 'scramble' | 'decrypt' | 'swap';

const randomChar = () => SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];

/** Run the perpetual four-phase loop on a single fixed-width word span. */
function animateWord(span: HTMLElement, target: string): void {
  const chars = target.split('');
  let phase: Phase = 'hold';
  // Negative start frame staggers each word's first scramble so they desync.
  let frame = -Math.floor(Math.random() * 50);
  let current = chars.slice();

  setInterval(() => {
    frame++;

    if (phase === 'hold') {
      if (frame > 60) {
        phase = 'scramble';
        frame = 0;
      }
      return;
    }

    if (phase === 'scramble') {
      current = chars.map((_, i) => (Math.random() < 0.4 ? randomChar() : chars[i]));
      if (frame > 26) {
        phase = 'decrypt';
        frame = 0;
      }
    } else if (phase === 'decrypt') {
      current = chars.map((_, i) => (Math.random() < frame / 22 ? chars[i] : randomChar()));
      if (frame > 22) {
        phase = 'swap';
        frame = 0;
        current = chars.slice();
      }
    } else if (phase === 'swap') {
      const a = Math.floor(Math.random() * current.length);
      const b = Math.floor(Math.random() * current.length);
      [current[a], current[b]] = [current[b], current[a]];
      if (frame > 12) {
        phase = 'hold';
        frame = 0;
        current = chars.slice();
      }
    }

    span.textContent = current.join('');
  }, TICK_MS);
}

/** Split one [data-scramble] element into width-locked word spans, then run. */
function setupElement(el: HTMLElement): void {
  const full = el.textContent ?? '';
  // Keep whitespace runs as their own tokens so word boundaries are preserved.
  const parts = full.split(/(\s+)/);
  el.textContent = '';

  const words: HTMLElement[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (/^\s+$/.test(part)) {
      el.appendChild(document.createTextNode(part));
    } else {
      const span = document.createElement('span');
      span.className = 'scramble-word';
      span.textContent = part;
      el.appendChild(span);
      words.push(span);
    }
  }

  // Lock each word's natural width, then start the loops. Fixed widths mean the
  // churning glyphs can never push the line to rewrap. Measure only after the
  // webfont has loaded, or the locked widths would be wrong once Inter swaps in.
  const lockAndRun = () => {
    for (const span of words) {
      span.style.width = `${span.getBoundingClientRect().width.toFixed(2)}px`;
    }
    for (const span of words) {
      animateWord(span, span.textContent ?? '');
    }
  };

  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    fonts.ready.then(() => requestAnimationFrame(lockAndRun));
  } else {
    requestAnimationFrame(lockAndRun);
  }
}

function initScramble(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-scramble]')) {
    setupElement(el);
  }
}

initScramble();
