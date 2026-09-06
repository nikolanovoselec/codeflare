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
  api.discover.mockResolvedValue({
    route: 'development', classification: 'Verified', assignable: true,
    outcome: 'custom-profile',
    accounting: { logicalProbes: 23, httpAttempts: 33 },
    profileDraft: {
      schemaVersion: 1, enabled: true, ingressContract: 'ai-gateway-chat-completions',
      supportedLevels: ['off', 'medium'], removePaths: ['reasoning_effort'],
      levels: { off: [{ path: 'reasoning_effort', value: null }], medium: [{ path: 'reasoning_effort', value: 'medium' }] },
      aliases: {}, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: null },
      recognizedResponseFields: {}, classification: 'Compatible, unverified',
      toolCompatibility: { status: 'unverified', levels: [] }, validatedTransports: [], limitations: [], evidence: [],
    },
  });
  api.start.mockResolvedValue(new Response(''));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-031 warned activation', () => {
  it('continues a discovered profile directly into Review with the immutable unassigned draft', async () => {
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);

    await waitFor(() => expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(2));
    await fireEvent.click(screen.getByRole('button', { name: /discover development compatibility/i }));
    await fireEvent.click(screen.getByRole('button', { name: /check compatibility/i }));
    await screen.findByText(/compatible reasoning behavior found/i);
    await fireEvent.input(screen.getByLabelText('Profile name'), { target: { value: 'GLM 4.7 Flash' } });
    await fireEvent.click(screen.getByRole('button', { name: /continue to review/i }));

    await waitFor(() => expect(api.preview).toHaveBeenCalledWith(
      'aiRouting',
      7,
      expect.objectContaining({
        reasoningConfiguration: expect.objectContaining({
          customProfileRevisions: [expect.objectContaining({ id: 'custom-glm-4-7-flash', name: 'GLM 4.7 Flash', revision: 1 })],
          routeAssignments: aiRouting.reasoningConfiguration.routeAssignments,
        }),
      }),
    ));
    expect(await screen.findByText(/nothing is saved until apply change/i)).toBeInTheDocument();
    expect(screen.getByText('GLM 4.7 Flash')).toBeInTheDocument();
    expect(screen.getByText('Pending save · Unassigned · Inactive')).toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: /back to edit/i }));
    expect(await screen.findByText(/GLM 4\.7 Flash is ready to review/i)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /review and save profile/i }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(
      'aiRouting',
      7,
      expect.objectContaining({
        reasoningConfiguration: expect.objectContaining({
          customProfileRevisions: [expect.objectContaining({ name: 'GLM 4.7 Flash' })],
        }),
      }),
      ['reasoning_profile_unverified'],
    ));
  });

  it('keeps a matched Kimi selection in the hidden draft until explicit Review and Apply', async () => {
    const kimiRef = { id: 'workers-ai-kimi-k-thinking', revision: 3, hash: 'b'.repeat(64) };
    api.catalog.mockResolvedValue({
      schemaVersion: 1,
      profiles: [
        { id: 'workers-ai-glm-thinking', revision: 1, hash, name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'] },
        { ...kimiRef, name: 'Kimi thinking', supportedLevels: ['medium', 'high'] },
      ],
      notices: [], usage: [], routes: ['development'], routeCatalogStatus: 'ready',
    });
    api.discover.mockResolvedValueOnce({
      route: 'development', classification: 'Verified', assignable: true, outcome: 'existing-profile',
      matchedProfiles: [{ profileRef: kimiRef, name: 'Kimi thinking', supportedLevels: ['medium', 'high'] }],
    });
    const { container } = render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
    await waitFor(() => expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(3));
    const draft = () => JSON.parse((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
    await fireEvent.click(screen.getByRole('button', { name: /discover development compatibility/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Check compatibility' }));
    const select = await screen.findByRole('button', { name: 'Use Kimi thinking' });
    expect(draft()).toEqual(aiRouting.reasoningConfiguration);
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Continue to review' })).toBeNull();
    await fireEvent.click(select);
    const expected = { ...aiRouting.reasoningConfiguration, routeAssignments: { development: { activeProfile: kimiRef } } };
    expect(draft()).toEqual(expected);
    expect(aiRouting.reasoningConfiguration.routeAssignments.development.activeProfile.id).toBe('workers-ai-glm-thinking');
    expect(screen.queryByRole('heading', { name: /discover compatibility for development/i })).toBeNull();
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith('aiRouting', 7, expect.objectContaining({ reasoningConfiguration: expected })));
    expect(screen.queryByLabelText('Profiles pending save')).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await waitFor(() => expect(screen.getByLabelText('development reasoning profile')).toHaveValue(`${kimiRef.id}\u001f${kimiRef.revision}\u001f${kimiRef.hash}`));
    expect(draft()).toEqual(expected);
    await fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Apply change' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith('aiRouting', 7, expect.objectContaining({ reasoningConfiguration: expected }), ['reasoning_profile_unverified']));
  });

  it('blocks Apply until the API warning is confirmed and submits that exact code', async () => {
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);

    await waitFor(() => expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(2));
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
