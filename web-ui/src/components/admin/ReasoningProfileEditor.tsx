/* v8 ignore start -- user-validated administration UI */
import { For, Show, createMemo, createSignal, createUniqueId, onMount, type Component } from 'solid-js';
import { discoverReasoningCompatibility } from '../../api/client';
import { normalizeCustomProfile } from '../../../../src/lib/reasoning-profiles';
import type { PiReasoningLevel, ProfileRevisionRef, ReasoningDiscoveryDiagnostic, ReasoningDiscoveryResult } from '../../types';

interface Props {
  route: string;
  existingRevisions: Array<Record<string, unknown>>;
  onSave: (revision: Record<string, unknown>) => void;
  onSelectProfile: (ref: ProfileRevisionRef) => void;
  onCancel: () => void;
}

function generatedId(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 57).replace(/-+$/g, '');
  const base = slug || 'profile';
  return base === 'custom' || base.startsWith('custom-') ? base : `custom-${base}`;
}

function discoveredLevels(result: ReasoningDiscoveryResult): string {
  const levels = result.profileDraft?.supportedLevels;
  return Array.isArray(levels) && levels.length > 0 ? levels.map(String).join(', ') : 'Not reported';
}

export const DISCOVERY_COMPLETION_TOKENS = 4096;

const DIAGNOSTIC_MESSAGES: Record<string, string> = {
  completion_limit: 'The check was incomplete at the fixed 4096-token budget. Compatibility remains unconfirmed; nothing was changed.',
  no_tool_call: 'The provider did not return the required Pi tool call.',
  invalid_tool_call: 'The provider returned an invalid Pi tool call.',
  replay_rejected: 'The provider rejected the Pi tool-result replay.',
  request_rejected: 'The provider rejected the compatibility request.',
  timeout: 'The compatibility check timed out.',
  transport_error: 'The provider connection failed.',
  malformed_response: 'The provider returned a malformed response.',
  response_too_large: 'The provider response exceeded the safe size limit.',
  off_not_disabled: 'Reasoning remained enabled when checking Off.',
  incomplete_final_response: 'The provider did not complete the final response after tool replay.',
  unsupported_mapping: 'The observed reasoning mapping is not supported.',
  custom_provider_backend_requires_revalidation: 'The declared custom provider backend needs another compatibility check.',
};

function diagnosticMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_MESSAGES, code) ? DIAGNOSTIC_MESSAGES[code] : 'The compatibility check could not be completed.';
}

export function reasoningCheckSummary(result: ReasoningDiscoveryResult, fallback = 'Compatibility could not be confirmed. Nothing was changed.'): string {
  const diagnostics = [...(result.diagnostics ?? []), ...(result.candidateResults?.flatMap((candidate) => candidate.diagnostics ?? []) ?? [])];
  const fatal = diagnostics.find((diagnostic) => ['timeout', 'transport_error', 'malformed_response', 'response_too_large'].includes(diagnostic.code)
    || diagnostic.status === 401 || diagnostic.status === 403 || diagnostic.status === 429 || (diagnostic.status !== undefined && diagnostic.status >= 500));
  if (fatal) return `${diagnosticMessage(fatal.code)} Compatibility check stopped during ${fatal.stage}${fatal.status ? ` (HTTP ${fatal.status})` : ''}. See technical details before retrying.`;
  if (diagnostics.some((diagnostic) => diagnostic.code === 'completion_limit') || result.warnings?.includes('completion_limit')) {
    return diagnosticMessage('completion_limit');
  }
  const candidateClassifications = result.candidateResults?.map((candidate) => candidate.classification.toLowerCase()) ?? [];
  if (result.outcome === 'ambiguous' || result.warnings?.includes('ambiguous_profile_mapping') || candidateClassifications.includes('heterogeneous')) {
    return 'Multiple reasoning behaviors matched. No safe profile was created.';
  }
  const concrete = diagnostics.find((diagnostic) => Object.prototype.hasOwnProperty.call(DIAGNOSTIC_MESSAGES, diagnostic.code));
  if (concrete) return `${diagnosticMessage(concrete.code)} Nothing was changed.`;
  if (result.outcome === 'unsupported' || (!result.outcome && (result.classification.toLowerCase() === 'unsupported' || (candidateClassifications.length > 0 && candidateClassifications.every((classification) => classification === 'unsupported'))))) {
    return 'No compatible reasoning behavior was found. Nothing was changed.';
  }
  return result.outcome === 'inconclusive' ? 'Compatibility could not be confirmed. Nothing was changed.' : fallback;
}

