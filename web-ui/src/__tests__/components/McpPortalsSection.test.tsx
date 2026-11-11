import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import McpPortalsSection from '../../components/settings/McpPortalsSection';
import type { McpPortalStatus } from '../../api/mcp-portals';
import { createSignal } from 'solid-js';

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
  it('REQ-AGENT-228 AC4 / REQ-AGENT-226 AC7: saved authorization offers a non-destructive Authorize again separately from Disconnect', async () => {
    render(() => <McpPortalsSection {...{ currentUserEmail: 'owner@example.test', isActive: true, returnOutcome: 'reconnect' as const }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Portal authorization could not be completed');
    const retry = await screen.findByRole('button', { name: 'Authorize again Model Context Protocol portal alpha' });
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toHaveTextContent('Authorization saved');
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    // Intentional user-copy contract: saved authorization never certifies tools or requires a Pi restart.
    expect(screen.getByText('Tool access isn’t verified here. Reauthorization may be needed; no Pi restart required.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' })).toBeEnabled();
    const originalLocation = window.location;
    const destination = { href: '' };
    try {
      Object.defineProperty(window, 'location', { value: destination, writable: true });
      fireEvent.click(retry);
      expect(destination.href).toBe('/auth/mcp/connect/alpha');
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
    }
    // This mock models the persisted grant at the API boundary: Disconnect would
    // make alpha false. Explicit Connect navigation must leave both grants alone.
    expect(stored.map(portal => ({ name: portal.name, connected: portal.connected }))).toEqual([
      { name: 'alpha', connected: true }, { name: 'beta', connected: false },
    ]);
    expect(screen.getByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' })).toBeEnabled();
  });

  it('REQ-AGENT-226 AC3/6 / REQ-AGENT-228 AC4: a returned outcome refreshes a mounted section but cannot certify connectivity', async () => {
    const [outcome, setOutcome] = createSignal<'connected' | 'reconnect'>();
    render(() => <McpPortalsSection {...{ currentUserEmail: 'owner@example.test', isActive: true, returnOutcome: outcome() }} />);
    await screen.findByTestId('mcp-alpha-connected-badge');
    stored = stored.map(portal => ({ ...portal, connected: false }));
    setOutcome('connected');
    expect(await screen.findByText('Authorization response received.')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(screen.queryByTestId('mcp-alpha-connected-badge')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: late old-owner status and return outcome cannot replace the current owner surface', async () => {
    let finishOld!: (value: McpPortalStatus[]) => void;
    get.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const [owner, setOwner] = createSignal('alice@example.test');
    const [outcome, setOutcome] = createSignal<'reconnect' | undefined>('reconnect');
    render(() => <McpPortalsSection {...{ currentUserEmail: owner(), isActive: true, returnOutcome: outcome() }} />);
    setOutcome(undefined);
    stored = [{ name: 'bob-portal', url: 'https://bob.example/mcp', connected: false }];
    setOwner('bob@example.test');
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal bob-portal' })).toBeEnabled();
    finishOld([{ name: 'alice-private-portal', url: 'https://alice.example/mcp', connected: true }]);
    await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByText('alice-private-portal')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Model Context Protocol portal bob-portal' })).toBeEnabled();
  });

  it('REQ-AGENT-228 AC4: a disposed request cannot publish into a newly mounted owner surface', async () => {
    let rejectOld!: (reason: unknown) => void;
    get.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const first = render(() => <McpPortalsSection {...{ currentUserEmail: 'alice@example.test', isActive: true }} />);
    first.unmount();
    stored = [{ name: 'bob-portal', url: 'https://bob.example/mcp', connected: false }];
    render(() => <McpPortalsSection {...{ currentUserEmail: 'bob@example.test', isActive: true }} />);
    expect(await screen.findByText('bob-portal')).toBeVisible();
    rejectOld(new Error('old-owner unavailable'));
    await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Model Context Protocol portal bob-portal' })).toBeEnabled();
  });
  it('REQ-AGENT-228 AC4: multiple portal identities connect through existing browser navigation and disconnect independently', async () => {
    render(() => <McpPortalsSection />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading portals');
    await screen.findByText('alpha');
    expect(screen.getByText(/no Pi restart required/i)).toBeVisible();
    const connections = screen.getByRole('group', { name: 'MCP portals' });
    expect(within(connections).getByText('alpha')).toBeVisible();
    expect(within(connections).getByText('beta')).toBeVisible();
    const alpha = within(screen.getByRole('group', { name: 'alpha' }));
    const beta = within(screen.getByRole('group', { name: 'beta' }));
    expect(alpha.getByRole('button', { name: 'Authorize again Model Context Protocol portal alpha' })).toBeEnabled();
    expect(alpha.getByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(beta.getByRole('button', { name: 'Connect Model Context Protocol portal beta' })).toBeEnabled();
    expect(screen.getByText('Connect MCP portals to use their tools in your sessions.')).toBeVisible();
    expect(screen.getByTestId('mcp-alpha-identity')).toHaveTextContent('alpha');
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toBeInTheDocument();
    const connect = screen.getByRole('button', { name: 'Connect Model Context Protocol portal beta' });
    expect(connect).toHaveAttribute('data-href', '/auth/mcp/connect/beta');
    const originalLocation = window.location;
    const destination = { href: '' };
    try {
      Object.defineProperty(window, 'location', { value: destination, writable: true });
      fireEvent.click(connect);
      expect(destination.href).toBe('/auth/mcp/connect/beta');
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
    }
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
    expect(screen.getByText(/no Pi restart required/i)).toBeVisible();
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
    expect(await screen.findByText('Authorization response received.')).toBeVisible();
    expect(await screen.findByTestId('mcp-alpha-connected-badge')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/no Pi restart required/i)).toBeVisible();
  });

  it('REQ-AGENT-228 AC4: a return marker cannot override disconnected status or remove unrelated navigation state', async () => {
    stored = stored.map(portal => ({ ...portal, connected: false }));
    window.history.replaceState({}, '', '?view=settings&mcp=connected#connections');
    render(() => <McpPortalsSection />);
    expect(await screen.findByText('Authorization response received.')).toBeVisible();
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
