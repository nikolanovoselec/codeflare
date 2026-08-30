const MAX_TRACE_LINES = 12;

function targetLabel(target: EventTarget | null): string {
  if (target === window) return 'window';
  if (!(target instanceof Element)) return 'other';
  const id = target.id ? `#${target.id}` : '';
  const className = typeof target.className === 'string'
    ? target.className.trim().split(/\s+/)[0]
    : '';
  return `${target.tagName.toLowerCase()}${id}${className ? `.${className}` : ''}`;
}

function touchSource(event: Event): string {
  const value = (event as Event & {
    sourceCapabilities?: { firesTouchEvents?: boolean } | null;
  }).sourceCapabilities?.firesTouchEvents;
  return value === undefined ? '?' : value ? '1' : '0';
}

/** Attach bounded, content-free browser input tracing for the ?debug=1 overlay. */
export function attachTouchEventDebug(
  target: Window,
  onTrace: (lines: readonly string[]) => void,
): () => void {
  const startedAt = performance.now();
  const lines: string[] = [];
  let touchMoves = 0;
  const eventTypes = [
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'pointerdown', 'pointerup', 'pointercancel',
    'mousedown', 'mouseup', 'click', 'focusin', 'focusout',
  ] as const;

  const append = (line: string) => {
    lines.push(line);
    if (lines.length > MAX_TRACE_LINES) lines.splice(0, lines.length - MAX_TRACE_LINES);
    onTrace([...lines]);
  };

  const handleEvent = (event: Event) => {
    if (event.type === 'touchstart') touchMoves = 0;
    if (event.type === 'touchmove') {
      touchMoves += 1;
      return;
    }
    const elapsed = Math.round(performance.now() - startedAt);
    const moveSuffix = event.type === 'touchend' || event.type === 'touchcancel'
      ? ` moves=${touchMoves}`
      : '';
    const pointerType = typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
      ? ` pointer=${event.pointerType || '?'}`
      : '';
    const detail = event instanceof MouseEvent ? ` detail=${event.detail}` : '';
    const source = event instanceof MouseEvent ? ` touchSource=${touchSource(event)}` : '';
    const eventTarget = targetLabel(event.target);

    queueMicrotask(() => {
      append(`${elapsed}ms ${event.type} prevented=${event.defaultPrevented ? 1 : 0}`
        + ` trusted=${event.isTrusted ? 1 : 0}${source}${detail}${pointerType}${moveSuffix}`
        + ` target=${eventTarget} active=${targetLabel(target.document.activeElement)}`);
    });
  };

  const virtualKeyboard = (target.navigator as Navigator & {
    virtualKeyboard?: {
      boundingRect: DOMRect;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
  }).virtualKeyboard;
  const recordViewport = (type: string) => {
    const elapsed = Math.round(performance.now() - startedAt);
    append(`${elapsed}ms ${type} inner=${target.innerHeight}`
      + ` vv=${target.visualViewport?.height.toFixed(0) ?? '?'}`
      + ` vk=${virtualKeyboard?.boundingRect.height.toFixed(0) ?? '?'}`
      + ` active=${targetLabel(target.document.activeElement)}`);
  };
  const handleGeometry = () => recordViewport('geometrychange');
  const handleViewportResize = () => recordViewport('visualViewport.resize');
  const handleResize = () => recordViewport('window.resize');

  for (const type of eventTypes) {
    target.addEventListener(type, handleEvent, { capture: true, passive: true });
  }
  virtualKeyboard?.addEventListener('geometrychange', handleGeometry);
  target.visualViewport?.addEventListener('resize', handleViewportResize);
  target.addEventListener('resize', handleResize, { passive: true });

  return () => {
    for (const type of eventTypes) {
      target.removeEventListener(type, handleEvent, { capture: true });
    }
    virtualKeyboard?.removeEventListener('geometrychange', handleGeometry);
    target.visualViewport?.removeEventListener('resize', handleViewportResize);
    target.removeEventListener('resize', handleResize);
  };
}
