/* v8 ignore start -- user-validated administration UI */
import { For, Show, createMemo, createSignal, onMount, type Component } from 'solid-js';
import { discoverReasoningCompatibility } from '../../api/client';
import { normalizeCustomProfile } from '../../../../src/lib/reasoning-profiles';
import type { ProfileRevisionRef, ReasoningDiscoveryDiagnostic, ReasoningDiscoveryResult } from '../../types';

interface Props {
  route: string;
  startOnMount?: boolean;
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

export function completionTokenCeiling(value: string): number | undefined {
  const ceiling = Number(value);
  return Number.isInteger(ceiling) && ceiling >= 32 && ceiling <= 16384 ? ceiling : undefined;
}

const DIAGNOSTIC_MESSAGES: Record<string, string> = {
  completion_limit: 'The check was incomplete at the chosen token budget. Increase the completion token ceiling explicitly, then run the check again.',
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

export const ReasoningCheckDetails: Component<{ result: ReasoningDiscoveryResult }> = (props) => <>
  <details class="admin-technical-details admin-inline-technical-details">
    <summary>Technical check details</summary>
    <Show when={!props.result.candidateResults?.length}><DiagnosticList diagnostics={props.result.diagnostics} /></Show>
    <For each={props.result.warnings?.filter((warning) => Object.prototype.hasOwnProperty.call(DIAGNOSTIC_MESSAGES, warning) && !props.result.diagnostics?.some((diagnostic) => diagnostic.code === warning))}>{(warning) => <p class="admin-status-text">{diagnosticMessage(warning)}</p>}</For>
    <dl>
      <div><dt>Logical probes</dt><dd>{props.result.accounting?.logicalProbes ?? 'Not reported'}</dd></div>
      <div><dt>HTTP attempts</dt><dd>{props.result.accounting?.httpAttempts ?? 'Not reported'}</dd></div>
    </dl>
    <Show when={props.result.requestedCompletionCeiling !== undefined}><p>Completion token ceiling: {props.result.requestedCompletionCeiling}</p></Show>
    <For each={props.result.candidateResults}>{(candidate) => <div class="admin-profile-summary">
      <strong>{candidate.profileName ?? 'Protocol candidate'}</strong>
      <span>Verified levels: {candidate.verifiedLevels?.join(', ') || 'None reported'}</span>
      <DiagnosticList diagnostics={candidate.diagnostics} />
    </div>}</For>
  </details>
</>;

const ReasoningProfileEditor: Component<Props> = (props) => {
  let heading!: HTMLHeadingElement;
  onMount(() => { heading.focus(); if (props.startOnMount) void discover(); });
  const [result, setResult] = createSignal<ReasoningDiscoveryResult>();
  const [name, setName] = createSignal('');
  const [ceiling, setCeiling] = createSignal('4096');
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
    const maxCompletionTokens = completionTokenCeiling(ceiling());
    if (maxCompletionTokens === undefined) {
      setError('Completion token ceiling must be a whole number from 32 to 16384.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await discoverReasoningCompatibility({ route: props.route, maxCompletionTokens }));
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
    <details class="admin-technical-details"><summary>Advanced mapping controls</summary>
    <label class="admin-form-field admin-profile-name"><span>Discovery completion token ceiling</span><input type="number" min="32" max="16384" step="1" value={ceiling()} disabled={busy()} onInput={(event) => setCeiling(event.currentTarget.value)} /></label>
    <div class="admin-discovery-callout">
      <div><strong>Ready to check</strong><span>This uses the saved AI Gateway connection and may create provider usage. Codeflare never retries at a higher ceiling automatically.</span></div>
      <button type="button" class="admin-primary-button" disabled={busy()} onClick={() => void discover()}>{busy() ? 'Checking…' : 'Check compatibility'}</button>
    </div>
    </details>

    <Show when={result()}>{(discovered) => <section class="admin-profile-section" aria-live="polite">
      <Show when={matchedProfiles().length > 0}>
        <div class="admin-discovery-success">
          <strong>Compatible reasoning profiles found</strong>
          <p>These profiles fit the observed safe reasoning behavior. This does not identify the backend model.</p>
          <span>Assign a profile to this route draft, then Save. Nothing is saved or activated by this check.</span>
        </div>
        <For each={matchedProfiles()}>{(profile) => <div class="admin-review-action">
          <div><strong>{profile.name}</strong><span>Supported levels: {profile.supportedLevels.join(', ') || 'Not reported'}</span></div>
          <button type="button" class="admin-primary-button" onClick={() => props.onSelectProfile(profile.profileRef)}>Assign {profile.name}</button>
        </div>}</For>
      </Show>
      <Show when={customDraft()}>
        <div class="admin-discovery-success">
          <strong>Compatible reasoning behavior found</strong>
          <p>The route completed bounded reasoning, Pi tool-call, and tool-result replay checks.</p>
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
    </section>}</Show>
  </section>;
};

export default ReasoningProfileEditor;
/* v8 ignore stop */
