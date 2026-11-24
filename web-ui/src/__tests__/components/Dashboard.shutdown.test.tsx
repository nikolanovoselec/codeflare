import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import Dashboard from '../../components/Dashboard';
import SessionDropdown from '../../components/SessionDropdown';
import { SESSION_POLL_TRANSITION_MS } from '../../lib/constants';
import { createMigrationRetry } from '../../components/MigrationRetryNotice';
import { sessionStore } from '../../stores/session';
import { terminalStore } from '../../stores/terminal';
import type { Terminal } from '@xterm/xterm';

// Keep the Dashboard, SessionStatCard, session store, and HTTP client real.
// jsdom can check accessible content and commands, not card dimensions or tap targets.
let scenario = 0;
let id: string;
let sessionPath: string;
const name = 'Shutdown workspace';
const stamp = '2026-11-23T10:00:00.000Z';
type Phase = 'queued' | 'saving' | 'consolidating' | 'finishing' | 'memory-not-merged';
type Lifecycle = 'running' | 'stopping' | 'stopped';
type Projection = { status: Lifecycle; lifecycle: Lifecycle; generation: number; revision: number;
  shutdownPhase?: Phase; pendingDelete?: boolean; snapshotUnavailable?: boolean; metrics?: { cpu: string; mem: string; hdd: string } };
let catalog: Projection | undefined;
let polled: Projection | undefined;
let operations: string[];
let retryResponse: Promise<Response> | undefined;

function project(status: Lifecycle, revision: number, shutdownPhase?: Phase, pendingDelete?: boolean, generation = 7) {
  catalog = polled = { status, lifecycle: status, generation, revision, shutdownPhase, pendingDelete };
}

function renderDashboard() {
  const openTerminal = vi.fn();
  const start = vi.fn();
  const view = render(() => <Dashboard
    sessions={sessionStore.sessions}
    migrationRetry={createMigrationRetry()}
    viewState="dashboard"
    onCreateSession={() => {}}
    onStartSession={start}
    onOpenVscodeSession={() => {}}
    onOpenSessionById={openTerminal}
    onStopSession={sessionStore.stopSession}
    onDeleteSession={sessionStore.deleteSession}
  />);
  return { ...view, openTerminal, start };
}

const card = () => within(screen.getByTestId(`session-stat-card-${id}`));
const retry = () => card().getByRole('button', { name: 'Retry memory consolidation' });
const resume = () => card().getByRole('button', { name: 'Resume session' });
const accepted = (shutdownPhase: Phase, pendingDelete = false) =>
  Response.json({ id, success: true, shutdownPhase, pendingDelete }, { status: 202 });

beforeEach(async () => {
  id = `shutdownsession${++scenario}`;
  sessionPath = `/api/sessions/${id}`;
  catalog = polled = undefined;
  operations = [];
  retryResponse = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = url.pathname;
    if (path === '/api/sessions' && method === 'GET') {
      return Response.json({ sessions: catalog ? [{ id, name, createdAt: stamp, lastAccessedAt: stamp,
        agentType: 'pi', workspace: 'terminal', terminalMode: 'classic', ...catalog }] : [] });
    }
    if (path === '/api/sessions/batch-status') return Response.json({ statuses: polled ? { [id]: polled } : {} });
    if (path === '/api/sessions/ancillary-status') return Response.json({ maxSessions: 3 });
    if (path === '/api/user/ensure-r2-token' || path === '/api/user/r2-status') return Response.json({ ready: false });
    if (path === '/api/preferences') return Response.json({ userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (path === '/api/github/status') return Response.json({ enabled: false, connected: false });
    if (path === '/api/storage/stats') return Response.json({ totalFiles: 0, totalFolders: 0, totalSizeBytes: 0 });
    operations.push(`${method} ${path}`);
    if (path === `${sessionPath}/retry-memory-consolidation` && method === 'POST') {
      return retryResponse ?? accepted('queued', polled?.pendingDelete);
    }
    if (path === `${sessionPath}/kill` && method === 'POST') return Response.json({ id, success: true, stopped: true });
    if (path === `${sessionPath}/stop` && method === 'POST') return accepted('queued');
    if (path === sessionPath && method === 'DELETE') return accepted('queued', true);
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  });
  await sessionStore.loadSessions();
});

