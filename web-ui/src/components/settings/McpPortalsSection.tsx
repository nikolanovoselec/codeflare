import { Component, For, Show, createSignal, onMount } from 'solid-js';
import { mdiTransitConnectionHorizontal } from '@mdi/js';
import OAuthConnectCard from '../connect/OAuthConnectCard';
import { getMcpPortalStatuses, disconnectMcpPortal, mcpPortalConnectUrl, type McpPortalStatus } from '../../api/mcp-portals';

/** Settings uses the same cards/navigation as GitHub and Cloudflare, in all modes. */
const McpPortalsSection: Component = () => {
  const [portals, setPortals] = createSignal<McpPortalStatus[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [returnStatus, setReturnStatus] = createSignal('');
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
      setReturnStatus(returned === 'connected' ? 'MCP portal connected.' : 'MCP authorization could not be completed. Connect the portal again.');
    }
    try { await refresh(); } catch { setError('MCP portals could not be loaded. Try reopening Settings.'); }
    finally { setLoading(false); }
  });
  const disconnect = async (name: string) => {
    if (busy().includes(name)) return;
    setBusy(rows => [...rows, name]); setError('');
    try { await disconnectMcpPortal(name); await refresh(); }
    catch { setError('MCP portal could not be disconnected. Try again.'); }
    finally { setBusy(rows => rows.filter(row => row !== name)); }
  };
  return <>
    <p class="settings-hint type-hint" style={{ 'margin-bottom': 'var(--space-2)' }}>
      Connect MCP portals and manage access to their tools.
    </p>
    <Show when={loading()}><p class="settings-hint type-hint" role="status" aria-busy="true">Loading MCP portals…</p></Show>
    <Show when={returnStatus()}><p class="settings-hint type-hint" role="status" aria-live="polite">{returnStatus()}</p></Show>
    <Show when={error()}><p class="settings-hint type-hint" role="alert">{error()}</p></Show>
    <Show when={!loading() && !error() && portals().length === 0}>
      <p class="settings-hint type-hint">No MCP portals configured. Ask your administrator to add a portal in Environment.</p>
    </Show>
    <For each={portals()}>{portal => <OAuthConnectCard
      class="mcp-portal-connect-card"
      provider={`mcp-${portal.name}`}
      icon={mdiTransitConnectionHorizontal}
      name="MCP portal"
      status={busy().includes(portal.name) ? 'connecting' : portal.connected ? 'connected' : 'disconnected'}
      identity={portal.name}
      description={portal.name}
      connectUrl={mcpPortalConnectUrl(portal.name)}
      onDisconnect={() => { void disconnect(portal.name); }}
    />}</For>
    <p class="settings-hint type-hint">Connections apply to both Pi modes. A connected portal does not guarantee access to every upstream tool. Restart Pi after adding a portal.</p>
  </>;
};
export default McpPortalsSection;
