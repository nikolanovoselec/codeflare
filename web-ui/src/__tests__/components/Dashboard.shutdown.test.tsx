import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import Dashboard from '../../components/Dashboard';
import SessionDropdown from '../../components/SessionDropdown';
import SessionSwitcher from '../../components/SessionSwitcher';
import { SESSION_POLL_STABLE_MS, SESSION_POLL_TRANSITION_MS } from '../../lib/constants';
import { createMigrationRetry } from '../../components/MigrationRetryNotice';
import { sessionStore } from '../../stores/session';
import { terminalStore } from '../../stores/terminal';
import type { Terminal } from '@xterm/xterm';
import type { SessionWithStatus } from '../../types';

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
  shutdownPhase?: Phase; pendingDelete?: boolean; snapshotUnavailable?: boolean;
  metrics?: { cpu?: string; mem?: string; hdd?: string; updatedAt?: string; syncStatus?: string } };
let catalog: (Projection & { name?: string }) | undefined;
let polled: Projection | undefined;
let operations: string[];
let retryResponse: Promise<Response> | undefined;
let deleteResponse: Promise<Response> | undefined;
let batchResponse: Promise<Response> | undefined;
let onBatchRequest: (() => void) | undefined;

function project(status: Lifecycle, revision: number, shutdownPhase?: Phase, pendingDelete?: boolean, generation = 7) {
  catalog = polled = { status, lifecycle: status, generation, revision, shutdownPhase, pendingDelete };
}

function renderDashboard(extra?: SessionWithStatus, onDelete = (id: string) => sessionStore.deleteSession(id)) {
  const openTerminal = vi.fn();
  const start = vi.fn();
  const view = render(() => <Dashboard
    sessions={extra ? [...sessionStore.sessions, extra] : sessionStore.sessions}
    migrationRetry={createMigrationRetry()}
    viewState="dashboard"
    onCreateSession={() => {}}
    onStartSession={start}
    onOpenVscodeSession={() => {}}
    onOpenSessionById={openTerminal}
    onStopSession={sessionStore.stopSession}
    onDeleteSession={onDelete}
  />);
  return { ...view, openTerminal, start };
}

const card = () => within(screen.getByTestId(`session-stat-card-${id}`));
const retry = () => card().getByRole('button', { name: 'Retry memory consolidation' });
const resume = () => card().getByRole('button', { name: 'Resume session' });

async function awaitCommand(name: 'deleteSession' | 'retryMemoryConsolidation', submit: () => void) {
  const command = vi.spyOn(sessionStore, name);
  try {
    submit();
    await command.mock.results[0]?.value;
  } finally {
    command.mockRestore();
  }
}
const accepted = (shutdownPhase: Phase, pendingDelete = false) =>
  Response.json({ id, success: true, shutdownPhase, pendingDelete }, { status: 202 });

beforeEach(async () => {
  id = `shutdownsession${++scenario}`;
  sessionPath = `/api/sessions/${id}`;
  catalog = polled = undefined;
  operations = [];
  retryResponse = deleteResponse = batchResponse = onBatchRequest = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = url.pathname;
    if (path === '/api/sessions' && method === 'GET') {
      return Response.json({ sessions: catalog ? [{ id, name, createdAt: stamp, lastAccessedAt: stamp,
        agentType: 'pi', workspace: 'terminal', terminalMode: 'classic', ...catalog }] : [] });
    }
    if (path === '/api/sessions/batch-status') {
      onBatchRequest?.();
      return batchResponse ?? Response.json({ statuses: polled ? { [id]: polled } : {} });
    }
    if (url.searchParams.get('sessionId') === id) {
      if (path === '/api/container/start' && method === 'POST') return Response.json({ generation: 7 });
      if (path === '/api/container/startup-status') return Response.json({ stage: 'ready', generation: 7,
        progress: 100, message: 'Ready', details: { bucketName: 'test-bucket', container: 'container', path: '/workspace' } });
    }
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
    if (path === sessionPath && method === 'DELETE') return deleteResponse ?? accepted('queued', true);
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
    const label = within(view.getByRole('status', { name: 'Memory consolidation pending...' }));
    for (const word of ['Memory', 'consolidation', 'pending...']) expect(label.getByText(word)).toBeVisible();
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
    const label = within(view.getByRole('status', { name: 'Consolidating memory...' }));
    for (const word of ['Consolidating', 'memory...']) expect(label.getByText(word)).toBeVisible();
    for (const metric of ['7%', '1.2G', '3.1G']) expect(view.getByText(metric)).toBeVisible();
    expect(view.queryByRole('button', { name: /activate session|resume session/i })).not.toBeInTheDocument();
  }
  polled = { ...polled, revision: 13, shutdownPhase: 'finishing' };
  await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
  for (const view of cards()) {
    expect(view.getByRole('status', { name: 'Shutting down' })).toHaveTextContent(/^Shutting down$/);
    expect(view.queryByText(/^(consolidating|pending\.\.\.)$/i)).not.toBeInTheDocument();
    expect(view.getByText('7%')).toBeVisible();
    expect(view.queryByRole('button', { name: /activate session|resume session/i })).not.toBeInTheDocument();
  }
  if (action === 'Stop') {
    polled = { status: 'stopped', lifecycle: 'stopped', generation: 7, revision: 14 };
    await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
    for (const view of cards()) expect(view.getByRole('status', { name: 'STOPPED' })).toBeVisible();
  } else {
    catalog = polled = undefined;
    await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS * 3);
    expect(screen.queryAllByTestId(`session-stat-card-${id}`)).toHaveLength(0);
  }
});

