import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
import type { ManagementDetail } from '../../api/operator-management';

// The activation surface consumes only the incumbent active-session facade.
const activeSession = vi.hoisted(() => ({
  set: (_session: unknown) => {},
}));
vi.mock('../../stores/session', async () => {
  const { createSignal } = await import('solid-js');
  const [current, setCurrent] = createSignal<typeof sourceHost | undefined>();
  activeSession.set = session => { setCurrent(session as typeof sourceHost | undefined); };
  return { sessionStore: {
    preferences: {},
    getActiveSession: current,
    get activeSessionId() { return current()?.id ?? null; },
    get sessions() { return current() ? [current()!] : []; },
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
let activate: (body: unknown) => Promise<Response>;
const activationPath = '/api/operator-activities/renovate/activation';
const cutoff = '2026-11-11T00:00:00.000Z';
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  state = fixture(); writes = []; reads = []; conflict = false;
  activeSession.set(undefined);
  activate = async () => json({ activatedAt: cutoff, repositoryId: 424242 }, 202);
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
    if (path === '/api/sessions') return json({ sessions: [sourceHost] });
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
function interval(group: HTMLElement) { return within(group).getByRole('spinbutton', { name: 'Repeat interval (seconds)' }); }
function automatic(_group?: HTMLElement) { return screen.getByRole('button', { name: 'Automatic runs' }); }
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
    expect(automatic(group)).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval (seconds)' })).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/1 hour/i);
    expect(screen.queryByRole('checkbox', { name: 'Automatic runs' })).not.toBeInTheDocument();
    expect(automatic()).toHaveAccessibleDescription(/Save run settings.*does not start work/i);
    expect(save()).toBeDisabled();
    expect(writes).toEqual([]);
    expect(state.installations[0].configuration).toEqual(retained);
  });

  it('REQ-OPERATOR-061: repeat follows Enable or Disable and edits only the unsaved run-settings draft', async () => {
    const installed = await open();
    const group = await settings();
    const before = structuredClone(state);
    const actions = within(installed).getAllByRole('button');
    // Intentional accessible action order: repeat immediately follows enablement.
    expect(actions[actions.indexOf(within(installed).getByRole('button', { name: 'Disable' })) + 1]).toBe(automatic());
    fireEvent.click(automatic());
    expect(automatic()).toHaveAttribute('aria-pressed', 'true');
    expect(interval(group)).toHaveValue(3600);
    expect(interval(group)).toHaveAccessibleDescription(/Default: 3,600 seconds/);
    expect(writes).toEqual([]);
    expect(state).toEqual(before);
    fireEvent.click(automatic());
    expect(automatic()).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/Default: 3,600 seconds/);
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
    fireEvent.input(interval(group), { target: { value: '900' } });
    fireEvent.click(save());
    const configuration = { ...retained, renovate: { repository: 'acme/automation', automaticRuns: true, repetitionIntervalSeconds: 900 } };
    // Intentional configure wire contract: CAS revision, unchanged policy and retained JSON keys.
    await waitFor(() => expect(writes).toEqual([{ path: '/api/operator-management/installations/installation-1/configure',
      body: { revision: 4, policy, configuration } }]));
    const installed = screen.getByRole('region', { name: 'Installed version' });
    await waitFor(() => expect(within(installed).getAllByRole('status').some(element =>
      /saved/i.test(element.textContent ?? '') && /disable|enable/i.test(element.textContent ?? ''))).toBe(true));
    await screen.findByRole('button', { name: 'Enable' });
    expect(state.installations[0]).toMatchObject({ enabled: false, revision: 5, configuration });
    expect(state.installations[1]).toEqual(before.installations[1]);
    expect(state.operator).toEqual(before.operator);
    expect(state.releases).toEqual(before.releases);
    expect(state.grants).toEqual(before.grants);
    cleanup(); await open();
    const reloaded = await settings();
    expect(repository(reloaded)).toHaveValue('acme/automation');
    expect(automatic(reloaded)).toHaveAttribute('aria-pressed', 'true');
    expect(interval(reloaded)).toHaveValue(900);
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(repository(await settings())).toHaveValue('other/project');
    expect(interval(await settings())).toHaveValue(7200);
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await screen.findByRole('button', { name: 'Disable' });
    expect(writes).toContainEqual({ path: '/api/operator-management/installations/installation-1/enable', body: { revision: 5, enabled: true } });
    expect(state.installations[0].configuration).toEqual(configuration);
  });

  it('REQ-OPERATOR-061: configured Renovate run settings retain the interval when automatic runs are switched off and leave manual runs available', async () => {
    setRunSettings('acme/manual', true, 1800);
    await open();
    const group = await settings();
    fireEvent.click(automatic(group));
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval (seconds)' })).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/Default: 3,600/);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/manual', automaticRuns: false, repetitionIntervalSeconds: 1800 }));
    cleanup(); await open();
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval (seconds)' })).not.toBeInTheDocument();
    fireEvent.click(automatic());
    expect(interval(await settings())).toHaveValue(1800);
    fireEvent.click(automatic());
    expect(automatic(await settings())).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await screen.findByRole('button', { name: 'Disable' });
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
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval (seconds)' })).not.toBeInTheDocument();
    fireEvent.click(automatic(group));
    expect(interval(group)).toBeEnabled();
    expect(interval(group)).toHaveValue(7200);
    fireEvent.click(save());
    await waitFor(() => expect(state.installations[0].configuration?.renovate).toEqual({
      repository: 'acme/resume', automaticRuns: true, repetitionIntervalSeconds: 7200 }));
    cleanup(); await open();
    expect(automatic(await settings())).toHaveAttribute('aria-pressed', 'true');
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
    expect(automatic(group)).toHaveAttribute('aria-pressed', 'true');
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
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval (seconds)' })).not.toBeInTheDocument();
    fireEvent.click(automatic());
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


