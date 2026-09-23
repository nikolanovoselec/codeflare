import { For, Show, createEffect, createSignal, onCleanup, type Component } from 'solid-js';
import * as api from '../api/operator-management';
import type { OperatorActivitySummary } from '../api/operator-activities';
import { ApiError } from '../api/fetch-helper';

const working = new Set(['queued', 'running', 'waiting', 'cancel-requested', 'unknown']);
function message(error: unknown) {
  if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return 'Access denied. Invocation requires its own grant; management is not invocation.';
  if (error instanceof ApiError && error.status === 409) return 'Activity or installation state changed. Refresh and review before acting again.';
  if (error instanceof ApiError && error.status === 400) return 'Invalid invocation. Check the approved operator input contract.';
  return 'Activity state could not be confirmed. Refresh before another action; uncertain work must not be blindly repeated.';
}
/** Reads never drive or renew activity authority. No background mutation or automatic retry. */
const OperatorManagementActivity: Component<{ installationId?: string }> = props => {
  const [items, setItems] = createSignal<OperatorActivitySummary[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [uncertain, setUncertain] = createSignal(false);
  const [invocation, setInvocation] = createSignal('{}');
  const [preparedId, setPreparedId] = createSignal('');
  const [selected, setSelected] = createSignal('');
  const [detail, setDetail] = createSignal<Awaited<ReturnType<typeof api.getOwnedActivity>>>();
  const [detailLoading, setDetailLoading] = createSignal(false);
  let active = true;
  let detailSequence = 0;
  onCleanup(() => { active = false; });
  async function refresh() {
    setLoading(true); setError('');
    try { const result = await api.getOwnedActivities(); if (active) { setItems(result.items); setUncertain(false); } }
    catch (cause) { if (active) { setError(message(cause)); setItems([]); } }
    finally { if (active) setLoading(false); }
  }
  async function read(id: string) {
    const sequence = ++detailSequence;
    setSelected(id); setDetail(undefined); setDetailLoading(true); setError('');
    try { const value = await api.getOwnedActivity(id); if (active && sequence === detailSequence) setDetail(value); }
    catch (cause) { if (active && sequence === detailSequence) setError(message(cause)); }
    finally { if (active && sequence === detailSequence) setDetailLoading(false); }
  }
  createEffect(() => { void refresh(); });
  async function perform(action: () => Promise<unknown>, success: string) {
    if (busy() || uncertain()) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (active) { setNotice(success); await refresh(); if (selected()) await read(selected()); } }
    catch (cause) { if (active) { setError(message(cause)); setUncertain(true); } }
    finally { if (active) setBusy(false); }
  }
  function invoke() {
    let input: unknown;
    try {
      if (new TextEncoder().encode(invocation()).byteLength > 65536) throw new Error('Too large');
      input = JSON.parse(invocation());
    } catch { setError('Invocation must be valid JSON, at most 64 KiB.'); return; }
    void perform(async () => {
      const prepared = await api.prepareInstallationActivity(props.installationId!, input);
      if (!active) return;
      setPreparedId(prepared.activityId);
      await api.startInstallationActivity(prepared.activityId, prepared.startCapability);
      // The single-use start capability is neither rendered nor retained.
      if (active) setSelected(prepared.activityId);
    }, 'Activity start accepted. Observe execution and cleanup separately.');
  }
  return <>
    <Show when={error()}><div class="operator-message" role="alert"><p>{error()}</p><button class="admin-secondary-button" disabled={busy() || loading()} onClick={() => void refresh()}>Refresh activity state</button></div></Show>
    <Show when={notice()}><p class="operator-message" role="status">{notice()}</p></Show>
    <Show when={props.installationId}>
      <section class="admin-panel operator-panel"><h2>Invoke as yourself</h2><p>Installation: {props.installationId}</p>
        <p>Runs with your current human authorization and this installation's pinned release and restrictions. Disabled installations cannot start new work.</p>
        <form onSubmit={event => { event.preventDefault(); invoke(); }}><fieldset disabled={busy() || uncertain()}>
          <label class="admin-form-field"><span>Invocation JSON</span><textarea aria-label="Invocation JSON" rows="8" required maxlength="65536" value={invocation()} onInput={event => setInvocation(event.currentTarget.value)} /><small>Use the approved operator's input contract. Never paste source credentials, Access tokens or caller authority.</small></label>
          <button type="submit" class="admin-primary-button">Start activity</button></fieldset></form>
        <Show when={preparedId()}><p>Prepared activity: <button class="admin-secondary-button" disabled={busy()} onClick={() => void read(preparedId())}>{preparedId()}</button>. If submission was interrupted, inspect its state before preparing more work.</p></Show>
      </section>
    </Show>
    <section class="admin-panel operator-panel"><div class="operator-section-heading"><h2>My activity</h2><button class="admin-secondary-button" disabled={busy() || loading()} onClick={() => void refresh()}>Refresh activities</button></div>
      <p>Only activities initiated by your authenticated identity. Status reads do not drive work or renew authorization.</p>
      <Show when={loading()}><p role="status">Loading owned activities…</p></Show>
      <Show when={!loading() && !error()}><Show when={items().length} fallback={<p>No owned activity.</p>}>
        <ul class="operator-list"><For each={items()}>{item => <li><strong>{item.operatorId}</strong><p>{item.activityId}</p>
          <p>Execution: {item.executionStatus} · Cleanup: {item.cleanupStatus} · Collection: {item.collectionStatus}</p>
          <p>Updated {new Date(item.updatedAt).toLocaleString()}{Date.now() - new Date(item.updatedAt).getTime() > 120000 ? ' · Stale observation — refresh before acting' : ''}</p>
          <Show when={item.attention}><p>Needs attention</p></Show>
          <div class="operator-actions"><button class="admin-secondary-button" disabled={busy()} onClick={() => void read(item.activityId)}>View {item.activityId}</button>
            <Show when={working.has(item.executionStatus)}><button class="admin-secondary-button" disabled={busy() || uncertain() || item.executionStatus === 'cancel-requested'} aria-label={`Cancel ${item.activityId}`} onClick={() => void perform(() => api.cancelOwnedActivity(item.activityId), 'Cancellation requested. Already-admitted effects cannot be undone.')}>Cancel activity</button></Show>
            <Show when={item.executionStatus === 'waiting'}><button class="admin-secondary-button" disabled={busy() || uncertain()} aria-label={`Continue ${item.activityId}`} onClick={() => void perform(() => api.continueOwnedActivity(item.activityId), 'Continuation requested with current authorization.')}>Continue activity</button></Show>
          </div>
        </li>}</For></ul>
      </Show></Show>
    </section>
    <Show when={detailLoading()}><p role="status">Loading activity detail…</p></Show>
    <Show when={detail()}>{value => <section class="admin-panel operator-panel"><h2>Activity {value().activityId}</h2>
      <p>Execution: {value().executionStatus} · Cleanup: {value().cleanupStatus}</p>
      <Show when={value().checkpoint != null}><h3>Progress</h3><pre class="operator-result">{JSON.stringify(value().checkpoint, null, 2)}</pre></Show>
      <Show when={value().result != null} fallback={<p>No result available.</p>}><h3>Result</h3><pre class="operator-result">{JSON.stringify(value().result, null, 2)}</pre></Show>
      <Show when={value().sessionId}><a href={`/app?session=${encodeURIComponent(value().sessionId!)}`}>Open owned session</a></Show>
    </section>}</Show>
  </>;
};
export default OperatorManagementActivity;
