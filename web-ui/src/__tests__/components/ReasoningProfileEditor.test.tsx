import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';
import ReasoningProfileEditor from '../../components/admin/ReasoningProfileEditor';
import type { ReasoningDiscoveryResult } from '../../types';

const { catalogMock, discoverMock } = vi.hoisted(() => ({
  catalogMock: vi.fn(),
  discoverMock: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => catalogMock(...args),
  getReasoningRouteInventory: vi.fn(),
  discoverReasoningCompatibility: (...args: unknown[]) => discoverMock(...args),
}));

const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  dynamicRoutes: ['mesh'],
  defaultRoute: { route: 'mesh', reasoning: 'medium' },
  routeContextWindows: { mesh: 262144 },
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
  groupRouting: [],
};

const discoveredDraft = {
  schemaVersion: 1,
  enabled: true,
  ingressContract: 'ai-gateway-chat-completions',
  supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  removePaths: ['reasoning_effort'],
  levels: {
    off: [{ path: 'reasoning_effort', value: 'none' }],
    medium: [{ path: 'reasoning_effort', value: 'medium' }],
  },
  aliases: { minimal: 'medium', low: 'medium', high: 'medium', xhigh: 'medium', max: 'medium' },
  offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' },
  recognizedResponseFields: { reasoning: [], content: ['choices[].message.content'], tools: ['choices[].message.tool_calls'] },
  classification: 'Compatible, unverified',
  toolCompatibility: { status: 'unverified', levels: [] },
  validatedTransports: [],
  originallyCreatedAgainst: { route: 'mesh', observedAt: '2026-09-05T20:30:00.000Z' },
  evidence: [{ current: true, toolReplay: true, route: 'mesh' }],
  limitations: ['Discovery validates only the exercised route path and current backend configuration.'],
};