it.each(['Stop', 'Delete'] as const)('REQ-SESSION-043: an open observer dropdown follows remote %s without a reload', async action => {
  vi.useFakeTimers();
  project('running', 10);
  await sessionStore.loadSessions();
  const observer = { ...sessionStore.sessions[0]!, id: 'observer', name: 'Observer' };
  render(() => <SessionSwitcher sessions={[observer, ...sessionStore.sessions]} activeSessionId={observer.id}
    onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
  sessionStore.startSessionListPolling();
  fireEvent.click(screen.getByTestId('session-switcher'));
  expect(card().getByRole('status', { name: 'IDLE' })).toBeVisible();
  await vi.advanceTimersByTimeAsync(0);

  project('running', 11, 'queued', action === 'Delete');
  await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
  expect(card().getByRole('status', { name: 'Memory consolidation pending...' })).toBeVisible();
  project('stopping', 12, 'consolidating', action === 'Delete');
  await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
  expect(card().getByRole('status', { name: 'Consolidating memory...' })).toBeVisible();
  expect(card().queryByRole('button', { name: /activate session|resume session/i })).not.toBeInTheDocument();

  if (action === 'Stop') {
    project('stopped', 13);
    await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
    expect(card().getByRole('status', { name: 'STOPPED' })).toBeVisible();
    fireEvent.click(screen.getByTestId('session-switcher'));
    project('running', 14, undefined, undefined, 8);
    await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
    expect(sessionStore.sessions.find(s => s.id === id)?.status).toBe('stopped');
    fireEvent.click(screen.getByTestId('session-switcher'));
    await vi.advanceTimersByTimeAsync(0);
    expect(card().getByRole('status', { name: 'IDLE' })).toBeVisible();
    project('stopping', 15, undefined, undefined, 8);
    await sessionStore.refreshSessionStatuses();
    project('stopped', 16, undefined, undefined, 8);
    await sessionStore.refreshSessionStatuses();
    expect(card().getByRole('status', { name: 'STOPPED' })).toBeVisible();
  } else {
    catalog = polled = undefined;
    await vi.advanceTimersByTimeAsync(3 * SESSION_POLL_TRANSITION_MS);
    expect(screen.queryByTestId(`session-stat-card-${id}`)).not.toBeInTheDocument();
  }
});

it.each(['stopped', 'memory-not-merged'] as const)('REQ-SESSION-043: both cards show %s without dismissing terminal Ready', async outcome => {
  project('stopped', 10, undefined, undefined, 6);
  await sessionStore.loadSessions();
  await sessionStore.startSession(id);
  try {
    const { openTerminal } = renderDashboard();
    const select = vi.fn();
    render(() => <SessionDropdown isOpen sessions={sessionStore.sessions} activeSessionId="observer"
      onSelectSession={select} onStopSession={() => {}} onDeleteSession={() => {}}
      onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);
    const cards = () => screen.getAllByTestId(`session-stat-card-${id}`).map(node => within(node));
    expect(cards()).toHaveLength(2);
    for (const view of cards()) expect(view.getByRole('status', { name: 'IDLE' })).toBeVisible();

    project('stopping', 12, 'consolidating');
    await sessionStore.refreshSessionStatuses();
    for (const view of cards()) expect(view.getByRole('status', { name: 'Consolidating memory...' })).toBeVisible();

    project('stopped', 13);
    await sessionStore.refreshSessionStatuses();
    for (const view of cards()) expect(view.getByRole('status', { name: 'STOPPED' })).toBeVisible();
    expect(sessionStore.getInitProgressForSession(id)?.stage).toBe('ready');
    for (const view of cards()) {
      fireEvent.click(view.getByRole('button', { name: 'Session actions' }));
      expect(screen.getByTestId('context-menu-delete')).toBeVisible();
      expect(screen.queryByTestId('context-menu-stop')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Kill' })).not.toBeInTheDocument();
      fireEvent.click(document.querySelector('.session-context-menu__backdrop')!);
    }

    if (outcome === 'stopped') {
      for (const view of cards()) fireEvent.click(view.getByRole('button', { name: `Activate session ${name}` }));
      expect(openTerminal).toHaveBeenCalledWith(id);
      expect(select).toHaveBeenCalledWith(id);
      sessionStore.dismissInitProgressForSession(id);
      for (const view of cards()) expect(view.getByRole('status', { name: 'STOPPED' })).toBeVisible();
      return;
    }
    project('stopped', 14, 'memory-not-merged');
    await sessionStore.refreshSessionStatuses();
    for (const view of cards()) fireEvent.click(view.getByRole('button', { name: 'Resume session' }));
    expect(openTerminal).toHaveBeenCalledWith(id);
    expect(select).toHaveBeenCalledWith(id);
    await awaitCommand('retryMemoryConsolidation', () => fireEvent.click(cards()[0].getByRole('button', { name: 'Retry memory consolidation' })));
    expect(operations).toContain(`POST ${sessionPath}/retry-memory-consolidation`);
  } finally {
    sessionStore.dismissInitProgressForSession(id);
    await sessionStore.refreshSessionStatuses();
  }
});

it('REQ-SESSION-043: repeated omissions hide both cards without changing terminal Ready', async () => {
  project('stopped', 10, undefined, undefined, 6);
  await sessionStore.loadSessions();
  await sessionStore.startSession(id);
  try {
    renderDashboard();
    render(() => <SessionDropdown isOpen sessions={sessionStore.sessions} activeSessionId="observer"
      onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}}
      onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);
    const cards = () => screen.queryAllByTestId(`session-stat-card-${id}`);
    expect(cards()).toHaveLength(2);
    const miss = async () => {
      catalog = polled = undefined;
      await sessionStore.refreshSessionStatuses();
    };
    project('running', 11);
    await sessionStore.refreshSessionStatuses();
    await miss();
    await miss();
    project('running', 12);
    await sessionStore.refreshSessionStatuses();
    await miss();
    expect(cards()).toHaveLength(2);
    batchResponse = Promise.resolve(new Response(null, { status: 503 }));
    await sessionStore.refreshSessionStatuses();
    expect(cards()).toHaveLength(2);
    batchResponse = undefined;
    await miss();
    expect(cards()).toHaveLength(2);
    project('running', 11);
    await sessionStore.refreshSessionStatuses();
    await miss();
    expect(cards()).toHaveLength(0);
    expect(sessionStore.getInitProgressForSession(id)?.stage).toBe('ready');
    expect(sessionStore.sessions.some(session => session.id === id)).toBe(true);
  } finally {
    sessionStore.dismissInitProgressForSession(id);
    await sessionStore.loadSessions();
  }
});

