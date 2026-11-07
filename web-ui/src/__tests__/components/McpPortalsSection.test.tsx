import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import McpPortalsSection from '../../components/settings/McpPortalsSection';
import type { McpPortalStatus } from '../../api/mcp-portals';

vi.mock('../../api/mcp-portals', () => ({ getMcpPortalStatuses: vi.fn(), disconnectMcpPortal: vi.fn(),
  mcpPortalConnectUrl: (name: string) => `/auth/mcp/connect/${encodeURIComponent(name)}` }));
import { getMcpPortalStatuses, disconnectMcpPortal } from '../../api/mcp-portals';
const get = vi.mocked(getMcpPortalStatuses), disconnect = vi.mocked(disconnectMcpPortal);
let stored: McpPortalStatus[];
beforeEach(() => {
  vi.resetAllMocks();
  stored = [{ name: 'alpha', url: 'https://alpha.example/mcp', connected: true },
    { name: 'beta', url: 'https://beta.example/mcp', connected: false }];
  get.mockImplementation(async () => structuredClone(stored));
  disconnect.mockImplementation(async name => { stored = stored.map(p => p.name === name ? { ...p, connected: false } : p); });
});
afterEach(() => { cleanup(); window.history.replaceState({}, '', window.location.pathname); });

describe('Settings MCP connections', () => {
  it('REQ-AGENT-228 AC4: multiple portal identities connect through existing browser navigation and disconnect independently', async () => {
    render(() => <McpPortalsSection />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading portals');
    await screen.findByText('alpha');
    expect(screen.getByText('Portal connections renew automatically using your browser session. No Pi restart is needed for renewal.')).toBeVisible();
    const connections = screen.getByRole('group', { name: 'MCP portals' });
    expect(within(connections).getByText('alpha')).toBeVisible();
    expect(within(connections).getByText('beta')).toBeVisible();
    expect(screen.getByText('Connect MCP portals to use their tools in your sessions.')).toBeVisible();
    expect(screen.getByTestId('mcp-alpha-identity')).toHaveTextContent('alpha');
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Model Context Protocol portal beta' })).toHaveAttribute('data-href', '/auth/mcp/connect/beta');
    expect(screen.getByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mcp-alpha-disconnect-btn'));
    await screen.findByTestId('mcp-alpha-connect-btn');
    expect(stored.map(p => ({ name: p.name, connected: p.connected }))).toEqual([{ name: 'alpha', connected: false }, { name: 'beta', connected: false }]);
    expect(screen.getByTestId('mcp-beta-connect-btn')).toBeInTheDocument();
  });

  it('REQ-AGENT-228 AC4: disconnect stays busy until its result and preserves the other portal', async () => {
    let finish!: () => void;
    disconnect.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    render(() => <McpPortalsSection />);
    const button = await screen.findByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByText('Disconnecting…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Model Context Protocol portal beta' })).toBeEnabled();
    stored = stored.map(portal => portal.name === 'alpha' ? { ...portal, connected: false } : portal);
    finish();
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(screen.getByText('beta')).toBeVisible();
  });

  it('REQ-AGENT-228 AC4: clean browser completion status is consumed using the existing connection pattern', async () => {
    window.history.replaceState({}, '', '?mcp=reconnect');
    render(() => <McpPortalsSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Portal authorization could not be completed');
    expect(screen.getByRole('alert')).toHaveTextContent('Ask your administrator to check the portal, then try Connect again.');
    expect(window.location.search).not.toContain('mcp=');
    expect(await screen.findByTestId('mcp-alpha-identity')).toHaveTextContent('alpha');
  });

  it('REQ-AGENT-228 AC4: concise permission guidance keeps connection actions available without a troubleshooting disclosure', async () => {
    render(() => <McpPortalsSection />);
    const connect = await screen.findByRole('button', { name: 'Connect Model Context Protocol portal beta' });
    expect(screen.getByText('Portal connections renew automatically using your browser session. No Pi restart is needed for renewal.')).toBeVisible();
    expect(screen.queryByText('Portal setup and connection help')).not.toBeInTheDocument();
    expect(connect).toBeEnabled();
    expect(connect).toHaveAttribute('data-href', '/auth/mcp/connect/beta');
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toBeVisible();
    expect(stored.map(portal => portal.connected)).toEqual([true, false]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('REQ-AGENT-228 AC4: successful authorization is not presented as a tool-discovery failure', async () => {
    window.history.replaceState({}, '', '?mcp=connected');
    render(() => <McpPortalsSection />);
    expect(await screen.findByText('Authorization returned. Check the connection status below.')).toBeVisible();
    expect(await screen.findByTestId('mcp-alpha-connected-badge')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Portal connections renew automatically using your browser session. No Pi restart is needed for renewal.')).toBeVisible();
  });

  it('REQ-AGENT-228 AC4: a return marker cannot override disconnected status or remove unrelated navigation state', async () => {
    stored = stored.map(portal => ({ ...portal, connected: false }));
    window.history.replaceState({}, '', '?view=settings&mcp=connected#connections');
    render(() => <McpPortalsSection />);
    expect(await screen.findByText('Authorization returned. Check the connection status below.')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Connect Model Context Protocol portal beta' })).toBeEnabled();
    expect(screen.queryByTestId('mcp-alpha-connected-badge')).not.toBeInTheDocument();
    expect(window.location.search).toBe('?view=settings');
    expect(window.location.hash).toBe('#connections');
  });

  it('REQ-AGENT-228 AC4: empty configuration, loading errors and disconnect errors are actionable and accessible', async () => {
    stored = []; render(() => <McpPortalsSection />);
    expect(await screen.findByText(/No portals configured/)).toBeInTheDocument(); cleanup();
    get.mockRejectedValueOnce(new Error('network unavailable')); render(() => <McpPortalsSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Portals could not be loaded'); cleanup();
    stored = [{ name: 'alpha', url: 'https://alpha.example/mcp', connected: true }];
    disconnect.mockRejectedValueOnce(new Error('denied')); render(() => <McpPortalsSection />);
    fireEvent.click(await screen.findByTestId('mcp-alpha-disconnect-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Portal could not be disconnected');
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toBeInTheDocument();
  });
});
