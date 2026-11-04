import { For, Show, type Component } from 'solid-js';
import { verifiedDiagnosticSourceUrl, type DiagnosticDetail, type DiagnosticErrorMetadata,
  type DiagnosticEvent, type DiagnosticRecord, type SdkServiceFailure } from '../api/operator-diagnostics-wire';

export function sdkServiceCause(cause: SdkServiceFailure): string {
  const operation = cause.sdkCode === null ? 'SDK service' : ({ model_source: 'Model configuration',
    model_validation: 'Model validation', provider: 'Provider request', stream: 'Provider stream',
    auth: 'Provider authentication', oauth: 'OAuth authentication' })[cause.sdkCode];
  const stage = cause.sdkStage === 'refresh' ? 'OAuth refresh' : cause.sdkStage === 'derivation'
    ? 'OAuth credential derivation' : operation;
  return `${stage} failed${cause.httpStatus ? `: upstream HTTP ${cause.httpStatus}` : ''}${cause.oauthError ? ` (${cause.oauthError})` : ''}${cause.exceptionCategory === 'timeout' ? ' (timeout)' : cause.exceptionCategory === 'abort' ? ' (aborted)' : ''}. The platform returned HTTP ${cause.wrapperStatus}; this is not the upstream status.`;
}
export function sdkServiceNext(cause: SdkServiceFailure): string {
  if (cause.requestAborted || cause.exceptionCategory === 'abort') return 'Check why the request was cancelled before starting another run.';
  if (cause.exceptionCategory === 'timeout') return 'Check provider connectivity and the timeout evidence before deciding whether to start another run.';
  if (cause.sdkCode === 'oauth' || cause.sdkCode === 'auth') return 'The execution owner should log in to the provider in Pi, then sync the updated auth to R2 before starting a new run. Do not copy credentials or use Cloudflare Access login to repair provider authentication.';
  return 'Check the execution owner’s model and provider configuration against the retained failure evidence before starting another run.';
}
export const diagnosticWords = (value: string) => value.replace(/-/g, ' ');
const boundaryLabels: Record<DiagnosticEvent['boundary'], string> = {
  artifact: 'Artifact check', admission: 'Admission', construction: 'Runtime startup', submission: 'Work submission',
  scheduling: 'Scheduling', delivery: 'Work delivery', model: 'Model request', 'inference-response': 'Host response',
  'canonical-commit': 'Saving the response', tool: 'Tool execution', effect: 'Effect', recovery: 'Recovery',
  settlement: 'Finishing the work', continuation: 'Continuation', fence: 'Execution fence', release: 'SDK release',
  platform: 'Platform observation', recorder: 'Diagnostic capture',
};
const available = (value: number | string | null | undefined) => value == null ? 'Unavailable' : String(value);
const coordinates: Record<keyof DiagnosticEvent['correlation'], string> = {
  logicalOrdinal: 'Logical ordinal', hostAttemptIndex: 'Host attempt index', chargedOrdinal: 'Charged ordinal',
  sdkAttemptDigest: 'SDK attempt digest', submissionDigest: 'Submission digest', deliveryDigest: 'Delivery digest',
  requestDigest: 'Request digest', responseDigest: 'Host response digest', rootDigest: 'SDK root digest',
  streamIncarnationDigest: 'Stream incarnation digest', sdkBatchSequence: 'SDK batch sequence',
  sdkProducerEpoch: 'SDK producer epoch', sdkProducerSequence: 'SDK producer sequence', sdkRecordIndex: 'SDK record index',
};
const Correlation: Component<{ event: DiagnosticEvent }> = props => <dl class="operator-diagnostic-facts">
  <For each={Object.entries(coordinates)}>{([key, label]) => <Show when={props.event.correlation[key as keyof DiagnosticEvent['correlation']] != null}>
    <div><dt>{label}</dt><dd>{available(props.event.correlation[key as keyof DiagnosticEvent['correlation']])}</dd></div>
  </Show>}</For>

</dl>;
const ErrorLineage: Component<{ error: DiagnosticErrorMetadata }> = props => <div class="operator-diagnostic-lineage">
  <p>Error kind: {props.error.kind}</p>
  <Show when={props.error.publicCode}><p>Public error code: {props.error.publicCode}</p></Show>
  <p>Fingerprint scope: {props.error.fingerprintScope}. Fingerprints are not error messages.</p>
  <dl class="operator-diagnostic-facts"><Show when={props.error.messageDigest}>{digest => <div><dt>Message fingerprint</dt><dd>{digest()}</dd></div>}</Show>
    <Show when={props.error.stackDigest}>{digest => <div><dt>Stack fingerprint</dt><dd>{digest()}</dd></div>}</Show></dl>
  <Show when={props.error.causes.length}><ol aria-label="Bounded error causes"><For each={props.error.causes}>{(cause, index) => <li>
    <p>Cause {index() + 1}: {cause.kind}</p><dl class="operator-diagnostic-facts">
      <div><dt>Message fingerprint</dt><dd>{available(cause.messageDigest)}</dd></div>
      <div><dt>Stack fingerprint</dt><dd>{available(cause.stackDigest)}</dd></div></dl>
  </li>}</For></ol></Show>
  <Show when={props.error.loss.length}><p>Error capture loss: {props.error.loss.map(diagnosticWords).join(', ')}; cause lineage and fingerprints may be bounded.</p></Show>
