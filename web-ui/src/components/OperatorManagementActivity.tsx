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
const OperatorManagementActivity: Component<{ installationId?: string; onBackToCatalog: (event: MouseEvent) => void }> = props => {
  const [items, setItems] = createSignal<OperatorActivitySummary[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [uncertain, setUncertain] = createSignal(false);
  const [unresolvedStartId, setUnresolvedStartId] = createSignal('');
  // A shareable example may fill the two admitted fields; opening it never prepares an Activity.
  const example = new URL(window.location.href).searchParams;
  const [repository, setRepository] = createSignal((example.get('repository') ?? '').slice(0, 256));
  const [pullRequest, setPullRequest] = createSignal((example.get('pullRequest') ?? '').slice(0, 16));
  const [preview, setPreview] = createSignal<Awaited<ReturnType<typeof api.getInstallationActivityPreview>>>();
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal(false);
  const [preparedId, setPreparedId] = createSignal('');
  const [selected, setSelected] = createSignal('');
  const [detail, setDetail] = createSignal<Awaited<ReturnType<typeof api.getOwnedActivity>>>();
  const [detailLoading, setDetailLoading] = createSignal(false);
  let active = true;
  let detailSequence = 0;
  onCleanup(() => { active = false; });
  createEffect(() => {
    const id = props.installationId;
    setPreview(undefined); setPreviewError(false);
    if (!id) return;
    let current = true;
    setPreviewLoading(true);
    void api.getInstallationActivityPreview(id).then(value => { if (current) setPreview(value); })
      .catch(() => { if (current) setPreviewError(true); })
      .finally(() => { if (current) setPreviewLoading(false); });
    onCleanup(() => { current = false; });
  });
  async function refresh() {
    setLoading(true); setError('');
    try { const result = await api.getOwnedActivities(); if (active) {
      setItems(result.items);
      if (!unresolvedStartId()) setUncertain(false);
    } }
    catch (cause) { if (active) { setError(message(cause)); setItems([]); } }
    finally { if (active) setLoading(false); }
  }
  async function read(id: string) {
    const sequence = ++detailSequence;
    setSelected(id); setDetail(undefined); setDetailLoading(true); setError('');
    try { const value = await api.getOwnedActivity(id); if (active && sequence === detailSequence) {
      setDetail(value);
      if (unresolvedStartId() === id) { setUnresolvedStartId(''); setUncertain(false); }
    } }
    catch (cause) { if (active && sequence === detailSequence) setError(message(cause)); }
    finally { if (active && sequence === detailSequence) setDetailLoading(false); }
  }
  createEffect(() => { void refresh(); });
  async function perform(action: () => Promise<unknown>, success: string, onUncertain?: () => void) {
    if (busy() || uncertain()) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (active) { setNotice(success); await refresh(); if (selected()) await read(selected()); } }
    catch (cause) { if (active) { setError(message(cause)); setUncertain(true); onUncertain?.(); } }
    finally { if (active) setBusy(false); }
  }
  function invoke() {
    const mode = preview()?.guidedMode;
    if (!preview()?.guidedAssessment || !mode) return;
    const target = mode === 'repository' ? preview()?.configuredRepository ?? '' : repository().trim();
    if (mode === 'repository' && !target) { setError('Repository is not configured. Configure run settings before starting.'); return; }
    const number = Number(pullRequest());
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target) || target.length > (mode === 'repository' ? 201 : 256)) {
      setError('Repository must be an owner/repository name you can read.'); return;
    }
    if (mode === 'legacy-pull-request' && (!/^[1-9]\d*$/.test(pullRequest()) || !Number.isSafeInteger(number))) {
      setError('Enter a positive pull request number.'); return;
    }
    let attemptedStartId = '';
    void perform(async () => {
      const input = mode === 'repository' ? { repository: target } : { repository: target, pullRequest: number };
      const prepared = await api.prepareInstallationActivity(props.installationId!, input);
      if (!active) return;
      attemptedStartId = prepared.activityId;
      setPreparedId(attemptedStartId);
      await api.startInstallationActivity(attemptedStartId, prepared.startCapability);
      // The single-use start capability is neither rendered nor retained.
      if (active) setSelected(prepared.activityId);
    }, 'Activity start accepted. Observe execution and cleanup separately.',
    () => { if (attemptedStartId) {
      setUnresolvedStartId(attemptedStartId);
      setError('Activity start state could not be confirmed. Inspect the prepared activity before preparing more work.');
    } });
  }
  return <>
    <Show when={error()}><div class="operator-message" role="alert"><p>{error()}</p><button class="admin-secondary-button" disabled={busy() || loading()} onClick={() => void refresh()}>Refresh activity state</button></div></Show>
    <Show when={notice()}><p class="operator-message" role="status">{notice()}</p></Show>
    <Show when={props.installationId}>
      <section class="admin-panel operator-panel" aria-label="Prepare assessment">
        <Show when={previewLoading()}><p role="status">Checking your invocation access and installed package…</p></Show>
        <Show when={previewError()}><p role="alert">The installation is unavailable or you cannot invoke it. Return to Operators and review your access.</p></Show>
        <Show when={preview()}>{value => <Show when={value().guidedAssessment && value().guidedMode} fallback={<p>No guided assessment is available for {value().name} ({value().version}). This page does not start unsupported packages.</p>}>
          <h2>{value().guidedMode === 'repository' ? 'Assess recent Renovate pull requests' : 'Assess a Renovate pull request'}</h2><p>{value().name} · {value().version}</p>
          <p>{value().guidedMode === 'repository'
            ? 'This discovers recent Renovate pull requests, researches dependency changes, and may post comments and conditionally merge eligible pull requests using your own invocation grant, repository access and inference route. Nothing runs until you start it.'
            : 'This starts a real read-only assessment using your own invocation grant, repository read access and inference route. It will not merge or change the pull request. Nothing runs until you start it.'}</p>
          <Show when={value().guidedMode === 'repository' && !value().configuredRepository}><p role="status">Repository is not configured. Configure run settings before starting.</p></Show>
          <form onSubmit={event => { event.preventDefault(); invoke(); }}><fieldset disabled={busy() || uncertain()}>
            <div class="admin-form-grid">
              <label class="admin-form-field"><span>Repository</span><input aria-label="Repository" type="text" required maxlength={value().guidedMode === 'repository' ? 201 : 256} autocomplete="off" placeholder="owner/repository" readonly={value().guidedMode === 'repository'} value={value().guidedMode === 'repository' ? value().configuredRepository ?? '' : repository()} onInput={event => { if (value().guidedMode !== 'repository') setRepository(event.currentTarget.value); }} /><small>{value().guidedMode === 'repository' ? 'Uses the saved target; this form cannot override it.' : 'Enter a repository you can read, in owner/repository format.'}</small></label>
              <Show when={value().guidedMode === 'legacy-pull-request'}><label class="admin-form-field"><span>Pull request number</span><input aria-label="Pull request number" type="number" required min="1" step="1" max="9007199254740991" value={pullRequest()} onInput={event => setPullRequest(event.currentTarget.value)} /><small>Choose a Renovate pull request in that repository.</small></label></Show>
            </div>
            <div class="operator-actions"><button type="submit" class="admin-primary-button" disabled={value().guidedMode === 'repository' && !value().configuredRepository}>Start assessment</button><a href="/operators" onClick={props.onBackToCatalog}>Back to operators</a></div></fieldset></form>
        </Show>}</Show>
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
    <Show when={detail()}>{value => <section class="admin-panel operator-panel"><h2>Activity detail</h2><p>Activity ID: {value().activityId}</p>
      <p>Execution: {value().executionStatus} · Cleanup: {value().cleanupStatus}</p>
      <Show when={value().checkpoint != null}><h3>Progress</h3><pre class="operator-result">{JSON.stringify(value().checkpoint, null, 2)}</pre></Show>
      <Show when={value().result != null} fallback={<p>No result available.</p>}><h3>Result</h3><pre class="operator-result">{JSON.stringify(value().result, null, 2)}</pre></Show>
      <Show when={value().sessionId}><a href={`/app?session=${encodeURIComponent(value().sessionId!)}`}>Open owned session</a></Show>
    </section>}</Show>
  </>;
};
export default OperatorManagementActivity;
