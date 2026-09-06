import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  inventory: vi.fn(),
  discover: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args),
  getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.discover(...args),
}));

const hash = (value: string) => value.repeat(64);
const catalog = {
  schemaVersion: 1 as const,
  profiles: [
    { id: 'openai-gpt-chat-tools-reasoning', revision: 1, hash: hash('1'), name: 'OpenAI GPT reasoning', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'openai-gpt-chat-tools-off', revision: 1, hash: hash('2'), name: 'OpenAI GPT off only', supportedLevels: ['off'], classification: 'Verified' },
    { id: 'workers-ai-gemma-thinking', revision: 1, hash: hash('3'), name: 'Gemma thinking', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
    { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: hash('b'), name: 'Kimi thinking', supportedLevels: ['medium', 'high'], classification: 'Verified' },
    { id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a'), name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'], classification: 'Verified' },
    { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: hash('6'), name: 'Mesh binary thinking', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], classification: 'Verified' },
  ],
  notices: [{ id: 'gpt-oss-tool-replay', name: 'GPT-OSS tool replay', assignable: false, summary: 'Tool-result replay is unsupported.' }],
  usage: [],
  routes: ['general_usage', 'development', 'research'],
  routeCatalogStatus: 'ready' as const,
};

const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  dynamicRoutes: ['general_usage', 'development'],
  defaultRoute: { route: 'general_usage', reasoning: 'off' },
  routeContextWindows: { general_usage: 262144, development: 131072 },
  reasoningConfiguration: {
    schemaVersion: 1,
    customProfileRevisions: [],
    routeAssignments: {
      general_usage: { activeProfile: { id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a') } },
      development: { activeProfile: { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: hash('b') } },
    },
  },
  availableAccessGroups: ['developers', 'support', 'research-team'],
  groupRouting: [
    { accessGroup: 'developers', routes: ['general_usage', 'development'], defaultRoute: 'development', reasoning: 'medium' },
    { accessGroup: 'support', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'off' },
  ],
};

const routeInventory = (route: string) => ({
  route,
  routeVersion: `${route}-v2`,
  legs: [
    { nodeId: `${route}-primary`, provider: 'custom-enterprise', declaredModel: `${route}-alias` },
    { nodeId: `${route}-fallback`, provider: 'workers-ai', declaredModel: `@cf/${route}-fallback` },
  ],
  commonLevels: [],
  warnings: ['missing_leg_evidence'],
});
const singleInventory = (route: string) => ({
  ...routeInventory(route),
  legs: [{ nodeId: `${route}-only`, provider: 'workers-ai', declaredModel: `@cf/${route}-model` }],
});
const verifiedReport = () => ({
  route: 'development', classification: 'Verified', assignable: true,
  requestedCompletionCeiling: 4096, compatibleLevels: ['medium', 'high'],
  piCompatibility: { status: 'verified', verifiedLevels: ['medium', 'high'], failedLevels: [] },
  reasoningConfiguration: { off: 'unsupported-by-profile', routeHealthVerified: true },
  diagnostics: [], stopDiscovery: false,
  accounting: { logicalProbes: 2, httpAttempts: 3 },
  evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions', status: 'Verified' },
});
const savedDevelopmentAssignment = () => ({
  activeProfile: current.reasoningConfiguration.routeAssignments.development.activeProfile,
  routeVersion: 'development-v2',
  legs: [{
    ...singleInventory('development').legs[0],
    profileRef: current.reasoningConfiguration.routeAssignments.development.activeProfile,
    evidence: verifiedReport().evidence,
  }],
});
const draftConfiguration = (container: HTMLElement) => JSON.parse((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
const formValues = (container: HTMLElement) => environmentValues('aiRouting', 'enterprise', new FormData(container.querySelector('form')!)) as Record<string, any>;
const profileKey = (id: string, digit: string) => `${id}\u001f1\u001f${hash(digit)}`;
async function ready(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.getByLabelText('development reasoning profile')).toBeEnabled());
}
function describedText(element: HTMLElement) {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => {
    const helper = document.getElementById(id);
    expect(helper).toBeVisible();
    return helper?.textContent ?? '';
  }).join(' ');
}

