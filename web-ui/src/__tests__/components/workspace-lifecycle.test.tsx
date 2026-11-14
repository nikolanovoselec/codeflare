// Actual card and store outcomes only, not mounted terminal/editor acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@solidjs/testing-library';
import { loadTerminalsFromStorage } from '../../stores/session-tabs';
import type { Terminal } from '@xterm/xterm';
import { terminalStore } from '../../stores/terminal';
import { sessionStore } from '../../stores/session';
import * as api from '../../api/client';
import SessionStatCard from '../../components/SessionStatCard';
import type { Session } from '../../types';

vi.mock('../../api/client', async original => ({
  ...await original<typeof import('../../api/client')>(),
  getSessions: vi.fn(),
  getPreferences: vi.fn(async () => ({ sleepAfter: '30m' as const })),
  getBatchSessionStatus: vi.fn(),
  getSessionAncillaryStatus: vi.fn(async () => ({ maxSessions: 3 })),
}));
vi.mock('../../lib/vault-cache', () => ({
  cleanupSessionVaultCache: async () => undefined,
  sweepOrphanVaultCaches: async () => undefined,
}));

const id = 'abcdef0123456789';
const base: Session = {
  id, name: 'Lifecycle fixture', workspace: 'terminal',
  createdAt: '2026-11-08T00:00:00Z', lastAccessedAt: '2026-11-08T00:00:00Z',
  status: 'running', lifecycle: 'running', generation: 7, revision: 10,
};
async function projection(status: 'running' | 'unreachable' | 'stopping' | 'stopped', revision: number, generation = 7) {
  vi.mocked(api.getBatchSessionStatus).mockResolvedValueOnce({ statuses: {
    [id]: { status, lifecycle: status, generation, revision, editorReady: true },
  } });
  await sessionStore.refreshSessionStatuses();
}
function card() {
  return <SessionStatCard
    session={sessionStore.sessions.find(session => session.id === id)!}
    isActive={true} onSelect={() => {}} onStop={() => {}} onDelete={() => {}}
  />;
}
function stopPolling() {
  sessionStore.stopSessionListPolling();
  sessionStore.stopAllPolling();
}
beforeEach(async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected external I/O in lifecycle test'); });
  stopPolling();
  terminalStore.disposeAll();
  sessionStore._resetMissCounters();
  sessionStore._resetStartupGuards();
  sessionStore._resetManagedCheckState();
  vi.mocked(api.getSessions).mockReset();
  vi.mocked(api.getBatchSessionStatus).mockReset();
  sessionStore.setActiveSession(null);
  vi.mocked(api.getSessions).mockResolvedValue([]);
  vi.mocked(api.getBatchSessionStatus).mockResolvedValue({ statuses: {} });
  await sessionStore.loadSessions();
  vi.mocked(api.getSessions).mockResolvedValue([base]);
  vi.mocked(api.getBatchSessionStatus).mockResolvedValue({ statuses: {
    [id]: { status: 'running', lifecycle: 'running', generation: 7, revision: 10 },
  } });
  await sessionStore.loadSessions();
  sessionStore._resetStartupGuards();
  stopPolling();
});
afterEach(() => {
  cleanup();
  sessionStore.setActiveSession(null);
  stopPolling();
  terminalStore.disposeAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ordered lifecycle presentation through actual card/store owners', () => {
  it('REQ-TERM-045 AC3: local ACTIVE/IDLE never changes persisted workspace or shared lifecycle', async () => {
    vi.useFakeTimers();
    sessionStore.initializeTerminalsForSession(id);
    const persisted = localStorage.getItem('codeflare:terminalsPerSession');
    expect(persisted).not.toBeNull();
    const storedTabs = loadTerminalsFromStorage()[id];
    const shared = { ...sessionStore.sessions.find(session => session.id === id)! };
    // Reuse setup.ts's WebSocket and the terminal store's existing xterm seam.
    // This tests local socket presentation, not a native PTY or xterm buffer.
    const terminal = {
      cols: 80, rows: 24,
      onData: () => ({ dispose: () => {} }),
      write: (_text: string, done?: () => void) => done?.(),
      dispose: () => {},
    } as unknown as Terminal;
    terminalStore.connect(id, '1', terminal);
    await vi.advanceTimersByTimeAsync(0);
    const first = render(card);
    expect(screen.getByRole('status', { name: 'ACTIVE' })).toHaveClass('session-stat-card__dot--success');
    expect(localStorage.getItem('codeflare:terminalsPerSession')).toBe(persisted);
    expect(sessionStore.sessions.find(session => session.id === id)).toEqual(shared);
    terminalStore.disconnect(id, '1');
    expect(screen.getByRole('status', { name: 'IDLE' })).toHaveClass('session-stat-card__dot--idle');
    expect(localStorage.getItem('codeflare:terminalsPerSession')).toBe(persisted);
    expect(sessionStore.sessions.find(session => session.id === id)).toEqual(shared);
    first.unmount();
    // Re-read stored tabs and remount after the socket changed: no old ACTIVE
    // label can be rehydrated from this device's persisted workspace record.
    expect(loadTerminalsFromStorage()[id]).toEqual(storedTabs);
    render(card);
    expect(screen.getByRole('status', { name: 'IDLE' })).toBeInTheDocument();
    expect(localStorage.getItem('codeflare:terminalsPerSession')).toBe(persisted);
    expect(sessionStore.sessions.find(session => session.id === id)).toEqual(shared);
  });

  it('expires the rendered idle timer without inventing stopped lifecycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    await sessionStore.loadPreferences();
    vi.mocked(api.getSessions).mockResolvedValueOnce([{ ...base, lastActiveAt: '2026-11-08T11:30:30Z' }]);
    await sessionStore.loadSessions();
    stopPolling();
    render(card);
    expect(screen.getByTestId(`session-stat-card-${id}-timer`)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(screen.queryByTestId(`session-stat-card-${id}-timer`)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'IDLE' })).toBeInTheDocument();
    expect(sessionStore.sessions.find(session => session.id === id)).toMatchObject({ status: 'running', generation: 7, revision: 10 });
  });

  it('retains rendered UNREACHABLE through a failed read and rejects old stop evidence before recovery', async () => {
    render(card);
    expect(screen.getByRole('status', { name: 'IDLE' })).toBeInTheDocument();
    await projection('unreachable', 11);
    expect(screen.getByRole('status', { name: 'UNREACHABLE' })).toBeInTheDocument();
    vi.mocked(api.getBatchSessionStatus).mockRejectedValueOnce(new Error('D1 unavailable'));
    await sessionStore.refreshSessionStatuses();
    expect(screen.getByRole('status', { name: 'UNREACHABLE' })).toBeInTheDocument();
    expect(sessionStore.statusUnavailable).toBe(true);
    await projection('stopped', 999, 6);
    expect(screen.getByRole('status', { name: 'UNREACHABLE' })).toBeInTheDocument();
    await projection('stopped', 10);
    expect(screen.getByRole('status', { name: 'UNREACHABLE' })).toBeInTheDocument();
    await projection('running', 12);
    expect(screen.getByRole('status', { name: 'IDLE' })).toBeInTheDocument();
    expect(sessionStore.statusUnavailable).toBe(false);
    await projection('stopping', 13);
    expect(screen.getByRole('status', { name: 'STOPPING' })).toBeInTheDocument();
    await projection('stopped', 14);
    expect(screen.getByRole('status', { name: 'STOPPED' })).toBeInTheDocument();
  });
});
