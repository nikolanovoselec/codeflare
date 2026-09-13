import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import { normalizeCustomProfile, getBuiltInProfile, BUILT_IN_REASONING_PROFILES } from '../../../../src/lib/reasoning-profiles';
import type { CapabilitySummary } from '../../../../src/lib/ai-capability-discovery/contract';

const api = vi.hoisted(() => ({ discover: vi.fn(), inventory: vi.fn(), catalog: vi.fn(), checkNative: vi.fn(), verify: vi.fn() }));
vi.mock('../../api/client', () => ({ discoverTargetCapabilities: (...args: unknown[]) => api.discover(...args),
  checkNativeTarget: (...args: unknown[]) => api.checkNative(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.verify(...args),
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args), getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const profile = normalizeCustomProfile({ id: 'discovered-synthetic-wire', name: 'Discovered protocol', schemaVersion: 1, revision: 1,
  enabled: true, reasoningMode: 'provider-default', supportedLevels: [], levels: {}, removePaths: [],
  compatibility: { response: 'stream', toolNames: 'repeated-complete' } });
const ref = { id: profile.id, revision: profile.revision, hash: profile.hash };
const capabilities = { schemaVersion: 1, tools: true, replay: true, cache: 'gateway-response', nativePromptCache: false,
  reasoning: 'provider-default', streaming: 'incremental', grade: 'Optimal' };
const proof = { schemaVersion: 1, profileRef: ref, routeVersion: 'v1', inventoryDigest: 'a'.repeat(64), connectionFingerprint: 'b'.repeat(64),
  canaryVersion: 'synthetic', supportedLevels: [], scope: 'observed-path', checkedAt: '2026-09-13T12:00:00Z', capabilities };
const result = { schemaVersion: 1, assignable: true, classification: 'Verified', explanation: 'Automatically selected; review and Save.',
  capabilities, profile, attempts: [], accounting: { httpAttempts: 4 }, checkId: 'synthetic-check', routeVerification: proof };
function setup(overrides: Record<string, unknown> = {}, catalogOverrides: Record<string, unknown> = {}) {
  api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: BUILT_IN_REASONING_PROFILES, notices: [], usage: [],
    routes: ['brand-new-route'], routeCatalogStatus: 'ready', providers: [{ provider: 'aws-bedrock', label: 'Amazon Bedrock', supported: true, configured: true, defaultSelection: true }], providerCatalogStatus: 'ready', ...catalogOverrides });
  api.inventory.mockResolvedValue({ route: 'brand-new-route', routeVersion: 'v1', inventoryDigest: 'a'.repeat(64),
    legs: [{ nodeId: 'future', provider: 'future-provider', declaredModel: 'synthetic-future-2099' }] });
  const current = { gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', dynamicRoutes: [],
    routeContextWindows: {}, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, availableAccessGroups: ['engineering'], ...overrides };
  return render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
}
// Accessible result/disclosure names are the shared normal and Advanced UI contract.
const advancedName = /Advanced: choose a profile/i;
const checkResultName = /^Check result$/i;

function formValues(container: HTMLElement): any {
  return environmentValues('aiRouting', 'enterprise', new FormData(container.querySelector('form')!));
}

describe('REQ-ENTERPRISE-074 select target → Discover → review/Save', () => {
  it('REQ-ENTERPRISE-041: Discover leaves one visible result and the review/save next step outside optional profile controls', async () => {
    api.discover.mockResolvedValue(result);
    const view = setup();
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const row = within(view.getByRole('article', { name: 'brand-new-route route' }));
    const advanced = row.getByText(advancedName).closest('details')!;
    expect(row.getAllByText(advancedName)).toHaveLength(1);
    expect(advanced.open).toBe(false);
    expect(row.getByLabelText('brand-new-route Pi compatibility profile')).not.toBeVisible();
    // Closed details retain their controls in the DOM; assert visibility, not absence.
    for (const name of ['Discover Profile for brand-new-route', 'Verify Profile for brand-new-route']) {
      const control = row.getByRole('button', { name, hidden: true });
      expect(advanced).toContainElement(control);
      expect(control).not.toBeVisible();
    }
    const discover = row.getByRole('button', { name: 'Discover capabilities for brand-new-route' });
    await waitFor(() => expect(discover).toBeEnabled());
    await fireEvent.click(discover);

    const panel = await row.findByRole('region', { name: checkResultName });
    expect(row.getAllByRole('region', { name: checkResultName })).toHaveLength(1);
    expect(advanced).not.toContainElement(panel);
    expect(await within(panel).findByText('Ready for review')).toBeVisible();
    expect(within(panel).getByText(/Review changes/i)).toBeVisible();
    expect(within(panel).getByText(/Confirm Save/i)).toBeVisible();
    expect(within(panel).getByText(/next (?:normal )?session/i)).toBeVisible();
    const detailSummary = within(panel).getByText(/(?:check|technical|discovery) details|discovery attempts/i);
    const details = detailSummary.closest('details')!;
    expect(details.open).toBe(false);
    await fireEvent.click(detailSummary);
    expect(within(panel).getByText(/Gateway HIT/i)).toBeVisible();
    await fireEvent.click(detailSummary);
    expect(within(panel).getByText('Ready for review')).toBeVisible();
    expect(advanced.open).toBe(false);
    expect(formValues(view.container).routeChecks['brand-new-route']).toBe('synthetic-check');
    expect(formValues(view.container).reasoningConfiguration.routeAssignments['brand-new-route'].activeProfile).toEqual(ref);
    expect(api.verify).not.toHaveBeenCalled();
    expect(api.checkNative).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-038: Advanced verification updates the same visible result without requiring the disclosure to stay open', async () => {
    api.verify.mockResolvedValue({ classification: 'Verified', assignable: true, checkId: 'advanced-check', verification: proof });
    const view = setup({ reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [profile],
      routeAssignments: { 'brand-new-route': { activeProfile: ref } } } });
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const row = within(view.getByRole('article', { name: 'brand-new-route route' }));
    const summary = row.getByText(advancedName);
    const advanced = summary.closest('details')!;
    await fireEvent.click(summary);
    const controls = within(advanced);
    expect(controls.getByLabelText('brand-new-route Pi compatibility profile')).toBeVisible();
    expect(controls.getByRole('button', { name: 'Discover Profile for brand-new-route' })).toBeVisible();
    // Generated contracts require live evidence; only historical eligible profiles offer manual confirmation.
    expect(controls.queryByRole('button', { name: 'Mark brand-new-route as verified' })).toBeNull();
    const verify = controls.getByRole('button', { name: 'Verify Profile for brand-new-route' });
    await waitFor(() => expect(verify).toBeEnabled());
    await fireEvent.click(verify);
    await waitFor(() => expect(formValues(view.container).routeChecks['brand-new-route']).toBe('advanced-check'));
    await fireEvent.click(summary);

    const panel = row.getByRole('region', { name: checkResultName });
    expect(row.getAllByRole('region', { name: checkResultName })).toHaveLength(1);
    expect(advanced).not.toContainElement(panel);
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent(/check passed|verified|automated/i);
    expect(within(panel).getByText(/Review changes/i)).toBeVisible();
    expect(formValues(view.container).reasoningConfiguration.routeAssignments['brand-new-route'].verification).toEqual(proof);
    expect(api.discover).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-040: an unsuccessful normal Discover replaces success without authorizing its returned profile or receipt', async () => {
    api.discover.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, assignable: false,
      classification: 'Inconclusive', explanation: 'Cache reuse was not observed. Check again before enabling this route.' });
    const view = setup();
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const discover = view.getByRole('button', { name: 'Discover capabilities for brand-new-route' });
    await waitFor(() => expect(discover).toBeEnabled());
    await fireEvent.click(discover);
    await waitFor(() => expect(formValues(view.container).routeChecks['brand-new-route']).toBe('synthetic-check'));
    await fireEvent.click(discover);

    const panel = await view.findByRole('region', { name: checkResultName });
    await waitFor(() => expect(panel).toHaveTextContent(/cache reuse was not observed/i));
    expect(within(panel).getByText(/cache reuse was not observed/i)).toBeVisible();
    expect(panel).not.toHaveTextContent(/Optimal|automatically selected/i);
    expect(formValues(view.container).routeChecks['brand-new-route']).toBeNull();
    expect(formValues(view.container).reasoningConfiguration.routeAssignments['brand-new-route'].verification).toBeUndefined();
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
  });

  it('REQ-ENTERPRISE-040: Native Advanced recheck clears prior discovery success and receipt while pending and after failure', async () => {
    const native = getBuiltInProfile('bedrock-anthropic-native-provider-default')!;
    const targetId = '11111111-1111-4111-8111-111111111111';
    api.discover.mockResolvedValue({ ...result, profile: native, routeVerification: undefined, targetId,
      nativeVerification: { method: 'automated', checkedAt: proof.checkedAt, current: true } });
    let finish!: (value: unknown) => void;
    api.checkNative.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = setup();
    await view.findByText('Connected · 1 routes readable');
    await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
    await fireEvent.click(view.getByRole('button', { name: 'Add Native Route' }));
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-synthetic-future-2099-v1:0' } });
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Rechecked native' } });
    await fireEvent.click(view.getByRole('button', { name: 'Discover capabilities for native target 1' }));
    await waitFor(() => expect(formValues(view.container).nativeChecks[targetId]).toBe('synthetic-check'));
    expect(view.getByText('Ready for review')).toBeVisible();
    const row = within(view.getByRole('article', { name: 'Rechecked native native target' }));
    // Reach the existing recheck path before asserting its stale-evidence bug;
    // disclosure consolidation is independently covered above.
    const summary = row.getByText(/Advanced(?:: choose a profile| profile verification)/i);
    await fireEvent.click(summary);
    expect(row.queryByRole('button', { name: /Mark .*verified/i })).toBeNull();
    await fireEvent.click(row.getByRole('button', { name: /^Verify Profile$/i }));

    // A recheck withdraws old authority immediately, not only on its response.
    expect(row.queryByText('Ready for review')).toBeNull();
    expect(formValues(view.container).nativeChecks[targetId]).toBeNull();
    expect(formValues(view.container).nativeTargets[0].enabled).toBe(false);
    finish({ targetId, assignable: false, classification: 'Inconclusive',
      capabilitySummary: { schemaVersion: 2, mappings: [{ levels: [], transport: 'bedrock-eventstream', tools: true,
        replay: false, reasoning: 'provider-default', streaming: 'incremental', cache: 'inconclusive' }] },
      cacheEvidence: { explanation: 'Exact replay was not established. Cache reuse was not observed.' } });
    await waitFor(() => expect(row.getByRole('button', { name: /^Verify Profile$/i })).toBeEnabled());
    await fireEvent.click(summary);

    const panel = row.getByRole('region', { name: checkResultName });
    expect(row.getAllByRole('region', { name: checkResultName })).toHaveLength(1);
    expect(summary.closest('details')).not.toContainElement(panel);
    expect(within(panel).getByText(/cache reuse was not observed/i)).toBeVisible();
    const toolFact = within(panel).getByText('Tool calling', { selector: 'dt' }).nextElementSibling!;
    const streamFact = within(panel).getByText('Streaming', { selector: 'dt' }).nextElementSibling!;
    expect(toolFact).toBeVisible();
    expect(toolFact).toHaveTextContent('Tool call succeeded; exact replay not verified');
    expect(streamFact).toBeVisible();
    expect(streamFact).toHaveTextContent('Incremental public deltas observed');
    expect(api.checkNative).toHaveBeenCalledTimes(1);
    expect(row.queryByText('Ready for review')).toBeNull();
    expect(formValues(view.container).nativeChecks[targetId]).toBeNull();
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id: targetId, enabled: false });
    expect(row.getByRole('button', { name: /Configure Native Route/i })).toHaveTextContent(/not ready/i);
  });

  it.each([
    ['automated', 'bedrock-anthropic-native-provider-default', /automated|live[- ]verified/i],
    ['administrator', 'bedrock-anthropic-native-sonnet', /administrator[- ]confirmed/i],
  ] as const)('REQ-ENTERPRISE-043: saved Native %s authority has a distinct visible basis without a fresh check', async (method, profileId, message) => {
    const native = getBuiltInProfile(profileId)!;
    const target = { id: '11111111-1111-4111-8111-111111111111', provider: 'aws-bedrock', label: 'Saved native',
      model: 'eu.anthropic.claude-sonnet-5', transport: 'aig-bedrock-anthropic-eventstream', region: 'eu-central-1',
      contextWindow: 200000, profileRef: { id: native.id, revision: native.revision, hash: native.hash }, enabled: true,
      verification: { method, checkedAt: proof.checkedAt, current: true } };
    const view = setup({ nativeTargets: [target] });
    await view.findByText('Connected · 1 routes readable');
    await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
    const configure = view.getByRole('button', { name: /Configure Native Route/i });
    expect(configure).toHaveTextContent(message);
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ id: target.id, enabled: true, profileRef: target.profileRef });
    expect(api.discover).not.toHaveBeenCalled();
    expect(api.checkNative).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-041: non-Bedrock Native keeps its consolidated Advanced controls open and publishes verification outside them', async () => {
    const native = getBuiltInProfile('native-openai-compat')!;
    const target = { id: '11111111-1111-4111-8111-111111111111', provider: 'openai', label: 'OpenAI native',
      model: 'synthetic-openai-model', transport: 'aig-legacy-compat', contextWindow: 200000,
      profileRef: { id: native.id, revision: native.revision, hash: native.hash }, enabled: false };
    api.checkNative.mockResolvedValue({ targetId: target.id, assignable: true, classification: 'Verified', checkId: 'openai-check',
      verification: { method: 'automated', checkedAt: proof.checkedAt, current: true } });
    const view = setup({ nativeTargets: [target] }, { providers: [{ provider: 'openai', label: 'OpenAI', supported: true, configured: true, defaultSelection: true }] });
    await view.findByText('Connected · 1 routes readable');
    await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
    await fireEvent.click(view.getByRole('button', { name: /Configure Native Route/i }));
    const row = within(view.getByRole('article', { name: 'OpenAI native native target' }));
    const summary = row.getByText(advancedName);
    const advanced = summary.closest('details')!;
    expect(advanced.open).toBe(true);
    expect(row.getAllByText(advancedName)).toHaveLength(1);
    expect(within(advanced).getByLabelText('Native target 1 profile')).toBeVisible();
    expect(within(advanced).getByRole('button', { name: 'Discover Profile for native target 1' })).toBeVisible();
    expect(within(advanced).getByRole('button', { name: 'Mark as verified' })).toBeVisible();
    await fireEvent.click(within(advanced).getByRole('button', { name: 'Verify Profile' }));
    await waitFor(() => expect(formValues(view.container).nativeChecks[target.id]).toBe('openai-check'));
    await fireEvent.click(summary);
    const panel = row.getByRole('region', { name: checkResultName });
    expect(row.getAllByRole('region', { name: checkResultName })).toHaveLength(1);
    expect(advanced).not.toContainElement(panel);
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent(/verified|check passed|automated/i);
    expect(formValues(view.container).nativeTargets[0]).toMatchObject({ ...target, enabled: true });
    expect(api.discover).not.toHaveBeenCalled();
  });

  it('automatically adopts the generated contract and receipt without choosing, naming or verifying a profile', async () => {
    api.discover.mockResolvedValue(result);
    const view = setup();
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const discover = await view.findByRole('button', { name: 'Discover capabilities for brand-new-route' });
    await waitFor(() => expect(discover).toBeEnabled());
    await fireEvent.click(discover);
    expect(await view.findByText('Ready for review')).toBeVisible();
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(api.discover).toHaveBeenCalledWith({ kind: 'dynamic-route', route: 'brand-new-route' });
    const values: any = environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!));
    expect(values.reasoningConfiguration.customProfileRevisions).toEqual([profile]);
    expect(values.reasoningConfiguration.routeAssignments['brand-new-route'].activeProfile).toEqual(ref);
    expect(values.reasoningConfiguration.routeAssignments['brand-new-route'].verification).toEqual(proof);
    expect(values.routeChecks['brand-new-route']).toBe('synthetic-check');
    expect(view.queryByRole('button', { name: /Create.*Assign/ })).toBeNull();
    expect(view.queryByRole('button', { name: /^Assign profile/ })).toBeNull();
  });

  it('shows incomplete replay without creating or authorizing a profile', async () => {
    api.discover.mockResolvedValue({ ...result, assignable: false, profile: undefined, checkId: undefined, routeVerification: undefined,
      classification: 'Inconclusive', explanation: 'Tool call succeeded, but exact replay was not established.',
      capabilities: { ...capabilities, replay: false, cache: 'inconclusive', grade: 'Not qualified' } });
    const view = setup();
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const discover = await view.findByRole('button', { name: 'Discover capabilities for brand-new-route' });
    await waitFor(() => expect(discover).toBeEnabled()); await fireEvent.click(discover);
    expect(await view.findByText(/Tool call succeeded, but exact replay/)).toBeVisible();
    const values: any = environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!));
    expect(values.reasoningConfiguration.customProfileRevisions).toEqual([]);
    expect(values.routeChecks['brand-new-route']).toBeNull();
  });

  it('selects a future Bedrock model and adopts its reusable native contract in one Discover action', async () => {
    const native = getBuiltInProfile('bedrock-anthropic-native-provider-default')!;
    const targetId = '11111111-1111-4111-8111-111111111111';
    api.discover.mockResolvedValue({ ...result, profile: native, routeVerification: undefined, targetId,
      capabilities: { ...capabilities, cache: 'provider-prefix', nativePromptCache: true },
      nativeVerification: { method: 'automated', checkedAt: proof.checkedAt, current: true } });
    const view = setup();
    await view.findByText('Connected · 1 routes readable');
    await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
    await fireEvent.click(view.getByRole('button', { name: 'Add Native Route' }));
    await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: 'eu.anthropic.claude-synthetic-future-2099-v1:0' } });
    await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Future native' } });
    // Billable limits must be visible before the operator authorizes the check.
    const discovery = within(view.getByRole('region', { name: 'native target 1 capability discovery' }));
    expect(discovery.getByText(/at most 40 submissions, 2,048 output tokens each, 90 seconds per request and 10 minutes overall/)).toBeVisible();
    expect(api.discover).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Discover capabilities for native target 1' }));
    expect(await view.findByText('Ready for review')).toBeVisible();
    const values: any = environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!));
    expect(values.nativeTargets[0]).toMatchObject({ id: targetId, enabled: true, transport: 'aig-bedrock-anthropic-auto',
      model: 'eu.anthropic.claude-synthetic-future-2099-v1:0', profileRef: { id: native.id, revision: native.revision, hash: native.hash } });
    expect(values.nativeTargets[0]).not.toHaveProperty('discoveryResult');
    expect(values.reasoningConfiguration.customProfileRevisions).toEqual([]);
    expect(values.nativeChecks[targetId]).toBe('synthetic-check');
    expect(api.discover).toHaveBeenCalledTimes(1);
  });

  it.each([
    { profileId: 'bedrock-anthropic-native-sonnet', model: 'eu.anthropic.claude-sonnet-5', transport: 'aig-bedrock-anthropic-eventstream' },
    { profileId: 'bedrock-anthropic-native-opus-invoke', model: 'eu.anthropic.claude-opus-5', transport: 'aig-bedrock-anthropic-invoke' },
  ])('retains saved $profileId in Advanced after generic adoption, requiring a fresh exact check when reselected', async ({ profileId, model, transport }) => {
    const explicit = getBuiltInProfile(profileId)!;
    const explicitRef = { id: explicit.id, revision: explicit.revision, hash: explicit.hash };
    const explicitKey = `${explicit.id}\u001f${explicit.revision}\u001f${explicit.hash}`;
    const native = getBuiltInProfile('bedrock-anthropic-native-provider-default')!;
    const nativeRef = { id: native.id, revision: native.revision, hash: native.hash };
    const target = { id: '11111111-1111-4111-8111-111111111111', provider: 'aws-bedrock', label: 'Saved native',
      model, transport, region: 'eu-central-1', contextWindow: 200000, profileRef: explicitRef, enabled: true };
    api.discover.mockResolvedValue({ ...result, profile: native, routeVerification: undefined, targetId: target.id,
      capabilities: { ...capabilities, cache: 'provider-prefix', nativePromptCache: true },
      nativeVerification: { method: 'automated', checkedAt: proof.checkedAt, current: true } });
    api.checkNative.mockResolvedValue({ targetId: target.id, assignable: true, classification: 'Administrator-confirmed', checkId: 'fresh-explicit-check',
      verification: { method: 'administrator', checkedAt: proof.checkedAt, current: true } });
    const view = setup({ nativeTargets: [{ ...target, verification: { method: 'administrator', checkedAt: proof.checkedAt, current: true } }] });
    const values = (): any => environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!));
    await view.findByText('Connected · 1 routes readable');
    await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
    const row = within(view.getByRole('article', { name: 'Saved native native target' }));
    const configure = row.getByRole('button', { name: `Configure Native Route - AWS Bedrock - ${model}` });
    await fireEvent.click(configure);
    await fireEvent.click(row.getByText(/Advanced: choose a profile/i));
    const select = row.getByLabelText('Native target 1 profile') as HTMLSelectElement;
    expect(select).toBeVisible();
    expect(Array.from(select.options, (option) => option.value)).toContain(explicitKey);
    expect(values().nativeTargets[0]).toMatchObject(target);
    await fireEvent.click(row.getByText(/Advanced: choose a profile/i));

    await fireEvent.click(row.getByRole('button', { name: 'Discover capabilities for native target 1' }));
    await waitFor(() => expect(values().nativeChecks[target.id]).toBe('synthetic-check'));
    expect(values().nativeTargets[0]).toMatchObject({ ...target, profileRef: nativeRef });
    expect(api.discover).toHaveBeenCalledWith({ kind: 'native-provider', target: { ...target, enabled: false } });
    expect(configure).toHaveTextContent('Live-verified');

    await fireEvent.click(row.getByText(/Advanced: choose a profile/i));
    expect(select).toBeVisible();
    expect(select).toBeEnabled();
    expect(Array.from(select.options, (option) => option.value)).toContain(explicitKey);
    await fireEvent.change(select, { target: { value: explicitKey } });
    expect(select).toHaveValue(explicitKey);
    expect(values().nativeTargets[0]).toMatchObject({ ...target, enabled: false });
    expect(values().nativeChecks[target.id]).toBeNull();
    expect(configure).toHaveTextContent('Not ready');
    expect(api.checkNative).not.toHaveBeenCalled();

    await fireEvent.click(row.getByRole('button', { name: 'Mark as verified' }));
    await waitFor(() => expect(values().nativeChecks[target.id]).toBe('fresh-explicit-check'));
    expect(api.checkNative).toHaveBeenCalledTimes(1);
    expect(api.checkNative).toHaveBeenCalledWith({ target: { ...target, enabled: false }, administratorConfirmed: true });
    expect(values().nativeTargets[0]).toMatchObject(target);
    expect(configure).toHaveTextContent('Administrator-confirmed');
    expect(api.discover).toHaveBeenCalledTimes(1);
  });

  it('does not adopt a successful result if the route inventory changes during discovery', async () => {
    api.discover.mockImplementation(async () => {
      api.inventory.mockResolvedValue({ route: 'brand-new-route', routeVersion: 'v2', inventoryDigest: 'c'.repeat(64), legs: [] });
      return result;
    });
    const view = setup();
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const discover = await view.findByRole('button', { name: 'Discover capabilities for brand-new-route' });
    await waitFor(() => expect(discover).toBeEnabled()); await fireEvent.click(discover);
    expect(await view.findByText(/The route changed during verification/)).toBeVisible();
    const values: any = environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!));
    expect(values.reasoningConfiguration.customProfileRevisions).toEqual([]);
    expect(values.routeChecks['brand-new-route']).toBeNull();
  });
});

