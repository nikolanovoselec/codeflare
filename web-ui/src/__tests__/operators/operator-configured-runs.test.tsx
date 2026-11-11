import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
import type { ManagementDetail } from '../../api/operator-management';

// The incumbent active-session facade and the owner catalog remain separate read projections.
const activeSession = vi.hoisted(() => ({
  set: (_session: unknown) => {}, list: (_sessions: unknown) => {},
}));
vi.mock('../../stores/session', async () => {
  const { createSignal } = await import('solid-js');
  const [current, setCurrent] = createSignal<typeof sourceHost | undefined>();
  activeSession.set = session => { setCurrent(session as typeof sourceHost | undefined); };
  const [listed, setListed] = createSignal<Array<typeof sourceHost> | undefined>();
  activeSession.list = value => { setListed(value as Array<typeof sourceHost> | undefined); };
  return { sessionStore: {
    preferences: {},
    getActiveSession: current,
    get activeSessionId() { return current()?.id ?? null; },
    get sessions() { return listed() ?? (current() ? [current()!] : []); },
    get statusUnavailable() { return false; },
  } };
});

const source = 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher';
const grants = { users: ['manager@example.test'], groups: [] };
const policy = { capabilities: ['inference', 'fetch'], resourceProfileId: null, sourceResponseBytes: 524288 };
const retained = { unrelated: { labels: ['keep', 'these'] }, schedules: { external: 'retained' } };
const sourceHost = { id: 'ownersession1', name: 'Existing owner Host', createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-02T00:00:00.000Z', status: 'running', lifecycle: 'running', generation: 3,
  revision: 1, workspace: 'terminal', terminalMode: 'classic', agentType: 'bash' };
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
let reads: string[];
let hosts: Array<typeof sourceHost>;
let hostError: boolean;
let canInvoke: boolean;
let automaticStatus: 'inactive' | 'active' | 'expired' | 'unconfirmed';
let activate: (body: unknown) => Promise<Response>;
const activationPath = '/api/operator-activities/renovate/activation';
const cutoff = '2026-11-11T00:00:00.000Z';
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  hosts = [sourceHost]; hostError = false; canInvoke = true;
  state = fixture(); writes = []; reads = []; conflict = false;
  activeSession.list(undefined); activeSession.set(undefined);
  automaticStatus = 'inactive';
  activate = async () => { automaticStatus = 'active'; return json({ activatedAt: cutoff, repositoryId: 424242 }, 202); };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    const path = url.pathname;
    if (path.endsWith('/options')) return json({ users: grants.users, groups: [],
      capabilities: ['inference', 'fetch'], resourceProfileIds: [],
      ceiling: { capabilities: ['inference', 'fetch'], resourceProfileIds: [], sourceResponseBytes: 1048576 } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === activationPath) return activate(body);
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
    reads.push(path);
    if (path.endsWith('/operator-1')) return json(state);
    if (path.endsWith('/operators')) return json({ items: [state.operator], cursor: null });
    if (path === '/api/sessions') return hostError ? json({ error: 'Unavailable' }, 503) : json({ sessions: hosts });
    if (path === '/api/operator-activities/installations') return json({ items: state.installations.map(item => ({
      id: item.id, operatorId: item.operatorId, name: 'Renovate Dispatcher', installationName: item.name,
      revision: item.revision, enabled: item.enabled, approved: state.releases[0].approved, version: 'v0.1.3',
      profile: 'dispatcher', canManage: true, canInvoke: canInvoke, canActivateAutomaticRuns: canInvoke, automaticRunStatus: automaticStatus,
      guidedMode: 'repository', repository: (item.configuration?.renovate as any)?.repository ?? null,
      automaticRuns: (item.configuration?.renovate as any)?.automaticRuns ?? false,
      repetitionIntervalSeconds: (item.configuration?.renovate as any)?.repetitionIntervalSeconds ?? 3600,
    })), cursor: null });
    if (path.endsWith('/preview')) return json({ name: 'Renovate Dispatcher', version: 'v0.1.3', guidedAssessment: true,
      guidedMode: 'repository', requiresSourceHost: state.operator.policy.capabilities.includes('inference')
        && state.installations[0].policy.capabilities.includes('inference'), configuredRepository: state.installations[0].configuration?.renovate
        && (state.installations[0].configuration.renovate as { repository: string }).repository });
    if (path === '/api/operator-activities') return json({ items: [] });
    return json({ error: 'Not found' }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open(isAdmin = false) {
  window.history.replaceState({}, '', '/operators');
  render(() => <OperatorManagement isAdmin={isAdmin} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Renovate Manager' }));
  const installed = await screen.findByRole('region', { name: 'Installed version' });
  const configuration = await within(installed).findByRole('combobox', { name: 'Installed configuration' });
  if (!(configuration as HTMLSelectElement).value) {
    fireEvent.change(configuration, { target: { value: 'installation-1' } });
  }
  return installed;
}
async function settings() {
  return screen.findByRole('group', { name: 'Run settings' });
}
function repository(group: HTMLElement) { return within(group).getByRole('textbox', { name: 'Repository' }); }
function interval(group: HTMLElement) { return within(group).getByRole('spinbutton', { name: 'Repeat interval' }); }
function automatic(_group?: HTMLElement) { return screen.getByRole('checkbox', { name: 'Automatic runs' }); }
function save() { return screen.getByRole('button', { name: /Save run settings/i }); }
function submit() { fireEvent.submit(save().closest('form')!); }
function setRunSettings(repository: string, automaticRuns: boolean, repetitionIntervalSeconds: number) {
  state.installations[0].configuration = { ...retained, renovate: { repository, automaticRuns, repetitionIntervalSeconds } };
}

describe('configured Renovate run settings', () => {
  it.each(['3', '4'])('REQ-OPERATOR-061: intent %s exposes the saved repository and Save action without a read mutation', async intentVersion => {
    state.releases[0].intentVersion = intentVersion;
    setRunSettings('acme/saved-project', false, 3600);
    const installed = await open();
    const group = await settings();
    expect(repository(group)).toHaveValue('acme/saved-project');
    expect(save()).toBeEnabled();
    expect(within(installed).queryByRole('textbox', { name: 'Repository to assess' })).not.toBeInTheDocument();
    expect(within(installed).queryByRole('spinbutton', { name: 'Pull request to assess' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('REQ-OPERATOR-061: configured Renovate run settings default to an unset required repository, automatic off and 3600 seconds without a read mutation', async () => {
    await open();
    const group = await settings();
    expect(repository(group)).toHaveValue('');
    expect(repository(group)).toBeRequired();
    expect(repository(group)).toHaveAttribute('maxlength', '201');
    expect(automatic(group)).not.toBeChecked();
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/1 hour/i);
    expect(automatic()).not.toBeChecked();
    expect(within(group).getByText(/Saving run settings disables.*does not start a run/i)).toBeVisible();
    expect(save()).toBeDisabled();
    expect(writes).toEqual([]);
    expect(state.installations[0].configuration).toEqual(retained);
  });

  it('REQ-OPERATOR-061: labeled Automatic runs checkbox edits only the unsaved run-settings draft', async () => {
    const installed = await open();
    const group = await settings();
    const before = structuredClone(state);
    expect(within(installed).getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    fireEvent.click(automatic());
    expect(automatic()).toBeChecked();
    expect(interval(group)).toHaveValue(1);
    expect(interval(group)).toHaveAccessibleDescription(/Default: 1 hour/);
    expect(writes).toEqual([]);
    expect(state).toEqual(before);
    fireEvent.click(automatic());
    expect(automatic()).not.toBeChecked();
    expect(within(group).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/Default: 1 hour/);
    expect(writes).toEqual([]);
  });

  it.each(['', '0'])('REQ-OPERATOR-061: repeat off restores the saved interval after invalid draft %s and permits manual-only save', async value => {
    setRunSettings('acme/automation', true, 900);
    await open();
    const group = await settings();
    fireEvent.input(interval(group), { target: { value } });
    expect(save()).toBeDisabled();
    fireEvent.click(automatic());
    expect(within(group).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/automation', automaticRuns: false, repetitionIntervalSeconds: 900,
    }));
    expect(state.installations[0].enabled).toBe(false);
  });

  it.each(['3', '4'])('REQ-OPERATOR-061: intent %s run settings save the public wire contract, reload retained values and isolate other installations until explicit re-enable', async intentVersion => {
    state.releases[0].intentVersion = intentVersion;
    const before = structuredClone(state);
    await open();
    const group = await settings();
    fireEvent.input(repository(group), { target: { value: 'acme/automation' } });
    fireEvent.click(automatic(group));
    expect(interval(group)).toBeEnabled();
    fireEvent.change(within(group).getByRole('combobox', { name: 'Interval unit' }), { target: { value: 'seconds' } });
    fireEvent.input(interval(group), { target: { value: '900' } });
    fireEvent.click(save());
    const configuration = { ...retained, renovate: { repository: 'acme/automation', automaticRuns: true, repetitionIntervalSeconds: 900 } };
    // Intentional configure wire contract: CAS revision, unchanged policy and retained JSON keys.
    await waitFor(() => expect(writes).toEqual([{ path: '/api/operator-management/installations/installation-1/configure',
      body: { revision: 4, policy, configuration } }]));
    const installed = screen.getByRole('region', { name: 'Installed version' });
    await waitFor(() => expect(within(installed).getAllByRole('status').some(element =>
      /saved/i.test(element.textContent ?? '') && /disable|enable/i.test(element.textContent ?? ''))).toBe(true));
    await screen.findByRole('button', { name: 'Activate' });
    expect(state.installations[0]).toMatchObject({ enabled: false, revision: 5, configuration });
    expect(state.installations[1]).toEqual(before.installations[1]);
    expect(state.operator).toEqual(before.operator);
    expect(state.releases).toEqual(before.releases);
    expect(state.grants).toEqual(before.grants);
    cleanup(); await open();
    const reloaded = await settings();
    expect(repository(reloaded)).toHaveValue('acme/automation');
    expect(automatic(reloaded)).toBeChecked();
    expect(interval(reloaded)).toHaveValue(15);
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(repository(await settings())).toHaveValue('other/project');
    expect(interval(await settings())).toHaveValue(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-1' } });
  });

  it('REQ-OPERATOR-061: configured Renovate run settings retain the interval when automatic runs are switched off and leave manual runs available', async () => {
    setRunSettings('acme/manual', true, 1800);
    await open();
    const group = await settings();
    fireEvent.click(automatic(group));
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/Default: 3,600/);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/manual', automaticRuns: false, repetitionIntervalSeconds: 1800 }));
    cleanup(); await open();
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    fireEvent.click(automatic());
    expect(interval(await settings())).toHaveValue(30);
    fireEvent.click(automatic());
    expect(automatic(await settings())).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await screen.findByRole('button', { name: 'Deactivate' });
    const installed = screen.getByRole('region', { name: 'Installed version' });
    expect(within(installed).queryByRole('textbox', { name: 'Repository to assess' })).not.toBeInTheDocument();
    expect(within(installed).queryByRole('spinbutton', { name: 'Pull request to assess' })).not.toBeInTheDocument();
    const run = within(installed).getByRole('link', { name: /assess|run/i });
    expect(new URL(run.getAttribute('href')!, window.location.origin).searchParams.get('repository')).toBeNull();
    fireEvent.click(run);
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveValue('acme/manual');
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    const source = await screen.findByRole('combobox', { name: /source.*host/i });
    const option = await within(source).findByRole('option', { name: /Existing owner Host/ });
    fireEvent.change(source, { target: { value: (option as HTMLOptionElement).value } });
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeEnabled();
  });

  it('REQ-OPERATOR-061: configured Renovate run settings switching automatic runs back on restores the saved interval rather than resetting it', async () => {
    setRunSettings('acme/resume', false, 7200);
    await open();
    const group = await settings();
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    fireEvent.click(automatic(group));
    expect(interval(group)).toBeEnabled();
    expect(interval(group)).toHaveValue(2);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/resume', automaticRuns: true, repetitionIntervalSeconds: 7200 }));
    cleanup(); await open();
    expect(automatic(await settings())).toBeChecked();
    expect(interval(await settings())).toHaveValue(2);
    expect(interval(await settings())).toBeEnabled();
  });

  it('REQ-OPERATOR-061: configured Renovate run settings reset only the repeat interval to 3600 and preserve restrictions and unrelated schedules', async () => {
    setRunSettings('acme/reset', true, 7200);
    const other = structuredClone(state.installations[1]);
    await open();
    const group = await settings();
    fireEvent.click(within(group).getByRole('button', { name: 'Reset Repeat interval to default' }));
    expect(interval(group)).toHaveValue(1);
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
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    fireEvent.click(automatic());
    expect(interval(await settings())).toHaveValue(2);
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
    expect(interval(await settings())).toHaveValue(2);
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


describe('REQ-OPERATOR-061 AC1/3/5: explicit installation Activate', () => {
  const activateButton = () => screen.getByRole('button', { name: /^Activate$/ });
  it('zero sessions: one explicit Activate enables the saved installation then arms automatic observation', async () => {
    hosts = []; activeSession.set(undefined); setRunSettings('acme/automation', true, 900);
    state.installations[0].enabled = false;
    await open(true); await waitFor(() => expect(activateButton()).toBeEnabled());
    expect(screen.queryByRole('combobox', { name: 'Running workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start automatic runs' })).toBeNull();
    expect(writes).toEqual([]);
    fireEvent.click(activateButton());
    await waitFor(() => expect(writes).toEqual([
      { path: '/api/operator-management/installations/installation-1/enable', body: { enabled: true, revision: 4 } },
      { path: activationPath, body: { installationId: 'installation-1', revision: 5 } },
    ]));
    expect(reads).not.toContain('/api/sessions');
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeEnabled();
  });
  it('an expired installation rearms from the same single Activate without toggling availability or requiring a workspace', async () => {
    hosts = []; setRunSettings('acme/automation', true, 900); automaticStatus = 'expired';
    await open(true); await waitFor(() => expect(activateButton()).toBeEnabled());
    expect(screen.getByText(/Automatic runs: expired/)).toBeVisible();
    fireEvent.click(activateButton());
    await waitFor(() => expect(writes).toEqual([{ path: activationPath, body: { installationId: 'installation-1', revision: 4 } }]));
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeEnabled();
    expect(reads).not.toContain('/api/sessions');
  });
  it('manual-only Activate enables availability without scheduling, Deactivate disables it', async () => {
    setRunSettings('acme/manual', false, 900); state.installations[0].enabled = false;
    await open(true); fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('button', { name: 'Activate' });
    expect(writes.map(write => write.path)).toEqual([
      '/api/operator-management/installations/installation-1/enable',
      '/api/operator-management/installations/installation-1/enable']);
    expect(state.installations[0].enabled).toBe(false);
  });
  it.each([{}, { activatedAt: 'invalid', repositoryId: 424242 }, { activatedAt: cutoff, repositoryId: 424242, accessJwt: 'private' }])(
    'unknown activation response %j is fenced until explicit refresh, never replayed', async response => {
      activate = async () => json(response, 202); setRunSettings('acme/automation', true, 900);
      await open(true); await waitFor(() => expect(activateButton()).toBeEnabled()); fireEvent.click(activateButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(/not confirmed/i);
      expect(activateButton()).toBeDisabled(); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'));
      expect(writes.filter(write => write.path === activationPath)).toHaveLength(1);
      expect(document.body).not.toHaveTextContent('private');
    });
  it('pending activation cannot duplicate consent; a changed installation cannot receive its late success', async () => {
    let finish!: (response: Response) => void;
    activate = () => new Promise<Response>(resolve => { finish = resolve; });
    setRunSettings('acme/automation', true, 900); await open(true);
    await waitFor(() => expect(activateButton()).toBeEnabled()); fireEvent.click(activateButton());
    await waitFor(() => expect(writes.filter(write => write.path === activationPath)).toHaveLength(1));
    expect(activateButton()).toBeDisabled(); fireEvent.click(activateButton());
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    finish(json({ activatedAt: cutoff, repositoryId: 424242 }, 202));
    await waitFor(() => expect(screen.queryByText(/Automatic runs activated/i)).toBeNull());
    expect(writes.filter(write => write.path === activationPath)).toHaveLength(1);
  });
  it.each(['non-admin', 'no-invoker', 'dirty'] as const)('%s cannot authorize automatic activation', async fault => {
    canInvoke = fault !== 'no-invoker'; setRunSettings('acme/automation', true, 900);
    await open(fault !== 'non-admin'); await settings();
    if (fault === 'dirty') fireEvent.input(repository(await settings()), { target: { value: 'acme/changed' } });
    const button = screen.queryByRole('button', { name: /^Activate$/ });
    if (button) { expect(button).toBeDisabled(); fireEvent.click(button); }
    else expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    expect(writes).toEqual([]);
  });
});

describe('Task101 Administration automatic-off parity', () => {
  it('REQ-OPERATOR-209 AC2: automatic off hides interval and default help until explicitly switched on', async () => {
    setRunSettings('acme/automation', false, 3600); await open();
    const group = await settings();
    expect(automatic()).not.toBeChecked();
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).toBeNull();
    expect(within(group).queryByRole('combobox', { name: 'Interval unit' })).toBeNull();
    expect(within(group).queryByText(/Default: 1 hour/)).toBeNull();
    fireEvent.click(automatic());
    expect(interval(group)).toHaveValue(1);
    expect(within(group).getByRole('combobox', { name: 'Interval unit' })).toHaveValue('hours');
    expect(within(group).getByText(/Default: 1 hour/)).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('REQ-OPERATOR-209 AC2/3: off and on retain valid draft seconds and only explicit Save writes manual-only settings', async () => {
    setRunSettings('acme/automation', true, 3600); await open();
    const group = await settings();
    fireEvent.change(within(group).getByRole('combobox', { name: 'Interval unit' }), { target: { value: 'seconds' } });
    fireEvent.input(interval(group), { target: { value: '3661' } });
    fireEvent.click(automatic());
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).toBeNull();
    expect(within(group).queryByText(/Default: 1 hour/)).toBeNull();
    fireEvent.click(automatic());
    expect(interval(group)).toHaveValue(3661);
    expect(within(group).getByRole('combobox', { name: 'Interval unit' })).toHaveValue('seconds');
    fireEvent.click(automatic()); expect(writes).toEqual([]);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/automation', automaticRuns: false, repetitionIntervalSeconds: 3661,
    }));
    expect(state.installations[0].enabled).toBe(false);
    expect(writes.map(write => write.path)).toEqual(['/api/operator-management/installations/installation-1/configure']);
  });

  it.each([[900, 900, 15, 'minutes'], [9007199254740991, 3600, 1, 'hours']] as const)(
    'REQ-OPERATOR-209 AC2/3: invalid draft switched off recovers saved %i as %i seconds without enabling or starting', async (saved, recovered, amount, units) => {
      setRunSettings('acme/automation', true, saved); await open();
      const group = await settings();
      fireEvent.input(interval(group), { target: { value: '' } });
      expect(save()).toBeDisabled(); fireEvent.click(automatic());
      expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).toBeNull();
      expect(within(group).queryByText(/Default: 1 hour/)).toBeNull();
      expect(save()).toBeEnabled(); fireEvent.click(automatic());
      expect(interval(group)).toHaveValue(amount);
      expect(within(group).getByRole('combobox', { name: 'Interval unit' })).toHaveValue(units);
      fireEvent.click(automatic()); expect(writes).toEqual([]); fireEvent.click(save());
      await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
        repository: 'acme/automation', automaticRuns: false, repetitionIntervalSeconds: recovered,
      }));
      expect(state.installations[0].enabled).toBe(false);
      expect(writes.map(write => write.path)).toEqual(['/api/operator-management/installations/installation-1/configure']);
    });
});
