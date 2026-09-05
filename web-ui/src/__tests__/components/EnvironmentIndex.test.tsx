import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  configuration: vi.fn(),
  catalog: vi.fn(),
  preview: vi.fn(),
  start: vi.fn(),
  run: vi.fn(),
  inventory: vi.fn(),
  discover: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  getAdminConfiguration: (...args: unknown[]) => api.configuration(...args),
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args),
  previewConfiguration: (...args: unknown[]) => api.preview(...args),
  startConfigurationRun: (...args: unknown[]) => api.start(...args),
  getConfigurationRun: (...args: unknown[]) => api.run(...args),
  getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.discover(...args),
  ConfigurationRequestError: class ConfigurationRequestError extends Error {},
}));

import AdministrationLayout from '../../components/admin/AdministrationLayout';
import { EnvironmentAreaDetail } from '../../components/admin/EnvironmentIndex';

const hash = 'a'.repeat(64);
const aiRouting = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  tokenState: 'administration',
  dynamicRoutes: ['development'],
  defaultRoute: { route: 'development', reasoning: 'medium' },
  routeContextWindows: { development: 262144 },
  reasoningConfiguration: {
    schemaVersion: 1,
    customProfileRevisions: [],
    routeAssignments: { development: { activeProfile: { id: 'workers-ai-glm-thinking', revision: 1, hash } } },
  },
  groupRouting: [],
};

beforeEach(() => {
  window.history.replaceState({}, '', '/admin/environment/aiRouting');
  api.configuration.mockResolvedValue({
    mode: 'enterprise', revision: 7, applicableSections: ['aiRouting'], sections: { aiRouting, domain: {} }, activeRunId: null, latest: {},
  });
  api.catalog.mockResolvedValue({
    schemaVersion: 1,
    profiles: [{ id: 'workers-ai-glm-thinking', revision: 1, hash, name: 'GLM thinking', enabled: true, supportedLevels: ['off', 'medium', 'high'] }],
    notices: [],
    usage: [],
    routes: ['development'],
    routeCatalogStatus: 'ready',
  });
  api.preview.mockResolvedValue({
    section: 'aiRouting', baseRevision: 7, currentRevision: 7,
    changes: [{ field: 'reasoningConfiguration', after: aiRouting.reasoningConfiguration }],
    tasks: [{ id: 'configure_model_routing', dependsOn: [] }],
    warnings: [{ code: 'reasoning_profile_unverified', message: 'Route development has incomplete profile evidence' }],
    exclusions: [],
  });
  api.start.mockResolvedValue(new Response(''));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-031 warned activation', () => {
  it('blocks Apply until the API warning is confirmed and submits that exact code', async () => {
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);

    await waitFor(() => expect(screen.getByText('Selected: GLM thinking')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    await waitFor(() => expect(screen.getByText('Route development has incomplete profile evidence')).toBeInTheDocument());

    const apply = screen.getByRole('button', { name: 'Apply change' });
    expect(apply).toBeDisabled();
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    expect(apply).toBeEnabled();
    await fireEvent.click(apply);

    await waitFor(() => expect(api.start).toHaveBeenCalledWith(
      'aiRouting',
      7,
      expect.objectContaining({ dynamicRoutes: ['development'] }),
      ['reasoning_profile_unverified'],
    ));
  });
});
