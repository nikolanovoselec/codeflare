import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields from '../../components/admin/EnvironmentAreaFields';
import ReasoningProfileEditor, { DISCOVERY_COMPLETION_TOKENS, ReasoningCheckOverview, reasoningCheckSummary } from '../../components/admin/ReasoningProfileEditor';
import { parseReasoningConfiguration } from '../../../../src/lib/reasoning-configuration';
import type { ReasoningDiscoveryResult } from '../../types';

const { catalogMock, discoverMock } = vi.hoisted(() => ({ catalogMock: vi.fn(), discoverMock: vi.fn() }));
vi.mock('../../api/client', () => ({ getReasoningCatalog: (...args: unknown[]) => catalogMock(...args), getReasoningRouteInventory: vi.fn(), discoverReasoningCompatibility: (...args: unknown[]) => discoverMock(...args) }));
const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', dynamicRoutes: ['mesh', 'other'],
  defaultRoute: { route: 'mesh', reasoning: 'medium' }, routeContextWindows: { mesh: 262144, other: 65536 },
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }, groupRouting: [],
};
const discoveredDraft = {
  schemaVersion: 1, enabled: true, ingressContract: 'ai-gateway-chat-completions', supportedLevels: ['off', 'medium'],
  removePaths: ['reasoning_effort'], levels: { off: [{ path: 'reasoning_effort', value: 'none' }], medium: [{ path: 'reasoning_effort', value: 'medium' }] },
  aliases: {}, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' },
  recognizedResponseFields: { content: ['choices[].message.content'] }, classification: 'Compatible, unverified',
  toolCompatibility: { status: 'unverified', levels: [] }, validatedTransports: [],
  originallyCreatedAgainst: { route: 'mesh' }, evidence: [{ current: true, toolReplay: true, route: 'mesh' }], limitations: [],
};
beforeEach(() => {
  catalogMock.mockResolvedValue({ schemaVersion: 1, profiles: [{ id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: 'a'.repeat(64), name: 'Mesh binary thinking', supportedLevels: ['off', 'medium'] }], notices: [{ id: 'gpt-oss-tool-replay', name: 'GPT-OSS tool replay', assignable: false }], usage: [], routes: ['mesh', 'other'], routeCatalogStatus: 'ready' });
  discoverMock.mockResolvedValue({ route: 'mesh', classification: 'Verified', assignable: true, outcome: 'custom-profile', profileDraft: discoveredDraft });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function standalone() {
  const onSave = vi.fn(); const onSelectProfile = vi.fn();
  return { ...render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onSave={onSave} onSelectProfile={onSelectProfile} onCancel={vi.fn()} />), onSave, onSelectProfile };
}

describe('REQ-ENTERPRISE-035/036 route-scoped profile discovery', () => {
  it('REQ-ENTERPRISE-035: offers completed matches with a rate-limit notice without retrying', async () => {
    const profileRef = { id: 'workers-ai-glm-thinking', revision: 1, hash: 'a'.repeat(64) };
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'existing-profile', matchedProfiles: [{ name: 'GLM thinking', profileRef, supportedLevels: ['off', 'medium'] }], diagnostics: [{ code: 'request_rejected', status: 429, stage: 'reasoning', levels: ['high'] }] });
    const view = standalone();
    const assign = await view.findByRole('button', { name: 'Assign profile' });
    expect(view.getByText('The remaining checks stopped because of rate limiting. Completed matches are shown below; no automatic retry was made.')).toBeVisible();
    await fireEvent.click(assign);
    expect(view.onSelectProfile).toHaveBeenCalledExactlyOnceWith(profileRef);
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(view.onSave).not.toHaveBeenCalled();
  });
  it('REQ-ENTERPRISE-045: matched predefined profiles identify their tested provider without changing the selected ref', async () => {
    const profileRef = { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: 'a'.repeat(64) };
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'existing-profile', matchedProfiles: [{ name: 'Mesh binary thinking', profileRef, supportedLevels: ['off', 'medium'] }] });
    const view = standalone();
    const assign = await view.findByRole('button', { name: 'Assign profile' });
    expect(assign).toHaveAccessibleDescription('Codeflare Inference Mesh · Qwen / Ornith');
    await fireEvent.click(assign);
    expect(view.onSelectProfile).toHaveBeenCalledExactlyOnceWith(profileRef);
  });
  it('REQ-ENTERPRISE-042: mapping carries the transient connection and backend context without saving', async () => {
    const context = { gateway: { gatewayUrl: current.gatewayUrl, replacementToken: 'draft-test-token' }, backendDescriptions: { primary: 'Mesh primary' } };
    const onSave = vi.fn();
    const view = render(() => <ReasoningProfileEditor route="mesh" context={context} existingRevisions={[]} onSave={onSave} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    await view.findByRole('button', { name: 'Create & Assign' });
    expect(discoverMock).toHaveBeenCalledExactlyOnceWith({ route: 'mesh', ...context, maxCompletionTokens: 4096 });
    expect(onSave).not.toHaveBeenCalled();
  });
  it('Discover Profile starts exactly once and creates a canonical route draft without submitting Save', async () => {
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const view = render(() => <form onSubmit={submit}><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await waitFor(() => expect((view.getByLabelText('mesh Pi compatibility profile') as HTMLSelectElement).options.length).toBe(2));
    await fireEvent.click(view.getByRole('button', { name: 'Configure mesh' }));
    await fireEvent.click(view.getByRole('button', { name: 'Discover Profile for mesh' }));
    await view.findByText('Create a custom Pi profile');
    expect(discoverMock).toHaveBeenCalledExactlyOnceWith({ route: 'mesh', maxCompletionTokens: 4096 });
    await fireEvent.input(view.getByLabelText('mesh context window'), { target: { value: '131072' } });
    expect(view.getByRole('button', { name: 'Discover Profile for mesh' })).toBeDisabled();
    await fireEvent.input(view.getByLabelText('Profile name'), { target: { value: 'Custom mesh' } });
    await fireEvent.keyDown(view.getByLabelText('Profile name'), { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Create & Assign' }));
    expect(submit).not.toHaveBeenCalled();
    expect(discoverMock).toHaveBeenCalledTimes(1);
    const draft = JSON.parse((view.container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
    expect(draft.customProfileRevisions).toEqual([expect.objectContaining({ id: 'custom-mesh', name: 'Custom mesh', revision: 1, classification: 'Compatible, unverified', toolCompatibility: { status: 'unverified', levels: [] } })]);
    expect(draft.routeAssignments).toEqual({ mesh: { activeProfile: { id: 'custom-mesh', revision: 1, hash: draft.customProfileRevisions[0].hash } } });
    expect(parseReasoningConfiguration(draft)).toEqual(draft);
    expect(view.getByLabelText('mesh Pi compatibility profile')).toHaveValue(`custom-mesh\u001f1\u001f${draft.customProfileRevisions[0].hash}`);
    expect(view.queryByRole('heading', { name: /discover compatibility/i })).toBeNull();
  });
  it('REQ-ENTERPRISE-044: finishes the busy state without requiring the result panel to close', async () => {
    let complete!: (result: ReasoningDiscoveryResult) => void;
    discoverMock.mockReturnValueOnce(new Promise<ReasoningDiscoveryResult>((resolve) => { complete = resolve; }));
    const busy = vi.fn();
    const view = render(() => <ReasoningProfileEditor route="mesh" existingRevisions={[]} onBusyChange={busy} onSave={vi.fn()} onSelectProfile={vi.fn()} onCancel={vi.fn()} />);
    expect(busy).toHaveBeenLastCalledWith(true);
    complete({ classification: 'Unsupported', assignable: false });
    await view.findByRole('alert');
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(view.getByRole('heading', { name: 'Discover compatibility for mesh' })).toBeVisible();
  });
  it('starts on mount with fixed 4096 and offers no second start or token input, including after incomplete results', async () => {
    let complete!: (result: ReasoningDiscoveryResult) => void;
    discoverMock.mockReturnValueOnce(new Promise<ReasoningDiscoveryResult>((resolve) => { complete = resolve; }));
    const view = standalone();
    expect(DISCOVERY_COMPLETION_TOKENS).toBe(4096);
    expect(discoverMock).toHaveBeenCalledExactlyOnceWith({ route: 'mesh', maxCompletionTokens: 4096 });
    expect(view.getByRole('status')).toHaveTextContent('Discovering profiles');
    expect(view.queryByRole('spinbutton')).toBeNull();
    expect(view.queryByRole('button', { name: /check compatibility|checking/i })).toBeNull();
    expect(view.queryByText('Advanced mapping controls')).toBeNull();
    complete({ classification: 'Inconclusive', assignable: false, diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'completion_limit' }] });
    expect(await view.findByRole('alert')).toHaveTextContent(/incomplete at the fixed 4096-token budget/i);
    expect(view.container).not.toHaveTextContent(/increase|edit.*ceiling/i);
    expect(view.container.querySelectorAll('details')).toHaveLength(0);
    expect(view.queryByRole('spinbutton')).toBeNull();
    expect(view.queryByRole('button', { name: /check compatibility/i })).toBeNull();
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });
  it('keeps route-only draft mapping free of selected-profile checks', async () => {
    const view = standalone();
    await view.findByRole('button', { name: 'Create & Assign' });
    expect(view.queryByRole('table', { name: 'Selected profile checks' })).toBeNull();
    expect(view.container.querySelector('.admin-check-pill')).toBeNull();
    await fireEvent.input(view.getByLabelText('Profile name'), { target: { value: 'Named draft' } });
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(view.onSave).not.toHaveBeenCalled();
  });
  it('names each match row and describes identically named Assign profile buttons without changing immutable refs', async () => {
    const matches = ['Kimi thinking', 'Mesh binary thinking', 'Saved custom reasoning'].map((name, i) => ({ name, profileRef: { id: `profile-${i}`, revision: i + 1, hash: String(i).repeat(64) }, supportedLevels: ['off', 'medium'] }));
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'existing-profile', matchedProfiles: matches });
    const view = standalone();
    const buttons = await view.findAllByRole('button', { name: 'Assign profile' });
    expect(buttons).toHaveLength(3);
    matches.forEach((match, index) => {
      const row = buttons[index].closest('.admin-profile-match')!;
      expect(within(row as HTMLElement).getByText(match.name)).toBeInTheDocument();
      expect(row).toHaveTextContent(`Supported levels: ${match.supportedLevels.join(', ')}`);
      expect(buttons[index]).toHaveAccessibleDescription(match.name);
    });
    expect(view.queryByLabelText('Profile name')).toBeNull();
    expect(view.container).not.toHaveTextContent(/recommended|model identified|identified model/i);
    expect(view.onSelectProfile).not.toHaveBeenCalled();
    await fireEvent.click(buttons[2]);
    expect(view.onSelectProfile).toHaveBeenCalledExactlyOnceWith(matches[2].profileRef);
    expect(matches[2].profileRef.hash).toBe('2'.repeat(64));
    expect(view.onSave).not.toHaveBeenCalled();
  });
  it.each([
    ['no_tool_call', /did not return the required Pi tool call/i], ['invalid_tool_call', /invalid Pi tool call/i],
    ['replay_rejected', /rejected the Pi tool-result replay/i], ['request_rejected', /rejected the compatibility request/i],
    ['off_not_disabled', /reasoning remained enabled when checking Off/i], ['unsupported_mapping', /observed reasoning mapping is not supported/i],
    ['timeout', /timed out/i], ['transport_error', /connection failed/i], ['malformed_response', /malformed response/i],
    ['response_too_large', /safe size limit/i], ['incomplete_final_response', /did not complete the final response/i],
  ])('reports concrete %s failure without exposing raw data', async (code, message) => {
    discoverMock.mockResolvedValueOnce({ classification: 'Inconclusive', assignable: false, profileDraft: discoveredDraft, diagnostics: [{ code, levels: ['medium'], stage: 'tool-replay', body: 'PRIVATE' }], normalizedDraft: { raw: 'PRIVATE' } });
    const view = standalone();
    expect(await view.findByRole('alert')).toHaveTextContent(message);
    expect(view.queryByLabelText('Profile name')).toBeNull();
    expect(view.onSave).not.toHaveBeenCalled();
    expect(view.container).not.toHaveTextContent('PRIVATE');
    expect(view.container.querySelector('textarea, pre')).toBeNull();
  });
  it('prioritizes fatal gateway failure over earlier budget exhaustion', () => {
    expect(reasoningCheckSummary({ classification: 'Inconclusive', diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'completion_limit' }, { levels: ['off'], stage: 'reasoning', code: 'request_rejected', status: 401 }] })).toMatch(/401/);
  });
  it('shows an actionable incomplete result without candidate diagnostics or counters', async () => {
    discoverMock.mockResolvedValueOnce({ route: 'mesh', classification: 'Unsupported', assignable: false, requestedCompletionCeiling: 4096, accounting: { logicalProbes: 3, httpAttempts: 5 }, candidateResults: [{ profileName: 'Kimi thinking', classification: 'Unsupported', assignable: false, verifiedLevels: ['medium'], diagnostics: [{ code: 'completion_limit', levels: ['high'], stage: 'tool-replay' }] }] });
    const view = standalone();
    expect(await view.findByRole('alert')).toHaveTextContent(/incomplete at the fixed 4096-token budget/i);
    expect(view.queryByText('Technical check details')).toBeNull();
    expect(view.queryByText('Kimi thinking')).toBeNull();
    expect(view.container).not.toHaveTextContent('Logical probes');
    expect(view.queryByLabelText('Profile name')).toBeNull();
  });
  it('reports empty supported levels and refuses an invalid canonical draft', async () => {
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'custom-profile', profileDraft: { ...discoveredDraft, supportedLevels: [] } });
    const view = standalone();
    expect(await view.findByText('Supported levels: Not reported')).toBeInTheDocument();
    await fireEvent.input(view.getByLabelText('Profile name'), { target: { value: 'Empty' } });
    await fireEvent.click(view.getByRole('button', { name: 'Create & Assign' }));
    expect(view.onSave).not.toHaveBeenCalled();
    expect(await view.findByRole('alert')).toHaveTextContent(/could not be prepared/i);
  });
  it('does not expose discovery for a stored route missing from the gateway', async () => {
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={{ ...current, dynamicRoutes: ['mesh', 'retired'] }} />);
    await waitFor(() => expect((view.getByLabelText('mesh Pi compatibility profile') as HTMLSelectElement).options.length).toBe(2));
    await fireEvent.click(view.getByRole('button', { name: 'Configure mesh' }));
    expect(view.getByRole('button', { name: 'Discover Profile for mesh' })).toBeEnabled();
    await fireEvent.click(view.getByRole('button', { name: 'Configure retired' }));
    expect(view.getByRole('button', { name: 'Discover Profile for retired' })).toBeDisabled();
    expect(discoverMock).not.toHaveBeenCalled();
  });
  it('keeps failed-family notices non-assignable and outside the primary route scan path', async () => {
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((view.getByLabelText('mesh Pi compatibility profile') as HTMLSelectElement).options.length).toBe(2));
    expect(view.getByText('GPT-OSS tool replay').closest('details')?.open).toBe(false);
    expect(view.queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });
  it('keeps Gemma Off failures scoped to Gemma instead of coloring the matched GPT profile', async () => {
    const diagnostic = { code: 'off_not_disabled', levels: ['off'], stage: 'reasoning' };
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'existing-profile', diagnostics: [diagnostic], matchedProfiles: [{ profileRef: { id: 'gpt', revision: 1, hash: 'a'.repeat(64) }, name: 'GPT reasoning', supportedLevels: ['off', 'medium'] }], candidateResults: [{ profileId: 'internal-protocol-id', profileName: 'Gemma reasoning', classification: 'Unsupported', assignable: false, diagnostics: [diagnostic] }] });
    const view = standalone();
    const assign = await view.findByRole('button', { name: 'Assign profile' });
    expect(assign).toHaveAccessibleDescription('GPT reasoning');
    expect(view.queryByText('Gemma reasoning')).toBeNull();
    expect(view.queryByText('Technical check details')).toBeNull();
    expect(assign.closest('.admin-profile-match')!.querySelector('.admin-check-pill')).toBeNull();
    expect(view.queryByRole('table', { name: 'Selected profile checks' })).toBeNull();
    expect(view.container.querySelector('.admin-check-pill')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.container).not.toHaveTextContent('internal-protocol-id');
  });
  it.each([['unsupported', /no compatible reasoning behavior/i], ['inconclusive', /compatibility could not be confirmed/i], ['ambiguous', /multiple reasoning behaviors matched/i]])('explains %s without offering creation', async (outcome, message) => {
    discoverMock.mockResolvedValueOnce({ classification: 'Inconclusive', assignable: false, outcome });
    const view = standalone();
    expect(await view.findByRole('alert')).toHaveTextContent(message);
    expect(view.queryByLabelText('Profile name')).toBeNull();
  });
  it('does not expose provider response bodies from failed requests', async () => {
    discoverMock.mockRejectedValueOnce(new Error('PRIVATE PROVIDER BODY'));
    const view = standalone();
    expect(await view.findByRole('alert')).toHaveTextContent(/compatibility check failed.*AI Gateway connection/i);
    expect(view.container).not.toHaveTextContent('PRIVATE');
  });
});

