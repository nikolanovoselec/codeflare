import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';

const catalogMock = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => catalogMock(...args),
  getReasoningRouteInventory: vi.fn(),
  discoverReasoningCompatibility: vi.fn(),
}));

const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  dynamicRoutes: ['mesh'],
  defaultRoute: { route: 'mesh', reasoning: 'medium' },
  routeContextWindows: { mesh: 262144 },
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
  groupRouting: [],
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-ENTERPRISE-031 typed custom profile workflow', () => {
  it('creates mappings with typed scalar rows and aliases without an editable JSON field', async () => {
    const { getByRole, getByLabelText, queryByRole, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    expect(getByLabelText('Profile name')).toBeTruthy();
    expect(getByLabelText('Supported reasoning levels')).toBeTruthy();
    expect(getByRole('button', { name: /add mapping row/i })).toBeTruthy();
    expect(getByLabelText('Mapping value type')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: /alias reasoning level/i }));
    expect(getByLabelText('Alias level')).toBeTruthy();
    expect(getByLabelText('Alias target')).toBeTruthy();
    expect(queryByRole('textbox', { name: /json/i })).toBeNull();
  });

  it('normalizes scalar types and aliases into a read-only preview', async () => {
    const { getByRole, getByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    await fireEvent.change(getByLabelText('Mapping value type'), { target: { value: 'boolean' } });
    await fireEvent.change(getByLabelText('Mapping boolean value'), { target: { value: 'true' } });
    const preview = getByLabelText('Normalized wire preview') as HTMLTextAreaElement;
    expect(preview).toHaveAttribute('readonly');
    expect(JSON.parse(preview.value).levels.medium[0].value).toBe(true);
  });

  it('serializes a typed custom revision and explicit alias without editable JSON', async () => {
    const { container, getByRole, getByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    await fireEvent.input(getByLabelText('Profile ID'), { target: { value: 'custom-mesh' } });
    await fireEvent.input(getByLabelText('Profile name'), { target: { value: 'Custom mesh' } });
    await fireEvent.click(getByRole('button', { name: /alias reasoning level/i }));
    await fireEvent.click(getByRole('button', { name: /add immutable revision to draft/i }));

    const form = document.createElement('form');
    form.append(container.firstElementChild!);
    const values = environmentValues('aiRouting', 'enterprise', new FormData(form)) as Record<string, any>;
    expect(values.reasoningConfiguration.customProfileRevisions[0]).toMatchObject({
      id: 'custom-mesh',
      name: 'Custom mesh',
      revision: 1,
      levels: { medium: [{ path: 'reasoning_effort', value: 'medium' }] },
      aliases: { minimal: 'medium' },
      offSemantics: { status: 'unsupported' },
    });
  });

  it('shows off semantics, limitations, immutable provenance, and a read-only wire preview', async () => {
    const { getByRole, getByText, getByLabelText, findByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await findByText(/Mesh binary thinking/);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    expect(getByLabelText('Off semantics')).toBeTruthy();
    expect(getByText('Immutable revision 1')).toBeTruthy();
    expect(getByRole('heading', { name: 'Limitations' })).toBeTruthy();
    expect(getByLabelText('Provenance provider')).toBeTruthy();
    expect(getByLabelText('Normalized wire preview')).toHaveAttribute('readonly');
  });

  it('renders failed families as non-assignable compatibility notices', async () => {
    const { findByText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    expect(await findByText('GPT-OSS tool replay')).toBeTruthy();
    expect(queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });
});
