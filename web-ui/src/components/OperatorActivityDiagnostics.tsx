import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { ApiError } from '../api/fetch-helper';
import { exportOperatorActivityDiagnostics, getOperatorActivityDiagnosticHistory,
  getOperatorActivityDiagnosticRecord, getOperatorActivityDiagnostics } from '../api/operator-activities';
import type { DiagnosticDetail, DiagnosticExport, DiagnosticHistory, DiagnosticRecord, DiagnosticSummary } from '../api/operator-diagnostics-wire';
import OperatorDiagnosticRecord, { DiagnosticRecordMetadata, diagnosticWords } from './OperatorDiagnosticRecord';

const reasons: Record<DiagnosticSummary['diagnosis']['code'], string> = {
  none: 'The retained records do not identify a failure.', unclassified: 'The retained records do not classify the failure.',
  'artifact-unavailable': 'The admitted artifact was unavailable.', 'artifact-mismatch': 'The artifact did not match its immutable binding.',
  'admission-denied': 'Activity admission was denied.', 'authority-expired': 'Execution authority expired.',
  'authority-denied': 'The platform rejected a request because it could not confirm the run’s current authorization.', 'stale-drive': 'The request belonged to an earlier execution.',
  'startup-failed': 'The execution runtime could not start.', 'submission-failed': 'The work could not be submitted to the execution runtime.',
  'sse-json-invalid': 'Provider stream JSON parsing failed.', 'provider-failed': 'The model provider failed.',
  'stream-failed': 'The response stream failed.', 'response-unusable': 'The inference response was unusable.',
  'canonical-append-failed': 'The response could not be saved to the execution journal; a durable save was not confirmed.',
  'tool-failed': 'A tool failed.', 'effect-unknown': 'The effect outcome is unknown; do not replay uncertain work.',
  'settlement-failed': 'The runtime did not finish with a confirmed final result.', 'continuation-not-ready': 'The run was not ready to continue.',
  cancelled: 'Cancellation was observed.', 'deadline-expired': 'The activity deadline expired.',
  'cleanup-failed': 'The execution runtime could not finish cleanup.', 'capacity-exhausted': 'The admitted capacity was exhausted.',
  'recorder-unavailable': 'The diagnostic recorder is unavailable.',
  'platform-evidence-required': 'Correlated platform evidence is required; the JavaScript cause is not known.',
};
const nextChecks: Record<DiagnosticSummary['diagnosis']['nextCheck'], string> = {
  'inspect-failure': 'Check the failure record in the timeline to see what was recorded.',
  'inspect-sdk-import': 'Check the technical details for records that have not been confirmed as saved by the host.',
  'inspect-platform-events': 'Inspect independently correlated platform events and evidence.',
  'inspect-retention-gap': 'Check the retention gaps in technical details for missing records before drawing conclusions.',
  'inspect-original-binding': 'Check the original activity binding in technical details to check any recorded reason for stopping this run.',
  'inspect-pending-handoff': 'Check the pending handoff in the timeline; receiving a response does not confirm that it was saved or the work finished.',
  none: 'Review the retained timeline if more context is needed. These diagnostics cannot resume or replay work.',
};
function diagnosticFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if ([401, 403, 404].includes(error.status)) return 'Diagnostics are not available: access or permission could not be confirmed.';
    if (error.status === 409) return 'Diagnostic binding changed or retention epoch expired. The stale snapshot has been discarded; open diagnostics manually for a fresh snapshot.';
    if (error.status === 503) return 'Diagnostics unavailable. Retained evidence could not be read; this does not mean no failure occurred.';
  }
  return 'Diagnostic metadata is invalid or unavailable. It cannot be used as evidence.';
}
const quantity = (value: number | null) => value === null ? 'Unknown / unavailable' : String(value);
const Retention: Component<{ summary: DiagnosticSummary | DiagnosticHistory | DiagnosticExport; additionalGaps: string[] }> = props => <div class="operator-diagnostic-retention">
  <h4>Evidence availability</h4>
  <p>{props.summary.health.status === 'loss' ? 'Some diagnostic metadata is missing. The retained records may not explain everything that happened.'
    : props.summary.health.status === 'unavailable' ? 'Diagnostic metadata availability is unknown. Missing records cannot rule out a failure.'
    : 'Only the metadata saved in this snapshot is shown; uncaptured failures cannot be ruled out.'} Protected runtime logs are stored separately; gaps here do not prove those logs were lost.</p>
  <details><summary>Retention technical details</summary>
  <p>Retained evidence health: {props.summary.health.status}. {props.summary.health.status === 'loss' ? 'Evidence gaps are reported; counters below describe observed retention loss only.'
    : props.summary.health.status === 'unavailable' ? 'Retention loss quantities are unknown / unavailable.' : 'Availability applies only to this captured metadata snapshot.'}</p>
  <p>Routine events evicted: {quantity(props.summary.retention.evictedRoutine)}</p>
  <p>Failure capsules: {quantity(props.summary.retention.droppedFailure)} dropped</p>
  <p>Terminal capsules dropped: {quantity(props.summary.retention.droppedTerminal)}</p>
  <p>Oversized records: {quantity(props.summary.retention.oversized)} · Rejected records: {quantity(props.summary.retention.rejected)}</p>
  <Show when={props.additionalGaps.length}><p>Additional evidence gaps: {props.additionalGaps.map(diagnosticWords).join(', ')}</p></Show>
  </details>