describe('REQ-ENTERPRISE-035 evidence-backed check overview', () => {
  function checkCell(table: HTMLElement, level: string, check: string, state: 'Passed' | 'Failed' | 'Unclear') {
    const row = within(table).getByRole('rowheader', { name: level }).closest('tr')!;
    const cell = within(row).getByRole('cell', { name: `${level} ${check}: ${state}` });
    const pill = within(cell).getByLabelText(`${level} ${check}: ${state}`);
    expect(pill).toHaveTextContent(new RegExp(`^${state}$`));
    expect(pill).toHaveAttribute('data-state', state.toLowerCase());
  }
  it('uses one row per level with associated headers and never passes classification alone', () => {
    const view = render(() => <ReasoningCheckOverview result={{ classification: 'Verified', assignable: true }} levels={['off', 'medium']} />);
    const table = view.getByRole('table', { name: 'Selected profile checks' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Level', 'Compatibility', 'Tool call', 'Tool replay']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    for (const level of ['Off', 'Medium']) for (const check of ['compatibility', 'tool call', 'tool replay']) checkCell(table, level, check, 'Unclear');
    expect(view.container.querySelector('[data-state="passed"]')).toBeNull();
    expect(view.queryByLabelText('Reasoning strength: Unclear')).toBeNull();
  });
  it('associates passed, failed, and incomplete checks with their exact level and stage', () => {
    const result: ReasoningDiscoveryResult = { classification: 'Verified', compatibleLevels: ['medium'], piCompatibility: { status: 'partial', verifiedLevels: ['medium'], failedLevels: ['off', 'high'] }, reasoningConfiguration: { off: 'not-disabled', graduatedEffort: 'not-proven-by-discovery' }, diagnostics: [{ levels: ['off'], stage: 'reasoning', code: 'off_not_disabled' }, { levels: ['high'], stage: 'tool-replay', code: 'completion_limit' }], distinctMappings: [{ levels: ['medium'], toolLifecycle: { passed: true, stage: 'complete' } }] };
    const view = render(() => <ReasoningCheckOverview result={result} levels={['off', 'medium', 'high']} />);
    const table = view.getByRole('table', { name: 'Selected profile checks' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    checkCell(table, 'Medium', 'compatibility', 'Passed');
    checkCell(table, 'Off', 'compatibility', 'Failed');
    checkCell(table, 'High', 'compatibility', 'Unclear');
    checkCell(table, 'Medium', 'tool call', 'Passed');
    checkCell(table, 'Medium', 'tool replay', 'Passed');
    const off = view.getByLabelText('Off disabled: Failed');
    expect(off).toHaveAttribute('data-state', 'failed');
    expect(table).not.toContainElement(off);
    expect(view.queryByLabelText('Reasoning strength: Unclear')).toBeNull();
  });
  it('gives diagnostics priority and leaves unattempted replay unclear without an irrelevant Off control', () => {
    const view = render(() => <ReasoningCheckOverview result={{ classification: 'Verified', compatibleLevels: ['medium'], diagnostics: [{ levels: ['medium'], stage: 'tool-call', code: 'no_tool_call' }] }} levels={['medium']} />);
    const table = view.getByRole('table', { name: 'Selected profile checks' });
    checkCell(table, 'Medium', 'compatibility', 'Failed');
    checkCell(table, 'Medium', 'tool call', 'Failed');
    checkCell(table, 'Medium', 'tool replay', 'Unclear');
    expect(view.queryByLabelText('Off disabled: Unclear')).toBeNull();
  });
  it.each([
    ['tool-replay', 'replay_rejected', 'Failed'],
    ['final-response', 'completion_limit', 'Unclear'],
  ] as const)('retains successful tool-call evidence when %s does not complete', (stage, code, replayState) => {
    const result: ReasoningDiscoveryResult = { classification: 'Unsupported', diagnostics: [{ levels: ['medium'], stage: 'tool-replay', code }],
      distinctMappings: [{ levels: ['medium'], toolLifecycle: { passed: false, stage } }],
      piCompatibility: { status: 'partial', verifiedLevels: [], failedLevels: ['medium'] } };
    const view = render(() => <ReasoningCheckOverview result={result} levels={['medium']} />);
    const table = view.getByRole('table', { name: 'Selected profile checks' });
    checkCell(table, 'Medium', 'tool call', 'Passed');
    checkCell(table, 'Medium', 'tool replay', replayState);
    checkCell(table, 'Medium', 'compatibility', replayState);
  });

  it('does not equate a Pi tool pass with verified Off or reasoning configuration', () => {
    const view = render(() => <ReasoningCheckOverview result={{ classification: 'Verified', piCompatibility: { status: 'verified', verifiedLevels: ['off', 'medium'], failedLevels: [] } }} levels={['off', 'medium']} />);
    const table = view.getByRole('table', { name: 'Selected profile checks' });
    checkCell(table, 'Off', 'compatibility', 'Unclear');
    checkCell(table, 'Off', 'tool call', 'Passed');
    checkCell(table, 'Off', 'tool replay', 'Passed');
    expect(view.getByLabelText('Off disabled: Unclear')).toHaveAttribute('data-state', 'unclear');
    expect(view.queryByLabelText('Reasoning strength: Unclear')).toBeNull();
  });
});
