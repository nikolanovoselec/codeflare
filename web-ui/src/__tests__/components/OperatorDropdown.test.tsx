import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OperatorActivityButton from '../../components/OperatorActivityButton';
import { ApiError } from '../../api/fetch-helper';

const server = vi.hoisted(() => ({
  page: [] as Array<Record<string, unknown>>, older: [] as Array<Record<string, unknown>>,
  installations: [] as Array<Record<string, unknown>>, detail: {} as Record<string, unknown>,
  management: {} as Record<string, unknown>, preview: {} as Record<string, unknown>,
  prepared: {} as Record<string, { installationId: string; invocation: unknown; phase: string }>,
  nextCursor: null as string | null, installCursor: null as string | null,
  previewError: false, installError: false, prepareError: false, startError: false, saveError: false,
  startWait: null as Promise<void> | null, reconcileError: false,
  configuration: { renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' },
  savedPolicy: null as unknown, savedRevision: null as number | null,
}));
vi.mock('../../api/operator-activities', () => ({
  listOperatorActivities: async (cursor: string | null) => ({ items: cursor ? server.older : server.page,
    nextCursor: cursor ? null : server.nextCursor, workingCount: 0, unreadCount: 0, latestSequence: 1 }),
  acknowledgeOperatorActivities: async () => ({ unreadCount: 0 }),
  getOperatorActivity: async () => server.detail,
  cancelOperatorActivity: async () => server.detail,
  getOperatorActivityDiagnostics: async () => { throw new Error('Diagnostics unavailable'); },
  getOperatorActivityDiagnosticHistory: async () => { throw new Error('Diagnostics unavailable'); },
  getOperatorActivityDiagnosticRecord: async () => { throw new Error('Diagnostics unavailable'); },
  exportOperatorActivityDiagnostics: async () => { throw new Error('Diagnostics unavailable'); },
}));
vi.mock('../../api/operator-management', () => ({
  listOperatorInstallations: async () => {
    if (server.installError) throw new Error('Unavailable');
    return { items: server.installations, cursor: server.installCursor };
  },
  getInstallationActivityPreview: async () => {
    if (server.previewError) throw new Error('Unavailable');
    return server.preview;
  },
  getManagedOperator: async () => server.management,
  configureInstallation: async (_id: string, value: { revision: number; policy: unknown; configuration: typeof server.configuration }) => {
    if (server.saveError) throw new ApiError('Conflict', 409, 'Conflict');
    server.configuration = structuredClone(value.configuration); server.savedPolicy = value.policy;
    server.savedRevision = value.revision;
    const installation = { id: 'install-1', revision: value.revision + 1, enabled: false,
      policy: value.policy, configuration: server.configuration };
    server.installations = server.installations.map(item => ({ ...item, enabled: false, revision: installation.revision,
      automaticRuns: value.configuration.renovate.automaticRuns, repetitionIntervalSeconds: value.configuration.renovate.repetitionIntervalSeconds }));
    server.management = { ...server.management, installations: [installation] };
    return installation;
  },
  prepareInstallationActivity: async (installationId: string, invocation: unknown) => {
    if (server.prepareError) throw new Error('Preparation unavailable');
    const activityId = `prepared-${Object.keys(server.prepared).length + 1}`;
    server.prepared[activityId] = { installationId, invocation, phase: 'prepared' };
    return { activityId, startCapability: 'PRIVATE_START_CAPABILITY', startExpiresAt: Date.now() + 60000 };
  },
  startInstallationActivity: async (id: string) => {
    if (server.startWait) await server.startWait;
    if (server.startError) throw new Error('Start response lost');
    server.prepared[id].phase = 'queued';
    return { ok: true };
  },
  getOwnedActivity: async (id: string) => {
    if (server.reconcileError) throw new Error('Activity unavailable');
    return { ...server.detail, activityId: id, executionStatus: server.prepared[id]?.phase ?? 'unknown' };
  },
}));
const row = (id: string, name = 'Renovate Dispatcher') => ({ activityId: id, operatorId: 'dispatcher', operatorName: name,
  context: 'acme/updates', executionStatus: 'completed', cleanupStatus: 'released', collectionStatus: 'consumed',
  attention: false, sessionId: null, source: null, updatedAt: new Date().toISOString() });
const installation = (extra: Record<string, unknown> = {}) => ({ id: 'install-1', operatorId: 'dispatcher',
  name: 'Renovate Dispatcher', installationName: 'Updates', version: 'v0.1.27', revision: 7,
  enabled: true, approved: true, canInvoke: true, canManage: true, guidedMode: 'repository',
  repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600, ...extra });
async function open(segment = 'Runs') {
  render(() => <OperatorActivityButton enabled />);
  await fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Runs' })).toBeTruthy());
  if (segment !== 'Runs') await fireEvent.click(screen.getByRole('tab', { name: segment }));
}
async function review() {
  await open('Installed');
  await fireEvent.click(await screen.findByRole('button', { name: /run manually/i }));
  await screen.findByRole('heading', { name: 'Start a manual run' });
}
beforeEach(() => {
  server.page = [row('run-1')]; server.older = [row('older-run')]; server.installations = [installation()];
  server.detail = { ...row('run-1'), sdkCleanupReleased: true, checkpoint: null,
    result: { repository: 'acme/updates', results: [{ pullRequest: 42, decision: 'DO_NOT_MERGE', outcome: 'NOT_MERGED',
      comment: 'Compatibility evidence is unavailable.\n\n' + 'Readable assessment. '.repeat(90) }] } };
  server.preview = { name: 'Renovate Dispatcher', version: 'v0.1.27', guidedAssessment: true,
    guidedMode: 'repository', configuredRepository: 'acme/updates' };
  server.configuration = { renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' };
  server.management = { installations: [{ id: 'install-1', revision: 7, enabled: true,
    policy: { capabilities: ['fetch', 'inference'], resourceProfileId: null }, configuration: server.configuration }] };
  server.prepared = {}; server.nextCursor = null; server.installCursor = null;
  server.previewError = false; server.installError = false; server.prepareError = false; server.startError = false;
  server.saveError = false; server.reconcileError = false; server.startWait = null;
  server.savedPolicy = null; server.savedRevision = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('REQ-OPERATOR-086: dropdown Runs and Installed workspace', () => {
  it('AC1/8: keeps segments and nested navigation in the existing dialog without preparing work on opening', async () => {
    await review();
    expect(screen.getByRole('tab', { name: 'Installed' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to installed operators' })).toBeTruthy();
    expect(server.prepared).toEqual({});
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Installed operators' })).toBeTruthy();
    expect(server.prepared).toEqual({});
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Operator activity' }));
  });

  it('AC2: preserves current-page search and pagination when details return or no rows match', async () => {
    server.page.push({ ...row('run-2', 'Pull Request Reviewer'), operatorId: 'reviewer' });
    server.nextCursor = 'run-2';
    await open();
    const search = screen.getByRole('searchbox', { name: 'Find a run' });
    await fireEvent.input(search, { target: { value: 'Renovate' } });
    expect(screen.queryByRole('button', { name: 'View run-2' })).toBeNull();
    expect(screen.getByText(/current page/i)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'View run-1' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Back to activities' }));
    expect((screen.getByRole('searchbox', { name: 'Find a run' }) as HTMLInputElement).value).toBe('Renovate');
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a run' }), { target: { value: 'no-match' } });
    expect(screen.getByText(/no matching runs/i)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Load next 5' }));
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a run' }), { target: { value: '' } });
    expect(await screen.findByRole('button', { name: 'View older-run' })).toBeTruthy();
  });

  it('AC2: filters the visible page by operator independently of execution state', async () => {
    server.page.push({ ...row('run-2', 'Pull Request Reviewer'), operatorId: 'reviewer' });
    await open();
    await fireEvent.change(screen.getByRole('combobox', { name: 'Filter runs by operator' }), { target: { value: 'reviewer' } });
    expect(screen.queryByRole('button', { name: 'View run-1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View run-2' })).toBeTruthy();
  });

  it('AC3: presents supplied version and outcomes separately from completed execution, without inventing missing counts', async () => {
    server.page = [{ ...row('run-1'), version: 'v0.1.27', resultSummary: { assessed: 1, merged: 0, notMerged: 1, deferred: 0, unknown: 0 } }];
    await open();
    expect(screen.getByText('v0.1.27')).toBeTruthy();
    expect(screen.getByText('0 merged')).toBeTruthy();
    expect(screen.getByText('1 not merged')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.queryByText(/all clear/i)).toBeNull();
  });

  it('AC3: makes unavailable outcome metadata explicit rather than showing zero merges', async () => {
    await open();
    expect(await screen.findByText('Outcome details unavailable')).toBeTruthy();
    expect(screen.queryByText('0 merged')).toBeNull();
  });

  it('AC4: exposes full bounded multiline assessments and safe PR links without treating SDK release as physical cessation', async () => {
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'View run-1' }));
    await waitFor(() => expect(screen.getByText(/SDK release confirmed/)).toBeTruthy());
    expect(screen.getByText(/Collection: consumed/)).toBeTruthy();
    const full = screen.getByText('Read full assessment');
    await fireEvent.click(full);
    expect(screen.getByText(/Readable assessment\./).textContent).toContain('Readable assessment. '.repeat(90));
    expect(screen.getByRole('link', { name: 'PR #42' }).getAttribute('href')).toBe('https://github.com/acme/updates/pull/42');
    expect(screen.queryByText(/physically stopped/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'View diagnostics' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy activity ID' })).toBeTruthy();
  });

  it('AC4: keeps explicitly opened diagnostics visible across elapsed time, focus and reconnect', async () => {
    vi.useFakeTimers();
    render(() => <OperatorActivityButton enabled />);
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'View run-1' }));
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'View diagnostics' }));
    await fireEvent.click(screen.getAllByRole('button', { name: 'View diagnostics' }).at(-1)!);
    await vi.advanceTimersByTimeAsync(0);
    const failure = 'Diagnostic metadata is invalid or unavailable. It cannot be used as evidence.';
    expect(screen.getByText(failure)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(failure)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide diagnostics' })).toBeTruthy();
    expect(server.prepared).toEqual({});
  });

  it('AC4: never creates external assessment links from an untrusted repository path or opaque URL', async () => {
    server.detail.result = { repository: 'acme/updates?token=PRIVATE', results: [{ pullRequest: 42,
      outcome: 'NOT_MERGED', decision: 'DO_NOT_MERGE', comment: '<script>not executable</script>', url: 'javascript:alert(1)' }] };
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'View run-1' }));
    await screen.findByRole('button', { name: 'Back to activities' });
    expect(screen.queryByRole('link', { name: 'PR #42' })).toBeNull();
    expect(screen.queryByRole('link', { name: /posted assessment/i })).toBeNull();
    expect(screen.queryByText('PRIVATE')).toBeNull();
  });

  it('AC5/6: distinguishes each real installation and never grants invocation through management', async () => {
    server.installations = [installation({ id: 'manage-only', installationName: 'Managed only', canInvoke: false }),
      installation({ id: 'invoke-only', installationName: 'Invocation only', canManage: false })];
    await open('Installed');
    const first = await screen.findByRole('article', { name: 'Managed only' });
    const second = screen.getByRole('article', { name: 'Invocation only' });
    expect(within(first).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(true);
    expect(within(first).getByText(/invocation permission required/i)).toBeTruthy();
    expect(within(second).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(false);
    expect(within(second).queryByRole('checkbox')).toBeNull();
    expect(within(second).getByText(/management permission/i)).toBeTruthy();
  });

  it.each([
    {}, { enabled: false }, { approved: false }, { guidedMode: null, automaticRuns: null },
  ])('AC5/6: retains management navigation independently of invocation and readiness %j', async extra => {
    server.installations = [installation({ ...extra, canManage: true, canInvoke: false })];
    await open('Installed');
    const item = await screen.findByRole('article', { name: 'Updates' });
    expect(within(item).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(true);
    // Intentional navigation contract: this usable link enters the existing reauthorizing management route.
    expect(screen.getByRole('link', { name: 'Manage installations' }).getAttribute('href')).toBe('/operators');
    expect(server.prepared).toEqual({});
    expect(server.configuration.renovate.automaticRuns).toBe(false);
  });

  it.each([true, false])('AC5: invocation permission %s never grants management navigation', async canInvoke => {
    server.installations = [installation({ canManage: false, canInvoke })];
    await open('Installed');
    const item = await screen.findByRole('article', { name: 'Updates' });
    expect(screen.queryByRole('link', { name: 'Manage installations' })).toBeNull();
    expect(within(item).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(!canInvoke);
    expect(server.prepared).toEqual({});
  });

  it('AC5: offers one management destination for a mixed inventory without granting invocation to managers', async () => {
    server.installations = [installation({ id: 'invoke-only', installationName: 'Invocation only', canManage: false }),
      installation({ id: 'manage-only', installationName: 'Managed only', canInvoke: false }),
      installation({ id: 'second-manager', installationName: 'Second managed installation', canInvoke: false })];
    await open('Installed');
    const managed = await screen.findByRole('article', { name: 'Managed only' });
    const invoked = screen.getByRole('article', { name: 'Invocation only' });
    const secondManaged = screen.getByRole('article', { name: 'Second managed installation' });
    expect(screen.getByRole('link', { name: 'Manage installations' }).getAttribute('href')).toBe('/operators');
    for (const item of [managed, invoked, secondManaged]) {
      expect(within(item).queryByRole('link', { name: 'Manage installations' })).toBeNull();
    }
    expect(within(managed).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(true);
    expect(within(secondManaged).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(true);
    expect(within(invoked).getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it.each([false, true])('AC5/10: does not invent management eligibility for an empty or unavailable inventory (error=%s)', async unavailable => {
    server.installations = []; server.installError = unavailable;
    await open('Installed');
    await screen.findByText(unavailable ? 'Installations unavailable' : 'No installed operators on this page.');
    expect(screen.queryByRole('link', { name: 'Manage installations' })).toBeNull();
    expect(server.prepared).toEqual({});
  });

  it('AC5: refreshed management revocation removes navigation while preserving invocation eligibility', async () => {
    await open('Installed');
    expect((await screen.findByRole('link', { name: 'Manage installations' })).getAttribute('href')).toBe('/operators');
    server.installations = [installation({ canManage: false })];
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh installations' }));
    await screen.findByText(/management permission required to change scheduling/i);
    expect(screen.queryByRole('link', { name: 'Manage installations' })).toBeNull();
    expect(screen.getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it.each([
    { enabled: false }, { approved: false }, { guidedMode: null, automaticRuns: null },
  ])('AC6: does not offer a usable launcher for installation state %j', async extra => {
    server.installations = [installation(extra)];
    await open('Installed');
    const button = await screen.findByRole('button', { name: /run manually/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(button);
    expect(server.prepared).toEqual({});
    expect(screen.queryByRole('heading', { name: 'Start a manual run' })).toBeNull();
  });

  it('AC6/10: exposes unsupported scheduling and installation load errors honestly with retry', async () => {
    server.installError = true;
    await open('Installed');
    expect(await screen.findByText('Installations unavailable')).toBeTruthy();
    expect(screen.queryByText(/no installed operators/i)).toBeNull();
    server.installError = false; server.installations = [installation({ guidedMode: null, automaticRuns: null })];
    await fireEvent.click(screen.getByRole('button', { name: 'Retry installations' }));
    expect(await screen.findByText('Not configurable')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('AC7: explicitly saves supported scheduling with the current revision and unrelated configuration/policy preserved', async () => {
    await open('Installed');
    await fireEvent.click(await screen.findByRole('checkbox', { name: /automatic runs/i }));
    expect(screen.getByText(/saving.*disables/i)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Save scheduling' }));
    await waitFor(() => expect(server.savedRevision).toBe(7));
    expect(server.configuration).toEqual({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' });
    expect(server.savedPolicy).toEqual({ capabilities: ['fetch', 'inference'], resourceProfileId: null });
    expect(server.prepared).toEqual({});
    expect(await screen.findByText(/saved.*disabled/i)).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: /automatic runs/i }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByRole('button', { name: /run manually/i }).hasAttribute('disabled')).toBe(true);
    });
    await fireEvent.click(screen.getByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save scheduling' }));
    await waitFor(() => expect(server.savedRevision).toBe(8));
    expect(server.configuration).toEqual({ renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' });
    expect(server.installations[0].enabled).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it('AC7: lets a manager edit supported scheduling while the installation remains disabled', async () => {
    server.installations = [installation({ enabled: false, canInvoke: false })];
    await open('Installed');
    expect((await screen.findByRole('button', { name: /run manually/i })).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(screen.getByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save scheduling' }));
    expect(await screen.findByText(/saved.*disabled/i)).toBeTruthy();
    expect(server.configuration.renovate.automaticRuns).toBe(true);
    expect(server.installations[0].enabled).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it('AC7: treats a stale scheduling save as unconfirmed and does not silently enable or replay it', async () => {
    server.saveError = true;
    await open('Installed');
    await fireEvent.click(await screen.findByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save scheduling' }));
    expect(await screen.findByText(/revision.*changed|revision.*stale/i)).toBeTruthy();
    expect(server.savedRevision).toBeNull();
    expect(server.configuration.renovate.automaticRuns).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it('AC8/9: uses current configured preview, explicit effect disclosure and one-time launch without touching scheduling', async () => {
    server.preview.configuredRepository = 'acme/current';
    await review();
    expect((screen.getByRole('textbox', { name: 'Repository' }) as HTMLInputElement).value).toBe('acme/current');
    expect((screen.getByRole('textbox', { name: 'Repository' }) as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText(/may post.*merge/i)).toBeTruthy();
    expect(screen.getByText(/off.*unchanged/i)).toBeTruthy();
    expect(server.prepared).toEqual({});
    await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
    await waitFor(() => expect(server.prepared).toEqual({ 'prepared-1': {
      installationId: 'install-1', invocation: { repository: 'acme/current' }, phase: 'queued' } }));
    expect(server.configuration.renovate.automaticRuns).toBe(false);
    expect(server.savedRevision).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE_START_CAPABILITY');
    expect(screen.getByRole('tab', { name: 'Runs' }).getAttribute('aria-selected')).toBe('true');
  });

  it('AC8: preserves the supported legacy read-only PR form instead of applying a repository journey schema', async () => {
    server.installations = [installation({ guidedMode: 'legacy-pull-request', automaticRuns: null })];
    server.preview = { name: 'Renovate Dispatcher', version: 'legacy', guidedAssessment: true, guidedMode: 'legacy-pull-request' };
    await review();
    expect(screen.getByText(/read.only.*will not merge/i)).toBeTruthy();
    await fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'acme/legacy' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '17' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
    await waitFor(() => expect(server.prepared['prepared-1']).toEqual({ installationId: 'install-1',
      invocation: { repository: 'acme/legacy', pullRequest: 17 }, phase: 'queued' }));
  });

  it('AC8: a stale or denied preview removes the launcher without preparing work', async () => {
    server.previewError = true;
    await open('Installed');
    await fireEvent.click(await screen.findByRole('button', { name: /run manually/i }));
    expect(await screen.findByText(/installation.*unavailable|invocation.*unavailable/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start one run' })).toBeNull();
    expect(server.prepared).toEqual({});
  });

  it('AC9: pending launch disables duplicate submission and navigation that would lose uncertain work', async () => {
    let resolve!: () => void;
    server.startWait = new Promise<void>(done => { resolve = done; });
    await review();
    await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
    await waitFor(() => expect(server.prepared['prepared-1']?.phase).toBe('prepared'));
    expect(screen.getByRole('button', { name: /start one run|starting/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Runs' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Manage installations' })).toBeNull();
    resolve();
    await waitFor(() => expect(server.prepared).toEqual({ 'prepared-1': { installationId: 'install-1',
      invocation: { repository: 'acme/updates' }, phase: 'queued' } }));
  });

  it('AC9: an uncertain start stays blocked until its exact prepared Activity can be inspected', async () => {
    server.startError = true; server.reconcileError = true;
    await review();
    await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
    const inspect = await screen.findByRole('button', { name: 'Inspect prepared activity' });
    expect(screen.getByRole('button', { name: 'Start one run' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(inspect);
    expect(server.prepared).toEqual({ 'prepared-1': { installationId: 'install-1', invocation: { repository: 'acme/updates' }, phase: 'prepared' } });
    expect(screen.getByRole('button', { name: 'Start one run' }).hasAttribute('disabled')).toBe(true);
    server.reconcileError = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect prepared activity' }));
    expect(await screen.findByText(/prepared-1/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('PRIVATE_START_CAPABILITY');
  });

  it('AC9: a successful but unknown inspection cannot discard an uncertain start or authorize another launch', async () => {
    server.startError = true;
    await review();
    await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
    await screen.findByRole('button', { name: 'Inspect prepared activity' });
    server.prepared['prepared-1'].phase = 'unknown';
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect prepared activity' }));
    await screen.findByText(/outcome.*unknown/i);
    expect(screen.getByRole('tab', { name: 'Runs' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Start one run' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Manage installations' })).toBeNull();
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    server.prepared['prepared-1'].phase = 'queued';
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect prepared activity' }));
    await screen.findByText(/Activity prepared-1: queued/);
    expect(server.prepared).toEqual({ 'prepared-1': { installationId: 'install-1', invocation: { repository: 'acme/updates' }, phase: 'queued' } });
    expect(screen.getByRole('tab', { name: 'Runs' }).hasAttribute('disabled')).toBe(false);
  });

  it('AC9: failed preparation cannot borrow an earlier activity to authorize retry', async () => {
    server.prepareError = true;
    await review();
    await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
    expect(await screen.findByText(/preparation.*not confirmed|preparation.*unavailable/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start one run' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Inspect prepared activity' })).toBeNull();
    expect(server.prepared).toEqual({});
  });
});
