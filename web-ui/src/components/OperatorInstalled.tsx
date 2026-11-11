import { For, Show, createEffect, createMemo, createResource, createSignal, createUniqueId, onCleanup, type Component } from 'solid-js';
import { mdiChevronLeft, mdiMagnify } from '@mdi/js';
import Icon from './Icon';
import OperatorActivityPages from './OperatorActivityPages';
import { ApiError } from '../api/fetch-helper';
import { sessionStore } from '../stores/session';
import { activateRenovateRuns } from '../api/operator-activities';
import { configureInstallation, getInstallationActivityPreview, getManagedOperator, getOwnedActivity,
  listOperatorInstallations, prepareInstallationActivity, startInstallationActivity, type InstalledOperator } from '../api/operator-management';

interface Props { locked: (value: boolean) => void; opened: (id: string) => void }
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Explicit role disclosure, using the incumbent Vault click/tap interaction, not its timers. */
const RoleHelp: Component<{ profile: InstalledOperator['profile'] }> = props => {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ left: 12, top: 12, width: Math.min(288, window.innerWidth - 24) });
  let wrap: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;
  let note: HTMLDivElement | undefined;
  const role = () => props.profile === 'dispatcher' ? 'Dispatcher' : 'Conductor';
  const place = () => {
    if (!button || !open()) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 24);
    const height = note?.getBoundingClientRect().height ?? 0;
    const below = rect.bottom + 8;
    setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: Math.max(12, below + height <= window.innerHeight - 12 ? below : rect.top - height - 8) });
  };
  createEffect(() => {
    if (!open()) return;
    queueMicrotask(place);
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !wrap?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture before the containing dropdown's document listener.
      event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); button?.focus();
    };
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    onCleanup(() => {
      document.removeEventListener('click', outside, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    });
  });
  return <div ref={wrap} class="operator-role">
    <button ref={button} type="button" class="operator-role-button" aria-label={`About ${role()}`}
      aria-expanded={open()} aria-controls={id} aria-describedby={open() ? id : undefined}
      onClick={() => { setOpen(value => !value); button?.focus(); }}>{props.profile === 'dispatcher' ? 'D' : 'C'}</button>
    <Show when={open()}><div ref={note} id={id} role="note" class="operator-role-help"
      style={{ left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }}>
      <strong>{role()}</strong>
      <p>{props.profile === 'dispatcher'
        ? 'Works on the configured repository. May post assessment comments and merge eligible pull requests only when the installed package policy and permissions allow it.'
        : 'Coordinates pull request reviews under the installed package policy and permissions. Available actions depend on the installed package.'}</p>
    </div></Show>
  </div>;
};

const intervalUnits = { seconds: 1, minutes: 60, hours: 3600 } as const;
type IntervalUnit = keyof typeof intervalUnits;