</div>;
export const DiagnosticRecordMetadata: Component<{ record: DiagnosticRecord; source?: boolean }> = props => <Show
  when={props.record.kind === 'event' ? props.record : undefined} fallback={(() => {
    const row = () => props.record.kind === 'operation' ? props.record : undefined;
    return <Show when={row()}>{operation => <>
      <p>{operation().terminalOutcome === 'not-sent' ? 'The model permit retired without a physical send; no vendor receipt is claimed.' : operation().status === 'completed' ? 'The operation was recorded as completed.'
        : operation().status === 'reserved' ? 'The operation was reserved; completion is not confirmed.'
        : 'The operation outcome is unknown.'} {operation().availability === 'unavailable' ? 'Its retained metadata is unavailable.' : ''}</p>
      <p>Operation kind: {diagnosticWords(operation().operationKind ?? 'unknown')}. This class does not prove an external effect.</p>
      <Show when={operation().sdkHttp}>{permit => <p>Root model permit: {diagnosticWords(permit().state)} · Claimed sends: {permit().attempts}. A claim is not proof of delivery.</p>}</Show>
      <details><summary>Operation technical details</summary>
      <p>Logical ordinal: {available(operation().ordinal)} · Journal status: {operation().status} · Record generation: {operation().generation}</p>
      <p>Availability: {operation().availability} · Association: {diagnosticWords(operation().association)}</p>
      <p>Operation digest: <span class="operator-diagnostic-digest">{operation().operationDigest}</span></p>
      <Show when={props.source}><dl class="operator-diagnostic-facts">
        <div><dt>Request digest</dt><dd>{available(operation().requestDigest)}</dd></div>
        <div><dt>Response digest</dt><dd>{available(operation().responseDigest)}</dd></div></dl>
        <Show when={operation().binding}>{binding => <>
          <p>Phase association: {binding().scope} · {binding().phase} · Phase index: {available(binding().phaseIndex)} · Resource: {binding().resource}</p>
          <dl class="operator-diagnostic-facts"><div><dt>Phase submission digest</dt><dd>{binding().submissionDigest}</dd></div>
            <div><dt>Phase delivery digest</dt><dd>{binding().deliveryDigest}</dd></div></dl>
        </>}</Show>
        <Show when={operation().hostInference}>{host => <>
          <p>Host attempt index: {host().index} · Charged ordinal: {host().ordinal} · Host inference: {host().status} · Classification: {host().classification}</p>
          <p>Host inference response digest: {available(host().responseDigest)}</p>
        </>}</Show>
        <p>Parent journal metadata does not establish an SDK attempt or originating SDK error. Missing association remains unknown.</p>
      </Show>
      </details>
    </>}</Show>;
  })()}>{event => <>
    <p><strong>{boundaryLabels[event().boundary]}</strong> · {diagnosticWords(event().outcome)}</p>
    <Show when={event().evidence === 'unavailable' || ['failed', 'recovered', 'unknown'].includes(event().outcome)}>
      <p>{event().evidence === 'unavailable' ? 'Evidence for this step is unavailable.'
        : event().outcome === 'failed' ? 'A failure was recorded at this step.'
        : event().outcome === 'recovered' ? 'This step recovered from an earlier problem.'
        : 'The outcome of this step is unknown.'}</p>
    </Show>
    <Show when={event().error?.journal}>{journal => <>
      <p>Root refused final collection: {diagnosticWords(journal().gate)}. Unaccounted operations: {journal().unresolved}; inspected before refusal: {journal().inspectedUnresolved}.</p>
      <p>Observed phase: {journal().phase}. This is a Root journal gate, not a vendor failure or proof that writes occurred.</p>
      <Show when={journal().operationDigest}>{digest => <p>Affected operation digest: <span class="operator-diagnostic-digest">{digest()}</span></p>}</Show>
    </>}</Show>
    <Show when={event().error?.sdkService}>{cause => <p>{sdkServiceCause(cause())}</p>}</Show>
    <Show when={event().error?.transportStatus || event().error?.transportReason}><p>Request failure{event().error?.transportStatus ? ` (HTTP ${event().error!.transportStatus})` : ''}: {event().error?.transportReason === 'execution-inactive'
      ? 'The platform could not confirm this request belonged to an active run.'
      : event().error?.transportReason ? diagnosticWords(event().error!.transportReason!) : 'No further reason was retained.'}</p></Show>
    <details><summary>Record technical details</summary>
    <p class="operator-diagnostic-event-heading"><strong>{event().id}</strong><span>{event().boundary === 'inference-response' ? 'Host inference response' : diagnosticWords(event().boundary)}</span><span>{event().outcome}</span></p>
    <p><time datetime={new Date(event().timestamp).toISOString()}>{new Date(event().timestamp).toLocaleString()}</time> · Owner: {event().owner} · Evidence: {event().evidence} · Record generation: {event().generation}</p>
    <Correlation event={event()} />
    <Show when={props.source}>
      <p>Observed reason: {diagnosticWords(event().code)}</p>
      <Show when={event().error}>{error => <ErrorLineage error={error()} />}</Show>
      <p>Source package: {event().source.package}<Show when={event().source.baseVersion}>{version => <> · Base version: {version()}</>}</Show></p>
      <p>Source status: {event().source.status === 'verified' ? 'verified public mapping' : 'unverified / unavailable'}</p>
      <Show when={event().source.patchSetDigest}><p>Source patch digest: <span class="operator-diagnostic-digest">{event().source.patchSetDigest}</span></p></Show>
      <Show when={event().source.status !== 'verified' || !event().source.frames.some(frame => frame.kind === event().origin)}><p>Observation boundary: {diagnosticWords(event().origin)}</p></Show>
      <ul class="operator-diagnostic-sources" aria-label="Public source references"><For each={event().source.frames}>{frame => <li>
        <Show when={verifiedDiagnosticSourceUrl(event().source, frame)} fallback={<span>Unverified source mapping; no public link.</span>}>{url =>
          <a href={url()} target="_blank" rel="noopener noreferrer">{frame.repository}/{frame.path}:{frame.line}:{frame.column} — {diagnosticWords(frame.kind)}{frame.kind === 'patch-boundary' ? ' mapping (not an original compiled stack frame)' : ' source'}</a>
        }</Show>
      </li>}</For></ul>
    </Show>
    </details>
  </>}</Show>;