afterEach(() => {
  cleanup();
  terminalStore.disposeSession(id);
  sessionStore.stopSessionListPolling();
  sessionStore.stopR2Polling();
  sessionStore.stopAllPolling();
  sessionStore.setActiveSession(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['Stop', 'Delete'] as const)('REQ-SESSION-043: accepted %s advances both card surfaces without reload or manual refresh', async action => {
  project('running', 10);
  await sessionStore.loadSessions();
  vi.useFakeTimers();
  renderDashboard();
  const selectSession = vi.fn();
  render(() => <SessionDropdown isOpen sessions={sessionStore.sessions} activeSessionId={id}
    onSelectSession={selectSession} onStopSession={sessionStore.stopSession} onDeleteSession={sessionStore.deleteSession}
    onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);
  sessionStore.startSessionListPolling();
  const cards = () => screen.getAllByTestId(`session-stat-card-${id}`).map(node => within(node));
  const dropdown = within(screen.getByTestId('session-dropdown'));
  fireEvent.click(dropdown.getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('button', { name: action }));
  if (action === 'Delete') fireEvent.click(screen.getByRole('button', { name: 'Are you sure?' }));
  polled = { status: 'running', lifecycle: 'running', generation: 7, revision: 11, shutdownPhase: 'queued',
    pendingDelete: action === 'Delete', metrics: { cpu: '2%', mem: '1.0G', hdd: '3.0G' } };
  await vi.advanceTimersByTimeAsync(0);
  expect(cards()).toHaveLength(2);
  for (const view of cards()) {
    expect(view.getByRole('status')).toHaveTextContent('Memory consolidation pending...');
    expect(view.getByText('2%')).toBeVisible();
    expect(view.queryByRole('button', { name: /activate session/i })).not.toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Session actions' })).toBeEnabled();
  }
  fireEvent.click(dropdown.getByTestId(`session-card-${id}`));
  expect(selectSession).not.toHaveBeenCalled();

  polled = { ...polled, status: 'stopping', revision: 12, shutdownPhase: 'consolidating',
    metrics: { cpu: '7%', mem: '1.2G', hdd: '3.1G' } };
  await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
  for (const view of cards()) {
    expect(view.getByRole('status')).toHaveTextContent('Consolidating memory...');
    for (const metric of ['7%', '1.2G', '3.1G']) expect(view.getByText(metric)).toBeVisible();
    expect(view.queryByRole('button', { name: /activate session|resume session/i })).not.toBeInTheDocument();
  }
  if (action === 'Stop') {
    polled = { status: 'stopped', lifecycle: 'stopped', generation: 7, revision: 13 };
    await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
    for (const view of cards()) expect(view.getByRole('status', { name: 'STOPPED' })).toBeVisible();
  } else {
    catalog = polled = undefined;
    await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS * 3);
    expect(screen.queryAllByTestId(`session-stat-card-${id}`)).toHaveLength(0);
  }
});

it('REQ-SESSION-043: reports eviction after queued Retry and leaves Resume available', async () => {
  project('stopped', 10, 'memory-not-merged', true);
  await sessionStore.loadSessions();
  renderDashboard();
  fireEvent.click(retry());
  await waitFor(() => expect(operations).toContain(`POST ${sessionPath}/retry-memory-consolidation`));
  polled = { status: 'stopped', lifecycle: 'stopped', revision: 12, generation: 7,
    shutdownPhase: 'memory-not-merged', pendingDelete: true, snapshotUnavailable: true };
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Saved memory unavailable. Not deleted.')).toBeVisible();
  expect(retry()).toBeDisabled();
  expect(resume()).toBeEnabled();
});

it('REQ-SESSION-043: renders durable shutdown phases on the card without inventing progress or exit', async () => {
  project('running', 10, 'queued');
  await sessionStore.loadSessions();
  renderDashboard();
  expect(card().getByText('Memory consolidation pending...')).toBeVisible();
  expect(card().queryByRole('status', { name: /^stopped$/i })).not.toBeInTheDocument();

  project('stopping', 11, 'saving');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/saving/i)).toBeVisible();

  project('stopping', 12, 'consolidating');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Consolidating memory...')).toBeVisible();
  expect(card().queryByRole('progressbar')).not.toBeInTheDocument();

  project('stopping', 13, 'finishing');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/finishing/i)).toBeVisible();
  expect(card().queryByRole('status', { name: /^stopped$/i })).not.toBeInTheDocument();
});

