import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
const summary = { activityId: 'activity-1', operatorId: 'operator-1', executionStatus: 'running', cleanupStatus: 'pending', collectionStatus: 'unavailable',
  attention: false, sessionId: null, source: null, updatedAt: Date.now() };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let serve: (url: URL, init?: RequestInit) => Response;
let preview: { name: string; version: string; guidedAssessment: boolean; guidedMode: 'repository' | 'legacy-pull-request' | null; configuredRepository?: string };
beforeEach(() => {
  window.history.replaceState({}, '', '/operators?view=activity');
  serve = () => json({ items: [summary] });
  preview = { name: 'Renovate Dispatcher', version: 'v0.1.2', guidedAssessment: true, guidedMode: 'legacy-pull-request' };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(
    new URL(url).pathname.endsWith('/preview') ? json(preview) : serve(new URL(url), init))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('REQ-OPERATOR-049: human-owned invocation and activity', () => {
  it('REQ-OPERATOR-061: configured Renovate run settings make the modern target read-only and ignore malicious repository and PR URL overrides until explicit start', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1&repository=attacker%2Fforeign&pullRequest=42&automaticRuns=true&repetitionIntervalSeconds=1');
    preview.guidedMode = 'repository';
    preview.configuredRepository = 'acme/configured';
    const admissions: unknown[] = [];
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') {
        admissions.push(JSON.parse(String(init.body)));
        return json({ activityId: 'activity-1', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 });
      }
      if (url.pathname.endsWith('/start')) return json({ ok: true });
      if (url.pathname.endsWith('/activity-1')) return json({ ...summary, checkpoint: null, result: null });
      return json({ items: [] });
    };
    render(() => <OperatorManagement />);
    const repository = await screen.findByRole('textbox', { name: 'Repository' });
    expect(repository).toHaveValue('acme/configured');
    expect(repository).toHaveAttribute('readonly');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByText(/discovers recent Renovate pull requests/)).toHaveTextContent(/researches.*comments.*conditionally merge/);
    expect(admissions).toEqual([]);
    // Even a synthetic DOM input event cannot turn a read-only target into an override.
    fireEvent.input(repository, { target: { value: 'attacker/dom-injection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    // Intentional preparation wire contract: no interval, automatic flag or PR reaches the child input.
    expect(admissions).toEqual([{ installationId: 'installation-1', invocation: { repository: 'acme/configured' } }]);
  });

  it.each([undefined, ''])('REQ-OPERATOR-061: configured Renovate run settings block modern start when repository is unset (%j), with no hardcoded or URL fallback', async configuredRepository => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1&repository=nikolanovoselec%2Fkomodo&pullRequest=1253');
    preview.guidedMode = 'repository';
    preview.configuredRepository = configuredRepository;
    const mutations: unknown[] = [];
    serve = (_url, init) => {
      if (init?.method === 'POST') mutations.push(JSON.parse(String(init.body)));
      return json({ items: [] });
    };
    render(() => <OperatorManagement />);
    const pane = await screen.findByRole('region', { name: 'Prepare assessment' });
    await within(pane).findByText(/repository.*(?:not configured|missing|configure|required)|(?:not configured|missing|configure|required).*repository/i);
    const back = within(pane).getByRole('link', { name: 'Back to operators' });
    expect(back).toHaveAttribute('href', expect.stringContaining('/operators'));
    const start = within(pane).getByRole('button', { name: 'Start assessment' });
    expect(start).toBeDisabled();
    fireEvent.submit(start.closest('form')!);
    expect(mutations).toEqual([]);
    expect(within(pane).queryByRole('spinbutton')).not.toBeInTheDocument();
    const repository = within(pane).queryByRole('textbox', { name: 'Repository' });
    if (repository) {
      expect(repository).toHaveValue('');
      expect(repository).toHaveAttribute('readonly');
    }
  });

  it('preserves legacy read-only disclosure and rejects nonpositive PR input', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1&repository=owner%2Frepo&pullRequest=0');
    render(() => <OperatorManagement />);
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveAttribute('maxlength', '256');
    expect(screen.getByText(/real read-only assessment/)).toHaveTextContent(/will not merge or change/);
    fireEvent.submit(screen.getByRole('button', { name: 'Start assessment' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a positive pull request number.');
  });
  it('returns from the guided form to the catalog without starting an activity', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let admissions = 0;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') admissions++;
      return json({ items: [], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('link', { name: 'Back to operators' }));
    expect(await screen.findByRole('heading', { name: 'Available operators', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Assess a Renovate pull request' })).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(admissions).toBe(0);
  });
  it('prefills a user-chosen read-only Renovate demo without starting it, and rejects invalid targets before preparation', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1&repository=nikolanovoselec%2Fkomodo&pullRequest=1253');
    let preparations = 0;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') preparations++;
      return json({ items: [] });
    };
    render(() => <OperatorManagement />);
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveValue('nikolanovoselec/komodo');
    expect(screen.getByRole('spinbutton', { name: 'Pull request number' })).toHaveValue(1253);
    expect(preparations).toBe(0);
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'https://github.com/other/repository' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/repository.*owner\/repository/i);
    expect(preparations).toBe(0);
  });
  it('does not offer a Renovate form for an unsupported installed package', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    preview = { name: 'Another Dispatcher', version: 'v2', guidedAssessment: false, guidedMode: null };
    render(() => <OperatorManagement />);
    expect(await screen.findByText(/No guided assessment is available for Another Dispatcher/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start assessment' })).not.toBeInTheDocument();
  });
  it('shows execution independently of cleanup and reconciles an explicit cancellation', async () => {
    let cancelled = false;
    serve = (url, init) => {
      if (url.pathname.endsWith('/cancel') && init?.method === 'POST') { cancelled = true; return json({ ...summary, executionStatus: 'cancel-requested' }); }
      return json({ items: [{ ...summary, executionStatus: cancelled ? 'cancel-requested' : 'running' }] });
    };
    render(() => <OperatorManagement />);
    expect(await screen.findByText(/Execution: running · Cleanup: pending/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel activity-1' }));
    expect(await screen.findByText(/Execution: cancel-requested · Cleanup: pending/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel activity-1' })).toBeDisabled();
  });
  it('binds invocation to the selected installation and never renders its single-use start capability', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let admitted: unknown;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') {
        admitted = JSON.parse(String(init.body));
        return json({ activityId: 'activity-1', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 });
      }
      if (url.pathname.endsWith('/start')) return json({ ok: true });
      if (url.pathname.endsWith('/activity-1')) return json({ ...summary, checkpoint: null, result: null });
      return json({ items: [summary] });
    };
    render(() => <OperatorManagement />);
    await screen.findByRole('button', { name: 'Start assessment' });
    expect(screen.queryByLabelText('Invocation JSON')).not.toBeInTheDocument();
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'nikolanovoselec/komodo' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '1253' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    await waitFor(() => expect(admitted).toEqual({ installationId: 'installation-1', invocation: { repository: 'nikolanovoselec/komodo', pullRequest: 1253 } }));
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    expect(screen.queryByText('s'.repeat(43))).not.toBeInTheDocument();
  });
  it('does not allow another start after an uncertain response until the prepared activity is reconciled', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let indexed = false;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') {
        return json({ activityId: 'activity-2', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 });
      }
      if (url.pathname.endsWith('/activity-2/start')) return json({ error: 'Unavailable' }, 503);
      if (url.pathname.endsWith('/activity-2')) return indexed
        ? json({ ...summary, activityId: 'activity-2', checkpoint: null, result: null })
        : json({ error: 'Not found' }, 404);
      return json({ items: [summary] });
    };
    render(() => <OperatorManagement />);
    await screen.findByRole('button', { name: 'Start assessment' });
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'nikolanovoselec/komodo' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '1253' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/state could not be confirmed/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh activity state' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity state' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'activity-2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invocation requires its own grant/i);
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    indexed = true;
    fireEvent.click(screen.getByRole('button', { name: 'activity-2' }));
    expect(await screen.findByRole('heading', { name: 'Activity detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start assessment' })).not.toBeDisabled();
  });

  it('does not reconcile failed preparation against an earlier accepted activity', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let preparationAvailable = true;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') return preparationAvailable
        ? json({ activityId: 'activity-1', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 })
        : json({ error: 'Unavailable' }, 503);
      if (url.pathname.endsWith('/activity-1/start')) return json({ ok: true });
      if (url.pathname.endsWith('/activity-1')) return json({ ...summary, checkpoint: null, result: null });
      return json({ items: [summary] });
    };
    render(() => <OperatorManagement />);
    await screen.findByRole('button', { name: 'Start assessment' });
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'nikolanovoselec/komodo' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '1253' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start assessment' })).not.toBeDisabled());
    preparationAvailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/state could not be confirmed/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'activity-1' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'activity-1' }));
    expect(await screen.findByRole('heading', { name: 'Activity detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activities' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start assessment' })).not.toBeDisabled());
  });

  it('denies independent invocation and does not expose activity details on a denied list', async () => {
    serve = () => json({ error: 'Not found' }, 404);
    render(() => <OperatorManagement />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/invocation requires its own grant/i);
    expect(screen.queryByText('activity-1')).not.toBeInTheDocument();
  });
});