const DiagnosticList: Component<{ diagnostics?: ReasoningDiscoveryDiagnostic[] }> = (props) => <Show when={props.diagnostics?.length}>
  <ul class="admin-warning-list"><For each={props.diagnostics}>{(diagnostic) => <li>
    <p>{diagnosticMessage(diagnostic.code)}</p>
    <small>Levels: {diagnostic.levels.join(', ') || 'Not reported'} · Stage: {diagnostic.stage}<Show when={diagnostic.status}> · HTTP status: {diagnostic.status}</Show><Show when={diagnostic.transport}> · Transport: {diagnostic.transport}</Show></small>
  </li>}</For></ul>
</Show>;

type CheckState = 'passed' | 'failed' | 'unclear';
const LEVEL_LABELS: Record<PiReasoningLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Xhigh', max: 'Max' };
const checkStateLabel = (state: CheckState): string => state === 'passed' ? 'Passed' : state === 'failed' ? 'Failed' : 'Unclear';
const CheckPill: Component<{ label: string; state: CheckState }> = (props) => <span class="admin-check-pill" data-state={props.state} aria-label={`${props.label}: ${checkStateLabel(props.state)}`}>
  {checkStateLabel(props.state)}
</span>;
const CheckCell: Component<{ label: string; state: CheckState }> = (props) => <td aria-label={`${props.label}: ${checkStateLabel(props.state)}`}>
  <CheckPill label={props.label} state={props.state} />
</td>;

function diagnosticState(diagnostics: ReasoningDiscoveryDiagnostic[]): CheckState | undefined {
  if (!diagnostics.length) return undefined;
  const failures = ['no_tool_call', 'invalid_tool_call', 'replay_rejected', 'off_not_disabled', 'unsupported_mapping', 'incomplete_final_response'];
  return diagnostics.some((diagnostic) => !failures.includes(diagnostic.code)
    || diagnostic.status === 401 || diagnostic.status === 403 || diagnostic.status === 429
    || (diagnostic.status !== undefined && diagnostic.status >= 500)) ? 'unclear' : 'failed';
}