it('REQ-SESSION-043: keeps separate Retry and Resume actions after reload and repeated merge failures without opening a terminal for Retry', async () => {
  project('stopped', 20, 'memory-not-merged');
  await sessionStore.loadSessions();
  let dashboard = renderDashboard();
  for (const revision of [21, 24]) {
    expect(card().getByText('Stopped · memory not merged')).toBeVisible();
    expect(card().getByText(/files (?:were |are )?saved/i)).toBeVisible();
    expect(resume()).toBeEnabled();
    let accept!: (response: Response) => void;
    retryResponse = new Promise<Response>(resolve => { accept = resolve; });
    const previous = operations.length;
    try {
      fireEvent.click(retry());
      fireEvent.click(retry());
      const busyResume = card().queryByRole('button', { name: 'Resume session' });
      if (busyResume) fireEvent.click(busyResume);
      await waitFor(() => expect(operations.slice(previous)).toEqual([`POST ${sessionPath}/retry-memory-consolidation`]));
      expect(dashboard.openTerminal).not.toHaveBeenCalled();
      expect(dashboard.start).not.toHaveBeenCalled();
    } finally {
      accept(accepted('queued'));
      retryResponse = undefined;
    }

    project('stopping', revision, 'queued');
    await sessionStore.refreshSessionStatuses();
    expect(card().getByText('Memory consolidation pending...')).toBeVisible();
    expect(card().queryByRole('button', { name: 'Resume session' })).not.toBeInTheDocument();
    project('stopping', revision + 1, 'consolidating');
    await sessionStore.refreshSessionStatuses();
    expect(card().getByText('Consolidating memory...')).toBeVisible();
    project('stopped', revision + 2, 'memory-not-merged');
    dashboard.unmount();
    await sessionStore.loadSessions();
    dashboard = renderDashboard();
  }
  expect(operations).toEqual(Array(2).fill(`POST ${sessionPath}/retry-memory-consolidation`));
  expect(retry()).toBeEnabled();
  fireEvent.click(resume());
  expect(dashboard.openTerminal).toHaveBeenCalledWith(id);
});

it.each([['queued', 'running'], ['queued', 'stopped'], ['consolidating', 'stopping']] as const)('REQ-SESSION-043: keeps Kill independently usable on the %s card while %s', async (phase, status) => {
  project(status, 10, phase);
  await sessionStore.loadSessions();
  const dashboard = renderDashboard();
  expect(card().getByText(phase === 'queued' ? 'Memory consolidation pending...' : 'Consolidating memory...')).toBeVisible();
  fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
  await waitFor(() => expect(operations).toEqual([`POST ${sessionPath}/kill`]));
  expect(dashboard.openTerminal).not.toHaveBeenCalled();
  project('stopped', 11);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'STOPPED' })).toBeVisible();
  expect(card().queryByText(/memory consolidation pending|consolidating memory/i)).not.toBeInTheDocument();
});