// REQ-OPERATOR-084 AC1: public v2 metadata fixtures qualify presentation, not actual SDK capture.
// Every success below is gated by the real GET wire; no new client API is imported or mocked.
const diagnosticJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const diagnosticFamilies = ['artifact', 'admission', 'construction', 'submission', 'scheduling', 'delivery',
  'model', 'inference-response', 'canonical-commit', 'tool', 'effect', 'recovery', 'settlement',
  'continuation', 'fence', 'release', 'platform', 'recorder'];
const diagnosticBinding = { generation: 3, artifactDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64) };
const diagnosticHeaders = () => ({ version: 2, activityId: 'activity-1', capturedAt: 1791936000000,
  consistency: 'stable-binding', binding: { ...diagnosticBinding }, highWater: { events: 2 as number | null, operations: 1 as number | null },
  health: { status: 'available', sdkImport: 'host-persisted', gaps: [] as string[] },
  retention: { epoch: 4, firstSequence: 1 as number | null, lastSequence: 2 as number | null,
    routineLimit: 1536, failureLimit: 64, terminalLimit: 64, evictedRoutine: 0 as number | null,
    droppedFailure: 0 as number | null, droppedTerminal: 0 as number | null,
    oversized: 0 as number | null, rejected: 0 as number | null } });
const diagnosticSummary = () => ({ ...diagnosticHeaders(), capture: 'enabled',
  provenance: { hostRevision: 'c'.repeat(40) as string | null, sdkBaseRuntime: '2.2.2' as string | null,
    sdkBaseAgents: '0.20.1' as string | null, patchSetDigest: 'd'.repeat(64) as string | null },
  capabilities: diagnosticFamilies.map(boundary => ({ boundary, availability: 'supported', persistence: 'host-persisted' })),
  sdkBinding: { status: 'available', rootDigest: '1'.repeat(64), submissionDigest: '2'.repeat(64), attemptDigest: '3'.repeat(64) } as
    { status: string; rootDigest?: string; submissionDigest?: string; attemptDigest?: string },
  fence: null as null | { generation: number; timestamp: number; boundary: string; code: string; uncertain: boolean },
  diagnosis: { state: 'observed-failure', code: 'canonical-append-failed', lastConfirmedId: 'e-1' as string | null,
    failedId: 'e-2' as string | null, nextCheck: 'inspect-failure' } });
const diagnosticEvent = (sequence: number, boundary: string, outcome: string, code = 'none') => ({
  kind: 'event', id: `e-${sequence}`, sequence, generation: 3, timestamp: 1791936000000 + sequence,
  owner: boundary === 'inference-response' ? 'host' : 'sdk', boundary, outcome, code,
  evidence: 'observed', origin: 'originating',
  correlation: { logicalOrdinal: 7, hostAttemptIndex: 2, chargedOrdinal: 19,
    sdkAttemptDigest: '3'.repeat(64), submissionDigest: '2'.repeat(64), rootDigest: '1'.repeat(64),
    requestDigest: '4'.repeat(64), responseDigest: '5'.repeat(64) },
  source: { package: boundary === 'inference-response' ? 'codeflare' : '@flue/runtime', boundary,
    baseVersion: boundary === 'inference-response' ? null : '2.2.2', patchSetDigest: 'd'.repeat(64),
    status: 'verified', frames: [{ repository: boundary === 'inference-response' ? 'nikolanovoselec/codeflare' : 'withastro/flue',
      commit: 'e'.repeat(40), path: boundary === 'inference-response' ? 'src/operators/dispatcher.ts' : 'packages/runtime/src/conversation-writer.ts',
      line: 101, column: 8, kind: 'originating' }] },
});
const diagnosticError = () => ({ kind: 'TypeError', publicCode: null, messageDigest: '6'.repeat(64),
  stackDigest: '7'.repeat(64), causes: [{ kind: 'Error', messageDigest: '8'.repeat(64), stackDigest: null }],
  loss: ['cause-depth'], fingerprintScope: 'bounded' });
