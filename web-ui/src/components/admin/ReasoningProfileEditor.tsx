/* v8 ignore start -- user-validated administration UI */
import { For, Show, createMemo, createSignal, onMount, type Component } from 'solid-js';
import { discoverReasoningCompatibility } from '../../api/client';
import type { ReasoningDiscoveryResult } from '../../types';

interface Props {
  routes: string[];
  existingRevisions: Array<Record<string, unknown>>;
  onSave: (revision: Record<string, unknown>) => void;
  onCancel: () => void;
}

function generatedId(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 57).replace(/-+$/g, '');
  const base = slug || 'profile';
  return base === 'custom' || base.startsWith('custom-') ? base : `custom-${base}`;
}

const ReasoningProfileEditor: Component<Props> = (props) => {
  let heading!: HTMLHeadingElement;
  onMount(() => heading.focus());
  const [route, setRoute] = createSignal(props.routes[0] ?? '');
  const [result, setResult] = createSignal<ReasoningDiscoveryResult>();
  const [name, setName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const id = createMemo(() => generatedId(name()));
  const revision = createMemo(() => Math.max(0, ...props.existingRevisions
    .filter((item) => item.id === id())
    .map((item) => typeof item.revision === 'number' ? item.revision : 0)) + 1);

  const discover = async () => {
    if (!route()) {
      setError('Choose a discovered dynamic route.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await discoverReasoningCompatibility({ route: route(), maxCompletionTokens: 512 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Profile discovery failed.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const discovered = result()?.profileDraft;
    if (!discovered || result()?.assignable !== true) {
      setError('Run a successful profile discovery before saving.');
      return;
    }
    if (!name().trim()) {
      setError('Profile name is required.');
      return;
    }
    setError('');
    props.onSave({ ...discovered, id: id(), name: name().trim(), revision: revision() });
  };

  return <section class="admin-profile-editor admin-form-wide" aria-labelledby="custom-profile-heading">
    <div class="admin-subsection-heading">
      <div><h3 id="custom-profile-heading" tabIndex={-1} ref={heading}>Create custom profile</h3><p>Choose an existing Dynamic Route. Codeflare tests bounded known reasoning protocols and creates the profile from the observed compatible mapping.</p></div>
      <button type="button" class="admin-secondary-button" onClick={props.onCancel}>Close</button>
    </div>
    <Show when={error()}><div class="admin-inline-error" role="alert">{error()}</div></Show>
    <div class="admin-profile-grid">
      <label class="admin-form-field"><span>Dynamic route</span><select aria-label="Dynamic route" value={route()} disabled={busy() || props.routes.length === 0} onChange={(event) => { setRoute(event.currentTarget.value); setResult(undefined); setName(''); }}><For each={props.routes}>{(item) => <option value={item}>{item}</option>}</For></select></label>
      <div class="admin-readonly-field"><span>Credential</span><strong>Saved AI Gateway connection</strong><small>The encrypted URL and token already configured in Administration are reused Worker-side and are never returned to this page.</small></div>
    </div>
    <p class="admin-status-text">Discovery is deterministic and non-activating. It tests bounded built-in protocol candidates with a 512-token output ceiling, Pi tool calls, and tool-result replay. Provider billing may differ.</p>
    <button type="button" class="admin-primary-button" disabled={busy() || !route()} onClick={() => void discover()}>{busy() ? 'Discovering…' : 'Run profile discovery'}</button>

    <Show when={result()}>{(discovered) => <section class="admin-profile-section" aria-live="polite">
      <Show when={discovered().assignable === true && discovered().profileDraft} fallback={<div class="admin-inline-error" role="alert">No unambiguous compatible profile mapping was discovered. The route was not changed.</div>}>
        <div class="admin-profile-summary">
          <strong>{discovered().classification} compatibility</strong>
          <span>Matched deterministic protocol: {discovered().matchedCandidateProfileId}</span>
          <span>Logical probes: {discovered().accounting?.logicalProbes ?? 0}; HTTP attempts: {discovered().accounting?.httpAttempts ?? 0}</span>
          <small>Review the result, name it, then add the immutable revision to the configuration draft. Discovery evidence is retained, but custom revisions remain unverified and require explicit warned activation.</small>
        </div>
        <div class="admin-profile-grid">
          <label class="admin-form-field"><span>Profile name</span><input aria-label="Profile name" maxlength="128" value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
          <div class="admin-readonly-field"><span>Profile ID</span><strong>{id()}</strong><small>Immutable revision {revision()}</small></div>
        </div>
        <button type="button" class="admin-primary-button" onClick={save}>Add discovered profile to draft</button>
      </Show>
    </section>}</Show>
  </section>;
};

export default ReasoningProfileEditor;
/* v8 ignore stop */
