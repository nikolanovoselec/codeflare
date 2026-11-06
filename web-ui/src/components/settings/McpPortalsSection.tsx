import { Component, For, Show, createSignal, onMount } from 'solid-js';
import '../../styles/connect.css';
import { getMcpPortalStatuses, disconnectMcpPortal, mcpPortalConnectUrl, type McpPortalStatus } from '../../api/mcp-portals';

/** One shared connection surface using the existing Push & Deploy row styles. */
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
    <p class="settings-hint type-hint" style={{ 'margin-bottom': 'var(--space-2)' }}>Connect MCP portals to use their tools in your sessions.</p>
    <Show when={loading()}><p class="settings-hint type-hint" role="status" aria-busy="true">Loading portals…</p></Show>
    <Show when={returnStatus()}><p class="settings-hint type-hint" role={needsReconnect() ? 'alert' : 'status'} aria-live={needsReconnect() ? 'assertive' : 'polite'}>{returnStatus()}</p></Show>
    <Show when={error()}><p class="settings-hint type-hint" role="alert">{error()}</p></Show>
    <Show when={!loading() && !error() && portals().length === 0}>
      <p class="settings-hint type-hint">No portals configured. Ask your administrator to add one under Model Context Protocol in Environment.</p>
    </Show>
    <Show when={portals().length > 0}>
      <div class="oauth-connect-card mcp-portals-surface" role="group" aria-label="MCP portals">
        <For each={portals()}>{portal => <div class="oauth-connect-head mcp-portal-row">
          <span class="oauth-connect-name" data-testid={`mcp-${portal.name}-identity`}>{portal.name}</span>
          <Show when={portal.connected}>
            <span class="oauth-connect-badge" role="status" aria-live="polite"
              data-testid={`mcp-${portal.name}-connected-badge`}>
              {busy().includes(portal.name) ? 'Disconnecting…' : 'Connected'}
            </span>
          </Show>
          <button type="button" class={portal.connected ? 'oauth-connect-disconnect' : 'oauth-connect-btn oauth-connect-btn--connect settings-action settings-action--accent'}
            disabled={busy().includes(portal.name)} aria-busy={busy().includes(portal.name)}
            aria-label={`${portal.connected ? 'Disconnect' : 'Connect'} Model Context Protocol portal ${portal.name}`}
            data-testid={`mcp-${portal.name}-${portal.connected ? 'disconnect' : 'connect'}-btn`}
            data-href={portal.connected ? undefined : mcpPortalConnectUrl(portal.name)}
            onClick={() => { if (portal.connected) void disconnect(portal.name); else window.location.href = mcpPortalConnectUrl(portal.name); }}>
            {portal.connected ? 'Disconnect' : 'Connect'}
          </button>
        </div>}</For>
      </div>
    </Show>
    <p class="settings-hint type-hint">MCP portals bring tools and authentication together in a unified, governed surface. Restart Pi after adding or connecting a portal to load its tools.</p>
  </>;
};
export default McpPortalsSection;
