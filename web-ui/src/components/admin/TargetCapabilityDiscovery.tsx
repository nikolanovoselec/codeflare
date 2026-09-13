import { For, Show, type Component, type JSX } from 'solid-js';
import type { TargetDiscoveryResult } from '../../lib/target-capability-contract';
import { ReasoningDiscoveryDiagnosticSchema } from '../../lib/schemas';
import { DiagnosticList } from './ReasoningProfileEditor';
import { MAX_CAPABILITY_SUBMISSIONS, type CapabilitySummary } from '../../../../src/lib/ai-capability-discovery/contract';
import type { ReasoningProfileCatalogEntry } from '../../types';

/** Presentation only. The parent owns draft identity, current evidence and Save
 * eligibility; discovery never saves or needs a second verification step. */
export const TargetCapabilityDiscovery: Component<{ label: string; disabled: boolean; busy: boolean;
  onDiscover: () => void }> = (props) => <section class="admin-target-discovery" aria-label={`${props.label} capability discovery`}>
  <button type="button" class="admin-primary-button" aria-label={`Discover capabilities for ${props.label}`}
    disabled={props.disabled || props.busy} onClick={props.onDiscover}>{props.busy ? 'Discovering…' : 'Discover'}</button>
  <p class="admin-field-help">Discover selects and verifies a working configuration. No profile choice or second Verify step is needed after success.</p>
  <p class="admin-field-help">Uses provider credits: at most {MAX_CAPABILITY_SUBMISSIONS} submissions, 2,048 output tokens each, 90 seconds per request and 10 minutes overall.</p>
  <details class="admin-discovery-budget"><summary>Live check details</summary>
    <p>This explicit check uses synthetic provider requests. It never changes Gateway settings or executes a real tool.</p>
    <p>Tool calling with exact replay, reasoning, streaming and input caching are reported independently. Missing cache reuse does not prevent review. Provider-default reasoning remains provider-controlled.</p>
  </details>
</section>;

/** One always-visible result location shared by normal and Advanced actions.
 * The parent supplies the current source; this component grants no authority. */
export const TargetCheckResult: Component<{ title: string; ready?: boolean; busy?: boolean; progressLabel?: string; failed?: boolean; children?: JSX.Element }> = (props) =>
  <section class="admin-target-check-result" aria-label="Check result" data-state={props.ready ? 'passed' : props.failed ? 'failed' : 'unclear'} aria-busy={Boolean(props.busy)}>
    <h4>Check result</h4>
    <div role={props.failed ? 'alert' : 'status'}>
      <Show when={props.busy} fallback={<><strong>{props.title}</strong>{props.children}</>}>
        <div class="admin-inline-progress"><progress aria-label={props.progressLabel ?? props.title} /><span>{props.title}</span></div>
      </Show>
      <Show when={props.ready}><p class="admin-check-next-step">Next: set access as needed, choose <b>Review changes</b>, then <b>Confirm Save</b>. Saved changes apply at the next normal session start.</p></Show>
    </div>
  </section>;

type MappingEvidence = Extract<CapabilitySummary, { schemaVersion: 2 }>['mappings'][number];
type EvidenceRow = Omit<MappingEvidence, 'transport'> & { scope: string };
const levelLabel = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);
const transportLabel: Record<MappingEvidence['transport'], string> = {
  rest: 'REST', compat: 'Compatibility', 'bedrock-invoke': 'Bedrock Invoke', 'bedrock-eventstream': 'Bedrock Eventstream',
};
function evidenceRows(summary: CapabilitySummary | undefined, profile?: Pick<ReasoningProfileCatalogEntry, 'aliases'>): EvidenceRow[] {
  if (!summary) return [];
  if (summary.schemaVersion === 1) return [{ ...summary, levels: [],
    reasoning: summary.reasoning === 'unverified' ? 'accepted-unverified' : summary.reasoning, scope: 'Exercised path · legacy evidence' }];
  return summary.mappings.map((mapping) => ({ ...mapping, scope: `${mapping.levels.length
    ? mapping.levels.map((level) => profile?.aliases?.[level] ? `${levelLabel(level)} → ${levelLabel(profile.aliases[level]!)} (alias)` : levelLabel(level)).join(', ')
    : 'Provider default'} · ${transportLabel[mapping.transport]}` }));
}
const reasoningFact = (row: EvidenceRow): string => row.reasoning === 'provider-default'
  ? 'Provider-controlled; no explicit override is sent. Off is not verified.'
  : row.reasoning === 'verified-disabled' ? 'Off verified disabled'
    : row.reasoning === 'observed-enabled' ? 'Reasoning observed with this mapping; strength not measured'
      : row.reasoning === 'accepted-unverified' ? 'Control accepted; reasoning unverified' : 'Not tested';