it.each(['Dashboard', 'dropdown'] as const)('REQ-SESSION-244: %s discards Delete confirmation when its card is hidden', async surface => {
  project('stopped', 10, undefined, undefined, 6);
  await sessionStore.loadSessions();
  await sessionStore.startSession(id);
  const other = { ...sessionStore.sessions[0]!, id: 'other-session', name: 'Other workspace' };
  const remove = vi.fn(async (_id: string) => {});
  try {
    if (surface === 'Dashboard') renderDashboard(other, remove);
    else render(() => <SessionDropdown isOpen sessions={[...sessionStore.sessions, other]} activeSessionId="observer"
      onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={remove}
      onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);

    fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByTestId('context-menu-delete'));
    expect(screen.getByTestId('context-menu-delete-confirm')).toBeVisible();
    catalog = polled = undefined;
    for (let miss = 0; miss < 3; miss++) await sessionStore.refreshSessionStatuses();
    expect(screen.queryByTestId(`session-stat-card-${id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-menu-delete-confirm')).not.toBeInTheDocument();

    project('running', 11);
    await sessionStore.refreshSessionStatuses();
    expect(card().getByRole('button', { name: 'Session actions' })).toBeVisible();
    expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
    expect(screen.getByTestId('context-menu-delete')).toBeVisible();
    expect(screen.queryByTestId('context-menu-delete-confirm')).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('.session-context-menu__backdrop')!);

    fireEvent.click(within(screen.getByTestId(`session-stat-card-${other.id}`)).getByRole('button', { name: 'Session actions' }));
    expect(screen.queryByTestId('context-menu-delete-confirm')).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('context-menu-delete'));
    fireEvent.click(screen.getByTestId('context-menu-delete-confirm'));
    expect(remove.mock.calls).toEqual([[other.id]]);
  } finally {
    sessionStore.dismissInitProgressForSession(id);
    project('stopping', 12);
    await sessionStore.refreshSessionStatuses();
    project('stopped', 13);
    await sessionStore.refreshSessionStatuses();
  }
});

it('REQ-SESSION-043: an accepted Delete removes the card after a newer live read and no queued projection', async () => {
  vi.useFakeTimers();
  project('running', 10);
  await sessionStore.loadSessions();
  renderDashboard();
  sessionStore.startSessionListPolling();
  let accept!: (response: Response) => void;
  deleteResponse = new Promise(resolve => { accept = resolve; });
  const deletion = sessionStore.deleteSession(id);
  project('running', 11);
  await sessionStore.refreshSessionStatuses();
  polled = undefined;
  accept(accepted('queued', true));
  await deletion;
  await vi.advanceTimersByTimeAsync(2 * SESSION_POLL_TRANSITION_MS);
  expect(screen.queryByTestId(`session-stat-card-${id}`)).not.toBeInTheDocument();
});

it('REQ-SESSION-043: accepted Delete resumes fast confirmation after the tab was hidden', async () => {
  vi.useFakeTimers();
  let visible = true;
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  try {
    project('running', 10);
    await sessionStore.loadSessions();
    renderDashboard();
    sessionStore.startSessionListPolling();
    visible = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await sessionStore.deleteSession(id);
    catalog = polled = undefined;
    await vi.advanceTimersByTimeAsync(SESSION_POLL_STABLE_MS);
    expect(card().getByText(name)).toBeVisible();
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(card().getByText(name)).toBeVisible();
    await vi.advanceTimersByTimeAsync(2 * SESSION_POLL_TRANSITION_MS);
    expect(screen.queryByTestId(`session-stat-card-${id}`)).not.toBeInTheDocument();
  } finally {
    visibility.mockRestore();
  }
});

it('REQ-SESSION-043: a failed Delete without a shutdown phase returns to idle polling', async () => {
  vi.useFakeTimers();
  project('running', 10);
  await sessionStore.loadSessions();
  renderDashboard();
  sessionStore.startSessionListPolling();
  project('running', 11, undefined, true);
  await sessionStore.deleteSession(id);
  await vi.advanceTimersByTimeAsync(0);
  polled = { ...polled!, revision: 12, metrics: { cpu: '26%', mem: '1G', hdd: '3G' } };
  await vi.advanceTimersByTimeAsync(SESSION_POLL_TRANSITION_MS);
  expect(card().queryByText('26%')).not.toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(SESSION_POLL_STABLE_MS - SESSION_POLL_TRANSITION_MS);
  expect(card().getByText('26%')).toBeVisible();
});

it('REQ-SESSION-043: refresh called after Delete acceptance does not join a pre-command read', async () => {
  project('running', 10);
  await sessionStore.loadSessions();
  renderDashboard();
  let release!: (response: Response) => void;
  batchResponse = new Promise(resolve => { release = resolve; });
  const stale = sessionStore.refreshSessionStatuses();
  await sessionStore.deleteSession(id);
  const fresh = sessionStore.refreshSessionStatuses();
  batchResponse = undefined;
  project('running', 11, 'queued', true);
  release(Response.json({ statuses: {} }));
  await Promise.all([stale, fresh]);
  expect(card().getByRole('status', { name: 'Memory consolidation pending...' })).toBeVisible();
});

it('REQ-SESSION-043: distinguishes current readings, last-known readings and unavailable shutdown metrics', async () => {
  vi.useFakeTimers();
  const metrics = { cpu: '7%', mem: '1.2G', hdd: '3.1G', updatedAt: new Date().toISOString() };
  project('stopping', 10, 'consolidating');
  polled = { ...polled!, lifecycle: 'running', metrics };
  await sessionStore.loadSessions();
  renderDashboard();
  expect(card().getByText('7%')).toBeVisible();
  expect(card().queryByText('Last known metrics')).not.toBeInTheDocument();
  const dropdown = render(() => <SessionDropdown isOpen sessions={sessionStore.sessions} activeSessionId={id}
    onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}}
    onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);
  const cards = () => screen.getAllByTestId(`session-stat-card-${id}`).map(node => within(node));
  batchResponse = Promise.resolve(Response.json({ error: 'Status unavailable' }, { status: 503 }));
  await sessionStore.refreshSessionStatuses();
  expect(cards()).toHaveLength(2);
  for (const view of cards()) {
    expect(view.getByRole('status', { name: 'Consolidating memory...' })).toBeVisible();
    expect(view.getByText('7%')).toBeVisible();
    expect(view.getByText('Last known metrics')).toBeVisible();
  }
  batchResponse = Promise.resolve(Response.json({ statuses: {} }));
  await sessionStore.refreshSessionStatuses();
  expect(cards()).toHaveLength(2);
  for (const view of cards()) {
    expect(view.getByText('7%')).toBeVisible();
    expect(view.getByText('Last known metrics')).toBeVisible();
  }
  batchResponse = Promise.resolve(Response.json({ statuses: { [id]: { ...polled, metrics: {} } } }));
  await sessionStore.refreshSessionStatuses();
  for (const view of cards()) {
    expect(view.getByText('7%')).toBeVisible();
    expect(view.getByText('Last known metrics')).toBeVisible();
  }
  batchResponse = undefined;
  await sessionStore.refreshSessionStatuses();
  for (const view of cards()) expect(view.queryByText('Last known metrics')).not.toBeInTheDocument();
  dropdown.unmount();
  await vi.advanceTimersByTimeAsync(2 * SESSION_POLL_STABLE_MS);
  expect(card().getByText('Last known metrics')).toBeVisible();
  polled = { ...polled, revision: 11, metrics: { ...metrics, updatedAt: new Date().toISOString() } };
  await sessionStore.refreshSessionStatuses();
  expect(card().queryByText('Last known metrics')).not.toBeInTheDocument();
  polled = { ...polled, lifecycle: 'stopping', revision: 12, shutdownPhase: 'finishing' };
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Last known metrics')).toBeVisible();
  expect(card().getByText('7%')).toBeVisible();
  polled = { ...polled, lifecycle: 'stopped', status: 'stopped', revision: 13, shutdownPhase: 'queued', metrics: undefined };
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Metrics unavailable')).toBeVisible();
  expect(card().queryByText('7%')).not.toBeInTheDocument();
});

it.each(['poll', 'catalog'] as const)('REQ-SESSION-043: both cards hide the previous runtime readings after restart via %s', async source => {
  project('running', 10);
  const updatedAt = new Date().toISOString();
  const previous = { cpu: '7%', mem: '1.2G', hdd: '3.1G', updatedAt, syncStatus: 'syncing' };
  polled = { ...polled!, metrics: previous };
  await sessionStore.loadSessions();
  expect(sessionStore.getMetricsForSession(id)?.syncStatus).toBe('syncing');
  renderDashboard();
  render(() => <SessionDropdown isOpen sessions={sessionStore.sessions} activeSessionId={id}
    onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}}
    onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);
  const cards = () => screen.getAllByTestId(`session-stat-card-${id}`).map(node => within(node));
  expect(cards()).toHaveLength(2);
  for (const view of cards()) expect(view.getByText('7%')).toBeVisible();

  project('stopping', 11);
  await sessionStore.refreshSessionStatuses();
  project('stopped', 12);
  await sessionStore.refreshSessionStatuses();
  for (const view of cards()) expect(view.getByRole('status', { name: 'STOPPED' })).toBeVisible();

  const expectPlaceholders = () => {
    expect(cards()).toHaveLength(2);
    for (const view of cards()) {
      for (const value of ['7%', '1.2G', '3.1G']) expect(view.queryByText(value)).not.toBeInTheDocument();
      expect(view.getAllByText('...', { exact: true })).toHaveLength(3);
    }
  };
  project('running', 13, undefined, undefined, 8);
  if (source === 'poll') await sessionStore.refreshSessionStatuses();
  else {
    polled = { ...polled!, metrics: { updatedAt } };
    let reply!: (response: Response) => void;
    batchResponse = new Promise(resolve => { reply = resolve; });
    const loading = sessionStore.loadSessions();
    try {
      await waitFor(() => expect(sessionStore.sessions.find(session => session.id === id))
        .toMatchObject({ generation: 8, revision: 13, status: 'running' }));
      expect(sessionStore.getMetricsForSession(id)?.syncStatus).toBeUndefined();
      for (const view of cards()) expect(view.getByRole('status', { name: 'IDLE' })).toBeVisible();
      expectPlaceholders();
    } finally {
      reply(Response.json({ statuses: { [id]: polled } }));
      batchResponse = undefined;
      await loading;
    }
  }
  expectPlaceholders();

  polled = { ...polled, revision: 14, metrics: { cpu: '21%', mem: '2.1G', hdd: '4.2G', updatedAt } };
  await sessionStore.refreshSessionStatuses();
  for (const view of cards()) {
    for (const value of ['21%', '2.1G', '4.2G']) expect(view.getByText(value)).toBeVisible();
  }
});

it.each(['confirmed', 'omitted row', 'omitted metrics', 'failed', 'partial fallback'] as const)(
  'REQ-SESSION-043: retains readings on both cards when a catalog batch follows a %s poll', async outcome => {
    project('running', 9, 'queued');
    if (outcome === 'partial fallback') {
      polled = { ...polled!, metrics: { cpu: '15%', mem: '1.2G', hdd: '3.1G', updatedAt: new Date().toISOString() } };
    }
    await sessionStore.loadSessions();
    renderDashboard();
    const observer = render(() => <SessionDropdown isOpen sessions={sessionStore.sessions} activeSessionId={id}
      onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}}
      onCreateSession={() => {}} onClose={() => {}} isMobileView={false} />);
    const cards = () => screen.getAllByTestId(`session-stat-card-${id}`).map(node => within(node));
    project('stopping', 10, 'consolidating');
    const current = { ...polled!, lifecycle: 'running' as const,
      metrics: { cpu: '21%', mem: '1.2G', hdd: '3.1G', updatedAt: new Date().toISOString() } };
    // In the outage case the earlier request carries a higher lifecycle revision than the published catalog.
    catalog = outcome === 'failed' ? { ...current, name: 'Saving workspace', shutdownPhase: 'saving', revision: 9 } : current;
    let release!: (response: Response) => void;
    batchResponse = new Promise(resolve => { release = resolve; });
    const loading = sessionStore.loadSessions();
    const unavailable = 'Session status unavailable. Displayed state may be outdated.';
    try {
      if (outcome === 'failed') await within(observer.container).findByText('Saving workspace');
      else await within(observer.container).findByRole('status', { name: 'Consolidating memory...' });
      if (outcome === 'partial fallback') {
        for (const view of cards()) {
          for (const value of ['15%', '1.2G', '3.1G']) expect(view.getByText(value)).toBeVisible();
        }
      }
      batchResponse = outcome === 'failed'
        ? Promise.resolve(Response.json({ error: 'Status unavailable' }, { status: 503 })) : undefined;
      polled = outcome === 'omitted row' || outcome === 'partial fallback' ? undefined
        : outcome === 'omitted metrics' ? { ...current, metrics: undefined } : current;
      await sessionStore.refreshSessionStatuses();
      if (outcome === 'failed') expect(screen.getByText(unavailable)).toBeVisible();
    } finally {
      const metrics = outcome === 'partial fallback' ? { cpu: '7%', updatedAt: current.metrics.updatedAt }
        : { ...current.metrics, cpu: '7%' };
      release(Response.json({ statuses: { [id]: { ...current, metrics } } }));
      await loading;
    }
    expect(cards()).toHaveLength(2);
    if (outcome === 'failed') expect(screen.getByText(unavailable)).toBeVisible();
    for (const view of cards()) {
      if (outcome === 'failed') expect(view.getByRole('status', { name: 'Consolidating memory...' })).toBeVisible();
      if (outcome === 'confirmed') {
        expect(view.getByText('21%')).toBeVisible();
        expect(view.queryByText('7%')).not.toBeInTheDocument();
        expect(view.queryByText('Last known metrics')).not.toBeInTheDocument();
      } else {
        for (const value of ['7%', '1.2G', '3.1G']) expect(view.getByText(value)).toBeVisible();
        expect(view.getByText('Last known metrics')).toBeVisible();
      }
    }
  });

it.each(['queued', 'consolidating'] as const)('REQ-TERM-013: an active %s session and a stopped card cannot take MultiView slots', async phase => {
  project(phase === 'queued' ? 'running' : 'stopping', 10, phase);
  await sessionStore.loadSessions();
  const shuttingDown = sessionStore.sessions[0]!;
  const running = ['one', 'two'].map(id => ({ ...shuttingDown, id, name: id, status: 'running' as const, shutdownPhase: undefined }));
  const stopped = { ...shuttingDown, id: 'stopped', name: 'stopped', status: 'stopped' as const, shutdownPhase: undefined };
  const launch = vi.fn();
  render(() => <SessionDropdown isOpen sessions={[shuttingDown, stopped, ...running]} activeSessionId={id}
    onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}}
    onCreateSession={() => {}} onClose={() => {}} isMobileView={false}
    multiView={{ capacity: 2, existing: null, onLaunch: launch, onOpen: () => {}, onClose: () => {} }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Launch MultiView' }));
  expect(card().queryByRole('button', { name: /activate session/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Activate session stopped' }));
  expect(screen.getByRole('button', { name: 'Cancel MultiView' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Activate session one' }));
  expect(screen.getByRole('button', { name: 'Cancel MultiView' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Activate session two' }));
  fireEvent.click(screen.getByRole('button', { name: 'Launch MultiView' }));
  expect(launch).toHaveBeenCalledWith(['one', 'two']);
});

it('REQ-TERM-013: recovery Resume is disabled while selecting MultiView panes', async () => {
  project('stopped', 10, 'memory-not-merged');
  await sessionStore.loadSessions();
  const running = ['one', 'two'].map(id => ({ ...sessionStore.sessions[0]!, id, status: 'running' as const, shutdownPhase: undefined }));
  const select = vi.fn();
  render(() => <SessionDropdown isOpen sessions={[...sessionStore.sessions, ...running]} activeSessionId="one"
    onSelectSession={select} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}}
    onClose={() => {}} isMobileView={false} multiView={{ capacity: 2, existing: null,
      onLaunch: () => {}, onOpen: () => {}, onClose: () => {} }} />);
  expect(resume()).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Launch MultiView' }));
  expect(resume()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel MultiView' }));
  fireEvent.click(resume());
  expect(select).toHaveBeenCalledWith(id);
});

it('REQ-SESSION-043: reports eviction after queued Retry and leaves Resume available', async () => {
  project('stopped', 10, 'memory-not-merged', true);
  await sessionStore.loadSessions();
  renderDashboard();
  await awaitCommand('retryMemoryConsolidation', () => fireEvent.click(retry()));
  expect(operations).toContain(`POST ${sessionPath}/retry-memory-consolidation`);
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
  expect(card().getByRole('status', { name: 'Memory consolidation pending...' })).toBeVisible();
  expect(card().queryByRole('status', { name: /^stopped$/i })).not.toBeInTheDocument();

  project('stopping', 11, 'saving');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'Memory consolidation pending...' })).toBeVisible();
  expect(card().queryByText(/saving session files/i)).not.toBeInTheDocument();

  project('stopping', 12, 'consolidating');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'Consolidating memory...' })).toBeVisible();
  expect(card().queryByRole('progressbar')).not.toBeInTheDocument();

  project('stopping', 13, 'finishing');
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'Shutting down' })).toHaveTextContent(/^Shutting down$/);
  expect(card().queryByRole('button', { name: /activate session/i })).not.toBeInTheDocument();
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
    expect(card().getByRole('status', { name: 'Memory consolidation pending...' })).toBeVisible();
    expect(card().queryByRole('button', { name: 'Resume session' })).not.toBeInTheDocument();
    project('stopping', revision + 1, 'consolidating');
    await sessionStore.refreshSessionStatuses();
    expect(card().getByRole('status', { name: 'Consolidating memory...' })).toBeVisible();
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
  expect(card().getByRole('status', { name: phase === 'queued' ? 'Memory consolidation pending...' : 'Consolidating memory...' })).toBeVisible();
  fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
  await waitFor(() => expect(operations).toEqual([`POST ${sessionPath}/kill`]));
  expect(dashboard.openTerminal).not.toHaveBeenCalled();
  project('stopped', 11);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'STOPPED' })).toBeVisible();
  expect(card().queryByRole('status', { name: /memory consolidation pending|consolidating memory/i })).not.toBeInTheDocument();
});

it('REQ-SESSION-043: an accepted Delete retains the card through merge failure and finishing until the server removes it', async () => {
  vi.useFakeTimers();
  project('running', 10);
  await sessionStore.loadSessions();
  renderDashboard();
  fireEvent.click(card().getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await awaitCommand('deleteSession', () => fireEvent.click(screen.getByRole('button', { name: 'Are you sure?' })));
  expect(operations).toEqual([`DELETE ${sessionPath}`]);
  project('running', 11, 'queued', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByRole('status', { name: 'Memory consolidation pending...' })).toBeVisible();
  project('stopped', 12, 'memory-not-merged', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().getByText('Stopped · memory not merged')).toBeVisible();
  expect(card().getByText(/deletion (?:did not complete|is pending)|not deleted/i)).toBeVisible();
  await awaitCommand('retryMemoryConsolidation', () => fireEvent.click(retry()));
  expect(operations).toEqual([`DELETE ${sessionPath}`, `POST ${sessionPath}/retry-memory-consolidation`]);
  project('stopping', 13, 'finishing', true);
  await sessionStore.refreshSessionStatuses();
  expect(card().queryByRole('button', { name: /activate session/i })).not.toBeInTheDocument();
  sessionStore.setActiveSession(id);
  catalog = polled = undefined;
  // Each observation comes from a distinct successful HTTP read, not another
  // caller joining a prior refresh or a confirmation timer racing the fixture.
  for (let misses = 1; misses <= 3; misses++) {
    const served = new Promise<void>(resolve => { onBatchRequest = resolve; });
    await Promise.all([served, sessionStore.refreshSessionStatuses()]);
    onBatchRequest = undefined;
    expect(sessionStore.statusUnavailable).toBe(false);
    if (misses < 3) expect(card().queryByRole('button', { name: /activate session/i })).not.toBeInTheDocument();
  }
  expect(sessionStore.sessions.some(session => session.id === id)).toBe(false);
  expect(sessionStore.activeSessionId).toBeNull();
  expect(screen.queryByTestId(`session-stat-card-${id}`)).not.toBeInTheDocument();
});

it('REQ-SESSION-043: a settled Stop clears recovery controls and rejects older merge-failure evidence', async () => {
  project('stopped', 10, 'memory-not-merged');
  await sessionStore.loadSessions();
  renderDashboard();
  await awaitCommand('retryMemoryConsolidation', () => fireEvent.click(retry()));
  expect(operations).toEqual([`POST ${sessionPath}/retry-memory-consolidation`]);
  project('stopping', 11, 'finishing');
  await sessionStore.refreshSessionStatuses();
  expect(card().queryByRole('button', { name: /activate session/i })).not.toBeInTheDocument();
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
