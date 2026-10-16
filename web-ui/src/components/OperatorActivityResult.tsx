import { For, Show } from 'solid-js';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const readable = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 1000 && !/[\p{Cc}]/u.test(value) ? value : null;
const unavailableEvidence = 'Content unavailable (not safely readable)';
const assessmentText = (value: unknown): string | null => typeof value === 'string' && value.length <= 65_536
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : null;
const repositoryPath = (value: unknown): string | null => typeof value === 'string' && value.length <= 201
  && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;

/** Present only understood, bounded report fields; never stringify an opaque result payload. */
export default function OperatorActivityResult(props: { result: unknown }) {
  const data = record(props.result);
  if (!data) return <p>Result format unavailable. Check the activity status before acting.</p>;
  if (readable(data.repository) && Array.isArray(data.results) && data.results.length <= 1024) {
    return <div class="operator-activity-reports">
      <h4>Pull request outcomes</h4><Show when={repositoryPath(data.repository)}><p>Repository: {repositoryPath(data.repository)}</p></Show>
      <Show when={data.results.length} fallback={<p>No eligible pull requests discovered.</p>}>
        <For each={data.results}>{value => {
          const item = record(value);
          const number = typeof item?.pullRequest === 'number' && Number.isSafeInteger(item.pullRequest) && item.pullRequest > 0 ? item.pullRequest : null;
          const repository = repositoryPath(data.repository);
          const prUrl = repository && number ? `https://github.com/${repository}/pull/${number}` : null;
          return <article class="operator-result-item">
            <h5><Show when={prUrl} fallback={number ? `PR #${number}` : unavailableEvidence}>
              <a href={prUrl!} target="_blank" rel="noopener noreferrer">PR #{number}</a>
            </Show></h5>
            <p><strong>Outcome: {readable(item?.outcome) || unavailableEvidence}</strong></p>
            <p>Decision: {readable(item?.decision) || unavailableEvidence}</p>
            <Show when={item?.comment !== undefined}><Show when={assessmentText(item?.comment)} fallback={<p>{unavailableEvidence}</p>}>
              {comment => <details><summary>Read full assessment</summary><p class="operator-full-assessment">{comment()}</p></details>}
            </Show></Show>
            <Show when={prUrl && typeof item?.commentId === 'number' && Number.isSafeInteger(item.commentId) && item.commentId > 0}>
              <a href={`${prUrl}#issuecomment-${item?.commentId}`} target="_blank" rel="noopener noreferrer">Posted assessment</a>
            </Show>
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