</div>;

/** Manual metadata reads only. Component lifetime owns responses and download URLs. */
const OperatorActivityDiagnostics: Component<{ activityId: string; openOnMount?: boolean }> = props => {
  const [opened, setOpened] = createSignal(false);
  const [summary, setSummary] = createSignal<DiagnosticSummary>();
  const [history, setHistory] = createSignal<DiagnosticHistory>();
  const [records, setRecords] = createSignal<DiagnosticRecord[]>([]);
  const [detail, setDetail] = createSignal<DiagnosticDetail>();
  const [exportPart, setExportPart] = createSignal<DiagnosticExport>();
  const [partCount, setPartCount] = createSignal(0);
  const [downloads, setDownloads] = createSignal<Array<{ number: number; url: string }>>([]);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal('');
  const [recordLoading, setRecordLoading] = createSignal('');
  let active = true;
  let revision = 0;
  let recordRevision = 0;
  const urls = new Set<string>();
  const exportedIds = new Set<string>();
  let lastExportSequence = 0;
  let exportOperationsStarted = false;
  function releaseDownloads() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); setDownloads([]);
  }
  function discard() {
    ++revision; ++recordRevision;
    setSummary(undefined); setHistory(undefined); setRecords([]); setDetail(undefined);
    setExportPart(undefined); setPartCount(0); exportedIds.clear(); lastExportSequence = 0; exportOperationsStarted = false;
    releaseDownloads(); setLoading(''); setRecordLoading('');
  }
  createEffect(() => { void props.activityId; discard(); setOpened(false); setError(''); });
  // The dropdown mounts this reader only after its own explicit View action.
  onMount(() => { if (props.openOnMount) void open(); });
  onCleanup(() => { active = false; ++revision; ++recordRevision; releaseDownloads(); });
  function current(id: string, token: number) { return active && props.activityId === id && revision === token; }
  function fail(cause: unknown, id: string, token: number) {
    if (!current(id, token)) return;
    if (!(cause instanceof ApiError) || [401, 403, 404, 409].includes(cause.status)) discard();
    setError(diagnosticFailure(cause));
  }
  async function open() {
    if (loading() || recordLoading()) return;
    discard(); setOpened(true); setError(''); setLoading('Loading diagnostics…');
    const id = props.activityId, token = revision;
    try {
      const value = await getOperatorActivityDiagnostics(id);
      if (!current(id, token)) return;
      setSummary(value); setLoading('Loading diagnostic history…');
      const page = await getOperatorActivityDiagnosticHistory(id, null, value);
      if (!current(id, token)) return;
      setHistory(page); setRecords(page.records);
    } catch (cause) { fail(cause, id, token); }
    finally { if (current(id, token)) setLoading(''); }
  }
  async function nextHistory() {
    const previous = history();
    if (loading() || recordLoading() || !previous?.nextCursor || !summary()) return;
    const id = props.activityId, token = revision;
    setError(''); setLoading('Loading next history records…');
    try {
      const page = await getOperatorActivityDiagnosticHistory(id, previous.nextCursor, previous);
      if (!current(id, token)) return;
      const retained = records();
      const ids = new Set(retained.map(row => row.id));
      const events = retained.filter(row => row.kind === 'event');
      const lastEvent = events[events.length - 1];
      if (page.nextCursor === previous.nextCursor || page.records.some(row => ids.has(row.id)
        || row.kind === 'event' && (retained.some(old => old.kind === 'operation')
          || lastEvent?.kind === 'event' && row.sequence <= lastEvent.sequence))) throw new Error('Invalid traversal progress');
      setRecords([...retained, ...page.records]); setHistory(page);
    } catch (cause) { fail(cause, id, token); }
    finally { if (current(id, token)) setLoading(''); }
  }
  async function inspect(recordId: string) {
    const snapshot = summary();
    if (!snapshot || loading() || recordLoading()) return;
    const id = props.activityId, token = revision, request = ++recordRevision;
    setError(''); setDetail(undefined); setRecordLoading(recordId);
    try {
      const value = await getOperatorActivityDiagnosticRecord(id, recordId, snapshot);
      if (current(id, token) && recordRevision === request) setDetail(value);
    } catch (cause) { if (recordRevision === request) fail(cause, id, token); }
    finally { if (current(id, token) && recordRevision === request) setRecordLoading(''); }
  }
  async function exportMetadata() {
    const snapshot = exportPart() ?? summary();
    if (!snapshot || loading() || recordLoading()) return;
    const previous = exportPart();
    if (previous && !previous.nextCursor) return;
    const id = props.activityId, token = revision;
    setError(''); setLoading('Loading export metadata part…');
    try {
      const part = await exportOperatorActivityDiagnostics(id, previous?.nextCursor ?? null, snapshot);
      if (!current(id, token)) return;
      if (previous && (part.snapshotDigest !== previous.snapshotDigest || part.nextCursor === previous.nextCursor))
        throw new ApiError('Export snapshot changed.', 409, 'Conflict');
      for (const record of part.records) {
        if (exportedIds.has(record.id)) throw new Error('Invalid export traversal progress');
        if (record.kind === 'event') {
          if (exportOperationsStarted || record.sequence <= lastExportSequence) throw new Error('Invalid export event order');
          lastExportSequence = record.sequence;
        } else exportOperationsStarted = true;
        exportedIds.add(record.id);
      }
      setExportPart(part); setPartCount(value => value + 1);
      // Export only the successfully validated public metadata, never a server
      // response/error body. Earlier downloaded parts remain independently labelled.
      if (typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(part)], { type: 'application/json' }));
        urls.add(url); setDownloads(saved => [...saved, { number: partCount(), url }]);
      }
    } catch (cause) { fail(cause, id, token); }
    finally { if (current(id, token)) setLoading(''); }
  }
  const disabled = () => !!loading() || !!recordLoading();
  return <div class="operator-diagnostics">
    <Show when={!props.openOnMount}><div class="operator-actions"><button class="admin-secondary-button" disabled={disabled()} aria-expanded={opened()}
      onClick={() => void open()}>View diagnostics</button></div></Show>
    <Show when={opened()}><section aria-label="Activity Diagnostics" aria-busy={disabled()} class="operator-diagnostic-panel">
      <h3>Diagnostics</h3>
      <Show when={loading()}><p role="status" aria-live="polite">{loading()}</p></Show>
      <Show when={error()}><p class="operator-message" role="alert">{error()}</p></Show>
      <Show when={summary()}>{value => <>
        <div class="operator-diagnostic-diagnosis">
          <h4>Evidence summary</h4>
          <p class="operator-state">{value().diagnosis.state === 'recovered-failure' ? 'A failure was recorded and later recovered. It does not explain how the later work ended.'
            : value().diagnosis.state === 'observed-failure' ? 'A failure was recorded. Its original cause is not established by this summary.'
            : value().diagnosis.state === 'evidence-incomplete' ? 'The available records are incomplete. The cause or handoff cannot be fully confirmed.'
            : 'The retained records do not show a failure, but they do not establish that execution succeeded.'}</p>
          <Show when={value().diagnosis.code !== 'none'}><p>{reasons[value().diagnosis.code]}</p></Show>
          <p>{value().diagnosis.lastConfirmedId ? 'A last confirmed record is available in the timeline; it does not prove that later work succeeded.'
            : 'No last confirmed record is available; no successful step can be inferred.'} {value().diagnosis.failedId
              ? 'A failed or unfulfilled handoff was retained. It is not necessarily the first failure.'
              : 'The failed transition is unconfirmed; a missing record does not rule out a failure.'}</p>
          <p>Next: {nextChecks[value().diagnosis.nextCheck]}</p>
          <Show when={value().capture !== 'enabled'}><p>{value().capture === 'legacy' ? 'This older run did not capture diagnostic evidence.'
            : value().capture === 'disabled' ? 'Logging was off. Optional errors and timeline records were not captured.'
            : 'Diagnostic capture is unavailable.'}</p></Show>
          <Show when={value().health.sdkImport === 'pending' || value().health.gaps.includes('sdk-import-incomplete')}>
            <p>Some runtime records have not been imported into this metadata view. This does not establish whether their original runtime logs are available.</p>
          </Show>
          <Show when={value().fence?.uncertain}><p>Earlier effects are uncertain. Do not replay uncertain work.</p></Show>
          <details><summary>Summary technical details</summary>
          <p>Capture status: {value().capture}</p>
          <p>Last confirmed evidence: {value().diagnosis.lastConfirmedId ?? 'Unavailable; no last success is inferred.'}</p>
          <p>{value().diagnosis.failedId ? `Retained failed / unfulfilled handoff: ${value().diagnosis.failedId}`
            : 'Failed transition: unconfirmed.'}</p>
          <p>Snapshot captured <time datetime={new Date(value().capturedAt).toISOString()}>{new Date(value().capturedAt).toLocaleString()}</time>. No automatic refresh or polling.</p>
          <p>Current original-lease binding generation: {value().binding.generation}</p>
          <Show when={value().fence}>{fence => <p>Essential fence: {diagnosticWords(fence().boundary)} · {fence().code === value().diagnosis.code ? 'Reason shown above' : reasons[fence().code]} · Fence generation: {fence().generation} · {new Date(fence().timestamp).toLocaleString()}{fence().uncertain ? ' · Prior effects uncertain.' : ''}</p>}</Show>
          <p>SDK import: {diagnosticWords(value().health.sdkImport)}</p>
          <Show when={value().health.sdkImport === 'pending' || value().health.gaps.includes('sdk-import-incomplete')}>
            <p>{value().health.sdkImportReason === 'retirement-tail-unwitnessed'
              ? 'The last observed SDK watermark and its known record window are host-persisted. This does not prove that an unseen retirement tail reached the host; the future tail is unwitnessed, not an observed dropped-record count.'
              : 'Local child capture does not confirm a host-persisted cause. A persisted last-observed watermark does not prove that an unseen retirement tail reached the host.'} This uncertainty does not authorize reopening retired SDK work.</p>
          </Show>
          </details>
        </div>
        <Retention summary={value()} additionalGaps={value().health.gaps.filter(gap =>
          !(gap === 'legacy-uncaptured' && value().capture === 'legacy')
          && !(gap === 'logging-disabled' && value().capture === 'disabled')
          && !(gap === 'sdk-import-incomplete' && value().health.sdkImport === 'pending')
          && gap !== value().diagnosis.code)} />
        <p>A host response does not prove that the runtime received or saved it, or that the work finished.</p>
        <Show when={history()}>{page => <div class="operator-diagnostic-history">
          <h4>Retained timeline</h4>
          <Show when={page().health.status !== value().health.status && page().health.status !== 'available' || page().retainedStatus !== 'complete' && value().health.status === 'available'}>
            <p>The history page reports missing or unavailable evidence. Check timeline technical details for the gaps.</p>
          </Show>
          <details><summary>Timeline technical details</summary>
          <p>Diagnostic event sequence is host-persistence order, not SDK source time. Legacy operations follow in operation storage-key order, not logical ordinal order or a total chronology.</p>
          <p>History page: {page().pageStatus} · Retained history: {page().retainedStatus} · Event high-water: {quantity(page().highWater.events)} · Operation high-water: {quantity(page().highWater.operations)}. Counts do not prove enumeration exhaustion.</p>
          <p>History metadata read <time datetime={new Date(page().capturedAt).toISOString()}>{new Date(page().capturedAt).toLocaleString()}</time>; resumed pages preserve the history snapshot’s high-water and retention epoch.</p>
          <Show when={page().health.status !== value().health.status || page().retainedStatus !== 'complete'}>
            <p>Page evidence gaps: {page().health.gaps.filter(gap => !value().health.gaps.includes(gap)).map(diagnosticWords).join(', ') || 'Already described in the snapshot above'}.</p>
          </Show>
          </details>
          <ol class="operator-diagnostic-timeline" aria-label="Diagnostic timeline"><For each={records().filter(row => row.kind === 'event')}>{record => <li>
            <DiagnosticRecordMetadata record={record} />
            <button class="admin-secondary-button" disabled={disabled()} aria-expanded={detail()?.record.id === record.id}
              onClick={() => void inspect(record.id)}>View record {record.id}</button>
            <Show when={recordLoading() === record.id}><p role="status" aria-live="polite">Loading record detail…</p></Show>
            <Show when={detail()?.record.id === record.id ? detail() : undefined}>{selected => <OperatorDiagnosticRecord detail={selected()} />}</Show>
          </li>}</For></ol>
          <Show when={!records().some(row => row.kind === 'event')}><p>No retained diagnostic events in the pages read. {page().pageStatus === 'unavailable' ? 'History is unavailable, not empty complete evidence.' : 'This does not exclude uncaptured failures.'}</p></Show>
          <Show when={records().some(row => row.kind === 'operation')}><h4>Retained operation metadata</h4>
            <ul class="operator-diagnostic-operations" aria-label="Retained operations"><For each={records().filter(row => row.kind === 'operation')}>{record => <li>
              <DiagnosticRecordMetadata record={record} />
              <button class="admin-secondary-button" disabled={disabled()} aria-expanded={detail()?.record.id === record.id}
                onClick={() => void inspect(record.id)}>View record {record.id}</button>
              <Show when={recordLoading() === record.id}><p role="status" aria-live="polite">Loading record detail…</p></Show>
              <Show when={detail()?.record.id === record.id ? detail() : undefined}>{selected => <OperatorDiagnosticRecord detail={selected()} />}</Show>
            </li>}</For></ul>
          </Show>
          <Show when={page().nextCursor}><div class="operator-actions"><button class="admin-secondary-button" disabled={disabled()} onClick={() => void nextHistory()}>Load next history page</button></div></Show>
        </div>}</Show>
        <details><summary>Capture and source technical details</summary>
        <section aria-label="Capture capabilities" class="operator-diagnostic-coverage">
          <h4>Capture capabilities and provenance</h4>
          <p>Support describes this artifact’s capture capability, not identification of an earlier historical failure.</p>
          <ul class="operator-diagnostic-capabilities"><For each={value().capabilities}>{capability => <li><strong>{diagnosticWords(capability.boundary)}</strong><span>{diagnosticWords(capability.availability)} · {diagnosticWords(capability.persistence)}</span></li>}</For></ul>
          <Show when={!value().capabilities.length}><p>No capture capability metadata supplied; support is not inferred.</p></Show>
          <p>{value().provenance.patchSetDigest ? 'Codeflare-derived patched SDK provenance' : 'SDK patch provenance unavailable'}</p>
          <dl class="operator-diagnostic-facts"><div><dt>Host revision</dt><dd>{value().provenance.hostRevision ?? 'Unavailable'}</dd></div>
            <div><dt>Flue base runtime</dt><dd>{value().provenance.sdkBaseRuntime ?? 'Unavailable'}</dd></div>
            <div><dt>Agents base SDK</dt><dd>{value().provenance.sdkBaseAgents ?? 'Unavailable'}</dd></div>
            <div><dt>Patch set digest</dt><dd>{value().provenance.patchSetDigest ?? 'Unavailable'}</dd></div>
            <div><dt>Original artifact digest</dt><dd>{value().binding.artifactDigest}</dd></div>
            <div><dt>Original input digest</dt><dd>{value().binding.inputDigest}</dd></div></dl>
          <p>SDK binding: {value().sdkBinding.status}{value().sdkBinding.reason ? ` · ${diagnosticWords(value().sdkBinding.reason!)}` : ''}</p>
          <dl class="operator-diagnostic-facts"><For each={(['rootDigest', 'submissionDigest', 'attemptDigest'] as const)}>{key => <div>
            <dt>{key === 'rootDigest' ? 'SDK root digest' : key === 'submissionDigest' ? 'SDK submission digest' : 'SDK attempt digest'}</dt>
            <dd>{value().sdkBinding[key] ?? 'Unavailable'}</dd>
          </div>}</For></dl>
        </section>
        </details>
        <section class="operator-diagnostic-export" aria-label="Diagnostics metadata export"><h4>Metadata export</h4>
          <p>Read-only public metadata; no prompts, payloads, credentials or raw errors. Each download covers only one segment of retained evidence.</p>
          <Show when={!exportPart()}><button class="admin-secondary-button" disabled={disabled()} onClick={() => void exportMetadata()}>Export metadata</button></Show>
          <Show when={exportPart()}>{part => <>
            <p role="status">Metadata export part {partCount()} read. {part().nextCursor ? 'More parts remain.'
              : part().pageStatus === 'complete' ? 'Export traversal exhausted: all retained metadata parts read.'
              : 'Export traversal unavailable; retained evidence cannot be claimed complete.'}</p>
            <p>{part().retainedStatus === 'loss' ? 'Retained evidence loss remains even after all export parts have been read. '
              : part().retainedStatus === 'unavailable' ? 'The availability of retained export evidence is unknown. '
              : 'The export covers only retained records. '}Traversal completeness does not describe complete execution history.</p>
            <details><summary>Export technical details</summary>
            <p>Export retention status: {part().retainedStatus}</p>
            <dl class="operator-diagnostic-facts"><div><dt>Snapshot digest</dt><dd>{part().snapshotDigest}</dd></div>
              <div><dt>Part digest</dt><dd>{part().partDigest}</dd></div></dl></details>
            <ul class="operator-diagnostic-downloads" aria-label="Metadata downloads"><For each={downloads()}>{saved => <li>
              <a href={saved.url} download={`${props.activityId}-diagnostics-part-${saved.number}.json`}>Save part {saved.number} (.json)</a>
            </li>}</For></ul>
            <Show when={typeof URL.createObjectURL !== 'function'}><p>File downloads are unavailable in this browser.</p></Show>
            <Show when={part().nextCursor}><div class="operator-actions"><button class="admin-secondary-button" disabled={disabled()} onClick={() => void exportMetadata()}><span>Export next metadata</span> part</button></div></Show>
          </>}</Show>
        </section>
      </>}</Show>
    </section></Show>
  </div>;
};
export default OperatorActivityDiagnostics;