const streamingFact = (row: EvidenceRow): string => row.streaming === 'incremental' ? 'Incremental public deltas observed before completion'
  : row.streaming === 'not-tested' ? 'Not tested' : 'Incremental delivery not observed; delivery may be buffered';
const cacheFact = (row: EvidenceRow): string => row.cache === 'provider-prefix' ? 'Provider-prefix read verified'
  : row.cache === 'not-tested' ? 'Not tested' : 'Not observed — input-prefix reuse remains inconclusive';
const toolFact = (row: EvidenceRow): string => row.tools && row.replay ? 'Verified with exact replay'
  : row.tools ? 'Tool call succeeded; exact replay not verified' : 'Not verified';
// Historical result prose can contain retired rankings, but never display them as current capability claims.
const resultText = (text: string) => text.replace(/\bNot qualified\b/gi, 'Not ready for review')
  .replace(/\bMinimum\b/gi, 'Required checks').replace(/\b(?:Acceptable|Optimal)\b/gi, 'Checks complete');

/** REQ-ENTERPRISE-041/074: four independent facts, scoped per mapping; no authority is inferred here. */
export const CapabilityEvidence: Component<{ summaries: CapabilitySummary[]; profile?: Pick<ReasoningProfileCatalogEntry, 'aliases'> }> = (props) => {
  const rows = () => props.summaries.flatMap((summary) => evidenceRows(summary, props.profile));
  const facts: Array<{ label: string; fact: (row: EvidenceRow) => string }> = [
    { label: 'Tool calling', fact: toolFact }, { label: 'Reasoning', fact: reasoningFact },
    { label: 'Streaming', fact: streamingFact }, { label: 'Input caching', fact: cacheFact },
  ];
  return <dl class="admin-check-evidence"><For each={facts}>{(category) => <div>
    <dt>{category.label}</dt><dd><Show when={rows().length} fallback="Not established">
      <ul class="admin-capability-mappings"><For each={rows()}>{(row) => <li><strong>{row.scope}</strong><span>{category.fact(row)}</span></li>}</For></ul>
    </Show></dd>
  </div>}</For></dl>;
};

export const DiscoveryCheckEvidence: Component<{ result: TargetDiscoveryResult }> = (props) => {
  const summaries = () => props.result.capabilities ? [props.result.capabilities] : props.result.attempts.flatMap((attempt) => attempt.capabilities ? [attempt.capabilities] : []);
  const gatewayHit = () => summaries().some((summary) => evidenceRows(summary).some((row) => row.cache === 'gateway-response'));
  return <>
    <p>{resultText(props.result.explanation)}</p>
    <CapabilityEvidence summaries={summaries()} profile={props.result.profile} />
    <details class="admin-technical-details"><summary>Discovery details</summary>
      <p>Evidence covers the exercised backend path only, not other branches or fallback models.</p>
      <Show when={gatewayHit()}><p>Gateway HIT is whole-response reuse, not verified input-prefix caching.</p></Show>
      <ul><For each={props.result.attempts}>{(attempt) => <li>{resultText(attempt.classification)} · {attempt.httpAttempts} submissions
        <DiagnosticList diagnostics={attempt.diagnostics.flatMap((entry) => {
          const parsed = ReasoningDiscoveryDiagnosticSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })} />
      </li>}</For></ul>
    </details>
  </>;
};
