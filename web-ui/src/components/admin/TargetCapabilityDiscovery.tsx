import { For, Show, type Component, type JSX } from 'solid-js';
import type { TargetDiscoveryResult } from '../../lib/target-capability-contract';
import { ReasoningDiscoveryDiagnosticSchema } from '../../lib/schemas';
import { DiagnosticList, reasoningCheckSummary } from './ReasoningProfileEditor';
import { MAX_CAPABILITY_SUBMISSIONS } from '../../../../src/lib/ai-capability-discovery/contract';

/** Presentation only. The parent owns draft identity, current evidence and Save
 * eligibility; discovery never saves or needs a second verification step. */
export const TargetCapabilityDiscovery: Component<{ label: string; disabled: boolean; busy: boolean;
  onDiscover: () => void }> = (props) => <section class="admin-target-discovery" aria-label={`${props.label} capability discovery`}>
  <button type="button" class="admin-primary-button" aria-label={`Discover capabilities for ${props.label}`}
    disabled={props.disabled || props.busy} onClick={props.onDiscover}>{props.busy ? 'Discovering…' : 'Discover'}</button>
  <p class="admin-field-help">Discover selects and verifies a working configuration. No profile choice or second Verify step is needed after success.</p>
  <p class="admin-field-help">Uses provider credits · up to {MAX_CAPABILITY_SUBMISSIONS} submissions.</p>
  <details class="admin-discovery-budget"><summary>Live check cost and limits</summary>
    <p>This explicit check uses synthetic provider requests (at most {MAX_CAPABILITY_SUBMISSIONS} submissions, 2,048 output tokens each, 90 seconds per request and 10 minutes overall). It never changes Gateway settings or executes a real tool.</p>
    <p>Minimum requires tools with replay and cache reuse. Provider-default reasoning is accepted. Optimal adds incremental streaming.</p>
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

export const DiscoveryCheckEvidence: Component<{ result: TargetDiscoveryResult }> = (props) => <>
  <p>{props.result.assignable ? props.result.explanation : reasoningCheckSummary({ classification: props.result.classification,
    diagnostics: props.result.attempts.at(-1)?.diagnostics.flatMap((entry) => {
      const parsed = ReasoningDiscoveryDiagnosticSchema.safeParse(entry); return parsed.success ? [parsed.data] : [];
    }) }, props.result.explanation)}</p>
  <details class="admin-technical-details"><summary>Discovery details</summary>
    <Show when={props.result.assignable && props.result.capabilities}>{(evidence) => <dl class="admin-check-evidence">
      <div><dt>Tools / exact replay</dt><dd>{evidence().tools && evidence().replay ? 'Verified' : 'Not established'}</dd></div>
      <div><dt>Cache evidence</dt><dd>{evidence().cache === 'gateway-response' ? 'Gateway HIT (whole-response reuse)' : evidence().cache === 'provider-prefix' ? 'Provider input-prefix read' : 'Inconclusive'}</dd></div>
      <div><dt>Reasoning</dt><dd>{evidence().reasoning === 'provider-default' ? 'Provider default — all seven Pi preferences normalize here; no Off claim' : evidence().reasoning === 'observed-enabled' ? 'Enabled with the tested normalized mapping' : 'Control accepted; reasoning unverified'}</dd></div>
      <div><dt>Delivery</dt><dd>{evidence().streaming === 'incremental' ? 'Incremental public deltas observed before completion' : 'Incremental delivery not established; may be buffered'}</dd></div>
    </dl>}</Show>
    <p>Evidence covers the exercised backend path only, not other branches or fallback models.</p>
    <ul><For each={props.result.attempts}>{(attempt) => <li>{attempt.classification} · {attempt.httpAttempts} submissions · {attempt.capabilities?.grade ?? 'Not qualified'}
      <DiagnosticList diagnostics={attempt.diagnostics.flatMap((entry) => {
        const parsed = ReasoningDiscoveryDiagnosticSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })} />
    </li>}</For></ul>
  </details>
</>;
