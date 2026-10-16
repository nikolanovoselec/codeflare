import { For, Show, createResource, createSignal, onCleanup, type Component } from 'solid-js';
import { ApiError } from '../api/fetch-helper';
import { configureInstallation, getInstallationActivityPreview, getManagedOperator, getOwnedActivity,
  listOperatorInstallations, prepareInstallationActivity, startInstallationActivity, type InstalledOperator } from '../api/operator-management';

interface Props { locked: (value: boolean) => void; opened: (id: string) => void }
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** REQ-OPERATOR-086 AC7: explicit, revision-checked scheduling; no implicit enable or launch. */
const Scheduling: Component<{ item: InstalledOperator; saved: (message: string) => void }> = props => {
  const [automatic, setAutomatic] = createSignal(props.item.automaticRuns === true);
  const [interval, setInterval] = createSignal(props.item.repetitionIntervalSeconds ?? 3600);
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const save = async () => {
    if (pending() || !props.item.canManage || !Number.isSafeInteger(interval()) || interval() < 1) return;
    setPending(true); setMessage('');
    try {
      const detail = await getManagedOperator(props.item.operatorId);
      const current = detail.installations.find(item => item.id === props.item.id);
      if (!current || current.revision !== props.item.revision) throw new ApiError('Revision changed', 409, 'Conflict');
      const configuration = current.configuration ?? {};
      const renovate = configuration.renovate;
      if (!renovate || typeof renovate !== 'object' || Array.isArray(renovate)) throw new Error('Configuration unavailable');
      await configureInstallation(current.id, { revision: current.revision, policy: current.policy,
        configuration: { ...configuration, renovate: { ...renovate, automaticRuns: automatic(), repetitionIntervalSeconds: interval() } } });
      props.saved('Scheduling saved. Installation is disabled; enable it through management when ready.');
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409 ? 'Installation revision changed. Refresh before saving again.'
        : 'Scheduling save not confirmed. Refresh before acting.');
    } finally { setPending(false); }
  };
  return <div class="operator-scheduling">
    <label><input type="checkbox" checked={automatic()} disabled={pending()} onChange={event => setAutomatic(event.currentTarget.checked)} /> Automatic runs</label>
    <Show when={automatic()}><label>Interval (seconds)<input type="number" min="1" step="1" value={interval()}
      disabled={pending()} onInput={event => setInterval(event.currentTarget.valueAsNumber)} /></label></Show>
    <Show when={automatic() !== props.item.automaticRuns || interval() !== props.item.repetitionIntervalSeconds}>
      <small>Saving scheduling disables this installation. It does not start a run.</small>
      <button type="button" disabled={pending() || !Number.isSafeInteger(interval()) || interval() < 1} onClick={() => void save()}>Save scheduling</button>
    </Show>
    <Show when={message()}><p role="status">{message()}</p></Show>
  </div>;
};

/** Capabilities stay in this request's closure, never in markup or persistent UI state. */
const ManualRun: Component<Props & { item: InstalledOperator; back: () => void }> = props => {
  const [preview] = createResource(() => props.item.id, getInstallationActivityPreview);
  const [repository, setRepository] = createSignal('');
  const [pullRequest, setPullRequest] = createSignal<number>(NaN);
  const [attempted, setAttempted] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [preparedId, setPreparedId] = createSignal<string>();
  const [observed, setObserved] = createSignal<string>();
  const valid = () => {
    const value = preview();
    const repo = value?.guidedMode === 'repository' ? value.configuredRepository : repository();
    return !!value?.guidedAssessment && !!repo && repo.length <= 201 && repositoryPattern.test(repo)
      && (value.guidedMode === 'repository' || value.guidedMode === 'legacy-pull-request' && Number.isSafeInteger(pullRequest()) && pullRequest() > 0);
  };
  const inspect = async () => {
    const id = preparedId();
    if (!id || pending()) return;
    setPending(true);
    try {
      const detail = await getOwnedActivity(id);
      if (detail.activityId !== id) throw new Error('Foreign activity');
      if (detail.executionStatus === 'unknown') {
        setMessage(`Activity ${id}: outcome unknown. Keep inspecting this exact activity; no new run is authorized.`);
        return;
      }
      setObserved(detail.executionStatus); setMessage(`Activity ${id}: ${detail.executionStatus}. No new run was started.`);
      props.locked(false);
    } catch { setMessage('Prepared activity unavailable. Inspect this same activity again; do not start another run.'); }
    finally { setPending(false); }
  };
  const start = async () => {
    if (attempted() || pending() || !valid()) return;
    setAttempted(true); setPending(true); props.locked(true); setMessage('');
    try {
      const value = preview()!;
      const invocation = value.guidedMode === 'repository' ? { repository: value.configuredRepository! }
        : { repository: repository(), pullRequest: pullRequest() };
      const prepared = await prepareInstallationActivity(props.item.id, invocation);
      setPreparedId(prepared.activityId);
      try {
        await startInstallationActivity(prepared.activityId, prepared.startCapability);
        props.locked(false); props.opened(prepared.activityId);
      } catch { setMessage('Start response uncertain. Inspect the prepared activity before any further action.'); }
    } catch {
      setMessage('Preparation not confirmed. No known activity can authorize a retry. Refresh installations before a new review.');
      props.locked(false);
    } finally { setPending(false); }
  };
  return <div class="operator-dropdown-body operator-manual-review">
    <button type="button" disabled={pending() || !!preparedId() && !observed()} onClick={props.back}>Back to installed operators</button>
    <h3>Start a manual run</h3>
    <p>Review one invocation. Automatic scheduling is a separate setting.</p>
    <Show when={!preview.loading} fallback={<p role="status">Loading invocation…</p>}>
      <Show when={!preview.error && preview()?.guidedAssessment} fallback={<p role="alert">Installation invocation unavailable. Return to Installed and refresh.</p>}>
        <h4>{preview()?.name}</h4><p>{preview()?.version} · {props.item.installationName}</p>
        <label>Repository<input type="text" value={preview()?.guidedMode === 'repository' ? preview()?.configuredRepository ?? '' : repository()}
          readOnly={preview()?.guidedMode === 'repository'} disabled={attempted()} maxLength={201}
          onInput={event => setRepository(event.currentTarget.value)} /></label>
        <Show when={preview()?.guidedMode === 'legacy-pull-request'}><label>Pull request number<input type="number" min="1" step="1"
          disabled={attempted()} onInput={event => setPullRequest(event.currentTarget.valueAsNumber)} /></label></Show>
        <p class="operator-effect-notice">{preview()?.guidedMode === 'repository'
          ? 'This run may post assessments and merge eligible pull requests under the installed policy.'
          : 'This is a read-only assessment. It will not merge or post comments.'}</p>
        <p>Automatic runs: {props.item.automaticRuns === true ? 'on' : props.item.automaticRuns === false ? 'off' : 'not configurable'} — unchanged by this run.</p>
        <p>The current installation permissions and revision are checked again at preparation and start.</p>
        <div class="operator-dropdown-actions"><button type="button" disabled={pending() || !!preparedId() && !observed()} onClick={props.back}>Cancel</button>
          <button type="button" class="operator-primary-action" disabled={attempted() || !valid()} onClick={() => void start()}>{pending() ? 'Starting…' : 'Start one run'}</button></div>
      </Show>
    </Show>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <Show when={preparedId() && !observed() && !pending()}><button type="button" onClick={() => void inspect()}>Inspect prepared activity</button></Show>
    <Show when={observed()}><button type="button" onClick={() => props.opened(preparedId()!)}>View prepared activity</button></Show>
  </div>;
};

