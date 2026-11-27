// Pinned to stock Pi Web 1.202611.5 SessionList (open shadow root). The
// public selection subscription also fires for Back, deep links and refresh;
// it is not a user-intent signal. Never infer intent from a route or snapshot.
const interactive = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[contenteditable="true"]';

export function activateTranscriptIntent({ lifetimeSignal, selection }) {
  const base = new URL(window.location.href);
  const scope = /^\/api\/pi-web\/[a-z0-9]+\/g\/([1-9][0-9]*)\/a\/[a-f0-9-]{36}\/$/.exec(base.pathname);
  if (!scope || !selection) return;
  const endpoint = new URL('_intent', base);
  const generation = Number(scope[1]);
  const boundId = base.searchParams.get('session');
  let submitting = false;
  let pointer;
  const listen = { capture: true, signal: lifetimeSignal };
  const controlInList = (path, selector) => path.find(node => node instanceof Element && node.matches(selector)
    && node.getRootNode().host?.localName === 'session-list');

  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary) return;
    const row = controlInList(event.composedPath(), '.action-row[data-session-id]');
    pointer = row && { id: event.pointerId, row, x: event.clientX, y: event.clientY, time: event.timeStamp, dragged: false };
  }, listen);
  window.addEventListener('pointermove', event => {
    if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 4) pointer.dragged = true;
  }, listen);
  window.addEventListener('pointercancel', event => {
    if (pointer?.id === event.pointerId) pointer.dragged = true;
  }, listen);

  function intent(event) {
    if (!event.isTrusted || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const click = event.type === 'click';
    if (click ? event.button !== 0 : event.repeat || !['Enter', ' '].includes(event.key)) return;
    const path = event.composedPath();
    const plus = click && controlInList(path, 'button.start-session-button:not(:disabled)');
    const row = plus ? undefined : controlInList(path, '.action-row[data-session-id][data-archived="false"][data-selecting="false"]');
    if (!plus && (!row || path.some(node => node instanceof Element && node.matches(interactive)))) return;
    // Leave stock's drag/long-press click suppression untouched; a drag is
    // not a selection. Keyboard and assistive-technology clicks have detail 0.
    if (row && click && event.detail !== 0 && (!pointer || pointer.row !== row || pointer.dragged
      || row.dataset.reorderable === 'true' && event.timeStamp - pointer.time >= 350)) return;
    const id = row?.dataset.sessionId;
    if (row && (!id || id === boundId)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (submitting) return;
    const cwd = selection.getSnapshot().selectedWorkspace?.path;
    if (!cwd) return;
    submitting = true;
    const body = row ? { generation, cwd, action: 'select', id } : { generation, cwd, action: 'new' };
    void fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: lifetimeSignal,
    }).then(response => {
      if (response.status !== 202) throw new Error('Chat intent not accepted');
      // The parent observes the committed coordinator attempt and mounts a
      // different attachment. This frame never gets authority for that row.
    }).catch(() => {
      if (!lifetimeSignal.aborted) window.alert('Chat could not open that conversation.');
    }).finally(() => { submitting = false; });
  }
  window.addEventListener('click', intent, listen);
  window.addEventListener('keydown', intent, listen);
}