// Current evidence is per mapping; legacy grades remain readable but must not be
// rendered or promoted into current authority.
describe('Independent capability evidence and administrator default preferences', () => {
  const targetId = '11111111-1111-4111-8111-111111111111';
  const model = 'eu.anthropic.claude-synthetic-future-2099-v1:0';
  const unobservedCache = { schemaVersion: 2, mappings: [{ levels: [], transport: 'compat', tools: true, replay: true,
    reasoning: 'provider-default', streaming: 'incremental', cache: 'inconclusive' }] };
  type TargetKind = 'dynamic' | 'native';

  function discoveryResult(kind: TargetKind, evidence = unobservedCache) {
    const mappedEvidence = { ...evidence, mappings: evidence.mappings.map((mapping) => ({ ...mapping,
      transport: kind === 'native' ? 'bedrock-eventstream' : mapping.transport })) };
    const common = { ...result, capabilities: mappedEvidence,
      explanation: 'Tools and replay succeeded; streaming was observed. Input caching was not established.' };
    return kind === 'dynamic'
      ? { ...common, routeVerification: { ...proof, capabilities: mappedEvidence } }
      : { ...common, profile: getBuiltInProfile('bedrock-anthropic-native-provider-default')!, targetId,
        routeVerification: undefined,
        nativeVerification: { method: 'automated', checkedAt: proof.checkedAt, current: true, discovery: mappedEvidence } };
  }

  async function discover(view: ReturnType<typeof setup>, kind: TargetKind) {
    await view.findByText('Connected · 1 routes readable');
    if (kind === 'native') {
      await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
      await fireEvent.click(view.getByRole('button', { name: 'Add Native Route' }));
      await fireEvent.input(view.getByLabelText('Native target 1 model'), { target: { value: model } });
      await fireEvent.input(view.getByLabelText('Native target 1 label'), { target: { value: 'Independent native' } });
    } else {
      await fireEvent.click(view.getByRole('button', { name: 'Configure brand-new-route' }));
    }
    const button = view.getByRole('button', {
      name: `Discover capabilities for ${kind === 'native' ? 'native target 1' : 'brand-new-route'}`,
    });
    await waitFor(() => expect(button).toBeEnabled());
    await fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    return view.getByRole('region', { name: checkResultName });
  }

  function visibleCapability(panel: HTMLElement, label: string) {
    const term = within(panel).getByText(label, { selector: 'dt' });
    expect(term).toBeVisible();
    const status = term.nextElementSibling as HTMLElement;
    expect(status).toBeVisible();
    // Neither the label nor its outcome may be hidden in technical evidence.
    for (const disclosure of panel.querySelectorAll('details')) {
      expect(disclosure).not.toContainElement(term);
      expect(disclosure).not.toContainElement(status);
    }
    return status;
  }

  it.each(['dynamic', 'native'] as const)('REQ-ENTERPRISE-041: %s mixed evidence keeps four independent capability outcomes visible with details collapsed', async (kind) => {
    api.discover.mockResolvedValue(discoveryResult(kind));
    const view = setup();
    const panel = await discover(view, kind);
    const details = within(panel).getByText(/(?:check|technical|discovery) details|discovery attempts/i).closest('details')!;
    expect(details.open).toBe(false);
    const tools = visibleCapability(panel, 'Tool calling');
    expect(tools).toHaveTextContent(/verified|passed|supported/i);
    expect(tools).not.toHaveTextContent(/unverified|unsupported|failed|not (?:established|verified|supported)/i);
    const reasoning = visibleCapability(panel, 'Reasoning');
    expect(reasoning).toHaveTextContent(/provider[ -]default|provider[ -]controlled/i);
    expect(reasoning).toHaveTextContent(/(?:not|no|cannot|does not).{0,60}(?:guarantee|prove|off)|off.{0,60}(?:not guaranteed|not verified)/i);
    const streaming = visibleCapability(panel, 'Streaming');
    expect(streaming).toHaveTextContent(/incremental|verified|passed/i);
    expect(streaming).not.toHaveTextContent(/unverified|failed|not (?:observed|established|verified)/i);
    const cache = visibleCapability(panel, 'Input caching');
    expect(cache).toHaveTextContent(/inconclusive|not (?:observed|established|verified)|unverified/i);
    expect(cache).not.toHaveTextContent(/unsupported|not supported/i);
    expect(within(panel).getByText(/Review changes/i)).toBeVisible();
    expect(panel).not.toHaveTextContent(/\b(?:Minimum|Acceptable|Optimal|Not qualified)\b/i);
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    expect(formValues(view.container).groupRouting).toEqual([]);
  });

  it('REQ-ENTERPRISE-035: Gateway HIT remains response reuse rather than verified input caching', async () => {
    api.discover.mockResolvedValue(discoveryResult('dynamic', { ...unobservedCache,
      mappings: unobservedCache.mappings.map((mapping) => ({ ...mapping, cache: 'gateway-response' })) }));
    const view = setup();
    const panel = await discover(view, 'dynamic');
    const cache = visibleCapability(panel, 'Input caching');
    expect(cache).toHaveTextContent(/inconclusive|not (?:observed|established|verified)|unverified/i);
    expect(cache).not.toHaveTextContent(/^(?:verified|supported|passed)$/i);
    const summary = within(panel).getByText(/(?:check|technical|discovery) details|discovery attempts/i);
    await fireEvent.click(summary);
    expect(within(panel).getByText(/Gateway HIT/i)).toBeVisible();
    expect(panel).toHaveTextContent(/whole[- ]response|response reuse|response cach/i);
    expect(formValues(view.container).reasoningConfiguration.routeAssignments['brand-new-route'].verification.capabilities)
      .toMatchObject({ schemaVersion: 2, mappings: [{ cache: 'gateway-response' }] });
  });

  it('REQ-ENTERPRISE-041: legacy grades never appear in the result or expanded attempt history', async () => {
    api.discover.mockResolvedValue({ ...result, attempts: ['Minimum', 'Acceptable', 'Optimal'].map((grade) => ({
      contract: 'synthetic-wire', classification: 'Verified', capabilities: { ...capabilities, grade }, diagnostics: [], httpAttempts: 1,
    })) });
    const view = setup();
    const panel = await discover(view, 'dynamic');
    // textContent deliberately includes collapsed children, not just the title.
    expect(panel).not.toHaveTextContent(/\b(?:Minimum|Acceptable|Optimal)\b/i);
    await fireEvent.click(within(panel).getByText(/(?:check|technical|discovery) details|discovery attempts/i));
    expect(visibleCapability(panel, 'Tool calling')).toHaveTextContent(/verified|passed|supported/i);
    expect(panel).not.toHaveTextContent(/\b(?:Minimum|Acceptable|Optimal)\b/i);
    expect(formValues(view.container).routeChecks['brand-new-route']).toBe('synthetic-check');
  });

  it('REQ-ENTERPRISE-040: a nonassignable mixed result still reports each capability without granting receipt authority', async () => {
    api.discover.mockResolvedValue({ ...discoveryResult('dynamic'), assignable: false, classification: 'Inconclusive',
      capabilities: { ...unobservedCache, mappings: unobservedCache.mappings.map((mapping) => ({ ...mapping,
        replay: false, reasoning: 'accepted-unverified', streaming: 'not-observed' })) },
      explanation: 'Tool-result replay was not established.' });
    const view = setup();
    const panel = await discover(view, 'dynamic');
    expect(visibleCapability(panel, 'Tool calling')).toHaveTextContent(/not (?:established|verified)|inconclusive|failed/i);
    expect(visibleCapability(panel, 'Reasoning')).toHaveTextContent(/unverified|not (?:established|verified)/i);
    expect(visibleCapability(panel, 'Streaming')).toHaveTextContent(/not (?:observed|established|verified)|buffered|unverified/i);
    expect(visibleCapability(panel, 'Input caching')).toHaveTextContent(/inconclusive|not (?:observed|established|verified)|unverified/i);
    const values = formValues(view.container);
    expect(values.routeChecks['brand-new-route']).toBeNull();
    expect(values.reasoningConfiguration.customProfileRevisions).toEqual([]);
    expect(values.reasoningConfiguration.routeAssignments['brand-new-route']?.verification).toBeUndefined();
    expect(values.dynamicRoutes).toEqual([]);
    expect(values.groupRouting).toEqual([]);
  });

  it.each([false, true])('REQ-ENTERPRISE-074: exact generated Native levels and mixed delivery survive adoption/hydration (saved: %s)', async (saved) => {
    const template = getBuiltInProfile('bedrock-anthropic-native-opus-auto')!;
    const levels = ['off', 'minimal', 'low', 'high', 'xhigh', 'max'] as const;
    const native = normalizeCustomProfile({ id: `bedrock-anthropic-native-discovered-${'a'.repeat(24)}`,
      name: 'Discovered native mappings', schemaVersion: 1, revision: 1, enabled: true,
      supportedLevels: [...levels], levels: Object.fromEntries(levels.map((level) => [level, template.levels[level]])),
      removePaths: template.removePaths, aliases: { minimal: 'low' }, offSemantics: template.offSemantics });
    const nativeRef = { id: native.id, revision: native.revision, hash: native.hash };
    const evidence: CapabilitySummary = { schemaVersion: 2, mappings: [
      { levels: ['off'], transport: 'bedrock-eventstream', tools: true, replay: true, reasoning: 'verified-disabled', streaming: 'incremental', cache: 'inconclusive' },
      { levels: ['minimal', 'low'], transport: 'bedrock-eventstream', tools: true, replay: true, reasoning: 'observed-enabled', streaming: 'incremental', cache: 'inconclusive' },
      { levels: ['high'], transport: 'bedrock-eventstream', tools: true, replay: true, reasoning: 'observed-enabled', streaming: 'incremental', cache: 'provider-prefix' },
      { levels: ['xhigh'], transport: 'bedrock-invoke', tools: true, replay: true, reasoning: 'accepted-unverified', streaming: 'not-observed', cache: 'not-tested' },
      { levels: ['max'], transport: 'bedrock-invoke', tools: true, replay: true, reasoning: 'observed-enabled', streaming: 'not-observed', cache: 'inconclusive' },
    ] };
    const verification = { method: 'automated', checkedAt: proof.checkedAt, current: true, discovery: evidence };
    const target = { id: targetId, label: 'Independent native', model, provider: 'aws-bedrock', contextWindow: 200000,
      transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1', enabled: true, profileRef: nativeRef };
    const policy = { routes: [`cf-native-${targetId}`], defaultRoute: `cf-native-${targetId}`, reasoning: 'off' };
    api.discover.mockResolvedValue({ ...result, capabilities: evidence, profile: native, routeVerification: undefined, targetId,
      nativeVerification: verification });
    const view = setup(saved ? { nativeTargets: [{ ...target, verification }],
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [native], routeAssignments: {} },
      groupRouting: [{ accessGroup: 'engineering', ...policy }], fallbackRouting: { enabled: true, ...policy } } : {});
    let panel: HTMLElement;
    if (saved) {
      await view.findByText('Connected · 1 routes readable');
      await fireEvent.click(view.getByRole('button', { name: 'Native routes' }));
      await fireEvent.click(view.getByRole('button', { name: /Configure Native Route/i }));
      panel = view.getByRole('region', { name: checkResultName });
    } else panel = await discover(view, 'native');
    const streaming = visibleCapability(panel, 'Streaming');
    expect(within(streaming).getByText('High · Bedrock Eventstream').closest('li')).toHaveTextContent('Incremental public deltas observed');
    for (const level of ['Xhigh', 'Max']) {
      const row = within(streaming).getByText(`${level} · Bedrock Invoke`).closest('li')!;
      expect(row).toHaveTextContent('Incremental delivery not observed');
      expect(row).not.toHaveTextContent('deltas observed before completion');
    }
    const reasoning = visibleCapability(panel, 'Reasoning');
    expect(within(reasoning).getByText('Off verified disabled')).toBeVisible();
    expect(within(reasoning).getByText(/Minimal → Low \(alias\)/)).toBeVisible();
    const cache = visibleCapability(panel, 'Input caching');
    expect(within(cache).getByText('High · Bedrock Eventstream').closest('li')).toHaveTextContent('Provider-prefix read verified');
    expect(within(cache).getByText('Max · Bedrock Invoke').closest('li')).toHaveTextContent('Not observed');
    expect(formValues(view.container).nativeTargets).toEqual([target]);
    expect(formValues(view.container).reasoningConfiguration.customProfileRevisions).toEqual([native]);
    for (const field of ['verification', 'discoveryResult', 'checkResult', 'busy', 'verificationRequest']) {
      expect(formValues(view.container).nativeTargets[0]).not.toHaveProperty(field);
    }
    const row = within(view.getByRole('article', { name: 'Independent native native target' }));
    await fireEvent.click(row.getByText(advancedName));
    expect(row.getByRole('button', { name: 'Verify Profile' })).toBeEnabled();
    expect(row.queryByRole('button', { name: 'Mark as verified' })).toBeNull();
    expect(row.getByLabelText('Native target 1 profile')).toHaveValue(`${native.id}\u001f${native.revision}\u001f${native.hash}`);
    await fireEvent.click(view.getByRole('button', { name: 'Access & fallback' }));
    if (!saved) await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    const selector = view.getByLabelText('engineering default reasoning') as HTMLSelectElement;
    expect(Array.from(selector.options, (option) => option.value)).toEqual([...levels]);
    expect(selector).toBeEnabled();
    if (saved) {
      expect(selector).toHaveValue('off');
      expect(view.getByLabelText('Fallback default reasoning')).toHaveValue('off');
      expect(api.discover).not.toHaveBeenCalled();
    } else {
      await fireEvent.change(selector, { target: { value: 'off' } });
      expect(api.discover).toHaveBeenCalledTimes(1);
      expect(formValues(view.container).nativeChecks[targetId]).toBe('synthetic-check');
    }
    expect(formValues(view.container).groupRouting).toEqual([{ accessGroup: 'engineering', ...policy }]);
    expect(formValues(view.container).dynamicRoutes).toEqual([]);
    await fireEvent.click(view.getByRole('button', { name: 'Dynamic routes' }));
    await fireEvent.click(view.getByRole('button', { name: 'Configure brand-new-route' }));
    expect(Array.from((view.getByLabelText('brand-new-route Pi compatibility profile') as HTMLSelectElement).options, (option) => option.value))
      .not.toContain(`${native.id}\u001f${native.revision}\u001f${native.hash}`);
    expect(api.checkNative).not.toHaveBeenCalled();
    expect(api.verify).not.toHaveBeenCalled();
  });

  it.each(['dynamic', 'native'] as const)('REQ-ENTERPRISE-045: %s receipt permits an Off default preference and access without inventing cache or saving', async (kind) => {
    const response = discoveryResult(kind);
    api.discover.mockResolvedValue(response);
    const view = setup();
    const submit = vi.fn((event: Event) => event.preventDefault());
    view.container.querySelector('form')!.addEventListener('submit', submit);
    const panel = await discover(view, kind);
    const before = formValues(view.container);
    expect(before.dynamicRoutes).toEqual([]);
    expect(before.groupRouting).toEqual([]);
    const handle = kind === 'dynamic' ? 'brand-new-route' : `cf-native-${targetId}`;
    if (kind === 'dynamic') expect(before.routeChecks[handle]).toBe('synthetic-check');
    else expect(before.nativeChecks[targetId]).toBe('synthetic-check');

    await fireEvent.click(view.getByRole('button', { name: 'Access & fallback' }));
    await fireEvent.change(view.getByLabelText('Unconfigured access group'), { target: { value: 'engineering' } });
    await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    const policy = view.getByRole('button', { name: 'engineering policy' });
    if (policy.getAttribute('aria-expanded') !== 'true') await fireEvent.click(policy);
    const label = kind === 'dynamic' ? 'Dynamic Route - brand-new-route' : `Native Route - AWS Bedrock - ${model}`;
    const allowed = view.getByRole('checkbox', { name: `engineering ${label} route` });
    expect(allowed).toBeEnabled();
    // Adding a group selects its sole eligible route; discovery alone did not.
    expect(allowed).toBeChecked();
    await fireEvent.change(view.getByLabelText('engineering default route'), { target: { value: handle } });
    const reasoning = view.getByLabelText('engineering default reasoning');
    expect(reasoning).toBeEnabled();
    expect(within(reasoning).getByRole('option', { name: /^Off\b/i })).toHaveValue('off');
    await fireEvent.change(reasoning, { target: { value: 'off' } });
    expect(reasoning).toHaveValue('off');
    const helpers = (reasoning.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)!);
    for (const helper of helpers) expect(helper).toBeVisible();
    const caveat = helpers.map((helper) => helper.textContent).join(' ');
    expect(caveat).toMatch(/provider[ -](?:controlled|default)|provider controls/i);
    expect(caveat).toMatch(/(?:not|no|cannot|doesn't|isn't).{0,60}(?:guarantee|guaranteed|prove|proven|verified|off)|off.{0,60}(?:not guaranteed|not verified)/i);
    const values = formValues(view.container);
    expect(values.groupRouting).toEqual([{ accessGroup: 'engineering', routes: [handle], defaultRoute: handle, reasoning: 'off' }]);
    expect(values.fallbackRouting).toEqual({ enabled: false });
    if (kind === 'dynamic') {
      expect(values.dynamicRoutes).toEqual([handle]);
      expect(values.routeChecks[handle]).toBe('synthetic-check');
      expect(values.reasoningConfiguration.routeAssignments[handle]).toMatchObject({ activeProfile: ref,
        verification: { ...proof, capabilities: unobservedCache } });
      expect(values.reasoningConfiguration.customProfileRevisions).toEqual([profile]);
    } else {
      expect(values.dynamicRoutes).toEqual([]);
      expect(values.nativeChecks[targetId]).toBe('synthetic-check');
      expect(values.nativeTargets).toEqual([{ id: targetId, provider: 'aws-bedrock', label: 'Independent native', model,
        transport: 'aig-bedrock-anthropic-auto', region: 'eu-central-1', contextWindow: 200000, enabled: true,
        profileRef: { id: response.profile.id, revision: response.profile.revision, hash: response.profile.hash } }]);
    }
    expect(panel).not.toHaveTextContent(/\b(?:Minimum|Acceptable|Optimal)\b/i);
    expect(api.discover).toHaveBeenCalledWith(kind === 'dynamic'
      ? { kind: 'dynamic-route', route: 'brand-new-route' }
      : { kind: 'native-provider', target: expect.objectContaining({ model, enabled: false }) });
    expect(api.verify).not.toHaveBeenCalled();
    expect(api.checkNative).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
