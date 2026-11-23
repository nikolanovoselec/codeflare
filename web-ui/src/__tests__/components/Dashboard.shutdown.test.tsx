import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import Dashboard from '../../components/Dashboard';
import { createMigrationRetry } from '../../components/MigrationRetryNotice';
import { sessionStore } from '../../stores/session';

// Keep the Dashboard, SessionStatCard, session store, and HTTP client real.
// jsdom can check accessible content and commands, not card dimensions or tap targets.
const id = 'shutdownsession1';
const sessionPath = `/api/sessions/${id}`;
const name = 'Shutdown workspace';
const stamp = '2026-11-23T10:00:00.000Z';
type Phase = 'queued' | 'saving' | 'consolidating' | 'finishing' | 'memory-not-merged';
type Lifecycle = 'running' | 'stopping' | 'stopped';
type Projection = { status: Lifecycle; lifecycle: Lifecycle; generation: number; revision: number; shutdownPhase?: Phase; pendingDelete?: boolean };
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
    if (path === sessionPath && method === 'DELETE') return accepted('queued', true);
    throw new Error(`Unexpected HTTP request: ${method} ${path}`);
  });
  await sessionStore.loadSessions();
});

afterEach(() => {
  cleanup();
  sessionStore.stopSessionListPolling();
  sessionStore.stopR2Polling();
  sessionStore.stopAllPolling();
  sessionStore.setActiveSession(null);
  vi.unstubAllGlobals();
});

it('REQ-SESSION-043: renders durable shutdown phases on the card without inventing progress or exit', async () => {
  project('running', 10, 'queued');
  await sessionStore.loadSessions();
  renderDashboard();
  expect(card().getByText('Queued for shutdown.')).toBeVisible();
  expect(card().queryByRole('status', { name: /^stopped$/i })).not.toBeInTheDocument();

  project('stopping', 11, 'saving');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/saving/i)).toBeVisible();

  project('stopping', 12, 'consolidating');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Shutting down. Consolidating memory')).toBeVisible();
  const progress = card().getByRole('progressbar');
  expect(progress).not.toHaveAttribute('aria-valuenow');
  expect(progress).not.toHaveAttribute('value');

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
    expect(card().getByText('Queued for shutdown.')).toBeVisible();
    expect(retry()).toBeVisible();
    project('stopping', revision + 1, 'consolidating');
    await sessionStore.refreshSessionStatuses();
    expect(card().getByRole('progressbar')).toBeVisible();
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

it.each(['queued', 'consolidating'] as const)('REQ-SESSION-043: keeps Kill independently usable on the %s card', async phase => {
  project(phase === 'queued' ? 'running' : 'stopping', 10, phase);
  await sessionStore.loadSessions();
  const dashboard = renderDashboard();
  expect(card().getByText(phase === 'queued' ? 'Queued for shutdown.' : 'Shutting down. Consolidating memory')).toBeVisible();
  fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
  await waitFor(() => expect(operations).toEqual([`POST ${sessionPath}/kill`]));
  expect(dashboard.openTerminal).not.toHaveBeenCalled();
  project('stopped', 11);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'STOPPED' })).toBeVisible();
  expect(card().queryByText(/queued for shutdown|consolidating memory/i)).not.toBeInTheDocument();
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
  expect(card().getByText('Queued for shutdown.')).toBeVisible();
  project('stopped', 12, 'memory-not-merged', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Stopped · memory not merged')).toBeVisible();
  expect(card().getByText(/deletion (?:did not complete|is pending)|not deleted/i)).toBeVisible();
  fireEvent.click(retry());
  await waitFor(() => expect(operations).toEqual([`DELETE ${sessionPath}`, `POST ${sessionPath}/retry-memory-consolidation`]));
  project('stopping', 13, 'finishing', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText(/finishing/i)).toBeVisible();
  catalog = polled = undefined;
  await sessionStore.loadSessions();
  expect(screen.queryByText(name)).not.toBeInTheDocument();
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

it('REQ-SESSION-043: late retry failure from the prior generation does not overwrite a resumed session', async () => {
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
