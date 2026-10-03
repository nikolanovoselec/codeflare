import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiDeveloperBoard } from '@mdi/js';
import Icon from './Icon';
import { acknowledgeOperatorActivities, cancelOperatorActivity, getOperatorActivity, listOperatorActivities } from '../api/operator-activities';

interface Props { enabled: boolean }
const workingStates = new Set(['queued', 'running', 'waiting', 'cancel-requested', 'unknown']);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const readable = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 1000 && !/[\p{Cc}]/u.test(value) ? value : null;
const unavailableEvidence = 'Content unavailable (not safely readable)';

/** Present only understood, bounded report fields; never stringify an opaque result payload. */
function resultView(result: unknown) {
  const data = record(result);
  if (!data) return <p>Result format unavailable. Check the activity status before acting.</p>;
  if (readable(data.repository) && Array.isArray(data.results) && data.results.length <= 1024) {
    return <div class="operator-activity-reports">
      <h5>Dispatcher discovery</h5><p>Repository: {readable(data.repository)}</p>
      <Show when={data.results.length} fallback={<p>No eligible pull requests discovered.</p>}>
        <For each={data.results}>{value => {
          const item = record(value);
          return <article>
            <p>{typeof item?.pullRequest === 'number' && Number.isSafeInteger(item.pullRequest) && item.pullRequest > 0
              ? `PR #${item.pullRequest}` : unavailableEvidence}</p>
            <p>Decision: {readable(item?.decision) || unavailableEvidence}</p>
            <p>Outcome: {readable(item?.outcome) || unavailableEvidence}</p>
            <Show when={item?.comment !== undefined}><p>{readable(item?.comment) || unavailableEvidence}</p></Show>
          </article>;
        }}</For>
      </Show>
    </div>;
  }
  // Published Review packages retain their original lane reports under originalReports;
  // the older native Conductor fixture returns reports directly. Both are terminal bytes.
  const reportBytes = Array.isArray(data.originalReports) ? data.originalReports : data.reports;
  if (Array.isArray(reportBytes)) {
    const reports = reportBytes.map(record).filter((item): item is Record<string, unknown> => item !== null);
    const history = record(data.history);
    const presentation = record(data.presentation);
    const check = record(presentation?.check);
    return <div class="operator-activity-reports">
      <Show when={data.status === 'incomplete' || history?.clear === false || reports.some(item => item.complete === false)
        || (reports.length === 0 && data.status !== 'complete')}><p>Review reports incomplete. Do not treat this as an all-clear.</p></Show>
      <Show when={readable(check?.summary)}>{text => <p>Review: {text()}</p>}</Show>
      <Show when={check?.conclusion === 'failure'}><p>Review check failed. Findings require attention.</p></Show>
      <For each={reports}>{report => <section>
        <h5>{typeof report.lane === 'string' ? readable(report.lane) || unavailableEvidence : 'Review lane'}</h5>
        <p>{report.complete === true ? 'Report complete' : report.complete === false ? 'Report incomplete' : 'Original report'} · {Array.isArray(report.findings) ? report.findings.length : 0} findings</p>
        <For each={Array.isArray(report.omissions) ? report.omissions : []}>{omission =>
          <p>Missing: {readable(omission) || unavailableEvidence}</p>}</For>
        <For each={Array.isArray(report.findings) ? report.findings : []}>{finding => {
          const entry = record(finding);
          if (!entry) return <article><strong>{unavailableEvidence}</strong></article>;
          return <article><strong>{readable(entry.title) || readable(entry.message) || unavailableEvidence}</strong>
            <Show when={typeof entry.severity === 'string'}><span> · {readable(entry.severity) || unavailableEvidence}</span></Show>
            <Show when={typeof entry.summary === 'string' || typeof entry.description === 'string'}>
              <p>{readable(entry.summary) || readable(entry.description) || unavailableEvidence}</p>
            </Show>
          </article>;
        }}</For>
      </section>}</For>
      <Show when={readable(data.cleanup)}>{text => <p>Reported cleanup: {text()}</p>}</Show>
    </div>;
  }
  // The compiled Dispatcher keeps its compatibility decision inside assessment;
  // its older read-only evidence projection is handled separately below.
  const assessment = record(data.assessment);
  if (assessment) {
    const classification = assessment.classification;
    const compatibility = readable(assessment.compatibility);
    const reasons = assessment.reasons;
    const gaps = assessment.gaps;
    const citations = assessment.citations;
    if (typeof classification !== 'string' || !['safe', 'unsafe', 'unknown'].includes(classification) || !compatibility
      || !Array.isArray(reasons) || reasons.length < 1 || reasons.length > 5
      || reasons.some(reason => !readable(reason)) || !Array.isArray(gaps) || gaps.length > 10
      || gaps.some(gap => !readable(gap)) || !Array.isArray(citations) || citations.length > 42) {
      return <p>Result format unavailable. Check the activity status before acting.</p>;
    }
    const checks = record(assessment.checks);
    return <div class="operator-activity-reports">
      <h5>Dispatcher assessment</h5>
      <Show when={readable(data.repository) && typeof data.pullRequest === 'number'
        && Number.isSafeInteger(data.pullRequest) && data.pullRequest > 0}>
        <p>{readable(data.repository)} · PR #{String(data.pullRequest)}</p>
      </Show>
      <p>Compatibility: {String(classification).toUpperCase()}</p>
      <p>{compatibility}</p>
      <For each={reasons}>{reason => <p>Reason: {readable(reason) || unavailableEvidence}</p>}</For>
      <For each={gaps}>{gap => <p>Unresolved: {readable(gap) || unavailableEvidence}</p>}</For>
      <Show when={checks && ['passing', 'failing', 'pending', 'unconfigured', 'unavailable'].includes(String(checks.state))}>
        <p>Checks {String(checks?.state)}</p>
      </Show>
      <For each={citations}>{citation => {
        const item = record(citation);
        if (!item || !['release', 'guide', 'config'].includes(String(item.kind))) {
          return <p>Evidence: {unavailableEvidence}</p>;
        }
        const source = item.kind === 'config' ? readable(item.ref) : readable(item.source);
        const quote = item.kind === 'config' ? null : readable(item.quote);
        return <p>Evidence ({String(item.kind)}): {source || unavailableEvidence}
          <Show when={item.kind !== 'config'}> · {quote || unavailableEvidence}</Show></p>;
      }}</For>
      <p>Compatibility assessment only — not merge authorization.</p>
    </div>;
  }
  if (record(data.evidence) || readable(data.summary) || readable(data.verdict) || readable(data.decision)) {
    const evidence = record(data.evidence);
    return <div class="operator-activity-reports">
      <h5>Dispatcher assessment</h5>
      <Show when={readable(data.repository) && typeof data.pullRequest === 'number'
        && Number.isSafeInteger(data.pullRequest) && data.pullRequest > 0}>
        <p>{readable(data.repository)} · PR #{String(data.pullRequest)}</p>
      </Show>
      <Show when={readable(data.summary)}>{text => <p>{text()}</p>}</Show>
      <Show when={readable(evidence?.bot)}>{text => <p>Observed author: {text()}</p>}</Show>
      <Show when={readable(data.verdict) || readable(data.decision)}>{text => <p>Conclusion: {text()}</p>}</Show>
      <Show when={evidence?.complete === false}><p>Evidence incomplete. No safety conclusion is implied.</p></Show>
      <Show when={evidence?.stale === true}><p>Evidence stale.</p></Show>
      <Show when={evidence?.truncated === true}><p>Evidence truncated.</p></Show>
      <Show when={evidence?.complete === true && evidence?.stale === false && evidence?.truncated === false}><p>Evidence collection complete.</p></Show>
    </div>;
  }
  if (readable(data.code)) return <p>Reported failure: {readable(data.code)}</p>;
  return <p>Result format unavailable. Check the activity status before acting.</p>;
}

