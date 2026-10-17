import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiDeveloperBoard, mdiClose, mdiMagnify } from '@mdi/js';
import Icon from './Icon';
import OperatorInstalled from './OperatorInstalled';
import OperatorActivityResult from './OperatorActivityResult';
import OperatorActivityDiagnostics from './OperatorActivityDiagnostics';
import { acknowledgeOperatorActivities, cancelOperatorActivity, getOperatorActivity, listOperatorActivities } from '../api/operator-activities';
import '../styles/operator-dropdown.css';

interface Props { enabled: boolean }
const workingStates = new Set(['queued', 'running', 'waiting', 'cancel-requested', 'unknown']);

/** REQ-OPERATOR-086: four nested views inside the existing anchored, owner-scoped dropdown. */
const OperatorActivityButton: Component<Props> = props => {
  const [open, setOpen] = createSignal(false);
  const [segment, setSegment] = createSignal<'Runs' | 'Installed'>('Runs');
  const [installedVisited, setInstalledVisited] = createSignal(false);
  const [locked, setLocked] = createSignal(false);
  const [cancelling, setCancelling] = createSignal<string>();
  const [actionMessage, setActionMessage] = createSignal('');
  const [loadError, setLoadError] = createSignal(false);
  const [loadedAt, setLoadedAt] = createSignal<number>();
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [previous, setPrevious] = createSignal<Array<string | null>>([]);
  const [search, setSearch] = createSignal('');
  const [operator, setOperator] = createSignal('');
  const [activities, { refetch }] = createResource(() => [props.enabled, cursor()] as const, async ([enabled, after]) => {
    if (!enabled) return { items: [], nextCursor: null, workingCount: 0, unreadCount: 0, latestSequence: 0 };
    try { const value = await listOperatorActivities(after); setLoadError(false); setLoadedAt(Date.now()); return value; }
    catch { setLoadError(true); return null; }
  });
  const [selected, setSelected] = createSignal<string | null>(null);
  const [diagnostics, setDiagnostics] = createSignal(false);
  const [detail, { refetch: refetchDetail }] = createResource(selected, async id => id ? getOperatorActivity(id) : null);
  const select = (id: string | null) => { setDiagnostics(false); setActionMessage(''); setSelected(id); };
  const nextPage = () => {
    const next = activities()?.nextCursor;
    if (!next) return;
    setPrevious(values => [...values, cursor()]); setCursor(next);
  };
  const newerPage = () => {
    const values = previous();
    if (!values.length) return;
    setPrevious(values.slice(0, -1)); setCursor(values[values.length - 1]);
  };
  const visible = createMemo(() => (activities()?.items ?? []).filter(item => (!operator() || item.operatorId === operator())
    && [item.operatorName, item.operatorId, item.context, item.activityId].some(value => value?.toLowerCase().includes(search().trim().toLowerCase()))));
  const operators = createMemo(() => [...new Map((activities()?.items ?? []).map(item => [item.operatorId, item.operatorName || item.operatorId])).entries()]);
  const working = createMemo(() => activities()?.workingCount ?? 0);
  const unread = createMemo(() => activities()?.unreadCount ?? 0);
  let control: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  const [position, setPosition] = createSignal({ top: 0, right: 0 });
  const [viewportWidth, setViewportWidth] = createSignal(window.innerWidth);
  let openedWidth = 0;
  const close = () => {
    if (locked()) return;
    const held = !!panel && !!document.activeElement && panel.contains(document.activeElement);
    setOpen(false); select(null); setCursor(null); setPrevious([]); setSearch(''); setOperator('');
    setSegment('Runs'); setInstalledVisited(false);
    if (held) trigger?.focus();
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && open()) close(); };
  const clickOutside = (event: MouseEvent) => {
    if (open() && event.target instanceof Node && !control?.contains(event.target) && !panel?.contains(event.target)) close();
  };
  const toggle = () => {
    if (open()) { close(); return; }
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
    openedWidth = window.innerWidth; setOpen(true);
    queueMicrotask(() => panel?.focus());
    void (async () => {
      const page = await refetch();
      if (!page?.unreadCount) return;
      try { await acknowledgeOperatorActivities(page.latestSequence); await refetch(); }
      catch { /* Failed acknowledgment must leave unread visible. */ }
    })();
  };
  const closeOnResize = () => {
    setViewportWidth(window.innerWidth);
    if (!open() || window.innerWidth === openedWidth) return;
    if (!locked()) close();
    else if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
  };
  onMount(() => {
    document.addEventListener('keydown', keydown); document.addEventListener('mousedown', clickOutside);
    window.addEventListener('resize', closeOnResize);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', keydown); document.removeEventListener('mousedown', clickOutside);
    window.removeEventListener('resize', closeOnResize);
  });
  const updatedDate = (value: string | number) => new Date(value);
  const stale = (value: string | number) => Date.now() - updatedDate(value).getTime() > 2 * 60_000;
  const cancel = async (id: string) => {
    setCancelling(id); setActionMessage('');
    try { await cancelOperatorActivity(id); await refetch(); }
    catch { setActionMessage('Cancellation not confirmed. Refresh before acting.'); }
    finally { setCancelling(undefined); }
  };
  const changeSegment = (value: 'Runs' | 'Installed') => {
    if (locked()) return;
    setSegment(value); if (value === 'Installed') setInstalledVisited(true);
  };
  const copyId = async () => {
    const id = selected(); if (!id) return;
    try { await navigator.clipboard.writeText(id); setActionMessage('Activity ID copied.'); }
    catch { setActionMessage('Copy unavailable. Select the full activity ID to copy it.'); }
  };
  return <Show when={props.enabled}>
    <div ref={control} class="operator-activity-control">
      <button ref={trigger} type="button" class="header-icon-button operator-activity-trigger" aria-label="Operator activity" aria-expanded={open()} onClick={toggle}>
        <Icon path={mdiDeveloperBoard} size={22} /><Show when={unread() > 0}><span class="operator-activity-badge">{unread()}</span></Show>
      </button>
      <Portal><Show when={open()}>
        <section ref={panel} class="operator-activity-panel operator-activity-panel--portal operator-dropdown" classList={{
          'operator-activity-panel--active': segment() === 'Installed' || working() > 0 || (activities()?.items.length ?? 0) > 1 || !!selected(),
          'operator-activity-panel--compact': segment() === 'Runs' && working() === 0 && (activities()?.items.length ?? 0) <= 1 && !selected(),
          'operator-activity-panel--empty': !activities.loading && !loadError() && !activities()?.items.length,
        }} style={viewportWidth() > 640 ? { top: `${position().top}px`, right: `${position().right}px` } : undefined}
          tabindex="-1" role="dialog" aria-label="Operator activity" aria-modal="false">
          <header><h2>Operators</h2><button type="button" class="header-icon-button" aria-label="Close operators" disabled={locked()} onClick={close}><Icon path={mdiClose} size={20} /></button></header>
          <div class="operator-dropdown-segments" role="tablist" aria-label="Operator views">
            <For each={['Runs', 'Installed'] as const}>{name => <button type="button" role="tab" aria-selected={segment() === name}
              aria-controls={`operator-${name.toLowerCase()}-panel`} id={`operator-${name.toLowerCase()}-tab`}
              tabindex={segment() === name ? 0 : -1} disabled={locked()} onClick={() => changeSegment(name)}
              onKeyDown={event => { if (!locked() && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); const target = event.key === 'Home' ? 'Runs' : event.key === 'End' ? 'Installed' : name === 'Runs' ? 'Installed' : 'Runs';
                changeSegment(target); document.getElementById(`operator-${target.toLowerCase()}-tab`)?.focus();
              } }}>{name}</button>}</For>
          </div>
          <div id="operator-runs-panel" role="tabpanel" aria-labelledby="operator-runs-tab" hidden={segment() !== 'Runs'} class="operator-dropdown-view">
            <Show when={selected()} fallback={<>
              <div class="operator-run-filters"><label class="operator-run-search"><Icon path={mdiMagnify} size={18} /><input type="search" aria-label="Find a run" placeholder="Find a run…" value={search()} onInput={event => setSearch(event.currentTarget.value)} /></label>
                <div class="operator-dropdown-heading"><h3>Recent runs</h3><select aria-label="Filter runs by operator" value={operator()} onChange={event => setOperator(event.currentTarget.value)}><option value="">All operators</option><For each={operators()}>{entry => <option value={entry[0]}>{entry[1]}</option>}</For></select></div>
                <small class="operator-dropdown-muted">Search and filter apply to the current page.</small></div>
              <Show when={!activities.loading} fallback={<div class="operator-activity-state">Loading activity…</div>}>
                <Show when={!loadError()} fallback={<div class="operator-activity-state"><strong>Activity unavailable</strong><span>Last known state cannot be treated as current.</span><button type="button" onClick={() => void refetch()}>Retry</button><Show when={cursor()}><button type="button" onClick={() => { setPrevious([]); setCursor(null); }}>Return to newest</button></Show></div>}>
                  <div class="operator-activity-list"><Show when={visible().length} fallback={<p class="operator-activity-state">{activities()?.items.length ? 'No matching runs' : 'No activity'}</p>}>
                    <For each={visible()}>{item => <article class="operator-activity-item">
                      <div><strong>{item.operatorName || item.operatorId}</strong><span class="operator-run-status" data-status={item.executionStatus}>{item.executionStatus}</span></div>
                      <div><Show when={item.context || item.source}><p>{item.context || item.source}</p></Show><Show when={item.version}><small>{item.version}</small></Show></div>
                      <small>Updated {updatedDate(item.updatedAt).toLocaleString()}<Show when={stale(item.updatedAt) && workingStates.has(item.executionStatus)}> · Last observation may be stale</Show></small>
                      <Show when={item.resultSummary} fallback={<small>Outcome details unavailable</small>}>{counts => <div class="operator-run-outcomes"><span>{counts().merged} merged</span><span>{counts().notMerged} not merged</span><Show when={counts().deferred}><span>{counts().deferred} deferred</span></Show><Show when={counts().unknown}><span>{counts().unknown} unknown</span></Show></div>}</Show>
                      <Show when={item.progress}><p>{item.progress}</p></Show><Show when={item.attention}><span class="operator-activity-attention">Needs attention</span></Show>
                      <nav><button type="button" aria-label={`View ${item.activityId}`} onClick={() => select(item.activityId)}>View details</button><Show when={item.sessionId}>{id => <a href={`/app?session=${encodeURIComponent(id())}`}>Open session</a>}</Show>
                        <Show when={workingStates.has(item.executionStatus) && item.executionStatus !== 'unknown'}><button type="button" disabled={cancelling() === item.activityId} aria-label={`Cancel ${item.activityId}`} onClick={() => void cancel(item.activityId)}>Cancel</button></Show></nav>
                    </article>}</For>
                  </Show></div>
                  <nav class="operator-activity-pages"><Show when={previous().length}><button type="button" onClick={newerPage}>Newer 5</button></Show><Show when={activities()?.nextCursor}><button type="button" onClick={nextPage}>Load next 5</button></Show></nav>
                </Show>
              </Show>
            </>}>
              <div class="operator-dropdown-body"><button type="button" onClick={() => select(null)}>Back to activities</button>
                <Show when={!detail.loading} fallback={<p>Loading activity detail…</p>}><Show when={!detail.error && detail()} fallback={<div role="alert">Activity detail unavailable<button type="button" onClick={() => void refetchDetail()}>Retry detail</button></div>}>
                  {value => <div class="operator-activity-detail"><h3>{value().operatorName || value().operatorId}</h3><Show when={value().context}><p>{value().context}</p></Show>
                    <Show when={value().version}><p>Version: {value().version}</p></Show><p>Execution: {value().executionStatus}</p>
                    <h4>Result</h4><Show when={value().result != null} fallback={<p>{value().executionStatus === 'unknown' ? 'Outcome unknown' : value().executionStatus === 'failed' ? 'Activity failed without a result' : value().executionStatus === 'completed' ? 'Result unavailable' : 'Result pending'}</p>}><OperatorActivityResult result={value().result} /></Show>
                    <div class="operator-run-metadata"><p>Cleanup: {value().cleanupStatus === 'released' ? 'SDK release confirmed' : value().cleanupStatus}</p><p>Collection: {value().collectionStatus}</p>
                      <Show when={value().attention}><p class="operator-activity-attention">Needs attention</p></Show><Show when={value().progress}><p>Progress: {value().progress}</p></Show><Show when={value().checkpoint != null}><p>Checkpoint saved. Work may still be in progress.</p></Show>
                      <p>Activity ID: <span class="operator-full-id">{value().activityId}</span></p><button type="button" onClick={() => void copyId()}>Copy activity ID</button>
                      <small>Updated {updatedDate(value().updatedAt).toLocaleString()}<Show when={stale(value().updatedAt) && workingStates.has(value().executionStatus)}> · Last observation may be stale</Show></small></div>
                    <button type="button" aria-expanded={diagnostics()} onClick={() => setDiagnostics(value => !value)}>{diagnostics() ? 'Hide diagnostics' : 'View diagnostics'}</button><Show when={diagnostics()}><OperatorActivityDiagnostics activityId={value().activityId} /></Show>
                  </div>}
                </Show></Show>
              </div>
            </Show>
          </div>
          <Show when={installedVisited()}><div id="operator-installed-panel" role="tabpanel" aria-labelledby="operator-installed-tab" hidden={segment() !== 'Installed'} class="operator-dropdown-view">
            <OperatorInstalled locked={setLocked} opened={id => { select(id); setSegment('Runs'); void refetch(); }} />
          </div></Show>
          <Show when={actionMessage()}><p class="operator-dropdown-notice" role="status">{actionMessage()}</p></Show>
          <footer><small>{loadError() ? 'Update unavailable' : loadedAt() ? `Updated ${new Date(loadedAt()!).toLocaleTimeString()}` : 'Waiting for update'}</small><button type="button" aria-label="Refresh runs" disabled={locked()} onClick={() => { void refetch(); if (selected()) void refetchDetail(); }}>Refresh</button></footer>
        </section>
      </Show></Portal>
    </div>
  </Show>;
};
export default OperatorActivityButton;
