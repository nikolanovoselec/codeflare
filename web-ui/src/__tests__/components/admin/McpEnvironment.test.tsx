import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdministrationMode, McpPortal } from '../../../types';

const api = vi.hoisted(() => ({ configuration: vi.fn(), usage: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock('../../../api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../api/client')>(),
  getAdminConfiguration: api.configuration,
  getAdminUsage: api.usage,
  getMcpPortals: api.get,
  saveMcpPortals: api.save,
}));
import AdministrationLayout from '../../../components/admin/AdministrationLayout';
import AdministrationOverview from '../../../components/admin/AdministrationOverview';
import EnvironmentIndex, { EnvironmentAreaDetail } from '../../../components/admin/EnvironmentIndex';

let stored: McpPortal[];
let mode: AdministrationMode;
const portal = { name: 'tools', url: 'https://portal.example.com/mcp?codemode=search_and_execute' };
const mount = () => render(() => <Router>
  <Route path="/admin" component={AdministrationLayout}>
    <Route path="/" component={AdministrationOverview} />
    <Route path="/environment" component={EnvironmentIndex} />
    <Route path="/environment/:section" component={EnvironmentAreaDetail} />
  </Route>
</Router>);
const item = () => screen.findByRole('link', { name: /Model Context Protocol/ });

beforeEach(() => {
  vi.resetAllMocks();
  stored = [];
  mode = 'enterprise';
  window.history.replaceState({}, '', '/admin');
  api.configuration.mockImplementation(async () => ({
    mode, revision: 3, applicableSections: ['domain', 'mcpPortals'],
    sections: { domain: { customDomain: 'example.com' }, mcpPortals: { portals: structuredClone(stored) } },
    latest: {}, activeRunId: null,
  }));
  api.usage.mockResolvedValue({ summary: {}, historyUpdatedAt: null });
  api.get.mockImplementation(async () => structuredClone(stored));
  api.save.mockImplementation(async (portals: McpPortal[]) => {
    stored = structuredClone(portals);
    return structuredClone(stored);
  });
});
afterEach(cleanup);

describe('Model Context Protocol Environment integration', () => {
  it.each(['/admin', '/admin/environment'])('REQ-SETUP-023 AC3: %s presents area links in displayed-label order and preserves portal status', async (path) => {
    api.configuration.mockResolvedValue({
      mode, revision: 3, applicableSections: ['securityEgress', 'mcpPortals', 'domain', 'aiRouting', 'access'],
      sections: {
        securityEgress: { strictGatewayEgress: true },
        mcpPortals: { portals: [portal] },
        domain: { customDomain: 'example.com' },
        aiRouting: { tokenState: 'administration', dynamicRoutes: [] },
        access: { adminUsers: ['admin@example.com'] },
      },
      latest: {}, activeRunId: null,
    });
    window.history.replaceState({}, '', path);
    mount();
    const portalRow = await item();
    const links = screen.getAllByRole('link').filter(link => /^\/admin\/environment\/[^/]+$/.test(link.getAttribute('href') ?? ''));
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/admin/environment/access', '/admin/environment/aiRouting', '/admin/environment/domain',
      '/admin/environment/mcpPortals', '/admin/environment/securityEgress',
    ]);
    expect(within(portalRow).getByText('1 portal')).toBeVisible();
    expect(within(portalRow).getByText('Configured')).toBeVisible();
    if (path === '/admin/environment') {
      fireEvent.input(screen.getByRole('searchbox', { name: 'Find an area' }), { target: { value: 'Gateway' } });
      const filtered = screen.getAllByRole('link').filter(link => /^\/admin\/environment\/[^/]+$/.test(link.getAttribute('href') ?? ''));
      expect(filtered.map(link => link.getAttribute('href'))).toEqual(['/admin/environment/aiRouting', '/admin/environment/securityEgress']);
    }
  });

  it.each(['default', 'onboarding', 'saas', 'enterprise'] as const)('REQ-AGENT-227 AC1: normal Environment item and subsection are available in %s', async (deployment) => {
    mode = deployment;
    window.history.replaceState({}, '', '/admin/environment');
    mount();
    const row = await item();
    expect(row).toHaveAttribute('href', '/admin/environment/mcpPortals');
    expect(within(row).getByText('0 portals')).toBeVisible();
    expect(within(row).getByText('Not configured')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add portal' })).not.toBeInTheDocument();
    fireEvent.input(screen.getByRole('searchbox', { name: 'Find an area' }), { target: { value: 'Model Context Protocol' } });
    expect(await item()).toBeVisible();
    expect(screen.queryByRole('link', { name: /Domain and DNS/ })).not.toBeInTheDocument();
    fireEvent.click(await item());
    expect(await screen.findByRole('heading', { level: 1, name: 'Model Context Protocol' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Portal connections' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save portals' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Review changes' })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-227 AC1: subsection Save persists and updates Overview and Environment status through removal', async () => {
    mount();
    expect(within(await item()).getByText('Not configured')).toBeVisible();
    fireEvent.click(await item());
    const add = await screen.findByRole('button', { name: 'Add portal' });
    // Loading must finish before edits become available.
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.input(screen.getByRole('textbox', { name: 'Name 1' }), { target: { value: portal.name } });
    fireEvent.input(screen.getByRole('textbox', { name: 'URL 1' }), { target: { value: portal.url } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save portals' }).closest('form')!);
    expect(await screen.findByText(/MCP portals saved/)).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
      const row = screen.getByRole('link', { name: /Model Context Protocol/ });
      expect(within(row).getByText('1 portal')).toBeVisible();
      expect(within(row).getByText('Configured')).toBeVisible();
    });
    fireEvent.click(await item());
    expect(await screen.findByRole('textbox', { name: 'URL 1' })).toHaveValue(portal.url);
    fireEvent.click(screen.getByRole('button', { name: 'Remove portal 1' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save portals' }).closest('form')!);
    expect(await screen.findByText(/MCP portals saved/)).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Back to Environment' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Environment' })).toBeVisible();
      const row = screen.getByRole('link', { name: /Model Context Protocol/ });
      expect(within(row).getByText('0 portals')).toBeVisible();
      expect(within(row).getByText('Not configured')).toBeVisible();
    });
    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
      const row = screen.getByRole('link', { name: /Model Context Protocol/ });
      expect(within(row).getByText('0 portals')).toBeVisible();
      expect(within(row).getByText('Not configured')).toBeVisible();
    });
  });

  it('REQ-AGENT-227 AC1: Overview counts all saved portals using the shared Environment item', async () => {
    stored = [portal, { name: 'other', url: 'https://other.example.com/mcp' }];
    mount();
    expect(within(await item()).getByText('2 portals')).toBeVisible();
    expect(within(await item()).getByText('Configured')).toBeVisible();
  });
});
