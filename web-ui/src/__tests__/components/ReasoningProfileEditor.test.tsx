import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';

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
    matchedCandidateProfileId: 'workers-ai-gemma-thinking',
    accounting: { logicalProbes: 5, httpAttempts: 12 },
    profileDraft: discoveredDraft,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-035/036 route-scoped profile discovery', () => {
  it('uses one route-scoped discovery flow without exposing model-family candidate labels', async () => {
    const { getByRole, getByLabelText, queryByLabelText, queryByText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /discover mesh compatibility/i }));

    expect(getByRole('heading', { name: /discover compatibility for mesh/i })).toBeTruthy();
    expect(queryByLabelText('Dynamic route')).toBeNull();
    expect(queryByLabelText('Profile name')).toBeNull();

    await fireEvent.click(getByRole('button', { name: /check compatibility/i }));
    expect(discoverMock).toHaveBeenCalledWith({ route: 'mesh', maxCompletionTokens: 512 });
    expect(await findByText(/compatible reasoning behavior found/i)).toBeTruthy();
    expect(queryByText('workers-ai-gemma-thinking')).toBeNull();
    expect(getByLabelText('Profile name')).toBeTruthy();
    expect(getByRole('button', { name: /continue to review/i })).toBeTruthy();
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