const OperatorDiagnosticRecord: Component<{ detail: DiagnosticDetail }> = props => <section class="operator-diagnostic-detail"
  aria-label={`Record ${props.detail.record.id}`}>
  <h4>Record {props.detail.record.id}</h4>
  <details><summary>Record snapshot technical details</summary>
  <p>Record metadata read <time datetime={new Date(props.detail.capturedAt).toISOString()}>{new Date(props.detail.capturedAt).toLocaleString()}</time>; current original-lease binding generation {props.detail.binding.generation}.</p></details>
  <DiagnosticRecordMetadata record={props.detail.record} source />
  <Show when={props.detail.capsule}>{capsule => <div class="operator-diagnostic-capsule">
    <h5>{capsule().kind === 'failure' ? 'Retained failure information' : 'Retained completion information'}</h5>
    <p>{capsule().uncertainty === 'prior-effect-uncertain' ? 'Prior affected effects are uncertain. Do not replay uncertain work.'
      : capsule().uncertainty === 'evidence-incomplete' ? 'Affected-effect evidence is incomplete.' : 'No uncertainty observed in this capsule; this is not proof of absence elsewhere.'}</p>
    <Show when={capsule().loss.length}><p>Some details of this record are missing; the retained information may be incomplete.</p></Show>
    <details><summary>Retained failure and completion technical details</summary>
    <p>Capsule ID: {capsule().id}</p>
    <Show when={props.detail.record.kind !== 'event' || capsule().code !== props.detail.record.code}><p>Capsule reason: {diagnosticWords(capsule().code)}</p></Show>
    <p>Last host-persisted evidence: {capsule().lastHostPersistedId ?? 'Unavailable'}</p>
    <Show when={capsule().sdk}>{sdk => <>
      <p>SDK operational settlement: {sdk().settlement}</p>
      <dl class="operator-diagnostic-facts"><For each={Object.entries(sdk()).filter(([key]) => key !== 'settlement')}>{([key, value]) =>
        <div><dt>{({ rootDigest: 'SDK root digest', submissionDigest: 'SDK submission digest', attemptDigest: 'SDK attempt digest',
          batchSequence: 'SDK batch sequence', producerEpoch: 'SDK producer epoch', producerSequence: 'SDK producer sequence', recordIndex: 'SDK record index' } as Record<string, string>)[key]}</dt><dd>{available(value)}</dd></div>
      }</For></dl>
    </>}</Show>
    <Show when={capsule().error && (props.detail.record.kind !== 'event' || !props.detail.record.error)}>
      <ErrorLineage error={capsule().error!} />
    </Show>
    <ul aria-label="Affected operations"><For each={capsule().affectedOperations}>{operation => <li>
      <p>Affected operation: <span class="operator-diagnostic-digest">{operation.operationDigest}</span></p>
      <p>Effect: {operation.effect} · Status: {operation.status}</p>
    </li>}</For></ul>
    <Show when={capsule().affectedOperationsOmitted != null}><p>Affected operations omitted: {capsule().affectedOperationsOmitted}</p></Show>
    <Show when={capsule().loss.length}><p>Capsule evidence gaps: {capsule().loss.map(diagnosticWords).join(', ')}</p></Show>
    </details>
  </div>}</Show>
</section>;
export default OperatorDiagnosticRecord;
