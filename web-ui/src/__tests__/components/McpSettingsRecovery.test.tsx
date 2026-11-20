import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import SettingsPanel from '../../components/SettingsPanel';

// Keep the real Settings accordion, MCP section, status schema and HTTP client.
// Unrelated settings resources use their existing API boundaries, not live I/O.
vi.mock('../../api/client', () => ({
  getUser: async () => ({ email: 'owner@example.test', authenticated: true, hasSubscribed: true, subscribedMode: 'default' }),
  getDeployKeys: async () => ({}), updateDeployKeys: async () => ({}), deleteDeployKeys: async () => undefined,
  getLlmKeys: async () => ({}), updateLlmKeys: async () => ({}),
}));
vi.mock('../../api/storage', () => ({ recreateGettingStartedDocs: vi.fn(), recreateAgentConfigs: vi.fn() }));
vi.mock('../../stores/session', () => ({ sessionStore: {
  preferences: { sessionMode: 'default' }, saasMode: false, preseedUpgrading: false,
  updatePreferences: vi.fn(), runPreseedUpdate: vi.fn(),
} }));
vi.mock('../../lib/agent-notifications', () => ({
  agentNotificationPermission: () => 'unavailable', agentNotificationsAvailable: async () => false,
  agentNotificationsEnabled: async () => false, setAgentNotificationsEnabled: vi.fn(),
}));

const saved = { name: 'alpha', url: 'https://alpha.example/mcp', connected: true };
const disconnected = { ...saved, connected: false };
const response = (portals: typeof saved[]) => Response.json({ portals });
let statusResponse: () => Promise<Response>;

beforeEach(() => {
  history.replaceState({}, '', '/app/');
  statusResponse = async () => response([saved]);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.pathname === '/api/mcp-portals' && method === 'GET') return statusResponse();
    throw new Error('Unexpected HTTP boundary in MCP Settings test');
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const openMcp = () => fireEvent.click(screen.getByTestId('accordion-header-mcp'));

describe('REQ-AGENT-228 AC4: mounted Settings MCP status recovery', () => {
  it('refreshes on panel reopening and on section reopening without remounting Settings', async () => {
    const [isOpen, setIsOpen] = createSignal(true);
    render(() => <SettingsPanel isOpen={isOpen()} onClose={() => setIsOpen(false)} currentUserEmail="owner@example.test" enterpriseMode />);
    await openMcp();
    expect(await screen.findByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' })).toBeEnabled();
    setIsOpen(false);
    statusResponse = async () => response([disconnected]);
    setIsOpen(true);
    expect(screen.getByTestId('accordion-header-appearance')).toHaveAttribute('aria-expanded', 'true');
    await openMcp();
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(screen.queryByTestId('mcp-alpha-connected-badge')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('accordion-header-appearance'));
    statusResponse = async () => response([saved]);
    await openMcp();
    expect(await screen.findByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(screen.getByTestId('mcp-alpha-connected-badge')).toHaveTextContent('Authorization saved');
  });

  it('ignores a late status from the closed lifetime after a newer reopening settles', async () => {
    let finishOld!: (value: Response) => void;
    const old = new Promise<Response>(resolve => { finishOld = resolve; });
    let first = true;
    statusResponse = () => {
      if (first) { first = false; return old; }
      return Promise.resolve(response([disconnected]));
    };
    const [isOpen, setIsOpen] = createSignal(true);
    render(() => <SettingsPanel isOpen={isOpen()} onClose={() => setIsOpen(false)} currentUserEmail="owner@example.test" enterpriseMode />);
    await openMcp();
    setIsOpen(false);
    setIsOpen(true);
    await openMcp();
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
    finishOld(response([{ name: 'stale-private-portal', url: 'https://stale.example/mcp', connected: true }]));
    await old; await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByText('stale-private-portal')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
  });

  it('reopening recovers a failed status fetch with an accessible error rather than keeping a stale badge', async () => {
    const [isOpen, setIsOpen] = createSignal(true);
    render(() => <SettingsPanel isOpen={isOpen()} onClose={() => setIsOpen(false)} currentUserEmail="owner@example.test" enterpriseMode />);
    await openMcp();
    await screen.findByRole('button', { name: 'Disconnect Model Context Protocol portal alpha' });
    setIsOpen(false);
    statusResponse = async () => { throw new TypeError('offline'); };
    setIsOpen(true); await openMcp();
    expect(await screen.findByRole('alert')).toHaveTextContent('Portals could not be loaded');
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
    setIsOpen(false);
    statusResponse = async () => response([disconnected]);
    setIsOpen(true); await openMcp();
    expect(await screen.findByRole('button', { name: 'Connect Model Context Protocol portal alpha' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
