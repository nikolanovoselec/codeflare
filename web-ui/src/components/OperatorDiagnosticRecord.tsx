import { For, Show, type Component } from 'solid-js';
import { verifiedDiagnosticSourceUrl, type DiagnosticDetail, type DiagnosticErrorMetadata,
  type DiagnosticEvent, type DiagnosticRecord } from '../api/operator-diagnostics-wire';

export const diagnosticWords = (value: string) => value.replace(/-/g, ' ');
const available = (value: number | string | null | undefined) => value == null ? 'Unavailable' : String(value);
const coordinates: Record<keyof DiagnosticEvent['correlation'], string> = {
  logicalOrdinal: 'Logical ordinal', hostAttemptIndex: 'Host attempt index', chargedOrdinal: 'Charged ordinal',
  sdkAttemptDigest: 'SDK attempt digest', submissionDigest: 'Submission digest', deliveryDigest: 'Delivery digest',
  requestDigest: 'Request digest', responseDigest: 'Host response digest', rootDigest: 'SDK root digest',
  streamIncarnationDigest: 'Stream incarnation digest', sdkBatchSequence: 'SDK batch sequence',
  sdkProducerEpoch: 'SDK producer epoch', sdkProducerSequence: 'SDK producer sequence', sdkRecordIndex: 'SDK record index',
};
const Correlation: Component<{ event: DiagnosticEvent }> = props => <dl class="operator-diagnostic-facts">
  <For each={Object.entries(coordinates)}>{([key, label]) => <Show when={Object.prototype.hasOwnProperty.call(props.event.correlation, key)}>
    <div><dt>{label}</dt><dd>{available(props.event.correlation[key as keyof DiagnosticEvent['correlation']])}</dd></div>
  </Show>}</For>
  <Show when={!Object.keys(props.event.correlation).length}><div><dt>Correlation</dt><dd>Unavailable; identities are not inferred.</dd></div></Show>
</dl>;
const ErrorLineage: Component<{ error: DiagnosticErrorMetadata }> = props => <div class="operator-diagnostic-lineage">
  <p>Error kind: {props.error.kind}</p>
  <Show when={props.error.publicCode}><p>Public error code: {props.error.publicCode}</p></Show>
  <p>Fingerprint scope: {props.error.fingerprintScope}. Fingerprints are not error messages.</p>
  <dl class="operator-diagnostic-facts"><div><dt>Message fingerprint</dt><dd>{available(props.error.messageDigest)}</dd></div>
    <div><dt>Stack fingerprint</dt><dd>{available(props.error.stackDigest)}</dd></div></dl>
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
        <p>Legacy operation metadata does not supply an SDK attempt, diagnostic sequence, or retrospective error.</p>
      </Show>
    </>}</Show>;
  })()}>{event => <>
    <p class="operator-diagnostic-event-heading"><strong>{event().id}</strong><span>{event().boundary === 'inference-response' ? 'Host inference response' : diagnosticWords(event().boundary)}</span><span>{event().outcome}</span></p>
    <p><time datetime={new Date(event().timestamp).toISOString()}>{new Date(event().timestamp).toLocaleString()}</time> · Owner: {event().owner} · Evidence: {event().evidence} · Record generation: {event().generation}</p>
    <Correlation event={event()} />
    <Show when={props.source}>
      <p>Observed reason: {diagnosticWords(event().code)}</p>
      <Show when={event().error}>{error => <ErrorLineage error={error()} />}</Show>
      <p>Source package: {event().source.package} · Base version: {event().source.baseVersion ?? 'Unavailable'}</p>
      <p>Source status: {event().source.status === 'verified' ? 'verified public mapping' : 'unverified / unavailable'}</p>
      <Show when={event().source.patchSetDigest}><p>Source patch digest: <span class="operator-diagnostic-digest">{event().source.patchSetDigest}</span></p></Show>
      <Show when={event().source.status !== 'verified' || !event().source.frames.some(frame => frame.kind === event().origin)}><p>Observation boundary: {diagnosticWords(event().origin)}</p></Show>
      <ul class="operator-diagnostic-sources" aria-label="Public source references"><For each={event().source.frames}>{frame => <li>
        <Show when={verifiedDiagnosticSourceUrl(event().source, frame)} fallback={<span>Unverified source mapping; no public link.</span>}>{url =>
          <a href={url()} target="_blank" rel="noopener noreferrer">{frame.repository}/{frame.path}:{frame.line}:{frame.column} — {diagnosticWords(frame.kind)}{frame.kind === 'patch-boundary' ? ' mapping (not an original compiled stack frame)' : ' source'}</a>
        }</Show>
      </li>}</For></ul>
    </Show>
  </>}</Show>;

const OperatorDiagnosticRecord: Component<{ detail: DiagnosticDetail }> = props => <section class="operator-diagnostic-detail"
  aria-label={`Record ${props.detail.record.id}`}>
  <h4>Record {props.detail.record.id}</h4>
  <p>Record metadata read <time datetime={new Date(props.detail.capturedAt).toISOString()}>{new Date(props.detail.capturedAt).toLocaleString()}</time>; current original-lease binding generation {props.detail.binding.generation}.</p>
  <DiagnosticRecordMetadata record={props.detail.record} source />
  <Show when={props.detail.capsule}>{capsule => <div class="operator-diagnostic-capsule">
    <h5>{capsule().kind === 'failure' ? 'Retained failure capsule' : 'Retained terminal capsule'} {capsule().id}</h5>
    <Show when={props.detail.record.kind !== 'event' || capsule().code !== props.detail.record.code}><p>Capsule reason: {diagnosticWords(capsule().code)}</p></Show>
    <p>Last host-persisted evidence: {capsule().lastHostPersistedId ?? 'Unavailable'}</p>
    <p>{capsule().uncertainty === 'prior-effect-uncertain' ? 'Prior affected effects are uncertain. Do not replay uncertain work.'
      : capsule().uncertainty === 'evidence-incomplete' ? 'Affected-effect evidence is incomplete.' : 'No uncertainty observed in this capsule; this is not proof of absence elsewhere.'}</p>
    <Show when={capsule().sdk} fallback={<p>SDK capsule coordinates and operational settlement unavailable.</p>}>{sdk => <>
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
    <p>Affected operations omitted: {available(capsule().affectedOperationsOmitted)}</p>
    <Show when={capsule().loss.length}><p>Capsule evidence gaps: {capsule().loss.map(diagnosticWords).join(', ')}</p></Show>
  </div>}</Show>
</section>;
export default OperatorDiagnosticRecord;
