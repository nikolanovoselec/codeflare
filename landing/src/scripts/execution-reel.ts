/**
 * One bounded, deterministic software-to-infrastructure execution sequence.
 * The semantic transcripts are already complete in the server render; this
 * module mutates only aria-hidden visual copies under normal motion.
 */
const TYPE_MS = 16;
const TYPE_CHUNK = 3;
const CONTEXT_STEP_MS = 180;
const SOFTWARE_EVENTS_START_MS = 1_150;
const SOFTWARE_EVENT_STEP_MS = 700;
const FLIP_AT_MS = 7_000;
const FLIP_MIDPOINT_MS = 340;
const INFRA_EVENTS_START_MS = 7_800;
const INFRA_EVENT_STEP_MS = 700;
const COMPLETE_AT_MS = 15_000;
const MAX_VISIBLE_LINES = 6;

interface FaceElements {
  face: HTMLElement;
  lines: HTMLElement[];
  context: HTMLElement[];
  events: HTMLElement[];
  caret: HTMLElement | null;
}

const started = new WeakSet<HTMLElement>();

function collectFace(root: HTMLElement, name: 'software' | 'infrastructure'): FaceElements | null {
  const face = root.querySelector<HTMLElement>(`[data-execution-face="${name}"]`);
  if (!face) return null;
  const lines = Array.from(face.querySelectorAll<HTMLElement>('[data-execution-line]'));
  return {
    face,
    lines,
    context: lines.filter((line) => line.dataset.executionLine === 'context'),
    events: lines.filter((line) => line.dataset.executionLine === 'event'),
    caret: face.querySelector<HTMLElement>('[data-execution-caret]'),
  };
}

function textElement(line: HTMLElement): HTMLElement | null {
  return line.querySelector<HTMLElement>('[data-execution-text]');
}

function resetFace(face: FaceElements): void {
  for (const line of face.lines) {
    line.classList.remove('is-visible', 'is-history');
    const text = textElement(line);
    if (text) text.textContent = '';
  }
  face.caret?.setAttribute('data-active', 'false');
}

function typeLine(line: HTMLElement): void {
  const text = textElement(line);
  const full = text?.dataset.fullText ?? '';
  if (!text) return;
  text.textContent = '';
  let offset = 0;
  const tick = () => {
    offset = Math.min(full.length, offset + TYPE_CHUNK);
    text.textContent = full.slice(0, offset);
    if (offset < full.length) window.setTimeout(tick, TYPE_MS);
  };
  window.setTimeout(tick, TYPE_MS);
}

function scrollHistory(face: FaceElements): void {
  const visible = face.lines.filter(
    (line) => line.classList.contains('is-visible') && !line.classList.contains('is-history'),
  );
  const overflow = visible.length - MAX_VISIBLE_LINES;
  for (let index = 0; index < overflow; index += 1) {
    visible[index].classList.add('is-history');
  }
}

function revealLine(face: FaceElements, line: HTMLElement): void {
  line.classList.add('is-visible');
  typeLine(line);
  scrollHistory(face);
}

function scheduleLines(face: FaceElements, lines: HTMLElement[], start: number, step: number): void {
  lines.forEach((line, index) => {
    window.setTimeout(() => revealLine(face, line), start + index * step);
  });
}

function resolveFace(face: FaceElements): void {
  for (const line of face.lines) {
    const text = textElement(line);
    if (text) text.textContent = text.dataset.fullText ?? '';
    line.classList.add('is-visible');
    line.classList.remove('is-history');
  }
  const overflow = Math.max(0, face.lines.length - MAX_VISIBLE_LINES);
  face.lines.slice(0, overflow).forEach((line) => line.classList.add('is-history'));
}

export function startExecutionReel(root: HTMLElement): void {
  if (started.has(root)) return;
  const software = collectFace(root, 'software');
  const infrastructure = collectFace(root, 'infrastructure');
  if (!software || !infrastructure) return;
  started.add(root);

  root.classList.add('is-enhanced');
  root.classList.remove('is-flipped', 'is-complete');
  root.dataset.executionState = 'software';
  root.dataset.executionFlips = '0';
  resetFace(software);
  resetFace(infrastructure);
  software.caret?.setAttribute('data-active', 'true');

  // Both faces acquire recent context together. The back face is ready when the
  // card flips, so the visitor lands in an operation already under way.
  scheduleLines(software, software.context, 0, CONTEXT_STEP_MS);
  scheduleLines(infrastructure, infrastructure.context, 0, CONTEXT_STEP_MS);
  scheduleLines(software, software.events, SOFTWARE_EVENTS_START_MS, SOFTWARE_EVENT_STEP_MS);

  window.setTimeout(() => {
    root.classList.add('is-flipped');
    root.dataset.executionFlips = '1';
    window.setTimeout(() => {
      root.dataset.executionState = 'infrastructure';
      software.caret?.setAttribute('data-active', 'false');
      infrastructure.caret?.setAttribute('data-active', 'true');
    }, FLIP_MIDPOINT_MS);
  }, FLIP_AT_MS);

  scheduleLines(
    infrastructure,
    infrastructure.events,
    INFRA_EVENTS_START_MS,
    INFRA_EVENT_STEP_MS,
  );

  window.setTimeout(() => {
    resolveFace(software);
    resolveFace(infrastructure);
    root.classList.add('is-complete');
    root.dataset.executionState = 'complete';
    software.caret?.setAttribute('data-active', 'false');
    infrastructure.caret?.setAttribute('data-active', 'true');
  }, COMPLETE_AT_MS);
}

function init(): void {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-execution-reel]'));
  if (roots.length === 0) return;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduced) return;

  // Collapse the complete static two-run fallback into the fixed single-face
  // stage before first paint. Typing remains unarmed until intersection.
  roots.forEach((root) => root.classList.add('is-ready'));

  if (!('IntersectionObserver' in window)) {
    roots.forEach(startExecutionReel);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        startExecutionReel(entry.target as HTMLElement);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px 120px 0px', threshold: 0 },
  );
  roots.forEach((root) => observer.observe(root));
}

init();

