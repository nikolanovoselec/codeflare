import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
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
    expect(screen.getByText('Connect Model Context Protocol portals and manage access to their tools.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'beta' })).toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: 'beta' })).toBeInTheDocument();
  });

  it('REQ-AGENT-228 AC4: clean browser completion status is consumed using the existing connection pattern', async () => {
    window.history.replaceState({}, '', '?mcp=reconnect');
    render(() => <McpPortalsSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Portal authorization could not be completed');
    expect(screen.getByText(/Ask the portal administrator to check assigned and enabled servers/)).toBeVisible();
    expect(window.location.search).not.toContain('mcp=');
    expect(await screen.findByTestId('mcp-alpha-identity')).toHaveTextContent('alpha');
  });

  it('REQ-AGENT-228 AC4: setup guidance explains missing servers and discovery without blocking authorization or discarding connections', async () => {
    render(() => <McpPortalsSection />);
    const connect = await screen.findByRole('button', { name: 'Connect Model Context Protocol portal beta' });
    fireEvent.click(screen.getByText('Portal setup and connection help'));
    expect(screen.getByText(/Ask the portal administrator to check assigned and enabled servers/)).toBeVisible();
    expect(screen.getByText(/Manual OAuth servers may discover tools only after the first user signs in/)).toBeVisible();
    expect(screen.getByText(/Keep your connection while tool access is corrected/)).toBeVisible();
    expect(screen.getByText(/Ask the instance administrator to inspect MCP transport\/interception logs/)).toBeVisible();
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
    expect(screen.getByText(/A connected portal does not guarantee access to every upstream tool/)).toBeVisible();
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
