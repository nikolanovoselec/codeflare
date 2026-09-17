import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import { ApiError } from '../../api/fetch-helper';
import { getBuiltInProfile, normalizeCustomProfile } from '../../../../src/lib/reasoning-profiles';
import type {
  PiReasoningLevel, ProfileRevisionRef, ReasoningCatalog, ReasoningConfiguration,
  ReasoningDiscoveryResult, ReasoningRouteAssignment,
  ReasoningRouteInventory, ReasoningRouteVerification,
} from '../../types';

const api = vi.hoisted(() => ({ catalog: vi.fn(), inventory: vi.fn(), discover: vi.fn(), nativeDiscover: vi.fn(), native: vi.fn() }));
vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args),
  getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.discover(...args),
  discoverNativeCompatibility: (...args: unknown[]) => api.nativeDiscover(...args),
  checkNativeTarget: (...args: unknown[]) => api.native(...args),
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
    { id: 'dynamic-bedrock-anthropic-provider-default', revision: 1, hash: hash('4'), name: 'AWS Bedrock Claude provider default', supportedLevels: [], classification: 'Verified' },
    { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c'), name: 'AWS Bedrock · Anthropic Claude', supportedLevels: [], classification: 'Verified' },
    { id: 'bedrock-anthropic-native-provider-default', revision: 1, hash: hash('0'), name: 'Anthropic Messages Provider default', supportedLevels: [], classification: 'Compatible, unverified' },
    { id: 'bedrock-anthropic-native-sonnet', revision: 1, hash: hash('7'), name: 'AWS Bedrock Claude Sonnet · native', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'bedrock-anthropic-native-opus-stream', revision: 1, hash: hash('8'), name: 'AWS Bedrock Claude Opus · native stream', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high'], classification: 'Verified' },
    { id: 'bedrock-anthropic-native-opus-invoke', revision: 1, hash: hash('9'), name: 'AWS Bedrock Claude Opus · native Invoke', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'bedrock-anthropic-native-opus-auto', revision: 1, hash: hash('5'), name: 'AWS Bedrock Claude Opus · native automatic', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'native-openai-compat', revision: 1, hash: hash('d'), name: 'OpenAI GPT-5.6 · native tools-off', supportedLevels: ['off'], classification: 'Verified' },
    { id: 'native-google-ai-studio-compat', revision: 1, hash: hash('e'), name: 'Google AI Studio · Gemini native', supportedLevels: [], classification: 'Verified' },
    { id: 'native-codeflare-inference-mesh-compat', revision: 1, hash: hash('f'), name: 'Codeflare Inference Mesh · native compat', supportedLevels: [], classification: 'Verified' },
  ],
  notices: [{ id: 'gpt-oss-tool-replay', name: 'GPT-OSS tool replay', assignable: false, summary: 'Tool-result replay is unsupported.' }],
  usage: [], routes: ['general_usage', 'development', 'research'], routeCatalogStatus: 'ready',
  providers: [{ provider: 'aws-bedrock', label: 'Amazon Bedrock', configured: true, defaultSelection: true, supported: true }], providerCatalogStatus: 'ready',
};
const glmRef = { id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a') };
const kimiRef = { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: hash('b') };
const offRef = { id: 'openai-gpt-chat-tools-off', revision: 1, hash: hash('2') };
const bedrockDynamicRef = { id: 'dynamic-bedrock-anthropic-provider-default', revision: 1, hash: hash('4') };
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
const savedNativeCustom = normalizeCustomProfile({ schemaVersion: 1, id: 'custom-saved-native', revision: 3, name: 'Saved native', enabled: true, supportedLevels: ['off'], levels: { off: [{ path: 'reasoning_effort', value: 'none' }] }, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' }, removePaths: ['reasoning_effort'] });
const savedNativeCustomRef = { id: savedNativeCustom.id, revision: savedNativeCustom.revision, hash: savedNativeCustom.hash };
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
const mount = (data: unknown = current, baseRevision?: number) => {
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
  const onReadyChange = vi.fn();
  return { ...render(() => <form onSubmit={submit}><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={data} baseRevision={baseRevision} onReadyChange={onReadyChange} /></form>), submit, onReadyChange };
};
type View = ReturnType<typeof mount>;
async function section(view: View, name: 'Connection' | 'Dynamic routes' | 'Native routes' | 'Access & fallback') {
  await fireEvent.click(within(view.getByRole('navigation', { name: 'AI Gateway configuration sections' })).getByRole('button', { name }));
}
async function openNative(view: View) {
  await view.findByText('Connected · 3 routes readable');
  await section(view, 'Native routes');
}
async function addNativeTarget(view: View) {
  await openNative(view);
  await fireEvent.click(view.getByRole('button', { name: 'Add Native Route' }));
  for (const summary of view.container.querySelectorAll('details > summary')) {
    if (summary.textContent?.startsWith('Advanced') && !(summary.parentElement as HTMLDetailsElement).open) await fireEvent.click(summary);
  }
}
async function openRoute(view: View, route: string) {
  await section(view, 'Dynamic routes');
  const toggle = view.getByRole('button', { name: `Configure ${route}` });
  if (toggle.getAttribute('aria-expanded') !== 'true') await fireEvent.click(toggle);
  // These existing tests exercise the preserved manual/advanced workflow.
  // Single-click automatic discovery has its own regression without opening it.
  for (const summary of view.getByRole('article', { name: `${route} route` }).querySelectorAll('details > summary')) {
    if (summary.textContent?.startsWith('Advanced') && !(summary.parentElement as HTMLDetailsElement).open) await fireEvent.click(summary);
  }
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
  expect(within(view.getByRole('group', { name: 'developers allowed routes' })).queryByRole('checkbox', { name: 'developers Dynamic Route - development route' })).toBeNull();
}

// Register two independently schedulable halves without duplicating the shared
// component fixtures or changing the behavioral assertions.
export function registerAiRoutingFieldsTests(partition: 'first' | 'second') {
beforeEach(() => {
  api.catalog.mockReset().mockResolvedValue(catalog);
  api.inventory.mockReset().mockImplementation(async (route: string) => routeInventory(route));
  api.discover.mockReset().mockResolvedValue({ classification: 'Compatible, unverified', warnings: ['custom_provider_backend_requires_revalidation'], accounting: { logicalProbes: 2, httpAttempts: 3 } });
  api.nativeDiscover.mockReset().mockResolvedValue({ classification: 'Compatible, unverified', warnings: [], accounting: { logicalProbes: 2, httpAttempts: 2 } });
  api.native.mockReset().mockResolvedValue({ targetId: '11111111-1111-4111-8111-111111111111', classification: 'Administrator-confirmed', assignable: true, checkId: '22222222-2222-4222-8222-222222222222', verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// Synthetic component fixtures; CI reruns the locally verified behavior.
describe('Structured AI routing', () => {
  if (partition === 'first') {
  it('REQ-ENTERPRISE-034: shows only live Gateway routes and drops deleted route settings after a successful inventory', async () => {
    const deleted = ['bedrock_opus', 'code_review', 'codeflare_mesh', 'codeflare-mesh-research', 'development', 'documentation', 'freestyler', 'general_usage'];
    const live = ['Planning', 'Operations', 'Development', 'Review'];
    api.catalog.mockResolvedValueOnce({ ...catalog, routes: live, reconciliation: {
      status: 'applied', removedDynamicRoutes: deleted, removedNativeTargetIds: [], revision: 8,
    } });
    const saved = { ...current, dynamicRoutes: deleted,
      routeContextWindows: Object.fromEntries(deleted.map((route) => [route, 200000])),
      reasoningConfiguration: { ...current.reasoningConfiguration,
        routeAssignments: Object.fromEntries(deleted.map((route) => [route, { activeProfile: glmRef }])) } };
    const view = mount(saved, 7);
    await view.findByText('Connected · 4 routes readable');
    expect(api.catalog).toHaveBeenCalledWith(undefined, { reconcileSaved: true, baseRevision: 7 });
    await waitFor(() => expect(api.inventory).toHaveBeenCalledTimes(4));
    expect(view.getAllByRole('article').map((row) => row.getAttribute('aria-label'))).toEqual(live.map((route) => `${route} route`));
    expect(view.getByText('0 ready / 4 routes')).toBeVisible();
    for (const route of deleted) {
      expect(view.queryByRole('button', { name: `Configure ${route}` })).toBeNull();
      expect(draftConfiguration(view.container).routeAssignments).not.toHaveProperty(route);
    }
    expect(api.inventory.mock.calls.map(([route]) => route)).toEqual(live);
    expect(formValues(view.container).routeContextWindows).toEqual({});
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).groupRouting.every((group: { routes: string[] }) => group.routes.length === 0)).toBe(true);
    expect(api.discover).not.toHaveBeenCalled();
    expect(api.native).not.toHaveBeenCalled();
    expect(view.submit).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-034: an authoritative empty route inventory removes all saved Dynamic routes without discovery or Save', async () => {
    api.catalog.mockResolvedValueOnce({ ...catalog, routes: [], reconciliation: {
      status: 'applied', removedDynamicRoutes: Object.keys(current.reasoningConfiguration.routeAssignments), removedNativeTargetIds: [], revision: 8,
    } });
    const view = mount(current, 7);
    await view.findByText('Connected · 0 routes readable');
    expect(view.queryByRole('article')).toBeNull();
    expect(view.getByText('0 ready / 0 routes')).toBeVisible();
    expect(view.getByText(/No routes available/)).toBeVisible();
    expect(draftConfiguration(view.container).routeAssignments).toEqual({});
    expect(api.inventory).not.toHaveBeenCalled();
    expect(api.discover).not.toHaveBeenCalled();
    expect(view.submit).not.toHaveBeenCalled();
  });

  it.each(['ready', 'unavailable'] as const)('REQ-ENTERPRISE-052: missing Native providers remove their routes only after authoritative inventory (%s)', async (providerCatalogStatus) => {
    const targetId = '11111111-1111-4111-8111-111111111111';
    const handle = `cf-native-${targetId}`;
    const native = { id: targetId, label: 'Deleted provider route', model: 'eu.anthropic.claude-synthetic-2099', provider: 'aws-bedrock',
      transport: 'aig-legacy-compat', contextWindow: 200000, profileRef: savedNativeCustomRef, enabled: true,
      verification: { method: 'administrator', checkedAt: '2026-09-13T12:00:00Z', current: true } };
    api.catalog.mockResolvedValueOnce({ ...catalog, providers: [], providerCatalogStatus,
      ...(providerCatalogStatus === 'ready' && { reconciliation: {
        status: 'applied', removedDynamicRoutes: [], removedNativeTargetIds: [targetId], revision: 8,
      } }),
    });
    const view = mount({ ...current, nativeTargets: [native],
      reasoningConfiguration: { ...current.reasoningConfiguration, customProfileRevisions: [savedNativeCustom] },
      groupRouting: [{ accessGroup: 'developers', routes: [handle], defaultRoute: handle, reasoning: 'off' }],
      fallbackRouting: { enabled: true, routes: [handle], defaultRoute: handle, reasoning: 'off' } }, 7);
    await openNative(view);
    expect(view.queryByRole('article', { name: 'Deleted provider route native target' })).toBeNull();
    const values = formValues(view.container);
    if (providerCatalogStatus === 'ready') {
      expect(values.nativeTargets).toEqual([]);
      expect(JSON.stringify(values.groupRouting)).not.toContain(handle);
      expect(JSON.stringify(values.fallbackRouting)).not.toContain(handle);
    } else {
      expect(values.nativeTargets).toHaveLength(1); // A failed read is not proof of deletion.
      expect(values.nativeTargets[0].id).toBe(targetId);
      expect(view.getByText(/Provider discovery is unavailable/)).toBeVisible();
    }
    expect(draftConfiguration(view.container).customProfileRevisions).toEqual([savedNativeCustom]);
    expect(api.native).not.toHaveBeenCalled();
    expect(api.nativeDiscover).not.toHaveBeenCalled();
    expect(view.submit).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-075: an incomplete native check does not turn absent cache evidence into an unsupported claim', async () => {
    api.native.mockResolvedValueOnce({ assignable: false, classification: 'Inconclusive',
      cacheEvidence: { explanation: 'Exact replay was not established. No cache reuse observed; this does not establish unsupported caching.' } });
    const view = mount();
    await addNativeTarget(view);
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Synthetic cache check' } });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-synthetic-future-2099-v1:0' } });
    const article = view.getByRole('article', { name: 'Synthetic cache check native target' });
    await fireEvent.click(within(article).getByRole('button', { name: 'Verify Profile' }));
    expect(await within(article).findByRole('alert')).toHaveTextContent('does not establish unsupported caching');
    expect(formValues(view.container).nativeTargets[0].enabled).toBe(false);
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('verification');
    expect(api.native).toHaveBeenCalledTimes(1);
  });
  it('REQ-ENTERPRISE-041: navigates Dynamic routes and Native routes and adds a Native Route', async () => {
    const view = mount();
    await view.findByText('Connected · 3 routes readable');
    const navigation = within(view.getByRole('navigation', { name: 'AI Gateway configuration sections' }));
    await fireEvent.click(navigation.getByRole('button', { name: 'Dynamic routes' }));
    expect(view.getByRole('heading', { name: 'Dynamic routes' })).toBeVisible();
    await fireEvent.click(navigation.getByRole('button', { name: 'Native routes' }));
    expect(view.getByRole('heading', { name: 'Native routes' })).toBeVisible();
    await fireEvent.click(view.getByRole('button', { name: 'Add Native Route' }));
    expect(formValues(view.container).nativeTargets).toHaveLength(1);
    expect(view.submit).not.toHaveBeenCalled();
  });
  it('REQ-ENTERPRISE-075: selects older/current/synthetic future models with one reusable native profile and explicit verification', async () => {
    const view = mount();
    await addNativeTarget(view);
    const article = view.getByRole('article', { name: 'New native target' });
    expect(within(article).queryByLabelText('Native target 1 transport')).toBeNull();
    expect(formValues(view.container).nativeTargets[0].transport).toBe('aig-bedrock-anthropic-auto');
    await fireEvent.input(within(article).getByLabelText('Native target 1 label'), { target: { value: 'Native Claude' } });
    for (const model of ['eu.anthropic.claude-opus-5', 'eu.anthropic.claude-sonnet-4-6', 'eu.anthropic.claude-synthetic-future-2099-v1:0']) {
      const id = 'bedrock-anthropic-native-provider-default'; const digest = '0';
      await fireEvent.input(within(article).getByLabelText('Native target 1 model'), { target: { value: model } });
      expect(within(article).getByLabelText('Native target 1 region')).toHaveValue('eu-central-1');
      const profile = within(article).getByLabelText('Native target 1 profile') as HTMLSelectElement;
      expect(profile).toHaveValue(profileKey({ id, revision: 1, hash: hash(digest) }));
      expect(Array.from(profile.options, (option) => option.text)).toEqual(['Native Route - AWS Bedrock - Anthropic Messages (Provider default)']);
      expect(within(article).getByText(/All seven Pi preferences normalize to Provider default/)).toBeVisible();
      expect(within(article).getByRole('button', { name: 'Mark as verified' })).toBeVisible();
      await fireEvent.click(within(article).getByRole('button', { name: 'Verify Profile' }));
      await waitFor(() => expect(formValues(view.container).nativeTargets[0].enabled).toBe(true));
      expect(api.native).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({
        model, transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1', profileRef: { id, revision: 1, hash: hash(digest) },
      }) }));
      expect(api.native.mock.calls[api.native.mock.calls.length - 1][0]).not.toHaveProperty('administratorConfirmed');
      await openGroup(view, 'developers');
      const target = formValues(view.container).nativeTargets[0];
      const handle = `cf-native-${target.id}`;
      const checkbox = view.getByRole('checkbox', { name: 'developers Native Route - AWS Bedrock - Native Claude route' });
      if (!(checkbox as HTMLInputElement).checked) await fireEvent.click(checkbox);
      await fireEvent.change(view.getByLabelText('developers default route'), { target: { value: handle } });
      const reasoning = view.getByLabelText('developers default reasoning') as HTMLSelectElement;
      expect(reasoning).toBeEnabled(); // Off is a preference, not verified provider behavior.
      expect(within(reasoning).getByRole('option', { name: 'Off (preference)' })).toHaveValue('off');
      expect(describedText(reasoning)).toMatch(/no explicit override is sent/);
      expect(formValues(view.container).groupRouting[0]).toMatchObject({ defaultRoute: handle });
      await section(view, 'Native routes');
    }
  });

  it.each([
    [undefined, 'bedrock-anthropic-compat', 'c', []],
    ['aig-legacy-compat', 'bedrock-anthropic-compat', 'c', []],
    ['aig-bedrock-anthropic-eventstream', 'bedrock-anthropic-native-opus-stream', '8', ['off', 'minimal', 'low', 'medium', 'high']],
    ['aig-bedrock-anthropic-invoke', 'bedrock-anthropic-native-opus-invoke', '9', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['aig-bedrock-anthropic-auto', 'bedrock-anthropic-native-opus-auto', '5', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['aig-bedrock-anthropic-eventstream', 'bedrock-anthropic-native-sonnet', '7', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['aig-bedrock-anthropic-invoke', 'bedrock-anthropic-native-sonnet', '7', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['aig-bedrock-anthropic-auto', 'bedrock-anthropic-native-sonnet', '7', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ] as const)('REQ-ENTERPRISE-074/078: preserves saved %s / %s identity and real levels on unrelated edits', async (transport, id, digest, levels) => {
    const targetId = '11111111-1111-4111-8111-111111111111';
    const handle = `cf-native-${targetId}`;
    const profileRef = { id, revision: 1, hash: hash(digest) };
    const model = id === 'bedrock-anthropic-native-sonnet' ? 'eu.anthropic.claude-sonnet-5' : 'eu.anthropic.claude-opus-5';
    const target = { id: targetId, handle, label: 'Saved Claude', provider: 'aws-bedrock', model,
      contextWindow: 200000, profileRef, enabled: true, ...(transport && { transport }),
      ...(transport && transport !== 'aig-legacy-compat' && { region: 'us-east-1' }),
      verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true } };
    const view = mount({ ...checkedCurrent(), nativeTargets: [target], groupRouting: [{ accessGroup: 'developers', routes: [handle], defaultRoute: handle, reasoning: 'high' }] });
    await openNative(view);
    await fireEvent.click(view.getByRole('button', { name: `Configure Native Route - AWS Bedrock - ${model}` }));
    expect(view.queryByLabelText('Native target 1 transport')).toBeNull();
    const before = formValues(view.container).nativeTargets[0];
    expect(before).toMatchObject({ id: targetId, profileRef, transport: transport ?? 'aig-legacy-compat', enabled: true });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: target.model } });
    await fireEvent.change(view.getByLabelText('Native target 1 provider'), { target: { value: target.provider } });
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Renamed Opus' } });
    await fireEvent.input(view.getByLabelText('Native target 1 context window'), { target: { value: '240000' } });
    await openGroup(view, 'developers');
    const reasoning = view.getByLabelText('developers default reasoning') as HTMLSelectElement;
    expect(Array.from(reasoning.options, (option) => option.value)).toEqual(levels.length ? [...levels] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (!levels.length) {
      expect(within(reasoning).getByRole('option', { name: 'Off (preference)' })).toBeVisible();
      expect(reasoning).toBeEnabled();
    }
    await section(view, 'Connection');
    await fireEvent.input(view.getByLabelText('Replacement API token'), { target: { value: 'replacement' } });
    expect(formValues(view.container).nativeTargets[0]).toEqual({ ...before, label: 'Renamed Opus', contextWindow: 240000 });
    expect(formValues(view.container).nativeChecks ?? {}).toEqual({});
    expect(api.native).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-074: preserves the selected region through successive model edits without submitting it for compatibility', async () => {
    const view = mount();
    await addNativeTarget(view);
    const model = view.getByLabelText('Native target 1 model');
    await fireEvent.input(model, { target: { value: 'eu.anthropic.claude-sonnet-5' } });
    await fireEvent.input(view.getByLabelText('Native target 1 region'), { target: { value: 'us-east-1' } });
    await fireEvent.input(model, { target: { value: 'eu.anthropic.' } });
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('region');
    await fireEvent.input(model, { target: { value: 'eu.anthropic.claude-sonnet-5' } });
    expect(view.getByLabelText('Native target 1 region')).toHaveValue('us-east-1');
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ region: 'us-east-1', transport: 'aig-bedrock-anthropic-auto' });
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('rememberedRegion');
  });

  it('REQ-ENTERPRISE-074/078: never changes a saved compatibility transport when its model changes', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const view = mount({ ...checkedCurrent(), nativeTargets: [{ id, label: 'Saved', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5',
      contextWindow: 200000, transport: 'aig-legacy-compat', profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: true,
      verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true } }] });
    await openNative(view);
    await fireEvent.click(view.getByRole('button', { name: 'Configure Native Route - AWS Bedrock - eu.anthropic.claude-sonnet-5' }));
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-opus-5' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id, transport: 'aig-legacy-compat',
      profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false });
    expect(formValues(view.container).nativeChecks).toEqual({ [id]: null });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-future-profile' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ transport: 'aig-legacy-compat', profileRef: { id: 'bedrock-anthropic-compat' }, enabled: false });
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('region');
  });

  it('REQ-ENTERPRISE-078: selects automatic Bedrock after a genuine provider change and keeps other providers compatible', async () => {
    api.catalog.mockResolvedValueOnce({ ...catalog, providers: [
      { provider: 'openai', label: 'OpenAI', configured: true, defaultSelection: true, supported: true },
      { provider: 'aws-bedrock', label: 'AWS Bedrock', configured: true, defaultSelection: false, supported: true },
    ] });
    const view = mount(checkedCurrent());
    await addNativeTarget(view);
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ provider: 'openai', transport: 'aig-legacy-compat' });
    await fireEvent.change(view.getByLabelText('Native target 1 provider'), { target: { value: 'aws-bedrock' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ provider: 'aws-bedrock', model: '', transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1' });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-opus-5' } });
    expect(formValues(view.container).nativeTargets[0].profileRef.id).toBe('bedrock-anthropic-native-provider-default');
    await fireEvent.change(view.getByLabelText('Native target 1 provider'), { target: { value: 'openai' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ provider: 'openai', model: '', transport: 'aig-legacy-compat', profileRef: { id: 'native-openai-compat' } });
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('region');
  });

  it('REQ-ENTERPRISE-051/056/064: renders named native target rows with expanded-only controls', async () => {
    api.catalog.mockResolvedValueOnce({
      ...catalog,
      providers: [
        { provider: 'google-ai-studio', label: 'Google AI Studio', configured: true, defaultSelection: false, supported: true },
        { provider: 'codeflare-inference-mesh', label: 'Codeflare Inference Mesh', configured: true, defaultSelection: false, supported: false },
        { provider: 'openai', label: 'OpenAI', configured: true, defaultSelection: false, supported: true },
      ],
    });
    const view = mount({ ...checkedCurrent(), nativeTargets: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Gemini', provider: 'google-ai-studio', model: 'gemini-3.1-pro-preview', contextWindow: 200000, profileRef: { id: 'native-google-ai-studio-compat', revision: 1, hash: hash('e') }, enabled: false }] });
    await openNative(view);
    expect(view.queryByText('Configured providers')).toBeNull();
    const article = view.getByRole('article', { name: 'Gemini native target' });
    const toggle = within(article).getByRole('button', { name: 'Configure Native Route - Google AI Studio - gemini-3.1-pro-preview' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(article).getByText('Not ready')).toHaveAttribute('data-state', 'unclear');
    expect(within(article).getByLabelText('Native target 1 provider')).not.toBeVisible();
    expect(within(article).queryByRole('button', { name: 'Verify Profile' })).toBeNull();
    await fireEvent.click(toggle);
    const provider = within(article).getByLabelText('Native target 1 provider') as HTMLSelectElement;
    expect(provider).toBeVisible();
    expect(Array.from(provider.options, (option) => option.value)).toEqual(['google-ai-studio', 'openai']);
    await fireEvent.change(provider, { target: { value: 'openai' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ provider: 'openai', model: '', enabled: false });
    expect(within(article).getByRole('button', { name: 'Discover Profile for native target 1' })).toBeVisible();
    expect(within(article).getByRole('button', { name: 'Verify Profile' })).toBeVisible();
    expect(within(article).getByRole('button', { name: 'Mark as verified' })).toBeVisible();
    expect(within(article).queryByLabelText('Enable Gemini native target')).toBeNull();
  });

  it('REQ-ENTERPRISE-056: derives orange and green native readiness without an enable control', async () => {
    const readyId = '11111111-1111-4111-8111-111111111111';
    const view = mount({ ...checkedCurrent(), nativeTargets: [
      { id: readyId, label: 'Ready Claude', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false, verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true } },
      { id: '33333333-3333-4333-8333-333333333333', label: 'Draft Claude', provider: 'aws-bedrock', model: 'eu.anthropic.claude-opus-5', contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: true },
    ] });
    await openNative(view);
    expect(within(view.getByRole('button', { name: 'Configure Native Route - AWS Bedrock - eu.anthropic.claude-sonnet-5' })).getByText('Administrator-confirmed')).toHaveAttribute('data-state', 'passed');
    expect(within(view.getByRole('article', { name: 'Draft Claude native target' })).getByText('Not ready')).toHaveAttribute('data-state', 'unclear');
    expect(view.queryByText('Available for routing')).toBeNull();
    expect(formValues(view.container).nativeTargets.map((target: { enabled: boolean }) => target.enabled)).toEqual([true, false]);
    await openGroup(view, 'developers');
    expect(view.getByRole('checkbox', { name: 'developers Native Route - AWS Bedrock - Ready Claude route' })).toBeVisible();
    expect(view.queryByRole('checkbox', { name: 'developers Native Route - AWS Bedrock - Draft Claude route' })).toBeNull();
  });

  it.each(['GPT 5.6 Terra', '', '   ', undefined])('REQ-ENTERPRISE-064: #110 uses the native label or model fallback in group and fallback policies (%s)', async (label) => {
    const targetId = '6af8fc3b-5352-4d52-ac55-0c342673960d';
    const handle = `cf-native-${targetId}`;
    api.catalog.mockResolvedValueOnce({ ...catalog, providers: [{ provider: 'openai', label: 'OpenAI', configured: true, defaultSelection: true, supported: true }] });
    const view = mount({ ...checkedCurrent(), groupRouting: [
      { accessGroup: 'developers', routes: [handle], defaultRoute: handle, reasoning: 'off' },
      { accessGroup: 'support', routes: [], defaultRoute: '', reasoning: 'off' },
    ], nativeTargets: [{
      id: targetId, label, provider: 'openai', model: 'gpt-5.6-terra',
      contextWindow: 200000, profileRef: { id: 'native-openai-compat', revision: 1, hash: hash('d') },
      enabled: true, verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true },
    }] });
    await openGroup(view, 'developers');
    const display = `Native Route - OpenAI - ${label?.trim() || 'gpt-5.6-terra'}`;
    const assignment = view.getByRole('checkbox', { name: `developers ${display} route` });
    expect(assignment).toBeChecked();
    expect(within(view.getByLabelText('developers default route')).getByRole('option', { name: display })).toHaveValue(handle);
    await fireEvent.click(assignment);
    expect(formValues(view.container).groupRouting[0].routes).toEqual([]);
    await fireEvent.click(view.getByRole('checkbox', { name: `developers ${display} route` }));
    await fireEvent.change(view.getByLabelText('developers default route'), { target: { value: handle } });
    expect(formValues(view.container).groupRouting[0]).toEqual({ accessGroup: 'developers', routes: [handle], defaultRoute: handle, reasoning: 'off' });
    await fireEvent.click(view.getByRole('checkbox', { name: 'Enable fallback access' }));
    await fireEvent.click(view.getByRole('checkbox', { name: `Fallback ${display} route` }));
    expect(within(view.getByLabelText('Fallback default route')).getByRole('option', { name: display })).toHaveValue(handle);
    await fireEvent.change(view.getByLabelText('Fallback default route'), { target: { value: handle } });
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: true, routes: [handle], defaultRoute: handle, reasoning: 'off' });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id: targetId, model: 'gpt-5.6-terra' });
    expect(api.native).not.toHaveBeenCalled();
    expect(view.submit).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-055: submits saved native identity during a policy-only edit', async () => {
    const targetId = '11111111-1111-4111-8111-111111111111';
    const view = mount({ ...checkedCurrent(), nativeTargets: [{
      id: targetId, label: 'Ready Claude', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5',
      contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') },
      enabled: true, verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true },
    }] });
    await openGroup(view, 'developers');
    await fireEvent.click(view.getByRole('checkbox', { name: 'developers Native Route - AWS Bedrock - Ready Claude route' }));
    expect(formValues(view.container).groupRouting[0].routes).toContain(`cf-native-${targetId}`);
    expect(formValues(view.container).nativeTargets).toEqual([
      expect.objectContaining({ id: targetId, provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', enabled: true }),
    ]);
  });

  it.each([
    ['unavailable', { ...catalog, providerCatalogStatus: 'unavailable' as const, providers: [] }, 'Provider discovery is unavailable. Check the connection to add a Native Route.'],
    ['empty', { ...catalog, providerCatalogStatus: 'ready' as const, providers: [] }, 'No provider configurations are available to add.'],
  ])('keeps the native provider %s state actionable without restoring the provider catalogue', async (_case, providerCatalog, message) => {
    api.catalog.mockResolvedValueOnce(providerCatalog);
    const view = mount(checkedCurrent());
    await openNative(view);
    expect(view.getByText(message)).toBeVisible();
    expect(view.queryByText('Configured providers')).toBeNull();
    expect(view.queryByRole('button', { name: 'Add Native Route' })).toBeNull();
  });

  it('REQ-ENTERPRISE-051: edits the target label and context window in the native draft', async () => {
    const view = mount(checkedCurrent());
    await addNativeTarget(view);
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Claude production' } });
    await fireEvent.input(view.getByLabelText('Native target 1 context window'), { target: { value: '240000' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ label: 'Claude production', contextWindow: 240000 });
  });

  it('REQ-ENTERPRISE-051: accepts an exact model independently of provider-scoped optional suggestions', async () => {
    api.catalog.mockResolvedValueOnce({ ...catalog, providers: [
      { provider: 'google-ai-studio', label: 'Google AI Studio', configured: true, defaultSelection: false, supported: true },
      { provider: 'openai', label: 'OpenAI', configured: true, defaultSelection: false, supported: true },
    ] });
    const saved = checkedCurrent();
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), legs: route === 'general_usage'
      ? [{ nodeId: 'google', provider: 'google-ai-studio', declaredModel: 'gemini-suggested' }]
      : [{ nodeId: 'openai', provider: 'openai', declaredModel: 'gpt-suggested' }] }));
    const view = mount(saved);
    await addNativeTarget(view);
    const model = view.getByLabelText('Native target 1 model');
    const suggestions = () => Array.from(document.getElementById(model.getAttribute('list')!)!.querySelectorAll('option'), (option) => option.value);
    await waitFor(() => expect(suggestions()).toEqual(['gemini-suggested']));
    await fireEvent.input(model, { target: { value: 'gemini-exact-not-listed' } });
    expect(formValues(view.container).nativeTargets[0].model).toBe('gemini-exact-not-listed');
    await fireEvent.change(view.getByLabelText('Native target 1 provider'), { target: { value: 'openai' } });
    expect(model).toHaveValue('');
    await waitFor(() => expect(suggestions()).toEqual(['gpt-suggested']));
    await fireEvent.input(model, { target: { value: 'gpt-exact-not-listed' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ provider: 'openai', model: 'gpt-exact-not-listed' });
  });

  it.each([
    ['built-in', { id: 'native-openai-compat', revision: 1, hash: hash('d') }, undefined],
    ['saved custom', savedNativeCustomRef, savedNativeCustom],
  ])('REQ-ENTERPRISE-054: selects the exact %s profile revision in the target draft', async (_kind, ref, custom) => {
    const saved = checkedCurrent();
    const view = mount({ ...saved, reasoningConfiguration: { ...saved.reasoningConfiguration, customProfileRevisions: custom ? [custom] : [] }, nativeTargets: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Native target', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false }] });
    await openNative(view);
    await fireEvent.click(view.getByRole('button', { name: 'Configure Native Route - AWS Bedrock - eu.anthropic.claude-sonnet-5' }));
    await fireEvent.change(view.getByLabelText('Native target 1 profile'), { target: { value: profileKey(ref) } });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-sonnet-5' } });
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Renamed native target' } });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ profileRef: ref, transport: 'aig-legacy-compat', label: 'Renamed native target' });
  });

  it('REQ-ENTERPRISE-054: invokes native compatibility discovery for the current target draft', async () => {
    const view = mount(checkedCurrent());
    await addNativeTarget(view);
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-future-profile' } });
    const before = formValues(view.container).nativeTargets[0];
    await fireEvent.click(view.getByRole('button', { name: 'Discover Profile for native target 1' }));
    await waitFor(() => expect(api.nativeDiscover).toHaveBeenCalledExactlyOnceWith({ target: before, maxCompletionTokens: 4096 }));
    expect(formValues(view.container).nativeTargets[0]).toEqual(before);
  });

  it('REQ-ENTERPRISE-054: surfaces the server error when native compatibility discovery cannot run', async () => {
    api.nativeDiscover.mockRejectedValueOnce(new ApiError('Rate limit exceeded. Try again in 44 seconds.', 429, 'Too Many Requests'));
    const view = mount(checkedCurrent());
    await addNativeTarget(view);
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-future-profile' } });
    await fireEvent.click(view.getByRole('button', { name: 'Discover Profile for native target 1' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Rate limit exceeded. Try again in 44 seconds.');
  });

  it('REQ-ENTERPRISE-054: verifies the exact selected profile and records its server-issued draft state', async () => {
    let complete!: (value: unknown) => void;
    api.native.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const view = mount({ ...checkedCurrent(), nativeTargets: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Saved', provider: 'aws-bedrock',
      model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false }] });
    await openNative(view);
    await fireEvent.click(view.getByRole('button', { name: 'Configure Native Route - AWS Bedrock - eu.anthropic.claude-sonnet-5' }));
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Automated target' } });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-sonnet-5' } });
    const article = view.getByRole('article', { name: 'Automated target native target' });
    const verify = within(article).getByRole('button', { name: 'Verify Profile' });
    await fireEvent.click(verify);
    await waitFor(() => expect(api.native).toHaveBeenCalledExactlyOnceWith({ target: expect.objectContaining({ label: 'Automated target', model: 'eu.anthropic.claude-sonnet-5', profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false }) }));
    expect(within(article).getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    expect(within(article).getByLabelText('Native target 1 provider')).toBeDisabled();
    expect(within(article).getByLabelText('Native target 1 model')).toBeDisabled();
    expect(within(article).getByLabelText('Native target 1 profile')).toBeDisabled();
    expect(within(article).getByRole('button', { name: 'Remove Automated target' })).toBeDisabled();
    complete({ targetId: '11111111-1111-4111-8111-111111111111', classification: 'Verified', assignable: true, checkId: '22222222-2222-4222-8222-222222222222', verification: { method: 'automated', checkedAt: '2026-09-09T12:00:00.000Z', current: true } });
    await waitFor(() => expect(formValues(view.container).nativeChecks).toEqual({ '11111111-1111-4111-8111-111111111111': '22222222-2222-4222-8222-222222222222' }));
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', enabled: true });
    expect(view.queryByLabelText('Enable Automated target native target')).toBeNull();
  });

  it('keeps a pending native verification attached to its target when another target is removed', async () => {
    let complete!: (value: unknown) => void;
    api.native.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const nativeTarget = (id: string, label: string, model: string) => ({ id, label, provider: 'aws-bedrock', model, contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false });
    const view = mount({ ...checkedCurrent(), nativeTargets: [
      nativeTarget('11111111-1111-4111-8111-111111111111', 'First', 'eu.anthropic.claude-haiku'),
      nativeTarget('22222222-2222-4222-8222-222222222222', 'Pending', 'eu.anthropic.claude-sonnet-5'),
      nativeTarget('33333333-3333-4333-8333-333333333333', 'Third', 'eu.anthropic.claude-opus-5'),
    ] });
    await openNative(view);
    await fireEvent.click(view.getByRole('button', { name: 'Configure Native Route - AWS Bedrock - eu.anthropic.claude-sonnet-5' }));
    await fireEvent.click(within(view.getByRole('article', { name: 'Pending native target' })).getByRole('button', { name: 'Verify Profile' }));
    await fireEvent.click(view.getByRole('button', { name: 'Remove First' }));
    complete({ targetId: '44444444-4444-4444-8444-444444444444', classification: 'Verified', assignable: true, checkId: '55555555-5555-4555-8555-555555555555', verification: { method: 'automated', checkedAt: '2026-09-09T12:00:00.000Z', current: true } });
    await waitFor(() => expect(formValues(view.container).nativeTargets).toEqual([
      expect.objectContaining({ id: '44444444-4444-4444-8444-444444444444', label: 'Pending', enabled: true }),
      expect.objectContaining({ id: '33333333-3333-4333-8333-333333333333', label: 'Third', enabled: false }),
    ]));
  });

  it('REQ-ENTERPRISE-066: enables Save for a complete disabled native draft without access policies', async () => {
    const view = mount({ ...current, gatewayUrl: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/', gatewayId: 'codeflare-enterprise', dynamicRoutes: [], defaultRoute: null, groupRouting: [], reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} } });
    await addNativeTarget(view);
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Claude draft' } });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'arn:aws:bedrock:eu-central-1:123:model/claude' } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-sonnet-5' } });
    await fireEvent.input(view.getByLabelText('Native target 1 context window'), { target: { value: '4000001' } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    await fireEvent.input(view.getByLabelText('Native target 1 context window'), { target: { value: '200000' } });
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    expect(formValues(view.container)).toMatchObject({ dynamicRoutes: [], groupRouting: [], fallbackRouting: { enabled: false } });
    expect(formValues(view.container).nativeTargets).toMatchObject([{ label: 'Claude draft', enabled: false }]);
  });

  it('REQ-ENTERPRISE-066: keeps Save unavailable for a native draft whose profile is unavailable', async () => {
    const unavailableRef = { id: 'missing-native-profile', revision: 1, hash: hash('9') };
    const view = mount({
      ...current,
      gatewayUrl: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/', gatewayId: 'codeflare-enterprise',
      dynamicRoutes: [], defaultRoute: null, groupRouting: [], reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
      nativeTargets: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Unavailable profile', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: unavailableRef, enabled: false }],
    });
    await openNative(view);
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Unavailable profile draft' } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
  });

  it('REQ-ENTERPRISE-069: enables Review for a verified Dynamic Route profile without an access policy', async () => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce(verifiedReport('general_usage', glmRef));
    const view = mount({
      ...current,
      dynamicRoutes: [], groupRouting: [], fallbackRouting: { enabled: false },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
    });
    await ready(view, 'general_usage');
    await fireEvent.change(view.getByLabelText('general_usage Pi compatibility profile'), { target: { value: profileKey(glmRef) } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    await fireEvent.click(view.getByRole('button', { name: 'Mark general_usage as verified' }));
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    expect(formValues(view.container)).toMatchObject({ dynamicRoutes: [], groupRouting: [], fallbackRouting: { enabled: false } });
    expect(draftConfiguration(view.container).routeAssignments.general_usage.activeProfile).toEqual(glmRef);
  });

  it('REQ-ENTERPRISE-054: verification automatically enables the native target draft', async () => {
    api.native.mockRejectedValueOnce(new ApiError('Rate limit exceeded. Try again in 44 seconds.', 429, 'Too Many Requests'))
      .mockResolvedValueOnce({ targetId: '11111111-1111-4111-8111-111111111111', classification: 'Verified', assignable: true,
        checkId: '22222222-2222-4222-8222-222222222222', verification: { method: 'automated', checkedAt: '2026-09-09T12:00:00.000Z', current: true } });
    const view = mount(checkedCurrent());
    await addNativeTarget(view);
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Claude custom' } });
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-future-profile' } });
    const article = view.getByRole('article', { name: 'Claude custom native target' });
    expect(within(article).getByText('Not ready')).toHaveAttribute('data-state', 'unclear');
    await fireEvent.click(within(article).getByRole('button', { name: 'Verify Profile' }));
    expect(await within(article).findByRole('alert')).toHaveTextContent('Rate limit exceeded. Try again in 44 seconds.');
    // An explicit second Verify click remains a live check, not administrator confirmation.
    expect(within(article).getByRole('button', { name: 'Mark as verified' })).toBeVisible();
    await fireEvent.click(within(article).getByRole('button', { name: 'Verify Profile' }));
    await waitFor(() => expect(api.native).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ model: 'eu.anthropic.claude-future-profile' }) })));
    expect(api.native.mock.calls[api.native.mock.calls.length - 1]?.[0]).not.toHaveProperty('administratorConfirmed');
    expect(view.queryByLabelText('Enable Claude custom native target')).toBeNull();
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', model: 'eu.anthropic.claude-future-profile', enabled: true });
  });

  it('REQ-ENTERPRISE-054: removes a native target from the editable draft', async () => {
    const saved = checkedCurrent();
    const view = mount({ ...saved, nativeTargets: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Saved target', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: false }] });
    await openNative(view);
    expect(view.getByRole('article', { name: 'Saved target native target' })).toBeVisible();
    await fireEvent.click(view.getByRole('button', { name: 'Remove Saved target' }));
    expect(formValues(view.container).nativeTargets).toEqual([]);
  });
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
  it('REQ-ENTERPRISE-034/064: presents and preserves named Dynamic Routes in many-to-many group policies', async () => {
    const view = mount(checkedCurrent());
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    await openGroup(view, 'developers');
    expect(view.getByRole('checkbox', { name: 'developers Dynamic Route - general_usage route' })).toBeChecked();
    expect(view.getByRole('checkbox', { name: 'developers Dynamic Route - development route' })).toBeChecked();
    expect(view.getByLabelText('developers default route')).toHaveValue('development');
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('medium');
    await openGroup(view, 'support');
    expect(view.getByRole('checkbox', { name: 'support Dynamic Route - general_usage route' })).toBeChecked();
    expect(view.getByRole('checkbox', { name: 'support Dynamic Route - development route' })).not.toBeChecked();
    await fireEvent.change(view.getByLabelText('Unconfigured access group'), { target: { value: 'research-team' } });
    await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    expect(view.getByRole('checkbox', { name: 'research-team Dynamic Route - general_usage route' })).not.toBeChecked();
    await fireEvent.click(view.getByRole('checkbox', { name: 'research-team Dynamic Route - development route' }));
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
    await fireEvent.click(view.getByRole('checkbox', { name: 'developers Dynamic Route - research route' }));
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
    expect(Array.from(profile.options, (option) => option.value)).toEqual([
      '', ...catalog.profiles.filter((candidate) => !candidate.id.startsWith('bedrock-anthropic-native-')).map(profileKey),
    ]);
    expect(Array.from(profile.options, (option) => option.text)).toContain('Dynamic Route - AWS Bedrock - Claude');
    expect(Array.from(profile.options, (option) => option.text)).not.toContain('Native Route - AWS Bedrock - Claude Sonnet');
    expect(Array.from(profile.options, (option) => option.text)).not.toContain('Native Route - AWS Bedrock - Claude Opus');
    expect(profile).toHaveValue(profileKey(kimiRef));
    expect(within(profile).queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });

  it('REQ-ENTERPRISE-075: removes hidden provider-native authority from a Dynamic Route draft until an allowed profile is selected', async () => {
    const nativeRef = { id: 'bedrock-anthropic-native-sonnet', revision: 1, hash: hash('7') };
    const view = mount({
      ...checkedCurrent(),
      reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: {
        ...current.reasoningConfiguration.routeAssignments,
        general_usage: { activeProfile: nativeRef, routeVersion: 'general_usage-v2', verification: proof('general_usage', nativeRef) },
      } },
    });
    await ready(view, 'general_usage');
    const profile = view.getByLabelText('general_usage Pi compatibility profile') as HTMLSelectElement;
    expect(profile).toHaveValue('');
    expect(view.getByRole('alert')).toHaveTextContent('Native Route - AWS Bedrock - Claude Sonnet is unavailable for Dynamic Routes');
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.general_usage).toBeUndefined();
    await fireEvent.change(profile, { target: { value: profileKey(glmRef) } });
    expect(view.queryByText(/unavailable for Dynamic Routes/)).toBeNull();
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.general_usage).toEqual({ activeProfile: glmRef });
  });

  it('REQ-ENTERPRISE-045/070: presents Dynamic Bedrock reasoning as provider-controlled instead of unsupported Off', async () => {
    const view = mount({
      ...checkedCurrent(),
      reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: {
        ...current.reasoningConfiguration.routeAssignments,
        general_usage: { activeProfile: bedrockDynamicRef, verification: proof('general_usage', bedrockDynamicRef) },
      } },
    });
    await ready(view, 'general_usage');
    const card = await openRoute(view, 'general_usage');
    expect(within(card).getByText('Provider default')).toBeVisible();
    expect(within(card).queryByText('Reasoning off')).toBeNull();
    expect(within(card).queryByText('Not supported')).toBeNull();
  });

  it('REQ-ENTERPRISE-034: offers one primary action on the expanded route and runs route-only protocol discovery', async () => {
    const view = mount(); await ready(view);
    expect(view.getAllByRole('button', { name: /discover profile for /i })).toHaveLength(1);
    expect(view.queryByRole('button', { name: /revalidate|start discovery|use evidence/i })).toBeNull();
    const before = draftConfiguration(view.container);
    await fireEvent.click(view.getByRole('button', { name: 'Discover Profile for development' }));
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
    await fireEvent.click(view.getByRole('button', { name: 'Discover Profile for general_usage' }));
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
    expect(verify.closest('details')).toHaveAttribute('open');
    expect(within(card).getByRole('button', { name: 'Discover Profile for development' })).toBeVisible();
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
    const pill = await view.findByText('Compatible · backup untested', { exact: true });
    expect(pill).toBeVisible();
    expect(pill).toHaveAttribute('data-state', 'passed'); // Existing green success treatment; the backup warning remains.
    expect(view.getByText(/Other backends remain untested/)).toBeVisible();
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container).routeAssignments.development).toEqual({ activeProfile: kimiRef, routeVersion: 'development-v2', verification: proof('development', kimiRef, 'observed-path') });
    expect(formValues(view.container).dynamicRoutes).toEqual(['development']);
    expect(formValues(view.container).routeChecks.development).toBe('development-check');
    await openGroup(view, 'developers');
    expect(view.getByRole('checkbox', { name: 'developers Dynamic Route - development route' })).toBeChecked();
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
    expect(within(view.getByRole('article', { name: 'development route' })).getByText('Needs confirmation · inactive', { exact: true })).toBeVisible();
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
    await fireEvent.click(await view.findByText('Technical check details'));
    await view.findByRole('table', { name: 'Selected profile checks' });
    expect(view.queryByText('Verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(formValues(view.container).routeChecks.development).toBeNull();
    await expectDevelopmentInactive(view);
  });
  }

  if (partition === 'second') {
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
    await fireEvent.click(await view.findByText('Technical check details'));
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
    const details = (await view.findByText('Technical check details')).closest('details')!;
    await fireEvent.click(within(details).getByText('Technical check details'));
    expect(await view.findByRole('cell', { name: cell })).toBeVisible();
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

  it.each([1, 2])('REQ-ENTERPRISE-038: retains %s saved custom backend descriptions without a metadata editor', async (count) => {
    const legs = Array.from({ length: count }, (_, index) => ({ nodeId: `custom-${index}`, provider: 'custom-enterprise', declaredModel: `model-${index}`, customProviderBackend: `Saved backend ${index}`, profileRef: kimiRef }));
    const descriptions = Object.fromEntries(legs.map((leg) => [leg.nodeId, leg.customProviderBackend]));
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), legs }));
    api.discover.mockResolvedValueOnce(verifiedReport('development', kimiRef, count === 1 ? 'single-model' : 'observed-path'));
    const saved = withDevelopment({ activeProfile: kimiRef, legs });
    const snapshot = structuredClone(saved);
    const view = mount(saved); await ready(view);
    expect(view.queryByLabelText('custom-0 custom provider backend')).toBeNull();
    await verifyProfile(view);
    await waitFor(() => expect(formValues(view.container).routeChecks.development).toBe('development-check'));
    expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: kimiRef, backendDescriptions: descriptions, maxCompletionTokens: 4096 });
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.development.legs).toEqual(legs);
    expect(saved).toEqual(snapshot);
    expect(view.submit).not.toHaveBeenCalled();
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

  it('REQ-ENTERPRISE-038: #105 confirms a generated Dynamic selection without inventing automated facts or assigning access', async () => {
    const custom = normalizeCustomProfile({ schemaVersion: 1, id: 'discovered-manual-selection', revision: 1,
      name: 'Generated Dynamic', enabled: true, supportedLevels: ['medium'],
      levels: { medium: [{ path: 'reasoning_effort', value: 'medium' }] }, removePaths: ['reasoning_effort'] });
    const ref = { id: custom.id, revision: custom.revision, hash: custom.hash };
    const receipt = { ...proof('development', ref), method: 'administrator' as const, supportedLevels: ['medium'] as PiReasoningLevel[] };
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce({ route: 'development', classification: 'Administrator-confirmed', assignable: true,
      checkId: 'development-manual-check', verification: receipt, diagnostics: [] });
    const view = mount({ ...current, dynamicRoutes: [], defaultRoute: null, groupRouting: [],
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [custom], routeAssignments: { development: { activeProfile: ref } } } });
    await ready(view);
    const card = view.getByRole('article', { name: 'development route' });
    const confirm = within(card).getByRole('button', { name: 'Mark development as verified' });
    expect(confirm.closest('details')).toHaveAttribute('open');
    expect(draftConfiguration(view.container).routeAssignments.development).not.toHaveProperty('verification');
    await fireEvent.click(confirm);
    await waitFor(() => expect(formValues(view.container).routeChecks.development).toBe('development-manual-check'));
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', profileRef: ref, profileDraft: custom,
      administratorConfirmed: true, maxCompletionTokens: 4096 });
    expect(draftConfiguration(view.container).routeAssignments.development.verification).toEqual(receipt);
    const result = within(card).getByRole('region', { name: 'Check result' });
    expect(within(result).getByText('Administrator-confirmed')).toBeVisible();
    for (const fact of ['Tool calling', 'Reasoning', 'Streaming', 'Input caching']) {
      expect(within(result).getByText(fact).parentElement?.querySelector('dd')).toHaveTextContent('Not established');
    }
    expect(within(card).queryByText('Live-verified', { exact: true })).toBeNull();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).groupRouting).toEqual([]);
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: false });
    expect(view.submit).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-054: #105 confirms a generated Native selection without inventing automated facts or assigning access', async () => {
    const template = getBuiltInProfile('bedrock-anthropic-native-opus-auto')!;
    const custom = normalizeCustomProfile({ schemaVersion: 1, id: `bedrock-anthropic-native-discovered-${'a'.repeat(24)}`,
      revision: 1, name: 'Generated Native', enabled: true, supportedLevels: ['off'],
      levels: { off: template.levels.off }, removePaths: template.removePaths, offSemantics: template.offSemantics });
    const ref = { id: custom.id, revision: custom.revision, hash: custom.hash };
    const id = '11111111-1111-4111-8111-111111111111';
    const target = { id, label: 'Generated Claude', provider: 'aws-bedrock', model: 'eu.anthropic.claude-synthetic-future-2099-v1:0',
      transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1', contextWindow: 200000, profileRef: ref, enabled: false };
    const view = mount({ ...current, dynamicRoutes: [], defaultRoute: null, groupRouting: [], nativeTargets: [target],
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [custom], routeAssignments: {} } });
    await openNative(view);
    const card = view.getByRole('article', { name: 'Generated Claude native target' });
    await fireEvent.click(within(card).getByRole('button', { name: /Configure Native Route/ }));
    for (const summary of card.querySelectorAll('details > summary')) {
      if (summary.textContent?.startsWith('Advanced') && !(summary.parentElement as HTMLDetailsElement).open) await fireEvent.click(summary);
    }
    const confirm = within(card).getByRole('button', { name: 'Mark as verified' });
    expect(confirm.closest('details')).toHaveAttribute('open');
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('verification');
    await fireEvent.click(confirm);
    await waitFor(() => expect(formValues(view.container).nativeChecks).toEqual({ [id]: '22222222-2222-4222-8222-222222222222' }));
    expect(api.native).toHaveBeenCalledExactlyOnceWith({ target, profileDraft: custom, administratorConfirmed: true });
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id, profileRef: ref, enabled: true });
    // Save carries only the server check ID, never client-authored verification facts.
    expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty('verification');
    expect(draftConfiguration(view.container).customProfileRevisions).toEqual([custom]);
    const result = within(card).getByRole('region', { name: 'Check result' });
    expect(within(result).getByText('Administrator-confirmed')).toBeVisible();
    for (const fact of ['Tool calling', 'Reasoning', 'Streaming', 'Input caching']) {
      expect(within(result).getByText(fact).parentElement?.querySelector('dd')).toHaveTextContent('Not established');
    }
    expect(formValues(view.container).groupRouting).toEqual([]);
    expect(formValues(view.container).fallbackRouting).toEqual({ enabled: false });
    expect(api.nativeDiscover).not.toHaveBeenCalled();
    expect(view.submit).not.toHaveBeenCalled();
  });

  it.each(['Dynamic', 'Native'] as const)('REQ-ENTERPRISE-039: #106 preserves all seven Provider-default preferences in %s group and fallback payloads', async (kind) => {
    const id = '11111111-1111-4111-8111-111111111111';
    const route = kind === 'Dynamic' ? 'general_usage' : `cf-native-${id}`;
    const saved = checkedCurrent();
    api.inventory.mockImplementation(async (name: string) => ({ ...singleInventory(name),
      verification: proof(name, name === 'general_usage' ? bedrockDynamicRef : selectedRef(name)) }));
    const view = mount({ ...saved,
      reasoningConfiguration: { ...saved.reasoningConfiguration, routeAssignments: {
        ...saved.reasoningConfiguration.routeAssignments,
        general_usage: { activeProfile: bedrockDynamicRef, verification: proof('general_usage', bedrockDynamicRef) },
      } },
      nativeTargets: [{ id, label: 'Provider-controlled Claude', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5',
        contextWindow: 200000, profileRef: { id: 'bedrock-anthropic-compat', revision: 1, hash: hash('c') }, enabled: true,
        verification: { method: 'administrator', checkedAt: '2026-09-09T12:00:00.000Z', current: true } }],
      groupRouting: [{ accessGroup: 'developers', routes: [route], defaultRoute: route, reasoning: 'off' }],
      fallbackRouting: { enabled: true, routes: [route], defaultRoute: route, reasoning: 'off' },
    });
    await view.findByText('Connected · 3 routes readable');
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    await openGroup(view, 'developers');
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const label of ['developers', 'Fallback']) {
      const select = view.getByLabelText(`${label} default reasoning`) as HTMLSelectElement;
      expect(Array.from(select.options, (option) => option.value)).toEqual(levels);
      expect(select).toBeEnabled();
      expect(describedText(select)).toMatch(/no explicit override is sent/i);
      expect(describedText(select)).toMatch(/Off.*(?:not guaranteed|does not guarantee)/i);
      for (const reasoning of levels) {
        await fireEvent.change(select, { target: { value: reasoning } });
        expect(select).toHaveValue(reasoning);
        const values = formValues(view.container);
        expect(label === 'developers' ? values.groupRouting[0] : values.fallbackRouting).toMatchObject({
          routes: [route], defaultRoute: route, reasoning,
        });
      }
    }
    expect(api.discover).not.toHaveBeenCalled();
    expect(api.native).not.toHaveBeenCalled();
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
    expect(view.getByLabelText('Fallback default reasoning')).toBeEnabled();
    expect(describedText(view.getByLabelText('Fallback default reasoning'))).toMatch(/only Off/);
    expect(new FormData(view.container.querySelector('form')!).get('reasoning')).toBe('off');
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'general_usage', reasoning: 'off' });
    await fireEvent.change(view.getByLabelText('developers default route'), { target: { value: 'general_usage' } });
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('off');
    expect(view.getByLabelText('developers default reasoning')).toBeEnabled();
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

  it('REQ-ENTERPRISE-057: a successfully checked credential change preserves saved route authority for Review changes', async () => {
    const view = mount({ ...checkedCurrent(), routeChecks: { general_usage: 'general_usage-check', development: 'development-check' } });
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    await section(view, 'Connection');
    await fireEvent.input(view.getByLabelText('Replacement API token'), { target: { value: 'rotated-token' } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.development.verification).toEqual(proof());
    expect(formValues(view.container).routeChecks).toEqual({ general_usage: 'general_usage-check', development: 'development-check' });
    await fireEvent.click(view.getByRole('button', { name: 'Check connection' }));
    await view.findByText('Connected · 3 routes readable');
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    expect(formValues(view.container).replacementToken).toBe('rotated-token');
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
  });

  it('REQ-ENTERPRISE-042: canonicalizes a pasted v4 inference URL and supplies the gateway name to Dynamic Route discovery', async () => {
    const view = mount(checkedCurrent()); await ready(view);
    await section(view, 'Connection');
    await fireEvent.change(view.getByLabelText('Gateway URL format'), { target: { value: 'account-api' } });
    await fireEvent.input(view.getByLabelText('AI Gateway URL'), { target: { value: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions' } });
    await fireEvent.input(view.getByLabelText('AI Gateway name'), { target: { value: 'codeflare-enterprise' } });
    await fireEvent.click(view.getByRole('button', { name: 'Check connection' }));
    await view.findByText('Connected · 3 routes readable');
    expect(view.getByLabelText('AI Gateway URL')).toHaveValue('https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/');
    expect(api.catalog).toHaveBeenLastCalledWith({ gatewayUrl: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/', gatewayId: 'codeflare-enterprise' });
    expect(formValues(view.container).gatewayId).toBe('codeflare-enterprise');
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
    expect(view.getByRole('button', { name: 'Discover Profile for research' })).toBeEnabled();
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(formValues(view.container).routeContextWindows).toEqual(current.routeContextWindows);
    expect(draftConfiguration(view.container)).toEqual({ ...saved.reasoningConfiguration, fallbackRouting: { enabled: false } });
    await openGroup(view, 'developers');
    expect(view.queryByLabelText('developers Dynamic Route - research route')).toBeNull();
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
    expect(view.getByRole('button', { name: 'Discover Profile for research' })).toBeEnabled();
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
    await fireEvent.click(view.getByRole('checkbox', { name: 'support Dynamic Route - general_usage route' }));
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
    expect(view.queryByLabelText('developers Dynamic Route - research route')).toBeNull();
    api.discover.mockResolvedValueOnce(verifiedReport('research'));
    await verifyProfile(view, 'research');
    await waitFor(() => expect(formValues(view.container).routeChecks.research).toBe('research-check'));
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    await openGroup(view, 'developers');
    await fireEvent.click(view.getByRole('checkbox', { name: 'developers Dynamic Route - research route' }));
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
  }
});
}
