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
import { normalizeCustomProfile } from '../../../../src/lib/reasoning-profiles';

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
  it('saves a different manually selected revision without configuring unrelated gateway routes', async () => {
    const nextRef = { id: 'workers-ai-glm-thinking', revision: 2, hash: 'b'.repeat(64) };
    api.start.mockResolvedValueOnce(new Response(`${JSON.stringify({ type: 'snapshot', run: { runId: 'manual-routing', section: 'aiRouting', state: 'succeeded', tasks: [], resultingRevision: 8 } })}\n`));
    api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: [
      { ...aiRouting.reasoningConfiguration.routeAssignments.development.activeProfile, name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'] },
      { ...nextRef, name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'] },
    ], notices: [], usage: [], routes: ['development', 'unconfigured'], routeCatalogStatus: 'ready' });
    api.preview.mockResolvedValueOnce({ section: 'aiRouting', baseRevision: 7, currentRevision: 7, changes: [{ field: 'reasoningConfiguration', after: aiRouting.reasoningConfiguration }], tasks: [], warnings: [], exclusions: [] });
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
    await waitFor(() => expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(3));
    expect(screen.getByLabelText('development reasoning profile')).toHaveValue(`workers-ai-glm-thinking\u001f1\u001f${hash}`);
    expect(screen.getByRole('button', { name: 'Map Profile for unconfigured' })).toBeEnabled();
    await fireEvent.change(screen.getByLabelText('development reasoning profile'), { target: { value: `${nextRef.id}\u001f${nextRef.revision}\u001f${nextRef.hash}` } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Confirm Save' });
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith('aiRouting', 7, expect.objectContaining({
      dynamicRoutes: ['development'], routeContextWindows: { development: 262144 }, defaultRoute: aiRouting.defaultRoute,
      reasoningConfiguration: { ...aiRouting.reasoningConfiguration, routeAssignments: { development: { activeProfile: nextRef } } },
    }), []));
    expect(api.discover).not.toHaveBeenCalled();
    await screen.findByRole('heading', { name: 'Execution succeeded' });
    const savedValues = api.start.mock.calls[0][2];
    api.configuration.mockResolvedValue({ mode: 'enterprise', revision: 8, applicableSections: ['aiRouting'], sections: { aiRouting: { ...aiRouting, ...savedValues } }, activeRunId: null, latest: {} });
    cleanup();
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map Profile for unconfigured' })).toBeEnabled());
    expect(screen.getByLabelText('development reasoning profile')).toHaveValue(`${nextRef.id}\u001f${nextRef.revision}\u001f${nextRef.hash}`);
  });
  it('creates and assigns to the mapped route only, retaining the canonical draft until explicit Save', async () => {
    api.start.mockResolvedValueOnce(new Response(`${JSON.stringify({ type: 'snapshot', run: { runId: 'saved-routing', section: 'aiRouting', state: 'succeeded', tasks: [], resultingRevision: 8 } })}\n`));
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);

    await waitFor(() => expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(2));
    await fireEvent.click(screen.getByRole('button', { name: /map profile for development/i }));
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', maxCompletionTokens: 4096 });
    await screen.findByText(/compatible reasoning behavior found/i);
    await fireEvent.input(screen.getByLabelText('Profile name'), { target: { value: 'GLM 4.7 Flash' } });
    await fireEvent.keyDown(screen.getByLabelText('Profile name'), { key: 'Enter' });
    expect(api.preview).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Create & Assign' }));
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).value).toContain('custom-glm-4-7-flash');
    expect(screen.getByLabelText('Global default reasoning')).toHaveValue('medium');
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.preview).toHaveBeenCalledWith(
      'aiRouting',
      7,
      expect.objectContaining({
        reasoningConfiguration: expect.objectContaining({
          customProfileRevisions: [expect.objectContaining({ id: 'custom-glm-4-7-flash', name: 'GLM 4.7 Flash', revision: 1 })],
          routeAssignments: { development: { activeProfile: { id: 'custom-glm-4-7-flash', revision: 1, hash: expect.stringMatching(/^[0-9a-f]{64}$/) } } },
        }),
      }),
    ));
    expect(await screen.findByRole('heading', { name: 'Confirm Save' })).toBeInTheDocument();
    expect(screen.getByText('GLM 4.7 Flash')).toBeInTheDocument();
    expect(screen.getByText('Pending save · Assigned to development · Inactive')).toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: /back to edit/i }));
    expect(await screen.findByText(/GLM 4\.7 Flash is ready to save/i)).toBeInTheDocument();
    expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).value).toContain('custom-glm-4-7-flash');
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(
      'aiRouting',
      7,
      expect.objectContaining({
        reasoningConfiguration: expect.objectContaining({
          customProfileRevisions: [expect.objectContaining({ name: 'GLM 4.7 Flash', classification: 'Compatible, unverified', toolCompatibility: { status: 'unverified', levels: [] } })],
          routeAssignments: { development: { activeProfile: { id: 'custom-glm-4-7-flash', revision: 1, hash: expect.stringMatching(/^[0-9a-f]{64}$/) } } },
        }),
      }),
      ['reasoning_profile_unverified'],
    ));
    await screen.findByRole('heading', { name: 'Execution succeeded' });
    const savedValues = api.start.mock.calls[0][2];
    const savedProfile = savedValues.reasoningConfiguration.customProfileRevisions[0];
    expect(savedValues.reasoningConfiguration.routeAssignments.development.activeProfile).toEqual({ id: savedProfile.id, revision: savedProfile.revision, hash: savedProfile.hash });
    api.configuration.mockResolvedValue({ mode: 'enterprise', revision: 8, applicableSections: ['aiRouting'], sections: { aiRouting: { ...aiRouting, ...savedValues } }, activeRunId: null, latest: {} });
    api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: [savedProfile], notices: [], usage: [], routes: ['development'], routeCatalogStatus: 'ready' });
    cleanup();
    const remounted = render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
    await waitFor(() => expect(screen.getByLabelText('development reasoning profile')).toHaveValue(`${savedProfile.id}\u001f${savedProfile.revision}\u001f${savedProfile.hash}`));
    const restored = JSON.parse((remounted.container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
    expect(restored).toEqual(savedValues.reasoningConfiguration);
  });

  it('saves a mapped custom revision while preserving another configured route and its saved custom profile', async () => {
    const savedCustom = normalizeCustomProfile({ id: 'custom-archive', name: 'Archive reasoning', schemaVersion: 1, revision: 3, enabled: true, supportedLevels: ['off'], removePaths: ['reasoning_effort'], levels: { off: [{ path: 'reasoning_effort', value: 'none' }] }, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' } });
    const archive = { activeProfile: { id: savedCustom.id, revision: savedCustom.revision, hash: savedCustom.hash } };
    const groupRouting = [{ accessGroup: 'archivists', routes: ['archive'], defaultRoute: 'archive', reasoning: 'off' }];
    api.configuration.mockResolvedValueOnce({ mode: 'enterprise', revision: 7, applicableSections: ['aiRouting'], sections: { aiRouting: {
      ...aiRouting, dynamicRoutes: ['development', 'archive'], routeContextWindows: { development: 262144, archive: 65536 }, groupRouting,
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [savedCustom], routeAssignments: { ...aiRouting.reasoningConfiguration.routeAssignments, archive } },
    } }, activeRunId: null, latest: {} });
    api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: [savedCustom, { ...aiRouting.reasoningConfiguration.routeAssignments.development.activeProfile, name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'] }], notices: [], usage: [], routes: ['development', 'archive', 'unconfigured'], routeCatalogStatus: 'ready' });
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map Profile for development' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Map Profile for development' }));
    await screen.findByText('Compatible reasoning behavior found');
    await fireEvent.input(screen.getByLabelText('Profile name'), { target: { value: 'Development custom' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create & Assign' }));
    expect(api.preview).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Confirm Save' });
    const values = api.preview.mock.calls[0][2];
    const revisions = values.reasoningConfiguration.customProfileRevisions;
    expect(revisions).toEqual([savedCustom, expect.objectContaining({ id: 'custom-development-custom', revision: 1 })]);
    expect(values.reasoningConfiguration.routeAssignments).toEqual({ archive, development: { activeProfile: { id: revisions[1].id, revision: revisions[1].revision, hash: revisions[1].hash } } });
    expect(values.dynamicRoutes).toEqual(['development', 'archive']);
    expect(values.routeContextWindows).toEqual({ development: 262144, archive: 65536 });
    expect(values.defaultRoute).toEqual(aiRouting.defaultRoute);
    expect(values.groupRouting).toEqual(groupRouting);
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map Profile for unconfigured' })).toBeEnabled());
    expect(screen.getByLabelText('archive reasoning profile')).toHaveValue(`${savedCustom.id}\u001f${savedCustom.revision}\u001f${savedCustom.hash}`);
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Confirm Save' });
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith('aiRouting', 7, values, ['reasoning_profile_unverified']));
  });

  it('keeps a matched Kimi selection in the hidden draft until explicit Save confirmation', async () => {
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
    await fireEvent.click(screen.getByRole('button', { name: /map profile for development/i }));
    const select = await screen.findByRole('button', { name: 'Assign Kimi thinking' });
    expect(draft()).toEqual(aiRouting.reasoningConfiguration);
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Create & Assign' })).toBeNull();
    await fireEvent.click(select);
    const expected = { ...aiRouting.reasoningConfiguration, routeAssignments: { development: { activeProfile: kimiRef } } };
    expect(draft()).toEqual(expected);
    expect(aiRouting.reasoningConfiguration.routeAssignments.development.activeProfile.id).toBe('workers-ai-glm-thinking');
    expect(screen.queryByRole('heading', { name: /discover compatibility for development/i })).toBeNull();
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith('aiRouting', 7, expect.objectContaining({ reasoningConfiguration: expected })));
    expect(screen.queryByLabelText('Profiles pending save')).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await waitFor(() => expect(screen.getByLabelText('development reasoning profile')).toHaveValue(`${kimiRef.id}\u001f${kimiRef.revision}\u001f${kimiRef.hash}`));
    expect(draft()).toEqual(expected);
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith('aiRouting', 7, expect.objectContaining({ reasoningConfiguration: expected }), ['reasoning_profile_unverified']));
  });

  it('blocks Save confirmation until the API warning is confirmed and submits that exact code', async () => {
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);

    await waitFor(() => expect((screen.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(2));
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Route development has incomplete profile evidence')).toBeInTheDocument());

    const apply = screen.getByRole('button', { name: 'Confirm Save' });
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
