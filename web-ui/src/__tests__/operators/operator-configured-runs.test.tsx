import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
import type { ManagementDetail } from '../../api/operator-management';

const source = 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher';
const grants = { users: ['manager@example.test'], groups: [] };
const policy = { capabilities: ['inference', 'fetch'], resourceProfileId: null, sourceResponseBytes: 524288 };
const retained = { unrelated: { labels: ['keep', 'these'] }, schedules: { external: 'retained' } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(): ManagementDetail {
  return {
    operator: { id: 'operator-1', name: 'Renovate Dispatcher', profile: 'dispatcher', realm: 'internal',
      repositoryId: 1380652724, repositoryUrl: source, revision: 7, enabled: true,
      managers: grants, invokers: grants, policy: { ...policy, loggingEnabled: false, operationLimit: 2048, inferenceRequestBytes: 1048576 },
      source: { kind: 'github-release', repositoryUrl: source, repositoryId: 1380652724,
        credentialConfigured: true, approvedWorkflow: { id: 7, ref: 'refs/heads/develop' } } },
    releases: [{ id: 'release-1', operatorId: 'operator-1', githubReleaseId: 456, sourceCommit: 'a'.repeat(40),
      manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64), interfaceVersion: 1, approved: true,
      name: 'Renovate Dispatcher', coreVersion: '1', intentVersion: '3', version: '0.1.3',
      tagName: 'v0.1.3', publishedAt: '2026-09-25T12:00:00Z' }],
    installations: [
      { id: 'installation-1', operatorId: 'operator-1', name: 'Primary', releaseId: 'release-1', revision: 4,
        enabled: true, policy, configuration: { ...retained } },
      { id: 'installation-2', operatorId: 'operator-1', name: 'Secondary', releaseId: 'release-1', revision: 9,
        enabled: false, policy, configuration: { secondary: 'keep', renovate: {
          repository: 'other/project', automaticRuns: true, repetitionIntervalSeconds: 7200 } } },
    ], grants: { managers: grants, invokers: grants },
  };
}
let state: ManagementDetail;
let writes: Array<{ path: string; body: unknown }>;
let conflict: boolean;
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  state = fixture(); writes = []; conflict = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    const path = url.pathname;
    if (path.endsWith('/options')) return json({ users: grants.users, groups: [],
      capabilities: ['inference', 'fetch'], resourceProfileIds: [],
      ceiling: { capabilities: ['inference', 'fetch'], resourceProfileIds: [], sourceResponseBytes: 1048576 } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      const item = state.installations.find(value => path.includes(`/installations/${value.id}/`));
      if (item && path.endsWith('/configure')) {
        if (conflict || body.revision !== item.revision) return json({ error: 'Stale revision' }, 409);
        Object.assign(item, { configuration: body.configuration, policy: body.policy, revision: item.revision + 1, enabled: false });
        return json(item);
      }
      if (item && path.endsWith('/enable')) {
        if (body.revision !== item.revision) return json({ error: 'Stale revision' }, 409);
        Object.assign(item, { enabled: body.enabled, revision: item.revision + 1 });
        return json(item);
      }
      return json({ error: 'Unexpected mutation' }, 400);
    }
    if (path.endsWith('/operator-1')) return json(state);
    if (path.endsWith('/operators')) return json({ items: [state.operator], cursor: null });
    if (path.endsWith('/preview')) return json({ name: 'Renovate Dispatcher', version: 'v0.1.3', guidedAssessment: true,
      guidedMode: 'repository', configuredRepository: state.installations[0].configuration?.renovate
        && (state.installations[0].configuration.renovate as { repository: string }).repository });
    if (path === '/api/operator-activities') return json({ items: [] });
    return json({ error: 'Not found' }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open() {
  window.history.replaceState({}, '', '/operators');
  render(() => <OperatorManagement />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Renovate Manager' }));
  return screen.findByRole('region', { name: 'Installed version' });
}
async function settings() {
  return screen.findByRole('group', { name: 'Run settings' });
}
function repository(group: HTMLElement) { return within(group).getByRole('textbox', { name: 'Repository' }); }
function interval(group: HTMLElement) { return within(group).getByRole('spinbutton', { name: 'Repeat interval (seconds)' }); }
function automatic(group: HTMLElement) { return within(group).getByRole('checkbox', { name: 'Automatic runs' }); }
function save() { return screen.getByRole('button', { name: /Save run settings/i }); }
function submit() { fireEvent.submit(save().closest('form')!); }
function setRunSettings(repository: string, automaticRuns: boolean, repetitionIntervalSeconds: number) {
  state.installations[0].configuration = { ...retained, renovate: { repository, automaticRuns, repetitionIntervalSeconds } };
}

describe('configured Renovate run settings', () => {
  it('REQ-OPERATOR-061: configured Renovate run settings default to an unset required repository, automatic off and 3600 seconds without a read mutation', async () => {
    await open();
    const group = await settings();
    expect(repository(group)).toHaveValue('');
    expect(repository(group)).toBeRequired();
    expect(repository(group)).toHaveAttribute('maxlength', '201');
    expect(automatic(group)).not.toBeChecked();
    expect(interval(group)).toHaveValue(3600);
    expect(interval(group)).toBeDisabled();
    expect(group).toHaveTextContent(/1 hour/i);
    expect(save()).toBeDisabled();
    expect(writes).toEqual([]);
    expect(state.installations[0].configuration).toEqual(retained);
  });

  it('REQ-OPERATOR-061: configured Renovate run settings save the public wire contract, reload retained values and isolate other installations until explicit re-enable', async () => {
    const before = structuredClone(state);
    await open();
    const group = await settings();
    fireEvent.input(repository(group), { target: { value: 'acme/automation' } });
    fireEvent.click(automatic(group));
    expect(interval(group)).toBeEnabled();
    fireEvent.input(interval(group), { target: { value: '900' } });
    fireEvent.click(save());
    const configuration = { ...retained, renovate: { repository: 'acme/automation', automaticRuns: true, repetitionIntervalSeconds: 900 } };
    // Intentional configure wire contract: CAS revision, unchanged policy and retained JSON keys.
    await waitFor(() => expect(writes).toEqual([{ path: '/api/operator-management/installations/installation-1/configure',
      body: { revision: 4, policy, configuration } }]));
    const installed = screen.getByRole('region', { name: 'Installed version' });
    await waitFor(() => expect(within(installed).getAllByRole('status').some(element =>
      /saved/i.test(element.textContent ?? '') && /disable|enable/i.test(element.textContent ?? ''))).toBe(true));
    await screen.findByRole('button', { name: 'Enable for new runs' });
    expect(state.installations[0]).toMatchObject({ enabled: false, revision: 5, configuration });
    expect(state.installations[1]).toEqual(before.installations[1]);
    expect(state.operator).toEqual(before.operator);
    expect(state.releases).toEqual(before.releases);
    expect(state.grants).toEqual(before.grants);
    cleanup(); await open();
    const reloaded = await settings();
    expect(repository(reloaded)).toHaveValue('acme/automation');
    expect(automatic(reloaded)).toBeChecked();
    expect(interval(reloaded)).toHaveValue(900);
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(repository(await settings())).toHaveValue('other/project');
    expect(interval(await settings())).toHaveValue(7200);
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable for new runs' }));
    await screen.findByRole('button', { name: 'Disable for new runs' });
    expect(writes).toContainEqual({ path: '/api/operator-management/installations/installation-1/enable', body: { revision: 5, enabled: true } });
    expect(state.installations[0].configuration).toEqual(configuration);
  });

  it('REQ-OPERATOR-061: configured Renovate run settings retain the interval when automatic runs are switched off and leave manual runs available', async () => {
    setRunSettings('acme/manual', true, 1800);
    await open();
    const group = await settings();
    fireEvent.click(automatic(group));
    expect(interval(group)).toBeDisabled();
    expect(interval(group)).toHaveValue(1800);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/manual', automaticRuns: false, repetitionIntervalSeconds: 1800 }));
    cleanup(); await open();
    expect(interval(await settings())).toHaveValue(1800);
    expect(automatic(await settings())).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Enable for new runs' }));
    await screen.findByRole('button', { name: 'Disable for new runs' });
    const installed = screen.getByRole('region', { name: 'Installed version' });
    expect(within(installed).queryByRole('textbox', { name: 'Repository to assess' })).not.toBeInTheDocument();
    expect(within(installed).queryByRole('spinbutton', { name: 'Pull request to assess' })).not.toBeInTheDocument();
    const run = within(installed).getByRole('link', { name: /assess|run/i });
    expect(new URL(run.getAttribute('href')!, window.location.origin).searchParams.get('repository')).toBeNull();
    fireEvent.click(run);
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveValue('acme/manual');
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeEnabled();
  });

  it('REQ-OPERATOR-061: configured Renovate run settings switching automatic runs back on restores the saved interval rather than resetting it', async () => {
    setRunSettings('acme/resume', false, 7200);
    await open();
    const group = await settings();
    expect(interval(group)).toBeDisabled();
    fireEvent.click(automatic(group));
    expect(interval(group)).toBeEnabled();
    expect(interval(group)).toHaveValue(7200);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/resume', automaticRuns: true, repetitionIntervalSeconds: 7200 }));
    cleanup(); await open();
    expect(automatic(await settings())).toBeChecked();
    expect(interval(await settings())).toHaveValue(7200);
    expect(interval(await settings())).toBeEnabled();
  });

  it('REQ-OPERATOR-061: configured Renovate run settings reset only the repeat interval to 3600 and preserve restrictions and unrelated schedules', async () => {
    setRunSettings('acme/reset', true, 7200);
    const other = structuredClone(state.installations[1]);
    await open();
    const group = await settings();
    fireEvent.click(within(group).getByRole('button', { name: 'Reset Repeat interval (seconds) to default' }));
    expect(interval(group)).toHaveValue(3600);
    expect(repository(group)).toHaveValue('acme/reset');
    expect(automatic(group)).toBeChecked();
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration).toEqual({ ...retained,
      renovate: { repository: 'acme/reset', automaticRuns: true, repetitionIntervalSeconds: 3600 } }));
    expect(state.installations[0].policy).toEqual(policy);
    expect(state.installations[1]).toEqual(other);
  });

  it.each(['', ' ', 'owner', 'https://github.com/owner/repo', 'owner/repo/extra', '../repo', 'owner/..', 'owner/%2Frepo', 'a'.repeat(198) + '/repo'])(
    'REQ-OPERATOR-061: configured Renovate run settings reject invalid repository %j even with automatic runs off', async invalid => {
      setRunSettings('acme/valid', false, 3600);
      const before = structuredClone(state.installations);
      await open();
      const group = await settings();
      fireEvent.input(repository(group), { target: { value: invalid } });
      expect(save()).toBeDisabled();
      submit();
      expect(writes).toEqual([]);
      expect(state.installations).toEqual(before);
    });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])(
    'REQ-OPERATOR-061: configured Renovate run settings reject invalid enabled interval %j without mutation', async invalid => {
      setRunSettings('acme/valid', true, 3600);
      const before = structuredClone(state.installations);
      await open();
      fireEvent.input(interval(await settings()), { target: { value: invalid } });
      expect(save()).toBeDisabled();
      submit();
      expect(writes).toEqual([]);
      expect(state.installations).toEqual(before);
    });

  it('REQ-OPERATOR-061: configured Renovate run settings restriction-only saves retain the configured repository, toggle and interval', async () => {
    setRunSettings('acme/restricted', false, 7200);
    const configuration = structuredClone(state.installations[0].configuration);
    await open(); await settings();
    const restrictions = screen.getByRole('group', { name: 'Installation restrictions' });
    fireEvent.click(within(restrictions).getByRole('checkbox', { name: /Inference/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for Primary' }));
    await waitFor(() => expect(state.installations[0].policy.capabilities).toEqual(['fetch']));
    expect(state.installations[0].configuration).toEqual(configuration);
    cleanup(); await open();
    expect(repository(await settings())).toHaveValue('acme/restricted');
    expect(interval(await settings())).toHaveValue(7200);
  });

  it('REQ-OPERATOR-061: configured Renovate run settings reconcile stale revisions before a deliberate save at the refreshed revision', async () => {
    setRunSettings('acme/original', false, 3600);
    await open();
    fireEvent.input(repository(await settings()), { target: { value: 'acme/stale-draft' } });
    state.installations[0] = { ...state.installations[0], revision: 8, configuration: { ...retained,
      renovate: { repository: 'acme/concurrent', automaticRuns: true, repetitionIntervalSeconds: 7200 } } };
    conflict = true;
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(/stale.*refresh/i);
    expect(save()).toBeDisabled();
    expect(state.installations[0].configuration?.renovate).toEqual({ repository: 'acme/concurrent', automaticRuns: true, repetitionIntervalSeconds: 7200 });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current state' }));
    await waitFor(() => expect(repository(screen.getByRole('group', { name: 'Run settings' }))).toHaveValue('acme/concurrent'));
    expect(interval(await settings())).toHaveValue(7200);
    conflict = false;
    fireEvent.input(repository(await settings()), { target: { value: 'acme/reviewed' } });
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].revision).toBe(9));
    expect(writes).toContainEqual({ path: '/api/operator-management/installations/installation-1/configure', body: {
      revision: 8, policy, configuration: { ...retained, renovate: { repository: 'acme/reviewed', automaticRuns: true, repetitionIntervalSeconds: 7200 } } } });
  });

  it('REQ-OPERATOR-061: configured Renovate run settings save only the explicitly selected secondary installation at its own revision', async () => {
    const primary = structuredClone(state.installations[0]);
    await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    const group = await settings();
    expect(repository(group)).toHaveValue('other/project');
    fireEvent.input(repository(group), { target: { value: 'other/updated' } });
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[1].revision).toBe(10));
    expect(writes).toEqual([{ path: '/api/operator-management/installations/installation-2/configure', body: {
      revision: 9, policy, configuration: { secondary: 'keep', renovate: {
        repository: 'other/updated', automaticRuns: true, repetitionIntervalSeconds: 7200 } } } }]);
    expect(state.installations[0]).toEqual(primary);
    cleanup(); await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(repository(await settings())).toHaveValue('other/updated');
  });

  it.each(['legacy', 'third-party', 'wrong-identity', 'unsupported-intent'])(
    'REQ-OPERATOR-061: configured Renovate run settings are not offered for %s packages', async kind => {
      if (kind === 'legacy') state.releases[0].intentVersion = '2';
      if (kind === 'unsupported-intent') state.releases[0].intentVersion = '99';
      if (kind === 'third-party') state.operator.repositoryUrl = 'https://github.com/acme/dispatcher';
      if (kind === 'wrong-identity') state.operator.repositoryId = 123;
      render(() => <OperatorManagement />);
      fireEvent.click(await screen.findByRole('button', { name: /Manage Renovate/ }));
      await screen.findByRole('region', { name: 'Installed version' });
      expect(screen.queryByRole('group', { name: 'Run settings' })).not.toBeInTheDocument();
      expect(writes).toEqual([]);
    });
});
