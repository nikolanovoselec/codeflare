import { For, Show, type Component } from 'solid-js';
import type { TargetDiscoveryResult } from '../../lib/target-capability-contract';
import { MAX_CAPABILITY_SUBMISSIONS } from '../../../../src/lib/ai-capability-discovery/contract';

/** Presentation only. The parent owns editable target identity and stale-result
 * protection; the server owns credentials, search, evidence and Save authority.
 * Deliberately no profile chooser, editable mapping or second Verify step. */
export const TargetCapabilityDiscovery: Component<{ label: string; disabled: boolean; busy: boolean;
  result?: TargetDiscoveryResult; onDiscover: () => void }> = (props) => <section aria-label={`${props.label} capability discovery`}>
  <button type="button" class="admin-primary-button" aria-label={`Discover capabilities for ${props.label}`}
    disabled={props.disabled || props.busy} onClick={props.onDiscover}>{props.busy ? 'Discovering…' : 'Discover'}</button>
  <p class="admin-field-help">Automatically finds and verifies a working configuration. Minimum: tools with replay and cache reuse. Provider-default reasoning is accepted. Optimal adds incremental streaming. Review the result, then Save to enable it.</p>
  <p class="admin-field-help">This explicit check uses synthetic provider requests (at most {MAX_CAPABILITY_SUBMISSIONS} submissions, 2,048 output tokens each, 90 seconds per request and 10 minutes overall). It never changes Gateway settings or executes a real tool.</p>
  <Show when={props.busy}><p role="status">Testing tools, cache reuse, reasoning and delivery for {props.label}…</p></Show>
  <Show when={props.result}>{(result) => <div role={result().assignable ? 'status' : 'alert'}>
    <strong>{result().assignable ? result().capabilities?.grade : 'Minimum not established'}</strong>
    <p>{result().explanation}</p>
    <Show when={result().capabilities}>{(evidence) => <dl>
      <div><dt>Tools / exact replay</dt><dd>{evidence().tools && evidence().replay ? 'Verified' : 'Not established'}</dd></div>
      <div><dt>Cache evidence</dt><dd>{evidence().cache === 'gateway-response' ? 'Gateway HIT (whole-response reuse)' : evidence().cache === 'provider-prefix' ? 'Provider input-prefix read' : 'Inconclusive'}</dd></div>
      <div><dt>Reasoning</dt><dd>{evidence().reasoning === 'provider-default' ? 'Provider default — all seven Pi preferences normalize here; no Off claim' : evidence().reasoning === 'observed-enabled' ? 'Enabled with the tested normalized mapping' : 'Control accepted; reasoning unverified'}</dd></div>
      <div><dt>Delivery</dt><dd>{evidence().streaming === 'incremental' ? 'Incremental public deltas observed before completion' : 'Incremental delivery not established; may be buffered'}</dd></div>
    </dl>}</Show>
    <p>Evidence covers the exercised backend path only, not other branches or fallback models.</p>
    <details><summary>Discovery attempts</summary><ul><For each={result().attempts}>{(attempt) => <li>{attempt.classification} · {attempt.httpAttempts} submissions · {attempt.capabilities?.grade ?? 'Not qualified'}
      <For each={attempt.diagnostics}>{(entry) => { const diagnostic = entry as { stage?: string; code?: string; status?: number; providerCode?: string | number; providerType?: string }; return <small> {diagnostic.stage}: {diagnostic.code}{diagnostic.status ? ` (HTTP ${diagnostic.status})` : ''}{diagnostic.providerCode !== undefined ? ` · ${diagnostic.providerCode}` : ''}{diagnostic.providerType ? ` · ${diagnostic.providerType}` : ''}</small>; }}</For>
    </li>}</For></ul></details>
  </div>}</Show>
</section>;