beforeEach(() => {
  api.catalog.mockReset().mockResolvedValue(catalog);
  // Every GET, including verification's before/after reads, receives its own route.
  api.inventory.mockReset().mockImplementation(async (route: string) => routeInventory(route));
  api.discover.mockReset().mockResolvedValue({ classification: 'Compatible, unverified', warnings: ['custom_provider_backend_requires_revalidation'], accounting: { logicalProbes: 2, httpAttempts: 3 } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-031 structured AI routing', () => {
  it('preserves many-to-many group routes with one scope default route and reasoning', async () => {
    const { getByLabelText, getByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    expect(getByLabelText('developers allowed routes')).toBeTruthy();
    expect((getByLabelText('developers default route') as HTMLSelectElement).value).toBe('development');
    expect((getByLabelText('developers default reasoning') as HTMLSelectElement).value).toBe('medium');
    expect(getByLabelText('support allowed routes')).toBeTruthy();
    await fireEvent.change(getByLabelText('Unconfigured access group'), { target: { value: 'research-team' } });
    await fireEvent.click(getByRole('button', { name: 'Add group policy' }));
    expect(getByLabelText('research-team allowed routes')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Remove research-team policy' }));
    expect(() => getByLabelText('research-team allowed routes')).toThrow();
  });

  it('preserves selected revisions and medium defaults when the catalog hydrates', async () => {
    let hydrate!: (value: typeof catalog) => void;
    api.catalog.mockReturnValueOnce(new Promise<typeof catalog>((resolve) => { hydrate = resolve; }));
    const saved = { ...current, defaultRoute: { route: 'general_usage', reasoning: 'medium' } };
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} /></form>);
    expect(view.getByLabelText('general_usage reasoning profile')).toBeDisabled();
    hydrate(catalog);
    await waitFor(() => expect(view.getByLabelText('general_usage reasoning profile')).toHaveValue(`workers-ai-glm-thinking\u001f1\u001f${hash('a')}`));
    expect(view.getByLabelText('development reasoning profile')).toHaveValue(`workers-ai-kimi-k-thinking\u001f1\u001f${hash('b')}`);
    expect(view.getByLabelText('Global default reasoning')).toHaveValue('medium');
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('medium');
    const values = environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!)) as Record<string, any>;
    expect(values.defaultRoute).toEqual(saved.defaultRoute);
    expect(values.reasoningConfiguration).toEqual(current.reasoningConfiguration);
    expect(values.groupRouting).toEqual(current.groupRouting);
  });

  it.each(['0', '1.5'])('does not block form Save for unconfigured context %s but rejects it after assignment', async (invalid) => {
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await waitFor(() => expect((view.getByLabelText('research reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const form = view.container.querySelector('form')!;
    const context = view.getByLabelText('research context window') as HTMLInputElement;
    expect(context).toBeEnabled();
    await fireEvent.input(context, { target: { value: invalid } });
    expect(context.value).toBe(invalid);
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).getAll('routeContextRoute')).not.toContain('research');
    await fireEvent.change(view.getByLabelText('research reasoning profile'), { target: { value: `workers-ai-glm-thinking\u001f1\u001f${hash('a')}` } });
    expect(view.getByLabelText('research context window')).toBe(context);
    expect(context.value).toBe(invalid);
    expect(form.checkValidity()).toBe(false);
    await fireEvent.input(context, { target: { value: '' } });
    expect(form.checkValidity()).toBe(false);
    await fireEvent.input(context, { target: { value: '65536' } });
    expect(form.checkValidity()).toBe(true);
    expect(new FormData(form).getAll('routeContextRoute')).toContain('research');
  });

  it('REQ-ENTERPRISE-034: loads every detected inventory read-only and exposes models outside route disclosures', async () => {
    let hydrate!: (value: typeof catalog) => void;
    api.catalog.mockReturnValueOnce(new Promise<typeof catalog>((resolve) => { hydrate = resolve; }));
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    expect(api.inventory).not.toHaveBeenCalled();
    hydrate(catalog);
    for (const route of catalog.routes) {
      const card = view.getByRole('heading', { name: route }).closest('article')!;
      const model = await within(card).findByText(`${route}-alias`);
      expect(model).toBeVisible();
      expect(model.closest('details')).toBeNull();
      expect(within(card).getByText(`@cf/${route}-fallback`)).toBeVisible();
      expect(within(card).queryByText('Advanced route details')).toBeNull();
      expect(api.inventory).toHaveBeenCalledWith(route);
    }
    expect(formValues(view.container).reasoningConfiguration).toEqual(current.reasoningConfiguration);
    expect(formValues(view.container).dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(api.discover).not.toHaveBeenCalled();
    const profile = view.getByLabelText('development reasoning profile') as HTMLSelectElement;
    expect(Array.from(profile.options, (option) => option.textContent)).toEqual([
      'Select reasoning profile', ...catalog.profiles.map((item) => `${item.name} · revision ${item.revision}`),
    ]);
    expect(view.queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });

  it('offers one primary route discovery action and runs route-only protocol discovery', async () => {
    const { getByRole, getAllByRole, getByLabelText, findByText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));

    expect(getAllByRole('button', { name: /map profile for /i })).toHaveLength(3);
    expect(queryByRole('button', { name: /revalidate|start discovery|use evidence/i })).toBeNull();
    await fireEvent.click(getByRole('button', { name: /map profile for development/i }));
    expect(await findByText(/compatibility could not be confirmed/i)).toBeTruthy();
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', maxCompletionTokens: 4096 });
  });

  it.each([
    { id: 'workers-ai-kimi-k-thinking', revision: 4, hash: hash('d'), name: 'Kimi thinking', supportedLevels: ['medium', 'high'] },
    { id: 'custom-saved-reasoning', revision: 3, hash: hash('e'), name: 'Saved custom reasoning', supportedLevels: ['medium', 'high'] },
  ])('uses the exact matched $name catalog revision only in the route draft', async (match) => {
    const profileRef = { id: match.id, revision: match.revision, hash: match.hash };
    api.catalog.mockResolvedValueOnce({ ...catalog, profiles: [...catalog.profiles, match] });
    api.discover.mockResolvedValueOnce({
      ...verifiedReport(), route: 'general_usage', outcome: 'existing-profile',
      compatibleLevels: match.supportedLevels,
      matchedProfiles: [{ profileRef, name: match.name, supportedLevels: match.supportedLevels }],
    });
    const savedCurrent = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, customProfileRevisions: match.id.startsWith('custom-') ? [match] : [] } };
    const { container, getByRole, findByRole, getByLabelText, queryByRole, queryByLabelText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={savedCurrent} />);
    await waitFor(() => expect((getByLabelText('general_usage reasoning profile') as HTMLSelectElement).options.length).toBe(8));
    const draft = () => JSON.parse((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
    const before = draft();
    await fireEvent.click(getByRole('button', { name: /map profile for general_usage/i }));
    const useProfile = await findByRole('button', { name: 'Assign profile', exact: true });
    expect(draft()).toEqual(before);
    expect(queryByLabelText('Profile name')).toBeNull();
    await fireEvent.click(useProfile);

    expect(draft()).toEqual({ ...before, routeAssignments: { ...before.routeAssignments, general_usage: { activeProfile: profileRef } } });
    expect(getByLabelText('general_usage reasoning profile')).toHaveValue(`${match.id}\u001f${match.revision}\u001f${match.hash}`);
    expect(queryByRole('heading', { name: /discover compatibility for general_usage/i })).toBeNull();
    expect(queryByRole('button', { name: /review and save profile/i })).toBeNull();
    expect(current.reasoningConfiguration.routeAssignments.general_usage.activeProfile).toEqual({ id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a') });
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'general_usage', maxCompletionTokens: 4096 });
  });

  it('REQ-ENTERPRISE-034: Verify Profile uses fixed 4096 beside Map Profile and attaches single-leg evidence only to the draft', async () => {
    const events: string[] = [];
    api.inventory.mockImplementation(async (route: string) => { events.push(`inventory:${route}`); return singleInventory(route); });
    let complete!: (value: ReturnType<typeof verifiedReport>) => void;
    api.discover.mockImplementationOnce(() => {
      events.push('discover');
      return new Promise((resolve) => { complete = resolve; });
    });
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const view = render(() => <form onSubmit={submit}><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await ready(view);
    await view.findByText('@cf/development-model');
    const card = view.getByRole('heading', { name: 'development' }).closest('article')!;
    const verify = within(card).getByRole('button', { name: 'Verify Profile for development' });
    expect(verify).toBeEnabled();
    expect(verify.closest('details')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Map Profile for development' })).toBeVisible();
    expect(within(card).queryByRole('spinbutton', { name: /verification|completion|token/i })).toBeNull();
    expect(within(card).queryByRole('button', { name: /start|add compatibility record/i })).toBeNull();
    const before = draftConfiguration(view.container);
    await waitFor(() => expect(api.inventory).toHaveBeenCalledWith('research'));
    events.length = 0;
    await fireEvent.click(verify);
    await waitFor(() => expect(api.discover).toHaveBeenCalledWith({ route: 'development', profileRef: current.reasoningConfiguration.routeAssignments.development.activeProfile, maxCompletionTokens: 4096 }));
    expect(events).toEqual(['inventory:development', 'discover']);
    expect(verify).toBeDisabled();
    expect(view.getByLabelText('development reasoning profile')).toBeDisabled();
    expect(draftConfiguration(view.container)).toEqual(before);
    complete(verifiedReport());
    expect(await within(card).findByText('Profile verified', { exact: true })).toBeVisible();
    expect(events).toEqual(['inventory:development', 'discover', 'inventory:development']);
    expect(draftConfiguration(view.container)).toEqual({
      ...before,
      routeAssignments: { ...before.routeAssignments, development: savedDevelopmentAssignment() },
    });
    // FormData is the Save boundary owned by EnvironmentIndex; verification never submits it.
    expect(formValues(view.container).reasoningConfiguration.routeAssignments.development).toEqual(savedDevelopmentAssignment());
    expect(current.reasoningConfiguration.routeAssignments.development).toEqual({ activeProfile: { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: hash('b') } });
    expect(submit).not.toHaveBeenCalled();
    expect(verify).toBeEnabled();
  });

  it('REQ-ENTERPRISE-033: multiple reachable legs show Observed path passed without fabricating a single-leg record', async () => {
    api.discover.mockResolvedValueOnce(verifiedReport());
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await ready(view);
    await view.findByText('development-alias');
    const before = draftConfiguration(view.container);
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    expect(await view.findByText('Observed path passed', { exact: true })).toBeVisible();
    expect(view.queryByText('Profile verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(before);
    expect(view.queryByRole('button', { name: /add compatibility record/i })).toBeNull();
  });

  it.each([
    ['route version', { routeVersion: 'development-v3' }],
    ['provider', { legs: [{ ...singleInventory('development').legs[0], provider: 'openai' }] }],
    ['model', { legs: [{ ...singleInventory('development').legs[0], declaredModel: '@cf/replaced-model' }] }],
    ['node', { legs: [{ ...singleInventory('development').legs[0], nodeId: 'replacement' }] }],
    ['backend description', { legs: [{ ...singleInventory('development').legs[0], customProviderBackend: 'changed' }] }],
    ['reachable topology', { legs: routeInventory('development').legs }],
  ])('REQ-ENTERPRISE-033: %s changing during verification prevents evidence attachment', async (_label, change) => {
    let changed = false;
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), ...(route === 'development' && changed ? change : {}) }));
    let complete!: (value: ReturnType<typeof verifiedReport>) => void;
    api.discover.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await ready(view);
    await view.findByText('@cf/development-model');
    const before = draftConfiguration(view.container);
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    await waitFor(() => expect(api.discover).toHaveBeenCalled());
    changed = true;
    complete(verifiedReport());
    await waitFor(() => expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled());
    const card = view.getByRole('heading', { name: 'development' }).closest('article')!;
    expect(within(card).getByText('Needs verification', { exact: true })).toBeVisible();
    expect(within(card).queryByText('Profile verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(before);
  });

  it.each([
    ['not assignable', { assignable: false }],
    ['missing assignability', { assignable: undefined }],
    ['unverified classification', { classification: 'Compatible, unverified' }],
    ['stale evidence', { evidence: { ...verifiedReport().evidence, current: false } }],
    ['missing freshness', { evidence: { toolReplay: true, ingress: 'ai-gateway-chat-completions' } }],
    ['missing replay', { evidence: { ...verifiedReport().evidence, toolReplay: false } }],
    ['absent replay', { evidence: { current: true, ingress: 'ai-gateway-chat-completions' } }],
    ['wrong ingress', { evidence: { ...verifiedReport().evidence, ingress: 'direct-provider' } }],
    ['missing evidence', { evidence: undefined }],
    ['incomplete diagnostic', { diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'incomplete_final_response' }] }],
    ['completion limit', { diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'completion_limit' }] }],
    ['fatal diagnostic', { diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'transport_error' }] }],
    ['fatal status', { diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'request_rejected', status: 403 }] }],
  ])('REQ-ENTERPRISE-033: %s cannot attach evidence or claim whole-route verification', async (_label, patch) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce({ ...verifiedReport(), ...patch });
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await ready(view);
    await view.findByText('@cf/development-model');
    const before = draftConfiguration(view.container);
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    await waitFor(() => expect(api.discover).toHaveBeenCalled());
    await waitFor(() => expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled());
    expect(view.queryByText('Profile verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(before);
  });

  it.each([
    ['failed', { classification: 'Unsupported', assignable: false, outcome: 'unsupported' }, 'Verification failed'],
    ['inconclusive', { classification: 'Inconclusive', assignable: false, outcome: 'inconclusive', diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'completion_limit' }] }, 'Verification unclear'],
  ])('REQ-ENTERPRISE-034: %s check has an explicit non-success result', async (_label, report, status) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce(report);
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await ready(view);
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    expect(await view.findByText(status, { exact: true })).toBeVisible();
    expect(view.queryByText('Profile verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(current.reasoningConfiguration);
  });

  it('REQ-ENTERPRISE-034: failed verification hides provider bodies and restores the Verify action', async () => {
    api.discover.mockRejectedValueOnce(new Error('PRIVATE PROVIDER BODY'));
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await ready(view);
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    expect(await view.findByText('Verification failed', { exact: true })).toBeVisible();
    expect(view.container).not.toHaveTextContent('PRIVATE');
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
    expect(draftConfiguration(view.container)).toEqual(current.reasoningConfiguration);
  });

  it('REQ-ENTERPRISE-034: profile changes clear the result and invalidate evidence even when switching back', async () => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockResolvedValueOnce(verifiedReport());
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await ready(view);
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    await view.findByText('Profile verified', { exact: true });
    for (const key of [profileKey('workers-ai-glm-thinking', 'a'), profileKey('workers-ai-kimi-k-thinking', 'b')]) {
      await fireEvent.change(view.getByLabelText('development reasoning profile'), { target: { value: key } });
      expect(view.queryByText('Profile verified', { exact: true })).toBeNull();
      expect(view.queryByText('Observed path passed', { exact: true })).toBeNull();
      const legs = draftConfiguration(view.container).routeAssignments.development.legs ?? [];
      expect(legs.some((leg: any) => leg.evidence?.current === true)).toBe(false);
    }
  });

  it('REQ-ENTERPRISE-033: saved exact single-leg evidence is green only after fresh matching inventory arrives', async () => {
    let release!: (value: ReturnType<typeof singleInventory>) => void;
    api.inventory.mockImplementation((route: string) => route === 'development'
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(singleInventory(route)));
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: savedDevelopmentAssignment() } } };
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} />);
    await ready(view);
    await waitFor(() => expect(api.inventory).toHaveBeenCalledWith('development'));
    expect(view.queryByText('Profile verified', { exact: true })).toBeNull();
    release(singleInventory('development'));
    expect(await view.findByText('Profile verified', { exact: true })).toBeVisible();
    expect(draftConfiguration(view.container)).toEqual(saved.reasoningConfiguration);
    expect(api.discover).not.toHaveBeenCalled();
  });

  it.each([
    ['revision mismatch', { legs: [{ ...savedDevelopmentAssignment().legs[0], profileRef: { ...savedDevelopmentAssignment().activeProfile, revision: 2 } }] }],
    ['hash mismatch', { legs: [{ ...savedDevelopmentAssignment().legs[0], profileRef: { ...savedDevelopmentAssignment().activeProfile, hash: hash('f') } }] }],
    ['profile id mismatch', { legs: [{ ...savedDevelopmentAssignment().legs[0], profileRef: { ...savedDevelopmentAssignment().activeProfile, id: 'other-profile' } }] }],
    ['old version', { routeVersion: 'development-v1' }],
    ['changed provider', { legs: [{ ...savedDevelopmentAssignment().legs[0], provider: 'openai' }] }],
    ['changed model', { legs: [{ ...savedDevelopmentAssignment().legs[0], declaredModel: 'old-model' }] }],
    ['missing replay', { legs: [{ ...savedDevelopmentAssignment().legs[0], evidence: { ...verifiedReport().evidence, toolReplay: false } }] }],
    ['stale evidence', { legs: [{ ...savedDevelopmentAssignment().legs[0], evidence: { ...verifiedReport().evidence, current: false } }] }],
    ['wrong ingress', { legs: [{ ...savedDevelopmentAssignment().legs[0], evidence: { ...verifiedReport().evidence, ingress: 'direct-provider' } }] }],
  ])('REQ-ENTERPRISE-033: saved %s cannot appear as Profile verified', async (_label, patch) => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: { ...savedDevelopmentAssignment(), ...patch } } } };
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} />);
    await ready(view);
    await view.findByText('@cf/development-model');
    const card = view.getByRole('heading', { name: 'development' }).closest('article')!;
    expect(within(card).queryByText('Profile verified', { exact: true })).toBeNull();
    expect(within(card).getByText('Needs verification', { exact: true })).toBeVisible();
    expect(draftConfiguration(view.container)).toEqual(saved.reasoningConfiguration);
  });

  it('REQ-ENTERPRISE-033: saved evidence cannot certify a fresh multi-leg route', async () => {
    const assignment = savedDevelopmentAssignment();
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: {
      ...assignment,
      legs: routeInventory('development').legs.map((leg) => ({ ...leg, profileRef: assignment.activeProfile, evidence: verifiedReport().evidence })),
    } } } };
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} />);
    await ready(view);
    await view.findByText('development-alias');
    expect(view.queryByText('Profile verified', { exact: true })).toBeNull();
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeEnabled();
    expect(draftConfiguration(view.container)).toEqual(saved.reasoningConfiguration);
  });

  it('REQ-ENTERPRISE-033: unavailable fresh inventory never reuses saved evidence as green', async () => {
    api.inventory.mockImplementation(async (route: string) => {
      if (route === 'development') throw new Error('Inventory unavailable');
      return singleInventory(route);
    });
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: savedDevelopmentAssignment() } } };
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} />);
    await ready(view);
    const card = view.getByRole('heading', { name: 'development' }).closest('article')!;
    expect(await within(card).findByRole('alert')).toHaveTextContent(/inventory|gateway/i);
    expect(within(card).queryByText('Profile verified', { exact: true })).toBeNull();
    expect(draftConfiguration(view.container)).toEqual(saved.reasoningConfiguration);
  });

  it('REQ-ENTERPRISE-034: a failed recheck invalidates earlier saved verification in the draft', async () => {
    api.inventory.mockImplementation(async (route: string) => singleInventory(route));
    api.discover.mockRejectedValueOnce(new Error('PRIVATE'));
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: savedDevelopmentAssignment() } } };
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} />);
    await view.findByText('Profile verified', { exact: true });
    await fireEvent.click(view.getByRole('button', { name: 'Verify Profile for development' }));
    await view.findByText('Verification failed', { exact: true });
    expect(draftConfiguration(view.container).routeAssignments.development.legs[0].evidence.current).toBe(false);
    expect(saved.reasoningConfiguration.routeAssignments.development.legs[0].evidence.current).toBe(true);
  });

  it('REQ-ENTERPRISE-033: editing custom provenance requires Save before verification and preserves the draft', async () => {
    api.inventory.mockImplementation(async (route: string) => ({ ...singleInventory(route), legs: [{ ...singleInventory(route).legs[0], provider: 'custom-enterprise', customProviderBackend: 'Old backend' }] }));
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    const input = await view.findByLabelText('development-only custom provider backend');
    await fireEvent.input(input, { target: { value: 'New backend' } });
    expect(view.getByRole('button', { name: 'Verify Profile for development' })).toBeDisabled();
    const card = view.getByRole('heading', { name: 'development' }).closest('article')!;
    expect(within(card).getByText('Save the backend description before verifying.')).toBeVisible();
    expect(draftConfiguration(view.container).routeAssignments.development.legs[0].customProviderBackend).toBe('New backend');
    expect(api.discover).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-036: an unsaved custom revision has a disabled Verify action with a save explanation', async () => {
    const custom = { id: 'custom-new', revision: 1, hash: hash('f'), name: 'New custom', supportedLevels: ['medium'], classification: 'Compatible, unverified' };
    const saved = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, customProfileRevisions: [custom], routeAssignments: { ...current.reasoningConfiguration.routeAssignments, development: { activeProfile: { id: custom.id, revision: 1, hash: custom.hash } } } } };
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={saved} />);
    await ready(view);
    const verify = view.getByRole('button', { name: 'Verify Profile for development' });
    expect(verify).toBeVisible();
    expect(verify).toBeDisabled();
    const card = view.getByRole('heading', { name: 'development' }).closest('article')!;
    expect(within(card).getByText('Save this new profile before verifying.')).toBeVisible();
    await fireEvent.click(verify);
    expect(api.discover).not.toHaveBeenCalled();
    expect(draftConfiguration(view.container)).toEqual(saved.reasoningConfiguration);
  });

  it('REQ-ENTERPRISE-034: supported levels and associated helpers explain profile-limited defaults', async () => {
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await ready(view);
    const global = view.getByLabelText('Global default reasoning') as HTMLSelectElement;
    const group = view.getByLabelText('developers default reasoning') as HTMLSelectElement;
    expect(Array.from(global.options, (option) => option.value)).toEqual(['off', 'medium', 'high']);
    expect(Array.from(group.options, (option) => option.value)).toEqual(['medium', 'high']);
    expect(describedText(global)).toMatch(/profile/i);
    expect(describedText(group)).toMatch(/profile/i);
    expect(global).toBeEnabled();
    expect(group).toBeEnabled();
    await fireEvent.change(global, { target: { value: 'high' } });
    await fireEvent.change(view.getByLabelText('general_usage reasoning profile'), { target: { value: profileKey('openai-gpt-chat-tools-off', '2') } });
    expect(global).toHaveValue('off');
    expect(global).toBeDisabled();
    expect(describedText(global)).toMatch(/only|one|single/i);
    expect(view.container.querySelector('input[type="hidden"][name="reasoning"]')).toHaveValue('off');
    expect(new FormData(view.container.querySelector('form')!).get('reasoning')).toBe('off');
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'general_usage', reasoning: 'off' });
    await fireEvent.change(view.getByLabelText('developers default route'), { target: { value: 'general_usage' } });
    expect(view.getByLabelText('developers default reasoning')).toHaveValue('off');
    expect(view.getByLabelText('developers default reasoning')).toBeDisabled();
    expect(describedText(view.getByLabelText('developers default reasoning'))).toMatch(/only|one|single/i);
    expect(formValues(view.container).groupRouting[0].reasoning).toBe('off');
    await fireEvent.change(view.getByLabelText('Global default route'), { target: { value: 'development' } });
    expect(global).toHaveValue('medium');
    expect(global).toBeEnabled();
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'development', reasoning: 'medium' });
  });

  it('REQ-ENTERPRISE-034: a single non-off mode stays disabled yet serializes its selected value', async () => {
    const onlyHigh = { id: 'custom-high-only', revision: 1, hash: hash('f'), name: 'High only', supportedLevels: ['high'], classification: 'Verified' };
    api.catalog.mockResolvedValueOnce({ ...catalog, profiles: [...catalog.profiles, onlyHigh] });
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await ready(view);
    await fireEvent.change(view.getByLabelText('general_usage reasoning profile'), { target: { value: profileKey('custom-high-only', 'f') } });
    const reasoning = view.getByLabelText('Global default reasoning');
    expect(reasoning).toHaveValue('high');
    expect(reasoning).toBeDisabled();
    expect(describedText(reasoning)).toMatch(/only|one|single/i);
    expect(view.container.querySelector('input[type="hidden"][name="reasoning"]')).toHaveValue('high');
    expect(new FormData(view.container.querySelector('form')!).getAll('reasoning')).toEqual(['high']);
    expect(formValues(view.container).defaultRoute).toEqual({ route: 'general_usage', reasoning: 'high' });
    expect(formValues(view.container).groupRouting[1].reasoning).toBe('high');
    expect(view.getByLabelText('support default reasoning')).toHaveValue('high');
    expect(view.getByLabelText('support default reasoning')).toBeDisabled();
  });

  it('REQ-ENTERPRISE-034: default reasoning helper distinguishes catalog loading from missing assignment', async () => {
    let hydrate!: (value: typeof catalog) => void;
    api.catalog.mockReturnValueOnce(new Promise<typeof catalog>((resolve) => { hydrate = resolve; }));
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    expect(view.getByLabelText('Global default reasoning')).toBeDisabled();
    expect(describedText(view.getByLabelText('Global default reasoning'))).toMatch(/loading/i);
    hydrate(catalog);
    await ready(view);
    await fireEvent.change(view.getByLabelText('general_usage reasoning profile'), { target: { value: '' } });
    const reasoning = view.getByLabelText('Global default reasoning');
    expect(reasoning).toBeDisabled();
    expect(describedText(reasoning)).toMatch(/assign|select.*profile/i);
    expect(describedText(reasoning)).not.toMatch(/loading/i);
  });

  it('keeps unconfigured gateway rows visible without adding them to saved routing or new group defaults', async () => {
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await waitFor(() => expect((view.getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const values = () => environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!)) as Record<string, any>;
    expect(view.getByRole('button', { name: 'Map Profile for research' })).toBeEnabled();
    expect(values().dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(values().routeContextWindows).toEqual(current.routeContextWindows);
    expect(values().reasoningConfiguration).toEqual(current.reasoningConfiguration);
    expect(Array.from((view.getByLabelText('Global default route') as HTMLSelectElement).options, (option) => option.value)).toEqual(current.dynamicRoutes);
    expect(view.queryByLabelText('developers research route')).toBeNull();
    await fireEvent.change(view.getByLabelText('Unconfigured access group'), { target: { value: 'research-team' } });
    await fireEvent.click(view.getByRole('button', { name: 'Add group policy' }));
    expect(values().groupRouting[2]).toEqual({ accessGroup: 'research-team', routes: current.dynamicRoutes, defaultRoute: 'general_usage', reasoning: 'off' });
    await fireEvent.change(view.getByLabelText('development reasoning profile'), { target: { value: '' } });
    expect(values().dynamicRoutes).toEqual(current.dynamicRoutes);
    expect(values().groupRouting[0].routes).toEqual(current.groupRouting[0].routes);
    expect(view.getByLabelText('developers default route')).toHaveValue('development');
  });

  it('uses the first assigned route as the initial default instead of an unrelated gateway row', async () => {
    const view = render(() => <form><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={{ ...current, dynamicRoutes: [], defaultRoute: null, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, groupRouting: [] }} /></form>);
    await waitFor(() => expect((view.getByLabelText('research reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    expect((view.getByLabelText('Global default route') as HTMLSelectElement).value).toBe('');
    await fireEvent.change(view.getByLabelText('research reasoning profile'), { target: { value: `workers-ai-glm-thinking\u001f1\u001f${hash('a')}` } });
    const values = environmentValues('aiRouting', 'enterprise', new FormData(view.container.querySelector('form')!)) as Record<string, any>;
    expect(values.dynamicRoutes).toEqual(['research']);
    expect(values.defaultRoute).toEqual({ route: 'research', reasoning: 'off' });
    expect(view.getByRole('button', { name: 'Map Profile for development' })).toBeEnabled();
  });

  it('does not treat unconfigured gateway rows as replacements for the last configured route', async () => {
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={{ ...current, dynamicRoutes: ['retired'], defaultRoute: { route: 'retired', reasoning: 'off' }, reasoningConfiguration: { ...current.reasoningConfiguration, routeAssignments: { retired: current.reasoningConfiguration.routeAssignments.general_usage } }, groupRouting: [] }} />);
    await waitFor(() => expect(view.getByRole('button', { name: 'Map Profile for research' })).toBeEnabled());
    await fireEvent.click(view.getByRole('button', { name: 'Remove retired stale route' }));
    expect(view.getByRole('alert')).toHaveTextContent('At least one route must remain in the catalog.');
    expect(view.queryByRole('button', { name: 'Confirm remove retired' })).toBeNull();
    expect(view.getByLabelText('Global default route')).toHaveValue('retired');
  });

  it('adds a discovered gateway route to routing only after assignment and preserves group apply-to-all', async () => {
    const { container, getByLabelText, queryByLabelText, getByRole, getByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));

    expect(getByLabelText('research context window')).toBeTruthy();
    expect(queryByLabelText('New route handle')).toBeNull();
    expect(getByRole('button', { name: /map profile for research/i })).toBeEnabled();

    await fireEvent.input(getByLabelText('research context window'), { target: { value: '65536' } });
    const profile = getByLabelText('research reasoning profile') as HTMLSelectElement;
    const glm = Array.from(profile.options).find((option) => option.textContent?.startsWith('GLM thinking'))!;
    await fireEvent.change(profile, { target: { value: glm.value } });
    await fireEvent.click(getByLabelText('developers research route'));
    await fireEvent.change(getByLabelText('developers default route'), { target: { value: 'research' } });
    await fireEvent.change(getByLabelText('developers default reasoning'), { target: { value: 'high' } });

    await fireEvent.click(getByRole('button', { name: /apply to all groups/i }));
    expect(getByText(/developers.*support|support.*developers/i)).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: /confirm group changes/i }));

    const form = document.createElement('form');
    form.append(container.firstElementChild!);
    const values = environmentValues('aiRouting', 'enterprise', new FormData(form)) as Record<string, any>;
    expect(values.dynamicRoutes).toEqual(['general_usage', 'development', 'research']);
    expect(values.routeContextWindows.research).toBe(65536);
    expect(values.reasoningConfiguration.routeAssignments.research.activeProfile).toEqual({ id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a') });
    expect(values.groupRouting).toEqual([
      { accessGroup: 'developers', routes: ['general_usage', 'development', 'research'], defaultRoute: 'research', reasoning: 'high' },
      { accessGroup: 'support', routes: ['general_usage', 'development', 'research'], defaultRoute: 'research', reasoning: 'high' },
    ]);
  });

  it('confirms affected references before removing a stored route absent from the gateway', async () => {
    const staleCurrent = {
      ...current,
      dynamicRoutes: [...current.dynamicRoutes, 'retired'],
      routeContextWindows: { ...current.routeContextWindows, retired: 65536 },
      defaultRoute: { route: 'retired', reasoning: 'off' },
      reasoningConfiguration: {
        ...current.reasoningConfiguration,
        routeAssignments: {
          ...current.reasoningConfiguration.routeAssignments,
          retired: { activeProfile: { id: 'workers-ai-glm-thinking', revision: 1, hash: hash('a') } },
        },
      },
    };
    const { getByLabelText, getByRole, getByText, queryByLabelText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={staleCurrent} />);
    await waitFor(() => expect((getByLabelText('retired reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    await fireEvent.click(getByRole('button', { name: /remove retired stale route/i }));
    expect(getByText(/Affected references: global default/i)).toBeTruthy();
    expect(queryByLabelText('retired context window')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: /confirm remove retired/i }));
    await waitFor(() => expect(queryByLabelText('retired context window')).toBeNull());
  });
});
