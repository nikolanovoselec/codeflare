/**
 * Hero flare-word scramble: a vanilla DOM port of the web-ui ScrambleText
 * component (use-scramble-text.ts, fourPhase mode): a perpetual idle loop of
 * hold -> scramble -> decrypt -> swap that keeps the headline accent word
 * gently churning.
 *
 * Two adaptations for a marketing headline that must wrap on small screens:
 *   1. The phrase CONTAINER is width-locked to its natural width and set nowrap,
 *      so glyph churn never reflows the headline. Each word span stays
 *      content-sized, so wider churn glyphs are painted rather than clipped to a
 *      fixed-width gradient box (a fixed-width span with background-clip:text
 *      renders any glyph past its right edge transparent -> the old "cut off").
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

  // Lock the phrase CONTAINER's width to its natural width and stop it wrapping,
  // so glyph churn can never reflow the headline. Each word span is left
  // content-sized, so its own gradient box always covers its current glyphs and
  // nothing is clipped. The container keeps its natural layout width, so churn
  // overflow (if any) is trailing at the line end. The font size is fluid (a
  // vw-based clamp), so this must re-run on resize/rotation.
  const lockContainer = () => {
    el.style.width = '';
    el.style.display = 'inline-block';
    el.style.whiteSpace = 'nowrap';
    for (const { span, text } of words) {
      span.style.width = '';
      span.textContent = text;
    }
    el.style.width = `${el.getBoundingClientRect().width.toFixed(2)}px`;
  };

  const start = () => {
    lockContainer();
    for (const { span, text } of words) {
      animateWord(span, text);
    }
  };

  // Measure only after the webfont has loaded, or the widths would be wrong once
  // Inter swaps in over the fallback font.
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    fonts.ready.then(() => requestAnimationFrame(start));
  } else {
    requestAnimationFrame(start);
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => requestAnimationFrame(lockContainer), 150);
  });
}

function initScramble(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
