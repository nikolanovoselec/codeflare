import { Component, For, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { mdiCheck } from '@mdi/js';
import Icon from '../Icon';
import '../../styles/connect.css';
import { getMcpPortalStatuses, disconnectMcpPortal, mcpPortalConnectUrl, type McpPortalStatus } from '../../api/mcp-portals';

import type { McpReturnOutcome } from '../../lib/mcp-portal-recovery';

interface McpPortalsSectionProps {
  currentUserEmail?: string;
  isActive?: boolean;
  returnOutcome?: McpReturnOutcome;
}

/** One shared connection surface using the existing Push & Deploy row styles. */
const McpPortalsSection: Component<McpPortalsSectionProps> = (props) => {
  const [portals, setPortals] = createSignal<McpPortalStatus[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [returnStatus, setReturnStatus] = createSignal('');
  const [needsReconnect, setNeedsReconnect] = createSignal(false);
  const [busy, setBusy] = createSignal<string[]>([]);
  // Direct/manual returns also work without the global recovery helper.
  const params = new URLSearchParams(window.location.search);
  const returned = params.get('mcp');
  const [directReturn, setDirectReturn] = createSignal<McpReturnOutcome | undefined>(
    returned === 'connected' || returned === 'reconnect' ? returned : undefined);
  if (directReturn()) {
    params.delete('mcp');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }
  let revision = 0;
  let disposed = false;
  let owner = props.currentUserEmail;
  const current = (request: number, requestOwner: string | undefined) =>
    !disposed && revision === request && props.currentUserEmail === requestOwner && props.isActive !== false;
  const refresh = async (request: number, requestOwner: string | undefined) => {
    const rows = await getMcpPortalStatuses();
    if (current(request, requestOwner)) setPortals(rows);
  };
  createEffect(() => {
    const requestOwner = props.currentUserEmail;
    const active = props.isActive !== false;
    if (owner !== requestOwner) {
      owner = requestOwner;
      setDirectReturn(undefined);
      setPortals([]);
    }
    const outcome = props.returnOutcome ?? directReturn();
    setNeedsReconnect(outcome === 'reconnect');
    setReturnStatus(outcome === 'connected' ? 'Authorization response received.'
      : outcome === 'reconnect' ? 'Portal authorization could not be completed. Ask your administrator to check the portal, then try Connect again.' : '');
    const request = ++revision;
    setBusy([]);
    setError('');
    setLoading(active);
    if (!active) return;
    void refresh(request, requestOwner).catch(() => {
      if (current(request, requestOwner)) {
        setPortals([]);
        setError('Portals could not be loaded. Try reopening Settings.');
      }
    }).finally(() => { if (current(request, requestOwner)) setLoading(false); });
  });
  onCleanup(() => { disposed = true; revision++; });
  const disconnect = async (name: string) => {
    if (busy().includes(name)) return;
    const request = revision, requestOwner = props.currentUserEmail;
    setBusy(rows => [...rows, name]); setError('');
    try {
      await disconnectMcpPortal(name);
      if (current(request, requestOwner)) await refresh(request, requestOwner);
    } catch {
      if (current(request, requestOwner)) setError('Portal could not be disconnected. Try again.');
    } finally {
      if (current(request, requestOwner)) setBusy(rows => rows.filter(row => row !== name));
    }
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
        <For each={portals()}>{portal => <div class="mcp-portal-row" role="group" aria-label={portal.name}>
          <div class="mcp-portal-identity">
            <span class="oauth-connect-name" data-testid={`mcp-${portal.name}-identity`}>{portal.name}</span>
            <Show when={portal.connected}>
              <span class="mcp-portal-status" role="status" aria-live="polite" aria-busy={busy().includes(portal.name)}
                data-testid={`mcp-${portal.name}-connected-badge`}>
                <Show when={!busy().includes(portal.name)}><Icon path={mdiCheck} size={14} aria-hidden="true" /></Show>
                {busy().includes(portal.name) ? 'Disconnecting…' : 'Authorization saved'}
              </span>
            </Show>
          </div>
          <div class="mcp-portal-actions">
            <Show when={portal.connected}>
              <button type="button" class="oauth-connect-btn settings-action"
                disabled={busy().includes(portal.name)}
                aria-label={`Authorize again Model Context Protocol portal ${portal.name}`}
                data-href={mcpPortalConnectUrl(portal.name)}
                onClick={() => { window.location.href = mcpPortalConnectUrl(portal.name); }}>Authorize again</button>
            </Show>
            <button type="button" class={portal.connected ? 'oauth-connect-disconnect' : 'oauth-connect-btn oauth-connect-btn--connect settings-action settings-action--accent'}
              disabled={busy().includes(portal.name)} aria-busy={busy().includes(portal.name)}
              aria-label={`${portal.connected ? 'Disconnect' : 'Connect'} Model Context Protocol portal ${portal.name}`}
              data-testid={`mcp-${portal.name}-${portal.connected ? 'disconnect' : 'connect'}-btn`}
              data-href={portal.connected ? undefined : mcpPortalConnectUrl(portal.name)}
              onClick={() => { if (portal.connected) void disconnect(portal.name); else window.location.href = mcpPortalConnectUrl(portal.name); }}>
              {portal.connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        </div>}</For>
      </div>
    </Show>
    <p class="settings-hint type-hint">Tool access isn’t verified here. Reauthorization may be needed; no Pi restart required.</p>
  </>;
};
export default McpPortalsSection;
