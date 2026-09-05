import { cleanup, fireEvent, render } from '@solidjs/testing-library';
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
  classification: 'Verified',
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
    matchedCandidateProfileId: 'openai-gpt-chat-tools-reasoning',
    accounting: { logicalProbes: 5, httpAttempts: 12 },
    profileDraft: discoveredDraft,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-031 discovery-created custom profile workflow', () => {
  it('asks only for an auto-discovered route, runs deterministic discovery, then asks for a name', async () => {
    const { getByRole, getByLabelText, queryByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));

    expect(getByLabelText('Dynamic route')).toHaveValue('mesh');
    expect(queryByLabelText('Profile name')).toBeNull();
    expect(queryByLabelText(/property path/i)).toBeNull();

    await fireEvent.click(getByRole('button', { name: /run profile discovery/i }));
    expect(discoverMock).toHaveBeenCalledWith({ route: 'mesh', maxCompletionTokens: 512 });
    expect(await findByText(/verified compatibility/i)).toBeTruthy();
    expect(getByLabelText('Profile name')).toBeTruthy();
  });

  it('creates a named immutable revision from the discovered mapping without assigning or activating it', async () => {
    const { container, getByRole, getByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    await fireEvent.click(getByRole('button', { name: /run profile discovery/i }));
    await findByText(/verified compatibility/i);
    await fireEvent.input(getByLabelText('Profile name'), { target: { value: 'Custom mesh' } });
    await fireEvent.click(getByRole('button', { name: /add discovered profile to draft/i }));

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

  it('does not offer saving when discovery cannot produce an assignable profile', async () => {
    discoverMock.mockResolvedValueOnce({ route: 'mesh', classification: 'Inconclusive', assignable: false, accounting: { logicalProbes: 6, httpAttempts: 6 } });
    const { getByRole, queryByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    await fireEvent.click(getByRole('button', { name: /run profile discovery/i }));

    expect(await findByText(/no unambiguous compatible profile mapping was discovered/i)).toBeTruthy();
    expect(queryByLabelText('Profile name')).toBeNull();
    expect(queryByLabelText(/property path/i)).toBeNull();
  });

  it('uses only routes returned by the saved-credential catalog', async () => {
    const { getByRole, getByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    const options = Array.from((getByLabelText('Dynamic route') as HTMLSelectElement).options, (option) => option.value);
    expect(options).toEqual(['mesh']);
  });

  it('renders failed families as non-assignable compatibility notices', async () => {
    const { findByText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    expect(await findByText('GPT-OSS tool replay')).toBeTruthy();
    expect(queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });
});
