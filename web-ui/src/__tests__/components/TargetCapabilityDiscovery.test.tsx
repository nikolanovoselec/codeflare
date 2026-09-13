import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import { normalizeCustomProfile, getBuiltInProfile } from '../../../../src/lib/reasoning-profiles';

const api = vi.hoisted(() => ({ discover: vi.fn(), inventory: vi.fn(), catalog: vi.fn() }));
vi.mock('../../api/client', () => ({ discoverTargetCapabilities: (...args: unknown[]) => api.discover(...args),
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
function setup() {
  api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: [getBuiltInProfile('bedrock-anthropic-native-provider-default')], notices: [], usage: [],
    routes: ['brand-new-route'], routeCatalogStatus: 'ready', providers: [{ provider: 'aws-bedrock', label: 'Amazon Bedrock', supported: true, configured: true, defaultSelection: true }], providerCatalogStatus: 'ready' });
  api.inventory.mockResolvedValue({ route: 'brand-new-route', routeVersion: 'v1', inventoryDigest: 'a'.repeat(64),
    legs: [{ nodeId: 'future', provider: 'future-provider', declaredModel: 'synthetic-future-2099' }] });
  const current = { gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', dynamicRoutes: [],
    routeContextWindows: {}, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, availableAccessGroups: ['engineering'] };
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
