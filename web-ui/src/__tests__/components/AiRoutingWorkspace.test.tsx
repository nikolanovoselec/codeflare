import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import type { ReasoningRouteVerification } from '../../types';

const api = vi.hoisted(() => ({ catalog: vi.fn(), inventory: vi.fn(), discover: vi.fn() }));
vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args),
  getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.discover(...args),
}));
const ref = { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: 'a'.repeat(64) };
const offRef = { id: 'openai-gpt-chat-tools-off', revision: 1, hash: 'b'.repeat(64) };
const proof = (route = 'general_usage', scope: 'single-model' | 'observed-path' = 'single-model'): ReasoningRouteVerification => ({
  schemaVersion: 1, profileRef: ref, routeVersion: `${route}-v1`, inventoryDigest: `${route}-digest`, connectionFingerprint: 'connection-digest', canaryVersion: 'canary', supportedLevels: ['medium', 'high'], scope, checkedAt: '2026-09-06T12:00:00Z',
});
const inventory = (route: string, verified = route === 'general_usage') => ({
  route, routeVersion: `${route}-v1`, inventoryDigest: `${route}-digest`,
  legs: [{ nodeId: `${route}-model`, provider: 'workers-ai', declaredModel: `@cf/${route}` }],
  ...(verified && { verification: proof(route) }),
});
const catalog = () => ({ schemaVersion: 1, profiles: [
  { ...ref, name: 'Kimi thinking', supportedLevels: ['medium', 'high'], enabled: true },
  { ...offRef, name: 'GPT off', supportedLevels: ['off'], enabled: true },
], notices: [], usage: [], routes: ['general_usage', 'development', 'unconfigured'], routeCatalogStatus: 'ready', connection: { status: 'ready', message: 'Routes can be read.' } });
const current = () => ({
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', tokenState: 'administration',
  dynamicRoutes: ['general_usage', 'development'], routeContextWindows: { general_usage: 256000, development: 128000 },
  defaultRoute: { route: 'general_usage', reasoning: 'medium' },
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {
    general_usage: { activeProfile: ref, verification: proof() }, development: { activeProfile: ref },
  }, fallbackRouting: { enabled: false } },
  availableAccessGroups: ['developers', 'support'],
  groupRouting: [{ accessGroup: 'developers', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'medium' }],
});
const values = (container: HTMLElement) => environmentValues('aiRouting', 'enterprise', new FormData(container.querySelector('form')!)) as Record<string, any>;
const mount = (data: unknown = current(), onReadyChange = vi.fn()) => ({ ...render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={data} onReadyChange={onReadyChange} /></form>), onReadyChange });
async function ready(view: ReturnType<typeof mount>) { await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true)); }
async function section(view: ReturnType<typeof mount>, name: string) { await fireEvent.click(within(view.getByRole('navigation', { name: 'AI Gateway configuration sections' })).getByRole('button', { name })); }
async function openRoute(view: ReturnType<typeof mount>, route: string) { await section(view, 'Routes'); await fireEvent.click(view.getByRole('button', { name: `Configure ${route}` })); }