const diagnosticOperation = (operationDigest = '9'.repeat(64), ordinal = 7) => ({ kind: 'operation',
  id: `o-3-${operationDigest}`, generation: 3, operationDigest, ordinal, status: 'completed',
  requestDigest: '4'.repeat(64), responseDigest: '5'.repeat(64), binding: null, hostInference: null,
  availability: 'retained', association: 'legacy' });
const diagnosticHistory = (records: unknown[] = [diagnosticEvent(1, 'inference-response', 'completed'),
  diagnosticEvent(2, 'canonical-commit', 'failed', 'canonical-append-failed'), diagnosticOperation()]) => ({ ...diagnosticHeaders(),
  records, nextCursor: null as string | null, pageStatus: 'complete', retainedStatus: 'complete',
  sourceOrder: 'diagnostic-sequence-then-operation-storage-key' });
const diagnosticExport = (records: unknown[] = diagnosticHistory().records) => ({ ...diagnosticHistory(records),
  snapshotDigest: 'a'.repeat(64), partDigest: 'b'.repeat(64) });
const diagnosticDetail = () => ({ ...diagnosticHeaders(),
  record: { ...diagnosticEvent(2, 'canonical-commit', 'failed', 'canonical-append-failed'),
    error: diagnosticError(), capsuleId: 'f-2' },
  capsule: { id: 'f-2', kind: 'failure', binding: { ...diagnosticBinding }, eventId: 'e-2',
    code: 'canonical-append-failed', error: diagnosticError(), lastHostPersistedId: 'e-1',
    sdk: { rootDigest: '1'.repeat(64), submissionDigest: '2'.repeat(64), attemptDigest: '3'.repeat(64), settlement: 'unknown' },
    affectedOperations: [{ operationDigest: '9'.repeat(64), effect: 'write', status: 'unknown' }],
    affectedOperationsOmitted: 0, loss: ['error-truncated'], uncertainty: 'prior-effect-uncertain' } });
const diagnosticPath = '/api/operator-activities/activity-1/diagnostics/v2';
const diagnosticButtonName = /^(?:View diagnostics|Diagnostics)$/i;
type DiagnosticRoute = () => Response | Promise<Response>;
function ownedDiagnosticFixture() {
  // Keep browser download URLs in this fixture: Node's inherited object-URL
  // implementation cannot accept jsdom Blobs. Fetch/wire validation is unchanged.
  let downloadNumber = 0;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn((_blob: Blob) => `blob:diagnostics-${++downloadNumber}`);
    static revokeObjectURL = vi.fn();
  });
  const state = { summary: diagnosticSummary(), history: diagnosticHistory(), detail: diagnosticDetail(),
    export: diagnosticExport(), mutations: [] as Array<{ path: string; method: string }>,
    activities: [{ ...summary, executionStatus: 'failed', cleanupStatus: 'stopped' }] };
  const routes = new Map<string, DiagnosticRoute>([
    [diagnosticPath, () => diagnosticJson(state.summary)],
    [`${diagnosticPath}/history`, () => diagnosticJson(state.history)],
    [`${diagnosticPath}/records/e-1`, () => diagnosticJson({ ...diagnosticHeaders(), record: diagnosticEvent(1, 'inference-response', 'completed') })],
    [`${diagnosticPath}/records/e-2`, () => diagnosticJson(state.detail)],
    [`${diagnosticPath}/export`, () => diagnosticJson(state.export)],
  ]);
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      state.mutations.push({ path: url.pathname, method });
      return Promise.resolve(diagnosticJson({ error: 'Diagnostics never authorize execution.' }, 405));
    }
    if (url.pathname.includes('/diagnostics')) {
      // Intentional authenticated wire contract: wrong method, credentials, selectors or v1 path cannot supply evidence.
      if (method !== 'GET' || init?.credentials !== 'same-origin' || init?.redirect !== 'manual' || init?.body !== undefined)
        return Promise.resolve(diagnosticJson({ error: 'Invalid diagnostic read.' }, 403));
      return Promise.resolve(routes.get(url.pathname + url.search)?.() ?? diagnosticJson({ error: 'Invalid diagnostic selector.' }, 400));
    }
    if (url.pathname === '/api/operator-activities') return Promise.resolve(diagnosticJson({ items: state.activities }));
    const activity = state.activities.find(item => url.pathname === `/api/operator-activities/${item.activityId}`);
    if (activity) return Promise.resolve(diagnosticJson({ ...activity, checkpoint: { stage: 'retained progress' },
      result: { outcome: `Original result for ${activity.activityId}` } }));
    if (url.pathname === '/api/operator-management/options') return Promise.resolve(diagnosticJson({ users: [], groups: [],
      unresolvedGroups: [], capabilities: [], resourceProfileIds: [], ceiling: { capabilities: [], resourceProfileIds: [] } }));
    return Promise.resolve(diagnosticJson({ error: 'Not found' }, 404));
  });
  return { state, routes };
}
async function selectDiagnosticActivity(activityId = 'activity-1') {
  fireEvent.click(await screen.findByRole('button', { name: `View ${activityId}` }));
  expect(await screen.findByRole('heading', { name: 'Activity detail' })).toBeInTheDocument();
}
async function openDiagnostics() {
  // Baseline RED is the missing accessible button, not a nonexistent import or shape exception.
  fireEvent.click(await screen.findByRole('button', { name: diagnosticButtonName }));
  return within(await screen.findByRole('region', { name: /^(?:Activity )?Diagnostics$/i }));
}
function deferredDiagnosticResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

