import { Component, Index, Show, createSignal, onMount } from 'solid-js';
import { getMcpPortals, saveMcpPortals } from '../../api/client';
import type { McpPortal } from '../../types';

const McpPortalSettings: Component = () => {
  const [portals, setPortals] = createSignal<McpPortal[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [saved, setSaved] = createSignal(false);
  const busy = () => loading() || saving() || !loaded();
  const edited = () => { setSaved(false); setError(''); };
  const update = (index: number, field: keyof McpPortal, value: string) => {
    edited();
    setPortals((rows) => rows.map((row, i) => i === index ? { ...row, [field]: value } : row));
  };

  onMount(async () => {
    try { setPortals(await getMcpPortals()); setLoaded(true); }
    catch { setError('MCP portals could not be loaded. No changes were made.'); }
    finally { setLoading(false); }
  });

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setSaving(true); setError(''); setSaved(false);
    try { setPortals(await saveMcpPortals(portals())); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'MCP portals could not be saved.'); }
    finally { setSaving(false); }
  };

  return <section class="admin-panel" aria-labelledby="mcp-portals-heading" aria-busy={loading() || saving()}>
    <div class="admin-panel-heading"><div>
      <h2 id="mcp-portals-heading">MCP portals</h2>
      <p>Named HTTPS MCP endpoints for subsequent advanced Pi startups. Saving does not restart sessions or connect portals. Each connection requires owner OAuth.</p>
    </div></div>
    <Show when={loading()}><p role="status">Loading MCP portals…</p></Show>
    <Show when={error()}><p class="admin-inline-error" role="alert">{error()}</p></Show>
    <form class="admin-environment-form" onSubmit={(event) => void save(event)}>
      <Index each={portals()}>{(portal, index) => <div class="admin-form-grid">
        <label class="admin-form-field">Name
          <input aria-label={`Name ${index + 1}`} required pattern="[a-z][a-z0-9_-]{0,63}" maxLength={64} value={portal().name} disabled={busy()} onInput={(event) => update(index, 'name', event.currentTarget.value)} />
        </label>
        <label class="admin-form-field">URL
          <input aria-label={`URL ${index + 1}`} type="url" required maxLength={512} value={portal().url} disabled={busy()} onInput={(event) => update(index, 'url', event.currentTarget.value)} />
        </label>
        <div><button type="button" class="admin-secondary-button" aria-label={`Remove portal ${index + 1}`} disabled={busy()} onClick={() => { edited(); setPortals((rows) => rows.filter((_, i) => i !== index)); }}>Remove</button></div>
      </div>}</Index>
      <div class="admin-form-actions">
        <button type="button" class="admin-secondary-button" disabled={busy()} onClick={() => { edited(); setPortals((rows) => [...rows, { name: '', url: '' }]); }}>Add portal</button>
        <button type="submit" class="admin-primary-button" disabled={busy()}>{saving() ? 'Saving…' : 'Save portals'}</button>
      </div>
    </form>
    <Show when={saved()}><p role="status">MCP portals saved. Changes apply on subsequent advanced Pi startups.</p></Show>
  </section>;
};

export default McpPortalSettings;
