import { Component, For, Show, createSignal, onMount } from 'solid-js';
import { mdiSwapHorizontalHidden } from '@mdi/js';
import Icon from '../Icon';
import '../../styles/button.css';
import { getMcpPortalStatuses, disconnectMcpPortal, mcpPortalConnectUrl, type McpPortalStatus } from '../../api/mcp-portals';

/** Portal connections use the established Settings section and row treatment. */
const McpPortalsSection: Component = () => {
  const [portals, setPortals] = createSignal<McpPortalStatus[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [returnStatus, setReturnStatus] = createSignal('');
  const [needsReconnect, setNeedsReconnect] = createSignal(false);
  const [busy, setBusy] = createSignal<string[]>([]);
  const refresh = async () => { setPortals(await getMcpPortalStatuses()); };
  onMount(async () => {
    // Same clean-query completion pattern as the existing GitHub connection surface.
    const params = new URLSearchParams(window.location.search);
    const returned = params.get('mcp');
    if (returned === 'connected' || returned === 'reconnect') {
      params.delete('mcp');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
      setNeedsReconnect(returned === 'reconnect');
      setReturnStatus(returned === 'connected' ? 'Authorization returned. Check the connection status below.' : 'Portal authorization could not be completed. Ask your administrator to check the portal, then try Connect again.');
    }
    try { await refresh(); } catch { setError('Portals could not be loaded. Try reopening Settings.'); }
    finally { setLoading(false); }
  });
  const disconnect = async (name: string) => {
    if (busy().includes(name)) return;
    setBusy(rows => [...rows, name]); setError('');
    try { await disconnectMcpPortal(name); await refresh(); }
    catch { setError('Portal could not be disconnected. Try again.'); }
    finally { setBusy(rows => rows.filter(row => row !== name)); }
  };
  return <>
    <Show when={loading()}><p class="settings-hint type-hint" role="status" aria-busy="true">Loading portals…</p></Show>
    <Show when={returnStatus()}><p class="settings-hint type-hint" role={needsReconnect() ? 'alert' : 'status'} aria-live={needsReconnect() ? 'assertive' : 'polite'}>{returnStatus()}</p></Show>
    <Show when={error()}><p class="settings-hint type-hint" role="alert">{error()}</p></Show>
    <Show when={!loading() && !error() && portals().length === 0}>
      <p class="settings-hint type-hint">No portals configured. Ask your administrator to add one under Model Context Protocol in Environment.</p>
    </Show>
    <For each={portals()}>{portal => <section class="settings-section">
      <div class="settings-section-header">
        <Icon path={mdiSwapHorizontalHidden} size={16} aria-hidden="true" />
        <h3 class="settings-section-title type-section-header" data-testid={`mcp-${portal.name}-identity`}>{portal.name}</h3>
      </div>
      <div class="setting-row">
        <span class="type-label" role="status" aria-live="polite"
          data-testid={portal.connected ? `mcp-${portal.name}-connected-badge` : undefined}>
          {busy().includes(portal.name) ? 'Disconnecting…' : portal.connected ? 'Connected' : 'Not connected'}
        </span>
        <button type="button" class="button settings-action" classList={{ 'settings-action--destructive': portal.connected }} data-variant="secondary" data-size="sm"
          disabled={busy().includes(portal.name)} aria-busy={busy().includes(portal.name)}
          aria-label={`${portal.connected ? 'Disconnect' : 'Connect'} Model Context Protocol portal ${portal.name}`}
          data-testid={`mcp-${portal.name}-${portal.connected ? 'disconnect' : 'connect'}-btn`}
          data-href={portal.connected ? undefined : mcpPortalConnectUrl(portal.name)}
          onClick={() => { if (portal.connected) void disconnect(portal.name); else window.location.href = mcpPortalConnectUrl(portal.name); }}>
          {portal.connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>
    </section>}</For>
    <p class="settings-hint type-hint">Available tools depend on portal permissions. Restart Pi after adding a portal.</p>
  </>;
};
export default McpPortalsSection;
