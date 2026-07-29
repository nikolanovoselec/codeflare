/**
 * Two independent, bounded Execution terminal timelines. Semantic transcripts
 * are complete in the server render; normal motion mutates only aria-hidden
 * visual event copies after their own terminal enters the viewport.
 */
const TYPE_MS = 22;
const TYPE_CHUNK = 2;
const LINE_HOLD_MS = 1_600;

interface TerminalElements {
  face: HTMLElement;
  events: HTMLElement[];
  caret: HTMLElement | null;
}

const started = new WeakSet<HTMLElement>();

function collectTerminal(face: HTMLElement): TerminalElements {
  return {
    face,
    events: Array.from(face.querySelectorAll<HTMLElement>('[data-execution-line="event"]')),
    caret: face.querySelector<HTMLElement>('[data-execution-caret]'),
  };
}

function textElement(line: HTMLElement): HTMLElement | null {
  return line.querySelector<HTMLElement>('[data-execution-text]');
}

function prepareTerminal(terminal: TerminalElements): void {
  terminal.face.dataset.executionState = 'ready';
  terminal.caret?.setAttribute('data-active', 'false');
  for (const line of terminal.events) {
    line.classList.remove('is-typing', 'is-complete');
    const text = textElement(line);
    if (text) text.textContent = '';
  }
}

function typeLine(line: HTMLElement, onComplete: () => void): void {
  const text = textElement(line);
  const full = text?.dataset.fullText ?? '';
  if (!text) {
    onComplete();
    return;
  }

  line.classList.add('is-typing');
  let offset = 0;
  const tick = () => {
    offset = Math.min(full.length, offset + TYPE_CHUNK);
    text.textContent = full.slice(0, offset);
    if (offset < full.length) {
      window.setTimeout(tick, TYPE_MS);
      return;
    }
    line.classList.remove('is-typing');
    line.classList.add('is-complete');
    onComplete();
  };
  window.setTimeout(tick, TYPE_MS);
}

function updateReelState(face: HTMLElement): void {
  const root = face.closest<HTMLElement>('[data-execution-reel]');
  if (!root) return;
  const states = Array.from(root.querySelectorAll<HTMLElement>('[data-execution-face]'))
    .map((terminal) => terminal.dataset.executionState);
  root.dataset.executionState = states.every((state) => state === 'complete')
    ? 'complete'
    : 'running';
}

function startTerminal(face: HTMLElement): void {
  if (started.has(face)) return;
  started.add(face);
  const terminal = collectTerminal(face);
  terminal.face.dataset.executionState = 'running';
  terminal.caret?.setAttribute('data-active', 'true');
  updateReelState(face);

  const typeNext = (index: number) => {
    if (index >= terminal.events.length) {
      terminal.face.dataset.executionState = 'complete';
      terminal.caret?.setAttribute('data-active', 'false');
      updateReelState(face);
      return;
    }
    typeLine(terminal.events[index], () => {
      if (index === terminal.events.length - 1) {
        typeNext(index + 1);
        return;
      }
      window.setTimeout(() => typeNext(index + 1), LINE_HOLD_MS);
    });
  };

  typeNext(0);
}

function init(): void {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-execution-reel]'));
  if (roots.length === 0) return;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduced || !('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const face = entry.target as HTMLElement;
        startTerminal(face);
        observer.unobserve(face);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.15 },
  );

  for (const root of roots) {
    const faces = Array.from(root.querySelectorAll<HTMLElement>('[data-execution-face]'));
    if (faces.length === 0) continue;
    root.classList.add('is-ready');
    root.dataset.executionState = 'ready';
    for (const face of faces) {
      prepareTerminal(collectTerminal(face));
      observer.observe(face);
    }
  }
}

init();
