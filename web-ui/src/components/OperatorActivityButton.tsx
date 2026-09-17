import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { mdiRobotOutline, mdiClose, mdiRefresh } from '@mdi/js';
import Icon from './Icon';
import { cancelOperatorActivity, listOperatorActivities } from '../api/operator-activities';

interface Props { enabled: boolean }
const workingStates = new Set(['queued', 'running', 'waiting', 'cancel-requested', 'unknown']);

/** REQ-OPERATOR-008 global enterprise activity summary; all mutations remain explicit POSTs. */
const OperatorActivityButton: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [cancelling, setCancelling] = createSignal<string>();
  const [activities, { refetch }] = createResource(() => props.enabled, async enabled => enabled
    ? listOperatorActivities() : { items: [] });
  const working = createMemo(() => (activities()?.items ?? []).filter(item => workingStates.has(item.executionStatus)).length);
  let closeButton: HTMLButtonElement | undefined;
  const close = () => setOpen(false);
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && open()) close(); };
  onMount(() => document.addEventListener('keydown', keydown));
  onCleanup(() => document.removeEventListener('keydown', keydown));
  const interval = setInterval(() => { if (props.enabled) void refetch(); }, 15_000);
  onCleanup(() => clearInterval(interval));
  createEffect(() => { if (open()) queueMicrotask(() => closeButton?.focus()); });
  const stale = (updatedAt: string) => Date.now() - new Date(updatedAt).getTime() > 2 * 60_000;
  const cancel = async (activityId: string) => {
    setCancelling(activityId);
    try { await cancelOperatorActivity(activityId); await refetch(); } finally { setCancelling(undefined); }
  };

  return <Show when={props.enabled}>
    <div class="operator-activity-control">
      <button type="button" class="header-icon-button operator-activity-trigger" aria-label="Operator activity"
        aria-expanded={open()} onClick={() => setOpen(value => !value)}>
        <Icon path={mdiRobotOutline} size={22} />
        <Show when={working() > 0}><span class="operator-activity-badge">{working()}</span></Show>
      </button>
      <Show when={open()}>
        <section class="operator-activity-panel" role="dialog" aria-label="Operator activity" aria-modal="false">
          <header><div><strong>Operator activity</strong><small>Execution, cleanup and collection are independent.</small></div>
            <button ref={closeButton} type="button" class="header-icon-button" aria-label="Close operator activity" onClick={close}><Icon path={mdiClose} size={18} /></button>
          </header>
          <Show when={!activities.loading} fallback={<div class="operator-activity-state">Loading activity…</div>}>
            <Show when={!activities.error} fallback={<div class="operator-activity-state"><strong>Activity unavailable</strong><span>Last known state cannot be treated as current.</span><button type="button" onClick={() => void refetch()}>Retry</button></div>}>
              <Show when={(activities()?.items.length ?? 0) > 0} fallback={<div class="operator-activity-state">No operator activity</div>}>
                <div class="operator-activity-list"><For each={activities()?.items}>{item => (
                  <article class={`operator-activity-item ${item.attention || stale(item.updatedAt) ? 'needs-attention' : ''}`}>
                    <div><strong>{item.operatorId}</strong><span class="admin-mono">{item.activityId}</span></div>
                    <Show when={item.attention || stale(item.updatedAt)}><span class="operator-activity-attention">Needs attention</span></Show>
                    <Show when={item.source}><p>{item.source}</p></Show>
                    <dl><div><dt>Execution</dt><dd>Execution: {item.executionStatus}</dd></div>
                      <div><dt>Cleanup</dt><dd>Cleanup: {item.cleanupStatus}</dd></div>
                      <div><dt>Collection</dt><dd>Collection: {item.collectionStatus}</dd></div></dl>
                    <small>Updated {new Date(item.updatedAt).toLocaleString()}</small>
                    <nav><Show when={item.sessionId}>{sessionId => <a href={`/app?session=${encodeURIComponent(sessionId())}`}>Open session</a>}</Show>
                      <a href={`/api/operator-activities/${encodeURIComponent(item.activityId)}/result`}>View result</a>
                      <Show when={workingStates.has(item.executionStatus)}><button type="button" disabled={cancelling() === item.activityId}
                        aria-label={`Cancel ${item.activityId}`} onClick={() => void cancel(item.activityId)}>Cancel</button></Show></nav>
                  </article>
                )}</For></div>
              </Show>
            </Show>
          </Show>
          <footer><button type="button" onClick={() => void refetch()}><Icon path={mdiRefresh} size={16} /> Refresh</button></footer>
        </section>
      </Show>
    </div>
  </Show>;
};
export default OperatorActivityButton;
