/**
 * Component behavior with controlled API responses: enterprise gating, honest load/error states,
 * distinct approval/enablement actions, policy edits and one-time key handling. Real HTTP validation
 * and backend authorization are exercised by the API-client and server route suites respectively.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorDetails, OperatorPolicyInput, OperatorRegistration } from '../../api/operators';

const state = vi.hoisted(() => ({ mode: 'enterprise' }));
const api = vi.hoisted(() => ({ listOperators: vi.fn(), getOperator: vi.fn(), registerOperator: vi.fn(),
  discoverOperator: vi.fn(), approveOperator: vi.fn(), setOperatorEnabled: vi.fn(), setOperatorDistribution: vi.fn(),
  setOperatorPolicy: vi.fn(), rotateOperatorWebhookKey: vi.fn() }));
vi.mock('../../api/operators', () => api);
vi.mock('../../components/admin/AdministrationLayout', () => ({ useAdministration: () => ({ mode: state.mode }) }));
import OperatorsPage from '../../components/admin/OperatorsPage';

const policy: OperatorPolicyInput = { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
    reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } };
const registration: OperatorRegistration = { operatorId: 'operator', revision: 2, enabled: false, approvedArtifactDigest: null };
const manifestJson = JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'operator', name: 'Example operator',
  description: 'Private fixture', coreVersion: '1', intentVersion: '1', inputSchema: {}, requiredCapabilities: [],
  artifact: { path: '/bundle.json', url: 'https://operator.example.test/bundle.json', sha256: 'a'.repeat(64) } });
const details: OperatorDetails = { registration, endpoint: 'https://operator.example.test/discovery', connectionSecretConfigured: true,
  webhookKeyConfigured: false, discoveredManifestJson: manifestJson, approvedManifestJson: null, policyJson: JSON.stringify(policy) };

beforeEach(() => {
  vi.resetAllMocks(); state.mode = 'enterprise';
  api.listOperators.mockResolvedValue({ operators: [registration] });
  api.getOperator.mockResolvedValue(details);
  api.discoverOperator.mockResolvedValue({ manifestJson });
  api.approveOperator.mockResolvedValue({ ...registration, revision: 3, approvedArtifactDigest: 'a'.repeat(64) });
  api.registerOperator.mockResolvedValue(registration);
  api.setOperatorEnabled.mockResolvedValue({ ...registration, revision: 3, enabled: true });
  api.setOperatorDistribution.mockResolvedValue({ ...registration, revision: 3 });
  api.setOperatorPolicy.mockResolvedValue({ ...registration, revision: 3 });
  api.rotateOperatorWebhookKey.mockResolvedValue({ registration: { ...registration, revision: 3 }, key: 'k'.repeat(43) });
});
afterEach(cleanup);
async function selectOperator() {
  fireEvent.click(await screen.findByRole('button', { name: 'Manage operator' }));
  await screen.findByText('Private fixture');
}

describe('REQ-OPERATOR-008: enterprise Operators administration', () => {
  it.each(['default', 'saas', 'onboarding'])('makes no operator requests outside enterprise: %s', mode => {
    state.mode = mode;
    render(() => <OperatorsPage />);
    expect(api.listOperators).not.toHaveBeenCalled();
    expect(api.getOperator).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Register operator' })).not.toBeInTheDocument();
  });
  it('shows loading/error rather than inventing an empty registry, and supports refresh', async () => {
    api.listOperators.mockRejectedValueOnce(new Error('Unavailable'));
    render(() => <OperatorsPage />);
    await screen.findByRole('alert');
    expect(screen.queryByText('No operators registered')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Manage operator' });
  });
  it('registers endpoint and secret with deny-by-default restrictions without implicit approval', async () => {
    api.listOperators.mockResolvedValue({ operators: [] });
    render(() => <OperatorsPage />);
    await screen.findByText('No operators registered');
    fireEvent.input(screen.getByLabelText('Endpoint URL'), { target: { value: 'https://operator.example.test/discovery' } });
    fireEvent.input(screen.getByLabelText('Connection secret'), { target: { value: 'private-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register operator' }));
    await waitFor(() => expect(api.registerOperator).toHaveBeenCalledWith({ endpoint: 'https://operator.example.test/discovery', connectionSecret: 'private-secret', policy }));
    expect(api.approveOperator).not.toHaveBeenCalled();
    expect(api.setOperatorEnabled).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Connection secret')).toHaveValue(''));
  });
  it('keeps discovery, explicit digest approval and enablement separate', async () => {
    render(() => <OperatorsPage />);
    await selectOperator();
    expect(screen.getByRole('button', { name: 'Enable operator' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh discovery' }));
    await waitFor(() => expect(api.discoverOperator).toHaveBeenCalledWith('operator'));
    expect(api.approveOperator).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve artifact' }));
    await waitFor(() => expect(api.approveOperator).toHaveBeenCalledWith('operator', 2, 'a'.repeat(64)));
    expect(api.setOperatorEnabled).not.toHaveBeenCalled();
  });
  it('displays a newly generated key until dismissed, then never restores it from readback', async () => {
    const view = render(() => <OperatorsPage />);
    await selectOperator();
    fireEvent.click(screen.getByRole('button', { name: 'Generate webhook key' }));
    await screen.findByText('k'.repeat(43));
    expect(screen.getByText(/CODEFLARE_OPERATOR_WEBHOOK_KEY/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I saved the key' }));
    expect(screen.queryByText('k'.repeat(43))).not.toBeInTheDocument();
    view.unmount();
    render(() => <OperatorsPage />);
    await selectOperator();
    expect(screen.queryByText('k'.repeat(43))).not.toBeInTheDocument();
  });
  it('enables only after an explicit action on an approved registration', async () => {
    api.getOperator.mockResolvedValue({ ...details, registration: { ...registration, approvedArtifactDigest: 'a'.repeat(64) }, approvedManifestJson: manifestJson });
    render(() => <OperatorsPage />);
    await selectOperator();
    expect(api.setOperatorEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enable operator' }));
    await waitFor(() => expect(api.setOperatorEnabled).toHaveBeenCalledWith('operator', 2, true));
  });
  it('requires confirmation before replacing an existing webhook key', async () => {
    api.getOperator.mockResolvedValue({ ...details, webhookKeyConfigured: true });
    render(() => <OperatorsPage />);
    await selectOperator();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate webhook key' }));
    expect(api.rotateOperatorWebhookKey).not.toHaveBeenCalled();
    expect(screen.getByText(/update.*consuming repositories/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }));
    await screen.findByText('k'.repeat(43));
  });
  it('shows mutation conflicts without automatically repeating them', async () => {
    api.approveOperator.mockRejectedValue(new Error('Revision conflict; refresh before retrying'));
    render(() => <OperatorsPage />);
    await selectOperator();
    fireEvent.click(screen.getByRole('button', { name: 'Approve artifact' }));
    await screen.findByRole('alert');
    expect(api.approveOperator).toHaveBeenCalledTimes(1);
    expect(api.setOperatorEnabled).not.toHaveBeenCalled();
  });
  it('edits restrictive policy and explicitly replaces credentials without secret readback', async () => {
    render(() => <OperatorsPage />);
    await selectOperator();
    expect(screen.getByLabelText('Replacement connection secret')).toHaveValue('');
    fireEvent.input(screen.getByLabelText('General egress hosts'), { target: { value: 'api.example.test\n*.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions' }));
    await waitFor(() => expect(api.setOperatorPolicy).toHaveBeenCalledWith('operator', 2, { ...policy, networkHosts: ['api.example.test', '*.example.org'] }));
    fireEvent.input(screen.getByLabelText('Replacement connection secret'), { target: { value: 'replacement-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace connection' }));
    await waitFor(() => expect(api.setOperatorDistribution).toHaveBeenCalledWith('operator', 2, details.endpoint, 'replacement-secret'));
  });
});
