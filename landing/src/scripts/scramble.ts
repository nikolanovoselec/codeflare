/**
 * Hero flare-word scramble: a vanilla DOM port of the web-ui ScrambleText
 * component (use-scramble-text.ts, fourPhase mode): a perpetual idle loop of
 * hold -> scramble -> decrypt -> swap that keeps the headline accent word
 * gently churning.
 *
 * Two adaptations for a marketing headline that must wrap on small screens:
 *   1. Each churning word is locked to its resting width after the webfont loads,
 *      so a wider churn glyph can never grow the word's advance and re-wrap the
 *      phrase -- the per-frame reflow that shoved the whole page on narrow screens.
 *      A glyph wider than the resting box clips a sliver at the centered edges (a
 *      far smaller artifact than the page flicker); 1-2 character words are left
 *      static so a tiny locked box never clips a full glyph. The phrase still wraps
 *      naturally at rest inside the headline's max-width.
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

/** Run the perpetual four-phase loop on a single content-sized word span. */
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

/** Split one [data-scramble] element into content-sized word spans, then run. */
function setupElement(el: HTMLElement): void {
  const full = el.textContent ?? '';
  // Keep whitespace runs as their own tokens so word boundaries are preserved.
  const parts = full.split(/(\s+)/);
  el.textContent = '';

  const words: { span: HTMLElement; text: string }[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (/^\s+$/.test(part)) {
      el.appendChild(document.createTextNode(part));
    } else {
      const span = document.createElement('span');
      span.className = 'scramble-word';
      span.textContent = part;
      el.appendChild(span);
      words.push({ span, text: part });
    }
  }

  // Lock each churning word to its resting width so glyph churn can never change the
  // word's advance and re-wrap the phrase (the per-frame reflow that flickered the
  // whole page on narrow screens). Measured after the webfont has loaded so the lock
  // matches real Inter metrics, not the fallback font. 1-2 char words stay static: a
  // tiny locked box would clip a full wide glyph, and a static short word never grows.
  const start = () => {
    for (const { span, text } of words) {
      if (text.length < 3) continue;
      const width = span.getBoundingClientRect().width;
      if (width > 0) {
        span.style.display = 'inline-block';
        span.style.textAlign = 'center';
        span.style.width = `${width}px`;
      }
      animateWord(span, text);
    }
  };

  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    fonts.ready.then(() => requestAnimationFrame(start));
  } else {
    requestAnimationFrame(start);
  }
}

function initScramble(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Word-width locking (setupElement) freezes the churn's wrap points, so the headline
  // no longer reflows mid-churn. Below the layout's split breakpoint the accent still
  // stays fully static: a churning headline is louder than the calm the small-screen
  // layout wants, and the server-rendered gradient reads cleanly on its own.
  if (!window.matchMedia('(min-width: 820px)').matches) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-scramble]')) {
    setupElement(el);
  }
}

initScramble();

/**
 * Hover / focus decode: [data-scramble-hover] elements (the header "Enter The
 * Matrix" sign-in CTA) rest static and run a single scramble -> decode pass when
 * hovered or focused. The button paints solid coral (not the flare gradient), so
 * content-sized word spans never clip. Disabled under reduced motion; with no JS
 * the label is plain, legible text.
 */
const HOVER_FRAMES = 26;

function decodeWord(span: HTMLElement, target: string): void {
  const chars = target.split('');
  let frame = 0;
  const timer = setInterval(() => {
    frame++;
    const settled = frame < 8 ? 0 : (frame - 8) / (HOVER_FRAMES - 8);
    span.textContent = chars
      .map((c) => (/\s/.test(c) || Math.random() < settled ? c : randomChar()))
      .join('');
    if (frame >= HOVER_FRAMES) {
      clearInterval(timer);
      span.textContent = target;
    }
  }, TICK_MS);
}

function setupHoverElement(el: HTMLElement): void {
  const parts = (el.textContent ?? '').split(/(\s+)/);
  el.textContent = '';
  const words: { span: HTMLElement; text: string }[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (/^\s+$/.test(part)) {
      el.appendChild(document.createTextNode(part));
    } else {
      const span = document.createElement('span');
      span.className = 'scramble-word';
      span.textContent = part;
      el.appendChild(span);
      words.push({ span, text: part });
    }
  }

  // Lock each word span to its resting width so the churning glyphs (a proportional
  // nav font, every random glyph a different width) can never resize the button and
  // reflow the header nav around it. The decode is 1:1 on character count, so the
  // resting box always holds the churn; wider glyphs paint centered inside it without
  // moving a sibling. Measured after the webfont loads so the lock matches the real
  // Inter metrics, not the fallback font.
  const lockWidths = () => {
    for (const { span } of words) {
      span.style.display = 'inline-block';
      span.style.textAlign = 'center';
      span.style.width = `${span.getBoundingClientRect().width}px`;
    }
  };
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    fonts.ready.then(() => requestAnimationFrame(lockWidths));
  } else {
    requestAnimationFrame(lockWidths);
  }

  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    for (const { span, text } of words) decodeWord(span, text);
    window.setTimeout(() => {
      running = false;
    }, HOVER_FRAMES * TICK_MS + 80);
  };
  el.addEventListener('mouseenter', run);
  el.addEventListener('focus', run);
}

function initScrambleHover(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-scramble-hover]')) {
    setupHoverElement(el);
  }
}

initScrambleHover();
