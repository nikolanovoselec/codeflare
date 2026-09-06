import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationPreview } from '../../api/client';
import type { FallbackRouting, PiReasoningLevel, ProfileRevisionRef, ReasoningConfiguration, ReasoningDiscoveryResult, ReasoningRouteVerification } from '../../types';

const api = vi.hoisted(() => ({ configuration: vi.fn(), catalog: vi.fn(), preview: vi.fn(), start: vi.fn(), run: vi.fn(), inventory: vi.fn(), discover: vi.fn() }));
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

const ref = { id: 'workers-ai-glm-thinking', revision: 1, hash: 'a'.repeat(64) };
const levels: PiReasoningLevel[] = ['off', 'medium', 'high'];
const key = (profile: ProfileRevisionRef) => `${profile.id}\u001f${profile.revision}\u001f${profile.hash}`;
const proof = (route = 'development', profileRef: ProfileRevisionRef = ref, supportedLevels = levels): ReasoningRouteVerification => ({
  schemaVersion: 1, profileRef, routeVersion: `${route}-v1`, inventoryDigest: `${route}-digest`,
  connectionFingerprint: 'saved-connection-digest', canaryVersion: 'canary', supportedLevels,
  scope: 'single-model', checkedAt: '2026-09-06T12:00:00Z',
});
const inventory = (route: string, verification?: ReasoningRouteVerification) => ({
  route, routeVersion: `${route}-v1`, inventoryDigest: `${route}-digest`,
  legs: [{ nodeId: `${route}-model`, provider: 'workers-ai', declaredModel: `@cf/${route}` }],
  ...(verification && { verification }),
});
const verified = (verification = proof(), checkId = 'development-check'): ReasoningDiscoveryResult => ({
  classification: 'Verified', assignable: true, compatibleLevels: verification.supportedLevels,
  diagnostics: [], checkId, verification,
});
const profileDraft = {
  schemaVersion: 1, enabled: true, ingressContract: 'ai-gateway-chat-completions',
  supportedLevels: ['off', 'medium'], removePaths: ['reasoning_effort'],
  levels: { off: [{ path: 'reasoning_effort', value: null }], medium: [{ path: 'reasoning_effort', value: 'medium' }] },
  aliases: {}, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: null },
  recognizedResponseFields: {}, classification: 'Compatible, unverified',
  toolCompatibility: { status: 'unverified', levels: [] }, validatedTransports: [], limitations: [], evidence: [],
};
const mapped = (): ReasoningDiscoveryResult => ({
  route: 'development', classification: 'Verified', assignable: true, outcome: 'custom-profile', profileDraft,
});
const customRef = (profile: ProfileRevisionRef): ProfileRevisionRef => ({ id: profile.id, revision: profile.revision, hash: profile.hash });
const group = { accessGroup: 'developers', routes: ['development'], defaultRoute: 'development', reasoning: 'medium' };
const aiRouting = () => ({
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', tokenState: 'administration',
  dynamicRoutes: ['development'], defaultRoute: { route: 'development', reasoning: 'medium' },
  routeContextWindows: { development: 262144 }, availableAccessGroups: ['developers', 'archivists', 'support'],
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], fallbackRouting: { enabled: false },
    routeAssignments: { development: { activeProfile: ref, verification: proof() } },
  } as ReasoningConfiguration,
  groupRouting: [group],
});
const configuration = (routing: unknown = aiRouting(), revision = 7) => ({
  mode: 'enterprise', revision, applicableSections: ['aiRouting'], sections: { aiRouting: routing, domain: {} }, activeRunId: null, latest: {},
});
const catalog = () => ({
  schemaVersion: 1, profiles: [{ ...ref, name: 'GLM thinking', enabled: true, supportedLevels: levels }],
  notices: [], usage: [], routes: ['development'], routeCatalogStatus: 'ready',
  connection: { status: 'ready', message: 'Routes can be read.' },
});
const warning = { code: 'reasoning_observed_path', message: 'Development passed on the observed path. Other backends remain untested.' };
interface SubmittedRouting {
  gatewayUrl: string;
  replacementToken: string;
  dynamicRoutes: string[];
  defaultRoute: { route: string; reasoning: string };
  routeContextWindows: Record<string, number>;
  reasoningConfiguration: ReasoningConfiguration;
  groupRouting: typeof group[];
  fallbackRouting: FallbackRouting;
  routeChecks: Record<string, string | null>;
}
const preview = (section: ConfigurationPreview['section'], baseRevision: number, values: SubmittedRouting): ConfigurationPreview => ({
  section, baseRevision, currentRevision: baseRevision,
  changes: [{ field: 'reasoningConfiguration', after: values.reasoningConfiguration }],
  tasks: [{ id: 'configure_model_routing', dependsOn: [] }], warnings: [], exclusions: [],
});
const stream = () => new Response(`${JSON.stringify({ type: 'snapshot', run: { runId: 'saved-routing', section: 'aiRouting', state: 'succeeded', tasks: [], resultingRevision: 8 } })}\n`);
const mount = () => render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
async function section(name: string) {
  const navigation = await screen.findByRole('navigation', { name: 'AI Gateway configuration sections' });
  await fireEvent.click(within(navigation).getByRole('button', { name }));
}
async function openRoute(name: string) {
  await section('Routes');
  const button = await screen.findByRole('button', { name: `Configure ${name}` });
  if (button.getAttribute('aria-expanded') === 'false') await fireEvent.click(button);
}
async function verifyRoute(name = 'development') {
  await openRoute(name);
  const button = screen.getByRole('button', { name: `Verify Profile for ${name}` });
  await waitFor(() => expect(button).toBeEnabled());
  await fireEvent.click(button);
  expect(await within(screen.getByRole('article', { name: `${name} route` })).findByText('Check passed. Assign access and confirm Save to activate this draft.')).toBeVisible();
}
const draft = (container: HTMLElement): ReasoningConfiguration => JSON.parse((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
const submitted = (): SubmittedRouting => api.preview.mock.calls[api.preview.mock.calls.length - 1]![2];
const saved = (): SubmittedRouting => api.start.mock.calls[api.start.mock.calls.length - 1]![2];
// Server GET returns durable configuration, not credential drafts or transient check receipts.
function persisted(values: SubmittedRouting) {
  const { replacementToken: _token, routeChecks: _checks, ...routing } = values;
  return { ...routing, tokenState: 'administration', availableAccessGroups: aiRouting().availableAccessGroups };
}
async function review() {
  const save = screen.getByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toBeEnabled());
  await fireEvent.click(save);
  expect(await screen.findByRole('heading', { name: 'Confirm Save' })).toBeVisible();
}
async function confirm() {
  await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
  expect(await screen.findByRole('heading', { name: 'Execution succeeded' })).toBeVisible();
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  window.history.replaceState({}, '', '/admin/environment/aiRouting');
  api.configuration.mockResolvedValue(configuration());
  api.catalog.mockResolvedValue(catalog());
  api.preview.mockImplementation(async (section, baseRevision, values) => preview(section, baseRevision, values));
  api.inventory.mockImplementation(async (route: string) => inventory(route, route === 'development' ? proof() : undefined));
  api.start.mockImplementation(async () => stream());
});
afterEach(cleanup);

