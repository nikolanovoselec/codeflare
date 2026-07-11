/**
 * Hero flare-word scramble: a vanilla DOM port of the web-ui ScrambleText
 * component (use-scramble-text.ts, fourPhase mode): a perpetual idle loop of
 * hold -> scramble -> decrypt -> swap that keeps the headline accent word
 * gently churning.
 *
 * Two adaptations for a marketing headline that must wrap on small screens:
 *   1. Each word is a resting-width "ghost" (invisible, in flow -> holds the layout
 *      box) with the churning text painted on an absolutely-positioned overlay above
 *      it. The overlay is out of flow, so a churn glyph wider than the resting letters
 *      paints freely past the box edges -- never clipped, and never growing the box,
 *      so the phrase's wrap points never move and the headline never reflows (the
 *      reported mobile page-flicker). The phrase still wraps naturally at rest inside
 *      the headline's max-width.
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

/** Split one [data-scramble] element into per-word ghost + churn-overlay boxes, then run. */
function setupElement(el: HTMLElement): void {
  const full = el.textContent ?? '';
  // Keep whitespace runs as their own tokens so word boundaries are preserved.
  const parts = full.split(/(\s+)/);
  el.textContent = '';

  const words: { live: HTMLElement; text: string }[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (/^\s+$/.test(part)) {
      el.appendChild(document.createTextNode(part));
    } else {
      // A resting-width ghost (invisible, in flow) reserves the layout box; the churning
      // text is overlaid absolutely on top, so a glyph wider than the resting letters
      // paints past the box without clipping and without growing it -- the phrase's wrap
      // points never move, so the headline never reflows.
      const box = document.createElement('span');
      box.className = 'scramble-box';
      const ghost = document.createElement('span');
      ghost.className = 'scramble-ghost';
      ghost.textContent = part;
      const live = document.createElement('span');
      live.className = 'scramble-word';
      live.textContent = part;
      box.appendChild(ghost);
      box.appendChild(live);
      el.appendChild(box);
      words.push({ live, text: part });
    }
  }

  // Start only after the webfont has loaded, so the first churn frame is Inter, not the
  // fallback font.
  const start = () => {
    for (const { live, text } of words) {
      animateWord(live, text);
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
  // The ghost/overlay structure (setupElement) makes the churn footprint-stable, so the
  // headline never reflows at any width. The churn is still held static below the
  // layout's split breakpoint: a churning headline is louder than the calm the
  // small-screen layout wants, and the server-rendered gradient reads cleanly alone.
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