it('REQ-SESSION-043: an accepted Delete retains the card through merge failure and finishing until the server removes it', async () => {
  project('running', 10);
  await sessionStore.loadSessions();
  renderDashboard();
  fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Are you sure?' }));
  await waitFor(() => expect(operations).toEqual([`DELETE ${sessionPath}`]));
  project('running', 11, 'queued', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Memory consolidation pending...')).toBeVisible();
  project('stopped', 12, 'memory-not-merged', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Stopped · memory not merged')).toBeVisible();
  expect(card().getByText(/deletion (?:did not complete|is pending)|not deleted/i)).toBeVisible();
  fireEvent.click(retry());
  await waitFor(() => expect(operations).toEqual([`DELETE ${sessionPath}`, `POST ${sessionPath}/retry-memory-consolidation`]));
  project('stopping', 13, 'finishing', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/finishing/i)).toBeVisible();
  sessionStore.setActiveSession(id);
  catalog = polled = undefined;
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/finishing/i)).toBeVisible();
  await sessionStore.refreshSessionStatuses();
  await sessionStore.refreshSessionStatuses();
  expect(screen.queryByText(name)).not.toBeInTheDocument();
  expect(sessionStore.activeSessionId).toBeNull();
});

it('REQ-SESSION-043: a settled Stop clears recovery controls and rejects older merge-failure evidence', async () => {
  project('stopped', 10, 'memory-not-merged');
  await sessionStore.loadSessions();
  renderDashboard();
  fireEvent.click(retry());
  await waitFor(() => expect(operations).toEqual([`POST ${sessionPath}/retry-memory-consolidation`]));
  project('stopping', 11, 'finishing');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/finishing/i)).toBeVisible();
  project('stopped', 12);
  await sessionStore.refreshSessionStatuses();
  const stale: Projection = { status: 'stopped', lifecycle: 'stopped', generation: 7, revision: 10, shutdownPhase: 'memory-not-merged' };
  polled = stale;
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'STOPPED' })).toBeVisible();
  expect(card().queryByRole('button', { name: 'Retry memory consolidation' })).not.toBeInTheDocument();
});

it('REQ-SESSION-043: a stale status from the prior generation does not overwrite a resumed session', async () => {
  project('stopped', 10, 'memory-not-merged');
  await sessionStore.loadSessions();
  const dashboard = renderDashboard();
  fireEvent.click(resume());
  expect(dashboard.openTerminal).toHaveBeenCalledWith(id);
  project('running', 11, undefined, undefined, 8);
  await sessionStore.refreshSessionStatuses();
  polled = { status: 'stopped', lifecycle: 'stopped', generation: 7, revision: 99, shutdownPhase: 'memory-not-merged' };
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'IDLE' })).toBeVisible();
  expect(card().queryByRole('button', { name: 'Retry memory consolidation' })).not.toBeInTheDocument();
  expect(operations).toEqual([]);
});


it.each(['poll', 'catalog'])('REQ-SESSION-043: settled stop releases terminal state through %s after confirmed exit', async read => {
  const refresh = read === 'poll' ? sessionStore.refreshSessionStatuses : sessionStore.loadSessions;
  project('stopping', 10, 'finishing');
  await sessionStore.loadSessions();
  const terminal = { dispose() {} } as Terminal;
  terminalStore.setTerminal(id, '1', terminal);
  project('stopped', 11, 'finishing');
  await refresh();
  expect(terminalStore.getTerminal(id, '1')).toBe(terminal);
  project('stopped', 12);
  await refresh();
  expect(terminalStore.getTerminal(id, '1')).toBeUndefined();
});

it('REQ-SESSION-043: late retry failure from the prior generation does not overwrite a resumed session', async () => {
  project('stopped', 10, 'memory-not-merged');
  await sessionStore.loadSessions();
  let respond!: (response: Response) => void;
  retryResponse = new Promise<Response>(resolve => { respond = resolve; });
  const priorError = sessionStore.error;
  const attempt = sessionStore.retryMemoryConsolidation(id);
  await waitFor(() => expect(operations).toEqual([`POST ${sessionPath}/retry-memory-consolidation`]));
  project('running', 11, undefined, undefined, 8);
  await sessionStore.refreshSessionStatuses();
  respond(Response.json({ error: 'Old retry failed' }, { status: 409 }));
  await attempt;
  expect(sessionStore.sessions[0]).toMatchObject({ status: 'running', generation: 8 });
  expect(sessionStore.error).toBe(priorError);
});