/** REQ-OPERATOR-209: saved settings and current-scope acknowledgements are not schedule status. */
const Scheduling: Component<{ item: InstalledOperator; saved: (message: string) => void }> = props => {
  const configId = createUniqueId(), feedbackId = createUniqueId(), reasonId = createUniqueId(), validationId = createUniqueId();
  const initialSeconds = props.item.repetitionIntervalSeconds ?? 3600;
  const initialUnit: IntervalUnit = initialSeconds % 3600 === 0 ? 'hours' : initialSeconds % 60 === 0 ? 'minutes' : 'seconds';
  const [expanded, setExpanded] = createSignal(false);
  const [automatic, setAutomatic] = createSignal(props.item.automaticRuns === true);
  const [unit, setUnit] = createSignal<IntervalUnit>(initialUnit);
  const [quantity, setQuantity] = createSignal(initialSeconds / intervalUnits[initialUnit]);
  const interval = () => quantity() * intervalUnits[unit()];
  const validInterval = () => Number.isSafeInteger(quantity()) && quantity() > 0
    && Number.isSafeInteger(interval()) && interval() > 0
    && Number.isFinite(new Date(Date.now() + interval() * 1000).getTime());
  const dirty = () => automatic() !== props.item.automaticRuns || interval() !== props.item.repetitionIntervalSeconds;
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [saveUnconfirmed, setSaveUnconfirmed] = createSignal(false);
  const [activationPending, setActivationPending] = createSignal(false);
  const [activationMessage, setActivationMessage] = createSignal('');
  let alive = true, epoch = 0;
  const session = () => sessionStore.getActiveSession();
  const activationSession = () => {
    const current = session();
    return !sessionStore.statusUnavailable && current?.status === 'running'
      && (current.lifecycle === undefined || current.lifecycle === 'running')
      && /^[a-z0-9]{8,24}$/.test(current.id) && Number.isSafeInteger(current.generation) && current.generation! > 0 ? current : undefined;
  };
  const scope = createMemo(() => JSON.stringify([props.item.id, props.item.operatorId, props.item.revision,
    props.item.profile, props.item.canActivateAutomaticRuns, props.item.canInvoke, props.item.enabled,
    props.item.approved, props.item.guidedMode, props.item.repository, props.item.automaticRuns,
    props.item.repetitionIntervalSeconds, session()?.id, session()?.generation, session()?.status,
    session()?.lifecycle, sessionStore.statusUnavailable, dirty(), pending(), saveUnconfirmed()]));
  createEffect(() => {
    scope(); epoch++; setActivationPending(false); setActivationMessage('');
  });
  onCleanup(() => { alive = false; epoch++; });
  const prerequisite = () => {
    if (pending()) return 'Scheduling save pending. Wait for confirmation before activating.';
    if (saveUnconfirmed()) return 'Refresh installations before acting on the unconfirmed save.';
    if (dirty()) return 'Unsaved scheduling changes. Save before activating.';
    if (!props.item.approved) return 'Installation approval required before activation.';
    if (!props.item.enabled) return 'Enable this installation through management before activation.';
    if (!props.item.canInvoke) return 'Invocation permission required. Management access does not grant invocation.';
    if (props.item.automaticRuns !== true) return 'Automatic runs are off. Configure and save them before activation.';
    if (!props.item.canActivateAutomaticRuns) return 'Admin activation eligibility could not be confirmed for this installation.';
    if (props.item.profile !== 'dispatcher' || props.item.guidedMode !== 'repository' || !validInterval()
      || !props.item.repository || !repositoryPattern.test(props.item.repository)
      || props.item.repository.split('/').some(part => part === '.' || part === '..')) return 'Saved automatic configuration is unavailable. Review it in management.';
    if (!activationSession()) return 'Open an available running workspace session with a verified generation before activating.';
    return '';
  };
  const activate = async () => {
    if (activationPending() || prerequisite()) return;
    const currentSession = activationSession()!;
    const capturedScope = scope(), capturedEpoch = ++epoch;
    setActivationPending(true); setActivationMessage('');
    const current = () => alive && capturedEpoch === epoch && capturedScope === scope();
    try {
      const result = await activateRenovateRuns({ installationId: props.item.id,
        sessionId: currentSession.id, sessionGeneration: currentSession.generation! });
      if (current()) setActivationMessage(`Activation acknowledged for this installation revision and session. Original activation cutoff: ${result.activatedAt}. Authority ends at the original Access expiry; this is not proof of future execution.`);
    } catch {
      if (current()) setActivationMessage('Activation not confirmed. Check this session and installation before explicitly trying again. No automatic retry occurs.');
    } finally { if (current()) setActivationPending(false); }
  };
  const save = async () => {
    if (pending() || activationPending() || saveUnconfirmed() || !props.item.canManage || !dirty() || !validInterval()) return;
    const item = props.item;
    const seconds = interval(), automaticRuns = automatic();
    const currentScope = () => alive && props.item.id === item.id && props.item.revision === item.revision && props.item.canManage;
    setPending(true); setMessage('');
    try {
      const detail = await getManagedOperator(item.operatorId);
      if (!currentScope()) return;
      const current = detail.installations.find(value => value.id === item.id);
      if (!current || current.revision !== item.revision) throw new ApiError('Revision changed', 409, 'Conflict');
      const configuration = current.configuration ?? {};
      const renovate = configuration.renovate;
      if (!renovate || typeof renovate !== 'object' || Array.isArray(renovate)) throw new Error('Configuration unavailable');
      await configureInstallation(current.id, { revision: current.revision, policy: current.policy,
        configuration: { ...configuration, renovate: { ...renovate, automaticRuns, repetitionIntervalSeconds: seconds } } });
      if (currentScope()) props.saved('Scheduling saved. Installation is disabled; enable it through management when ready. Activation is separate.');
    } catch (error) {
      if (currentScope()) {
        setSaveUnconfirmed(true);
        setMessage(error instanceof ApiError && error.status === 409 ? 'Installation revision changed. Refresh before saving again.'
          : 'Scheduling save not confirmed. Refresh before acting.');
      }
    } finally { if (currentScope()) setPending(false); }
  };
  return <section class="operator-scheduling" aria-label="Automatic runs">
    <div class="operator-dropdown-heading"><span>Automatic runs: {props.item.automaticRuns ? 'saved on' : 'off'}</span>
      <Show when={props.item.canManage}><button type="button" aria-expanded={expanded()} aria-controls={configId}
        onClick={() => setExpanded(value => !value)}>Configure</button></Show>
    </div>
    <Show when={!props.item.canManage}><p>Management permission required to change scheduling.</p></Show>
    <Show when={props.item.canManage && expanded()}><div id={configId} class="operator-scheduling-fields">
      <label><input type="checkbox" checked={automatic()} disabled={pending() || activationPending() || saveUnconfirmed()}
        onChange={event => setAutomatic(event.currentTarget.checked)} /> Automatic runs</label>
      <div class="operator-interval">
        <label>Repeat interval<input type="number" min="1" step="1" value={quantity()} aria-invalid={!validInterval()}
          aria-describedby={!validInterval() ? validationId : undefined} disabled={pending() || activationPending() || saveUnconfirmed()}
          onInput={event => setQuantity(event.currentTarget.valueAsNumber)} /></label>
        <label>Interval unit<select value={unit()} disabled={pending() || activationPending() || saveUnconfirmed()}
          onChange={event => setUnit(event.currentTarget.value as IntervalUnit)}>
          <For each={Object.keys(intervalUnits) as IntervalUnit[]}>{value => <option value={value}>{value}</option>}</For>
        </select></label>
      </div>
      <Show when={!validInterval()}><p id={validationId} role="alert">Enter a valid interval: positive whole seconds within the supported range.</p></Show>
      <Show when={dirty()}><small>Saving scheduling disables this installation. It does not start a run.</small>
        <button type="button" disabled={pending() || activationPending() || saveUnconfirmed() || !validInterval()} onClick={() => void save()}>Save scheduling</button>
      </Show>
      <Show when={message()}><p role="status">{message()}</p></Show>
    </div></Show>
    <p id={feedbackId} role="status">{activationPending() ? 'Activating…' : activationMessage() || 'Activation unverified for this session and installation revision.'}</p>
    <Show when={prerequisite()}><p id={reasonId}>{prerequisite()}</p></Show>
    <button type="button" class="operator-activate" disabled={activationPending() || !!prerequisite()}
      aria-describedby={`${feedbackId}${prerequisite() ? ` ${reasonId}` : ''}`} onClick={() => void activate()}>Activate</button>
  </section>;
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
      const source = sessionStore.getActiveSession();
      const prepared = source?.generation && source.status === 'running'
        ? await prepareInstallationActivity(props.item.id, invocation, { sessionId: source.id, sessionGeneration: source.generation })
        : await prepareInstallationActivity(props.item.id, invocation);
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
    <button type="button" class="operator-back-action" disabled={pending() || !!preparedId() && !observed()} onClick={props.back}><Icon path={mdiChevronLeft} size={18} aria-hidden="true" />Back to installed operators</button>
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
  const [search, setSearch] = createSignal('');
  const [page, { refetch }] = createResource(() => ({ cursor: cursor() }), value => listOperatorInstallations(value.cursor));
  const current = () => page();
  const visible = () => {
    const query = search().trim().toLowerCase();
    return (current()?.items ?? []).filter(item => [item.name, item.installationName, item.repository]
      .some(value => value?.toLowerCase().includes(query)));
  };
  const loading = () => page.loading;
  const error = () => page.error;
  const refresh = () => { void refetch(); };
  const [notice, setNotice] = createSignal('');
  const [selected, setSelected] = createSignal<InstalledOperator>();
  onCleanup(() => props.locked(false));
  return <Show when={selected()} fallback={<div class="operator-dropdown-body">
    <div class="operator-dropdown-heading"><h3>Installed operators</h3><button type="button" onClick={refresh}>Refresh installations</button></div>
    <p class="operator-dropdown-muted">Run once when needed. Automatic runs are optional and configured separately.</p>
    <label class="operator-run-search"><Icon path={mdiMagnify} size={18} aria-hidden="true" /><input type="search" aria-label="Find an installed operator" placeholder="Find an installed operator…" value={search()}
      onInput={event => setSearch(event.currentTarget.value)} /></label>
    <small class="operator-dropdown-muted">Search applies to the current page.</small>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={!loading()} fallback={<p role="status">Loading installations…</p>}>
      <Show when={!error()} fallback={<div role="alert"><strong>Installations unavailable</strong><p>Readiness cannot be treated as current.</p><button type="button" onClick={refresh}>Retry installations</button></div>}>
        <Show when={visible().length} fallback={<p>{current()?.items.length ? 'No matching installed operators on this page.' : 'No installed operators on this page.'}</p>}>
          <For each={visible()}>{item => <article class="operator-installed-item" aria-label={item.installationName}>
            <header class="operator-installed-header">
              <RoleHelp profile={item.profile} />
              <div class="operator-installed-identity"><div class="operator-dropdown-heading"><h4>{item.name}</h4><span>{item.version ?? 'Version unavailable'}</span></div>
                <p>{item.installationName}</p><Show when={item.repository}><p>{item.repository}</p></Show>
                <p>{!item.approved ? 'Approval required' : !item.enabled ? 'Disabled' : 'Enabled'}</p>
              </div>
            </header>
            <Show when={item.automaticRuns !== null} fallback={<p>Automatic runs: <strong>Not configurable</strong></p>}>
              <Scheduling item={item} saved={message => { setNotice(message); refresh(); }} />
            </Show>
            <footer class="operator-installed-manual">
              <span>{item.guidedMode ? 'Review one invocation' : 'Manual input not supported here'}</span>
              <Show when={item.guidedMode}>
                <button type="button" class="operator-primary-action" disabled={!item.canInvoke || !item.enabled || !item.approved}
                  onClick={() => { if (item.canInvoke && item.enabled && item.approved && item.guidedMode) setSelected(item); }}>Run once</button>
              </Show>
            </footer>
            <Show when={!item.canInvoke && item.automaticRuns === null}><small>Invocation permission required. Management access does not grant invocation.</small></Show>
            <Show when={!item.canManage && item.automaticRuns === null}><small>Management permission required to configure installations.</small></Show>
          </article>}</For>
        </Show>
        <OperatorActivityPages label="Installation pages" hasNewer={previous().length > 0} hasNext={!!current()?.cursor}
          onNewer={() => { const values = previous(); setCursor(values[values.length - 1]); setPrevious(values.slice(0, -1)); }}
          onNext={() => { setPrevious(values => [...values, cursor()]); setCursor(current()!.cursor); }} />
        <Show when={current()?.items.some(item => item.canManage)}>
          <footer><a href="/operators">Manage installations</a></footer>
        </Show>
      </Show>
    </Show>
  </div>}>
    {item => <ManualRun {...props} item={item()} opened={id => { setSelected(undefined); props.opened(id); }} back={() => setSelected(undefined)} />}
  </Show>;
};
export default OperatorInstalled;
