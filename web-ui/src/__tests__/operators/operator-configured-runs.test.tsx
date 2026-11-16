import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import OperatorRecovery from '../../components/OperatorRecovery';
import OperatorManagement from '../../components/OperatorManagement';
import OperatorActivityButton from '../../components/OperatorActivityButton';
import type { ApplicationDefinition, ApplicationRecoveryItem, ApplicationRecoveryResetInput, ManagementDetail } from '../../api/operator-management';

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

// Synthetic package contract; the historical nesting is data, not a Root convention.
const application: ApplicationDefinition = {
  controlVersion: 1,
  githubWriteRepositoriesPath: '/renovate/repository',
  schedule: { enabledPath: '/renovate/automaticRuns', intervalSecondsPath: '/renovate/repetitionIntervalSeconds' },
  configurationSchema: { type: 'object', properties: { renovate: { type: 'object', required: ['repository'], properties: {
    repository: { type: 'string', title: 'Repository', maxLength: 201, pattern: '^[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_-]{1,100}$' },
    automaticRuns: { type: 'boolean', title: 'Automatic runs', default: false },
    repetitionIntervalSeconds: { type: 'integer', title: 'Repeat interval', format: 'duration-seconds', default: 3600 },
  } } } },
};
const source = 'https://github.com/example/synthetic-application';
const grants = { users: ['manager@example.test'], groups: [] };
const policy = { capabilities: ['inference', 'fetch'], resourceProfileId: null, sourceResponseBytes: 524288 };
const retained = { unrelated: { labels: ['keep', 'these'] }, schedules: { external: 'retained' } };
const sourceHost = { id: 'ownersession1', name: 'Existing owner Host', createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessedAt: '2026-01-02T00:00:00.000Z', status: 'running', lifecycle: 'running', generation: 3,
  revision: 1, workspace: 'terminal', terminalMode: 'classic', agentType: 'bash' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(): ManagementDetail {
  return {
    operator: { id: 'operator-1', name: 'Synthetic Application', profile: 'dispatcher', realm: 'internal',
      repositoryId: 7654321, repositoryUrl: source, revision: 7, enabled: true,
      managers: grants, invokers: grants, policy: { ...policy, loggingEnabled: false, operationLimit: 2048, inferenceRequestBytes: 1048576 },
      source: { kind: 'github-release', repositoryUrl: source, repositoryId: 7654321,
        credentialConfigured: true, approvedWorkflow: { id: 7, ref: 'refs/heads/develop' } } },
    releases: [{ id: 'release-1', operatorId: 'operator-1', githubReleaseId: 456, sourceCommit: 'a'.repeat(40),
      manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64), interfaceVersion: 1, approved: true,
      application, name: 'Synthetic Application', coreVersion: '1', intentVersion: '3', version: '0.1.3',
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
let recoveryPreview: (body: { revision: number; after?: string }) => Promise<Response>;
let recoveryReset: (body: ApplicationRecoveryResetInput) => Promise<Response>;
const recovery = { label: 'Reset Locks',
  description: 'Reset failed PR processing locks so they can be retried. Previous runs and completed GitHub actions are preserved.',
  prefix: 'renovate:head:' };
const recoveryRow = (index: number, status: 'resettable' | 'blocked' = 'resettable'): ApplicationRecoveryItem => ({
  key: `${recovery.prefix}${index}`, version: index.toString(16).padStart(64, '0'), label: `PR ${index}`, status,
  reason: status === 'blocked' ? 'Processing is still active.' : 'Failed processing.',
});
const activationPath = '/api/operator-activities/automatic/activation';
const cutoff = '2026-11-11T00:00:00.000Z';
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  hosts = [sourceHost]; hostError = false; canInvoke = true;
  state = fixture(); writes = []; reads = []; conflict = false;
  activeSession.list(undefined); activeSession.set(undefined);
  automaticStatus = 'inactive';
  recoveryPreview = async () => json({ items: [recoveryRow(1), recoveryRow(2, 'blocked')], nextCursor: null });
  recoveryReset = async body => json({ requestId: body.requestId, reset: body.entries.length, skipped: [] });
  activate = async () => { automaticStatus = 'active'; return json({ activatedAt: cutoff }, 202); };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    const path = url.pathname;
    if (path.endsWith('/options')) return json({ users: grants.users, groups: [],
      capabilities: ['inference', 'fetch'], resourceProfileIds: [],
      ceiling: { capabilities: ['inference', 'fetch'], resourceProfileIds: [], sourceResponseBytes: 1048576 } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path.endsWith('/recovery/preview')) return recoveryPreview(body);
      if (path.endsWith('/recovery/reset')) return recoveryReset(body);
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
    state.operator.enabled = state.installations.some(item => item.enabled);
    reads.push(path);
    if (path.endsWith('/operator-1')) return json(state);
    if (path.endsWith('/operators')) return json({ items: [state.operator], cursor: null });
    if (path === '/api/sessions') return hostError ? json({ error: 'Unavailable' }, 503) : json({ sessions: hosts });
    if (path === '/api/operator-activities/installations') return json({ items: state.installations.map(item => ({
      id: item.id, operatorId: item.operatorId, name: 'Synthetic Application', installationName: item.name,
      revision: item.revision, enabled: item.enabled, approved: state.releases[0].approved, version: 'v0.1.3',
      profile: 'dispatcher', canManage: true, canInvoke: canInvoke, canActivateAutomaticRuns: canInvoke, automaticRunStatus: automaticStatus,
      application: state.releases[0].application, guidedMode: null, repository: (item.configuration?.renovate as any)?.repository ?? null,
      automaticRuns: (item.configuration?.renovate as any)?.automaticRuns ?? false,
      repetitionIntervalSeconds: (item.configuration?.renovate as any)?.repetitionIntervalSeconds ?? 3600,
    })), cursor: null });
    if (path.endsWith('/preview')) return json({ name: 'Synthetic Application', version: 'v0.1.3',
      application, inputSchema: { type: 'object', properties: {} }, description: 'Runs with the saved application configuration.',
      guidedAssessment: false, guidedMode: null, requiresSourceHost: false });
    if (path === '/api/operator-activities') return json({ items: [], nextCursor: null, workingCount: 0, unreadCount: 0, latestSequence: 0 });
    return json({ error: 'Not found' }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open(isAdmin = false) {
  window.history.replaceState({}, '', '/operators');
  render(() => <OperatorManagement isAdmin={isAdmin} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Synthetic Application' }));
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
function repository(group: HTMLElement) { return within(group).getByRole('textbox', { name: 'Repository' }) as HTMLInputElement; }
function interval(group: HTMLElement) { return within(group).getByRole('spinbutton', { name: 'Repeat interval' }); }
function automatic(_group?: HTMLElement) { return screen.getByRole('checkbox', { name: 'Automatic runs' }); }
function save() { return screen.getByRole('button', { name: /Save run settings/i }); }
function submit() { fireEvent.submit(save().closest('form')!); }
function setRunSettings(repository: string, automaticRuns: boolean, repetitionIntervalSeconds: number) {
  state.installations[0].configuration = { ...retained, renovate: { repository, automaticRuns, repetitionIntervalSeconds } };
}

describe('application-owned run settings', () => {
  it.each(['3', '4'])('REQ-OPERATOR-061: intent %s does not override metadata exposing the saved repository and Save action without a read mutation', async intentVersion => {
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

  it('REQ-OPERATOR-061: application-owned run settings default to an unset required repository, automatic off and 3600 seconds without a read mutation', async () => {
    await open();
    const group = await settings();
    expect(repository(group)).toHaveValue('');
    expect(repository(group)).toBeRequired();
    expect(automatic(group)).not.toBeChecked();
    expect(within(group).queryByRole('spinbutton', { name: 'Repeat interval' })).not.toBeInTheDocument();
    expect(group).not.toHaveTextContent(/1 hour/i);
    expect(automatic()).not.toBeChecked();
    expect(within(group).getByText(/Saving run settings disables.*does not start a run/i)).toBeVisible();
    expect(repository(group).checkValidity()).toBe(false);
    submit();
    expect(writes).toEqual([]);
    expect(state.installations[0].configuration).toEqual(retained);
  });

  it('REQ-OPERATOR-061: declared repository bounds reject excess input and preserve a corrected maximum-length value on save', async () => {
    setRunSettings('acme/valid', false, 3600);
    const before = structuredClone(state.installations);
    await open();
    const group = await settings();
    const maximum = `${'a'.repeat(100)}/${'b'.repeat(100)}`;
    fireEvent.input(repository(group), { target: { value: `${maximum}b` } });
    expect(repository(group).checkValidity()).toBe(false);
    submit();
    expect(writes).toEqual([]);
    expect(state.installations).toEqual(before);
    fireEvent.input(repository(group), { target: { value: maximum } });
    expect(repository(group).checkValidity()).toBe(true);
    submit();
    await waitFor(() => expect(writes).toEqual([{
      path: '/api/operator-management/installations/installation-1/configure',
      body: { revision: 4, policy, configuration: { ...retained,
        renovate: { repository: maximum, automaticRuns: false, repetitionIntervalSeconds: 3600 } } },
    }]));
    expect(state.installations[0].configuration?.renovate).toEqual({
      repository: maximum, automaticRuns: false, repetitionIntervalSeconds: 3600,
    });
    expect(state.installations[1]).toEqual(before[1]);
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

  it.each(['3', '4'])('REQ-OPERATOR-061: intent %s metadata-backed run settings save the public wire contract, reload retained values and isolate other installations until explicit re-enable', async intentVersion => {
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
    expect(state.operator).toEqual({ ...before.operator, enabled: false });
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

  it('REQ-OPERATOR-061: application-owned run settings retain the interval when automatic runs are switched off and leave manual runs available', async () => {
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
    expect(await screen.findByRole('button', { name: 'Start run' })).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: 'Repository' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /source.*host/i })).not.toBeInTheDocument();
    expect(reads).not.toContain('/api/sessions');
  });

  it('REQ-OPERATOR-061: application-owned run settings switching automatic runs back on restores the saved interval rather than resetting it', async () => {
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

  it('REQ-OPERATOR-061: application-owned run settings reset only the repeat interval to 3600 and preserve restrictions and unrelated schedules', async () => {
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
    'REQ-OPERATOR-061: declared configuration schema rejects invalid repository %j even with automatic runs off', async invalid => {
      setRunSettings('acme/valid', false, 3600);
      const before = structuredClone(state.installations);
      await open();
      const group = await settings();
      fireEvent.input(repository(group), { target: { value: invalid } });
      expect(repository(group).checkValidity()).toBe(false);
      submit();
      expect(writes).toEqual([]);
      expect(state.installations).toEqual(before);
      fireEvent.input(repository(group), { target: { value: 'acme/valid' } });
      expect(repository(group).checkValidity()).toBe(true);
      submit();
      await waitFor(() => expect(writes).toEqual([{
        path: '/api/operator-management/installations/installation-1/configure',
        body: { revision: 4, policy, configuration: before[0].configuration },
      }]));
    });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])(
    'REQ-OPERATOR-061: application-owned run settings reject invalid enabled interval %j without mutation', async invalid => {
      setRunSettings('acme/valid', true, 3600);
      const before = structuredClone(state.installations);
      await open();
      fireEvent.change(within(await settings()).getByRole('combobox', { name: 'Interval unit' }), { target: { value: 'seconds' } });
      fireEvent.input(interval(await settings()), { target: { value: invalid } });
      expect(save()).toBeDisabled();
      submit();
      expect(writes).toEqual([]);
      expect(state.installations).toEqual(before);
    });

  it('REQ-OPERATOR-061: application-owned run settings restriction-only saves retain the configured repository, toggle and interval', async () => {
    setRunSettings('acme/restricted', false, 7200);
    const configuration = structuredClone(state.installations[0].configuration);
    await open(); await settings();
    fireEvent.click(screen.getByText('Advanced settings', { selector: 'summary' }));
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

  it('REQ-OPERATOR-061: application-owned run settings reconcile stale revisions before a deliberate save at the refreshed revision', async () => {
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

  it('REQ-OPERATOR-061: application-owned run settings save only the explicitly selected secondary installation at its own revision', async () => {
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
    'application metadata, not %s identity or intent, exposes run settings', async kind => {
      if (kind === 'legacy') state.releases[0].intentVersion = '2';
      if (kind === 'unsupported-intent') state.releases[0].intentVersion = '99';
      if (kind === 'third-party') state.operator.repositoryUrl = 'https://github.com/acme/dispatcher';
      if (kind === 'wrong-identity') state.operator.repositoryId = 123;
      await open();
      expect(repository(await settings())).toBeRequired();
      expect(writes).toEqual([]);
    });

  it('does not infer application controls from a recognized historical package identity', async () => {
    state.operator.name = 'Renovate Dispatcher';
    state.operator.repositoryUrl = 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher';
    state.operator.repositoryId = 1380652724;
    delete state.releases[0].application;
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Renovate Dispatcher' }));
    await screen.findByRole('region', { name: 'Installed version' });
    expect(screen.queryByRole('group', { name: 'Run settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run operator' })).not.toBeInTheDocument();
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
    expect(screen.getByText(/Use Deactivate to revoke this delegation; Cloudflare sign-out does not revoke it/)).toBeVisible();
    expect(writes).toEqual([]);
    fireEvent.click(activateButton());
    await waitFor(() => expect(writes).toEqual([
      { path: '/api/operator-management/installations/installation-1/enable', body: { enabled: true, revision: 4 } },
      { path: activationPath, body: { installationId: 'installation-1', revision: 5 } },
    ]));
    expect(reads).not.toContain('/api/sessions');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled());
  });
  it('saving the sole enabled configuration permits a fresh explicit enable-and-arm without a workspace', async () => {
    hosts = []; setRunSettings('acme/automation', true, 900);
    await open(true);
    const group = await settings();
    fireEvent.input(repository(group), { target: { value: 'acme/changed' } });
    fireEvent.click(save());
    await waitFor(() => expect(state.operator.enabled).toBe(false));
    await waitFor(() => expect(activateButton()).toBeEnabled());
    const revision = state.installations[0].revision;
    writes = [];
    fireEvent.click(activateButton());
    await waitFor(() => expect(writes).toEqual([
      { path: '/api/operator-management/installations/installation-1/enable', body: { enabled: true, revision } },
      { path: activationPath, body: { installationId: 'installation-1', revision: revision + 1 } },
    ]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled());
    expect(reads).not.toContain('/api/sessions');
  });
  it('an expired installation rearms from the same single Activate without toggling availability or requiring a workspace', async () => {
    hosts = []; setRunSettings('acme/automation', true, 900); automaticStatus = 'expired';
    await open(true); await waitFor(() => expect(activateButton()).toBeEnabled());
    expect(screen.getByText(/Automatic runs: expired/)).toBeVisible();
    fireEvent.click(activateButton());
    await waitFor(() => expect(writes).toEqual([{ path: activationPath, body: { installationId: 'installation-1', revision: 4 } }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled());
    expect(reads).not.toContain('/api/sessions');
  });
  it('manual-only Activate enables availability without scheduling, Deactivate disables it', async () => {
    setRunSettings('acme/manual', false, 900); state.installations[0].enabled = false;
    await open(true);
    await waitFor(() => expect(activateButton()).toBeEnabled());
    fireEvent.click(activateButton());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(activateButton()).toBeEnabled());
    expect(writes).toEqual([
      { path: '/api/operator-management/installations/installation-1/enable', body: { enabled: true, revision: 4 } },
      { path: '/api/operator-management/installations/installation-1/enable', body: { enabled: false, revision: 5 } },
    ]);
    expect(state.installations[0].enabled).toBe(false);
  });
  it.each([{}, { activatedAt: 'invalid' }, { activatedAt: cutoff, accessJwt: 'private' }])(
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
    finish(json({ activatedAt: cutoff }, 202));
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

  it.each([[900, 900, 15, 'minutes'], [86400, 86400, 24, 'hours']] as const)(
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

async function recoverySurface(surface: 'settings' | 'dropdown', declared = true) {
  state.releases[0].application = { ...application, ...(declared ? { recovery } : {}) };
  if (surface === 'settings') return open();
  render(() => <OperatorActivityButton enabled />);
  fireEvent.click(await screen.findByRole('button', { name: 'Operator activity' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Installed' }));
  return screen.findByRole('article', { name: 'Primary' });
}
const previewPath = '/api/operator-management/installations/installation-1/recovery/preview';
const resetPath = '/api/operator-management/installations/installation-1/recovery/reset';

describe('application-owned lock recovery', () => {
  it.each(['settings', 'dropdown'] as const)('%s omits undeclared recovery', async surface => {
    const panel = await recoverySurface(surface, false);
    expect(within(panel).queryByRole('button', { name: 'Reset Locks' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it.each(['settings', 'dropdown'] as const)('%s previews read-only and confirms only exact eligible versions', async surface => {
    const panel = await recoverySurface(surface);
    const before = structuredClone(state);
    const button = within(panel).getByRole('button', { name: 'Reset Locks' });
    expect(button).toHaveAttribute('title', recovery.description);
    button.focus();
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleDescription(recovery.description);
    fireEvent.mouseOver(button);
    fireEvent.click(button);
    await within(panel).findByText('1 eligible locks.');
    expect(within(panel).getByText('PR 2 — Blocked: Processing is still active.')).toBeVisible();
    expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }]);
    expect(state).toEqual(before);
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset 1 locks' }));
    await within(panel).findByText('1 locks reset; 0 skipped. No run or settings change was requested.');
    expect(writes).toEqual([
      { path: previewPath, body: { revision: 4 } },
      { path: resetPath, body: { revision: 4, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        entries: [{ key: recoveryRow(1).key, version: recoveryRow(1).version }] } },
    ]);
    expect(state).toEqual(before);
  });

  it('cancels a read-only preview and returns keyboard focus without changing settings', async () => {
    const panel = await recoverySurface('settings');
    const before = structuredClone(state);
    const button = within(panel).getByRole('button', { name: 'Reset Locks' });
    fireEvent.click(button);
    await within(panel).findByText('1 eligible locks.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(button).toHaveFocus();
    expect(within(panel).queryByRole('button', { name: 'Reset 1 locks' })).not.toBeInTheDocument();
    expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }]);
    expect(state).toEqual(before);
  });

  it.each(['oversized-page', 'invalid-version', 'oversized-key', 'oversized-reason', 'oversized-label', 'oversized-scope', 'invalid-scope'] as const)(
    'refuses an invalid %s wire preview rather than making it resettable', async invalid => {
      const row = recoveryRow(1);
      const items = invalid === 'oversized-page' ? Array.from({ length: 65 }, (_, index) => recoveryRow(index)) : [{
        ...row,
        ...(invalid === 'invalid-version' ? { version: 'not-a-version' } : {}),
        ...(invalid === 'oversized-key' ? { key: 'k'.repeat(1025) } : {}),
        ...(invalid === 'oversized-reason' ? { reason: 'r'.repeat(257) } : {}),
        ...(invalid === 'oversized-label' ? { label: 'l'.repeat(257) } : {}),
      }];
      recoveryPreview = async () => json({ items, nextCursor: null,
        ...(invalid === 'oversized-scope' ? { scopeCursor: 's'.repeat(16 * 1024 + 1) } : {}),
        ...(invalid === 'invalid-scope' ? { scopeCursor: 1 } : {}) });
      const panel = await recoverySurface('settings');
      fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
      await within(panel).findByText(/Preview unavailable or incomplete/);
      expect(within(panel).getByRole('button', { name: 'Reset 0 locks' })).toBeDisabled();
      expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }]);
    });

  it('uses arbitrary package copy rather than operator identity to expose recovery', async () => {
    state.releases[0].application = { controlVersion: 1, recovery: {
      label: 'Repair queue', description: 'Inspect failed queue entries.', prefix: 'queue:' } };
    await open();
    expect(screen.getByRole('button', { name: 'Repair queue' })).toHaveAccessibleDescription('Inspect failed queue entries.');
    expect(screen.queryByRole('button', { name: 'Reset Locks' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('preserves an escaped-key cursor through continuation and reset', async () => {
    const row = { ...recoveryRow(1), key: `${recovery.prefix}${'\u0001'.repeat(1000)}` };
    const anchor = { key: row.key, version: row.version };
    const scopeCursor = JSON.stringify({ phase: 'records', anchor });
    const nextCursor = JSON.stringify({ phase: 'records', anchor, after: '["l",""]' });
    expect(scopeCursor.length).toBeGreaterThan(4096);
    recoveryPreview = async body => json({ items: body.after ? [] : [row],
      nextCursor: body.after ? null : nextCursor, scopeCursor });
    const panel = await recoverySurface('settings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Load more locks' }));
    const confirm = await within(panel).findByRole('button', { name: 'Reset 1 locks' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await within(panel).findByText('1 locks reset; 0 skipped. No run or settings change was requested.');
    expect(writes.filter(write => write.path === previewPath).map(write => write.body)).toEqual([
      { revision: 4 }, { revision: 4, after: nextCursor },
    ]);
    expect(writes.find(write => write.path === resetPath)?.body).toEqual({ revision: 4,
      requestId: expect.any(String), entries: [{ key: row.key, version: row.version }], scopeCursor });
  });

  it.each([undefined, 'opaque-owned-anchor'])('loads every page before enabling confirmation, chunks at 64 and preserves versions, revision and scope witness %s', async scopeCursor => {
    const rows = Array.from({ length: 65 }, (_, index) => recoveryRow(index));
    const witness = scopeCursor === undefined ? {} : { scopeCursor };
    recoveryPreview = async body => json({ items: body.after ? rows.slice(64) : rows.slice(0, 64),
      nextCursor: body.after ? null : 'page-two', ...(!body.after ? witness : {}) });
    const panel = await recoverySurface('settings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    expect(await within(panel).findByRole('button', { name: 'Reset 64 locks' })).toBeDisabled();
    const more = within(panel).getByRole('button', { name: 'Load more locks' });
    await waitFor(() => expect(more).toBeEnabled());
    fireEvent.click(more);
    const confirm = await within(panel).findByRole('button', { name: 'Reset 65 locks' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await within(panel).findByText('65 locks reset; 0 skipped. No run or settings change was requested.');
    const requests = writes.filter(write => write.path === resetPath).map(write => write.body as ApplicationRecoveryResetInput);
    expect(requests.map(({ requestId: _requestId, ...body }) => body)).toEqual([
      { revision: 4, ...witness, entries: rows.slice(0, 64).map(({ key, version }) => ({ key, version })) },
      { revision: 4, ...witness, entries: rows.slice(64).map(({ key, version }) => ({ key, version })) },
    ]);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    expect(writes.filter(write => write.path === previewPath).map(write => write.body)).toEqual([
      { revision: 4 }, { revision: 4, after: 'page-two' },
    ]);
    expect(writes.every(write => [previewPath, resetPath].includes(write.path))).toBe(true);
  });

  it.each(['stale', 'unavailable', 'duplicate-cursor'] as const)('refuses incomplete %s previews', async failure => {
    recoveryPreview = async () => failure === 'duplicate-cursor'
      ? json({ items: [], nextCursor: 'repeat' })
      : json({ error: 'Not available' }, failure === 'stale' ? 409 : 503);
    const panel = await recoverySurface('settings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    if (failure === 'duplicate-cursor') {
      fireEvent.click(await within(panel).findByRole('button', { name: 'Load more locks' }));
    }
    await within(panel).findByText(failure === 'stale' ? /This preview is stale/ : /Preview unavailable or incomplete/);
    expect(within(panel).getByRole('button', { name: 'Reset 0 locks' })).toBeDisabled();
    expect(writes.every(write => write.path === previewPath)).toBe(true);
  });

  it('requires a new preview after a stale reset, without automatically resetting newer claims', async () => {
    recoveryReset = async () => json({ error: 'New claim' }, 409);
    const panel = await recoverySurface('settings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Reset 1 locks' }));
    await within(panel).findByText(/0 locks confirmed reset.*This preview is stale/);
    expect(within(panel).getByRole('button', { name: 'Reset 1 locks' })).toBeDisabled();
    expect(writes.map(write => write.path)).toEqual([previewPath, resetPath]);
  });

  it('shows skipped outcomes and their reasons without resetting them again', async () => {
    recoveryReset = async body => json({ requestId: body.requestId, reset: 0,
      skipped: [{ key: body.entries[0].key, reason: 'Claim version changed.' }] });
    const panel = await recoverySurface('settings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Reset 1 locks' }));
    await within(panel).findByText('0 locks reset; 1 skipped. No run or settings change was requested.');
    expect(within(panel).getByText(`${recoveryRow(1).key} — Skipped: Claim version changed.`)).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Reset 1 locks' })).toBeDisabled();
  });

  it.each([0, 64])('keeps %i prior successes truthful after a lost response and permits inspection only', async confirmed => {
    const rows = Array.from({ length: confirmed ? 129 : 1 }, (_, index) => recoveryRow(index));
    recoveryPreview = async body => {
      const offset = Number(body.after ?? 0);
      return json({ items: rows.slice(offset, offset + 64), nextCursor: offset + 64 < rows.length ? String(offset + 64) : null });
    };
    recoveryReset = async body => {
      if (confirmed && body.entries[0].key === rows[0].key) return json({ requestId: body.requestId, reset: 64, skipped: [] });
      throw new TypeError('Response lost');
    };
    const panel = await recoverySurface('settings');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    if (confirmed) {
      expect(await within(panel).findByRole('button', { name: 'Reset 64 locks' })).toBeDisabled();
      const more = await within(panel).findByRole('button', { name: 'Load more locks' });
      await waitFor(() => expect(more).toBeEnabled());
      fireEvent.click(more);
      expect(await within(panel).findByRole('button', { name: 'Reset 128 locks' })).toBeDisabled();
      await waitFor(() => expect(more).toBeEnabled());
      fireEvent.click(more);
    }
    const confirm = await within(panel).findByRole('button', { name: `Reset ${rows.length} locks` });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await within(panel).findByText(new RegExp(`${confirmed} locks confirmed reset.*Reset outcome unconfirmed.*${confirmed ? 1 : 0} not submitted`));
    const operations = writes.filter(write => write.path === resetPath);
    for (const operation of operations) expect(panel).toHaveTextContent((operation.body as ApplicationRecoveryResetInput).requestId);
    fireEvent.click(within(panel).getByRole('button', { name: 'Inspect current locks' }));
    await within(panel).findByText(confirmed ? '64 eligible locks in the loaded preview (incomplete).' : '1 eligible locks.');
    expect(within(panel).getByRole('button', { name: `Reset ${confirmed ? 64 : 1} locks` })).toBeDisabled();
    const check = within(panel).getByRole('button', { name: 'Check reset result' });
    await waitFor(() => expect(check).toBeEnabled());
    expect(writes.filter(write => write.path === resetPath)).toEqual(operations);
    const lostRequest = operations[operations.length - 1].body as ApplicationRecoveryResetInput;
    recoveryReset = async body => {
      expect(body).toEqual(lostRequest);
      return json({ requestId: body.requestId, reset: body.entries.length, skipped: [] });
    };
    fireEvent.click(within(panel).getByRole('button', { name: 'Check reset result' }));
    await within(panel).findByText(new RegExp(`${confirmed + lostRequest.entries.length} locks confirmed reset.*${confirmed ? 1 : 0} not submitted.*explicitly confirm`));
    expect(writes.filter(write => write.path === resetPath)).toEqual([...operations, operations[operations.length - 1]]);
    expect(within(panel).queryByRole('button', { name: 'Check reset result' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: `Reset ${confirmed ? 64 : 1} locks` })).toBeDisabled();
  });

  it.each(['revision', 'installation', 'prefix'] as const)('reconciles only the original lost-ack request after revision changes, with late %s change', async change => {
    const [revision, setRevision] = createSignal(4);
    const [installationId, setInstallationId] = createSignal('installation-1');
    const [prefix, setPrefix] = createSignal(recovery.prefix);
    const scopeCursor = 'original-owned-anchor';
    recoveryPreview = async () => json({ items: [recoveryRow(1)], nextCursor: null, scopeCursor });
    recoveryReset = async () => { throw new TypeError('Response lost'); };
    render(() => <OperatorRecovery installationId={installationId()} revision={revision()}
      recovery={{ ...recovery, prefix: prefix() }} />);
    const before = structuredClone(state);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Locks' }));
    const reset = await screen.findByRole('button', { name: 'Reset 1 locks' });
    await waitFor(() => expect(reset).toBeEnabled());
    expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }]);
    fireEvent.click(reset);
    await screen.findByText(/Reset outcome unconfirmed/);
    const original = writes[1];
    expect(original).toEqual({ path: resetPath, body: { revision: 4, scopeCursor,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      entries: [{ key: recoveryRow(1).key, version: recoveryRow(1).version }] } });
    setRevision(5);
    expect(reset).toBeDisabled();
    const check = screen.getByRole('button', { name: 'Check reset result' });
    expect(check).toBeEnabled();
    expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }, original]);
    let resolve!: (response: Response) => void;
    recoveryReset = () => new Promise(done => { resolve = done; });
    fireEvent.click(check);
    await waitFor(() => expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }, original, original]));
    if (change === 'revision') setRevision(6);
    else if (change === 'installation') setInstallationId('installation-2');
    else setPrefix('other:');
    resolve(json({ requestId: (original.body as ApplicationRecoveryResetInput).requestId, reset: 1, skipped: [] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
    if (change === 'revision') {
      expect(screen.getByText(/1 locks confirmed reset.*explicitly confirm/)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Check reset result' })).not.toBeInTheDocument();
    } else {
      expect(check).toBeDisabled();
      expect(screen.getByText(/Reset outcome unconfirmed/)).toBeVisible();
      expect(screen.queryByText(/1 locks confirmed reset/)).not.toBeInTheDocument();
    }
    expect(reset).toBeDisabled();
    expect(state).toEqual(before);
    expect(writes).toEqual([{ path: previewPath, body: { revision: 4 } }, original, original]);
  });

  it('holds dropdown navigation and other actions while confirmation is pending', async () => {
    let resolve!: (response: Response) => void;
    let request!: ApplicationRecoveryResetInput;
    recoveryReset = body => { request = body; return new Promise(done => { resolve = done; }); };
    const panel = await recoverySurface('dropdown');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset Locks' }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Reset 1 locks' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close operators' })).toBeDisabled());
    expect(within(panel).getByRole('button', { name: 'Run once' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Configure' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh installations' })).toBeDisabled();
    resolve(json({ requestId: request.requestId, reset: 1, skipped: [] }));
    await within(panel).findByText('1 locks reset; 0 skipped. No run or settings change was requested.');
    expect(screen.getByRole('button', { name: 'Close operators' })).toBeEnabled();
  });
});