// REQ-ENTERPRISE-035: Pi lifecycle evidence is not evidence of graduated reasoning effort.
export const ReasoningCheckOverview: Component<{ result: ReasoningDiscoveryResult; levels: PiReasoningLevel[] }> = (props) => {
  const levelDiagnostics = (level: PiReasoningLevel) => (props.result.diagnostics ?? []).filter((diagnostic) => !diagnostic.levels.length || diagnostic.levels.includes(level));
  const offState = (): CheckState => diagnosticState(levelDiagnostics('off').filter((diagnostic) => diagnostic.stage === 'reasoning'))
    ?? (props.result.reasoningConfiguration?.off === 'verified-disabled' ? 'passed'
      : props.result.reasoningConfiguration?.off === 'not-disabled' ? 'failed' : 'unclear');
  const compatibilityState = (level: PiReasoningLevel): CheckState => {
    const diagnostic = diagnosticState(levelDiagnostics(level));
    if (diagnostic) return diagnostic;
    if (props.result.compatibleLevels?.includes(level)) return 'passed';
    if (props.result.piCompatibility?.verifiedLevels.includes(level)
      && props.result.reasoningConfiguration?.routeHealthVerified === true
      && (level !== 'off' || offState() === 'passed')) return 'passed';
    return 'unclear';
  };
  const toolState = (level: PiReasoningLevel, stage: 'tool-call' | 'tool-replay'): CheckState => {
    const diagnostics = levelDiagnostics(level).filter((diagnostic) => stage === 'tool-call'
      ? diagnostic.stage === 'tool-call'
      : ['tool-call', 'tool-replay', 'final-response'].includes(diagnostic.stage));
    const diagnostic = diagnosticState(diagnostics);
    if (diagnostic) return stage === 'tool-replay' && diagnostics.some((item) => item.stage === 'tool-call') ? 'unclear' : diagnostic;
    return props.result.distinctMappings?.some((mapping) => mapping.levels.includes(level)
      && (mapping.toolLifecycle?.passed === true || (stage === 'tool-call'
        && ['tool-replay', 'final-response'].includes(mapping.toolLifecycle?.stage ?? ''))))
      || props.result.piCompatibility?.verifiedLevels.includes(level) ? 'passed' : 'unclear';
  };
  return <div class="admin-check-overview">
    <table class="admin-check-table">
      <caption>Selected profile checks</caption>
      <thead><tr><th scope="col">Level</th><th scope="col">Compatibility</th><th scope="col">Tool call</th><th scope="col">Tool replay</th></tr></thead>
      <tbody><For each={props.levels}>{(level) => <tr>
        <th scope="row">{LEVEL_LABELS[level]}</th>
        <CheckCell label={`${LEVEL_LABELS[level]} compatibility`} state={compatibilityState(level)} />
        <CheckCell label={`${LEVEL_LABELS[level]} tool call`} state={toolState(level, 'tool-call')} />
        <CheckCell label={`${LEVEL_LABELS[level]} tool replay`} state={toolState(level, 'tool-replay')} />
      </tr>}</For></tbody>
    </table>
    <Show when={props.levels.includes('off')}><div>Off disabled: <CheckPill label="Off disabled" state={offState()} /></div></Show>
  </div>;
};

export const ReasoningCheckDetails: Component<{ result: ReasoningDiscoveryResult }> = (props) => <details class="admin-technical-details admin-inline-technical-details">
  <summary>Technical check details</summary>
  <div class="admin-check-candidate">
    <strong>Check scope</strong>
    <p>Route: {props.result.route ?? 'Not reported'}</p>
    <p>Only the exercised route path and current backend configuration were checked. Accepted level fields do not prove reasoning strength.</p>
    <Show when={!props.result.candidateResults}><DiagnosticList diagnostics={props.result.diagnostics} /></Show>
    <For each={props.result.warnings?.filter((warning) => Object.prototype.hasOwnProperty.call(DIAGNOSTIC_MESSAGES, warning) && !props.result.diagnostics?.some((diagnostic) => diagnostic.code === warning))}>{(warning) => <p class="admin-status-text">{diagnosticMessage(warning)}</p>}</For>
  </div>
  <For each={props.result.candidateResults}>{(candidate) => <div class="admin-check-candidate">
    <strong>{candidate.profileName ?? 'Protocol candidate'}</strong>
    <p>Pi tool lifecycle levels: {candidate.verifiedLevels?.join(', ') || 'None reported'}</p>
    <DiagnosticList diagnostics={candidate.diagnostics} />
  </div>}</For>
  <dl>
    <div><dt>Logical probes</dt><dd>{props.result.accounting?.logicalProbes ?? 'Not reported'}</dd></div>
    <div><dt>HTTP attempts</dt><dd>{props.result.accounting?.httpAttempts ?? 'Not reported'}</dd></div>
  </dl>
</details>;

