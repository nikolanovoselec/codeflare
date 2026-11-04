import { For, Show, createEffect, createSignal, onCleanup, type Component } from 'solid-js';
import * as api from '../api/operator-management';
import { getSessions } from '../api/client';
import type { Session } from '../types';
import { SESSION_ID_RE } from '../lib/constants';
import { piLoginRecoveryCopy, type OperatorActivitySummary, type OperatorActivityDetail } from '../api/operator-activities';
import { ApiError } from '../api/fetch-helper';
import OperatorActivityDiagnostics from './OperatorActivityDiagnostics';

const working = new Set(['queued', 'running', 'waiting', 'cancel-requested', 'unknown']);
const nativeSelection = (selection: OperatorActivityDetail['inferenceSelection']) => selection?.source === 'pi-native' ? selection : undefined;
function nativeReasoningLabel(selection: NonNullable<ReturnType<typeof nativeSelection>>): string {
  const level = selection.reasoningLevel;
  if (level === null) return 'Provider default';
  const origin = selection.reasoningSource === 'installation' ? 'installation override'
    : selection.reasoningSource === 'default' ? 'Medium default'
      : selection.reasoningSource ? 'inherited Pi default' : 'reasoning origin unavailable';
  return `${level.charAt(0).toUpperCase() + level.slice(1)} (${origin})`;
}
type SourceHost = Session & { generation: number };
function isSourceHost(session: Session): session is SourceHost {
  const lifecycle = session.lifecycle ?? session.status;
  return (lifecycle === 'running' || lifecycle === 'starting') && SESSION_ID_RE.test(session.id)
    && typeof session.generation === 'number' && Number.isSafeInteger(session.generation) && session.generation > 0;
}
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
  const [sourceHosts, setSourceHosts] = createSignal<SourceHost[]>([]);
  const [sourceSession, setSourceSession] = createSignal<{ sessionId: string; sessionGeneration: number }>();
  const [sourceLoading, setSourceLoading] = createSignal(false);
  const [sourceError, setSourceError] = createSignal(false);
  const [preparedId, setPreparedId] = createSignal('');
  const [selected, setSelected] = createSignal('');
  const [detail, setDetail] = createSignal<Awaited<ReturnType<typeof api.getOwnedActivity>>>();
  const [detailLoading, setDetailLoading] = createSignal(false);
  let active = true;
  let detailSequence = 0;
  let sourceSequence = 0;
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
  createEffect(() => {
    const requiresSource = preview()?.guidedAssessment && preview()?.requiresSourceHost;
    sourceSequence++;
    setSourceHosts([]); setSourceSession(undefined); setSourceLoading(false); setSourceError(false);
    if (requiresSource) void refreshSources();
  });
  async function refreshSources() {
    const sequence = ++sourceSequence;
    setSourceLoading(true); setSourceError(false);
    try {
      const hosts = (await getSessions()).filter(isSourceHost);
      if (active && sequence === sourceSequence) {
        setSourceHosts(hosts);
        setSourceSession(previous => previous && hosts.some(host => host.id === previous.sessionId
          && host.generation === previous.sessionGeneration) ? previous : undefined);
      }
    } catch {
      if (active && sequence === sourceSequence) {
        setSourceHosts([]); setSourceSession(undefined); setSourceError(true);
      }
    } finally { if (active && sequence === sourceSequence) setSourceLoading(false); }
  }
  function sourceReady() {
    const source = sourceSession();
    return !preview()?.requiresSourceHost || source !== undefined && !sourceLoading() && !sourceError()
      && sourceHosts().some(host => host.id === source.sessionId && host.generation === source.sessionGeneration);
  }
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
    if (!sourceReady()) { setError('Select an available existing source Host before starting.'); return; }
    const source = preview()?.requiresSourceHost ? sourceSession() : undefined;
    let attemptedStartId = '';
    void perform(async () => {
      const input = mode === 'repository' ? { repository: target } : { repository: target, pullRequest: number };
      const prepared = await api.prepareInstallationActivity(props.installationId!, input, source);
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
              <Show when={value().requiresSourceHost}>
                <label class="admin-form-field"><span>Source host</span><select aria-label="Source host" required disabled={sourceLoading()} onChange={event => {
                  const host = sourceHosts().find(candidate => candidate.id === event.currentTarget.value);
                  setSourceSession(host ? { sessionId: host.id, sessionGeneration: host.generation } : undefined);
                }}><option value="" selected={!sourceSession()}>Select an existing host</option><For each={sourceHosts()}>{host => <option value={host.id} selected={sourceSession()?.sessionId === host.id && sourceSession()?.sessionGeneration === host.generation}>{host.name} · {host.id} · generation {host.generation}</option>}</For></select>
                  <small>Uses that existing Host's configured Pi services. This does not start or resume a session, open Pi, or change saved settings.</small>
                </label>
                <div class="admin-form-field">
                  <Show when={sourceLoading()}><p role="status">Reading existing source hosts…</p></Show>
                  <Show when={sourceError()}><p role="alert">Source hosts could not be read. Refresh before selecting a Host.</p></Show>
                  <Show when={!sourceLoading() && !sourceError() && sourceHosts().length === 0}><p role="status">No eligible existing source hosts are available.</p></Show>
                  <button type="button" class="admin-secondary-button" disabled={sourceLoading() || busy()} onClick={() => void refreshSources()}>Refresh source hosts</button>
                </div>
              </Show>
            </div>
            <div class="operator-actions"><button type="submit" class="admin-primary-button" disabled={!sourceReady() || value().guidedMode === 'repository' && !value().configuredRepository}>Start assessment</button><a href="/operators" onClick={props.onBackToCatalog}>Back to operators</a></div></fieldset></form>
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
      <Show when={nativeSelection(value().inferenceSelection)}>{selection => <p>Inference: Pi built-in providers · {selection().provider} / {selection().model} · {nativeReasoningLabel(selection())}</p>}</Show>
      <Show when={value().authFailure}>{failure => <div role="alert"><p>Pi login required · {failure().provider}</p><p>{piLoginRecoveryCopy}</p></div>}</Show>
      <Show when={value().checkpoint != null}><h3>Progress</h3><pre class="operator-result">{JSON.stringify(value().checkpoint, null, 2)}</pre></Show>
      <Show when={value().result != null} fallback={<p>No result available.</p>}><h3>Result</h3><pre class="operator-result">{JSON.stringify(value().result, null, 2)}</pre></Show>
      <Show when={value().sessionId}><a href={`/app?session=${encodeURIComponent(value().sessionId!)}`}>Open owned session</a></Show>
      <OperatorActivityDiagnostics activityId={value().activityId} />
    </section>}</Show>
  </>;
};
export default OperatorManagementActivity;