const OperatorInstalled: Component<Props> = props => {
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [previous, setPrevious] = createSignal<Array<string | null>>([]);
  const [page, { refetch }] = createResource(() => ({ cursor: cursor() }), value => listOperatorInstallations(value.cursor));
  const current = () => page();
  const loading = () => page.loading;
  const error = () => page.error;
  const refresh = () => { void refetch(); };
  const [notice, setNotice] = createSignal('');
  const [selected, setSelected] = createSignal<InstalledOperator>();
  onCleanup(() => props.locked(false));
  return <Show when={selected()} fallback={<div class="operator-dropdown-body">
    <div class="operator-dropdown-heading"><h3>Installed operators</h3><button type="button" onClick={refresh}>Refresh installations</button></div>
    <p class="operator-dropdown-muted">Run once when needed. Automatic runs are optional and configured separately.</p>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={!loading()} fallback={<p role="status">Loading installations…</p>}>
      <Show when={!error()} fallback={<div role="alert"><strong>Installations unavailable</strong><p>Readiness cannot be treated as current.</p><button type="button" onClick={refresh}>Retry installations</button></div>}>
        <Show when={current()?.items.length} fallback={<p>No installed operators on this page.</p>}>
          <For each={current()?.items}>{item => <article class="operator-installed-item" aria-label={item.installationName}>
            <div class="operator-dropdown-heading"><h4>{item.name}</h4><span>{item.version ?? 'Version unavailable'}</span></div>
            <p>{item.installationName}</p><Show when={item.repository}><p>{item.repository}</p></Show>
            <p>{!item.approved ? 'Approval required' : !item.enabled ? 'Disabled' : 'Enabled'} · {item.guidedMode ? 'Manual run supported' : 'Manual input not supported here'}</p>
            <button type="button" disabled={!item.canInvoke || !item.enabled || !item.approved || !item.guidedMode}
              onClick={() => { if (item.canInvoke && item.enabled && item.approved && item.guidedMode) setSelected(item); }}>Run manually</button>
            <Show when={!item.canInvoke}><small>Invocation permission required. Management access does not grant invocation.</small></Show>
            <Show when={item.automaticRuns !== null} fallback={<p>Automatic runs: <strong>Not configurable</strong></p>}>
              <Show when={item.canManage} fallback={<p>Automatic runs: {item.automaticRuns ? 'on' : 'off'}. Management permission required to change scheduling.</p>}>
                <Scheduling item={item} saved={message => { setNotice(message); refresh(); }} />
              </Show>
            </Show>
            <Show when={!item.canManage && item.automaticRuns === null}><small>Management permission required to configure installations.</small></Show>
          </article>}</For>
        </Show>
        <nav class="operator-activity-pages" aria-label="Installation pages">
          <Show when={previous().length}><button type="button" onClick={() => { const values = previous(); setCursor(values[values.length - 1]); setPrevious(values.slice(0, -1)); }}>Newer installations</button></Show>
          <Show when={current()?.cursor}><button type="button" onClick={() => { setPrevious(values => [...values, cursor()]); setCursor(current()!.cursor); }}>More installations</button></Show>
        </nav>
      </Show>
    </Show>
  </div>}>
    {item => <ManualRun {...props} item={item()} opened={id => { setSelected(undefined); props.opened(id); }} back={() => setSelected(undefined)} />}
  </Show>;
};
export default OperatorInstalled;
