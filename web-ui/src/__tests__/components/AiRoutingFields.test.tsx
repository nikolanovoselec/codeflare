import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import { normalizeCustomProfile } from '../../../../src/lib/reasoning-profiles';
import type {
  PiReasoningLevel, ProfileRevisionRef, ReasoningCatalog, ReasoningConfiguration,
  ReasoningDiscoveryResult, ReasoningManagementContext, ReasoningRouteAssignment,
  ReasoningRouteInventory, ReasoningRouteVerification,
} from '../../types';

const api = vi.hoisted(() => ({ catalog: vi.fn(), inventory: vi.fn(), discover: vi.fn() }));
vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args),
  getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.discover(...args),
}));

const hash = (value: string) => value.repeat(64);
const catalog: ReasoningCatalog = {
  schemaVersion: 1,
  profiles: [
    { id: 'openai-gpt-chat-tools-reasoning', revision: 1, hash: hash('1'), name: 'OpenAI GPT reasoning', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'openai-gpt-chat-tools-off', revision: 1, hash: hash('2'), name: 'OpenAI GPT off only', supportedLevels: ['off'], classification: 'Verified' },
    { id: 'workers-ai-gemma-thinking', revision: 1, hash: hash('3'), name: 'Gemma thinking', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: hash('b'), name: 'Kimi thinking', supportedLevels: ['medium', 'high'], classification: 'Verified' },
    { id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a'), name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'], classification: 'Verified' },
    { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: hash('6'), name: 'Mesh binary thinking', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
  ],
  notices: [{ id: 'gpt-oss-tool-replay', name: 'GPT-OSS tool replay', assignable: false, summary: 'Tool-result replay is unsupported.' }],
  usage: [], routes: ['general_usage', 'development', 'research'], routeCatalogStatus: 'ready',
};
const glmRef = { id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a') };
const kimiRef = { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: hash('b') };
const offRef = { id: 'openai-gpt-chat-tools-off', revision: 1, hash: hash('2') };
const selectedRef = (route: string) => route === 'development' ? kimiRef : glmRef;
const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  dynamicRoutes: ['general_usage', 'development'],
  defaultRoute: { route: 'general_usage', reasoning: 'off' },
  routeContextWindows: { general_usage: 262144, development: 131072 },
  reasoningConfiguration: {
    schemaVersion: 1, customProfileRevisions: [],
    routeAssignments: { general_usage: { activeProfile: glmRef }, development: { activeProfile: kimiRef } },
  } as ReasoningConfiguration,
  availableAccessGroups: ['developers', 'support', 'research-team'],
  groupRouting: [
    { accessGroup: 'developers', routes: ['general_usage', 'development'], defaultRoute: 'development', reasoning: 'medium' },
    { accessGroup: 'support', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'off' },
  ],
};
const proof = (route = 'development', profileRef = selectedRef(route), scope: ReasoningRouteVerification['scope'] = 'single-model'): ReasoningRouteVerification => ({
  schemaVersion: 1, profileRef: { ...profileRef }, routeVersion: `${route}-v2`, inventoryDigest: `${route}-digest`,
  connectionFingerprint: 'saved-connection-digest', canaryVersion: 'pi-canary',
  supportedLevels: [...(catalog.profiles.find((profile) => profile.id === profileRef.id)?.supportedLevels ?? ['medium', 'high'])],
  scope, checkedAt: '2026-09-06T12:00:00Z',
});
const routeInventory = (route: string): ReasoningRouteInventory => ({
  route, routeVersion: `${route}-v2`, inventoryDigest: `${route}-digest`,
  legs: [
    { nodeId: `${route}-primary`, provider: 'custom-enterprise', declaredModel: `${route}-alias` },
    { nodeId: `${route}-fallback`, provider: 'workers-ai', declaredModel: `@cf/${route}-fallback` },
  ],
  commonLevels: [], warnings: ['missing_leg_evidence'],
});
const singleInventory = (route: string): ReasoningRouteInventory => ({
  ...routeInventory(route), legs: [{ nodeId: `${route}-only`, provider: 'workers-ai', declaredModel: `@cf/${route}-model` }],
});
const legacyEvidence = () => ({ current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions', status: 'Verified' });
const verifiedReport = (route = 'development', profileRef = selectedRef(route), scope: ReasoningRouteVerification['scope'] = 'single-model'): ReasoningDiscoveryResult => ({
  route, classification: 'Verified', assignable: true, requestedCompletionCeiling: 4096,
  compatibleLevels: proof(route, profileRef).supportedLevels,
  piCompatibility: { status: 'verified', verifiedLevels: proof(route, profileRef).supportedLevels, failedLevels: [] },
  reasoningConfiguration: { off: 'unsupported-by-profile', routeHealthVerified: true },
  diagnostics: [], accounting: { logicalProbes: 2, httpAttempts: 3 }, evidence: legacyEvidence(),
  checkId: `${route}-check`, verification: proof(route, profileRef, scope),
});
const savedDevelopmentAssignment = (): ReasoningRouteAssignment => ({ activeProfile: { ...kimiRef }, routeVersion: 'development-v2', verification: proof() });
const legacyDevelopmentAssignment = (): ReasoningRouteAssignment => ({
  activeProfile: { ...kimiRef }, routeVersion: 'development-v2',
  legs: [{ ...singleInventory('development').legs[0], profileRef: { ...kimiRef }, evidence: legacyEvidence() }],
});
const withDevelopment = (assignment: ReasoningRouteAssignment) => ({
  ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: assignment } },
});
function checkedCurrent() {
  api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), ...(route !== 'research' && { verification: proof(route) }) }));
  return { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: {
    general_usage: { activeProfile: { ...glmRef }, verification: proof('general_usage') }, development: savedDevelopmentAssignment(),
  } } };
}
const draftConfiguration = (container: HTMLElement): ReasoningConfiguration => JSON.parse((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
const formValues = (container: HTMLElement) => environmentValues('aiRouting', 'enterprise', new FormData(container.querySelector('form')!)) as Record<string, any>;
const profileKey = (ref: ProfileRevisionRef) => `${ref.id}\u001f${ref.revision}\u001f${ref.hash}`;
const mount = (data: unknown = current) => {
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
  const onReadyChange = vi.fn();
  return { ...render(() => <form onSubmit={submit}><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={data} onReadyChange={onReadyChange} /></form>), submit, onReadyChange };
};
type View = ReturnType<typeof mount>;
async function section(view: View, name: 'Connection' | 'Routes' | 'Access & fallback') {
  await fireEvent.click(within(view.getByRole('navigation', { name: 'AI Gateway configuration sections' })).getByRole('button', { name }));
}
async function openRoute(view: View, route: string) {
  await section(view, 'Routes');
  const toggle = view.getByRole('button', { name: `Configure ${route}` });
  if (toggle.getAttribute('aria-expanded') !== 'true') await fireEvent.click(toggle);
  return view.getByRole('article', { name: `${route} route` });
}
async function ready(view: View, route = 'development') {
  await view.findByText('Connected · 3 routes readable');
  await openRoute(view, route);
  await waitFor(() => expect(view.getByLabelText(`${route} Pi compatibility profile`)).toBeEnabled());
}
async function openGroup(view: View, group: string) {
  await section(view, 'Access & fallback');
  const toggle = view.getByRole('button', { name: `${group} policy` });
  if (toggle.getAttribute('aria-expanded') !== 'true') await fireEvent.click(toggle);
}
async function verifyProfile(view: View, route = 'development') {
  await openRoute(view, route);
  const button = view.getByRole('button', { name: `Verify Profile for ${route}` });
  await waitFor(() => expect(button).toBeEnabled());
  await fireEvent.click(button);
}
function describedText(element: HTMLElement) {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => {
    const helper = document.getElementById(id);
    expect(helper).toBeVisible();
    return helper?.textContent ?? '';
  }).join(' ');
}
async function expectDevelopmentInactive(view: View) {
  expect(formValues(view.container).dynamicRoutes).not.toContain('development');
  expect(formValues(view.container).groupRouting).toEqual([
    { accessGroup: 'developers', routes: [], defaultRoute: '', reasoning: 'off' },
    { accessGroup: 'support', routes: [], defaultRoute: '', reasoning: 'off' },
  ]);
  await openGroup(view, 'developers');
  expect(within(view.getByRole('group', { name: 'developers allowed routes' })).queryByRole('checkbox', { name: 'developers development route' })).toBeNull();
}

beforeEach(() => {
  api.catalog.mockReset().mockResolvedValue(catalog);
  api.inventory.mockReset().mockImplementation(async (route: string) => routeInventory(route));
  api.discover.mockReset().mockResolvedValue({ classification: 'Compatible, unverified', warnings: ['custom_provider_backend_requires_revalidation'], accounting: { logicalProbes: 2, httpAttempts: 3 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// Behavioral fixtures are execution-pending; CI owns RED/GREEN verification.
describe('Structured AI routing', () => {
  it.each(['provider', 'model', 'node'] as const)('REQ-ENTERPRISE-038: drift-before-Verify reconciles saved %s identity for Save without per-leg evidence', async (drift) => {
    const fresh = singleInventory('development');
    if (drift === 'provider') fresh.legs[0].provider = 'openai';
    if (drift === 'model') fresh.legs[0].declaredModel = 'replacement-model';
    if (drift === 'node') fresh.legs[0].nodeId = 'replacement-node';
    api.inventory.mockImplementation(async (route: string) => route === 'development' ? fresh : singleInventory(route));
    api.discover.mockResolvedValueOnce(verifiedReport());
    const saved = withDevelopment(legacyDevelopmentAssignment());
    const view = mount(saved); await ready(view); await verifyProfile(view);
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    const assignment = formValues(view.container).reasoningConfiguration.routeAssignments.development;
    expect(assignment.legs).toEqual(fresh.legs.map(({ nodeId, provider, declaredModel }) => ({ nodeId, provider, declaredModel, profileRef: kimiRef })));
    expect(assignment.verification).toEqual(proof());
    expect(formValues(view.container).routeChecks.development).toBe('development-check');
    expect(saved.reasoningConfiguration.routeAssignments.development).toEqual(legacyDevelopmentAssignment());
  });
  it('REQ-ENTERPRISE-034: preserves checked many-to-many group routes with one scope default route and reasoning', async () => {
    const view = mount(checkedCurrent());
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    await openGroup(view, 'developers');
    expect(view.getByRole('checkbox', { name: 'developers general_usage route' })).toBeChecked();
    expect(view.getByRole('checkbox', { name: 'developers development route' })).toBeChecked();
    expect(view.getByLabelText('developers default route')).toHaveValue('development');
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('medium');
    await openGroup(view, 'support');
    expect(view.getByRole('checkbox', { name: 'support general_usage route' })).toBeChecked();
    expect(view.getByRole('checkbox', { name: 'support development route' })).not.toBeChecked();
    await fireEvent.change(view.getByLabelText('Unconfigured access group'), { target: { value: 'research-team' } });
    await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    expect(view.getByRole('checkbox', { name: 'research-team general_usage route' })).not.toBeChecked();
    await fireEvent.click(view.getByRole('checkbox', { name: 'research-team development route' }));
    expect(formValues(view.container).groupRouting[2]).toEqual({ accessGroup: 'research-team', routes: ['development'], defaultRoute: 'development', reasoning: 'medium' });
    await fireEvent.click(view.getByRole('button', { name: 'Remove research-team policy' }));
    expect(view.queryByLabelText('research-team allowed routes')).toBeNull();
    expect(formValues(view.container).groupRouting).toEqual(current.groupRouting);
  });

  it('REQ-ENTERPRISE-039: preserves exact selected revisions and medium policy defaults when the catalog hydrates', async () => {
    const saved = checkedCurrent();
    const fallbackRouting = { enabled: true, routes: current.dynamicRoutes, defaultRoute: 'general_usage', reasoning: 'medium' };
    let hydrate!: (value: ReasoningCatalog) => void;
    api.catalog.mockReturnValueOnce(new Promise<ReasoningCatalog>((resolve) => { hydrate = resolve; }));
    const view = mount({ ...saved, fallbackRouting });
    await openRoute(view, 'general_usage');
    expect(view.getByLabelText('general_usage Pi compatibility profile')).toBeDisabled();
    hydrate(catalog);
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    expect(view.getByLabelText('general_usage Pi compatibility profile')).toHaveValue(profileKey(glmRef));
    await openRoute(view, 'development');
    expect(view.getByLabelText('development Pi compatibility profile')).toHaveValue(profileKey(kimiRef));
    await openGroup(view, 'developers');
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('medium');
    expect(view.getByLabelText('Fallback default reasoning')).toHaveValue('medium');
    expect(formValues(view.container)).toMatchObject({ defaultRoute: { route: 'general_usage', reasoning: 'medium' }, fallbackRouting, groupRouting: current.groupRouting });
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting });
  });

  it.each(['0', '1.5', ''])('REQ-ENTERPRISE-034: retains invalid context %s without blocking working policies or activating the incomplete route', async (invalid) => {
    const view = mount(checkedCurrent());
    await ready(view, 'research');
    const context = view.getByLabelText('research context window');
    await fireEvent.input(context, { target: { value: invalid } });
    await fireEvent.change(view.getByLabelText('research Pi compatibility profile'), { target: { value: profileKey(glmRef) } });
    expect(view.getByLabelText('research context window')).toBe(context);
    expect(view.getByText(/positive whole-number context window/)).toBeVisible();
    expect(view.container.querySelector('form')!.checkValidity()).toBe(true);
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(formValues(view.container).routeContextWindows).not.toHaveProperty('research');
    expect(draftConfiguration(view.container).routeAssignments.research.activeProfile).toEqual(glmRef);
    api.discover.mockResolvedValueOnce(verifiedReport('research'));
    await verifyProfile(view, 'research');
    await view.findByText('Set context window', { exact: true });
    expect(formValues(view.container).dynamicRoutes).not.toContain('research');
    await openRoute(view, 'development');
    await openRoute(view, 'research');
    expect(view.getByText(/positive whole-number context window/)).toBeVisible();
    await fireEvent.input(view.getByLabelText('research context window'), { target: { value: '65536' } });
    await openGroup(view, 'developers');
    await fireEvent.click(view.getByRole('checkbox', { name: 'developers research route' }));
    expect(formValues(view.container).routeContextWindows.research).toBe(65536);
    expect(formValues(view.container).dynamicRoutes).toEqual([...current.dynamicRoutes, 'research']);
    expect(view.onReadyChange).toHaveBeenLastCalledWith(true);
  });

  it('REQ-ENTERPRISE-034: loads every detected inventory read-only and exposes models in the selected route outside advanced disclosures', async () => {
    let hydrate!: (value: ReasoningCatalog) => void;
    api.catalog.mockReturnValueOnce(new Promise<ReasoningCatalog>((resolve) => { hydrate = resolve; }));
    const view = mount();
    expect(api.inventory).not.toHaveBeenCalled();
    hydrate(catalog);
    await view.findByText('Connected · 3 routes readable');
    for (const route of catalog.routes) {
      const card = await openRoute(view, route);
      expect(await within(card).findByText(`${route}-alias`)).toBeVisible();
      expect(within(card).getByText(`${route}-alias`).closest('details')).toBeNull();
      expect(within(card).getByText(`@cf/${route}-fallback`)).toBeVisible();
      expect(api.inventory).toHaveBeenCalledWith(route);
    }
    expect(draftConfiguration(view.container)).toEqual({ ...current.reasoningConfiguration, fallbackRouting: { enabled: false } });
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(api.discover).not.toHaveBeenCalled();
    await openRoute(view, 'development');
    const profile = view.getByLabelText('development Pi compatibility profile') as HTMLSelectElement;
    expect(Array.from(profile.options, (option) => option.textContent)).toEqual([
      'Choose a profile', 'OpenAI · GPT — tools and reasoning', 'OpenAI · GPT — reasoning off',
      'Workers AI · Gemma', 'Workers AI · Kimi', 'Workers AI · GLM', 'Codeflare Inference Mesh · Qwen / Ornith',
    ]);
    expect(profile).toHaveValue(profileKey(kimiRef));
    expect(within(profile).queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });

  it('REQ-ENTERPRISE-034: offers one primary action on the expanded route and runs route-only protocol discovery', async () => {
    const view = mount(); await ready(view);
    expect(view.getAllByRole('button', { name: /map profile for /i })).toHaveLength(1);
    expect(view.queryByRole('button', { name: /revalidate|start discovery|use evidence/i })).toBeNull();
    const before = draftConfiguration(view.container);
    await fireEvent.click(view.getByRole('button', { name: 'Map Profile for development' }));
    expect(await view.findByText(/compatibility could not be confirmed/i)).toBeVisible();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    // One explicit mapping must not spend additional provider credits through a retry.
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', maxCompletionTokens: 4096 });
  });

  it.each([
    { id: 'workers-ai-kimi-k-thinking', revision: 4, hash: hash('d'), name: 'Kimi thinking', supportedLevels: ['medium', 'high'] as PiReasoningLevel[] },
    { id: 'custom-saved-reasoning', revision: 3, hash: hash('e'), name: 'Saved custom reasoning', supportedLevels: ['medium', 'high'] as PiReasoningLevel[] },
  ])('REQ-ENTERPRISE-034: uses the exact matched $name catalog revision only in the route draft until verification', async (match) => {
    const profileRef = { id: match.id, revision: match.revision, hash: match.hash };
    api.catalog.mockResolvedValueOnce({ ...catalog, profiles: [...catalog.profiles, match] });
    api.discover.mockResolvedValueOnce({
      ...verifiedReport('general_usage', profileRef), outcome: 'existing-profile',
      matchedProfiles: [{ profileRef, name: match.name, supportedLevels: match.supportedLevels }],
    });
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, customProfileRevisions: match.id.startsWith('custom-') ? [match] : [] } };
    const snapshot = structuredClone(saved);
    const view = mount(saved); await ready(view, 'general_usage');
    const before = draftConfiguration(view.container);
    await fireEvent.click(view.getByRole('button', { name: 'Map Profile for general_usage' }));
    const assign = await view.findByRole('button', { name: 'Assign profile' });
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(view.queryByLabelText('Profile name')).toBeNull();
    await fireEvent.click(assign);
    expect(draftConfiguration(view.container)).toEqual({ ...before, routeAssignments: { ...before.routeAssignments, general_usage: { activeProfile: profileRef } } });
    expect(view.getByLabelText('general_usage Pi compatibility profile')).toHaveValue(profileKey(profileRef));
    expect(view.queryByRole('button', { name: 'Assign profile' })).toBeNull();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).routeChecks.general_usage).toBeNull();
    expect(saved).toEqual(snapshot);
    expect(view.submit).not.toHaveBeenCalled();
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'general_usage', maxCompletionTokens: 4096 });
  });

  it('REQ-ENTERPRISE-038: Verify Profile uses fixed 4096 and attaches the server receipt only to the exact route draft', async () => {
    const events: string[] = [];
    api.inventory.mockImplementation(async (route: string) => { events.push(`inventory:${route}`); return singleInventory(route); });
    let complete!: (value: ReasoningDiscoveryResult) => void;
    api.discover.mockImplementationOnce(() => { events.push('discover'); return new Promise((resolve) => { complete = resolve; }); });
    const view = mount(); await ready(view);
    await waitFor(() => expect(api.inventory).toHaveBeenCalledWith('research'));
    const card = view.getByRole('article', { name: 'development route' });
    const verify = within(card).getByRole('button', { name: 'Verify Profile for development' });
    expect(verify).toBeEnabled();
    expect(verify.closest('details')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Map Profile for development' })).toBeVisible();
    expect(within(card).queryByRole('spinbutton', { name: /verification|completion|token/i })).toBeNull();
    expect(within(card).queryByRole('button', { name: /start|add compatibility record/i })).toBeNull();
    const before = draftConfiguration(view.container);
    events.length = 0;
    await fireEvent.click(verify);
    await waitFor(() => expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: kimiRef, maxCompletionTokens: 4096 }));
    expect(events).toEqual(['inventory:development', 'discover']);
    expect(verify).toBeDisabled();
    expect(view.getByLabelText('development Pi compatibility profile')).toBeDisabled();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(formValues(view.container).routeChecks.development).toBeNull();
    complete(verifiedReport());
    expect(await within(card).findByText('Verified', { exact: true })).toBeVisible();
    expect(events).toEqual(['inventory:development', 'discover', 'inventory:development']);
    expect(draftConfiguration(view.container)).toEqual({ ...before, routeAssignments: { ...before.routeAssignments, development: savedDevelopmentAssignment() } });
    expect(formValues(view.container).routeChecks.development).toBe('development-check');
    expect(formValues(view.container).dynamicRoutes).toEqual(['development']);
    expect(current.reasoningConfiguration.routeAssignments.development).toEqual({ activeProfile: kimiRef });
    expect(view.submit).not.toHaveBeenCalled();
    expect(verify).toBeEnabled();
    // A double start would spend provider credits even if the final receipt were identical.
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', profileRef: kimiRef, maxCompletionTokens: 4096 });
  });

  it('REQ-ENTERPRISE-038: observed-path receipts enable access with a backup warning without fabricating per-leg evidence', async () => {
    api.inventory.mockImplementation(async (route: string) => ({ ...routeInventory(route), legs: routeInventory(route).legs.map((leg) => ({ ...leg, provider: 'workers-ai' })) }));
    api.discover.mockResolvedValueOnce(verifiedReport('development', kimiRef, 'observed-path'));
    const view = mount(); await ready(view); await verifyProfile(view);
    expect(await view.findByText('Compatible · backup untested', { exact: true })).toBeVisible();
    expect(view.getByText(/Other backends remain untested/)).toBeVisible();
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container).routeAssignments.development).toEqual({ activeProfile: kimiRef, routeVersion: 'development-v2', verification: proof('development', kimiRef, 'observed-path') });
    expect(formValues(view.container).dynamicRoutes).toEqual(['development']);
    expect(formValues(view.container).routeChecks.development).toBe('development-check');
    await openGroup(view, 'developers');
    expect(view.getByRole('checkbox', { name: 'developers development route' })).toBeChecked();
    expect(within(view.getByRole('group', { name: 'developers allowed routes' })).getByText('Backup untested')).toBeVisible();
  });

  it.each([
    ['route version', { routeVersion: 'development-v3' }],
    ['provider', { legs: [{ ...singleInventory('development').legs[0], provider: 'openai' }] }],
    ['model', { legs: [{ ...singleInventory('development').legs[0], declaredModel: '@cf/replaced-model' }] }],
    ['node', { legs: [{ ...singleInventory('development').legs[0], nodeId: 'replacement' }] }],
    ['backend description', { legs: [{ ...singleInventory('development').legs[0], customProviderBackend: 'changed' }] }],
    ['reachable topology', { legs: routeInventory('development').legs }],
  ])('REQ-ENTERPRISE-038: %s changing the server inventory digest during verification prevents receipt attachment', async (_label, change) => {
    let changed = false;
    // Inventory identity is server-owned; each changed identity produces a different digest.
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), ...(route === 'development' && changed ? { ...change, inventoryDigest: 'changed-digest' } : {}) }));
    let complete!: (value: ReasoningDiscoveryResult) => void;
    api.discover.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const view = mount(); await ready(view);
    const before = draftConfiguration(view.container);
    await verifyProfile(view);
    await waitFor(() => expect(api.discover).toHaveBeenCalled());
    changed = true; complete(verifiedReport());
    expect(await view.findByRole('alert')).toHaveTextContent('The route changed during verification.');
    expect(within(view.getByRole('article', { name: 'development route' })).getByText('Needs verification · inactive', { exact: true })).toBeVisible();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(formValues(view.container).routeChecks.development).toBeNull();
    await expectDevelopmentInactive(view);
  });

  it.each([
    ['complete legacy evidence', {}],
    ['not assignable', { assignable: false }], ['missing assignability', { assignable: undefined }],
    ['unverified classification', { classification: 'Compatible, unverified' }],
    ['stale evidence', { evidence: { ...legacyEvidence(), current: false } }],
    ['missing freshness', { evidence: { toolReplay: true, ingress: 'ai-gateway-chat-completions' } }],
    ['missing replay', { evidence: { ...legacyEvidence(), toolReplay: false } }],
    ['absent replay', { evidence: { current: true, ingress: 'ai-gateway-chat-completions' } }],
    ['wrong ingress', { evidence: { ...legacyEvidence(), ingress: 'direct-provider' } }], ['missing evidence', { evidence: undefined }],
  ])('REQ-ENTERPRISE-038: advisory %s without a server receipt cannot activate a route', async (_label, patch) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce({ ...verifiedReport(), checkId: undefined, verification: undefined, ...patch });
    const view = mount(); await ready(view);
    const before = draftConfiguration(view.container);
    await verifyProfile(view);
    await view.findByRole('table', { name: 'Selected profile checks' });
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(formValues(view.container).routeChecks.development).toBeNull();
    await expectDevelopmentInactive(view);
  });

  it.each([
    ['missing check ID', { checkId: undefined }], ['missing receipt', { verification: undefined }],
    ['not assignable', { assignable: false }], ['missing assignability', { assignable: undefined }],
    ['unverified classification', { classification: 'Compatible, unverified' }],
    ['wrong selected revision', { verification: { ...proof(), profileRef: { ...kimiRef, revision: 2 } } }],
    ['wrong selected hash', { verification: { ...proof(), profileRef: { ...kimiRef, hash: hash('f') } } }],
    ['wrong selected profile', { verification: { ...proof(), profileRef: glmRef } }],
    ['wrong inventory digest', { verification: { ...proof(), inventoryDigest: 'other-inventory' } }],
    ['incomplete diagnostic', { diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'incomplete_final_response' }] }],
    ['completion limit', { diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'completion_limit' }] }],
    ['fatal diagnostic', { diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'transport_error' }] }],
    ['fatal status', { diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'request_rejected', status: 403 }] }],
    ['candidate failure', { candidateResults: [{ profileId: kimiRef.id, classification: 'Unsupported', assignable: false, diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'no_tool_call' }] }] }],
  ])('REQ-ENTERPRISE-038: %s cannot attach a successful current verification receipt', async (_label, patch) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce({ ...verifiedReport(), ...patch });
    const view = mount(); await ready(view);
    const before = draftConfiguration(view.container);
    await verifyProfile(view);
    await view.findByRole('table', { name: 'Selected profile checks' });
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(formValues(view.container).routeChecks.development).toBeNull();
    await expectDevelopmentInactive(view);
  });

  it.each([
    ['failed', { classification: 'Unsupported', assignable: false, outcome: 'unsupported', diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'replay_rejected' }] }, 'High tool replay: Failed', 'The provider rejected the Pi tool-result replay.'],
    ['inconclusive', { classification: 'Inconclusive', assignable: false, outcome: 'inconclusive', diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'completion_limit' }] }, 'High tool replay: Unclear', 'The check was incomplete at the fixed 4096-token budget.'],
  ])('REQ-ENTERPRISE-038: %s check reports the failed stage without enabling access', async (_label, report, cell, message) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce(report);
    const view = mount(); await ready(view); await verifyProfile(view);
    expect(await view.findByRole('cell', { name: cell })).toBeVisible();
    const details = view.getByText('Technical check details').closest('details')!;
    await fireEvent.click(within(details).getByText('Technical check details'));
    expect(within(details).getByText(/Levels: high · Stage: tool-replay/)).toBeVisible();
    expect(within(details).getByText((text) => text.startsWith(message))).toBeVisible();
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container).routeAssignments.development).toEqual({ activeProfile: kimiRef });
    await expectDevelopmentInactive(view);
  });

  it('REQ-ENTERPRISE-038: failed verification hides provider bodies and restores the Verify action without access', async () => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockRejectedValueOnce(new Error('PRIVATE PROVIDER BODY'));
    const view = mount(); await ready(view); await verifyProfile(view);
    expect(await view.findByRole('alert')).toHaveTextContent('Verification failed. Check the connection and try again.');
    expect(view.container).not.toHaveTextContent('PRIVATE');
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
    expect(draftConfiguration(view.container).routeAssignments.development).toEqual({ activeProfile: kimiRef });
    await expectDevelopmentInactive(view);
  });

  it('REQ-ENTERPRISE-040: profile changes clear the result and invalidate receipts even when switching back', async () => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce(verifiedReport());
    const view = mount(); await ready(view); await verifyProfile(view);
    await view.findByText('Verified', { exact: true });
    for (const ref of [glmRef, kimiRef]) {
      await openRoute(view, 'development');
      await fireEvent.change(view.getByLabelText('development Pi compatibility profile'), { target: { value: profileKey(ref) } });
      expect(view.queryByRole('table', { name: 'Selected profile checks' })).toBeNull();
      expect(draftConfiguration(view.container).routeAssignments.development.activeProfile).toEqual(ref);
      expect(draftConfiguration(view.container).routeAssignments.development.verification).toBeUndefined();
      expect(formValues(view.container).routeChecks.development).toBeNull();
      await expectDevelopmentInactive(view);
    }
  });

  it('REQ-ENTERPRISE-038: saved exact receipts enable access only after fresh server-approved inventory arrives', async () => {
    let release!: (value: ReasoningRouteInventory) => void;
    api.inventory.mockImplementation((route: string) => route === 'development' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(singleInventory(route)));
    const saved = withDevelopment(savedDevelopmentAssignment());
    const view = mount(saved); await ready(view);
    await waitFor(() => expect(api.inventory).toHaveBeenCalledWith('development'));
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    release({ ...singleInventory('development'), verification: proof() });
    expect(await view.findByText('Verified', { exact: true })).toBeVisible();
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    expect(formValues(view.container).dynamicRoutes).toEqual(['development']);
    expect(formValues(view.container).routeChecks).toEqual({});
    expect(api.discover).not.toHaveBeenCalled();
  });

  it.each([
    ['revision mismatch', { profileRef: { ...kimiRef, revision: 2 } }], ['hash mismatch', { profileRef: { ...kimiRef, hash: hash('f') } }],
    ['profile id mismatch', { profileRef: { ...kimiRef, id: 'other-profile' } }], ['old version', { routeVersion: 'development-v1' }],
    ['changed inventory', { inventoryDigest: 'old-inventory' }], ['changed connection', { connectionFingerprint: 'old-connection' }],
    ['unsupported levels', { supportedLevels: ['medium'] }],
  ])('REQ-ENTERPRISE-038: saved receipt with %s cannot enable access', async (_label, patch) => {
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), verification: proof(route) }));
    const saved = withDevelopment({ ...savedDevelopmentAssignment(), verification: { ...proof(), ...patch } as ReasoningRouteVerification });
    const view = mount(saved); await ready(view);
    await view.findByText('@cf/development-model');
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    await expectDevelopmentInactive(view);
  });

  it.each([
    ['exact single-leg evidence', {}],
    ['changed provider', { provider: 'openai' }], ['changed model', { declaredModel: 'old-model' }],
    ['missing replay', { evidence: { ...legacyEvidence(), toolReplay: false } }],
    ['stale evidence', { evidence: { ...legacyEvidence(), current: false } }],
    ['wrong ingress', { evidence: { ...legacyEvidence(), ingress: 'direct-provider' } }],
  ])('REQ-ENTERPRISE-038: saved legacy %s remains advisory even with matching fresh models', async (_label, patch) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    const assignment = legacyDevelopmentAssignment();
    const saved = withDevelopment({ ...assignment, legs: [{ ...assignment.legs![0], ...patch }] });
    const view = mount(saved); await ready(view);
    await view.findByText('@cf/development-model');
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    await expectDevelopmentInactive(view);
  });

  it('REQ-ENTERPRISE-038: saved per-leg evidence cannot certify a fresh multi-leg route', async () => {
    const saved = withDevelopment({ activeProfile: kimiRef, routeVersion: 'development-v2', legs: routeInventory('development').legs.map((leg) => ({ ...leg, ...(leg.provider.startsWith('custom') && { customProviderBackend: 'Declared enterprise backend' }), profileRef: kimiRef, evidence: legacyEvidence() })) });
    const view = mount(saved); await ready(view);
    await view.findByText('development-alias');
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(view.queryByText(/Other backends remain untested/)).toBeNull();
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    await expectDevelopmentInactive(view);
  });

  it.each(['unavailable', 'unapproved', 'missing digest'])('REQ-ENTERPRISE-038: %s fresh inventory never reuses a saved receipt as authorization', async (state) => {
    api.inventory.mockImplementation(async (route: string) => {
      if (route !== 'development') return singleInventory(route);
      if (state === 'unavailable') throw new Error('PRIVATE INVENTORY BODY');
      return { ...singleInventory(route), ...(state === 'missing digest' && { inventoryDigest: undefined, verification: proof() }) };
    });
    const saved = withDevelopment(savedDevelopmentAssignment());
    const view = mount(saved); await ready(view);
    const card = view.getByRole('article', { name: 'development route' });
    if (state === 'unavailable') expect(await within(card).findByRole('alert')).toHaveTextContent('Models could not be read.');
    else await view.findByText('@cf/development-model');
    expect(view.container).not.toHaveTextContent('PRIVATE');
    expect(within(card).queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    await expectDevelopmentInactive(view);
  });

  it('REQ-ENTERPRISE-040: a failed recheck invalidates the draft receipt and leaves loaded snapshot evidence detached', async () => {
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), verification: proof(route) }));
    let reject!: (error: Error) => void;
    api.discover.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const saved = withDevelopment({ ...legacyDevelopmentAssignment(), verification: proof() });
    const snapshot = structuredClone(saved);
    const view = mount(saved); await ready(view);
    await view.findByText('Verified', { exact: true });
    await verifyProfile(view);
    await waitFor(() => expect(api.discover).toHaveBeenCalled());
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).routeChecks.development).toBeNull();
    expect(draftConfiguration(view.container).routeAssignments.development.verification).toBeUndefined();
    expect(draftConfiguration(view.container).routeAssignments.development.legs![0].evidence).toMatchObject({ current: false, status: 'stale' });
    expect(saved).toEqual(snapshot);
    reject(new Error('PRIVATE'));
    expect(await view.findByRole('alert')).toHaveTextContent('Verification failed.');
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(saved).toEqual(snapshot);
    await expectDevelopmentInactive(view);
  });

  it('REQ-ENTERPRISE-038: editing custom provenance verifies transient backend descriptions without a Save-first deadlock', async () => {
    api.inventory.mockImplementation(async (route: string, context?: ReasoningManagementContext) => ({
      ...singleInventory(route), inventoryDigest: context?.backendDescriptions ? `${route}-edited-digest` : `${route}-digest`,
      legs: [{ ...singleInventory(route).legs[0], provider: 'custom-enterprise', customProviderBackend: context?.backendDescriptions?.[`${route}-only`] ?? 'Old backend' }],
    }));
    api.discover.mockResolvedValueOnce({ ...verifiedReport(), verification: { ...proof(), inventoryDigest: 'development-edited-digest' } });
    const view = mount(); await ready(view);
    const card = view.getByRole('article', { name: 'development route' });
    await fireEvent.click(within(card).getByText('Advanced profile and gateway details'));
    const input = await view.findByLabelText('development-only custom provider backend');
    await fireEvent.input(input, { target: { value: 'New backend' } });
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
    expect(formValues(view.container).routeChecks.development).toBeNull();
    expect(draftConfiguration(view.container).routeAssignments.development.legs![0].customProviderBackend).toBe('New backend');
    await verifyProfile(view);
    expect(await view.findByText('Verified', { exact: true })).toBeVisible();
    expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: kimiRef, backendDescriptions: { 'development-only': 'New backend' }, maxCompletionTokens: 4096 });
    expect(api.inventory).toHaveBeenLastCalledWith('development', { backendDescriptions: { 'development-only': 'New backend' } });
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.development.legs[0].customProviderBackend).toBe('New backend');
    expect(formValues(view.container).routeChecks.development).toBe('development-check');
    expect(current.reasoningConfiguration.routeAssignments.development).toEqual({ activeProfile: kimiRef });
    expect(view.submit).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-040: editing two custom backends preserves both draft descriptions in Save and verification', async () => {
    api.inventory.mockImplementation(async (route: string, context?: ReasoningManagementContext) => ({ ...routeInventory(route),
      inventoryDigest: context?.backendDescriptions ? `${route}-edited-digest` : `${route}-digest`,
      legs: [
        { nodeId: 'first', provider: 'custom-enterprise', declaredModel: 'first-model', customProviderBackend: context?.backendDescriptions?.first ?? 'Old first' },
        { nodeId: 'second', provider: 'custom-enterprise', declaredModel: 'second-model', customProviderBackend: context?.backendDescriptions?.second ?? 'Old second' },
      ],
    }));
    api.discover.mockResolvedValueOnce({ ...verifiedReport('development', kimiRef, 'observed-path'), verification: { ...proof('development', kimiRef, 'observed-path'), inventoryDigest: 'development-edited-digest' } });
    const view = mount(); await ready(view);
    const card = view.getByRole('article', { name: 'development route' });
    await fireEvent.click(within(card).getByText('Advanced profile and gateway details'));
    const first = await within(card).findByLabelText('first custom provider backend');
    const second = within(card).getByLabelText('second custom provider backend');
    await fireEvent.input(first, { target: { value: 'New first' } });
    await fireEvent.input(second, { target: { value: 'New second' } });
    expect(first).toHaveValue('New first'); expect(second).toHaveValue('New second');
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.development.legs).toEqual([
      { nodeId: 'first', provider: 'custom-enterprise', declaredModel: 'first-model', profileRef: kimiRef, customProviderBackend: 'New first' },
      { nodeId: 'second', provider: 'custom-enterprise', declaredModel: 'second-model', profileRef: kimiRef, customProviderBackend: 'New second' },
    ]);
    await verifyProfile(view);
    expect(await view.findByText(/Other backends remain untested/)).toBeVisible();
    expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: kimiRef, backendDescriptions: { first: 'New first', second: 'New second' }, maxCompletionTokens: 4096 });
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.development.legs.map((leg: any) => leg.customProviderBackend)).toEqual(['New first', 'New second']);
  });

  it('REQ-ENTERPRISE-036: an unsaved custom revision verifies its exact profileDraft before Save', async () => {
    const custom = normalizeCustomProfile({ schemaVersion: 1, id: 'custom-new', revision: 1, name: 'New custom', enabled: true, supportedLevels: ['medium'], levels: { medium: [{ path: 'reasoning_effort', value: 'medium' }] }, removePaths: ['reasoning_effort'] });
    const ref = { id: custom.id, revision: custom.revision, hash: custom.hash };
    const saved = { ...withDevelopment({ activeProfile: ref }), reasoningConfiguration: { ...withDevelopment({ activeProfile: ref }).reasoningConfiguration, customProfileRevisions: [custom] } };
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce({ ...verifiedReport('development', ref), verification: { ...proof('development', ref), supportedLevels: ['medium'] } });
    const snapshot = structuredClone(saved);
    const view = mount(saved); await ready(view);
    expect(view.getByLabelText('development Pi compatibility profile')).toHaveValue(profileKey(ref));
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    await verifyProfile(view);
    expect(await view.findByText('Verified', { exact: true })).toBeVisible();
    expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: ref, profileDraft: custom, maxCompletionTokens: 4096 });
    expect(draftConfiguration(view.container).customProfileRevisions).toEqual([custom]);
    expect(draftConfiguration(view.container).routeAssignments.development.verification?.profileRef).toEqual(ref);
    expect(formValues(view.container).dynamicRoutes).toEqual(['development']);
    expect(saved).toEqual(snapshot);
    expect(view.submit).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-039: supported levels and associated helpers explain checked group and fallback defaults', async () => {
    const view = mount({ ...checkedCurrent(), fallbackRouting: { enabled: true, routes: current.dynamicRoutes, defaultRoute: 'general_usage', reasoning: 'off' } });
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    await openGroup(view, 'developers');
    const fallback = view.getByLabelText('Fallback default reasoning') as HTMLSelectElement;
    const group = view.getByLabelText('developers default reasoning') as HTMLSelectElement;
    expect(Array.from(fallback.options, (option) => option.value)).toEqual(['off', 'medium', 'high']);
    expect(Array.from(group.options, (option) => option.value)).toEqual(['medium', 'high']);
    expect(describedText(fallback)).toMatch(/Pi compatibility profile/);
    expect(describedText(group)).toMatch(/Off is not supported/);
    await fireEvent.change(fallback, { target: { value: 'high' } });
    expect(formValues(view.container).fallbackRouting.reasoning).toBe('high');
    await openRoute(view, 'general_usage');
    await fireEvent.change(view.getByLabelText('general_usage Pi compatibility profile'), { target: { value: profileKey(offRef) } });
    api.discover.mockResolvedValueOnce(verifiedReport('general_usage', offRef));
    await verifyProfile(view, 'general_usage');
    await waitFor(() => expect(formValues(view.container).routeChecks.general_usage).toBe('general_usage-check'));
    await openGroup(view, 'developers');
    expect(view.getByLabelText('Fallback default reasoning')).toHaveValue('off');
    expect(view.getByLabelText('Fallback default reasoning')).toBeDisabled();
    expect(describedText(view.getByLabelText('Fallback default reasoning'))).toMatch(/only Off/);
    expect(new FormData(view.container.querySelector('form')!).get('reasoning')).toBe('off');
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'general_usage', reasoning: 'off' });
    await fireEvent.change(view.getByLabelText('developers default route'), { target: { value: 'general_usage' } });
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('off');
    expect(view.getByLabelText('developers default reasoning')).toBeDisabled();
    expect(formValues(view.container).groupRouting[0].reasoning).toBe('off');
    await fireEvent.change(view.getByLabelText('Fallback default route'), { target: { value: 'development' } });
    expect(view.getByLabelText('Fallback default reasoning')).toHaveValue('medium');
    expect(view.getByLabelText('Fallback default reasoning')).toBeEnabled();
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'development', reasoning: 'medium' });
  });

  it('REQ-ENTERPRISE-039: a single non-off mode stays disabled yet serializes its selected policy value', async () => {
    const onlyHigh = { id: 'custom-high-only', revision: 1, hash: hash('f'), name: 'High only', supportedLevels: ['high'], classification: 'Verified' };
    api.catalog.mockResolvedValueOnce({ ...catalog, profiles: [...catalog.profiles, onlyHigh] });
    const view = mount({ ...checkedCurrent(), fallbackRouting: { enabled: true, routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'off' } });
    await ready(view, 'general_usage');
    const ref = { id: onlyHigh.id, revision: onlyHigh.revision, hash: onlyHigh.hash };
    await fireEvent.change(view.getByLabelText('general_usage Pi compatibility profile'), { target: { value: profileKey(ref) } });
    api.discover.mockResolvedValueOnce({ ...verifiedReport('general_usage', ref), verification: { ...proof('general_usage', ref), supportedLevels: ['high'] } });
    await verifyProfile(view, 'general_usage');
    await waitFor(() => expect(formValues(view.container).routeChecks.general_usage).toBe('general_usage-check'));
    await openGroup(view, 'support');
    const reasoning = view.getByLabelText('Fallback default reasoning');
    expect(reasoning).toHaveValue('high'); expect(reasoning).toBeDisabled();
    expect(describedText(reasoning)).toMatch(/only High/);
    expect(new FormData(view.container.querySelector('form')!).getAll('reasoning')).toEqual(['high']);
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'general_usage', reasoning: 'high' });
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: true, routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'high' });
    expect(formValues(view.container).groupRouting[1].reasoning).toBe('high');
    expect(view.getByLabelText('support default reasoning')).toHaveValue('high');
    expect(view.getByLabelText('support default reasoning')).toBeDisabled();
  });

  it('REQ-ENTERPRISE-039: default reasoning help distinguishes pending connection from missing checked route assignment', async () => {
    let hydrate!: (value: ReasoningCatalog) => void;
    api.catalog.mockReturnValueOnce(new Promise<ReasoningCatalog>((resolve) => { hydrate = resolve; }));
    const view = mount({ ...current, fallbackRouting: { enabled: true, routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'off' } });
    await section(view, 'Access & fallback');
    expect(view.getByText('Checking connection…')).toBeVisible();
    expect(view.getByLabelText('Fallback default reasoning')).toBeDisabled();
    hydrate(catalog); await ready(view, 'general_usage');
    await fireEvent.change(view.getByLabelText('general_usage Pi compatibility profile'), { target: { value: '' } });
    await section(view, 'Access & fallback');
    const reasoning = view.getByLabelText('Fallback default reasoning');
    expect(reasoning).toBeDisabled();
    expect(describedText(reasoning)).toMatch(/Choose an available route first/);
    expect(view.queryByText('Checking connection…')).toBeNull();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
  });

  it('REQ-ENTERPRISE-034: keeps unconfigured and invalidated drafts out of active routing and new group defaults', async () => {
    const saved = checkedCurrent(); const view = mount(saved); await ready(view, 'research');
    expect(view.getByRole('button', { name: 'Map Profile for research' })).toBeEnabled();
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(formValues(view.container).routeContextWindows).toEqual(current.routeContextWindows);
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    await openGroup(view, 'developers');
    expect(view.queryByLabelText('developers research route')).toBeNull();
    await fireEvent.change(view.getByLabelText('Unconfigured access group'), { target: { value: 'research-team' } });
    await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    expect(view.getByLabelText('research-team default route')).toHaveValue('');
    expect(formValues(view.container).groupRouting).toEqual([...current.groupRouting, { accessGroup: 'research-team', routes: [], defaultRoute: '', reasoning: 'off' }]);
    await openRoute(view, 'development');
    await fireEvent.change(view.getByLabelText('development Pi compatibility profile'), { target: { value: profileKey(glmRef) } });
    expect(formValues(view.container).dynamicRoutes).toEqual(['general_usage']);
    expect(formValues(view.container).groupRouting[0]).toEqual({ accessGroup: 'developers', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'medium' });
    expect(draftConfiguration(view.container).routeAssignments.development.activeProfile).toEqual(glmRef);
    expect(formValues(view.container).routeContextWindows).toEqual(current.routeContextWindows);
    expect(formValues(view.container).groupRouting[2]).toEqual({ accessGroup: 'research-team', routes: [], defaultRoute: '', reasoning: 'off' });
    await openRoute(view, 'research');
    expect(view.getByRole('button', { name: 'Map Profile for research' })).toBeEnabled();
  });

  it('REQ-ENTERPRISE-034: retains emptied groups as deny policies until explicit removal', async () => {
    const saved = checkedCurrent();
    const view = mount({ ...saved, groupRouting: [
      { accessGroup: 'developers', routes: ['development'], defaultRoute: 'development', reasoning: 'medium' },
      current.groupRouting[1],
    ] });
    await ready(view);
    await view.findByText('@cf/development-model');
    await fireEvent.change(view.getByLabelText('development Pi compatibility profile'), { target: { value: profileKey(glmRef) } });
    expect(formValues(view.container).groupRouting).toEqual([
      { accessGroup: 'developers', routes: [], defaultRoute: '', reasoning: 'off' }, current.groupRouting[1],
    ]);
    expect(formValues(view.container).dynamicRoutes).toEqual(['general_usage']);
    expect(formValues(view.container).routeContextWindows).toEqual(current.routeContextWindows);
    expect(view.onReadyChange).toHaveBeenLastCalledWith(true);
    await openGroup(view, 'developers');
    expect(view.getByLabelText('developers default route')).toHaveValue('');
    await fireEvent.click(view.getByRole('button', { name: 'Remove developers policy' }));
    expect(formValues(view.container).groupRouting).toEqual([current.groupRouting[1]]);
    await openGroup(view, 'support');
    await fireEvent.click(view.getByRole('checkbox', { name: 'support general_usage route' }));
    expect(formValues(view.container).groupRouting).toEqual([{ accessGroup: 'support', routes: [], defaultRoute: '', reasoning: 'off' }]);
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).routeContextWindows).toEqual(current.routeContextWindows);
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
  });

  it('REQ-ENTERPRISE-034: uses the first checked route as a new group default instead of an unrelated gateway row', async () => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    const view = mount({ ...current, dynamicRoutes: [], defaultRoute: null, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, groupRouting: [] });
    await ready(view, 'research');
    await fireEvent.change(view.getByLabelText('research Pi compatibility profile'), { target: { value: profileKey(glmRef) } });
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: false });
    api.discover.mockResolvedValueOnce(verifiedReport('research'));
    await verifyProfile(view, 'research');
    await view.findByText('Verified', { exact: true });
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    await section(view, 'Access & fallback');
    await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    expect(formValues(view.container).dynamicRoutes).toEqual(['research']);
    expect(formValues(view.container).groupRouting).toEqual([{ accessGroup: 'developers', routes: ['research'], defaultRoute: 'research', reasoning: 'medium' }]);
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'research', reasoning: 'medium' });
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: false });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(true);
  });

  it('REQ-ENTERPRISE-034: removing the last stale draft does not activate unconfigured gateway replacements', async () => {
    const view = mount({ ...current, dynamicRoutes: ['retired'], defaultRoute: { route: 'retired', reasoning: 'off' }, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { retired: { activeProfile: glmRef } } }, groupRouting: [] });
    await ready(view, 'retired');
    await fireEvent.click(view.getByRole('button', { name: 'Remove retired stale route' }));
    expect(view.getByRole('alert')).toHaveTextContent('It will also be removed from draft access policies.');
    expect(draftConfiguration(view.container).routeAssignments.retired.activeProfile).toEqual(glmRef);
    await fireEvent.click(view.getByRole('button', { name: 'Confirm remove retired' }));
    expect(view.queryByRole('button', { name: 'Configure retired' })).toBeNull();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(draftConfiguration(view.container).routeAssignments).toEqual({});
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: false });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
  });

  it('REQ-ENTERPRISE-034: adds a discovered route only after verification and policy assignment and preserves apply-to-all', async () => {
    const view = mount(checkedCurrent()); await ready(view, 'research');
    expect(view.queryByLabelText('New route handle')).toBeNull();
    await fireEvent.input(view.getByLabelText('research context window'), { target: { value: '65536' } });
    await fireEvent.change(view.getByLabelText('research Pi compatibility profile'), { target: { value: profileKey(glmRef) } });
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(formValues(view.container).routeContextWindows.research).toBe(65536);
    await openGroup(view, 'developers');
    expect(view.queryByLabelText('developers research route')).toBeNull();
    api.discover.mockResolvedValueOnce(verifiedReport('research'));
    await verifyProfile(view, 'research');
    await waitFor(() => expect(formValues(view.container).routeChecks.research).toBe('research-check'));
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    await openGroup(view, 'developers');
    await fireEvent.click(view.getByRole('checkbox', { name: 'developers research route' }));
    await fireEvent.change(view.getByLabelText('developers default route'), { target: { value: 'research' } });
    await fireEvent.change(view.getByLabelText('developers default reasoning'), { target: { value: 'high' } });
    await fireEvent.click(view.getByRole('button', { name: 'Apply to all groups' }));
    expect(view.getByRole('alert')).toHaveTextContent('developers will be copied to developers, support.');
    expect(formValues(view.container).groupRouting[1]).toEqual(current.groupRouting[1]);
    await fireEvent.click(view.getByRole('button', { name: 'Confirm group changes' }));
    expect(formValues(view.container)).toMatchObject({
      dynamicRoutes: ['general_usage', 'development', 'research'], routeContextWindows: { ...current.routeContextWindows, research: 65536 },
      groupRouting: [
        { accessGroup: 'developers', routes: ['general_usage', 'development', 'research'], defaultRoute: 'research', reasoning: 'high' },
        { accessGroup: 'support', routes: ['general_usage', 'development', 'research'], defaultRoute: 'research', reasoning: 'high' },
      ],
    });
    expect(draftConfiguration(view.container).routeAssignments.research.activeProfile).toEqual(glmRef);
  });

  it('REQ-ENTERPRISE-034: confirms stale route removal and clears policy references without replacing working routes', async () => {
    const saved = checkedCurrent();
    const staleCurrent = { ...saved, dynamicRoutes: [...current.dynamicRoutes, 'retired'], routeContextWindows: { ...current.routeContextWindows, retired: 65536 },
      fallbackRouting: { enabled: true, routes: ['retired', 'general_usage'], defaultRoute: 'retired', reasoning: 'off' },
      reasoningConfiguration: { ...saved.reasoningConfiguration, routeAssignments: { ...saved.reasoningConfiguration.routeAssignments, retired: { activeProfile: glmRef } } },
    };
    const view = mount(staleCurrent); await ready(view, 'retired');
    await fireEvent.click(view.getByRole('button', { name: 'Remove retired stale route' }));
    expect(view.getByRole('alert')).toHaveTextContent('It will also be removed from draft access policies.');
    expect(view.getByLabelText('retired context window')).toHaveValue('65536');
    await fireEvent.click(view.getByRole('button', { name: 'Keep route' }));
    expect(draftConfiguration(view.container).routeAssignments.retired.activeProfile).toEqual(glmRef);
    await fireEvent.click(view.getByRole('button', { name: 'Remove retired stale route' }));
    await fireEvent.click(view.getByRole('button', { name: 'Confirm remove retired' }));
    expect(view.queryByLabelText('retired context window')).toBeNull();
    expect(draftConfiguration(view.container).routeAssignments).not.toHaveProperty('retired');
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(formValues(view.container).groupRouting).toEqual(current.groupRouting);
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: true, routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'medium' });
  });
});