beforeEach(() => {
  api.catalog.mockReset().mockResolvedValue(catalog());
  api.inventory.mockReset().mockImplementation(async (route: string) => inventory(route));
  api.discover.mockReset().mockResolvedValue({ route: 'development', classification: 'Verified', assignable: true, compatibleLevels: ['medium', 'high'], diagnostics: [], evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions', status: 'Verified' }, checkId: 'development-check', verification: proof('development') });
});
afterEach(cleanup);

describe('Administrator route workspace', () => {
  it('REQ-ENTERPRISE-041: mapping failure unlocks profile selection and keeps progress local', async () => {
    let finish!: (value: unknown) => void;
    api.discover.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount();
    await ready(view);
    await openRoute(view, 'development');
    await fireEvent.click(view.getByRole('button', { name: 'Discover Profile for development' }));
    expect(await view.findByRole('status')).toHaveTextContent('Discovering profiles for development…');
    expect(view.getAllByRole('status')).toHaveLength(1);
    expect(view.getByRole('status').closest('.admin-state-panel')).toBeNull();
    expect(view.getByRole('combobox', { name: 'development Pi compatibility profile' })).toBeDisabled();
    expect(view.queryByText('Wait for the current profile check to finish.')).toBeNull();
    finish({ outcome: 'inconclusive', classification: 'Inconclusive', assignable: false, diagnostics: [{ code: 'request_rejected', stage: 'reasoning', status: 429, levels: ['high'] }] });
    await waitFor(() => expect(view.getByRole('combobox', { name: 'development Pi compatibility profile' })).toBeEnabled());
    await fireEvent.change(view.getByRole('combobox', { name: 'development Pi compatibility profile' }), { target: { value: `${offRef.id}\u001f${offRef.revision}\u001f${offRef.hash}` } });
    expect(view.queryByRole('heading', { name: 'Discover compatibility for development' })).toBeNull();
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
  });

  it('REQ-ENTERPRISE-041: verification progress is visible beside the route without a bottom duplicate', async () => {
    let finish!: (value: unknown) => void;
    api.discover.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount();
    await ready(view);
    await openRoute(view, 'development');
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    expect(await view.findByText('Verifying profile for development…')).toBeVisible();
    expect(view.queryByText('Wait for the current profile check to finish.')).toBeNull();
    finish({ classification: 'Inconclusive', assignable: false, diagnostics: [] });
    await waitFor(() => expect(view.queryByText('Verifying profile for development…')).toBeNull());
  });
  it.each(['initial', 'refresh'] as const)('REQ-ENTERPRISE-044: selected policy inventory pending during %s blocks Save without dropping routes', async (phase) => {
    const data = current();
    data.reasoningConfiguration.routeAssignments.development = { activeProfile: ref, verification: proof('development') } as typeof data.reasoningConfiguration.routeAssignments.general_usage;
    data.groupRouting[0].routes.push('development');
    let release!: (value: ReturnType<typeof inventory>) => void;
    let pending = phase === 'initial';
    api.inventory.mockImplementation((route: string) => route === 'development' && pending
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(inventory(route, true)));
    const view = mount(data);
    if (phase === 'refresh') {
      await ready(view);
      pending = true;
      await openRoute(view, 'development');
      await fireEvent.click(view.getByRole('button', { name: 'Refresh development models' }));
    }
    await waitFor(() => expect(release).toBeDefined());
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    release(inventory('development', true));
    await ready(view);
    expect(values(view.container).groupRouting[0].routes).toEqual(['general_usage', 'development']);
    expect(api.discover).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-044: failed selected inventory settles inactive without blocking a working route', async () => {
    const data = current(); data.groupRouting[0].routes.push('development');
    api.inventory.mockImplementation(async (route: string) => {
      if (route === 'development') throw new Error('unavailable');
      return inventory(route);
    });
    const view = mount(data); await ready(view);
    expect(values(view.container).groupRouting[0].routes).toEqual(['general_usage']);
  });
  it('REQ-ENTERPRISE-041: starts with a compact route overview and expands only the selected route', async () => {
    const view = mount(); await ready(view);
    expect(view.getByRole('button', { name: 'Configure general_usage' })).toHaveAttribute('aria-expanded', 'false');
    expect(view.queryByRole('button', { name: 'Discover Profile for general_usage' })).toBeNull();
    await openRoute(view, 'general_usage');
    expect(view.getByRole('button', { name: 'Configure general_usage' })).toHaveAttribute('aria-expanded', 'true');
    expect(view.getByRole('button', { name: 'Discover Profile for general_usage' })).toBeVisible();
    expect(view.getByText('@cf/general_usage')).toBeVisible();
    expect(view.queryByRole('button', { name: 'Discover Profile for development' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Configure development' }));
    expect(view.queryByRole('button', { name: 'Discover Profile for general_usage' })).toBeNull();
    expect(view.getByRole('button', { name: 'Discover Profile for development' })).toBeVisible();
    expect(api.discover).not.toHaveBeenCalled();
  });
  it('REQ-ENTERPRISE-041: switching route details preserves unsaved values', async () => {
    const view = mount(); await ready(view); await openRoute(view, 'general_usage');
    await fireEvent.input(view.getByLabelText('general_usage context window'), { target: { value: '192000' } });
    await fireEvent.click(view.getByRole('button', { name: 'Configure development' }));
    await fireEvent.click(view.getByRole('button', { name: 'Configure general_usage' }));
    expect(view.getByLabelText('general_usage context window')).toHaveValue('192000');
    expect(values(view.container).routeContextWindows.general_usage).toBe(192000);
  });
  it('REQ-ENTERPRISE-041: section navigation retains configuration state', async () => {
    const view = mount(); await ready(view); await openRoute(view, 'general_usage');
    await fireEvent.input(view.getByLabelText('general_usage context window'), { target: { value: '200000' } });
    await section(view, 'Access & fallback');
    expect(view.getByRole('heading', { name: 'Group access' })).toBeVisible();
    expect(view.queryByRole('button', { name: 'Discover Profile for general_usage' })).toBeNull();
    await section(view, 'Routes');
    expect(view.getByLabelText('general_usage context window')).toHaveValue('200000');
    expect(api.discover).not.toHaveBeenCalled();
  });
  it('REQ-ENTERPRISE-045: explains Pi compatibility and shows provider-aware profile choices', async () => {
    const view = mount(); await ready(view); await openRoute(view, 'general_usage');
    const select = view.getByLabelText('general_usage Pi compatibility profile');
    expect(within(select).getByRole('option', { name: 'Workers AI · Kimi' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'OpenAI · GPT — reasoning off' })).toBeInTheDocument();
    expect(view.getByText(/translates Pi.*tool calling and reasoning/i)).toBeVisible();
    expect(within(view.getByRole('article', { name: 'general_usage route' })).getByText('Tested with Kimi through Workers AI.')).toBeVisible();
    expect(values(view.container).reasoningConfiguration.routeAssignments.general_usage.activeProfile).toEqual(ref);
  });
  it('REQ-ENTERPRISE-042: distinguishes unreadable routes from a merely stored token', async () => {
    api.catalog.mockResolvedValueOnce({ ...catalog(), routes: [], routeCatalogStatus: 'unavailable', connection: { status: 'permission-denied', message: 'Access denied. Check the token and AI Gateway Read permission.' } });
    const view = mount();
    expect(await view.findByText(/Access denied.*AI Gateway Read/)).toBeVisible();
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    await section(view, 'Connection');
    expect(view.getByLabelText('Replacement API token')).toHaveValue('');
    expect(view.getByRole('button', { name: 'Check connection' })).toBeEnabled();
    expect(api.discover).not.toHaveBeenCalled();
  });
  it('REQ-ENTERPRISE-042: checking changed credentials does not save or run model probes', async () => {
    const view = mount(); await ready(view); await section(view, 'Connection');
    await fireEvent.input(view.getByLabelText('Replacement API token'), { target: { value: 'new-test-token' } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    await fireEvent.click(view.getByRole('button', { name: 'Check connection' }));
    await waitFor(() => expect(api.catalog).toHaveBeenLastCalledWith({ gatewayUrl: current().gatewayUrl, replacementToken: 'new-test-token' }));
    expect(api.discover).not.toHaveBeenCalled();
    expect(values(view.container).replacementToken).toBe('new-test-token');
  });
  it('REQ-ENTERPRISE-043: excludes unverified routes from policy assignment and serialized activation', async () => {
    const view = mount(); await ready(view); await section(view, 'Access & fallback');
    const group = view.getByRole('group', { name: 'developers allowed routes' });
    expect(within(group).getByRole('checkbox', { name: 'developers general_usage route' })).toBeChecked();
    expect(within(group).queryByRole('checkbox', { name: 'developers development route' })).toBeNull();
    expect(values(view.container).dynamicRoutes).toEqual(['general_usage']);
    expect(values(view.container).reasoningConfiguration.routeAssignments.development.activeProfile).toEqual(ref);
  });
  it('REQ-ENTERPRISE-043: a successful observed-path check enables assignment with an untested-backup warning', async () => {
    api.inventory.mockImplementation(async (route: string) => route === 'development' ? { ...inventory(route, false), legs: [...inventory(route, false).legs, { nodeId: 'backup', provider: 'openai', declaredModel: 'backup-model' }] } : inventory(route));
    api.discover.mockResolvedValueOnce({ classification: 'Verified', assignable: true, compatibleLevels: ['medium', 'high'], diagnostics: [], evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions', status: 'Verified' }, checkId: 'observed-check', verification: proof('development', 'observed-path') });
    const view = mount(); await ready(view); await openRoute(view, 'development');
    const verify = view.getByRole('button', { name: 'Verify Profile for development' });
    await waitFor(() => expect(verify).toBeEnabled()); await fireEvent.click(verify);
    expect(await view.findByText(/Other backends remain untested/)).toBeVisible();
    await section(view, 'Access & fallback');
    await fireEvent.click(view.getByRole('checkbox', { name: 'developers development route' }));
    expect(values(view.container).groupRouting[0].routes).toEqual(['general_usage', 'development']);
    expect(values(view.container).routeChecks.development).toBe('observed-check');
  });
  it('REQ-ENTERPRISE-042: custom backend provenance is editable before Verify without requiring Save', async () => {
    api.inventory.mockImplementation(async (route: string) => route === 'development' ? { ...inventory(route, false), legs: [{ nodeId: 'custom-node', provider: 'custom-mesh', declaredModel: 'mesh' }] } : inventory(route));
    const view = mount(); await ready(view); await openRoute(view, 'development');
    const verify = view.getByRole('button', { name: 'Verify Profile for development' });
    expect(verify).toBeDisabled();
    const description = await view.findByLabelText('custom-node custom provider backend');
    expect(description).toBeVisible();
    await fireEvent.input(description, { target: { value: 'Qwen primary' } });
    await waitFor(() => expect(verify).toBeEnabled());
    await fireEvent.click(verify);
    await waitFor(() => expect(api.discover).toHaveBeenCalledWith(expect.objectContaining({ backendDescriptions: { 'custom-node': 'Qwen primary' } })));
  });
  it('REQ-ENTERPRISE-043: changing a profile removes eligibility even when changing back', async () => {
    const view = mount(); await ready(view); await openRoute(view, 'general_usage');
    const select = view.getByLabelText('general_usage Pi compatibility profile');
    const key = (id: typeof ref) => `${id.id}\u001f${id.revision}\u001f${id.hash}`;
    await fireEvent.change(select, { target: { value: key(offRef) } });
    await fireEvent.change(select, { target: { value: key(ref) } });
    expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
    expect(values(view.container).groupRouting).toEqual([{ accessGroup: 'developers', routes: [], defaultRoute: '', reasoning: 'off' }]);
    expect(values(view.container).routeChecks.general_usage).toBeNull();
  });
  it('REQ-ENTERPRISE-044: inactive deny policies and valid draft context windows survive Save serialization', async () => {
    const data = current();
    data.groupRouting = [
      { accessGroup: 'developers', routes: ['development'], defaultRoute: 'development', reasoning: 'medium' },
      { accessGroup: 'support', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'medium' },
    ];
    const view = mount(data); await ready(view);
    expect(values(view.container).groupRouting).toEqual([
      { accessGroup: 'developers', routes: [], defaultRoute: '', reasoning: 'off' },
      { accessGroup: 'support', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'medium' },
    ]);
    expect(values(view.container).routeContextWindows.development).toBe(128000);
    expect(values(view.container).dynamicRoutes).toEqual(['general_usage']);
  });
  it('REQ-ENTERPRISE-044: one working group route permits Save despite incomplete inactive routes', async () => {
    const data = current(); data.routeContextWindows.development = 0;
    const view = mount(data); await ready(view);
    expect(view.container.querySelector('form')!.checkValidity()).toBe(true);
    expect(values(view.container).dynamicRoutes).toEqual(['general_usage']);
    expect(values(view.container).routeContextWindows).toEqual({ general_usage: 256000 });
  });
  it('REQ-ENTERPRISE-044: fallback can be disabled or restricted to explicitly selected checked routes', async () => {
    const view = mount(); await ready(view); await section(view, 'Access & fallback');
    expect(values(view.container).fallbackRouting).toEqual({ enabled: false });
    await fireEvent.click(view.getByRole('checkbox', { name: 'Enable fallback access' }));
    const box = await view.findByRole('checkbox', { name: 'Fallback general_usage route' });
    if (!(box as HTMLInputElement).checked) await fireEvent.click(box);
    expect(values(view.container).fallbackRouting).toEqual({ enabled: true, routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'medium' });
    expect(view.getByText(/manually added users/i)).toBeVisible();
    await fireEvent.click(view.getByRole('checkbox', { name: 'Enable fallback access' }));
    expect(values(view.container).fallbackRouting).toEqual({ enabled: false });
  });
  it.each([
    [['medium', 'high'], 'medium'], [['off'], 'off'], [['high'], 'high'],
  ] as const)('REQ-ENTERPRISE-044: a single eligible route defaults to a supported preference %s', async (levels, expected) => {
    const list = catalog(); list.profiles[0].supportedLevels = [...levels]; api.catalog.mockResolvedValueOnce(list);
    const data = current(); data.groupRouting = []; data.reasoningConfiguration.routeAssignments.general_usage.verification.supportedLevels = [...levels];
    api.inventory.mockImplementation(async (route: string) => ({ ...inventory(route), ...(route === 'general_usage' && { verification: { ...proof(), supportedLevels: [...levels] } }) }));
    const view = mount(data); await waitFor(() => expect(api.inventory).toHaveBeenCalledWith('unconfigured'));
    await section(view, 'Access & fallback'); await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    await waitFor(() => expect(view.onReadyChange).toHaveBeenLastCalledWith(true));
    expect(values(view.container).groupRouting[0]).toEqual({ accessGroup: 'developers', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: expected });
  });
});
