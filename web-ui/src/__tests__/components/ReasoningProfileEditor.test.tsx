import { cleanup, fireEvent, render, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields from '../../components/admin/EnvironmentAreaFields';
import ReasoningProfileEditor, { reasoningCheckSummary } from '../../components/admin/ReasoningProfileEditor';
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
async function openAdvanced(view: ReturnType<typeof standalone>) {
  await fireEvent.click(view.getByText('Advanced mapping controls'));
}

describe('REQ-ENTERPRISE-035/036 route-scoped profile discovery', () => {
  it('Map Profile starts exactly once, never persists on naming or creation, and assigns a canonical revision only to the mapped route', async () => {
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const view = render(() => <form onSubmit={submit}><EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} /></form>);
    await waitFor(() => expect((view.getByLabelText('mesh reasoning profile') as HTMLSelectElement).options.length).toBe(2));
    await fireEvent.click(view.getByRole('button', { name: 'Map Profile for mesh' }));
    await view.findByText('Compatible reasoning behavior found');
    expect(discoverMock).toHaveBeenCalledExactlyOnceWith({ route: 'mesh', maxCompletionTokens: 4096 });
    await fireEvent.input(view.getByLabelText('mesh context window'), { target: { value: '131072' } });
    expect(view.getByRole('button', { name: 'Map Profile for mesh' })).toBeDisabled();
    expect(discoverMock).toHaveBeenCalledTimes(1);
    await fireEvent.input(view.getByLabelText('Profile name'), { target: { value: 'Custom mesh' } });
    await fireEvent.keyDown(view.getByLabelText('Profile name'), { key: 'Enter' });
    await fireEvent.click(view.getByRole('button', { name: 'Create & Assign' }));
    expect(submit).not.toHaveBeenCalled();
    const draft = JSON.parse((view.container.querySelector('input[name="reasoningConfiguration"]') as HTMLInputElement).value);
    expect(draft.customProfileRevisions).toEqual([expect.objectContaining({ id: 'custom-mesh', name: 'Custom mesh', revision: 1, classification: 'Compatible, unverified', toolCompatibility: { status: 'unverified', levels: [] } })]);
    expect(draft.routeAssignments).toEqual({ mesh: { activeProfile: { id: 'custom-mesh', revision: 1, hash: draft.customProfileRevisions[0].hash } } });
    expect(parseReasoningConfiguration(draft)).toEqual(draft);
    expect(view.getByLabelText('mesh reasoning profile')).toHaveValue(`custom-mesh\u001f1\u001f${draft.customProfileRevisions[0].hash}`);
    expect(view.queryByRole('heading', { name: /discover compatibility/i })).toBeNull();
  });

  it('surfaces every named passing profile for explicit assignment without recommending an arbitrary first match', async () => {
    const matches = ['Kimi thinking', 'Mesh binary thinking', 'Saved custom reasoning'].map((name, i) => ({ name, profileRef: { id: `profile-${i}`, revision: i + 1, hash: String(i).repeat(64) }, supportedLevels: i === 0 ? ['medium', 'high'] : ['off', 'medium'] }));
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'existing-profile', matchedProfiles: matches });
    const view = standalone();
    await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    await view.findByRole('button', { name: 'Assign Kimi thinking' });
    for (const match of matches) expect(within(view.getByRole('button', { name: `Assign ${match.name}` }).parentElement!).getByText(`Supported levels: ${match.supportedLevels.join(', ')}`)).toBeInTheDocument();
    expect(view.queryByLabelText('Profile name')).toBeNull();
    expect(view.container).not.toHaveTextContent(/Recommended|model identified|identified model/i);
    expect(view.onSelectProfile).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Assign Saved custom reasoning' }));
    expect(view.onSelectProfile).toHaveBeenCalledExactlyOnceWith(matches[2].profileRef);
    expect(view.onSave).not.toHaveBeenCalled();
  });

  it.each(['32', '256', '4096', '16384'])('uses explicit ceiling %s, locks controls, and never retries automatically', async (budget) => {
    let complete!: (result: ReasoningDiscoveryResult) => void;
    discoverMock.mockReturnValueOnce(new Promise<ReasoningDiscoveryResult>((resolve) => { complete = resolve; }));
    const view = standalone();
    expect(view.getByText('Advanced mapping controls').closest('details')?.open).toBe(false);
    await openAdvanced(view);
    const ceiling = view.getByRole('spinbutton', { name: 'Discovery completion token ceiling' });
    expect(ceiling).toHaveValue(4096);
    expect(ceiling).toHaveAttribute('min', '32'); expect(ceiling).toHaveAttribute('max', '16384');
    await fireEvent.input(ceiling, { target: { value: budget } });
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(discoverMock).toHaveBeenCalledExactlyOnceWith({ route: 'mesh', maxCompletionTokens: Number(budget) });
    expect(ceiling).toBeDisabled();
    complete({ classification: 'Inconclusive', assignable: false, outcome: 'inconclusive', diagnostics: [{ levels: ['high'], stage: 'tool-replay', code: 'completion_limit' }] });
    expect(await view.findByRole('alert')).toHaveTextContent(/incomplete at the chosen token budget/i);
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });
  it.each(['', '31', '16385', '32.5', '-1'])('rejects invalid ceiling %j before provider I/O', async (budget) => {
    const view = standalone(); await openAdvanced(view);
    await fireEvent.input(view.getByRole('spinbutton', { name: 'Discovery completion token ceiling' }), { target: { value: budget } });
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(await view.findByRole('alert')).toHaveTextContent(/whole number from 32 to 16384/i);
    expect(discoverMock).not.toHaveBeenCalled();
  });
  it.each([
    ['no_tool_call', /did not return the required Pi tool call/i], ['invalid_tool_call', /invalid Pi tool call/i],
    ['replay_rejected', /rejected the Pi tool-result replay/i], ['request_rejected', /rejected the compatibility request/i],
    ['off_not_disabled', /reasoning remained enabled when checking Off/i], ['unsupported_mapping', /observed reasoning mapping is not supported/i],
    ['timeout', /timed out/i], ['transport_error', /connection failed/i], ['malformed_response', /malformed response/i],
    ['response_too_large', /safe size limit/i], ['incomplete_final_response', /did not complete the final response/i],
  ])('reports concrete %s failure without inventing a draft or exposing raw data', async (code, message) => {
    discoverMock.mockResolvedValueOnce({ classification: 'Inconclusive', assignable: false, outcome: 'inconclusive', profileDraft: discoveredDraft, diagnostics: [{ code, levels: ['medium'], stage: 'tool-replay', body: 'PRIVATE' }], normalizedDraft: { raw: 'PRIVATE' } });
    const view = standalone(); await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(await view.findByRole('alert')).toHaveTextContent(message);
    expect(view.queryByLabelText('Profile name')).toBeNull();
    expect(view.onSave).not.toHaveBeenCalled();
    expect(view.container).not.toHaveTextContent('PRIVATE');
    expect(view.container.querySelector('textarea, pre')).toBeNull();
  });
  it('prioritizes fatal gateway failure over earlier budget exhaustion', () => {
    expect(reasoningCheckSummary({ classification: 'Inconclusive', assignable: false, diagnostics: [{ levels: ['high'], stage: 'tool-call', code: 'completion_limit' }, { levels: ['off'], stage: 'reasoning', code: 'request_rejected', status: 401 }] })).toMatch(/401/);
  });
  it('surfaces candidate-only budget exhaustion as incomplete and discloses profile names, levels, and stages', async () => {
    discoverMock.mockResolvedValueOnce({ classification: 'Unsupported', assignable: false, candidateResults: [{ profileName: 'Kimi thinking', classification: 'Unsupported', assignable: false, verifiedLevels: ['medium'], diagnostics: [{ code: 'completion_limit', levels: ['high'], stage: 'tool-replay' }] }] });
    const view = standalone(); await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(await view.findByRole('alert')).toHaveTextContent(/incomplete at the chosen token budget/i);
    const details = view.getByText('Technical check details').closest('details')!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent('Kimi thinking');
    expect(details).toHaveTextContent('Verified levels: medium');
    expect(details).toHaveTextContent('Levels: high');
    expect(details).toHaveTextContent('Stage: tool-replay');
    expect(view.queryByLabelText('Profile name')).toBeNull();
  });
  it('reports an empty supported-level list instead of rendering a blank value', async () => {
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'custom-profile', profileDraft: { ...discoveredDraft, supportedLevels: [] } });
    const view = standalone(); await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(await view.findByText('Supported levels: Not reported')).toBeInTheDocument();
    await fireEvent.input(view.getByLabelText('Profile name'), { target: { value: 'Empty' } });
    await fireEvent.click(view.getByRole('button', { name: 'Create & Assign' }));
    expect(view.onSave).not.toHaveBeenCalled();
    expect(await view.findByRole('alert')).toHaveTextContent(/could not be prepared/i);
  });
  it('does not expose discovery for a stored route missing from the gateway', async () => {
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={{ ...current, dynamicRoutes: ['mesh', 'retired'] }} />);
    await waitFor(() => expect((view.getByLabelText('mesh reasoning profile') as HTMLSelectElement).options.length).toBe(2));
    expect(view.getByRole('button', { name: 'Map Profile for mesh' })).toBeEnabled();
    expect(view.queryByRole('button', { name: 'Map Profile for retired' })).toBeNull();
  });
  it('keeps failed-family notices non-assignable and outside the primary route scan path', async () => {
    const view = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await waitFor(() => expect((view.getByLabelText('mesh reasoning profile') as HTMLSelectElement).options.length).toBe(2));
    expect(view.getByText('GPT-OSS tool replay').closest('details')?.open).toBe(false);
    expect(view.queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });
  it('keeps failed candidate diagnostics collapsed when an existing profile matches', async () => {
    discoverMock.mockResolvedValueOnce({ classification: 'Verified', assignable: true, outcome: 'existing-profile', matchedProfiles: [{ profileRef: { id: 'kimi', revision: 1, hash: 'a'.repeat(64) }, name: 'Kimi thinking', supportedLevels: ['medium'] }], candidateResults: [{ profileId: 'internal-protocol-id', classification: 'Unsupported', assignable: false, diagnostics: [{ code: 'off_not_disabled', levels: ['off'], stage: 'reasoning' }] }] });
    const view = standalone(); await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    await view.findByRole('button', { name: 'Assign Kimi thinking' });
    expect(view.getByText(/reasoning remained enabled when checking Off/i).closest('details')?.open).toBe(false);
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.container).not.toHaveTextContent('internal-protocol-id');
  });
  it.each([
    ['unsupported', /no compatible reasoning behavior/i], ['inconclusive', /compatibility could not be confirmed/i], ['ambiguous', /multiple reasoning behaviors matched/i],
  ])('explains a %s route-only outcome without offering profile creation', async (outcome, message) => {
    discoverMock.mockResolvedValueOnce({ classification: 'Inconclusive', assignable: false, outcome });
    const view = standalone(); await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(await view.findByRole('alert')).toHaveTextContent(message);
    expect(view.queryByLabelText('Profile name')).toBeNull();
  });
  it('does not expose provider response bodies from failed requests', async () => {
    discoverMock.mockRejectedValueOnce(new Error('PRIVATE PROVIDER BODY'));
    const view = standalone(); await openAdvanced(view);
    await fireEvent.click(view.getByRole('button', { name: 'Check compatibility' }));
    expect(await view.findByRole('alert')).toHaveTextContent(/compatibility check failed.*saved AI Gateway connection/i);
    expect(view.container).not.toHaveTextContent('PRIVATE');
  });
});