// All scenarios below map to planned REQ-OPERATOR-084 AC1 and its passive UI Constraints.
describe('REQ-OPERATOR-081: AC6 retained Dispatcher diagnostics in Activity detail', () => {
  afterEach(() => vi.useRealTimers());

  it('opens diagnostics manually for the selected Activity via authenticated GET without changing execution or its original result', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    // An eager diagnostic read receives unavailable evidence, not the manually requested cause.
    let manual = false;
    routes.set(diagnosticPath, () => manual ? diagnosticJson(state.summary) : diagnosticJson({ error: 'Manual diagnostics required.' }, 503));
    render(() => <OperatorManagement />);
    expect(screen.queryByRole('button', { name: diagnosticButtonName })).not.toBeInTheDocument();
    await selectDiagnosticActivity();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /diagnostics/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    manual = true;
    const panel = await openDiagnostics();
    expect(await panel.findByText(/canonical.*(?:append|persist|commit).*(?:fail|could not)|(?:fail|could not).*canonical/i)).toBeInTheDocument();
    expect(panel.getByText(/last confirmed.*e-1/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:(?:failed|unfulfilled).*(?:handoff|transition)|first failure).*e-2/i)).toBeInTheDocument();
    expect(panel.getByText(/summary reference does not establish the earliest or originating failure/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:inspect|view|check).*failure/i)).toBeInTheDocument();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(screen.getAllByText(/Execution: failed · Cleanup: stopped/).length).toBeGreaterThan(0);
    expect(panel.queryByRole('button', { name: /start|retry|renew|continue|collect|replay|repair/i })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('announces loading and disables duplicate diagnostic opening while keeping Activity detail readable', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    const pending = deferredDiagnosticResponse();
    routes.set(diagnosticPath, () => pending.promise);
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const button = await screen.findByRole('button', { name: diagnosticButtonName });
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent(/loading.*diagnostic/i);
    expect(button).toBeDisabled();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    pending.resolve(diagnosticJson(state.summary));
    const panel = within(await screen.findByRole('region', { name: /^(?:Activity )?Diagnostics$/i }));
    expect(await panel.findByText(/canonical.*(?:fail|could not)|(?:fail|could not).*canonical/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/loading.*diagnostic/i)).not.toBeInTheDocument());
    expect(button).not.toBeDisabled();
    expect(state.mutations).toEqual([]);
  });

  it('renders an accessible timeline with independent host and SDK attempts and does not infer receipt or settlement from a host response', async () => {
    const { state } = ownedDiagnosticFixture();
    const host = diagnosticEvent(1, 'inference-response', 'completed');
    host.correlation.sdkAttemptDigest = 'a'.repeat(64);
    const sdk = diagnosticEvent(2, 'canonical-commit', 'failed', 'canonical-append-failed');
    sdk.correlation.sdkAttemptDigest = 'b'.repeat(64);
    sdk.correlation.hostAttemptIndex = 3;
    sdk.correlation.chargedOrdinal = 23;
    state.history.records = [host, sdk, diagnosticOperation()];
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const timeline = await panel.findByRole('list', { name: /(?:diagnostic )?timeline/i });
    const rows = within(timeline).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(/(?:host|inference).*response/i);
    expect(rows[0]).toHaveTextContent(/logical.*7/i);
    expect(rows[0]).toHaveTextContent(/host.*attempt.*2/i);
    expect(rows[0]).toHaveTextContent(/charged.*19/i);
    expect(rows[0]).toHaveTextContent(/SDK.*attempt/i);
    expect(rows[0]).toHaveTextContent('a'.repeat(64));
    expect(rows[1]).toHaveTextContent(/canonical.*(?:commit|persist)/i);
    expect(rows[1]).toHaveTextContent(/host.*attempt.*3/i);
    expect(rows[1]).toHaveTextContent(/charged.*23/i);
    expect(rows[1]).toHaveTextContent('b'.repeat(64));
    expect(await panel.findByText(/(?:host response|inference).*(?:not|does not).*(?:receipt|commit|settlement)/i)).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('reads a record detail with verified source links, bounded error lineage and uncertain affected effects without offering replay', async () => {
    const { state } = ownedDiagnosticFixture();
    state.detail.record.source.frames.push({ ...state.detail.record.source.frames[0],
      path: 'packages/runtime/src/cloudflare/agent-coordinator.ts', line: 202, kind: 'catching' },
    { ...state.detail.record.source.frames[0], line: 103, kind: 'patch-boundary' });
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const event = within(await panel.findByRole('list', { name: 'Diagnostic timeline' })).getAllByRole('listitem')[1];
    fireEvent.click(within(event).getByRole('button', { name: 'View record e-2' }));
    // The requested evidence must appear beside its record, not below the full history.
    const detail = within(await within(event).findByRole('region', { name: /record.*e-2|e-2.*record/i }));
    expect(await detail.findByText(/TypeError/)).toBeInTheDocument();
    expect(detail.getByText(/cause.*(?:depth|truncat|bounded)/i)).toBeInTheDocument();
    expect(detail.getByText(/(?:prior|affected).*effect.*(?:uncertain|unknown)|(?:uncertain|unknown).*effect/i)).toBeInTheDocument();
    expect(detail.getByText('9'.repeat(64))).toBeInTheDocument();
    expect(detail.getByText(/(?:last|latest).*host.persisted.*e-1/i)).toBeInTheDocument();
    const links = detail.getAllByRole('link');
    expect(links.some(link => link.getAttribute('href') ===
      `https://github.com/withastro/flue/blob/${'e'.repeat(40)}/packages/runtime/src/conversation-writer.ts#L101`)).toBe(true);
    expect(links.some(link => link.getAttribute('href') ===
      `https://github.com/withastro/flue/blob/${'e'.repeat(40)}/packages/runtime/src/cloudflare/agent-coordinator.ts#L202`)).toBe(true);
    expect(detail.getByText(/originating/i)).toBeInTheDocument();
    expect(detail.getByText(/catching/i)).toBeInTheDocument();
    expect(detail.getByText(/patch.boundary/i)).toBeInTheDocument();
    expect(detail.getByText(/settlement.*unknown|unknown.*settlement/i)).toBeInTheDocument();
    expect(detail.queryByRole('button', { name: /replay|repair|retry|renew|continue|collect/i })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('REQ-OPERATOR-084 AC3: opens retained operation evidence inside the selected operation without replay or execution', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    const operation = diagnosticOperation();
    routes.set(`${diagnosticPath}/records/${operation.id}`, () => diagnosticJson({ ...diagnosticHeaders(), record: operation }));
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const row = within(await panel.findByRole('list', { name: 'Retained operations' })).getAllByRole('listitem')[0];
    fireEvent.click(within(row).getByRole('button', { name: `View record ${operation.id}` }));
    const detail = within(await within(row).findByRole('region', { name: `Record ${operation.id}` }));
    expect(detail.getByText(operation.operationDigest)).toBeInTheDocument();
    expect(detail.getByText(/legacy operation.*(?:not|cannot)/i)).toBeInTheDocument();
    expect(detail.queryByRole('button', { name: /replay|repair|retry|continue|collect/i })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('labels all eighteen capture capabilities and Codeflare-derived SDK provenance without claiming historical qualification', async () => {
    const { state } = ownedDiagnosticFixture();
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const coverage = within(await panel.findByRole('region', { name: /(?:capture )?(?:capabilities|coverage)/i }));
    for (const family of diagnosticFamilies) {
      const words = family.replace(/-/g, '[ -]');
      expect(coverage.getAllByText(new RegExp(words, 'i'))[0]).toBeInTheDocument();
    }
    expect(await panel.findByText(/2\.2\.2/)).toBeInTheDocument();
    expect(panel.getByText(/0\.20\.1/)).toBeInTheDocument();
    expect(panel.getByText(/Codeflare.derived|patched.*SDK/i)).toBeInTheDocument();
    expect(panel.getByText('d'.repeat(64))).toBeInTheDocument();
    expect(panel.queryByText(/historical.*(?:identified|resolved)|v24.*(?:identified|resolved)/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('loads the next history page explicitly with live loading status, preserves earlier evidence and labels legacy operation order honestly', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    state.history.records = [diagnosticEvent(1, 'inference-response', 'completed'),
      diagnosticEvent(2, 'canonical-commit', 'failed', 'canonical-append-failed')];
    state.summary.highWater.operations = 2; state.history.highWater.operations = 2;
    state.history.nextCursor = 'history-page-two';
    state.history.pageStatus = 'more';
    const pending = deferredDiagnosticResponse();
    // Distinct from the original artifact/input digests already disclosed in the summary.
    const firstOperationDigest = 'ab'.repeat(32), secondOperationDigest = 'bc'.repeat(32);
    const next = diagnosticHistory([diagnosticOperation(firstOperationDigest, 91), diagnosticOperation(secondOperationDigest, 4)]);
    next.highWater.operations = 2;
    routes.set(`${diagnosticPath}/history?cursor=history-page-two`, () => pending.promise);
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByRole('list', { name: /timeline/i })).toHaveTextContent(/canonical/i);
    expect(panel.queryByText(firstOperationDigest)).not.toBeInTheDocument();
    const more = await panel.findByRole('button', { name: /(?:load|view|show).*(?:more|next)|next.*(?:page|records)/i });
    fireEvent.click(more);
    expect(await panel.findByRole('status')).toHaveTextContent(/loading.*(?:more|next|history|records)/i);
    expect(more).toBeDisabled();
    expect(panel.getByRole('list', { name: /timeline/i })).toHaveTextContent(/canonical/i);
    pending.resolve(diagnosticJson(next));
    expect(await panel.findByText(firstOperationDigest)).toBeInTheDocument();
    expect(panel.getByText(secondOperationDigest)).toBeInTheDocument();
    const operations = within(panel.getByRole('list', { name: /(?:retained )?operations/i })).getAllByRole('listitem');
    expect(operations[0]).toHaveTextContent(/(?:logical.*ordinal|ordinal).*91/i);
    expect(operations[1]).toHaveTextContent(/(?:logical.*ordinal|ordinal).*4/i);
    expect(operations[0]).not.toHaveTextContent('3'.repeat(64));
    expect(operations[1]).not.toHaveTextContent('3'.repeat(64));
    expect(panel.getByRole('list', { name: /timeline/i })).toHaveTextContent(/canonical/i);
    expect(panel.getByText(/operation.*storage.*order|storage.*key.*order/i)).toBeInTheDocument();
    expect(panel.getAllByText(/legacy|unassociated/i)[0]).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /(?:load|view|show).*(?:more|next)|next.*(?:page|records)/i })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('exports metadata in explicit resumable parts and distinguishes export exhaustion from retention loss', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    const first = diagnosticExport([diagnosticEvent(1, 'inference-response', 'completed'),
      diagnosticEvent(2, 'canonical-commit', 'failed', 'canonical-append-failed')]);
    first.nextCursor = 'export-page-two'; first.pageStatus = 'more';
    first.retainedStatus = 'loss'; first.health.status = 'loss'; first.health.gaps = ['routine-evicted'];
    first.retention.evictedRoutine = 5;
    const last = { ...first, records: [diagnosticOperation()], nextCursor: null, pageStatus: 'complete', partDigest: 'c'.repeat(64) };
    routes.set(`${diagnosticPath}/export`, () => diagnosticJson(first));
    routes.set(`${diagnosticPath}/export?cursor=export-page-two`, () => diagnosticJson(last));
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const exportButton = await panel.findByRole('button', { name: /^(?:export|download)(?: diagnostics)?(?: metadata)?(?: part)?$/i });
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(panel.queryByText(/loading.*export/i)).not.toBeInTheDocument());
    expect(await panel.findByText(/(?:metadata|export).*part|part.*(?:metadata|export)/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:more|next).*part|part.*(?:more|next)/i)).toBeInTheDocument();
    expect(panel.queryByText(/export complete|all retained.*exported/i)).not.toBeInTheDocument();
    const nextPart = await panel.findByRole('button', { name: /(?:export|download).*next.*part|next.*export.*part/i });
    await waitFor(() => expect(nextPart).not.toBeDisabled());
    fireEvent.click(nextPart);
    expect(await panel.findByText(/Metadata export part 2 read\. Export traversal exhausted: all retained metadata parts read\./i)).toBeInTheDocument();
    expect(panel.getByText(/(?:retention|retained).*loss|evicted.*5|5.*evicted/i)).toBeInTheDocument();
    expect(panel.getByText(/does not describe complete execution history/i)).toBeInTheDocument();
    // Reject completeness claims, not the explicit disclaimer of execution-history completeness.
    expect(panel.queryByText(text => /complete execution history|no evidence loss/i.test(
      text.replace(/does not describe complete execution history/i, '')))).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /(?:export|download).*next.*part|next.*export.*part/i })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('keeps a recovered failure distinct from the successful successor and does not present it as the terminal cause', async () => {
    const { state } = ownedDiagnosticFixture();
    state.activities[0].executionStatus = 'completed';
    state.summary.diagnosis = { state: 'recovered-failure', code: 'provider-failed', lastConfirmedId: 'e-2',
      failedId: 'e-1', nextCheck: 'none' };
    const recovered = diagnosticEvent(1, 'model', 'recovered', 'provider-failed');
    const successor = diagnosticEvent(2, 'settlement', 'completed');
    successor.correlation.sdkAttemptDigest = 'a'.repeat(64);
    state.history.records = [recovered, successor, diagnosticOperation()];
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/recovered failure|failure.*recovered/i)).toBeInTheDocument();
    expect(await panel.findByRole('list', { name: /timeline/i })).toHaveTextContent(/settlement.*completed|completed.*settlement/i);
    expect(panel.queryByText(/terminal cause.*provider|activity failed.*provider/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('treats a legacy failed Activity as uncaptured evidence rather than proof that no failure occurred', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.capture = 'legacy'; state.summary.health.status = 'unavailable'; state.summary.health.sdkImport = 'legacy';
    state.summary.sdkBinding = { status: 'unavailable' };
    state.summary.highWater = { events: null, operations: null };
    state.summary.retention = { ...state.summary.retention, firstSequence: null, lastSequence: null,
      evictedRoutine: null, droppedFailure: null, droppedTerminal: null, oversized: null, rejected: null };
    state.summary.health.gaps = ['legacy-uncaptured'];
    state.summary.provenance = { hostRevision: null, sdkBaseRuntime: null, sdkBaseAgents: null, patchSetDigest: null };
    state.summary.capabilities = diagnosticFamilies.map(boundary => ({ boundary, availability: 'legacy', persistence: 'unavailable' }));
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'unclassified', lastConfirmedId: null,
      failedId: null, nextCheck: 'inspect-original-binding' };
    state.history = { ...diagnosticHistory([]), highWater: state.summary.highWater, retention: state.summary.retention,
      health: state.summary.health, pageStatus: 'unavailable', retainedStatus: 'unavailable' };
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/legacy.*(?:uncaptured|not captured|unavailable)|(?:uncaptured|not captured).*legacy/i,
      { selector: 'p' })).toBeInTheDocument();
    expect(panel.getByText(/(?:inspect|check).*original.*binding/i)).toBeInTheDocument();
    expect(panel.queryByText(/no failure (?:occurred|observed)|no evidence loss/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('shows logging OFF with the essential original-generation fence reason but no invented timeline or error capture', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.capture = 'disabled'; state.summary.health.sdkImport = 'unavailable';
    state.summary.highWater = { events: 0, operations: 1 };
    state.summary.retention = { ...state.summary.retention, firstSequence: null, lastSequence: null };
    state.summary.health.gaps = ['logging-disabled'];
    state.summary.fence = { generation: 3, timestamp: 1791936000010, boundary: 'fence', code: 'deadline-expired', uncertain: true };
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'deadline-expired', lastConfirmedId: null,
      failedId: null, nextCheck: 'inspect-original-binding' };
    state.summary.capabilities = diagnosticFamilies.map(boundary => ({ boundary, availability: 'unavailable', persistence: 'unavailable' }));
    state.history = { ...diagnosticHistory([diagnosticOperation()]), highWater: state.summary.highWater,
      retention: state.summary.retention, health: state.summary.health, retainedStatus: 'unavailable' };
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/logging.*(?:off|disabled)|capture.*disabled/i)).toBeInTheDocument();
    expect(panel.getByText(/deadline.*expir/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:original|binding).*generation.*3|generation.*3.*(?:original|binding)/i)).toBeInTheDocument();
    expect(panel.queryByText(/TypeError|canonical.*append.*failed/i)).not.toBeInTheDocument();
    expect(panel.queryByText(/no failure observed/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('exposes retained loss counters and unknown quantities instead of claiming a complete history or zero loss', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.health.status = 'loss';
    state.summary.health.gaps = ['routine-evicted', 'failure-overflow', 'terminal-overflow', 'oversized-record', 'invalid-record'];
    state.summary.retention = { ...state.summary.retention, evictedRoutine: 12, droppedFailure: 2,
      droppedTerminal: null, oversized: 1, rejected: 3 };
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'recorder-unavailable',
      lastConfirmedId: 'e-1', failedId: null, nextCheck: 'inspect-retention-gap' };
    state.history.health = state.summary.health; state.history.retention = state.summary.retention;
    state.history.retainedStatus = 'loss';
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/(?:retention|evidence).*loss|loss.*(?:retention|evidence)/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:evicted|routine).*12|12.*(?:evicted|routine)/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:failure|capsule).*2.*(?:drop|lost)|(?:drop|lost).*2.*failure/i)).toBeInTheDocument();
    expect(panel.getByText(/terminal.*(?:unknown|unavailable)|(?:unknown|unavailable).*terminal/i)).toBeInTheDocument();
    expect(panel.getByText(/oversized.*1|1.*oversized/i)).toBeInTheDocument();
    expect(panel.getByText(/rejected.*3|3.*rejected/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:inspect|check|view).*retention.*gap/i)).toBeInTheDocument();
    expect(panel.queryByText(/terminal.*(?:dropped|lost).*0|no evidence loss|complete execution history/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('discloses unavailable recorder counters and provenance rather than presenting absence as zero or success', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.capture = 'unavailable'; state.summary.health = { status: 'unavailable', sdkImport: 'unavailable', gaps: ['recorder-unavailable'] };
    state.summary.highWater = { events: null, operations: null }; state.summary.sdkBinding = { status: 'unavailable' };
    state.summary.retention = { ...state.summary.retention, firstSequence: null, lastSequence: null,
      evictedRoutine: null, droppedFailure: null, droppedTerminal: null, oversized: null, rejected: null };
    state.summary.provenance = { hostRevision: null, sdkBaseRuntime: null, sdkBaseAgents: null, patchSetDigest: null };
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'recorder-unavailable', lastConfirmedId: null,
      failedId: null, nextCheck: 'inspect-retention-gap' };
    state.history = { ...diagnosticHistory([]), highWater: state.summary.highWater, health: state.summary.health, retention: state.summary.retention,
      pageStatus: 'unavailable', retainedStatus: 'unavailable' };
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/recorder.*unavailable|unavailable.*recorder/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:loss|retention).*(?:unknown|unavailable)|(?:unknown|unavailable).*(?:loss|retention)/i)).toBeInTheDocument();
    expect(panel.getByText(/provenance.*(?:unknown|unavailable)|(?:unknown|unavailable).*provenance/i)).toBeInTheDocument();
    expect(panel.queryByText(/no evidence loss|no failure observed|evicted.*0/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('presents SDK import pending after retirement honestly and never advertises a locally captured cause as host-persisted', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.health = { status: 'loss', sdkImport: 'pending', gaps: ['sdk-import-incomplete'] };
    state.summary.highWater.events = 1; state.summary.retention.lastSequence = 1;
    state.summary.capabilities = diagnosticFamilies.map(boundary => ({ boundary, availability: 'supported',
      persistence: ['canonical-commit', 'settlement', 'release'].includes(boundary) ? 'pending' : 'host-persisted' }));
    state.summary.fence = { generation: 3, timestamp: 1791936000010, boundary: 'fence', code: 'deadline-expired', uncertain: true };
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'deadline-expired', lastConfirmedId: 'e-1',
      failedId: null, nextCheck: 'inspect-sdk-import' };
    state.history = { ...diagnosticHistory([diagnosticEvent(1, 'inference-response', 'completed'), diagnosticOperation()]),
      highWater: state.summary.highWater, retention: state.summary.retention, health: state.summary.health, retainedStatus: 'loss' };
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/SDK.*import.*(?:pending|incomplete)|(?:pending|incomplete).*SDK.*import/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:local|child).*captur.*(?:not|does not|unavailable).*host.persisted.*cause|host.persist.*(?:not|unconfirmed|unavailable).*cause/i)).toBeInTheDocument();
    expect(panel.getByText(/last confirmed.*e-1/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:inspect|check|view).*SDK.*import/i)).toBeInTheDocument();
    expect(panel.queryByText(/canonical.*append.*failed|TypeError/i)).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /retry|renew|continue|replay|collect/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('requires correlated platform evidence for platform-only termination instead of inventing a JavaScript cause', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.health = { status: 'loss', sdkImport: 'unavailable', gaps: ['platform-evidence-required'] };
    state.summary.highWater.events = 1; state.summary.retention.lastSequence = 1;
    state.summary.capabilities.find(item => item.boundary === 'platform')!.availability = 'platform-required';
    state.summary.capabilities.find(item => item.boundary === 'platform')!.persistence = 'unavailable';
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'platform-evidence-required', lastConfirmedId: 'e-1',
      failedId: null, nextCheck: 'inspect-platform-events' };
    state.history = { ...diagnosticHistory([diagnosticEvent(1, 'inference-response', 'completed'), diagnosticOperation()]),
      highWater: state.summary.highWater, retention: state.summary.retention, health: state.summary.health, retainedStatus: 'loss' };
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/platform.*evidence.*(?:required|missing)|(?:required|missing).*platform.*evidence/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:inspect|check|view).*platform.*(?:events|evidence)/i)).toBeInTheDocument();
    expect(panel.queryByText(/SyntaxError|TypeError|canonical.*append.*failed/i)).not.toBeInTheDocument();
    expect(panel.queryByText(/v24.*(?:cause|identified|resolved)/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('describes an unfulfilled SDK handoff and offers only a safe next evidence check', async () => {
    const { state } = ownedDiagnosticFixture();
    state.activities[0].executionStatus = 'unknown';
    state.summary.highWater.events = 1; state.summary.retention.lastSequence = 1;
    state.summary.diagnosis = { state: 'evidence-incomplete', code: 'none', lastConfirmedId: 'e-1',
      failedId: null, nextCheck: 'inspect-pending-handoff' };
    state.history = { ...diagnosticHistory([diagnosticEvent(1, 'inference-response', 'completed'), diagnosticOperation()]),
      highWater: state.summary.highWater, retention: state.summary.retention };
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/(?:unfulfilled|unconfirmed|pending|missing).*handoff|handoff.*(?:unfulfilled|unconfirmed|pending|missing)/i)).toBeInTheDocument();
    expect(panel.getByText(/last confirmed.*e-1/i)).toBeInTheDocument();
    expect(panel.getByText(/(?:inspect|check|view).*pending.*handoff/i)).toBeInTheDocument();
    expect(panel.queryByText(/SDK.*(?:receipt confirmed|settlement completed)|cause.*canonical.*append/i)).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /renew|continue|collect|retry|replay/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Execution: unknown/)[0]).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('scopes no-failure-observed to retained evidence when execution is unknown and a canonical commit is not settlement', async () => {
    const { state } = ownedDiagnosticFixture();
    state.activities[0].executionStatus = 'unknown';
    state.summary.diagnosis = { state: 'no-failure-observed', code: 'none', lastConfirmedId: 'e-2',
      failedId: null, nextCheck: 'none' };
    const committed = diagnosticEvent(2, 'canonical-commit', 'committed');
    Object.assign(committed.correlation, { sdkBatchSequence: 11, sdkRecordIndex: 4 });
    state.history.records = [diagnosticEvent(1, 'inference-response', 'completed'), committed, diagnosticOperation()];
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByText(/no failure observed.*(?:retained|captured).*evidence|(?:retained|captured).*evidence.*no failure observed/i)).toBeInTheDocument();
    const timeline = await panel.findByRole('list', { name: /timeline/i });
    const commit = within(timeline).getAllByRole('listitem')[1];
    expect(commit).toHaveTextContent(/batch.*11/i);
    expect(commit).toHaveTextContent(/record.*(?:index.*)?4/i);
    expect(panel.queryByText(/SDK settlement completed|execution succeeded|no failure occurred/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Execution: unknown/)[0]).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('announces record-detail loading without replacing the retained timeline or Activity result', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    const pending = deferredDiagnosticResponse();
    routes.set(`${diagnosticPath}/records/e-2`, () => pending.promise);
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const event = within(await panel.findByRole('list', { name: 'Diagnostic timeline' })).getAllByRole('listitem')[1];
    const button = within(event).getByRole('button', { name: 'View record e-2' });
    fireEvent.click(button);
    expect(await within(event).findByRole('status')).toHaveTextContent(/loading.*(?:record|detail)/i);
    expect(button).toBeDisabled();
    expect(panel.getByRole('list', { name: /timeline/i })).toHaveTextContent(/canonical/i);
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    pending.resolve(diagnosticJson(state.detail));
    const detail = within(await panel.findByRole('region', { name: /record.*e-2|e-2.*record/i }));
    expect(await detail.findByText(/TypeError/)).toBeInTheDocument();
    expect(panel.queryByText(/loading.*(?:record|detail)/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it.each(['foreign-activity', 'unknown-private-field', 'unsupported-version']) (
    'rejects %s diagnostic metadata without exposing it or replacing the original Activity result', async fault => {
      const { state, routes } = ownedDiagnosticFixture();
      const invalid = diagnosticSummary();
      if (fault === 'foreign-activity') invalid.activityId = 'foreign-activity';
      if (fault === 'unknown-private-field') Object.assign(invalid, { privateBody: 'PRIVATE_DIAGNOSTIC_BODY' });
      if (fault === 'unsupported-version') invalid.version = 1;
      routes.set(diagnosticPath, () => diagnosticJson(invalid));
      render(() => <OperatorManagement />);
      await selectDiagnosticActivity();
      fireEvent.click(await screen.findByRole('button', { name: diagnosticButtonName }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/diagnostic.*(?:invalid|unavailable|could not|cannot)|(?:invalid|unavailable).*diagnostic/i);
      expect(screen.queryByText(/PRIVATE_DIAGNOSTIC_BODY|foreign-activity/)).not.toBeInTheDocument();
      expect(screen.queryByRole('list', { name: /timeline/i })).not.toBeInTheDocument();
      expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
      expect(state.mutations).toEqual([]);
    });

  it('labels an unverified source explicitly and does not fabricate a public source link', async () => {
    const { state } = ownedDiagnosticFixture();
    state.summary.health.gaps = ['source-unverified'];
    state.detail.health = state.summary.health;
    state.detail.record.source.status = 'unavailable'; state.detail.record.source.frames = [];
    state.detail.record.origin = 'catching';
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    fireEvent.click(await panel.findByRole('button', { name: /(?:view|inspect|open).*e-2|e-2.*(?:detail|record)/i }));
    const detail = within(await panel.findByRole('region', { name: /record.*e-2|e-2.*record/i }));
    expect(await detail.findByText(/source.*(?:unverified|unavailable)|(?:unverified|unavailable).*source/i)).toBeInTheDocument();
    expect(detail.getByText(/catching/i)).toBeInTheDocument();
    expect(detail.queryAllByRole('link').filter(link => link.getAttribute('href')?.includes('github.com/'))).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it.each([403, 404, 503])('keeps Activity detail and original result usable when diagnostics GET returns %s', async status => {
    const { state, routes } = ownedDiagnosticFixture();
    routes.set(diagnosticPath, () => diagnosticJson({ error: status === 503 ? 'Diagnostics unavailable.' : 'Not found.' }, status));
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    fireEvent.click(await screen.findByRole('button', { name: diagnosticButtonName }));
    expect(await screen.findByRole('alert')).toHaveTextContent(status === 503
      ? /diagnostic.*unavailable|unavailable.*diagnostic/i : /access|permission|not available|not found/i);
    expect(screen.getByRole('heading', { name: 'Activity detail' })).toBeInTheDocument();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh activities' })).not.toBeDisabled();
    expect(screen.queryByText(/no failure observed/i)).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('discards the diagnostic snapshot after a changed-binding history response while preserving the selected Activity result', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    state.history.nextCursor = 'stale-history'; state.history.pageStatus = 'more';
    routes.set(`${diagnosticPath}/history?cursor=stale-history`, () => diagnosticJson({ error: 'Activity binding changed.' }, 409));
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    expect(await panel.findByRole('list', { name: /timeline/i })).toHaveTextContent(/canonical/i);
    fireEvent.click(await panel.findByRole('button', { name: /(?:load|view|show).*(?:more|next)|next.*(?:page|records)/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/binding.*chang|chang.*binding|snapshot.*(?:discard|stale)/i);
    expect(panel.queryByRole('list', { name: /timeline/i })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /(?:export|download).*metadata|^export diagnostics$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('invalidates a resumed export on retention-epoch expiry without claiming that an earlier part is a whole export', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    state.export.records = [diagnosticEvent(1, 'inference-response', 'completed')];
    state.export.nextCursor = 'expired-export'; state.export.pageStatus = 'more';
    routes.set(`${diagnosticPath}/export?cursor=expired-export`, () => diagnosticJson({ error: 'Retention epoch expired.' }, 409));
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    const panel = await openDiagnostics();
    const exportButton = await panel.findByRole('button', { name: /^(?:export|download)(?: diagnostics)?(?: metadata)?(?: part)?$/i });
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    fireEvent.click(exportButton);
    const nextPart = await panel.findByRole('button', { name: /(?:export|download).*next.*part|next.*export.*part/i });
    await waitFor(() => expect(nextPart).not.toBeDisabled());
    fireEvent.click(nextPart);
    expect(await screen.findByRole('alert')).toHaveTextContent(/retention.*(?:changed|expired)|snapshot.*(?:expired|invalid|discard)/i);
    expect(panel.queryByText(/export complete|all retained.*exported/i)).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /(?:export|download).*next.*part|next.*export.*part/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Original result for activity-1/)).toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('does not poll or automatically refresh diagnostic evidence after a manual snapshot', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    // Install the clock before opening, so any diagnostic poll registered at opening is observable.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const panel = await openDiagnostics();
    expect(await panel.findByText(/canonical.*(?:fail|could not)|(?:fail|could not).*canonical/i)).toBeInTheDocument();
    await panel.findByRole('list', { name: /timeline/i });
    // A later server snapshot has a different user-visible diagnosis. No explicit refresh is made.
    const later = diagnosticSummary();
    later.diagnosis = { state: 'evidence-incomplete', code: 'platform-evidence-required', lastConfirmedId: null,
      failedId: null, nextCheck: 'inspect-platform-events' };
    later.health.gaps = ['platform-evidence-required'];
    routes.set(diagnosticPath, () => diagnosticJson(later));
    routes.set(`${diagnosticPath}/history`, () => diagnosticJson({ ...diagnosticHistory([]), retainedStatus: 'unavailable' }));
    await vi.advanceTimersByTimeAsync(120000);
    expect(panel.getByRole('list', { name: /timeline/i })).toHaveTextContent(/canonical/i);
    expect(panel.queryByText(/platform.*evidence.*(?:required|missing)/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it('does not attach a late diagnostics response from the previously selected Activity to the current detail', async () => {
    const { state, routes } = ownedDiagnosticFixture();
    state.activities.push({ ...state.activities[0], activityId: 'activity-2' });
    const pending = deferredDiagnosticResponse();
    routes.set(diagnosticPath, () => pending.promise);
    render(() => <OperatorManagement />);
    await selectDiagnosticActivity();
    fireEvent.click(await screen.findByRole('button', { name: diagnosticButtonName }));
    expect(await screen.findByRole('status')).toHaveTextContent(/loading.*diagnostic/i);
    await selectDiagnosticActivity('activity-2');
    pending.resolve(diagnosticJson(state.summary));
    // Let the released fetch/body promises settle before checking that stale evidence stayed discarded.
    await new Promise<void>(done => setTimeout(done, 0));
    await waitFor(() => expect(screen.getByText(/Original result for activity-2/)).toBeInTheDocument());
    expect(screen.queryByText(/canonical.*append.*failed|(?:failed|failure).*canonical/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^(?:Activity )?Diagnostics$/i })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });
});
