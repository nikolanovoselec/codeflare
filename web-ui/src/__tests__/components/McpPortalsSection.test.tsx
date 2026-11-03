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
  it('REQ-AGENT-227 AC6: multiple portal identities connect through existing browser navigation and disconnect independently', async () => {
    render(() => <McpPortalsSection />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading MCP portals');
    await screen.findByText('alpha');
    expect(screen.getByText('Connect MCP portals and manage access to their tools.')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-alpha-identity')).toHaveTextContent('alpha');
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect MCP portal beta' })).toHaveAttribute('data-href', '/auth/mcp/connect/beta');
    expect(screen.getByRole('button', { name: 'Disconnect MCP portal alpha' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mcp-alpha-disconnect-btn'));
    await screen.findByTestId('mcp-alpha-connect-btn');
    expect(stored.map(p => ({ name: p.name, connected: p.connected }))).toEqual([{ name: 'alpha', connected: false }, { name: 'beta', connected: false }]);
    expect(screen.getByTestId('mcp-beta-connect-btn')).toBeInTheDocument();
  });

  it('REQ-AGENT-227 AC6: clean browser completion status is consumed using the existing connection pattern', async () => {
    window.history.replaceState({}, '', '?mcp=reconnect');
    render(() => <McpPortalsSection />);
    expect(await screen.findByText(/MCP authorization could not be completed/)).toBeInTheDocument();
    expect(window.location.search).not.toContain('mcp=');
    expect(await screen.findByTestId('mcp-alpha-identity')).toHaveTextContent('alpha');
  });

  it('REQ-AGENT-227 AC6: empty configuration, loading errors and disconnect errors are actionable and accessible', async () => {
    stored = []; render(() => <McpPortalsSection />);
    expect(await screen.findByText(/No MCP portals configured/)).toBeInTheDocument(); cleanup();
    get.mockRejectedValueOnce(new Error('network unavailable')); render(() => <McpPortalsSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('MCP portals could not be loaded'); cleanup();
    stored = [{ name: 'alpha', url: 'https://alpha.example/mcp', connected: true }];
    disconnect.mockRejectedValueOnce(new Error('denied')); render(() => <McpPortalsSection />);
    fireEvent.click(await screen.findByTestId('mcp-alpha-disconnect-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('MCP portal could not be disconnected');
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toBeInTheDocument();
  });
});