beforeEach(() => {
  catalogMock.mockResolvedValue({
    schemaVersion: 1,
    profiles: [{ id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: 'a'.repeat(64), name: 'Mesh binary thinking', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
    notices: [{ id: 'gpt-oss-tool-replay', name: 'GPT-OSS tool replay', assignable: false }],
    usage: [],
    routes: ['mesh'],
    routeCatalogStatus: 'ready',
  });
  discoverMock.mockResolvedValue({
    route: 'mesh',
    classification: 'Verified',
    assignable: true,
    outcome: 'custom-profile',
    accounting: { logicalProbes: 5, httpAttempts: 12 },
    profileDraft: discoveredDraft,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-035/036 route-scoped profile discovery', () => {
  it('offers custom profile review without claiming to identify the backend model', async () => {
    const { getByRole, getByLabelText, queryByLabelText, queryByText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /discover mesh compatibility/i }));

    expect(getByRole('heading', { name: /discover compatibility for mesh/i })).toBeTruthy();
    expect(queryByLabelText('Dynamic route')).toBeNull();
    expect(queryByLabelText('Profile name')).toBeNull();

    await fireEvent.click(getByRole('button', { name: /check compatibility/i }));
    expect(discoverMock).toHaveBeenCalledWith({ route: 'mesh', maxCompletionTokens: 32 });
    expect(await findByText(/compatible reasoning behavior found/i)).toBeTruthy();
    expect(queryByText(/model identified|identified model/i)).toBeNull();
    expect(getByLabelText('Profile name')).toBeTruthy();
    expect(getByRole('button', { name: /continue to review/i })).toBeTruthy();
  });

  it('shows every named existing match, including Kimi and a saved custom profile, without creating a duplicate', async () => {
    const matches: NonNullable<ReasoningDiscoveryResult['matchedProfiles']> = [
      { profileRef: { id: 'workers-ai-kimi-k-thinking', revision: 2, hash: 'b'.repeat(64) }, name: 'Kimi thinking', supportedLevels: ['medium', 'high'] },
      { profileRef: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: 'a'.repeat(64) }, name: 'Mesh binary thinking', supportedLevels: ['off', 'medium', 'high'] },
      { profileRef: { id: 'custom-saved', revision: 3, hash: 'c'.repeat(64) }, name: 'Saved custom reasoning', supportedLevels: ['medium', 'high'] },
    ];
    discoverMock.mockResolvedValueOnce({
      classification: 'Verified', assignable: true, outcome: 'existing-profile', matchedProfiles: matches,
      candidateResults: matches.map((match) => ({ profileId: match.profileRef.id, profileName: match.name, classification: 'Verified', assignable: true, verifiedLevels: match.supportedLevels })),
    });
    const onSave = vi.fn();
    const onSelectProfile = vi.fn();
    const { getByRole, findByRole, getByText, queryByLabelText, queryByRole, queryByText } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={onSave} onSelectProfile={onSelectProfile} onCancel={vi.fn()} />);
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    await findByRole('button', { name: 'Use Kimi thinking' });

    for (const match of matches) {
      const button = getByRole('button', { name: `Use ${match.name}` });
      expect(within(button.parentElement!).getByText(`Supported levels: ${match.supportedLevels.join(', ')}`)).toBeInTheDocument();
    }
    expect(queryByLabelText('Profile name')).toBeNull();
    expect(queryByRole('button', { name: 'Continue to review' })).toBeNull();
    expect(queryByText(/model identified|identified model/i)).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    expect(onSelectProfile).not.toHaveBeenCalled();

    const details = getByText('Technical check details').closest('details')!;
    expect(details.open).toBe(false);
    await fireEvent.click(within(details).getByText('Technical check details'));
    for (const match of matches) expect(within(details).getByText(match.name)).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Use Kimi thinking' }));
    expect(onSelectProfile).toHaveBeenCalledExactlyOnceWith(matches[0].profileRef);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps failed candidate diagnostics collapsed when an existing profile matches', async () => {
    discoverMock.mockResolvedValueOnce({
      classification: 'Verified', assignable: true, outcome: 'existing-profile',
      matchedProfiles: [{ profileRef: { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: 'b'.repeat(64) }, name: 'Kimi thinking', supportedLevels: ['low'] }],
      diagnostics: [{ levels: ['off'], stage: 'reasoning', code: 'off_not_disabled' }],
      candidateResults: [{ profileId: 'internal-protocol-id', classification: 'Unsupported', assignable: false, diagnostics: [{ levels: ['off'], stage: 'reasoning', code: 'off_not_disabled' }] }],
    });
    const { getByRole, findByRole, getByText, container } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    await findByRole('button', { name: 'Use Kimi thinking' });
    const details = getByText(/reasoning remained enabled when checking Off/i).closest('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(container).not.toHaveTextContent('internal-protocol-id');
  });

  it('prioritizes a fatal gateway failure over an earlier token limit', async () => {
    discoverMock.mockResolvedValueOnce({
      classification: 'Inconclusive', assignable: false, outcome: 'inconclusive',
      diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'completion_limit' }, { levels: ['off'], stage: 'reasoning', code: 'request_rejected', status: 401 }],
    });
    const { getByRole, findByRole } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    const alert = await findByRole('alert');
    expect(alert).toHaveTextContent('401');
    expect(alert).not.toHaveTextContent(/increase the completion token ceiling/i);
  });

  it.each(['32', '256', '16384'])('sends the explicit %s token ceiling and locks the controls during discovery', async (budget) => {
    let complete!: (result: ReasoningDiscoveryResult) => void;
    discoverMock.mockReturnValueOnce(new Promise<ReasoningDiscoveryResult>((resolve) => { complete = resolve; }));
    const { getByRole, getByText, findByRole } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    const ceiling = getByRole('spinbutton', { name: 'Discovery completion token ceiling' });
    expect(ceiling).toHaveValue(32);
    expect(ceiling).toHaveAttribute('min', '32');
    expect(ceiling).toHaveAttribute('max', '16384');
    expect(ceiling).toHaveAttribute('step', '1');
    expect(getByText(/may create provider usage/i)).toBeInTheDocument();
    await fireEvent.input(ceiling, { target: { value: budget } });
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    expect(discoverMock).toHaveBeenCalledExactlyOnceWith({ route: 'mesh', maxCompletionTokens: Number(budget) });
    expect(ceiling).toBeDisabled();
    expect(getByRole('button', { name: 'Checking…' })).toBeDisabled();
    complete({ classification: 'Unsupported', assignable: false, outcome: 'inconclusive', requestedCompletionCeiling: Number(budget), diagnostics: [{ levels: ['medium'], stage: 'tool-replay', code: 'completion_limit' }] });
    const alert = await findByRole('alert');
    expect(alert).toHaveTextContent(/incomplete at the chosen token budget.*increase the completion token ceiling/i);
    expect(alert).not.toHaveTextContent(/unsupported|no compatible reasoning behavior/i);
    expect(ceiling).toBeEnabled();
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it.each(['', '31', '16385', '32.5', '-1', 'not-a-number'])('blocks invalid discovery ceiling %j before any provider call', async (budget) => {
    const { getByRole, findByRole } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await fireEvent.input(getByRole('spinbutton', { name: 'Discovery completion token ceiling' }), { target: { value: budget } });
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    expect(await findByRole('alert')).toHaveTextContent(/whole number from 32 to 16384/i);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no_tool_call', /did not return the required Pi tool call/i],
    ['invalid_tool_call', /invalid Pi tool call/i],
    ['replay_rejected', /rejected the Pi tool-result replay/i],
    ['request_rejected', /rejected the compatibility request/i],
    ['timeout', /compatibility check timed out/i],
    ['transport_error', /provider connection failed/i],
    ['malformed_response', /malformed response/i],
    ['response_too_large', /response exceeded the safe size limit/i],
    ['off_not_disabled', /reasoning remained enabled when checking Off/i],
    ['incomplete_final_response', /did not complete the final response after tool replay/i],
    ['unsupported_mapping', /observed reasoning mapping is not supported/i],
  ])('explains %s in human wording without showing raw provider data', async (code, message) => {
    discoverMock.mockResolvedValueOnce({
      classification: 'Inconclusive', assignable: false, outcome: 'inconclusive',
      diagnostics: [{ code, levels: ['medium'], stage: 'tool-replay', status: 400, transport: 'json', body: 'PRIVATE PROVIDER BODY' }],
      normalizedDraft: { arbitrary: 'PRIVATE MAPPING' }, warnings: ['PRIVATE PROVIDER WARNING'],
    });
    const { getByRole, findByText, container } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    expect(await findByText(message)).toBeInTheDocument();
    expect(container).not.toHaveTextContent('PRIVATE');
    expect(container.querySelector('textarea, pre')).toBeNull();
  });

  it('does not expose provider response bodies from a failed discovery request', async () => {
    discoverMock.mockRejectedValueOnce(new Error('PRIVATE PROVIDER BODY'));
    const { getByRole, findByRole, container } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    expect(await findByRole('alert')).toHaveTextContent(/compatibility check failed.*saved AI Gateway connection/i);
    expect(container).not.toHaveTextContent('PRIVATE');
    expect(getByRole('button', { name: 'Check compatibility' })).toBeEnabled();
  });

  it('surfaces candidate-only budget exhaustion as incomplete and discloses profile names, levels, and stages', async () => {
    discoverMock.mockResolvedValueOnce({
      classification: 'Unsupported', assignable: false, requestedCompletionCeiling: 32,
      candidateResults: [{ profileId: 'workers-ai-kimi-k-thinking', profileName: 'Kimi thinking', classification: 'Unsupported', assignable: false, verifiedLevels: ['medium'], diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'completion_limit' }] }],
    });
    const { getByRole, findByRole, getByText, container } = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await fireEvent.click(getByRole('button', { name: 'Check compatibility' }));
    expect(await findByRole('alert')).toHaveTextContent(/incomplete at the chosen token budget/i);
    expect(container).not.toHaveTextContent(/no compatible reasoning behavior was found/i);
    const details = getByText('Technical check details').closest('details')!;
    await fireEvent.click(within(details).getByText('Technical check details'));
    expect(within(details).getByText('Kimi thinking')).toBeInTheDocument();
    expect(details).toHaveTextContent('Verified levels: medium');
    expect(details).toHaveTextContent('Levels: high');
    expect(details).toHaveTextContent('Stage: tool-replay');
    expect(details).toHaveTextContent('Completion token ceiling: 32');
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it('reports an empty supported-level list instead of rendering a blank value', async () => {
    discoverMock.mockResolvedValueOnce({
      route: 'mesh', classification: 'Verified', assignable: true,
      accounting: { logicalProbes: 5, httpAttempts: 12 },
      profileDraft: { ...discoveredDraft, supportedLevels: [] },
    });
    const { getByRole, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /discover mesh compatibility/i }));
    await fireEvent.click(getByRole('button', { name: /check compatibility/i }));

    expect(await findByText('Supported levels: Not reported')).toBeTruthy();
  });

  it('adds an immutable unassigned revision and surfaces the required Review and Apply path', async () => {
    const { container, getByRole, getByLabelText, getByText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /discover mesh compatibility/i }));
    await fireEvent.click(getByRole('button', { name: /check compatibility/i }));
    await findByText(/compatible reasoning behavior found/i);
    await fireEvent.input(getByLabelText('Profile name'), { target: { value: 'Custom mesh' } });
    await fireEvent.click(getByRole('button', { name: /continue to review/i }));

    expect(getByText(/Custom mesh is ready to review/i)).toBeTruthy();
    expect(getByText(/not saved, assigned, or active yet/i)).toBeTruthy();
    expect(getByRole('button', { name: /review and save profile/i })).toBeTruthy();

    const form = document.createElement('form');
    form.append(container.firstElementChild!);
    const values = environmentValues('aiRouting', 'enterprise', new FormData(form)) as Record<string, any>;
    expect(values.reasoningConfiguration.customProfileRevisions[0]).toMatchObject({
      id: 'custom-mesh',
      name: 'Custom mesh',
      revision: 1,
      levels: discoveredDraft.levels,
      originallyCreatedAgainst: { route: 'mesh' },
    });
    expect(values.reasoningConfiguration.routeAssignments).toEqual({});
  });

  it.each([
    ['unsupported', { warnings: ['no_compatible_profile_mapping'], candidateResults: [{ profileId: 'candidate', classification: 'Unsupported', assignable: false }] }, /no compatible reasoning behavior was found/i],
    ['inconclusive', { warnings: ['no_compatible_profile_mapping'], candidateResults: [{ profileId: 'candidate', classification: 'Inconclusive', assignable: false }] }, /compatibility could not be confirmed/i],
    ['ambiguous', { warnings: ['ambiguous_profile_mapping'], candidateResults: [{ profileId: 'candidate', classification: 'Verified', assignable: true }] }, /multiple reasoning behaviors matched/i],
    ['heterogeneous', { warnings: ['no_compatible_profile_mapping'], candidateResults: [{ profileId: 'candidate', classification: 'Heterogeneous', assignable: false }] }, /multiple reasoning behaviors matched/i],
  ])('explains a %s route-only outcome without offering profile creation', async (_outcome, result, message) => {
    discoverMock.mockResolvedValueOnce({ route: 'mesh', classification: 'Inconclusive', assignable: false, accounting: { logicalProbes: 6, httpAttempts: 6 }, ...result });
    const { getByRole, queryByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /discover mesh compatibility/i }));
    await fireEvent.click(getByRole('button', { name: /check compatibility/i }));

    expect(await findByText(message)).toBeTruthy();
    expect(queryByLabelText('Profile name')).toBeNull();
  });

  it('does not expose discovery for a stored route missing from the gateway', async () => {
    const staleCurrent = { ...current, dynamicRoutes: ['mesh', 'retired'], routeContextWindows: { mesh: 262144, retired: 65536 } };
    const { getByRole, getByLabelText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={staleCurrent} />);
    await waitFor(() => expect((getByLabelText('mesh reasoning profile') as HTMLSelectElement).options.length).toBe(2));

    expect(getByRole('button', { name: /discover mesh compatibility/i })).toBeEnabled();
    expect(queryByRole('button', { name: /discover retired compatibility/i })).toBeNull();
  });

  it('keeps failed-family notices non-assignable and outside the primary route scan path', async () => {
    const { findByText, queryByRole, getByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    const disclosure = getByText(/known compatibility limitations/i).closest('details');
    expect(disclosure?.open).toBe(false);
    expect(queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });
});
