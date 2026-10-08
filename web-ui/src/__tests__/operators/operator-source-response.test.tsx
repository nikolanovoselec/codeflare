import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement, { ManagementAccessPanel } from '../../components/OperatorManagement';
import type { ManagementAccess, ManagementDetail } from '../../api/operator-management';

const grant = { users: ['manager@example.test'], groups: [] };
const basePolicy = { capabilities: ['fetch'], resourceProfileId: null };
const explicitInstallationPolicy = { ...basePolicy, sourceResponseBytes: 65536 };
const release = { id: 'release-1', operatorId: 'operator-1', githubReleaseId: 1, sourceCommit: 'abc',
  manifestDigest: 'a'.repeat(64), bundleDigest: 'b'.repeat(64), interfaceVersion: 1, approved: true, tagName: 'v1.0.0', publishedAt: '2026-09-25T12:00:00Z' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let operator: ManagementDetail['operator'];
let installation: ManagementDetail['installations'][number];
let access: ManagementAccess;
let rejectSave: boolean;
let saved: { revision: number; policy?: ManagementDetail['operator']['policy']; configuration?: unknown; capabilities?: string[]; sourceResponseBytes?: number; inferenceRequestBytes?: number; operationLimit?: number; inferenceAttemptLimit?: number; submissionAttemptLimit?: number; loggingEnabled?: boolean; ceiling?: ManagementAccess['ceiling']; managers?: ManagementAccess['managers'] };
let holdSave: Promise<void> | undefined;
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  rejectSave = false; holdSave = undefined;
  access = { revision: 1, managers: grant, ceiling: { capabilities: ['fetch'], resourceProfileIds: [], sourceResponseBytes: 262144 } };
  operator = { id: 'operator-1', name: 'Dispatcher', revision: 1, repositoryId: 1,
    repositoryUrl: 'https://github.com/example/dispatcher', profile: 'dispatcher', realm: 'internal', enabled: true,
    managers: grant, invokers: grant, policy: { ...basePolicy, sourceResponseBytes: 131072 },
    source: { kind: 'github-release', repositoryId: 1, repositoryUrl: 'https://github.com/example/dispatcher', credentialConfigured: true, approvedWorkflow: null } };
  installation = { id: 'installation-1', operatorId: operator.id, name: 'default', revision: 1, releaseId: release.id, enabled: true,
    policy: { ...explicitInstallationPolicy }, configuration: { retained: 'value' } };
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(input, window.location.origin).pathname;
    if (init?.method === 'POST') {
      await holdSave;
      if (rejectSave) return response({ error: 'stale' }, 409);
      saved = JSON.parse(String(init.body));
      if (path.endsWith('/access')) { access = { ...access, ...saved, ceiling: saved.ceiling!, managers: saved.managers!, revision: access.revision + 1 }; return response(access); }
      if (path.endsWith('/capabilities')) {
        operator = { ...operator, revision: operator.revision + 1, policy: { ...operator.policy, capabilities: saved.capabilities!,
          ...(saved.loggingEnabled === undefined ? {} : { loggingEnabled: saved.loggingEnabled }),
          ...(saved.sourceResponseBytes === undefined ? {} : { sourceResponseBytes: saved.sourceResponseBytes }),
          ...(saved.operationLimit === undefined ? {} : { operationLimit: saved.operationLimit }),
          ...(saved.inferenceAttemptLimit === undefined ? {} : { inferenceAttemptLimit: saved.inferenceAttemptLimit }),
          ...(saved.submissionAttemptLimit === undefined ? {} : { submissionAttemptLimit: saved.submissionAttemptLimit }),
          ...(saved.inferenceRequestBytes === undefined ? {} : { inferenceRequestBytes: saved.inferenceRequestBytes }) } };
        if (installation.enabled) installation = { ...installation, revision: installation.revision + 1, enabled: false };
        return response(operator);
      }
      installation = { ...installation, policy: saved.policy!, revision: installation.revision + 1, enabled: false };
      return response(installation);
    }
    if (path.endsWith('/access')) return response(access);
    if (path.endsWith('/options')) return response({ users: grant.users, groups: [], capabilities: ['fetch'], resourceProfileIds: [], ceiling: access.ceiling });
    if (path.endsWith('/operator-1')) return response({ operator, installations: [installation], releases: [release], grants: { managers: grant, invokers: grant } });
    return response({ items: [operator], cursor: null });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open() {
  window.history.replaceState({}, '', '/operators');
  render(() => <OperatorManagement />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Dispatcher' }));
  return screen.findByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' });
}

describe('Dispatcher source response allowance', () => {
  it.each([1, 7, Number.MAX_SAFE_INTEGER])('REQ-OPERATOR-045/049: max inference attempts %i persist independently and reset to four', async limit => {
    await open();
    const field = screen.getByRole('spinbutton', { name: 'Max inference attempts' });
    expect(field).toHaveValue(4);
    expect(field).toHaveAccessibleDescription(/including the initial request.*1 to disable retries.*operation budget.*model cost.*writes are never retried/i);
    fireEvent.input(field, { target: { value: String(limit) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(operator.policy.inferenceAttemptLimit).toBe(limit));
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 131072, inferenceAttemptLimit: limit });
    expect(installation).toMatchObject({ enabled: false, releaseId: release.id, policy: explicitInstallationPolicy });
    cleanup(); await open();
    expect(screen.getByRole('spinbutton', { name: 'Max inference attempts' })).toHaveValue(limit);
    expect(screen.getByRole('spinbutton', { name: 'Operation limit per run' })).toHaveValue(1024);
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(1048576);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Max inference attempts to default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(operator.policy.inferenceAttemptLimit).toBe(4));
  });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])('REQ-OPERATOR-045/049: invalid inference attempt limit %s prevents mutation', async value => {
    await open();
    const before = structuredClone(operator);
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Max inference attempts' }), { target: { value } });
    const save = screen.getByRole('button', { name: 'Save operator capabilities' });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(operator).toEqual(before);
  });

  it('REQ-OPERATOR-049: Conductor does not offer an inference attempt setting', async () => {
    operator.profile = 'conductor';
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Dispatcher' }));
    await screen.findByRole('group', { name: 'Operator capabilities' });
    expect(screen.queryByRole('spinbutton', { name: 'Max inference attempts' })).not.toBeInTheDocument();
  });
  it.each([1, 7, Number.MAX_SAFE_INTEGER])('REQ-OPERATOR-045/049: submission attempts %i persist independently and reset to 1024', async limit => {
    await open();
    const field = screen.getByRole('spinbutton', { name: 'Submission attempt limit' });
    expect(field).toHaveValue(1024);
    expect(field).toHaveAccessibleDescription(/including the initial submission.*1 to disable retries.*operation budget.*deadline/i);
    fireEvent.input(field, { target: { value: String(limit) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(operator.policy).toMatchObject({ submissionAttemptLimit: limit }));
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 131072, submissionAttemptLimit: limit });
    expect(installation).toMatchObject({ enabled: false, releaseId: release.id, policy: explicitInstallationPolicy });
    cleanup(); await open();
    expect(screen.getByRole('spinbutton', { name: 'Submission attempt limit' })).toHaveValue(limit);
    expect(screen.getByRole('spinbutton', { name: 'Operation limit per run' })).toHaveValue(1024);
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(1048576);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Submission attempt limit to default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(operator.policy).toMatchObject({ submissionAttemptLimit: 1024 }));
  });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])('REQ-OPERATOR-045/049: invalid submission attempt limit %s prevents mutation', async value => {
    await open();
    const before = structuredClone(operator);
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Submission attempt limit' }), { target: { value } });
    const save = screen.getByRole('button', { name: 'Save operator capabilities' });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(operator).toEqual(before);
  });

  it('REQ-OPERATOR-049: Conductor does not offer an submission attempt setting', async () => {
    operator.profile = 'conductor';
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Dispatcher' }));
    await screen.findByRole('group', { name: 'Operator capabilities' });
    expect(screen.queryByRole('spinbutton', { name: 'Submission attempt limit' })).not.toBeInTheDocument();
  });
  it('REQ-OPERATOR-045/049: explains limit ownership and resets inference to its default without changing other fields', async () => {
    operator.policy.inferenceRequestBytes = 2097152;
    await open();
    const ceiling = screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' });
    const allowance = screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' });
    const inference = screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' });
    expect(ceiling).toHaveValue(131072);
    expect(allowance).toHaveValue(65536);
    expect(inference).toHaveValue(2097152);
    expect(ceiling).toHaveAccessibleDescription(/any installation.*Recommended: 1048576 bytes.*administrator.*Environment/i);
    expect(allowance).toHaveAccessibleDescription(/this installation.*source-response size failure.*Recommended: 1048576 bytes.*operator ceiling/i);
    expect(inference).toHaveAccessibleDescription(/request and response body size.*no installation override.*Does not increase model context.*Recommended: 1048576 bytes/i);
    expect(screen.getByText(/Environment maximum → operator ceiling → installation allowance/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Operator source-response ceiling (bytes) to default' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset Installation source-response allowance (bytes) to default' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Inference limit (bytes) to default' }));
    expect(inference).toHaveValue(1048576);
    expect(ceiling).toHaveValue(131072);
    expect(allowance).toHaveValue(65536);
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 131072, inferenceRequestBytes: 1048576 });
    expect(installation.policy).toEqual(explicitInstallationPolicy);
  });

  it('REQ-OPERATOR-045/049: source default resets update only the selected ceiling or installation draft', async () => {
    access.ceiling.sourceResponseBytes = 1048576;
    operator.policy.sourceResponseBytes = 1048576;
    await open();
    const ceiling = screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' });
    fireEvent.input(ceiling, { target: { value: '524288' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Operator source-response ceiling (bytes) to default' }));
    expect(ceiling).toHaveValue(1048576);
    expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toHaveValue(65536);
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' }), { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Installation source-response allowance (bytes) to default' }));
    expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toHaveValue(1048576);
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(1048576);
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for default' }));
    await screen.findByText('Restrictions saved. Enable new runs separately when ready.');
    expect(saved).toEqual({ revision: 1, policy: { ...basePolicy, sourceResponseBytes: 1048576 }, configuration: { retained: 'value' } });
    expect(operator.policy.inferenceRequestBytes).toBeUndefined();
  });

  it('REQ-OPERATOR-045/049: explains and persists operation budget independently then resets to 1024', async () => {
    await open();
    const field = screen.getByRole('spinbutton', { name: 'Operation limit per run' });
    expect(field).toHaveValue(1024);
    expect(field).toHaveAccessibleDescription(/charged operations.*discovery.*research.*inference attempts.*repository effects/i);
    expect(field).toHaveAccessibleDescription(/Cached responses and receipt checks add no charge.*Exhaustion blocks new work/i);
    expect(screen.queryByRole('button', { name: /Use recommended/ })).not.toBeInTheDocument();
    fireEvent.input(field, { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 131072, operationLimit: 2048 });
    expect(screen.getByRole('spinbutton', { name: 'Operation limit per run' })).toHaveValue(2048);
    expect(installation.policy).toEqual(explicitInstallationPolicy);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Reset Operation limit per run to default' }));
    expect(screen.getByRole('spinbutton', { name: 'Operation limit per run' })).toHaveValue(1024);
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved.operationLimit).toBe(1024));
  });

  it.each(['', '0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)])('REQ-OPERATOR-045/049: invalid operation limit %s prevents saving', async value => {
    await open();
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Operation limit per run' }), { target: { value } });
    expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeDisabled();
  });

  it('REQ-OPERATOR-049: reset defaults remain subject to a lower inherited source ceiling', async () => {
    access.ceiling.sourceResponseBytes = 32768; operator.policy.sourceResponseBytes = 32768;
    installation.policy.sourceResponseBytes = 16384;
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Installation source-response allowance (bytes) to default' }));
    expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toHaveValue(1048576);
    expect(screen.getByRole('button', { name: 'Save restrictions for default' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Operator source-response ceiling (bytes) to default' }));
    expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeDisabled();
  });

  it('REQ-OPERATOR-045: operator inference bytes default without being added on an unrelated save', async () => {
    await open();
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(1048576);
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 131072 });
  });

  it('REQ-OPERATOR-045: operator inference maximum persists independently of installation source bytes', async () => {
    await open();
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' }), {
      target: { value: String(Number.MAX_SAFE_INTEGER) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 131072,
      inferenceRequestBytes: Number.MAX_SAFE_INTEGER });
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(Number.MAX_SAFE_INTEGER);
    expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toHaveValue(65536);
    expect(installation.policy).toEqual(explicitInstallationPolicy);
    expect(installation.releaseId).toBe(release.id);
    expect(operator.managers).toEqual(grant);
    expect(operator.invokers).toEqual(grant);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled());
  });

  it.each(['', '0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)])('REQ-OPERATOR-045: invalid inference bytes %s prevent saving', async value => {
    await open();
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' }), { target: { value } });
    expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeDisabled();
  });

  it('REQ-OPERATOR-045: pending and stale inference edits require confirmed refresh', async () => {
    let releaseSave!: () => void;
    holdSave = new Promise(resolve => { releaseSave = resolve; });
    await open();
    const field = screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' });
    fireEvent.input(field, { target: { value: '1048576' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    expect(field).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Inference limit (bytes) to default' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Operation limit per run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Operation limit per run to default' })).toBeDisabled();
    releaseSave();
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toBeEnabled());
    rejectSave = true;
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' }), { target: { value: '2097152' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Inference limit (bytes) to default' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Operation limit per run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Operation limit per run to default' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current state' }));
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(1048576));
  });

  it('edits and persists installation bytes while preserving its other policy and configuration', async () => {
    const field = await open();
    expect(field).toHaveValue(65536);
    fireEvent.input(field, { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for default' }));
    await screen.findByText('Restrictions saved. Enable new runs separately when ready.');
    expect(saved).toEqual({ revision: 1, policy: { ...basePolicy, sourceResponseBytes: 100000 }, configuration: { retained: 'value' } });
    expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toHaveValue(100000);
  });

  it.each(['', '0', '1.5', '131073'])('rejects installation value %s outside the inherited integer allowance', async value => {
    const field = await open();
    fireEvent.input(field, { target: { value } });
    expect(screen.getByRole('button', { name: 'Save restrictions for default' })).toBeDisabled();
  });

  it('defaults absent operator and Environment source limits to 1 MiB', async () => {
    delete operator.policy.sourceResponseBytes;
    delete access.ceiling.sourceResponseBytes;
    const field = await open();
    fireEvent.input(field, { target: { value: '1048577' } });
    expect(screen.getByRole('button', { name: 'Save restrictions for default' })).toBeDisabled();
    fireEvent.input(field, { target: { value: '1048576' } });
    expect(screen.getByRole('button', { name: 'Save restrictions for default' })).toBeEnabled();
  });

  it('uses Environment as the installation bound when lower than the operator policy', async () => {
    access.ceiling.sourceResponseBytes = 100000;
    const field = await open();
    fireEvent.input(field, { target: { value: '100001' } });
    expect(screen.getByRole('button', { name: 'Save restrictions for default' })).toBeDisabled();
    fireEvent.input(field, { target: { value: '100000' } });
    expect(screen.getByRole('button', { name: 'Save restrictions for default' })).toBeEnabled();
  });

  it('locks byte editing while an installation save is pending', async () => {
    let releaseSave!: () => void;
    holdSave = new Promise(resolve => { releaseSave = resolve; });
    const field = await open();
    fireEvent.input(field, { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for default' }));
    expect(field).toBeDisabled();
    releaseSave();
    await screen.findByText('Restrictions saved. Enable new runs separately when ready.');
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toBeEnabled());
  });

  it('keeps initially missing defaults absent on unrelated saves', async () => {
    delete installation.policy.sourceResponseBytes;
    operator.policy.sourceResponseBytes = 1048576; access.ceiling.sourceResponseBytes = 1048576;
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for default' }));
    await screen.findByText('Restrictions saved. Enable new runs separately when ready.');
    expect(saved.policy).toEqual(basePolicy);
  });

  it('persists operator bytes with capabilities and disables installed runs pending re-enablement', async () => {
    await open();
    const field = screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' });
    fireEvent.input(field, { target: { value: '262145' } });
    expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeDisabled();
    fireEvent.input(field, { target: { value: '200000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 200000 });
    expect(screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' })).toHaveValue(200000);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Enable$/ })).toBeEnabled());
    expect(screen.getByText(/v1\.0\.0/, { selector: 'strong' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeEnabled());
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' }), { target: { value: '65536' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved).toEqual({ revision: 2, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 65536 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeEnabled());
    expect(screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' })).toHaveValue(65536);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByText(/v1\.0\.0/, { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    expect(within(screen.getByRole('group', { name: 'Managers' })).getByRole('checkbox', { name: grant.users[0] })).toBeChecked();
    expect(within(screen.getByRole('group', { name: 'Runners' })).getByRole('checkbox', { name: grant.users[0] })).toBeChecked();
  });

  it('omits an initially absent operator default but explicitly saves an edited 1 MiB value', async () => {
    delete operator.policy.sourceResponseBytes;
    access.ceiling.sourceResponseBytes = 1048576;
    await open();
    expect(screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' })).toHaveValue(1048576);
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await screen.findByText('Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.');
    expect(saved).toEqual({ revision: 1, capabilities: ['fetch'], loggingEnabled: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeEnabled());
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Operator source-response ceiling (bytes)' }), { target: { value: '1048576' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved).toEqual({ revision: 2, capabilities: ['fetch'], loggingEnabled: true, sourceResponseBytes: 1048576 }));
  });

  it('locks a stale installation draft until refreshed', async () => {
    const field = await open(); rejectSave = true;
    fireEvent.input(field, { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for default' }));
    await screen.findByRole('alert');
    expect(field).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current state' }));
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toBeEnabled());
    expect(screen.getByRole('spinbutton', { name: 'Installation source-response allowance (bytes)' })).toHaveValue(65536);
  });

  it('does not offer Dispatcher byte fields for Conductor policies', async () => {
    operator.profile = 'conductor';
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Dispatcher' }));
    await screen.findByRole('region', { name: 'Runtime permissions' });
    expect(screen.queryByRole('spinbutton', { name: /source-response (ceiling|allowance)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Inference limit (bytes)' })).not.toBeInTheDocument();
  });

  it.each(['', '0', '1.5', '1048577'])('rejects Environment value %s outside the supported integer allowance', async value => {
    render(() => <ManagementAccessPanel />);
    const field = await screen.findByRole('spinbutton', { name: 'Largest Dispatcher source response (bytes)' });
    fireEvent.input(field, { target: { value } });
    expect(screen.getByRole('button', { name: 'Save management access' })).toBeDisabled();
  });

  it('edits Environment bytes, preserves other ceiling fields and locks stale saves', async () => {
    delete access.ceiling.sourceResponseBytes;
    render(() => <ManagementAccessPanel />);
    const field = await screen.findByRole('spinbutton', { name: 'Largest Dispatcher source response (bytes)' });
    expect(field).toHaveValue(1048576);
    fireEvent.click(screen.getByRole('button', { name: 'Save management access' }));
    await screen.findByText('Management access saved. Operator ownership and invocation grants remain separate.');
    expect(saved.ceiling).toEqual({ capabilities: ['fetch'], resourceProfileIds: [] });
    fireEvent.input(field, { target: { value: '262144' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save management access' }));
    await waitFor(() => expect(saved.ceiling?.sourceResponseBytes).toBe(262144));
    expect(saved.managers).toEqual(grant);
    rejectSave = true;
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.input(field, { target: { value: '131072' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save management access' }));
    await screen.findByRole('alert');
    expect(field).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh management access' }));
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Largest Dispatcher source response (bytes)' })).toHaveValue(262144));
  });
});
