import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiDeveloperBoard } from '@mdi/js';
import Icon from './Icon';
import { cancelOperatorActivity, listOperatorActivities } from '../api/operator-activities';

interface Props { enabled: boolean }
const workingStates = new Set(['queued', 'running', 'waiting', 'cancel-requested', 'unknown']);

/** REQ-OPERATOR-008 global enterprise activity summary; all mutations remain explicit POSTs. */
const OperatorActivityButton: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [cancelling, setCancelling] = createSignal<string>();
  const [loadError, setLoadError] = createSignal(false);
  const [activities, { refetch }] = createResource(() => props.enabled, async enabled => {
    if (!enabled) return { items: [] };
    try { const value = await listOperatorActivities(); setLoadError(false); return value; }
    catch { setLoadError(true); return null; }
  });
  const working = createMemo(() => (activities()?.items ?? []).filter(item => workingStates.has(item.executionStatus)).length);
  const hasActivities = createMemo(() => (activities()?.items.length ?? 0) > 0);
  let control: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  const [position, setPosition] = createSignal({ top: 0, right: 0 });
  // Focus returns to the trigger only when it was inside the panel, so dismissing by clicking
  // elsewhere on the page does not steal focus from whatever the user clicked.
  const close = () => {
    const held = !!panel && !!document.activeElement && panel.contains(document.activeElement);
    setOpen(false);
    if (held) trigger?.focus();
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && open()) close(); };
  // The panel is portalled, so it is not a descendant of the control: both boxes count as inside.
  const clickOutside = (event: MouseEvent) => {
    if (!open() || !(event.target instanceof Node)) return;
    if (!control?.contains(event.target) && !panel?.contains(event.target)) close();
  };
  const toggle = () => {
    if (!open() && trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
    setOpen(value => !value);
    if (open()) queueMicrotask(() => panel?.focus());
  };
  // Coordinates and the layout branch are measured once per open, so the panel cannot outlive
  // the viewport it was measured in: a width crossing while open would otherwise leave desktop
  // offsets on a bottom sheet, or a fixed box with no offsets at all.
  const closeOnResize = () => { if (open()) close(); };
  onMount(() => {
    document.addEventListener('keydown', keydown);
    document.addEventListener('mousedown', clickOutside);
    window.addEventListener('resize', closeOnResize);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('mousedown', clickOutside);
    window.removeEventListener('resize', closeOnResize);
  });
  const interval = setInterval(() => { if (props.enabled) void refetch(); }, 15_000);
  onCleanup(() => clearInterval(interval));
  const updatedDate = (updatedAt: string | number) => typeof updatedAt === 'number'
    ? new Date(updatedAt) : new Date(updatedAt);
  const stale = (updatedAt: string | number) => Date.now() - updatedDate(updatedAt).getTime() > 2 * 60_000;
  const cancel = async (activityId: string) => {
    setCancelling(activityId);
    try { await cancelOperatorActivity(activityId); await refetch(); } finally { setCancelling(undefined); }
  };

  return <Show when={props.enabled}>
    <div ref={control} class="operator-activity-control">
      <button ref={trigger} type="button" class="header-icon-button operator-activity-trigger" aria-label="Operator activity"
        aria-expanded={open()} onClick={toggle}>
        <Icon path={mdiDeveloperBoard} size={22} />
        <Show when={working() > 0}><span class="operator-activity-badge">{working()}</span></Show>
      </button>
      {/* Portalled so the panel escapes the dashboard panel's backdrop-filter, which would
          otherwise make that card the containing block for position: fixed and inset the
          mobile bottom sheet. Same pattern as the account dropdown. Desktop anchors to the
          trigger via measured coordinates; mobile leaves them unset so the bottom-sheet
          media query applies. Focus moves into the panel on open and back to the trigger on
          close, because the portal detaches it from the trigger's tab order. */}
      <Portal>
      <Show when={open()}>
        <section ref={panel} class="operator-activity-panel operator-activity-panel--portal" classList={{
          'operator-activity-panel--active': working() > 0,
          'operator-activity-panel--compact': working() === 0,
          'operator-activity-panel--empty': !activities.loading && !loadError() && !hasActivities(),
        }} style={window.innerWidth > 640
          ? { top: `${position().top}px`, right: `${position().right}px` }
          : undefined} tabindex="-1" role="dialog" aria-label="Operator activity" aria-modal="false">
          <header><div><strong>Operator overview</strong><small>Operators are autonomous agents that work in the background. Track progress and results here.</small></div></header>
          <Show when={!activities.loading} fallback={<div class="operator-activity-state">Loading activity…</div>}>
            <Show when={!loadError()} fallback={<div class="operator-activity-state"><strong>Activity unavailable</strong><span>Last known state cannot be treated as current.</span><button type="button" onClick={() => void refetch()}>Retry</button></div>}>
              <Show when={(activities()?.items.length ?? 0) > 0} fallback={<div class="operator-activity-state operator-activity-state--empty">No activity</div>}>
                <div class="operator-activity-list"><For each={activities()?.items}>{item => (
                  <article class={`operator-activity-item ${item.attention || stale(item.updatedAt) ? 'needs-attention' : ''}`}>
                    <div><strong>{item.operatorId}</strong><span class="admin-mono">{item.activityId}</span></div>
                    <Show when={item.attention || stale(item.updatedAt)}><span class="operator-activity-attention">Needs attention</span></Show>
                    <Show when={item.source}><p>{item.source}</p></Show>
                    <dl><div><dt>Execution</dt><dd>Execution: {item.executionStatus}</dd></div>
                      <div><dt>Cleanup</dt><dd>Cleanup: {item.cleanupStatus}</dd></div>
                      <div><dt>Collection</dt><dd>Collection: {item.collectionStatus}</dd></div></dl>
                    <small>Updated {updatedDate(item.updatedAt).toLocaleString()}</small>
                    <nav><Show when={item.sessionId}>{sessionId => <a href={`/app?session=${encodeURIComponent(sessionId())}`}>Open session</a>}</Show>
                      <a href={`/api/operator-activities/${encodeURIComponent(item.activityId)}/result`}>View result</a>
                      <Show when={workingStates.has(item.executionStatus)}><button type="button" disabled={cancelling() === item.activityId}
                        aria-label={`Cancel ${item.activityId}`} onClick={() => void cancel(item.activityId)}>Cancel</button></Show></nav>
                  </article>
                )}</For></div>
              </Show>
            </Show>
          </Show>
        </section>
      </Show>
      </Portal>
    </div>
  </Show>;
};
export default OperatorActivityButton;