const ReasoningProfileEditor: Component<Props> = (props) => {
  let heading!: HTMLHeadingElement;
  onMount(() => { heading.focus(); void discover(); });
  const [result, setResult] = createSignal<ReasoningDiscoveryResult>();
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const id = createMemo(() => generatedId(name()));
  const revision = createMemo(() => Math.max(0, ...props.existingRevisions
    .filter((item) => item.id === id())
    .map((item) => typeof item.revision === 'number' ? item.revision : 0)) + 1);
  const matchedProfiles = createMemo(() => result()?.assignable === true ? result()?.matchedProfiles ?? [] : []);
  const customDraft = createMemo(() => {
    const discovered = result();
    return discovered?.assignable === true && !discovered.matchedProfiles?.length && (!discovered.outcome || discovered.outcome === 'custom-profile')
      ? discovered.profileDraft
      : undefined;
  });

  const discover = async () => {
    if (busy()) return;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await discoverReasoningCompatibility({ route: props.route, maxCompletionTokens: DISCOVERY_COMPLETION_TOKENS }));
    } catch {
      setError('Compatibility check failed. Check the saved AI Gateway connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const discovered = customDraft();
    if (!discovered) {
      setError('Run a successful compatibility check before continuing.');
      return;
    }
    if (!name().trim()) {
      setError('Profile name is required.');
      return;
    }
    try {
      const normalized = normalizeCustomProfile({ ...discovered, id: id(), name: name().trim(), revision: revision() });
      setError('');
      props.onSave({ ...normalized });
    } catch {
      setError('The generated profile could not be prepared for assignment. Nothing was changed. Run Map Profile again.');
    }
  };

  return <section class="admin-profile-editor admin-form-wide" aria-labelledby="custom-profile-heading" onKeyDown={(event) => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <div class="admin-subsection-heading">
      <div>
        <p class="admin-step-label">Compatibility check</p>
        <h5 id="custom-profile-heading" tabIndex={-1} ref={heading}>Discover compatibility for {props.route}</h5>
        <p>Codeflare checks which safe reasoning behavior this route supports. It does not change the route, assign a profile, or activate anything.</p>
      </div>
      <button type="button" class="admin-link-button" onClick={props.onCancel}>Cancel</button>
    </div>
    <Show when={error()}><div class="admin-inline-error" role="alert">{error()}</div></Show>

    <Show when={busy()}><p class="admin-status-text" role="status">Mapping profile…</p></Show>

    <Show when={result()}>{(discovered) => <div aria-live="polite">
      <Show when={matchedProfiles().length > 0}>
        <div class="admin-discovery-success">
          <strong>Compatible reasoning profiles found</strong>
          <p>These profiles fit the observed safe reasoning behavior. This does not identify the backend model.</p>
          <span>Assign a profile to this route draft, then Save. Nothing is saved or activated by this check.</span>
        </div>
        <For each={matchedProfiles()}>{(profile) => {
          const nameId = createUniqueId();
          return <div class="admin-profile-match">
            <div><strong id={nameId}>{profile.name}</strong><span>Supported levels: {profile.supportedLevels.join(', ') || 'Not reported'}</span></div>
            <button type="button" class="admin-secondary-button" aria-describedby={nameId} onClick={() => props.onSelectProfile(profile.profileRef)}>Assign profile</button>
          </div>;
        }}</For>
      </Show>
      <Show when={customDraft()}>
        <div class="admin-discovery-success">
          <strong>Compatible reasoning behavior found</strong>
          <p>A profile draft is available for explicit assignment. Tool compatibility does not prove reasoning strength.</p>
          <span>Supported levels: {discoveredLevels(discovered())}</span>
        </div>
        <label class="admin-form-field admin-profile-name"><span>Profile name</span><input aria-label="Profile name" maxlength="128" placeholder={`For example, ${props.route} reasoning`} value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
        <div class="admin-review-action">
          <div><strong>Assign to {props.route}</strong><span>Create this named profile and assign it to the route draft. Nothing is stored until Save is confirmed.</span></div>
          <button type="button" class="admin-primary-button" onClick={save}>Create &amp; Assign</button>
        </div>
      </Show>
      <Show when={matchedProfiles().length === 0 && !customDraft()}><div class="admin-inline-error" role="alert">{reasoningCheckSummary(discovered())}</div></Show>
      <ReasoningCheckDetails result={discovered()} />
    </div>}</Show>
  </section>;
};

export default ReasoningProfileEditor;
/* v8 ignore stop */
