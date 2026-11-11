import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OperatorActivityButton from '../../components/OperatorActivityButton';
import { ApiError } from '../../api/fetch-helper';

// Reactive incumbent session facade: exercise session/generation invalidation without runtime I/O.
const activeSession = vi.hoisted(() => ({ set: (_value: unknown) => {}, list: (_value: unknown) => {} }));
vi.mock('../../stores/session', async () => {
  const { createSignal } = await import('solid-js');
  const [current, setCurrent] = createSignal<unknown>();
  activeSession.set = value => { setCurrent(value); };
  const [listed, setListed] = createSignal<Array<Record<string, unknown>> | undefined>();
  activeSession.list = value => { setListed(value as Array<Record<string, unknown>> | undefined); };
  return { sessionStore: { preferences: { userTimezone: 'UTC' }, getActiveSession: current, get sessions() { return listed() ?? []; }, get statusUnavailable() { return server.sessionUnavailable; } } };
});
const runningSession = { id: 'ownersession1', status: 'running', lifecycle: 'running', generation: 3 };

const server = vi.hoisted(() => ({
  page: [] as Array<Record<string, unknown>>, older: [] as Array<Record<string, unknown>>,
  installations: [] as Array<Record<string, unknown>>, olderInstallations: [] as Array<Record<string, unknown>>,
  runPages: {} as Record<string, { items: Array<Record<string, unknown>>; nextCursor: string | null }>,
  installationPages: {} as Record<string, { items: Array<Record<string, unknown>>; cursor: string | null }>,
  detail: {} as Record<string, unknown>,
  diagnosticError: new Error('Diagnostics unavailable'),
  management: {} as Record<string, unknown>, preview: {} as Record<string, unknown>,
  prepared: {} as Record<string, { installationId: string; invocation: unknown; phase: string }>,
  nextCursor: null as string | null, installCursor: null as string | null,
  previewError: false, installError: false, prepareError: false, startError: false, saveError: false,
  startWait: null as Promise<void> | null, reconcileError: false,
  prepareWait: null as Promise<void> | null, inspectWait: null as Promise<void> | null,
  configuration: { renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' },
  savedPolicy: null as unknown, savedRevision: null as number | null,
  // Wire-command journal: the intentional contract forbids implicit Enable/Activate writes.
  mutations: [] as Array<{ kind: string; command: unknown }>,
  sessionUnavailable: false,
  hosts: [] as Array<Record<string, unknown>>, hostError: false, enableError: false,
  activateWait: null as Promise<void> | null, activateError: null as Error | null,

}));
vi.mock('../../api/client', () => ({ getSessions: async () => {
  if (server.hostError) throw new Error('Unavailable');
  return server.hosts;
} }));
vi.mock('../../api/operator-activities', () => ({
  activateRenovateRuns: async (command: unknown) => {
    server.mutations.push({ kind: 'activate', command });
    if (server.activateWait) await server.activateWait;
    if (server.activateError) throw server.activateError;
    return { activatedAt: '2026-11-11T00:00:00.000Z', repositoryId: 424242 };
  },
  listOperatorActivities: async (cursor: string | null) => ({
    ...(Object.keys(server.runPages).length ? server.runPages[cursor ?? ''] : {
      items: cursor ? server.older : server.page, nextCursor: cursor ? null : server.nextCursor }),
    workingCount: 0, unreadCount: 0, latestSequence: 1 }),
  acknowledgeOperatorActivities: async () => ({ unreadCount: 0 }),
  getOperatorActivity: async () => server.detail,
  cancelOperatorActivity: async () => server.detail,
  getOperatorActivityDiagnostics: async () => { throw server.diagnosticError; },
  getOperatorActivityDiagnosticHistory: async () => { throw new Error('Diagnostics unavailable'); },
  getOperatorActivityDiagnosticRecord: async () => { throw new Error('Diagnostics unavailable'); },
  exportOperatorActivityDiagnostics: async () => { throw new Error('Diagnostics unavailable'); },
}));
vi.mock('../../api/operator-management', () => ({
  listOperatorInstallations: async (cursor: string | null) => {
    if (server.installError) throw new Error('Unavailable');
    if (Object.keys(server.installationPages).length) {
      const page = server.installationPages[cursor ?? ''];
      if (!page) throw new Error('Unavailable page');
      return page;
    }
    if (cursor === 'older-installations') return { items: server.olderInstallations, cursor: null };
    if (cursor) throw new Error('Unavailable page');
    return { items: server.installations, cursor: server.installCursor };
  },
  getInstallationActivityPreview: async () => {
    if (server.previewError) throw new Error('Unavailable');
    return server.preview;
  },
  enableInstallation: async (...command: unknown[]) => {
    server.mutations.push({ kind: 'enable', command });
    if (server.enableError) throw new ApiError('Conflict', 409, 'Conflict');
    const [id, enabled, revision] = command;
    server.installations = server.installations.map(item => item.id === id ? { ...item, enabled, revision: Number(revision) + 1 } : item);
    return server.installations.find(item => item.id === id);
  },
  getManagedOperator: async () => server.management,
  configureInstallation: async (_id: string, value: { revision: number; policy: unknown; configuration: typeof server.configuration }) => {
    server.mutations.push({ kind: 'configure', command: value });
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
    if (server.prepareWait) await server.prepareWait;
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
    if (server.inspectWait) await server.inspectWait;
    if (server.reconcileError) throw new Error('Activity unavailable');
    return { ...server.detail, activityId: id, executionStatus: server.prepared[id]?.phase ?? 'unknown' };
  },
}));
const row = (id: string, name = 'Renovate Dispatcher') => ({ activityId: id, operatorId: 'dispatcher', operatorName: name,
  context: 'acme/updates', executionStatus: 'completed', cleanupStatus: 'released', collectionStatus: 'consumed',
  attention: false, sessionId: null, source: null, updatedAt: new Date().toISOString() });
const installation = (extra: Record<string, unknown> = {}) => ({ id: 'install-1', operatorId: 'dispatcher',
  name: 'Renovate Dispatcher', installationName: 'Updates', version: 'v0.1.27', revision: 7,
  profile: 'dispatcher', canActivateAutomaticRuns: true,
  enabled: true, approved: true, canInvoke: true, canManage: true, guidedMode: 'repository',
  repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600, ...extra });
async function open(segment = 'Runs') {
  render(() => <OperatorActivityButton enabled />);
  await fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Runs' })).toBeTruthy());
  if (segment !== 'Runs') await fireEvent.click(screen.getByRole('tab', { name: segment }));
}
async function configure() {
  const button = await screen.findByRole('button', { name: /^configure(?: automatic runs)?$/i });
  if (button.getAttribute('aria-expanded') !== 'true') await fireEvent.click(button);
}
async function review() {
  await open('Installed');
  await fireEvent.click(await screen.findByRole('button', { name: /run once/i }));
  await screen.findByRole('heading', { name: 'Start a manual run' });
}
beforeEach(() => {
  server.sessionUnavailable = false; server.hosts = []; server.hostError = false; server.enableError = false;
  activeSession.list(undefined); activeSession.set(undefined); server.mutations = []; server.activateWait = null; server.activateError = null;
  server.page = [row('run-1')]; server.older = [row('older-run')]; server.installations = [installation()];
  server.olderInstallations = []; server.runPages = {}; server.installationPages = {};
  server.detail = { ...row('run-1'), sdkCleanupReleased: true, checkpoint: null,
    result: { repository: 'acme/updates', results: [{ pullRequest: 42, decision: 'DO_NOT_MERGE', outcome: 'NOT_MERGED',
      comment: 'Compatibility evidence is unavailable.\n\n' + 'Readable assessment. '.repeat(90) }] } };
  server.preview = { name: 'Renovate Dispatcher', version: 'v0.1.27', guidedAssessment: true,
    guidedMode: 'repository', requiresSourceHost: false, configuredRepository: 'acme/updates' };
  server.configuration = { renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' };
  server.management = { installations: [{ id: 'install-1', revision: 7, enabled: true,
    policy: { capabilities: ['fetch', 'inference'], resourceProfileId: null }, configuration: server.configuration }] };
  server.prepared = {}; server.nextCursor = null; server.installCursor = null;
  server.previewError = false; server.installError = false; server.prepareError = false; server.startError = false;
  server.saveError = false; server.reconcileError = false; server.startWait = null;
  server.prepareWait = null; server.inspectWait = null;
  server.savedPolicy = null; server.savedRevision = null;
  server.diagnosticError = new Error('Diagnostics unavailable');
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

// REQ-OPERATOR-099: Installed review, invocation and presentation.
// UI-boundary outcomes do not substitute for backend policy/SDK qualification.
describe('REQ-OPERATOR-086: dropdown Runs and Installed workspace', () => {
  it('AC1/8: keeps segments and nested navigation in the existing dialog without preparing work on opening', async () => {
    await review();
    expect(screen.getByRole('tab', { name: 'Installed' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to installed operators' })).toBeTruthy();
    expect(screen.getByText('Review one invocation. Automatic scheduling is a separate setting.')).toBeVisible();
    expect(server.prepared).toEqual({});
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Installed operators' })).toBeTruthy();
    expect(screen.getByText('Run once when needed. Automatic runs are optional and configured separately.')).toBeVisible();
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
    await fireEvent.click(screen.getByRole('button', { name: 'Load 5 more' }));
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a run' }), { target: { value: '' } });
    expect(await screen.findByRole('button', { name: 'View older-run' })).toBeTruthy();
  });

  it('AC2: Installed search filters only the current page and survives empty matches, pagination and manual-review back navigation', async () => {
    server.installations = [installation(),
      installation({ id: 'review-install', name: 'Pull Request Reviewer', installationName: 'Review workspace', repository: 'acme/service' }),
      installation({ id: 'monitor-install', name: 'Checks', installationName: 'Special queue', repository: 'acme/observability' })];
    server.installCursor = 'older-installations';
    server.olderInstallations = [installation({ id: 'older-install', installationName: 'Older updates' })];
    await open('Installed');
    await screen.findByRole('article', { name: 'Review workspace' });
    const panel = screen.getByRole('tabpanel', { name: 'Installed' });
    expect(within(panel).queryByRole('article', { name: 'Older updates' })).toBeNull();
    const search = within(panel).getByRole('searchbox', { name: 'Find an installed operator' });
    await fireEvent.input(search, { target: { value: '  REVIEWER  ' } });
    expect(within(panel).getByRole('article', { name: 'Review workspace' })).toBeTruthy();
    expect(within(panel).queryByRole('article', { name: 'Updates' })).toBeNull();
    expect(within(panel).queryByRole('article', { name: 'Special queue' })).toBeNull();
    await fireEvent.input(search, { target: { value: 'special queue' } });
    expect(within(panel).getByRole('article', { name: 'Special queue' })).toBeTruthy();
    expect(within(panel).queryByRole('article', { name: 'Review workspace' })).toBeNull();
    await fireEvent.input(search, { target: { value: 'observability' } });
    expect(within(panel).getByRole('article', { name: 'Special queue' })).toBeTruthy();
    expect(within(panel).getByText(/current page/i)).toBeTruthy();
    await fireEvent.input(search, { target: { value: 'older' } });
    expect(within(panel).getByText('No matching installed operators on this page.')).toBeTruthy();
    expect(within(panel).queryByRole('article')).toBeNull();
    await fireEvent.click(within(panel).getByRole('button', { name: 'Load 5 more' }));
    expect(await within(panel).findByRole('article', { name: 'Older updates' })).toBeTruthy();
    expect((within(panel).getByRole('searchbox', { name: 'Find an installed operator' }) as HTMLInputElement).value).toBe('older');
    await fireEvent.click(within(panel).getByRole('button', { name: 'Run once' }));
    await within(panel).findByRole('heading', { name: 'Start a manual run' });
    await fireEvent.click(within(panel).getByRole('button', { name: 'Back to installed operators' }));
    expect(await within(panel).findByRole('article', { name: 'Older updates' })).toBeTruthy();
    expect((within(panel).getByRole('searchbox', { name: 'Find an installed operator' }) as HTMLInputElement).value).toBe('older');
    await fireEvent.click(within(panel).getByRole('button', { name: 'Newer 5' }));
    expect(await within(panel).findByText('No matching installed operators on this page.')).toBeTruthy();
    expect(within(panel).queryByRole('article', { name: 'Older updates' })).toBeNull();
    await fireEvent.input(within(panel).getByRole('searchbox', { name: 'Find an installed operator' }), { target: { value: '' } });
    expect(within(panel).getByRole('article', { name: 'Review workspace' })).toBeTruthy();
  });

  it.each(['Runs', 'Installed'])('AC2: %s uses identical five-entry navigation through every row and back', async segment => {
    const rows = Array.from({ length: 12 }, (_, index) => segment === 'Runs' ? row(`run-${index + 1}`)
      : installation({ id: `install-${index + 1}`, installationName: `Installation ${index + 1}` }));
    for (const offset of [0, 5, 10]) {
      const key = offset ? `page-${offset}` : '';
      const next = offset === 10 ? null : `page-${offset + 5}`;
      if (segment === 'Runs') server.runPages[key] = { items: rows.slice(offset, offset + 5), nextCursor: next };
      else server.installationPages[key] = { items: rows.slice(offset, offset + 5), cursor: next };
    }
    await open(segment);
    const panel = screen.getByRole('tabpanel', { name: segment });
    const firstRow = (index: number) => segment === 'Runs'
      ? within(panel).findByRole('button', { name: `View run-${index}` })
      : within(panel).findByRole('article', { name: `Installation ${index}` });
    const assertPage = async (start: number, count: number) => {
      await firstRow(start);
      expect(within(panel).getAllByRole('article')).toHaveLength(count);
      for (let index = start; index < start + count; index += 1) await firstRow(index);
    };
    await assertPage(1, 5);
    // Intentional shared user-copy contract, paired with the actual page transitions.
    expect(within(panel).queryByRole('button', { name: 'Newer 5' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /more installations|newer installations/i })).toBeNull();
    await fireEvent.click(within(panel).getByRole('button', { name: 'Load 5 more' }));
    await assertPage(6, 5);
    await fireEvent.click(within(panel).getByRole('button', { name: 'Load 5 more' }));
    await assertPage(11, 2);
    expect(within(panel).queryByRole('button', { name: 'Load 5 more' })).toBeNull();
    await fireEvent.click(within(panel).getByRole('button', { name: 'Newer 5' }));
    await assertPage(6, 5);
    await fireEvent.click(screen.getByRole('tab', { name: segment === 'Runs' ? 'Installed' : 'Runs' }));
    await fireEvent.click(screen.getByRole('tab', { name: segment }));
    await assertPage(6, 5);
    await fireEvent.click(within(panel).getByRole('button', { name: 'Newer 5' }));
    await assertPage(1, 5);
    expect(within(panel).queryByRole('button', { name: 'Newer 5' })).toBeNull();
    expect(server.prepared).toEqual({});
  });

  it('AC2/10: retries an unavailable Installed page without losing its five-entry cursor or search', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => installation({ id: `install-${index + 1}`,
      installationName: `Installation ${index + 1}` }));
    server.installationPages = { '': { items: rows.slice(0, 5), cursor: 'page-5' },
      'page-5': { items: rows.slice(5), cursor: null } };
    await open('Installed');
    const panel = screen.getByRole('tabpanel', { name: 'Installed' });
    await within(panel).findByRole('article', { name: 'Installation 1' });
    await fireEvent.input(within(panel).getByRole('searchbox', { name: 'Find an installed operator' }),
      { target: { value: 'Installation 7' } });
    expect(within(panel).getByText('No matching installed operators on this page.')).toBeTruthy();
    server.installError = true;
    await fireEvent.click(within(panel).getByRole('button', { name: 'Load 5 more' }));
    await within(panel).findByText('Installations unavailable');
    server.installError = false;
    await fireEvent.click(within(panel).getByRole('button', { name: 'Retry installations' }));
    await within(panel).findByRole('article', { name: 'Installation 7' });
    expect(within(panel).getAllByRole('article')).toHaveLength(1);
    expect((within(panel).getByRole('searchbox', { name: 'Find an installed operator' }) as HTMLInputElement).value).toBe('Installation 7');
    await fireEvent.input(within(panel).getByRole('searchbox', { name: 'Find an installed operator' }), { target: { value: '' } });
    expect(within(panel).getAllByRole('article')).toHaveLength(5);
    await fireEvent.click(within(panel).getByRole('button', { name: 'Newer 5' }));
    await within(panel).findByRole('article', { name: 'Installation 1' });
    expect(within(panel).getAllByRole('article')).toHaveLength(5);
    expect(server.prepared).toEqual({});
  });

  it('AC2: filters the visible page by operator independently of execution state', async () => {
    server.page.push({ ...row('run-2', 'Pull Request Reviewer'), operatorId: 'reviewer' });
    await open();
    const filter = screen.getByRole('combobox', { name: 'Filter runs by operator' });
    // Intentional uppercase user-copy contract: native mobile pickers must show
    // the same labels as the closed control, without changing filter values.
    expect(within(filter).getByRole('option', { name: 'ALL OPERATORS' })).toBeTruthy();
    expect(within(filter).getByRole('option', { name: 'RENOVATE DISPATCHER' })).toBeTruthy();
    expect(within(filter).getByRole('option', { name: 'PULL REQUEST REVIEWER' })).toBeTruthy();
    await fireEvent.change(filter, { target: { value: 'reviewer' } });
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
    await vi.advanceTimersByTimeAsync(0);
    // The first explicit action must read evidence, not reveal another open button.
    expect(screen.queryByRole('button', { name: 'View diagnostics' })).toBeNull();
    const failure = 'Diagnostic metadata is invalid or unavailable. It cannot be used as evidence.';
    expect(screen.getByText(failure)).toBeTruthy();
    // A forbidden background read would replace this retained error with a
    // different public outcome. Only the next explicit open may consume it.
    server.diagnosticError = new ApiError('Forbidden', 403, 'Forbidden');
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(failure)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide diagnostics' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide diagnostics' }));
    expect(screen.queryByText(failure)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'View diagnostics' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText(failure)).toBeNull();
    expect(screen.getByText('Diagnostics are not available: access or permission could not be confirmed.')).toBeVisible();
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
    expect(within(first).getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(true);
    expect(within(first).getByText(/invocation permission required/i)).toBeTruthy();
    expect(within(second).getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(false);
    expect(within(second).queryByRole('checkbox')).toBeNull();
    expect(within(second).getByText(/management permission/i)).toBeTruthy();
  });

  it.each([
    {}, { enabled: false }, { approved: false }, { guidedMode: null, automaticRuns: null },
  ])('AC5/6: retains management navigation independently of invocation and readiness %j', async extra => {
    server.installations = [installation({ ...extra, canManage: true, canInvoke: false })];
    await open('Installed');
    const item = await screen.findByRole('article', { name: 'Updates' });
    if ('guidedMode' in extra && extra.guidedMode === null) {
      expect(within(item).queryByRole('button', { name: 'Run once' })).toBeNull();
      expect(within(item).getByText(/manual input not supported here/i)).toBeVisible();
    } else expect(within(item).getByRole('button', { name: 'Run once' })).toBeDisabled();
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
    expect(within(item).getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(!canInvoke);
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
    expect(within(managed).getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(true);
    expect(within(secondManaged).getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(true);
    expect(within(invoked).getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(false);
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
    expect(screen.getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it.each([
    { enabled: false }, { approved: false }, { guidedMode: null, automaticRuns: null },
  ])('AC6: does not offer a usable launcher for installation state %j', async extra => {
    server.installations = [installation(extra)];
    await open('Installed');
    const card = await screen.findByRole('article', { name: 'Updates' });
    if ('guidedMode' in extra && extra.guidedMode === null) {
      expect(within(card).queryByRole('button', { name: 'Run once' })).toBeNull();
      expect(within(card).getByText(/manual input not supported here/i)).toBeVisible();
    } else {
      const button = within(card).getByRole('button', { name: 'Run once' });
      expect(button).toBeDisabled();
      await fireEvent.click(button);
    }
    expect(server.mutations).toEqual([]);
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
    await configure();
    await fireEvent.click(await screen.findByRole('checkbox', { name: /automatic runs/i }));
    expect(screen.getByText(/saving.*disables/i)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await waitFor(() => expect(server.savedRevision).toBe(7));
    expect(server.configuration).toEqual({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' });
    expect(server.savedPolicy).toEqual({ capabilities: ['fetch', 'inference'], resourceProfileId: null });
    expect(server.prepared).toEqual({});
    expect(await screen.findByText(/saved.*disabled/i)).toBeTruthy();
    await configure();
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: /automatic runs/i }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByRole('button', { name: /run once/i }).hasAttribute('disabled')).toBe(true);
    });
    await configure();
    await fireEvent.click(screen.getByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await waitFor(() => expect(server.savedRevision).toBe(8));
    expect(server.configuration).toEqual({ renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, retained: 'unchanged' });
    expect(server.installations[0].enabled).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it('AC7: lets a manager edit supported scheduling while the installation remains disabled', async () => {
    server.installations = [installation({ enabled: false, canInvoke: false })];
    await open('Installed');
    expect((await screen.findByRole('button', { name: /run once/i })).hasAttribute('disabled')).toBe(true);
    await configure();
    await fireEvent.click(screen.getByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    expect(await screen.findByText(/saved.*disabled/i)).toBeTruthy();
    expect(server.configuration.renovate.automaticRuns).toBe(true);
    expect(server.installations[0].enabled).toBe(false);
    expect(server.prepared).toEqual({});
  });

  it('AC7: treats a stale scheduling save as unconfirmed and does not silently enable or replay it', async () => {
    server.saveError = true;
    await open('Installed');
    await configure();
    await fireEvent.click(await screen.findByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
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
    server.preview = { name: 'Renovate Dispatcher', version: 'legacy', guidedAssessment: true, guidedMode: 'legacy-pull-request', requiresSourceHost: false };
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
    await fireEvent.click(await screen.findByRole('button', { name: /run once/i }));
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
    await fireEvent.click(screen.getByRole('button', { name: /start one run|starting/i }));
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

  it('REQ-OPERATOR-099 AC3: current preview version survives segment switching and cancellation without preparing work', async () => {
    server.preview.version = 'current-preview-v2';
    server.preview.configuredRepository = 'acme/current-preview';
    await review();
    expect(screen.getByText('current-preview-v2 · Updates')).toBeVisible();
    expect((screen.getByRole('textbox', { name: 'Repository' }) as HTMLInputElement).value).toBe('acme/current-preview');
    await fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    await screen.findByRole('heading', { name: 'Recent runs' });
    await fireEvent.click(screen.getByRole('tab', { name: 'Installed' }));
    expect(screen.getByText('current-preview-v2 · Updates')).toBeVisible();
    expect(screen.getByText(/may post assessments and merge eligible pull requests/i)).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('article', { name: 'Updates' });
    expect(server.prepared).toEqual({});
    expect(server.configuration.renovate.automaticRuns).toBe(false);
    expect(server.savedRevision).toBeNull();
  });

  it('REQ-OPERATOR-099 AC2: a changed revision at management read preserves configuration and never submits a scheduling save', async () => {
    server.management = { ...server.management, installations: [{ id: 'install-1', revision: 8,
      policy: { capabilities: ['fetch'] }, configuration: server.configuration }] };
    const original = structuredClone(server.configuration);
    await open('Installed');
    await configure();
    await fireEvent.click(await screen.findByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await screen.findByText('Installation revision changed. Refresh before saving again.');
    expect(server.configuration).toEqual(original);
    expect(server.savedRevision).toBeNull();
    expect(server.prepared).toEqual({});
  });

  it.each(['prepare', 'start', 'inspect'] as const)(
    'REQ-OPERATOR-099 AC6: pending %s retains review and prevents another launch or dismissal', async stage => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      if (stage === 'prepare') server.prepareWait = gate;
      else if (stage === 'start') server.startWait = gate;
      else { server.startError = true; server.inspectWait = gate; }
      const width = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
      try {
        await review();
        const trigger = screen.getByRole('button', { name: 'Operator activity' });
        let rect = { top: 28, bottom: 64, left: 1140, right: 1184,
          width: 44, height: 36, x: 1140, y: 28, toJSON: () => ({}) };
        vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => rect);
        await fireEvent.click(screen.getByRole('button', { name: 'Start one run' }));
        if (stage === 'inspect') {
          await fireEvent.click(await screen.findByRole('button', { name: 'Inspect prepared activity' }));
        } else if (stage === 'start') {
          await waitFor(() => expect(server.prepared['prepared-1']?.phase).toBe('prepared'));
        }
        // Exercise the real owner's width-change path while the request is still gated.
        Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
        window.dispatchEvent(new Event('resize'));
        const panel = screen.getByRole('dialog', { name: 'Operator activity' });
        expect(panel).toBeVisible();
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        expect(within(panel).getByRole('heading', { name: 'Start a manual run' })).toBeVisible();
        expect(within(panel).getByRole('textbox', { name: 'Repository' })).toHaveValue('acme/updates');
        expect(panel.style.top).toBe('72px');
        expect(panel.style.right).toBe('96px');

        rect = { top: 52, bottom: 88, left: 1276, right: 1320,
          width: 44, height: 36, x: 1276, y: 52, toJSON: () => ({}) };
        Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true });
        window.dispatchEvent(new Event('resize'));
        expect(screen.getByRole('dialog', { name: 'Operator activity' })).toBeVisible();
        expect(panel.style.top).toBe('96px');
        expect(panel.style.right).toBe('120px');
        expect(screen.getByRole('tab', { name: 'Installed' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Runs' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Close operators' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Back to installed operators' })).toBeDisabled();
        const launch = screen.getByRole('button', { name: /start one run|starting/i });
        expect(launch).toBeDisabled();
        await fireEvent.click(launch);
        await fireEvent.keyDown(document, { key: 'Escape' });
        await fireEvent.mouseDown(document.body);
        await fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
        expect(screen.getByRole('dialog')).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Start a manual run' })).toBeVisible();
        expect(server.prepared).toEqual(stage === 'prepare' ? {} : { 'prepared-1': {
          installationId: 'install-1', invocation: { repository: 'acme/updates' }, phase: 'prepared' } });
        release();
        if (stage === 'inspect') {
          await screen.findByText('Activity prepared-1: prepared. No new run was started.');
          expect(screen.getByRole('tab', { name: 'Runs' })).not.toBeDisabled();
          expect(screen.getByRole('button', { name: 'Start one run' })).toBeDisabled();
        } else {
          await waitFor(() => expect(server.prepared).toEqual({ 'prepared-1': {
            installationId: 'install-1', invocation: { repository: 'acme/updates' }, phase: 'queued' } }));
        }
        expect(server.configuration.renovate.automaticRuns).toBe(false);
        expect(server.savedRevision).toBeNull();
      } finally {
        release();
        Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
      }
    },
  );

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

// Task94: public interaction contracts for REQ-OPERATOR-099 AC2/5 and 209 AC2–6.
// Labels below are intentional accessible-control contracts, not markup snapshots.
const activation = () => screen.getByRole('button', { name: /^Start automatic runs$/i });
const quantity = () => screen.getByRole('spinbutton', { name: /repeat interval|interval quantity/i });
const unit = () => screen.getByRole('combobox', { name: /interval unit/i });
const unverified = /activation (?:is )?(?:unverified|not verified)|activation status (?:is )?unknown/i;
const acknowledged = /activation (?:accepted|acknowledged)/i;
function configured(extra: Record<string, unknown> = {}) {
  server.installations = [installation({ automaticRuns: true, ...extra })];
  server.configuration.renovate.automaticRuns = true;
  activeSession.set({ ...runningSession });
}
async function refreshInstalled() {
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh installations' }));
  await screen.findByRole('article', { name: 'Updates' });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('Task94 installed role help and independent controls', () => {
  it.each([
    { profile: 'dispatcher', name: 'Conductor', badge: 'D', role: 'Dispatcher' },
    { profile: 'conductor', name: 'Renovate Dispatcher', badge: 'C', role: 'Conductor' },
  ])('REQ-OPERATOR-099 AC1/2: verified $profile defeats spoofed name $name and preserves real identity', async ({ profile, name, badge, role }) => {
    server.installations = [installation({ profile, name, guidedMode: profile === 'conductor' ? null : 'repository',
      automaticRuns: profile === 'conductor' ? null : false })];
    await open('Installed');
    const card = await screen.findByRole('article', { name: 'Updates' });
    expect(within(card).getByRole('heading', { name })).toBeVisible();
    expect(within(card).getByText('v0.1.27')).toBeVisible();
    expect(within(card).getByText('acme/updates')).toBeVisible();
    expect(within(card).getByText(/enabled/i)).toBeVisible();
    const help = within(card).getByRole('button', { name: new RegExp(`about ${role}`, 'i') });
    expect(help.textContent).toContain(badge);
    expect(help).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(help);
    expect(help).toHaveAttribute('aria-expanded', 'true');
    const id = help.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    const explanation = document.getElementById(id!)!;
    expect(explanation).toBeVisible();
    if (profile === 'dispatcher') {
      expect(explanation.textContent).toMatch(/repository/i);
      expect(explanation.textContent).toMatch(/comment|assessment/i);
      expect(explanation.textContent).toMatch(/merge/i);
      expect(explanation.textContent).toMatch(/policy|permission/i);
    } else {
      expect(explanation.textContent).toMatch(/pull request|PR/i);
      expect(explanation.textContent).toMatch(/review/i);
      expect(explanation.textContent).toMatch(/coordinat/i);
      expect(screen.queryByRole('button', { name: /conductor run|start review coordination/i })).toBeNull();
      expect(within(card).queryByRole('button', { name: 'Run once' })).toBeNull();
      expect(within(card).getByText(/manual input not supported here/i)).toBeVisible();
    }
    expect(server.prepared).toEqual({});
    expect(server.mutations).toEqual([]);
  });

  it('REQ-OPERATOR-099 AC2/5: help closes on Escape before the dropdown, returns focus, and closes on outside tap without work', async () => {
    await open('Installed');
    const help = await screen.findByRole('button', { name: /about dispatcher/i });
    help.focus();
    await fireEvent.click(help);
    const id = help.getAttribute('aria-controls')!;
    await fireEvent.keyDown(help, { key: 'Escape', bubbles: true });
    expect(screen.getByRole('dialog', { name: 'Operator activity' })).toBeVisible();
    expect(help).toHaveAttribute('aria-expanded', 'false');
    const dismissed = document.getElementById(id);
    if (dismissed) expect(dismissed).not.toBeVisible();
    expect(document.activeElement).toBe(help);
    await fireEvent.click(help);
    // Outside the disclosure, but inside the dropdown: do not dismiss the workspace.
    await fireEvent.click(screen.getByRole('heading', { name: 'Installed operators' }));
    expect(help).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('dialog', { name: 'Operator activity' })).toBeVisible();
    expect(server.mutations).toEqual([]);
    expect(server.prepared).toEqual({});
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('REQ-OPERATOR-099 AC2: role help stays explicit across elapsed time and focus changes, with unique per-installation association', async () => {
    server.installations.push(installation({ id: 'second', installationName: 'Second' }));
    await open('Installed');
    const first = within(await screen.findByRole('article', { name: 'Updates' })).getByRole('button', { name: /about dispatcher/i });
    const second = within(screen.getByRole('article', { name: 'Second' })).getByRole('button', { name: /about dispatcher/i });
    await fireEvent.click(first);
    const firstId = first.getAttribute('aria-controls');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('focus'));
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(firstId!)).toBeVisible();
    await fireEvent.click(second);
    expect(second.getAttribute('aria-controls')).not.toBe(firstId);
    expect(document.getElementById(second.getAttribute('aria-controls')!)).toBeVisible();
    expect(server.mutations).toEqual([]);
    expect(server.prepared).toEqual({});
  });

  it('REQ-OPERATOR-099 AC5: Configure is collapsed and independent of Run once; opening either disclosure starts no work', async () => {
    await open('Installed');
    const card = await screen.findByRole('article', { name: 'Updates' });
    const config = within(card).getByRole('button', { name: /^configure(?: automatic runs)?$/i });
    expect(config).toHaveAttribute('aria-expanded', 'false');
    expect(within(card).queryByRole('checkbox', { name: /automatic runs/i })).toBeNull();
    expect(within(card).getByText(/run once/i)).toBeVisible();
    expect(within(card).getByRole('button', { name: /run once/i })).toBeEnabled();
    await configure();
    expect(config).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(config.getAttribute('aria-controls')!)).toBeVisible();
    await fireEvent.click(config);
    expect(config).toHaveAttribute('aria-expanded', 'false');
    expect(server.mutations).toEqual([]);
    expect(server.prepared).toEqual({});
  });
});

describe('Task94 exact human-unit scheduling', () => {
  it.each([
    [3600, '1', 'hours'], [5400, '90', 'minutes'], [3661, '3661', 'seconds'],
  ] as Array<[number, string, string]>)('REQ-OPERATOR-209 AC2: %i saved seconds round-trip as %s %s without rounding or implicit Save', async (seconds, amount, units) => {
    server.installations = [installation({ automaticRuns: true, repetitionIntervalSeconds: seconds })];
    server.configuration.renovate.automaticRuns = true;
    server.configuration.renovate.repetitionIntervalSeconds = seconds;
    await open('Installed');
    await configure();
    expect(quantity()).toHaveValue(Number(amount));
    expect(unit()).toHaveValue(units);
    // Toggle only: untouched nondivisible seconds must survive the human-unit form.
    await fireEvent.click(screen.getByRole('checkbox', { name: /automatic runs/i }));
    expect(server.mutations).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await waitFor(() => expect(server.savedRevision).toBe(7));
    expect(server.configuration.renovate.repetitionIntervalSeconds).toBe(seconds);
    expect(server.installations[0].enabled).toBe(false);
    expect(server.mutations.map(value => value.kind)).toEqual(['configure']);
    expect(await screen.findByRole('link', { name: 'Manage installations' })).toHaveAttribute('href', '/operators');
  });

  it('REQ-OPERATOR-209 AC2/3: explicit quantity and unit Save preserves policy and unrelated configuration and disables', async () => {
    await open('Installed');
    await configure();
    await fireEvent.click(screen.getByRole('checkbox', { name: /automatic runs/i }));
    await fireEvent.input(quantity(), { target: { value: '2' } });
    await fireEvent.change(unit(), { target: { value: 'hours' } });
    expect(server.configuration.renovate.repetitionIntervalSeconds).toBe(3600);
    expect(server.mutations).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await screen.findByText(/saved.*disabled/i);
    expect(server.configuration).toEqual({ renovate: { repository: 'acme/updates', automaticRuns: true,
      repetitionIntervalSeconds: 7200 }, retained: 'unchanged' });
    expect(server.savedPolicy).toEqual({ capabilities: ['fetch', 'inference'], resourceProfileId: null });
    expect(server.installations[0].enabled).toBe(false);
    expect(server.mutations.map(value => value.kind)).toEqual(['configure']);
    expect(server.prepared).toEqual({});
    expect(screen.queryByText(acknowledged)).toBeNull();
  });

  it.each(['', '0', '-1', '0.1', '9007199254740992'])('REQ-OPERATOR-209 AC2: invalid seconds quantity %j explains validation and cannot Save or Activate', async value => {
    configured();
    await open('Installed');
    await configure();
    await fireEvent.change(unit(), { target: { value: 'seconds' } });
    await fireEvent.input(quantity(), { target: { value } });
    expect(screen.getByText(/positive.*(?:whole|integer)|(?:whole|integer).*second|valid.*interval/i)).toBeVisible();
    const save = screen.queryByRole('button', { name: 'Save run settings' });
    if (save) { expect(save).toBeDisabled(); await fireEvent.click(save); }
    expect(activation()).toBeDisabled();
    expect(server.mutations).toEqual([]);
  });

  it('REQ-OPERATOR-209 AC2: Save conflict retains server policy and seconds with no Enable, Activate or replay on focus', async () => {
    configured(); server.saveError = true;
    const original = structuredClone(server.configuration);
    await open('Installed');
    await configure();
    await fireEvent.input(quantity(), { target: { value: '2' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await screen.findByText(/revision.*changed|revision.*stale/i);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    expect(server.configuration).toEqual(original);
    expect(server.savedPolicy).toBeNull();
    expect(server.mutations.map(value => value.kind)).toEqual(['configure']);
    expect(screen.queryByText(acknowledged)).toBeNull();
  });
});

describe('Task94 explicit installation and session scoped activation', () => {
  it('REQ-OPERATOR-209 AC4/6: configured is unverified until explicit acknowledgement, not persistent Active', async () => {
    configured();
    await open('Installed');
    await screen.findByText(unverified);
    expect(screen.queryByText(/^active$/i)).toBeNull();
    expect(server.mutations).toEqual([]);
    const gate = deferred(); server.activateWait = gate.promise;
    await fireEvent.click(activation());
    await screen.findByText(/activating|activation pending/i);
    expect(activation()).toBeDisabled();
    await fireEvent.click(activation());
    expect(server.mutations).toEqual([{ kind: 'activate', command: {
      installationId: 'install-1', sessionId: 'ownersession1', sessionGeneration: 3,
    } }]);
    gate.release();
    const feedback = await screen.findByText(acknowledged);
    expect(feedback).toHaveTextContent(/original.*(?:expiry|expiration)|(?:expiry|expiration).*original/i);
    expect(screen.queryByText(/^active$/i)).toBeNull();
    // Closing/remounting must not fabricate a durable schedule-status claim.
    await fireEvent.click(screen.getByRole('button', { name: 'Close operators' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Installed' }));
    await screen.findByText(unverified);
    expect(screen.queryByText(acknowledged)).toBeNull();
    expect(server.mutations.map(value => value.kind)).toEqual(['activate']);
    expect(server.prepared).toEqual({});
  });

  it.each([
    { label: 'no session', session: undefined, extra: {}, reason: /running.*(?:session|workspace)/i },
    { label: 'stopped session', session: { ...runningSession, status: 'stopped', lifecycle: 'stopped' }, extra: {}, reason: /running.*(?:session|workspace)/i },
    { label: 'stopping lifecycle', session: { ...runningSession, lifecycle: 'stopping' }, extra: {}, reason: /running.*(?:session|workspace)/i },
    { label: 'unavailable session', session: runningSession, extra: {}, unavailable: true, reason: /unavailable|running.*(?:session|workspace)/i },
    { label: 'invalid session id', session: { ...runningSession, id: 'foreign/invalid' }, extra: {}, reason: /generation|running.*(?:session|workspace)|invalid/i },
    { label: 'zero generation', session: { ...runningSession, generation: 0 }, extra: {}, reason: /generation|running.*(?:session|workspace)/i },
    { label: 'no generation', session: { ...runningSession, generation: undefined }, extra: {}, reason: /generation|running.*(?:session|workspace)/i },
    { label: 'no server admin eligibility', session: runningSession, extra: { canActivateAutomaticRuns: false }, reason: /admin|eligib|permission/i },
    { label: 'no invocation permission', session: runningSession, extra: { canInvoke: false }, reason: /invocation permission/i },
    { label: 'disabled', session: runningSession, extra: { enabled: false }, reason: /disabled|enable.*management/i },
    { label: 'unapproved', session: runningSession, extra: { approved: false }, reason: /approval|approved/i },
    { label: 'not saved automatic', session: runningSession, extra: { automaticRuns: false }, reason: /save|automatic.*off|configure/i },
  ])('REQ-OPERATOR-209 AC5/6: $label explains the prerequisite and never admits activation', async ({ session, extra, reason, unavailable }) => {
    configured(extra); server.sessionUnavailable = unavailable === true; activeSession.set(session);
    await open('Installed');
    const card = await screen.findByRole('article', { name: 'Updates' });
    for (const explanation of within(card).getAllByText(reason)) expect(explanation).toBeVisible();
    const button = screen.queryByRole('button', { name: /^Start automatic runs$/i });
    if (button) { expect(button).toBeDisabled(); await fireEvent.click(button); }
    expect(server.mutations).toEqual([]);
    expect(screen.queryByText(acknowledged)).toBeNull();
  });

  it('REQ-OPERATOR-209 AC6: dirty configuration blocks Activate and Save disables with an explicit management handoff', async () => {
    configured();
    await open('Installed'); await configure();
    await fireEvent.input(quantity(), { target: { value: '2' } });
    expect(activation()).toBeDisabled();
    expect(screen.getByText(/unsaved|save.*before activat/i)).toBeVisible();
    await fireEvent.click(activation());
    expect(server.mutations).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await screen.findByText(/saved.*disabled/i);
    expect(server.installations[0].enabled).toBe(false);
    expect(await screen.findByRole('link', { name: 'Manage installations' })).toHaveAttribute('href', '/operators');
    const button = screen.queryByRole('button', { name: /^Start automatic runs$/i });
    if (button) expect(button).toBeDisabled();
    expect(server.mutations.map(value => value.kind)).toEqual(['configure']);
    expect(screen.queryByText(acknowledged)).toBeNull();
  });

  it.each([new ApiError('Denied', 403, 'Forbidden'), new Error('Response lost')])(
    'REQ-OPERATOR-209 AC4: denied or lost activation response %s remains unconfirmed and is not retried by refresh or reconnect', async error => {
      configured(); server.activateError = error;
      await open('Installed');
      await screen.findByText(unverified);
      await fireEvent.click(activation());
      await screen.findByText(/activation not confirmed|activation.*denied/i);
      expect(screen.queryByText(acknowledged)).toBeNull();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await refreshInstalled();
      expect(server.mutations.map(value => value.kind)).toEqual(['activate']);
      expect(server.prepared).toEqual({});
    },
  );

  it.each(['revision', 'installation', 'session', 'generation', 'eligibility', 'stopped', 'unmount'] as const)(
    'REQ-OPERATOR-209 AC6: late acknowledgement is ignored after %s changes', async change => {
      configured();
      const gate = deferred(); server.activateWait = gate.promise;
      await open('Installed');
      await screen.findByText(unverified);
      await fireEvent.click(activation());
      await screen.findByText(/activating|activation pending/i);
      if (change === 'revision' || change === 'installation' || change === 'eligibility') {
        server.installations = [installation({ automaticRuns: true, revision: change === 'eligibility' ? 7 : 8,
          ...(change === 'eligibility' ? { canActivateAutomaticRuns: false } : {}),
          ...(change === 'installation' ? { id: 'replacement' } : {}) })];
        await refreshInstalled();
      } else if (change === 'session') activeSession.set({ ...runningSession, id: 'ownersession2' });
      else if (change === 'generation') activeSession.set({ ...runningSession, generation: 4 });
      else if (change === 'stopped') activeSession.set({ ...runningSession, status: 'stopped', lifecycle: 'stopped' });
      else {
        cleanup();
        await open('Installed');
      }
      gate.release();
      await gate.promise;
      // Let the abandoned request's continuation run before reading the new scope.
      await Promise.resolve();
      await waitFor(() => expect(screen.queryByText(/^activating(?:…|\.\.\.)$|^activation pending$/i)).toBeNull());
      expect(screen.queryByText(acknowledged)).toBeNull();
      expect(server.mutations.map(value => value.kind)).toEqual(['activate']);
    },
  );

  it.each(['revision', 'session', 'generation', 'eligibility'] as const)(
    'REQ-OPERATOR-209 AC6: an accepted acknowledgement resets when %s changes', async change => {
      configured();
      await open('Installed'); await screen.findByText(unverified);
      await fireEvent.click(activation()); await screen.findByText(acknowledged);
      if (change === 'revision' || change === 'eligibility') {
        server.installations = [installation({ automaticRuns: true, revision: change === 'eligibility' ? 7 : 8,
          canActivateAutomaticRuns: change !== 'eligibility' })]; await refreshInstalled();
      } else activeSession.set({ ...runningSession, ...(change === 'session' ? { id: 'ownersession2' } : { generation: 4 }) });
      await screen.findByText(unverified);
      expect(screen.queryByText(acknowledged)).toBeNull();
      expect(server.mutations.map(value => value.kind)).toEqual(['activate']);
    },
  );
});

// Invocation/activation authority is independent of configuration-management authority.
describe('Task94 activation authority and abandoned failures', () => {
  it('REQ-OPERATOR-209 AC5: a supported renamed automatic package does not require a manual launcher', async () => {
    configured({ name: 'Renamed package', guidedMode: null });
    await open('Installed'); await screen.findByText(unverified);
    expect(screen.queryByRole('button', { name: 'Run once' })).toBeNull();
    expect(activation()).toBeEnabled();
    await fireEvent.click(activation()); await screen.findByText(acknowledged);
    expect(server.mutations).toEqual([{ kind: 'activate', command: {
      installationId: 'install-1', sessionId: 'ownersession1', sessionGeneration: 3,
    } }]);
    expect(server.prepared).toEqual({});
  });

  it('REQ-OPERATOR-209 AC6: acknowledgement does not verify displayed settings after a server-only revision change', async () => {
    configured(); await open('Installed'); await screen.findByText(unverified);
    // The backend can select a newer enabled revision without a local list refresh.
    server.installations = [installation({ automaticRuns: true, revision: 8 })];
    await fireEvent.click(activation());
    const feedback = await screen.findByText(acknowledged);
    expect(feedback).toHaveTextContent(/does not verify (?:the )?displayed settings/i);
    expect(screen.queryByText(/acknowledged for this installation revision/i)).toBeNull();
    expect(server.prepared).toEqual({});
  });

  it('REQ-OPERATOR-209 AC5: server-eligible invoker can explicitly Activate without gaining management controls', async () => {
    configured({ canManage: false });
    await open('Installed');
    await screen.findByText(unverified);
    expect(screen.queryByRole('link', { name: 'Manage installations' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await fireEvent.click(activation());
    await screen.findByText(acknowledged);
    expect(server.mutations).toEqual([{ kind: 'activate', command: {
      installationId: 'install-1', sessionId: 'ownersession1', sessionGeneration: 3,
    } }]);
  });

  it('REQ-OPERATOR-209 AC1/5: unsupported Conductor configuration never invents a manual or automatic action', async () => {
    configured({ profile: 'conductor', name: 'Renovate Dispatcher', guidedMode: null,
      automaticRuns: null, repetitionIntervalSeconds: null, canActivateAutomaticRuns: false });
    await open('Installed');
    expect(await screen.findByText('Not configurable')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^configure(?: automatic runs)?$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run once' })).toBeNull();
    expect(screen.getByText(/manual input not supported here/i)).toBeVisible();
    const activate = screen.queryByRole('button', { name: /^Start automatic runs$/i });
    if (activate) { expect(activate).toBeDisabled(); await fireEvent.click(activate); }
    expect(server.prepared).toEqual({});
    expect(server.mutations).toEqual([]);
  });

  it.each(['revision', 'session', 'generation', 'eligibility', 'unmount'] as const)(
    'REQ-OPERATOR-209 AC6: late failure from abandoned %s scope does not replace current feedback', async change => {
      configured();
      const gate = deferred(); server.activateWait = gate.promise;
      server.activateError = new Error('Old response lost');
      await open('Installed'); await screen.findByText(unverified);
      await fireEvent.click(activation());
      await screen.findByText(/activating|activation pending/i);
      if (change === 'revision' || change === 'eligibility') {
        server.installations = [installation({ automaticRuns: true, revision: change === 'eligibility' ? 7 : 8,
          canActivateAutomaticRuns: change !== 'eligibility' })]; await refreshInstalled();
      } else if (change === 'session') activeSession.set({ ...runningSession, id: 'ownersession2' });
      else if (change === 'generation') activeSession.set({ ...runningSession, generation: 4 });
      else { cleanup(); await open('Installed'); }
      gate.release(); await gate.promise; await Promise.resolve();
      await screen.findByText(unverified);
      expect(screen.queryByText(/activation not confirmed/i)).toBeNull();
      expect(screen.queryByText(acknowledged)).toBeNull();
      expect(server.mutations.map(value => value.kind)).toEqual(['activate']);
    },
  );
});

describe('Task94 concurrent activation scope isolation', () => {
  it('REQ-OPERATOR-209 AC6: old completion cannot clear pending or acknowledge a newer session request', async () => {
    configured();
    const old = deferred(); server.activateWait = old.promise;
    await open('Installed'); await screen.findByText(unverified);
    await fireEvent.click(activation());
    await screen.findByText(/activating|activation pending/i);
    activeSession.set({ ...runningSession, generation: 4 });
    await screen.findByText(unverified);
    const current = deferred(); server.activateWait = current.promise;
    await fireEvent.click(activation());
    await screen.findByText(/activating|activation pending/i);
    old.release(); await old.promise; await Promise.resolve();
    expect(activation()).toBeDisabled();
    expect(screen.getByText(/activating|activation pending/i)).toBeVisible();
    expect(screen.queryByText(acknowledged)).toBeNull();
    current.release();
    await screen.findByText(acknowledged);
    expect(server.mutations).toEqual([
      { kind: 'activate', command: { installationId: 'install-1', sessionId: 'ownersession1', sessionGeneration: 3 } },
      { kind: 'activate', command: { installationId: 'install-1', sessionId: 'ownersession1', sessionGeneration: 4 } },
    ]);
  });

  it('REQ-OPERATOR-209 AC2: unit conversion overflow explains invalid seconds rather than rounding and saving', async () => {
    configured();
    await open('Installed'); await configure();
    await fireEvent.input(quantity(), { target: { value: '9007199254740991' } });
    await fireEvent.change(unit(), { target: { value: 'hours' } });
    expect(screen.getByText(/positive.*(?:whole|integer)|(?:whole|integer).*second|valid.*interval|safe.*integer|too large/i)).toBeVisible();
    const save = screen.queryByRole('button', { name: 'Save run settings' });
    if (save) { expect(save).toBeDisabled(); await fireEvent.click(save); }
    expect(activation()).toBeDisabled();
    expect(server.mutations).toEqual([]);
    expect(server.configuration.renovate.repetitionIntervalSeconds).toBe(3600);
  });
});


describe('Task101 Installed unification', () => {
  it('REQ-OPERATOR-209 AC2/3: reset uses one hour and explicit enable uses the refreshed revision without starting', async () => {
    configured({ repetitionIntervalSeconds: 7200 });
    await open('Installed'); await configure();
    await fireEvent.click(screen.getByRole('button', { name: 'Reset Repeat interval to default' }));
    expect(quantity()).toHaveValue(1); expect(unit()).toHaveValue('hours');
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await screen.findByText(/saved.*disabled/i);
    await fireEvent.click(await screen.findByRole('button', { name: 'Enable installation' }));
    await screen.findByRole('button', { name: 'Disable installation' });
    expect(server.mutations.map(value => value.kind)).toEqual(['configure', 'enable']);
    expect(server.mutations[1].command).toEqual(['install-1', true, 8]);
    expect(server.configuration.renovate.repetitionIntervalSeconds).toBe(3600);
  });

  it.each([false, true])('REQ-OPERATOR-209 AC3/5: failed enable and nonmanager authority fail closed (nonmanager=%s)', async nonmanager => {
    configured({ enabled: false, canManage: !nonmanager }); server.enableError = true;
    await open('Installed'); await screen.findByRole('article', { name: 'Updates' });
    const button = screen.queryByRole('button', { name: 'Enable installation' });
    if (nonmanager) expect(button).toBeNull();
    else {
      await fireEvent.click(button!);
      await screen.findByText(/enablement.*not confirmed|revision.*changed/i);
      expect(screen.getByRole('button', { name: 'Enable installation' })).toBeDisabled();
    }
    expect(activation()).toBeDisabled();
    expect(server.mutations.filter(value => value.kind === 'activate')).toEqual([]);
  });

  it('REQ-OPERATOR-209 AC5/6: no active workspace requires explicit owned running selection and only Start submits', async () => {
    configured(); activeSession.set(undefined);
    server.hosts = [{ ...runningSession, name: 'Owned running workspace' },
      { ...runningSession, id: 'stoppedhost1', name: 'Stopped workspace', status: 'stopped', lifecycle: 'stopped' },
      { ...runningSession, id: 'unverified01', name: 'Unverified workspace', generation: undefined }];
    await open('Installed');
    const selector = await screen.findByRole('combobox', { name: 'Running workspace' });
    await within(selector).findByRole('option', { name: 'Owned running workspace' });
    expect(selector).toHaveValue(''); expect(activation()).toBeDisabled();
    expect(within(selector).queryByRole('option', { name: 'Stopped workspace' })).toBeNull();
    expect(within(selector).queryByRole('option', { name: 'Unverified workspace' })).toBeNull();
    await fireEvent.change(selector, { target: { value: runningSession.id } });
    expect(activation()).toBeEnabled(); expect(server.mutations).toEqual([]);
    await fireEvent.click(activation()); await screen.findByText(acknowledged);
    expect(server.mutations).toEqual([{ kind: 'activate', command: {
      installationId: 'install-1', sessionId: runningSession.id, sessionGeneration: 3,
    } }]);
  });

  it.each(['unavailable', 'stopped', 'generation', 'removed', 'selection', 'store'] as const)(
    'REQ-OPERATOR-209 AC6: selected workspace %s fences late acknowledgement without replay', async change => {
      configured(); activeSession.set(undefined);
      server.hosts = [{ ...runningSession, name: 'Owned running workspace' },
        { ...runningSession, id: 'ownersession2', name: 'Second workspace' }];
      const gate = deferred(); server.activateWait = gate.promise;
      await open('Installed');
      const selector = await screen.findByRole('combobox', { name: 'Running workspace' });
      await within(selector).findByRole('option', { name: 'Owned running workspace' });
      await fireEvent.change(selector, { target: { value: runningSession.id } });
      await fireEvent.click(activation()); await screen.findByText(/activating/i);
      if (change === 'selection') await fireEvent.change(selector, { target: { value: 'ownersession2' } });
      else if (change === 'store') activeSession.list([{ ...runningSession, status: 'stopped', lifecycle: 'stopped' }]);
      else {
        server.hostError = change === 'unavailable';
        server.hosts = change === 'removed' ? [] : [{ ...runningSession, name: 'Owned running workspace',
          ...(change === 'stopped' ? { status: 'stopped', lifecycle: 'stopped' } : {}),
          ...(change === 'generation' ? { generation: 4 } : {}) }];
        await fireEvent.click(screen.getByRole('button', { name: 'Refresh workspaces' }));
        await waitFor(() => expect(activation()).toBeDisabled());
      }
      gate.release(); await gate.promise; await Promise.resolve();
      expect(screen.queryByText(acknowledged)).toBeNull();
      expect(server.mutations.map(value => value.kind)).toEqual(['activate']);
    });
});


describe('Task101 Installed automatic-off parity', () => {
  it('REQ-OPERATOR-209 AC2: automatic off hides interval and default help while Configure remains initially collapsed', async () => {
    await open('Installed');
    const card = await screen.findByRole('article', { name: 'Updates' });
    expect(within(card).getByRole('button', { name: 'Configure' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(card).queryByRole('checkbox', { name: 'Automatic runs' })).toBeNull();
    await configure();
    expect(screen.getByRole('checkbox', { name: 'Automatic runs' })).not.toBeChecked();
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Interval unit' })).toBeNull();
    expect(screen.queryByText(/Default: 1 hour/)).toBeNull();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    expect(quantity()).toHaveValue(1); expect(unit()).toHaveValue('hours');
    expect(screen.getByText(/Default: 1 hour/)).toBeVisible();
    expect(server.mutations).toEqual([]);
  });

  it('REQ-OPERATOR-209 AC2/3: off and on retain valid draft seconds and only explicit Save writes manual-only settings', async () => {
    configured(); await open('Installed'); await configure();
    await fireEvent.change(unit(), { target: { value: 'seconds' } });
    await fireEvent.input(quantity(), { target: { value: '3661' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval' })).toBeNull();
    expect(screen.queryByText(/Default: 1 hour/)).toBeNull();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    expect(quantity()).toHaveValue(3661); expect(unit()).toHaveValue('seconds');
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
    expect(server.mutations).toEqual([]);
    await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
    await waitFor(() => expect(server.configuration.renovate).toEqual({
      repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3661,
    }));
    expect(server.installations[0].enabled).toBe(false);
    expect(server.mutations.map(value => value.kind)).toEqual(['configure']);
  });

  it.each([[900, 900, 15, 'minutes'], [9007199254740991, 3600, 1, 'hours']] as const)(
    'REQ-OPERATOR-209 AC2/3: invalid draft switched off recovers saved %i as %i seconds without enabling or starting', async (saved, recovered, amount, units) => {
      configured({ repetitionIntervalSeconds: saved }); server.configuration.renovate.repetitionIntervalSeconds = saved;
      await open('Installed'); await configure();
      await fireEvent.input(quantity(), { target: { value: '' } });
      expect(screen.getByRole('button', { name: 'Save run settings' })).toBeDisabled();
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
      expect(screen.queryByRole('spinbutton', { name: 'Repeat interval' })).toBeNull();
      expect(screen.queryByText(/Default: 1 hour/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Save run settings' })).toBeEnabled();
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
      expect(quantity()).toHaveValue(amount); expect(unit()).toHaveValue(units);
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Automatic runs' }));
      expect(server.mutations).toEqual([]);
      await fireEvent.click(screen.getByRole('button', { name: 'Save run settings' }));
      await waitFor(() => expect(server.configuration.renovate).toEqual({
        repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: recovered,
      }));
      expect(server.installations[0].enabled).toBe(false);
      expect(server.mutations.map(value => value.kind)).toEqual(['configure']);
    });
});