describe('REQ-OPERATOR-061 AC1/3/5: explicit active-session Activate', () => {
  const activationButton = () => screen.getByRole('button', { name: /^Activate(?: automatic runs)?$/i });
  const activationWrites = () => writes.filter(write => write.path === activationPath);
  const expectInert = () => {
    const button = screen.queryByRole('button', { name: /^Activate(?: automatic runs)?$/i });
    if (button) { expect(button).toBeDisabled(); fireEvent.click(button); }
    expect(activationWrites()).toEqual([]);
  };

  it('Save and Enable do not Activate, and only an explicit click submits the current active running generation', async () => {
    activeSession.set(sourceHost);
    setRunSettings('acme/automation', true, 900);
    await open(true);
    expect(activationButton()).toBeEnabled();
    expect(activationWrites()).toEqual([]);
    fireEvent.input(repository(await settings()), { target: { value: 'acme/reviewed' } });
    fireEvent.click(save());
    await screen.findByRole('button', { name: 'Enable' });
    expect(state.installations[0]).toMatchObject({ enabled: false, configuration: {
      ...retained, renovate: { repository: 'acme/reviewed', automaticRuns: true, repetitionIntervalSeconds: 900 },
    } });
    expectInert();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await screen.findByRole('button', { name: 'Disable' });
    expect(activationWrites()).toEqual([]);
    await waitFor(() => expect(activationButton()).toBeEnabled());
    // Scope disclosure is an intentional user-facing contract, not a service authority promise.
    expect(screen.getByText(/current.*(?:running )?session|active.*session/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(sourceHost.id))).toBeInTheDocument();
    fireEvent.click(activationButton());
    await waitFor(() => expect(activationWrites()).toEqual([{ path: activationPath, body: {
      installationId: 'installation-1', sessionId: sourceHost.id, sessionGeneration: sourceHost.generation,
    } }]));
    await waitFor(() => expect(screen.getAllByRole('status').some(element => /activated/i.test(element.textContent ?? ''))).toBe(true));
    expect(reads).not.toContain('/api/sessions');
    expect(writes.every(write => write.path === activationPath || /\/(configure|enable)$/.test(write.path))).toBe(true);
    cleanup(); await open(true);
    expect(activationWrites()).toHaveLength(1); // remount/login/read never reactivates
  });

  it('direct load without an active session explains the disabled action without discovering or starting another host', async () => {
    setRunSettings('acme/automation', true, 900);
    await open(true);
    expect(activationButton()).toBeDisabled();
    expect(screen.getByText(/(?:current|active).*running.*session|running.*(?:current|active).*session/i)).toBeInTheDocument();
    fireEvent.click(activationButton());
    expect(writes).toEqual([]); expect(reads).not.toContain('/api/sessions');
    expect(screen.queryByRole('combobox', { name: /host|session/i })).not.toBeInTheDocument();
  });

  it.each([
    { status: 'stopped', lifecycle: 'stopped', generation: 3 },
    { status: 'starting', lifecycle: 'starting', generation: 3 },
    { status: 'running', lifecycle: 'stopping', generation: 3 },
    { status: 'running', lifecycle: 'unreachable', generation: 3 },
    { status: 'running', lifecycle: 'running', generation: undefined },
    { status: 'running', lifecycle: 'running', generation: 0 },
    { status: 'running', lifecycle: 'running', generation: -1 },
    { status: 'running', lifecycle: 'running', generation: 1.5 },
    { status: 'running', lifecycle: 'running', generation: Number.MAX_SAFE_INTEGER + 1 },
  ])('a non-current running projection %j cannot activate', async projection => {
    activeSession.set({ ...sourceHost, ...projection });
    setRunSettings('acme/automation', true, 900);
    await open(true); expectInert();
    expect(reads).not.toContain('/api/sessions'); expect(writes).toEqual([]);
  });

  it.each(['non-admin', 'disabled', 'automatic-off', 'unset', 'unsupported'] as const)(
    '%s never offers a usable activation command', async fault => {
      activeSession.set(sourceHost); setRunSettings('acme/automation', true, 900);
      if (fault === 'disabled') state.installations[0].enabled = false;
      if (fault === 'automatic-off') setRunSettings('acme/automation', false, 900);
      if (fault === 'unset') state.installations[0].configuration = { ...retained };
      if (fault === 'unsupported') state.releases[0].intentVersion = '99';
      await open(fault !== 'non-admin'); expectInert();
      expect(reads).not.toContain('/api/sessions'); expect(writes).toEqual([]);
    });

  it.each([
    {},
    { activatedAt: 'not-an-instant', repositoryId: 424242 },
    { activatedAt: cutoff, repositoryId: -1 },
    { activatedAt: cutoff, repositoryId: 424242, accessJwt: 'must-not-be-browser-authority' },
  ])('an invalid activation response %j is unconfirmed, not success or a replay instruction', async response => {
    activate = async () => json(response, 202);
    activeSession.set(sourceHost); setRunSettings('acme/automation', true, 900);
    await open(true); fireEvent.click(activationButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/not confirmed|unavailable|failed/i);
    expect(screen.queryByText(/successfully activated|automatic runs activated/i)).not.toBeInTheDocument();
    expect(activationWrites()).toEqual([{ path: activationPath, body: {
      installationId: 'installation-1', sessionId: sourceHost.id, sessionGeneration: sourceHost.generation,
    } }]);
    expect(document.body).not.toHaveTextContent('must-not-be-browser-authority');
  });

  it('pending is visible and cannot submit twice; failed acknowledgement is not activation success or automatically replayed', async () => {
    let finish!: (response: Response) => void;
    activate = () => new Promise<Response>(resolve => { finish = resolve; });
    activeSession.set(sourceHost); setRunSettings('acme/automation', true, 900);
    await open(true);
    fireEvent.click(activationButton());
    await waitFor(() => expect(activationWrites()).toHaveLength(1));
    expect(activationButton()).toBeDisabled();
    expect(screen.getAllByRole('status').some(element => /activat.*…|activat.*\.\.\.|activating/i.test(element.textContent ?? ''))).toBe(true);
    fireEvent.click(activationButton());
    expect(activationWrites()).toHaveLength(1);
    finish(json({ error: 'Unconfirmed schedule' }, 503));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not confirmed|unavailable|failed/i);
    expect(screen.queryByText(/successfully activated|automatic runs activated/i)).not.toBeInTheDocument();
    expect(activationWrites()).toHaveLength(1);
    activate = async () => json({ activatedAt: cutoff, repositoryId: 424242 }, 202);
    const refresh = screen.queryByRole('button', { name: /Refresh current state/i });
    if (refresh) fireEvent.click(refresh);
    await waitFor(() => expect(activationButton()).toBeEnabled());
    expect(activationWrites()).toHaveLength(1);
    fireEvent.click(activationButton());
    await waitFor(() => expect(activationWrites()).toHaveLength(2));
    expect(activationWrites()[1].body).toEqual(activationWrites()[0].body);
  });

  it.each(['session', 'installation'] as const)('late activation success cannot attach to a changed %s scope', async changed => {
    let finish!: (response: Response) => void;
    activate = () => new Promise<Response>(resolve => { finish = resolve; });
    activeSession.set(sourceHost); setRunSettings('acme/automation', true, 900);
    await open(true); fireEvent.click(activationButton());
    await waitFor(() => expect(activationWrites()).toHaveLength(1));
    if (changed === 'session') activeSession.set({ ...sourceHost, id: 'newsession01', generation: 4 });
    else fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    finish(json({ activatedAt: cutoff, repositoryId: 424242 }, 202));
    await waitFor(() => expect(screen.queryByText(/activating/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/successfully activated|automatic runs activated/i)).not.toBeInTheDocument();
    expect(activationWrites()).toEqual([{ path: activationPath, body: {
      installationId: 'installation-1', sessionId: sourceHost.id, sessionGeneration: sourceHost.generation,
    } }]);
    if (changed === 'session') {
      fireEvent.click(activationButton());
      await waitFor(() => expect(activationWrites()).toHaveLength(2));
      expect(activationWrites()[1].body).toEqual({ installationId: 'installation-1', sessionId: 'newsession01', sessionGeneration: 4 });
    } else {
      const button = screen.queryByRole('button', { name: /^Activate(?: automatic runs)?$/i });
      if (button) expect(button).toBeDisabled();
      expect(activationWrites()).toHaveLength(1);
    }
    expect(reads).not.toContain('/api/sessions');
  });
});
