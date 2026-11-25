import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import * as api from '../../api/client';
import { sessionStore } from '../../stores/session';
import { terminalStore } from '../../stores/terminal';
import SessionStatCard from '../../components/SessionStatCard';
import type { Session } from '../../types';

vi.mock('../../api/client', async original => ({
  ...await original<typeof import('../../api/client')>(),
  getSessions: vi.fn(),
  getBatchSessionStatus: vi.fn(),
  getSessionAncillaryStatus: vi.fn(async () => ({ maxSessions: 3 })),
  startSession: vi.fn(),
}));
vi.mock('../../lib/vault-cache', () => ({
  cleanupSessionVaultCache: async () => undefined,
  sweepOrphanVaultCaches: async () => undefined,
}));

const id = 'abcdef0123456789';
const editor: Session = {
  id, name: 'Readiness fixture', workspace: 'vscode',
  createdAt: '2026-11-08T00:00:00Z', lastAccessedAt: '2026-11-08T00:00:00Z',
  status: 'running', lifecycle: 'running', generation: 7, revision: 10,
};
const current = () => sessionStore.sessions.find(session => session.id === id)!;
function stopPolling() {
  sessionStore.stopSessionListPolling();
  sessionStore.stopAllPolling();
}
function renderCard(onSelect = () => {}) {
  return render(() => <SessionStatCard session={current()} isActive={true}
    onSelect={onSelect} onStop={() => {}} onDelete={() => {}} />);
}

beforeEach(async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected external I/O in IDE readiness test'); });
  stopPolling();
  terminalStore.disposeAll();
  sessionStore._resetMissCounters();
  sessionStore._resetStartupGuards();
  sessionStore._resetManagedCheckState();
  sessionStore.setActiveSession(null);
  vi.mocked(api.getSessions).mockReset().mockResolvedValue([]);
  vi.mocked(api.getBatchSessionStatus).mockReset().mockResolvedValue({ statuses: {} });
  vi.mocked(api.startSession).mockReset();
  await sessionStore.loadSessions();
  stopPolling();
});
afterEach(() => {
  cleanup();
  stopPolling();
  terminalStore.disposeAll();
  sessionStore.setActiveSession(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('REQ-IDE-049 AC3: retry renders pending editor initialization before the ready probe completes', async () => {
  vi.mocked(api.getSessions).mockResolvedValue([{ ...editor, editorReady: false, editorReadyError: true }]);
  vi.mocked(api.getBatchSessionStatus).mockResolvedValue({ statuses: {} });
  await sessionStore.loadSessions();
  stopPolling();
  let finish!: (generation: number) => void;
  let progress!: Parameters<typeof api.startSession>[1];
  let retryRequested = false;
  vi.mocked(api.startSession).mockImplementation((_id, onProgress, onComplete, _onError, options) => {
    progress = onProgress;
    finish = onComplete;
    retryRequested = options?.retryEditorTimeout === true;
    return () => {};
  });
  let starting: ReturnType<typeof sessionStore.startSession> | undefined;
  renderCard(() => { starting = sessionStore.startSession(id); });
  expect(screen.getByRole('status', { name: 'Session running' })).toHaveClass('session-stat-card__dot--error');

  fireEvent.click(screen.getByRole('button', { name: 'Activate session Readiness fixture' }));
  expect(retryRequested).toBe(true);
  expect(screen.getByTestId(`session-stat-card-${id}`)).toHaveAttribute('data-status', 'initializing');
  expect(screen.getByTestId(`session-stat-card-${id}-progress`)).toHaveStyle({ width: '0%' });
  expect(current().editorReady).toBe(false);
  progress({ stage: 'mounting', progress: 90, message: 'Preparing VS Code...' });
  expect(screen.getByTestId(`session-stat-card-${id}-progress`)).toHaveStyle({ width: '90%' });
  expect(sessionStore.isSessionInitializing(id)).toBe(true);
  expect(current()).toMatchObject({ editorReady: false, editorReadyError: true });
  expect(screen.getByRole('status', { name: 'Session initializing' })).toHaveClass('session-stat-card__dot--error');

  finish(7);
  await starting;
  expect(current()).toMatchObject({ status: 'running', editorReady: true, editorReadyError: false });
  expect(screen.queryByTestId(`session-stat-card-${id}-progress`)).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Session running' })).toHaveClass('session-stat-card__dot--success');
  expect(sessionStore.getTerminalsForSession(id)).toBeNull();
});

it.each([
  { editorReady: true, editorReadyError: false, variant: 'success' },
  { editorReady: false, editorReadyError: true, variant: 'error' },
  { editorReady: false, editorReadyError: false, variant: 'default' },
])('REQ-IDE-055 AC2: failed status reads preserve ready=$editorReady error=$editorReadyError and its rendered indicator', async state => {
  vi.mocked(api.getSessions).mockResolvedValue([editor]);
  vi.mocked(api.getBatchSessionStatus).mockResolvedValueOnce({ statuses: {
    [id]: { status: 'running', lifecycle: 'running', generation: 7, revision: 11,
      editorReady: state.editorReady, editorReadyError: state.editorReadyError },
  } });
  await sessionStore.loadSessions();
  stopPolling();
  const accepted = { ...current() };
  expect(accepted).toMatchObject({ generation: 7, revision: 11,
    editorReady: state.editorReady, editorReadyError: state.editorReadyError });
  renderCard();

  vi.mocked(api.getBatchSessionStatus).mockRejectedValueOnce(new Error('status read unavailable'));
  await sessionStore.refreshSessionStatuses();
  expect(sessionStore.statusUnavailable).toBe(true);
  expect(current()).toEqual(accepted);
  expect(screen.getByRole('status', { name: 'Session running' })).toHaveClass(`session-stat-card__dot--${state.variant}`);
  vi.mocked(api.getSessions).mockRejectedValueOnce(new Error('catalog read unavailable'));
  await sessionStore.loadSessions();
  expect(current()).toEqual(accepted);
  expect(screen.getByRole('status', { name: 'Session running' })).toHaveClass(`session-stat-card__dot--${state.variant}`);

  vi.mocked(api.getBatchSessionStatus).mockResolvedValueOnce({ statuses: {
    [id]: { status: 'running', lifecycle: 'running', generation: 7, revision: 12,
      editorReady: true, editorReadyError: false },
  } });
  await sessionStore.refreshSessionStatuses();
  expect(sessionStore.statusUnavailable).toBe(false);
  expect(current()).toMatchObject({ revision: 12, editorReady: true, editorReadyError: false });
  expect(screen.getByRole('status', { name: 'Session running' })).toHaveClass('session-stat-card__dot--success');
});
