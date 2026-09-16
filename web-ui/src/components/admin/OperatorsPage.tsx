/**
 * Operators administration: enterprise gating, resource/state ownership, explicit actions, then render sections.
 * Registry, registration form, artifact review, connection, restrictions and handoff key are separate
 * decisions. Secrets stay in component memory and are cleared on dismissal/selection/unmount.
 * This page does not start activities or imply that registration grants invoking-user eligibility.
 */
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type Component } from 'solid-js';
import { useAdministration } from './AdministrationLayout';
import * as api from '../../api/operators';

const emptyPolicy = (): api.OperatorPolicyInput => ({ schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
    reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
const lines = (text: string) => text.split('\n').map(value => value.trim()).filter(Boolean);

/** REQ-OPERATOR-008: Parent-authenticated admin controls, not an activity execution UI. */
const OperatorsPage: Component = () => {
  const configuration = useAdministration();
  if (configuration.mode !== 'enterprise') return <div class="admin-state-page"><h1>Not available</h1></div>;
  // Read resources are independent of mutation state. Loading/errors must not be
  // presented as an empty registry, and switching selection discards one-time secrets.
  const [operators, { refetch: reloadList }] = createResource(api.listOperators);
  const [selected, setSelected] = createSignal<string>();
  const [detail, { refetch: reloadDetail }] = createResource(selected, api.getOperator);
  const [endpoint, setEndpoint] = createSignal('');
  const [secret, setSecret] = createSignal('');
  const [replacementEndpoint, setReplacementEndpoint] = createSignal('');
  const [replacementSecret, setReplacementSecret] = createSignal('');
  const [policy, setPolicy] = createSignal(emptyPolicy());
  const [candidate, setCandidate] = createSignal<string>();
  const [key, setKey] = createSignal('');
  const [confirmRotation, setConfirmRotation] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  let active = true;
  onCleanup(() => { active = false; setKey(''); setSecret(''); setReplacementSecret(''); });
  // Confirmed detail readback seeds editable, non-secret fields. Password inputs
  // are deliberately never populated from the server, even after a successful write.
  createEffect(() => {
    if (detail.error || detail.loading) return;
    const current = detail();
    if (!current || current.registration.operatorId !== selected()) return;
    setReplacementEndpoint(current.endpoint ?? '');
    setReplacementSecret('');
    try { setPolicy(current.policyJson ? JSON.parse(current.policyJson) : emptyPolicy()); }
    catch { setError('Stored restrictions could not be read. Refresh before changing them.'); }
  });
  const metadata = createMemo(() => {
    try {
      const text = candidate() ?? detail()?.approvedManifestJson ?? detail()?.discoveredManifestJson;
      return text ? JSON.parse(text) as { name: string; description: string; coreVersion: string; intentVersion: string; artifact: { sha256: string } } : null;
    } catch { return null; }
  });
  function select(id: string) {
    setKey(''); setConfirmRotation(false); setCandidate(undefined); setError(''); setNotice(''); setSelected(id);
  }
  async function refresh() {
    await Promise.allSettled([reloadList(), selected() ? reloadDetail() : undefined]);
  }
  // One explicit mutation at a time. Refresh only reconciles readback; it never
  // repeats a failed write. A detached page must not display late responses/secrets.
  async function perform(action: () => Promise<unknown>, message: string) {
    if (busy()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      if (active) { setNotice(message); await refresh(); }
    } catch {
      if (active) setError('The operation was not confirmed. Refresh to reconcile the current revision before trying again.');
    } finally { if (active) setBusy(false); }
  }
  const current = () => detail()?.registration;
  async function rotate() {
    const record = current();
    if (!record) return;
    setConfirmRotation(false);
    setKey('');
    await perform(async () => {
      const result = await api.rotateOperatorWebhookKey(record.operatorId, record.revision);
      if (active && selected() === record.operatorId) setKey(result.key);
    }, 'Webhook key generated. Save it now; it cannot be displayed again.');
  }
  // Small local field renderers preserve the incumbent admin grid, native labels
  // and keyboard behavior; policy semantics remain server-validated.
  const textField = (label: string, value: () => string, change: (value: string) => void, password = false) => (
    <label class="admin-form-field"><span>{label}</span><input type={password ? 'password' : 'text'} value={value()}
      autocomplete={password ? 'new-password' : 'off'} disabled={busy()} onInput={event => change(event.currentTarget.value)} /></label>
  );
  const listField = (label: string, values: () => string[], change: (value: string[]) => void) => (
    <label class="admin-form-field"><span>{label}</span><textarea rows={3} value={values().join('\n')}
      disabled={busy()} onInput={event => change(lines(event.currentTarget.value))} /></label>
  );
  return <div class="admin-page">
    <header class="admin-page-header"><div><p class="admin-eyebrow">Administration</p><h1>Operators</h1>
      <p>Register private operators, review their artifacts and restrict their access. Human Access authorization remains required.</p></div></header>
    <Show when={error()}><div role="alert"><p>{error()}</p><button class="admin-secondary-button" type="button" disabled={busy()} onClick={() => void refresh()}>Refresh current state</button></div></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <section class="admin-panel operator-admin-panel" aria-label="Registered operators">
      <h2>Registered operators</h2>
      <Show when={!operators.loading || operators.latest} fallback={<p role="status">Loading operators…</p>}>
        <Show when={!operators.error} fallback={<div role="alert"><p>Operators could not be loaded.</p><button class="admin-primary-button" type="button" onClick={() => void refresh()}>Retry</button></div>}>
          <Show when={operators()?.operators.length} fallback={<p>No operators registered</p>}>
            <For each={operators()?.operators}>{record => <div class="admin-area-row">
              <div><strong>{record.operatorId}</strong><p>{record.enabled ? 'Enabled' : record.approvedArtifactDigest ? 'Approved · disabled' : 'Unapproved · disabled'} · Revision {record.revision}</p></div>
              <button class="admin-secondary-button" type="button" disabled={busy()} aria-label={`Manage ${record.operatorId}`} onClick={() => select(record.operatorId)}>Manage</button>
            </div>}</For>
          </Show>
        </Show>
      </Show>
    </section>
    <section class="admin-panel operator-admin-panel"><h2>Register an operator</h2><p>Registration starts disabled, with no external capabilities allowed. Approval and enablement are separate steps.</p>
      <form class="admin-form-grid" onSubmit={event => { event.preventDefault(); void perform(async () => {
        try { await api.registerOperator({ endpoint: endpoint().trim(), connectionSecret: secret(), policy: emptyPolicy() }); }
        finally { if (active) setSecret(''); }
      }, 'Operator registered, disabled and unapproved.'); }}>
        {textField('Endpoint URL', endpoint, setEndpoint)}{textField('Connection secret', secret, setSecret, true)}
        <div class="admin-form-actions admin-form-wide"><button class="admin-primary-button" type="submit" disabled={busy() || !endpoint().trim() || !secret().trim()}>Register operator</button></div>
      </form>
    </section>
    <Show when={selected()}>
      {/* Preserve confirmed content during readback, especially the one-time key.
          Controls remain disabled until reconciliation finishes; a new selection
          still gets a loading state rather than the preceding operator's data. */}
      <Show when={!detail.loading || detail.latest?.registration.operatorId === selected()} fallback={<p role="status">Loading operator details…</p>}>
        <Show when={!detail.error && detail()?.registration.operatorId === selected()} fallback={<div role="alert"><p>Operator details could not be loaded.</p><button class="admin-secondary-button" type="button" onClick={() => void refresh()}>Retry</button></div>}>
          <section class="admin-panel operator-admin-panel"><h2>{metadata()?.name ?? selected()}</h2><p>{metadata()?.description}</p>
            <p>Core {metadata()?.coreVersion ?? 'not discovered'} · Intent {metadata()?.intentVersion ?? 'not discovered'} · Revision {current()?.revision}</p>
            <p>{current()?.enabled ? 'Enabled for new activities' : 'Disabled for new activities'}</p>
            <p class="admin-mono" style={{ 'overflow-wrap': 'anywhere' }}>Approved SHA-256: {current()?.approvedArtifactDigest ?? 'None'}</p>
            <Show when={metadata()}><p class="admin-mono" style={{ 'overflow-wrap': 'anywhere' }}>Candidate SHA-256: {metadata()?.artifact.sha256}</p></Show>
            <p>Approving a candidate leaves the operator disabled until separately enabled.</p>
            <div class="admin-form-actions">
              <button class="admin-secondary-button" type="button" disabled={busy()} onClick={() => void perform(async () => {
                const id = selected()!; const result = await api.discoverOperator(id);
                if (active && selected() === id) setCandidate(result.manifestJson);
              }, 'Discovery refreshed. No artifact was approved or enabled.')}>Refresh discovery</button>
              <button class="admin-secondary-button" type="button" disabled={busy() || !metadata()} onClick={() => {
                const record = current(); const digest = metadata()?.artifact.sha256;
                if (record && digest) void perform(() => api.approveOperator(record.operatorId, record.revision, digest), 'Artifact approved. Enable separately after reviewing restrictions.');
              }}>Approve artifact</button>
              <button class="admin-primary-button" type="button" disabled={busy() || !current()?.approvedArtifactDigest} onClick={() => {
                const record = current(); if (record) void perform(() => api.setOperatorEnabled(record.operatorId, record.revision, !record.enabled), record.enabled ? 'Operator disabled for new activities.' : 'Operator enabled.');
              }}>{current()?.enabled ? 'Disable operator' : 'Enable operator'}</button>
            </div>
          </section>
          <section class="admin-panel operator-admin-panel"><h2>Connection</h2><p>Secrets are not returned. Replacement disables the operator and clears approval.</p>
            <div class="admin-form-grid">{textField('Replacement endpoint URL', replacementEndpoint, setReplacementEndpoint)}
              {textField('Replacement connection secret', replacementSecret, setReplacementSecret, true)}</div>
            <button class="admin-secondary-button" type="button" disabled={busy() || !replacementSecret().trim()} onClick={() => {
              const record = current(); if (record) void perform(async () => {
                try { await api.setOperatorDistribution(record.operatorId, record.revision, replacementEndpoint().trim(), replacementSecret()); setCandidate(undefined); }
                finally { if (active) setReplacementSecret(''); }
              }, 'Connection replaced. Discover and approve the artifact again.');
            }}>Replace connection</button>
          </section>
          <section class="admin-panel operator-admin-panel"><h2>Restrictions</h2><p>One value per line. Empty lists deny access. These limits never expand the initiating human’s authority.</p>
            <div class="admin-form-grid">
              {listField('General egress hosts', () => policy().networkHosts, values => setPolicy({ ...policy(), networkHosts: values }))}
              {listField('GitHub repositories', () => policy().github.repositories, repositories => setPolicy({ ...policy(), github: { ...policy().github, repositories } }))}
              {listField('GitHub methods', () => policy().github.methods, methods => setPolicy({ ...policy(), github: { ...policy().github, methods } }))}
              {listField('Restore prefixes', () => policy().storage.readPrefixes, readPrefixes => setPolicy({ ...policy(), storage: { ...policy().storage, readPrefixes } }))}
              {listField('Upload prefixes', () => policy().storage.writePrefixes, writePrefixes => setPolicy({ ...policy(), storage: { ...policy().storage, writePrefixes } }))}
              {listField('Allowed inference routes', () => policy().inference.routeIds, routeIds => setPolicy({ ...policy(), inference: { ...policy().inference, routeIds } }))}
              {textField('Default inference route', () => policy().inference.defaultRouteId ?? '', value => setPolicy({ ...policy(), inference: { ...policy().inference, defaultRouteId: value || null } }))}
              {listField('Allowed reasoning levels', () => policy().inference.reasoningLevels, reasoningLevels => setPolicy({ ...policy(), inference: { ...policy().inference, reasoningLevels } }))}
              {textField('Default reasoning level', () => policy().inference.defaultReasoningLevel ?? '', value => setPolicy({ ...policy(), inference: { ...policy().inference, defaultReasoningLevel: value || null } }))}
              <label class="admin-toggle-field"><input type="checkbox" checked={policy().inference.inheritUserDefaults} disabled={busy()}
                onChange={event => setPolicy({ ...policy(), inference: { ...policy().inference, inheritUserDefaults: event.currentTarget.checked } })} /> Inherit user defaults within allowed routes</label>
            </div>
            <button class="admin-primary-button" type="button" disabled={busy()} onClick={() => {
              const record = current(); if (record) void perform(() => api.setOperatorPolicy(record.operatorId, record.revision, policy()), 'Restrictions saved. Enable separately when ready.');
            }}>Save restrictions</button>
          </section>
          <section class="admin-panel operator-admin-panel"><h2>Actions handoff key</h2><p>Optional encryption for Actions handoffs. Use CODEFLARE_OPERATOR_WEBHOOK_KEY in repository, selected environment, or restricted organization secrets. Never distribute the Codeflare master key.</p>
            <button class="admin-secondary-button" type="button" disabled={busy()} onClick={() => detail()?.webhookKeyConfigured ? setConfirmRotation(true) : void rotate()}>
              {detail()?.webhookKeyConfigured ? 'Rotate webhook key' : 'Generate webhook key'}</button>
            <Show when={confirmRotation()}><div role="group" aria-label="Confirm webhook key rotation"><p>Rotation replaces the existing key. Update all consuming repositories; there is no retired-key fallback.</p>
              <button class="admin-secondary-button" type="button" disabled={busy()} onClick={() => void rotate()}>Confirm rotation</button>
              <button class="admin-secondary-button" type="button" onClick={() => setConfirmRotation(false)}>Cancel rotation</button></div></Show>
            <Show when={key()}><div><p>Save this key now. It will not be shown after dismissal.</p><output aria-label="New webhook key" class="admin-mono" style={{ 'overflow-wrap': 'anywhere' }}>{key()}</output>
              <button class="admin-secondary-button" type="button" onClick={() => setKey('')}>I saved the key</button></div></Show>
          </section>
        </Show>
      </Show>
    </Show>
  </div>;
};
export default OperatorsPage;
