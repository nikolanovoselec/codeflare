import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { ApiError } from '../api/fetch-helper';
import { exportOperatorActivityDiagnostics, getOperatorActivityDiagnosticHistory,
  getOperatorActivityDiagnosticRecord, getOperatorActivityDiagnostics } from '../api/operator-activities';
import type { DiagnosticDetail, DiagnosticExport, DiagnosticHistory, DiagnosticRecord, DiagnosticSummary } from '../api/operator-diagnostics-wire';
import OperatorDiagnosticRecord, { DiagnosticRecordMetadata, diagnosticWords, sdkServiceCause, sdkServiceNext } from './OperatorDiagnosticRecord';

const reasons: Record<DiagnosticSummary['diagnosis']['code'], string> = {
  none: 'The retained records do not identify a failure.', unclassified: 'The retained records do not classify the failure.',
  'artifact-unavailable': 'The admitted artifact was unavailable.', 'artifact-mismatch': 'The artifact did not match its immutable binding.',
  'admission-denied': 'Activity admission was denied.', 'authority-expired': 'Execution authority expired.',
  'authority-denied': 'The platform rejected a request because it could not confirm the run’s current authorization.', 'stale-drive': 'The request belonged to an earlier execution.',
  'startup-failed': 'The execution runtime could not start.', 'submission-failed': 'The work could not be submitted to the execution runtime.',
  'sse-json-invalid': 'Provider stream JSON parsing failed.', 'provider-failed': 'The model provider failed.',
  'stream-failed': 'The response stream failed.', 'response-unusable': 'The inference response was unusable.',
  'canonical-append-failed': 'The response could not be saved to the execution journal; a durable save was not confirmed.',
  'tool-failed': 'A tool attempt failed; no concrete cause was retained.', 'effect-unknown': 'The effect outcome is unknown; do not replay uncertain work.',
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
  <details><summary>Evidence availability technical details</summary>
  <p>{props.summary.health.status === 'loss' ? 'Some diagnostic metadata is missing. The retained records may not explain everything that happened.'
    : props.summary.health.status === 'unavailable' ? 'Diagnostic metadata availability is unknown. Missing records cannot rule out a failure.'
    : 'Only the metadata saved in this snapshot is shown; uncaptured failures cannot be ruled out.'} Protected runtime logs are stored separately; gaps here do not prove those logs were lost.</p>
  <h4>Retention</h4>
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
  const [detailPlacement, setDetailPlacement] = createSignal<'summary' | 'timeline'>('timeline');
  const [exportPart, setExportPart] = createSignal<DiagnosticExport>();
  const [partCount, setPartCount] = createSignal(0);
  const [exportRetention, setExportRetention] = createSignal('complete');
  const [download, setDownload] = createSignal<string>();
  let exportController: AbortController | undefined;
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal('');
  const [recordLoading, setRecordLoading] = createSignal('');
  let active = true;
  let revision = 0;
  let recordRevision = 0;
  const urls = new Set<string>();
  function releaseDownloads() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); setDownload(undefined);
  }
  function discard() {
    ++revision; ++recordRevision;
    setSummary(undefined); setHistory(undefined); setRecords([]); setDetail(undefined);
    exportController?.abort(); exportController = undefined;
    setExportPart(undefined); setPartCount(0);
    releaseDownloads(); setLoading(''); setRecordLoading('');
  }
  createEffect(() => { void props.activityId; discard(); setOpened(false); setError(''); });
  // The dropdown mounts this reader only after its own explicit View action.
  onMount(() => { if (props.openOnMount) void open(); });
  onCleanup(() => { exportController?.abort(); active = false; ++revision; ++recordRevision; releaseDownloads(); });
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
  async function inspect(recordId: string, placement: 'summary' | 'timeline' = 'timeline') {
    const snapshot = summary();
    if (!snapshot || loading() || recordLoading()) return;
    const id = props.activityId, token = revision, request = ++recordRevision;
    setError(''); setDetail(undefined); setDetailPlacement(placement); setRecordLoading(recordId);
    try {
      const value = await getOperatorActivityDiagnosticRecord(id, recordId, snapshot);
      if (current(id, token) && recordRevision === request) setDetail(value);
    } catch (cause) { if (recordRevision === request) fail(cause, id, token); }
    finally { if (current(id, token) && recordRevision === request) setRecordLoading(''); }
  }
  async function exportMetadata() {
    const snapshot = summary();
    if (!snapshot || loading() || recordLoading()) return;
    const id = props.activityId, token = revision;
    const controller = new AbortController();
    exportController = controller;
    releaseDownloads(); setExportPart(undefined); setPartCount(0);
    setError(''); setLoading('Loading metadata export…');
    const parts: DiagnosticExport[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let lastSequence = 0;
    let operationsStarted = false;
    let cursor: string | null = null;
    try {
      do {
        const previous = parts.at(-1);
        const part = await exportOperatorActivityDiagnostics(id, cursor, previous ?? snapshot, controller.signal);
        if (!current(id, token) || controller.signal.aborted) return;
        if (previous && part.snapshotDigest !== previous.snapshotDigest)
          throw new ApiError('Export snapshot changed.', 409, 'Conflict');
        if (part.pageStatus === 'unavailable') throw new Error('Export evidence unavailable');
        if (part.nextCursor && (cursors.has(part.nextCursor) || !part.records.length))
          throw new Error('Invalid export traversal progress');
        for (const record of part.records) {
          if (ids.has(record.id)) throw new Error('Invalid export traversal progress');
          if (record.kind === 'event') {
            if (operationsStarted || record.sequence <= lastSequence) throw new Error('Invalid export event order');
            lastSequence = record.sequence;
          } else operationsStarted = true;
          ids.add(record.id);
        }
        if (part.nextCursor) cursors.add(part.nextCursor);
        parts.push(part); setPartCount(parts.length);
        setLoading(`Loading metadata export… ${parts.length} parts read`);
        cursor = part.nextCursor;
      } while (cursor);
      if (!current(id, token) || controller.signal.aborted) return;
      const first = parts[0];
      // Preserve validated parts verbatim, including individual digests, order and
      // retention loss. Exhaustion describes retained traversal, not execution history.
      const retainedStatus = parts.some(part => part.retainedStatus === 'loss') ? 'loss'
        : parts.some(part => part.retainedStatus === 'unavailable') ? 'unavailable' : 'complete';
      const bundle = { version: 1, format: 'codeflare-diagnostic-export', activityId: id,
        binding: first.binding, highWater: first.highWater, snapshotDigest: first.snapshotDigest,
        traversal: 'complete', retainedStatus, parts };
      setExportRetention(retainedStatus);
      if (typeof URL.createObjectURL !== 'function') throw new Error('File downloads unavailable');
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
      urls.add(url); setDownload(url); setExportPart(parts[parts.length - 1]);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${id}-diagnostics.json`;
      anchor.click();
    } catch (cause) {
      if (current(id, token)) { releaseDownloads(); setExportPart(undefined); }
      fail(cause, id, token);
    }
    finally {
      if (exportController === controller) exportController = undefined;
      if (current(id, token)) setLoading('');
    }
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
          <Show when={value().diagnosis.executionStatus}>{status => <p class="operator-state">Current state: {diagnosticWords(status())}</p>}</Show>
          <p class="operator-state">{value().fence ? 'The run stopped at an execution fence.'
            : value().diagnosis.state === 'recovered-failure' ? 'An earlier failed attempt recovered; the final run outcome is not established here.'
            : value().diagnosis.continuedId ? 'Work continued after a failed attempt. Full recovery is not confirmed.'
            : value().diagnosis.state === 'observed-failure' ? 'No later work is confirmed after the retained failed attempt.'
            : value().diagnosis.state === 'evidence-incomplete' ? 'Evidence is incomplete; the run outcome is unconfirmed.'
            : 'No failure is retained; this does not confirm success.'}</p>
          <Show when={value().diagnosis.sdkService} fallback={<Show when={value().diagnosis.code !== 'none'}><p>{value().diagnosis.transportStatus === 409 && value().diagnosis.transportReason === 'operation-conflict'
            ? 'The platform refused an inference request with HTTP 409 (operation-conflict). No additional vendor send was authorized for that refusal; the exact conflict condition is not retained.'
            : value().diagnosis.publicCode === 'citation-provenance' ? 'A citation did not match retained source evidence.' : reasons[value().diagnosis.code]}</p></Show>}>
            {cause => <p>Retained attempt: {sdkServiceCause(cause())}</p>}
          </Show>
          <Show when={value().fence && value().diagnosis.sdkService}><p>{reasons[value().diagnosis.code]}</p></Show>
          <Show when={value().fence && value().diagnosis.continuedId}><p>Later work was recorded after the failed attempt; full recovery is not confirmed.</p></Show>
          <p>Next: {value().fence?.uncertain ? 'Inspect the execution fence and reconcile uncertain effects before considering another run. Do not replay uncertain work.' : value().diagnosis.sdkService && !value().diagnosis.continuedId && value().diagnosis.state !== 'recovered-failure'
            ? sdkServiceNext(value().diagnosis.sdkService!) : value().diagnosis.continuedId || value().diagnosis.state === 'recovered-failure'
              ? 'Inspect the later evidence and final result before deciding whether another run is needed.'
              : value().diagnosis.transportStatus === 409 && value().diagnosis.transportReason === 'operation-conflict'
                ? 'Inspect the original operation and request comparison before retrying. Do not replay uncertain work.'
                : nextChecks[value().diagnosis.nextCheck]}</p>
          <Show when={value().diagnosis.failedId}>{id => <button class="admin-secondary-button" disabled={disabled()}
            onClick={() => void inspect(id(), 'summary')}>View failure evidence</button>}</Show>
          <Show when={detailPlacement() === 'summary' ? detail() : undefined}>{selected => <OperatorDiagnosticRecord detail={selected()} />}</Show>
          <Show when={value().capture !== 'enabled'}><p>{value().capture === 'legacy' ? 'This older run did not capture diagnostic evidence.'
            : value().capture === 'disabled' ? 'Logging was off. Optional errors and timeline records were not captured.'
            : 'Diagnostic capture is unavailable.'}</p></Show>
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
            <p>Some runtime records have not been imported into this metadata view. This does not establish whether their original runtime logs are available.</p>
          </Show>

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

        <Show when={history()}>{page => <div class="operator-diagnostic-history">
          <details><summary>Timeline technical details and retained records</summary>
          <p>A host response does not prove that the runtime received or saved it, or that the work finished.</p>
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
            <Show when={detailPlacement() === 'timeline' && detail()?.record.id === record.id ? detail() : undefined}>{selected => <OperatorDiagnosticRecord detail={selected()} />}</Show>

          </li>}</For></ol>
          <Show when={!records().some(row => row.kind === 'event')}><p>No retained diagnostic events in the pages read. {page().pageStatus === 'unavailable' ? 'History is unavailable, not empty complete evidence.' : 'This does not exclude uncaptured failures.'}</p></Show>
          <Show when={records().some(row => row.kind === 'operation')}><h4>Retained operation metadata</h4>
            <ul class="operator-diagnostic-operations" aria-label="Retained operations"><For each={records().filter(row => row.kind === 'operation')}>{record => <li>
              <DiagnosticRecordMetadata record={record} />
              <button class="admin-secondary-button" disabled={disabled()} aria-expanded={detail()?.record.id === record.id}
                onClick={() => void inspect(record.id)}>View record {record.id}</button>
              <Show when={recordLoading() === record.id}><p role="status" aria-live="polite">Loading record detail…</p></Show>
            <Show when={detailPlacement() === 'timeline' && detail()?.record.id === record.id ? detail() : undefined}>{selected => <OperatorDiagnosticRecord detail={selected()} />}</Show>

            </li>}</For></ul>
          </Show>
          <Show when={page().nextCursor}><div class="operator-actions"><button class="admin-secondary-button" disabled={disabled()} onClick={() => void nextHistory()}>Load next history page</button></div></Show>
          </details>
        </div>}</Show>
        <details><summary>Capture and source technical details</summary>
        <section aria-label="Capture capabilities" class="operator-diagnostic-coverage">
          <h4>Capture capabilities and provenance</h4>
          <p>Support describes this artifact’s capture capability, not identification of an earlier historical failure.</p>
          <ul class="operator-diagnostic-capabilities"><For each={value().capabilities}>{capability => <li><strong>{diagnosticWords(capability.boundary)}</strong><span>{diagnosticWords(capability.availability)} · {diagnosticWords(capability.persistence)}</span></li>}</For></ul>
          <Show when={!value().capabilities.length}><p>No capture capability metadata supplied; support is not inferred.</p></Show>
          <p>{value().provenance.patchSetDigest ? 'Codeflare-derived patched SDK provenance' : 'SDK patch provenance unavailable'}</p>
          <dl class="operator-diagnostic-facts"><For each={Object.entries(value().provenance).filter(([, entry]) => entry != null)}>{([key, entry]) => <div>
            <dt>{({ hostRevision: 'Host revision', sdkBaseRuntime: 'Flue base runtime', sdkBaseAgents: 'Agents base SDK', patchSetDigest: 'Patch set digest' } as Record<string, string>)[key]}</dt><dd>{entry}</dd>
          </div>}</For><div><dt>Original artifact digest</dt><dd>{value().binding.artifactDigest}</dd></div>
            <div><dt>Original input digest</dt><dd>{value().binding.inputDigest}</dd></div></dl>
          <p>SDK binding: {value().sdkBinding.status}{value().sdkBinding.reason ? ` · ${diagnosticWords(value().sdkBinding.reason!)}` : ''}</p>
          <dl class="operator-diagnostic-facts"><For each={(['rootDigest', 'submissionDigest', 'attemptDigest'] as const).filter(key => value().sdkBinding[key] != null)}>{key => <div>
            <dt>{key === 'rootDigest' ? 'SDK root digest' : key === 'submissionDigest' ? 'SDK submission digest' : 'SDK attempt digest'}</dt>
            <dd>{value().sdkBinding[key] ?? 'Unavailable'}</dd>
          </div>}</For></dl>
        </section>
        </details>
        <section class="operator-diagnostic-export" aria-label="Diagnostics metadata export"><h4>Metadata export</h4>
          <p>Read-only public metadata; no prompts, payloads, credentials or raw errors. One download includes all retained cursor parts.</p>
          <button class="admin-secondary-button" disabled={disabled()} onClick={() => void exportMetadata()}>Export metadata</button>
          <Show when={exportPart()}><>
            <p role="status">Export traversal exhausted: all retained metadata parts read ({partCount()} parts). This does not establish complete execution history.</p>
            <p>{exportRetention() === 'loss' ? 'Retained evidence loss remains in the download.'
              : exportRetention() === 'unavailable' ? 'Retained evidence availability is unknown.'
              : 'The download covers only retained records.'}</p>
            <Show when={download()}>{url => <a href={url()} download={`${props.activityId}-diagnostics.json`}>Save metadata (.json)</a>}</Show>
          </></Show>
        </section>
      </>}</Show>
    </section></Show>
  </div>;
};
export default OperatorActivityDiagnostics;