describe('REQ-ENTERPRISE-031 explicit routing activation', () => {
  it('REQ-ENTERPRISE-044: Save and direct submission wait for a checked route assigned to a group', async () => {
    const initial = aiRouting();
    initial.groupRouting = [];
    initial.reasoningConfiguration.routeAssignments.development = { activeProfile: ref, routeVersion: 'development-v1', legs: [{
      nodeId: 'development-model', provider: 'workers-ai', declaredModel: '@cf/development', profileRef: ref,
      evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions', status: 'Verified' },
    }] };
    api.configuration.mockResolvedValueOnce(configuration(initial));
    api.inventory.mockImplementation(async (route: string) => inventory(route));
    api.discover.mockResolvedValueOnce(verified());
    mount();
    await openRoute('development');
    await screen.findByText('@cf/development');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await fireEvent.submit(save.closest('form')!);
    expect(api.preview).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Confirm Save' })).not.toBeInTheDocument();
    await verifyRoute();
    expect(save).toBeDisabled();
    expect(screen.getByText('Assign a checked route to at least one group before saving.')).toBeVisible();
    await fireEvent.submit(save.closest('form')!);
    expect(api.preview).not.toHaveBeenCalled();
    await section('Access & fallback');
    await fireEvent.click(screen.getByRole('button', { name: 'Add group policy' }));
    expect(screen.getByRole('checkbox', { name: 'developers development route' })).toBeChecked();
    await review();
    expect(submitted().dynamicRoutes).toEqual(['development']);
    expect(submitted().groupRouting).toEqual([group]);
    expect(submitted().routeChecks).toEqual({ development: 'development-check' });
    expect(api.start).not.toHaveBeenCalled();
  });

  it.each(['legacy evidence', 'missing inventory digest', 'missing saved inventory proof', 'mismatched saved connection', 'mismatched saved profile'] as const)(
    'REQ-ENTERPRISE-044: %s cannot enable Save for a configured group', async (invalid) => {
      const initial = aiRouting();
      const inspected = inventory('development', proof());
      if (invalid === 'legacy evidence') {
        initial.reasoningConfiguration.routeAssignments.development = { activeProfile: ref, legs: [{
          nodeId: 'development-model', provider: 'workers-ai', declaredModel: '@cf/development', profileRef: ref,
          evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions', status: 'Verified' },
        }] };
      }
      if (invalid === 'missing saved inventory proof') inspected.verification = undefined;
      if (invalid === 'missing inventory digest') inspected.inventoryDigest = '';
      if (invalid === 'mismatched saved connection') inspected.verification = { ...proof(), connectionFingerprint: 'other-connection' };
      if (invalid === 'mismatched saved profile') inspected.verification = { ...proof(), profileRef: { ...ref, hash: 'f'.repeat(64) } };
      api.configuration.mockResolvedValueOnce(configuration(initial));
      api.inventory.mockResolvedValue(inspected);
      const view = mount();
      await openRoute('development');
      await screen.findByText('@cf/development');
      expect(screen.getByRole('button', { name: 'Configure development' })).toHaveTextContent('Needs verification · inactive');
      const save = screen.getByRole('button', { name: 'Save' });
      expect(save).toBeDisabled();
      await fireEvent.submit(save.closest('form')!);
      expect(api.preview).not.toHaveBeenCalled();
      expect(api.start).not.toHaveBeenCalled();
      expect(screen.queryByRole('heading', { name: 'Confirm Save' })).not.toBeInTheDocument();
      const groups = JSON.parse((view.container.querySelector('input[name="groupRouting"]') as HTMLInputElement).value);
      expect(groups).toEqual([{ accessGroup: 'developers', routes: [], defaultRoute: '', reasoning: 'off' }]);
    },
  );

  it('REQ-ENTERPRISE-038: saves automatic verification with the route and restores its indicator after reload', async () => {
    const initial = aiRouting();
    initial.reasoningConfiguration.routeAssignments.development = { activeProfile: ref };
    api.configuration.mockResolvedValueOnce(configuration(initial));
    api.inventory.mockImplementation(async (route: string) => inventory(route));
    api.discover.mockResolvedValueOnce(verified());
    mount();
    await openRoute('development');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await verifyRoute();
    expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: ref, maxCompletionTokens: 4096 });
    expect(api.start).not.toHaveBeenCalled();
    await review();
    expect(api.start).not.toHaveBeenCalled();
    await confirm();
    const savedValues = saved();
    expect(savedValues.reasoningConfiguration.routeAssignments.development).toEqual({ activeProfile: ref, routeVersion: 'development-v1', verification: proof() });
    expect(savedValues.routeChecks).toEqual({ development: 'development-check' });
    expect(api.start).toHaveBeenCalledWith('aiRouting', 7, submitted(), []);
    api.configuration.mockResolvedValueOnce(configuration(persisted(savedValues), 8));
    api.inventory.mockImplementation(async (route: string) => inventory(route, savedValues.reasoningConfiguration.routeAssignments[route]?.verification));
    cleanup();
    const reloaded = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(within(screen.getByRole('button', { name: 'Configure development' })).getByText('Verified')).toBeVisible();
    expect(draft(reloaded.container).routeAssignments.development).toEqual(savedValues.reasoningConfiguration.routeAssignments.development);
    // Restoring a persisted proof must use management reads, not another paid check.
    expect(api.discover).toHaveBeenCalledTimes(1);
  });

  it('REQ-ENTERPRISE-034: saves a different manually selected revision without configuring unrelated gateway routes', async () => {
    const nextRef = { ...ref, revision: 2, hash: 'b'.repeat(64) };
    api.catalog.mockResolvedValue({ ...catalog(), profiles: [...catalog().profiles, { ...nextRef, name: 'GLM thinking', enabled: true, supportedLevels: levels }], routes: ['development', 'unconfigured'] });
    api.discover.mockResolvedValueOnce(verified(proof('development', nextRef), 'selected-revision-check'));
    const view = mount();
    await openRoute('development');
    const select = screen.getByLabelText('development Pi compatibility profile');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(select).toHaveValue(key(ref));
    await fireEvent.change(select, { target: { value: key(nextRef) } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(draft(view.container).routeAssignments.development.activeProfile).toEqual(nextRef);
    await verifyRoute();
    expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: nextRef, maxCompletionTokens: 4096 });
    await openRoute('unconfigured');
    expect(screen.getByLabelText('unconfigured Pi compatibility profile')).toHaveValue('');
    await review();
    expect(within(screen.getByRole('table', { name: 'Route profiles' })).queryByRole('row', { name: /unconfigured/ })).not.toBeInTheDocument();
    await confirm();
    const savedValues = saved();
    expect(savedValues).toEqual({
      gatewayUrl: aiRouting().gatewayUrl, replacementToken: '', dynamicRoutes: ['development'], routeContextWindows: { development: 262144 },
      defaultRoute: aiRouting().defaultRoute, groupRouting: [group], fallbackRouting: { enabled: false }, routeChecks: { development: 'selected-revision-check' },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], fallbackRouting: { enabled: false }, routeAssignments: { development: { activeProfile: nextRef, routeVersion: 'development-v1', verification: proof('development', nextRef) } } },
    });
    api.configuration.mockResolvedValueOnce(configuration(persisted(savedValues), 8));
    api.inventory.mockImplementation(async (route: string) => inventory(route, route === 'development' ? proof('development', nextRef) : undefined));
    cleanup(); mount();
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(nextRef));
    await openRoute('unconfigured');
    expect(screen.getByLabelText('unconfigured Pi compatibility profile')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Configure unconfigured' })).toHaveTextContent('Not active in a policy');
  });

  it('REQ-ENTERPRISE-036: creates and assigns to the mapped route only, retaining the canonical draft until explicit Save', async () => {
    api.discover.mockResolvedValueOnce(mapped());
    const view = mount();
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map Profile for development' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Map Profile for development' }));
    await screen.findByText('Create a custom Pi profile');
    await fireEvent.input(screen.getByLabelText('Profile name'), { target: { value: 'GLM 4.7 Flash' } });
    await fireEvent.keyDown(screen.getByLabelText('Profile name'), { key: 'Enter' });
    expect(api.preview).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Create & Assign' }));
    const expectedProfile = normalizeCustomProfile({ ...profileDraft, id: 'custom-glm-4-7-flash', name: 'GLM 4.7 Flash', revision: 1 });
    const selectedRef = customRef(expectedProfile);
    expect(draft(view.container).customProfileRevisions).toEqual([expectedProfile]);
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(selectedRef));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
    const selectedProof = proof('development', selectedRef, ['off', 'medium']);
    api.discover.mockResolvedValueOnce(verified(selectedProof, 'custom-draft-check'));
    await verifyRoute();
    expect(api.discover).toHaveBeenLastCalledWith({ route: 'development', profileRef: selectedRef, profileDraft: expectedProfile, maxCompletionTokens: 4096 });
    await review();
    const firstPreview = submitted();
    const row = within(screen.getByRole('table', { name: 'Route profiles' })).getByRole('row', { name: /development/ });
    expect(within(row).getByText('GLM 4.7 Flash')).toBeVisible();
    expect(within(row).getByText('Pending save')).toBeVisible();
    expect(firstPreview.reasoningConfiguration.customProfileRevisions).toEqual([expectedProfile]);
    expect(firstPreview.reasoningConfiguration.routeAssignments.development).toEqual({ activeProfile: selectedRef, routeVersion: 'development-v1', verification: selectedProof });
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(selectedRef));
    expect(draft(view.container)).toEqual(firstPreview.reasoningConfiguration);
    await review();
    expect(submitted()).toEqual(firstPreview);
    await confirm();
    expect(api.start).toHaveBeenCalledWith('aiRouting', 7, firstPreview, []);
    const savedValues = saved();
    api.configuration.mockResolvedValueOnce(configuration(persisted(savedValues), 8));
    api.catalog.mockResolvedValue({ ...catalog(), profiles: [expectedProfile] });
    api.inventory.mockImplementation(async (route: string) => inventory(route, selectedProof));
    cleanup();
    const reloaded = mount();
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(selectedRef));
    expect(draft(reloaded.container)).toEqual(savedValues.reasoningConfiguration);
    expect(within(screen.getByRole('button', { name: 'Configure development' })).getByText('Verified')).toBeVisible();
    // Map + selected Verify only; neither Back nor reload should start another paid check.
    expect(api.discover).toHaveBeenCalledTimes(2);
  });

  it('REQ-ENTERPRISE-036: saves a mapped custom revision while preserving another configured route and its saved custom profile', async () => {
    const archived = normalizeCustomProfile({ id: 'custom-archive', name: 'Archive reasoning', schemaVersion: 1, revision: 3, enabled: true, supportedLevels: ['off'], removePaths: ['reasoning_effort'], levels: { off: [{ path: 'reasoning_effort', value: 'none' }] }, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' } });
    const archiveProof = proof('archive', customRef(archived), ['off']);
    const archive = { activeProfile: customRef(archived), verification: archiveProof };
    const initial = { ...aiRouting(), dynamicRoutes: ['development', 'archive'], routeContextWindows: { development: 262144, archive: 65536 },
      groupRouting: [group, { accessGroup: 'archivists', routes: ['archive'], defaultRoute: 'archive', reasoning: 'off' }],
      reasoningConfiguration: { ...aiRouting().reasoningConfiguration, customProfileRevisions: [archived], routeAssignments: { development: { activeProfile: ref }, archive } },
    };
    api.configuration.mockResolvedValueOnce(configuration(initial));
    api.catalog.mockResolvedValue({ ...catalog(), profiles: [...catalog().profiles, archived], routes: ['development', 'archive', 'unconfigured'] });
    api.inventory.mockImplementation(async (route: string) => inventory(route, route === 'archive' ? archiveProof : undefined));
    api.discover.mockResolvedValueOnce(mapped());
    mount();
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map Profile for development' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Map Profile for development' }));
    await screen.findByText('Create a custom Pi profile');
    await fireEvent.input(screen.getByLabelText('Profile name'), { target: { value: 'Development custom' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create & Assign' }));
    expect(api.preview).not.toHaveBeenCalled();
    await review();
    const firstPreview = submitted();
    const pending = normalizeCustomProfile({ ...profileDraft, id: 'custom-development-custom', name: 'Development custom', revision: 1 });
    expect(firstPreview.reasoningConfiguration.customProfileRevisions).toEqual([archived, pending]);
    expect(firstPreview.reasoningConfiguration.routeAssignments).toEqual({ archive, development: { activeProfile: customRef(pending) } });
    expect(firstPreview.dynamicRoutes).toEqual(['archive']);
    expect(firstPreview.routeContextWindows).toEqual({ development: 262144, archive: 65536 });
    expect(firstPreview.defaultRoute).toEqual({ route: 'archive', reasoning: 'off' });
    expect(firstPreview.groupRouting).toEqual([
      { accessGroup: 'developers', routes: [], defaultRoute: '', reasoning: 'off' },
      { accessGroup: 'archivists', routes: ['archive'], defaultRoute: 'archive', reasoning: 'off' },
    ]);
    expect(firstPreview.fallbackRouting).toEqual({ enabled: false });
    expect(within(screen.getByRole('region', { name: 'Other profiles pending save' })).getByText('Development custom')).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await openRoute('archive');
    expect(screen.getByLabelText('archive Pi compatibility profile')).toHaveValue(key(customRef(archived)));
    await openRoute('development');
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(customRef(pending)));
    await review();
    expect(submitted()).toEqual(firstPreview);
    await confirm();
    expect(api.start).toHaveBeenCalledWith('aiRouting', 7, firstPreview, []);
    expect(saved().dynamicRoutes).toEqual(['archive']);
    expect(screen.getByRole('heading', { name: 'Execution succeeded' })).toBeVisible();
    // The unfinished development draft was mapped but never verified or activated.
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', maxCompletionTokens: 4096 });
  });

  it('REQ-ENTERPRISE-035: keeps a matched Kimi selection in the hidden draft until explicit Save confirmation', async () => {
    const kimiRef = { id: 'workers-ai-kimi-k-thinking', revision: 3, hash: 'b'.repeat(64) };
    api.catalog.mockResolvedValue({ ...catalog(), profiles: [...catalog().profiles, { ...kimiRef, name: 'Kimi thinking', supportedLevels: ['medium', 'high'] }] });
    api.discover.mockResolvedValueOnce({ route: 'development', classification: 'Verified', assignable: true, outcome: 'existing-profile',
      matchedProfiles: [{ profileRef: kimiRef, name: 'Kimi thinking', supportedLevels: ['medium', 'high'] }],
    });
    const view = mount();
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map Profile for development' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Map Profile for development' }));
    const assign = await screen.findByRole('button', { name: 'Assign profile' });
    expect(draft(view.container).routeAssignments.development.activeProfile).toEqual(ref);
    expect(screen.queryByRole('button', { name: 'Create & Assign' })).not.toBeInTheDocument();
    expect(api.preview).not.toHaveBeenCalled();
    await fireEvent.click(assign);
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(kimiRef));
    expect(draft(view.container).routeAssignments.development).toEqual({ activeProfile: kimiRef });
    expect(draft(view.container).customProfileRevisions).toEqual([]);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
    const selectedProof = proof('development', kimiRef, ['medium', 'high']);
    api.discover.mockResolvedValueOnce(verified(selectedProof, 'kimi-check'));
    await verifyRoute();
    expect(api.discover).toHaveBeenLastCalledWith({ route: 'development', profileRef: kimiRef, maxCompletionTokens: 4096 });
    await review();
    const firstPreview = submitted();
    expect(firstPreview.reasoningConfiguration.routeAssignments.development).toEqual({ activeProfile: kimiRef, routeVersion: 'development-v1', verification: selectedProof });
    expect(screen.queryByText('Pending save')).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await openRoute('development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('development Pi compatibility profile')).toHaveValue(key(kimiRef));
    expect(draft(view.container)).toEqual(firstPreview.reasoningConfiguration);
    await review();
    expect(submitted()).toEqual(firstPreview);
    await confirm();
    expect(api.start).toHaveBeenCalledWith('aiRouting', 7, firstPreview, []);
    expect(screen.getByText('Workers AI · Kimi')).toBeVisible();
  });

  it('REQ-ENTERPRISE-041: blocks Save confirmation until the API warning is confirmed and submits that exact code', async () => {
    const observedProof = { ...proof(), scope: 'observed-path' as const };
    const initial = aiRouting();
    initial.reasoningConfiguration.routeAssignments.development.verification = observedProof;
    api.configuration.mockResolvedValueOnce(configuration(initial));
    api.inventory.mockImplementation(async (route: string) => ({ ...inventory(route, observedProof), legs: [
      ...inventory(route).legs, { nodeId: 'backup', provider: 'openai', declaredModel: 'backup-model' },
    ] }));
    api.preview.mockImplementation(async (section, baseRevision, values) => ({ ...preview(section, baseRevision, values), warnings: [warning] }));
    mount();
    await screen.findByRole('button', { name: 'Save' });
    await review();
    expect(screen.getByText(warning.message)).toBeVisible();
    const apply = screen.getByRole('button', { name: 'Confirm Save' });
    expect(apply).toBeDisabled();
    await fireEvent.click(apply);
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    expect(apply).toBeEnabled();
    expect(api.start).not.toHaveBeenCalled();
    await confirm();
    expect(api.start).toHaveBeenCalledWith('aiRouting', 7, submitted(), [warning.code]);
    expect(saved().reasoningConfiguration.routeAssignments.development.verification).toEqual(observedProof);
    expect(saved().dynamicRoutes).toEqual(['development']);
    expect(screen.getByRole('table', { name: 'Route profiles' })).toBeVisible();
  });
});
