/* v8 ignore start -- user-validated administration UI */
import { Show, createMemo, createSignal, onMount, type Component } from 'solid-js';
import { discoverReasoningCompatibility } from '../../api/client';
import type { ReasoningDiscoveryResult } from '../../types';

interface Props {
  route: string;
  existingRevisions: Array<Record<string, unknown>>;
  onSave: (revision: Record<string, unknown>) => void;
  onCancel: () => void;
}

function generatedId(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 57).replace(/-+$/g, '');
  const base = slug || 'profile';
  return base === 'custom' || base.startsWith('custom-') ? base : `custom-${base}`;
}

function unsuccessfulOutcome(result: ReasoningDiscoveryResult): string {
  const candidateClassifications = result.candidateResults?.map((candidate) => candidate.classification.toLowerCase()) ?? [];
  if (result.warnings?.includes('ambiguous_profile_mapping') || candidateClassifications.includes('heterogeneous')) {
    return 'Multiple reasoning behaviors matched. No safe profile was created.';
  }
  if (result.classification.toLowerCase() === 'unsupported' || (candidateClassifications.length > 0 && candidateClassifications.every((classification) => classification === 'unsupported'))) {
    return 'No compatible reasoning behavior was found. Nothing was changed.';
  }
  return 'Compatibility could not be confirmed. Nothing was changed.';
}

const ReasoningProfileEditor: Component<Props> = (props) => {
  let editor!: HTMLElement;
  let heading!: HTMLHeadingElement;
  onMount(() => heading.focus());
  const [result, setResult] = createSignal<ReasoningDiscoveryResult>();
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const id = createMemo(() => generatedId(name()));
  const revision = createMemo(() => Math.max(0, ...props.existingRevisions
    .filter((item) => item.id === id())
    .map((item) => typeof item.revision === 'number' ? item.revision : 0)) + 1);

  const discover = async () => {
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await discoverReasoningCompatibility({ route: props.route, maxCompletionTokens: 512 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Compatibility check failed.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const discovered = result()?.profileDraft;
    if (!discovered || result()?.assignable !== true) {
      setError('Run a successful compatibility check before continuing.');
      return;
    }
    if (!name().trim()) {
      setError('Profile name is required.');
      return;
    }
    const form = editor.closest('form');
    setError('');
    props.onSave({ ...discovered, id: id(), name: name().trim(), revision: revision() });
    queueMicrotask(() => form?.requestSubmit());
  };

  return <section ref={editor} class="admin-profile-editor admin-form-wide" aria-labelledby="custom-profile-heading">
    <div class="admin-subsection-heading">
      <div>
        <p class="admin-step-label">Compatibility check</p>
        <h5 id="custom-profile-heading" tabIndex={-1} ref={heading}>Discover compatibility for {props.route}</h5>
        <p>Codeflare checks which safe reasoning behavior this route supports. It does not change the route, assign a profile, or activate anything.</p>
      </div>
      <button type="button" class="admin-link-button" onClick={props.onCancel}>Cancel</button>
    </div>
    <Show when={error()}><div class="admin-inline-error" role="alert">{error()}</div></Show>

    <div class="admin-discovery-callout">
      <div><strong>Ready to check</strong><span>This uses the saved AI Gateway connection and may create provider usage.</span></div>
      <button type="button" class="admin-primary-button" disabled={busy()} onClick={() => void discover()}>{busy() ? 'Checking…' : 'Check compatibility'}</button>
    </div>

    <Show when={result()}>{(discovered) => <section class="admin-profile-section" aria-live="polite">
      <Show when={discovered().assignable === true && discovered().profileDraft} fallback={<div class="admin-inline-error" role="alert">{unsuccessfulOutcome(discovered())}</div>}>
        <div class="admin-discovery-success">
          <strong>Compatible reasoning behavior found</strong>
          <p>The route completed bounded reasoning, Pi tool-call, and tool-result replay checks.</p>
          <span>Supported levels: {discovered().profileDraft?.supportedLevels?.join(', ') || 'Not reported'}</span>
        </div>
        <label class="admin-form-field admin-profile-name"><span>Profile name</span><input aria-label="Profile name" maxlength="128" placeholder={`For example, ${props.route} reasoning`} value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
        <div class="admin-review-action">
          <div><strong>Next: review and save</strong><span>The profile remains unassigned and inactive. Nothing is stored until you confirm Apply change.</span></div>
          <button type="button" class="admin-primary-button" onClick={save}>Continue to review</button>
        </div>
        <details class="admin-technical-details admin-inline-technical-details">
          <summary>Technical check details</summary>
          <dl>
            <div><dt>Logical probes</dt><dd>{discovered().accounting?.logicalProbes ?? 0}</dd></div>
            <div><dt>HTTP attempts</dt><dd>{discovered().accounting?.httpAttempts ?? 0}</dd></div>
          </dl>
        </details>
      </Show>
    </section>}</Show>
  </section>;
};

export default ReasoningProfileEditor;
/* v8 ignore stop */
