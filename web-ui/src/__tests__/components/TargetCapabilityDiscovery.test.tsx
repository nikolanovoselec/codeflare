import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import { normalizeCustomProfile, getBuiltInProfile, BUILT_IN_REASONING_PROFILES } from '../../../../src/lib/reasoning-profiles';

const api = vi.hoisted(() => ({ discover: vi.fn(), inventory: vi.fn(), catalog: vi.fn(), checkNative: vi.fn() }));
vi.mock('../../api/client', () => ({ discoverTargetCapabilities: (...args: unknown[]) => api.discover(...args),
  checkNativeTarget: (...args: unknown[]) => api.checkNative(...args),
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
function setup(overrides: Record<string, unknown> = {}) {
  api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: BUILT_IN_REASONING_PROFILES, notices: [], usage: [],
    routes: ['brand-new-route'], routeCatalogStatus: 'ready', providers: [{ provider: 'aws-bedrock', label: 'Amazon Bedrock', supported: true, configured: true, defaultSelection: true }], providerCatalogStatus: 'ready' });
  api.inventory.mockResolvedValue({ route: 'brand-new-route', routeVersion: 'v1', inventoryDigest: 'a'.repeat(64),
    legs: [{ nodeId: 'future', provider: 'future-provider', declaredModel: 'synthetic-future-2099' }] });
  const current = { gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', dynamicRoutes: [],
    routeContextWindows: {}, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, availableAccessGroups: ['engineering'], ...overrides };
  return render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
}
describe('REQ-ENTERPRISE-074 select target → Discover → review/Save', () => {
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
    await fireEvent.click(row.getByText('Advanced profile selection'));
    const select = row.getByLabelText('Native target 1 profile') as HTMLSelectElement;
    expect(select).toBeVisible();
    expect(Array.from(select.options, (option) => option.value)).toContain(explicitKey);
    expect(values().nativeTargets[0]).toMatchObject(target);
    await fireEvent.click(row.getByText('Advanced profile selection'));

    await fireEvent.click(row.getByRole('button', { name: 'Discover capabilities for native target 1' }));
    await waitFor(() => expect(values().nativeChecks[target.id]).toBe('synthetic-check'));
    expect(values().nativeTargets[0]).toMatchObject({ ...target, profileRef: nativeRef });
    expect(api.discover).toHaveBeenCalledWith({ kind: 'native-provider', target: { ...target, enabled: false } });
    expect(configure).toHaveTextContent('Ready');

    await fireEvent.click(row.getByText('Advanced profile selection'));
    expect(select).toBeVisible();
    expect(select).toBeEnabled();
    expect(Array.from(select.options, (option) => option.value)).toContain(explicitKey);
    await fireEvent.change(select, { target: { value: explicitKey } });
    expect(select).toHaveValue(explicitKey);
    expect(values().nativeTargets[0]).toMatchObject({ ...target, enabled: false });
    expect(values().nativeChecks[target.id]).toBeNull();
    expect(configure).toHaveTextContent('Not ready');
    expect(api.checkNative).not.toHaveBeenCalled();

    await fireEvent.click(row.getByText('Advanced profile verification'));
    await fireEvent.click(row.getByRole('button', { name: 'Mark as verified' }));
    await waitFor(() => expect(values().nativeChecks[target.id]).toBe('fresh-explicit-check'));
    expect(api.checkNative).toHaveBeenCalledTimes(1);
    expect(api.checkNative).toHaveBeenCalledWith({ target: { ...target, enabled: false }, administratorConfirmed: true });
    expect(values().nativeTargets[0]).toMatchObject(target);
    expect(configure).toHaveTextContent('Ready');
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