/** REQ-OPERATOR-008 global enterprise activity summary; all mutations remain explicit POSTs. */
const OperatorActivityButton: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [cancelling, setCancelling] = createSignal<string>();
  const [loadError, setLoadError] = createSignal(false);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [previous, setPrevious] = createSignal<Array<string | null>>([]);
  const [activities, { refetch }] = createResource(() => [props.enabled, cursor()] as const, async ([enabled, after]) => {
    if (!enabled) return { items: [], nextCursor: null, workingCount: 0, unreadCount: 0, latestSequence: 0 };
    try { const value = await listOperatorActivities(after); setLoadError(false); return value; }
    catch { setLoadError(true); return null; }
  });
  const [selected, setSelected] = createSignal<string | null>(null);
  const [detail, { refetch: refetchDetail }] = createResource(selected, async id => id ? getOperatorActivity(id) : null);
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
  const working = createMemo(() => activities()?.workingCount ?? 0);
  const unread = createMemo(() => activities()?.unreadCount ?? 0);
  const hasActivities = createMemo(() => (activities()?.items.length ?? 0) > 0);
  let control: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  const [position, setPosition] = createSignal({ top: 0, right: 0 });
  let openedWidth = 0;
  // Focus returns to the trigger when focus is still inside the panel, which is what keyboard
  // dismissal needs. On outside-click dismissal the browser's own mousedown focus handling runs
  // after this listener and takes precedence, so the user's click target keeps focus.
  const close = () => {
    const held = !!panel && !!document.activeElement && panel.contains(document.activeElement);
    setOpen(false);
    setSelected(null);
    setCursor(null);
    setPrevious([]);
    if (held) trigger?.focus();
  };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && open()) close(); };
  // The panel is portalled, so it is not a descendant of the control: both boxes count as inside.
  const clickOutside = (event: MouseEvent) => {
    if (!open() || !(event.target instanceof Node)) return;
    if (!control?.contains(event.target) && !panel?.contains(event.target)) close();
  };
  const toggle = () => {
    if (open()) { close(); return; }
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
    openedWidth = window.innerWidth;
    setOpen(true);
    queueMicrotask(() => panel?.focus());
    void (async () => {
      const page = await refetch();
      if (!page?.unreadCount) return;
      try { await acknowledgeOperatorActivities(page.latestSequence); await refetch(); }
      catch { /* Keep unread visible if acknowledgment fails. */ }
    })();
  };
  // Coordinates and the layout branch are measured once per open, so the panel cannot outlive the
  // width it was measured at: a crossing while open would otherwise leave desktop offsets on a
  // bottom sheet, or a fixed box with no offsets at all. Only width invalidates the measurement,
  // so height-only resizes (on-screen keyboard, URL bar) must not dismiss the panel.
  const closeOnResize = () => { if (open() && window.innerWidth !== openedWidth) close(); };
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
  const interval = setInterval(() => {
    if (props.enabled) {
      void refetch();
      if (selected()) void refetchDetail();
    }
  }, 15_000);
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
        <Show when={unread() > 0}><span class="operator-activity-badge">{unread()}</span></Show>
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
          'operator-activity-panel--active': working() > 0 || (activities()?.items.length ?? 0) > 1 || !!selected(),
          'operator-activity-panel--compact': working() === 0 && (activities()?.items.length ?? 0) <= 1 && !selected(),
          'operator-activity-panel--empty': !activities.loading && !loadError() && !hasActivities(),
        }} style={window.innerWidth > 640
          ? { top: `${position().top}px`, right: `${position().right}px` }
          : undefined} tabindex="-1" role="dialog" aria-label="Operator activity" aria-modal="false">
          <header><div><strong>Operator overview</strong><small>Operators are autonomous agents that work in the background. Track progress and results here.</small></div></header>
          <Show when={selected()} fallback={<Show when={!activities.loading} fallback={<div class="operator-activity-state">Loading activity…</div>}>
            <Show when={!loadError()} fallback={<div class="operator-activity-state"><strong>Activity unavailable</strong><span>Last known state cannot be treated as current.</span><button type="button" onClick={() => void refetch()}>Retry</button><Show when={cursor()}><button type="button" onClick={() => { setPrevious([]); setCursor(null); }}>Return to newest</button></Show></div>}>
              <Show when={(activities()?.items.length ?? 0) > 0} fallback={<div class="operator-activity-state operator-activity-state--empty">No activity</div>}>
                <div class="operator-activity-list"><For each={activities()?.items}>{item => (
                  <article class="operator-activity-item">
                    <div><strong>{item.operatorName || item.operatorId}</strong><span>{item.executionStatus}</span></div>
                    <Show when={item.context || item.source}><p>{item.context || item.source}</p></Show>
                    <Show when={item.progress}><p>{item.progress}</p></Show>
                    <Show when={item.attention}><span class="operator-activity-attention">Needs attention</span></Show>
                    <small>Updated {updatedDate(item.updatedAt).toLocaleString()}<Show when={stale(item.updatedAt) && workingStates.has(item.executionStatus)}> · Last observation may be stale</Show></small>
                    <nav><button type="button" aria-label={`View ${item.activityId}`} onClick={() => setSelected(item.activityId)}>View details</button>
                      <Show when={item.sessionId}>{sessionId => <a href={`/app?session=${encodeURIComponent(sessionId())}`}>Open session</a>}</Show>
                      <Show when={workingStates.has(item.executionStatus) && item.executionStatus !== 'unknown'}><button type="button" disabled={cancelling() === item.activityId}
                        aria-label={`Cancel ${item.activityId}`} onClick={() => void cancel(item.activityId)}>Cancel</button></Show></nav>
                  </article>
                )}</For></div>
                <nav class="operator-activity-pages"><Show when={previous().length > 0}><button type="button" onClick={newerPage}>Newer 5</button></Show>
                  <Show when={activities()?.nextCursor}><button type="button" onClick={nextPage}>Load next 5</button></Show></nav>
              </Show>
            </Show>
          </Show>}>
            <button type="button" onClick={() => setSelected(null)}>Back to activities</button>
            <Show when={!detail.loading} fallback={<div class="operator-activity-state">Loading activity detail…</div>}>
              <Show when={!detail.error && detail()} fallback={<div class="operator-activity-state">Activity detail unavailable</div>}>
                {value => <div class="operator-activity-list operator-activity-detail">
                  <h3>{value().operatorName || value().operatorId}</h3>
                  <Show when={value().context}><p>{value().context}</p></Show>
                  <p>Activity ID: {value().activityId}</p>
                  <p>Execution: {value().executionStatus}</p>
                  <p>Cleanup: {value().cleanupStatus}</p>
                  <p>Collection: {value().collectionStatus}</p>
                  <Show when={value().attention}><span class="operator-activity-attention">Needs attention</span></Show>
                  <Show when={value().progress}><p>Progress: {value().progress}</p></Show>
                  <Show when={value().checkpoint != null}><p>Checkpoint saved. Work may still be in progress.</p></Show>
                  <h4>Result</h4>
                  <Show when={value().result != null} fallback={<p>{value().executionStatus === 'unknown' ? 'Outcome unknown'
                    : value().executionStatus === 'failed' ? 'Activity failed without a result'
                    : value().executionStatus === 'completed' ? 'Result unavailable'
                    : 'Result pending'}</p>}>{resultView(value().result)}</Show>
                  <small>Updated {updatedDate(value().updatedAt).toLocaleString()}<Show when={stale(value().updatedAt) && workingStates.has(value().executionStatus)}> · Last observation may be stale</Show></small>
                </div>}
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
