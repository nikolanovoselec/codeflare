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

beforeEach(() => {
  api.catalog.mockResolvedValue(catalog);
  api.inventory.mockResolvedValue({
    route: 'development',
    routeVersion: 'route-v2',
    legs: [
      { nodeId: 'primary', provider: 'custom-enterprise', declaredModel: 'development-alias', evidence: { status: 'stale' } },
      { nodeId: 'fallback', provider: 'workers-ai', declaredModel: '@cf/zai-org/glm', evidence: { status: 'verified' } },
    ],
    commonMapping: { levels: { medium: { removePaths: [], writes: [] } }, digest: hash('c') },
  });
  api.discover.mockResolvedValue({ classification: 'Compatible, unverified', warnings: ['custom_provider_backend_requires_revalidation'], accounting: { logicalProbes: 2, httpAttempts: 3 } });
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

  it('keeps gateway inventory and compatibility records in collapsed advanced route details', async () => {
    const { getByRole, getByLabelText, findByText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    const profile = getByLabelText('development reasoning profile') as HTMLSelectElement;
    await waitFor(() => expect(profile.options.length).toBe(7));
    expect(api.catalog).toHaveBeenCalledTimes(1);
    expect(Array.from(profile.options, (option) => option.textContent)).toEqual([
      'Select reasoning profile',
      ...catalog.profiles.map((item) => `${item.name} · revision ${item.revision}`),
    ]);
    expect(queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();

    const developmentCard = getByRole('heading', { name: 'development' }).closest('article')!;
    const summary = within(developmentCard).getByText('Advanced route details', { selector: 'summary' });
    const details = summary.closest('details');
    expect(details?.open).toBe(false);

    await fireEvent.click(summary);
    await fireEvent.click(getByRole('button', { name: /refresh development gateway details/i }));
    expect(await findByText('development-alias')).toBeTruthy();
    expect(getByLabelText('primary custom provider backend')).toBeTruthy();
    expect(getByLabelText('primary compatibility record')).toBeTruthy();
    expect(within(developmentCard).getByText(/document observed behavior and never choose a backend/i)).toBeTruthy();
    expect(await findByText((_content, element) => element?.tagName === 'P' && element.textContent?.includes('Shared supported levels: medium') === true)).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: /verify development selected profile/i }));
    expect(await findByText((_content, element) => element?.tagName === 'STRONG' && element.textContent === 'Selected profile check: Compatible, unverified')).toBeTruthy();
    expect(queryByRole('button', { name: /add compatibility record/i })).toBeNull();
    expect(api.discover).toHaveBeenCalledWith(expect.objectContaining({ route: 'development', profileRef: current.reasoningConfiguration.routeAssignments.development.activeProfile, maxCompletionTokens: 4096 }));
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
      classification: 'Verified', assignable: true, outcome: 'existing-profile',
      matchedProfiles: [{ profileRef, name: match.name, supportedLevels: match.supportedLevels }],
    });
    const savedCurrent = { ...current, reasoningConfiguration: { ...current.reasoningConfiguration, customProfileRevisions: match.id.startsWith('custom-') ? [match] : [] } };
    const { container, getByRole, findByRole, getByLabelText, queryByRole, queryByLabelText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={savedCurrent} />);
    await waitFor(() => expect((getByLabelText('general_usage reasoning profile') as HTMLSelectElement).options.length).toBe(8));
    const draft = () => JSON.parse((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
    const before = draft();
    await fireEvent.click(getByRole('button', { name: /map profile for general_usage/i }));
    const useProfile = await findByRole('button', { name: `Assign ${match.name}` });
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

  it.each([false, undefined])('sends the chosen verification ceiling and exposes budget diagnostics without retrying (assignable: %s)', async (assignable) => {
    let complete!: (value: unknown) => void;
    api.discover.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const { getByLabelText, getByRole, findByText, container } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const card = getByRole('heading', { name: 'development' }).closest('article')!;
    await fireEvent.click(within(card).getByText('Advanced route details', { selector: 'summary' }));
    const ceiling = getByRole('spinbutton', { name: 'development verification completion token ceiling' });
    expect(ceiling).toHaveValue(4096);
    expect(ceiling).toHaveAttribute('min', '32');
    expect(ceiling).toHaveAttribute('max', '16384');
    expect(ceiling).toHaveAttribute('step', '1');
    expect(within(card).getByText(/may create provider usage/i)).toBeInTheDocument();
    await fireEvent.input(ceiling, { target: { value: '1024' } });
    const before = (container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value;
    await fireEvent.click(getByRole('button', { name: /verify development selected profile/i }));
    expect(getByRole('spinbutton', { name: 'development verification completion token ceiling' })).toBeDisabled();
    expect(getByRole('button', { name: /verify development selected profile/i })).toBeDisabled();
    expect(getByLabelText('development reasoning profile')).toBeDisabled();
    expect(api.discover).toHaveBeenCalledExactlyOnceWith({ route: 'development', profileRef: current.reasoningConfiguration.routeAssignments.development.activeProfile, maxCompletionTokens: 1024 });
    complete({
      classification: 'Unsupported', assignable, outcome: 'inconclusive', requestedCompletionCeiling: 1024,
      diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'completion_limit', body: 'PRIVATE PROVIDER BODY' }],
      candidateResults: [{ profileId: 'workers-ai-kimi-k-thinking', profileName: 'Kimi thinking', classification: 'Inconclusive', assignable: false, verifiedLevels: ['medium'], diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'incomplete_final_response' }] }],
    });
    expect(await findByText(/selected profile check:.*incomplete at the chosen token budget/i)).toBeInTheDocument();
    const details = within(getByRole('heading', { name: 'development' }).closest('article')!).getByText('Technical check details').closest('details')!;
    await fireEvent.click(within(details).getByText('Technical check details'));
    expect(details).toHaveTextContent('Kimi thinking');
    expect(details).toHaveTextContent('Verified levels: medium');
    expect(details).toHaveTextContent('Levels: high');
    expect(details).toHaveTextContent('Stage: tool-replay');
    expect(details).toHaveTextContent(/did not complete the final response after tool replay/i);
    expect(container).not.toHaveTextContent('PRIVATE');
    expect(getByRole('spinbutton', { name: 'development verification completion token ceiling' })).toBeEnabled();
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect((container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value).toBe(before);
  });

  it.each(['', '31', '16385', '32.5', 'not-a-number'])('blocks invalid selected-verification ceiling %j without a provider call', async (budget) => {
    const { getByLabelText, getByRole, findByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const card = getByRole('heading', { name: 'development' }).closest('article')!;
    await fireEvent.click(within(card).getByText('Advanced route details', { selector: 'summary' }));
    await fireEvent.input(getByRole('spinbutton', { name: 'development verification completion token ceiling' }), { target: { value: budget } });
    await fireEvent.click(getByRole('button', { name: /verify development selected profile/i }));
    expect(await findByRole('alert')).toHaveTextContent(/whole number from 32 to 16384/i);
    expect(api.discover).not.toHaveBeenCalled();
  });

  it('does not expose provider response bodies from failed selected verification', async () => {
    api.discover.mockRejectedValueOnce(new Error('PRIVATE PROVIDER BODY'));
    const { getByRole, getByLabelText, findByRole, container } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const card = getByRole('heading', { name: 'development' }).closest('article')!;
    await fireEvent.click(within(card).getByText('Advanced route details', { selector: 'summary' }));
    await fireEvent.click(getByRole('button', { name: /verify development selected profile/i }));
    expect(await findByRole('alert')).toHaveTextContent(/profile verification failed.*saved AI Gateway connection/i);
    expect(container).not.toHaveTextContent('PRIVATE');
    expect(getByRole('button', { name: /verify development selected profile/i })).toBeEnabled();
  });

  it('discards selected-profile verification when the profile draft changes', async () => {
    api.discover.mockResolvedValueOnce({ classification: 'Verified', assignable: true, evidence: { current: true, toolReplay: true } });
    const { getByLabelText, getByRole, findByText, queryByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const card = getByRole('heading', { name: 'development' }).closest('article')!;
    await fireEvent.click(within(card).getByText('Advanced route details', { selector: 'summary' }));
    await fireEvent.click(getByRole('button', { name: /verify development selected profile/i }));
    await findByText('Selected profile check: Verified');
    await fireEvent.change(getByLabelText('development reasoning profile'), { target: { value: `workers-ai-glm-thinking\u001f1\u001f${hash('a')}` } });
    expect(queryByText('Selected profile check: Verified')).toBeNull();
  });

  it('attaches a verified compatibility record only after inventory confirms one reachable leg', async () => {
    api.inventory.mockResolvedValueOnce({
      route: 'development', routeVersion: 'route-v2',
      legs: [{ nodeId: 'only', provider: 'workers-ai', declaredModel: '@cf/model' }],
      commonLevels: [], warnings: ['missing_leg_evidence'],
    });
    api.discover.mockResolvedValueOnce({
      classification: 'Verified', assignable: true, accounting: { logicalProbes: 2, httpAttempts: 3 },
      evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' },
    });
    const { container, getByLabelText, getByRole, findByRole, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((getByLabelText('development reasoning profile') as HTMLSelectElement).options.length).toBe(7));
    const developmentCard = getByRole('heading', { name: 'development' }).closest('article')!;
    await fireEvent.click(within(developmentCard).getByText('Advanced route details', { selector: 'summary' }));
    await fireEvent.click(getByRole('button', { name: /refresh development gateway details/i }));
    await fireEvent.click(getByRole('button', { name: /verify development selected profile/i }));
    await findByText(/selected profile check: verified/i);
    await fireEvent.click(await findByRole('button', { name: /add compatibility record/i }));

    const form = document.createElement('form');
    form.append(container.firstElementChild!);
    const values = environmentValues('aiRouting', 'enterprise', new FormData(form)) as Record<string, any>;
    expect(values.reasoningConfiguration.routeAssignments.development.legs[0].evidence).toEqual({
      current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions',
    });
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
    expect(view.getByLabelText('Global default route')).toHaveValue('');
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
