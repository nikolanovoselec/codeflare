import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import { normalizeCustomProfile, getBuiltInProfile, BUILT_IN_REASONING_PROFILES } from '../../../../src/lib/reasoning-profiles';

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
    expect(await within(panel).findByText(/Optimal/i)).toBeVisible();
    expect(within(panel).getByText(/Review changes/i)).toBeVisible();
    expect(within(panel).getByText(/Confirm Save/i)).toBeVisible();
    expect(within(panel).getByText(/next (?:normal )?session/i)).toBeVisible();
    const detailSummary = within(panel).getByText(/(?:check|technical|discovery) details|discovery attempts/i);
    const details = detailSummary.closest('details')!;
    expect(details.open).toBe(false);
    await fireEvent.click(detailSummary);
    expect(within(panel).getByText(/Gateway HIT/i)).toBeVisible();
    await fireEvent.click(detailSummary);
    expect(within(panel).getByText(/Optimal/i)).toBeVisible();
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
    expect(view.getByText('Optimal')).toBeVisible();
    const row = within(view.getByRole('article', { name: 'Rechecked native native target' }));
    // Reach the existing recheck path before asserting its stale-evidence bug;
    // disclosure consolidation is independently covered above.
    const summary = row.getByText(/Advanced(?:: choose a profile| profile verification)/i);
    await fireEvent.click(summary);
    expect(row.queryByRole('button', { name: /Mark .*verified/i })).toBeNull();
    await fireEvent.click(row.getByRole('button', { name: /^Verify Profile$/i }));

    // A recheck withdraws old authority immediately, not only on its response.
    expect(row.queryByText('Optimal')).toBeNull();
    expect(formValues(view.container).nativeChecks[targetId]).toBeNull();
    expect(formValues(view.container).nativeTargets[0].enabled).toBe(false);
    finish({ targetId, assignable: false, classification: 'Inconclusive',
      cacheEvidence: { explanation: 'Cache reuse was not observed. Retry the check before enabling this target.' } });
    await waitFor(() => expect(row.getByRole('button', { name: /^Verify Profile$/i })).toBeEnabled());
    await fireEvent.click(summary);

    const panel = row.getByRole('region', { name: checkResultName });
    expect(row.getAllByRole('region', { name: checkResultName })).toHaveLength(1);
    expect(summary.closest('details')).not.toContainElement(panel);
    expect(within(panel).getByText(/cache reuse was not observed/i)).toBeVisible();
    expect(row.queryByText('Optimal')).toBeNull();
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
    expect(await view.findByText('Optimal')).toBeVisible();
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

  it('shows a precise minimum failure without creating or authorizing a profile', async () => {
    api.discover.mockResolvedValue({ ...result, assignable: false, profile: undefined, checkId: undefined, routeVerification: undefined,
      classification: 'Inconclusive', explanation: 'Tools worked, but no cache reuse was observed; caching is inconclusive.' });
    const view = setup();
    await fireEvent.click(await view.findByRole('button', { name: 'Configure brand-new-route' }));
    const discover = await view.findByRole('button', { name: 'Discover capabilities for brand-new-route' });
    await waitFor(() => expect(discover).toBeEnabled()); await fireEvent.click(discover);
    expect(await view.findByText(/Tools worked, but no cache reuse/)).toBeVisible();
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
    expect(await view.findByText('Optimal')).toBeVisible();
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
