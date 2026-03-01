import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    dispose: vi.fn(),
    disposeSession: vi.fn(),
    triggerLayoutResize: vi.fn(),
  },
  sendInputToTerminal: vi.fn(() => false),
  registerProcessNameCallback: vi.fn(),
}));

vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    STARTUP_POLL_INTERVAL_MS: 1500,
    MAX_STARTUP_POLL_ERRORS: 10,
    MAX_TERMINALS_PER_SESSION: 6,
  };
});

vi.mock('../../api/client', () => ({
  getSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  updateSession: vi.fn(),
  getBatchSessionStatus: vi.fn().mockResolvedValue({ statuses: {}, maxSessions: 3 }),
  getStartupStatus: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  getPresets: vi.fn().mockResolvedValue([]),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  getPreferences: vi.fn().mockResolvedValue({}),
  updatePreferences: vi.fn().mockResolvedValue({}),
  getR2Status: vi.fn().mockResolvedValue({ ready: false }),
  ensureR2Token: vi.fn().mockResolvedValue({ ready: false }),
}));

import { sessionStore } from '../../stores/session';
import * as api from '../../api/client';

const mockGetSessions = vi.mocked(api.getSessions);
const mockGetBatchSessionStatus = vi.mocked(api.getBatchSessionStatus);

/**
 * Tests for session ready detection on page load.
 *
 * loadSessions() uses batch-status from KV to determine which sessions
 * are running vs stopped on initial page load (or refresh). This avoids
 * per-session DO queries which would wake hibernated containers.
 */
describe('Session Ready Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.useFakeTimers();

    mockGetSessions.mockResolvedValue([]);
    mockGetBatchSessionStatus.mockResolvedValue({ statuses: {}, maxSessions: 3 });
    sessionStore._resetMissCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStore.stopAllPolling();
  });

  it('should mark session as running and initialize terminals when batch status reports running', async () => {
    const session = {
      id: 'session-1',
      name: 'Test',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };
    mockGetSessions.mockResolvedValue([session]);
    mockGetBatchSessionStatus.mockResolvedValue({
      statuses: {
        'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' },
      },
      maxSessions: 3,
    });

    await sessionStore.loadSessions();

    const loaded = sessionStore.sessions.find(s => s.id === 'session-1');
    expect(loaded?.status).toBe('running');

    const terminals = sessionStore.getTerminalsForSession('session-1');
    expect(terminals).not.toBeNull();
    expect(terminals!.tabs.length).toBeGreaterThan(0);
  });

  it('should keep session as stopped when batch status reports stopped', async () => {
    const session = {
      id: 'session-1',
      name: 'Test',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };
    mockGetSessions.mockResolvedValue([session]);
    mockGetBatchSessionStatus.mockResolvedValue({
      statuses: {
        'session-1': { status: 'stopped', ptyActive: false },
      },
      maxSessions: 3,
    });

    await sessionStore.loadSessions();

    const loaded = sessionStore.sessions.find(s => s.id === 'session-1');
    expect(loaded?.status).toBe('stopped');
  });

  it('should keep session as stopped when not present in batch status', async () => {
    const session = {
      id: 'session-1',
      name: 'Test',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };
    mockGetSessions.mockResolvedValue([session]);
    mockGetBatchSessionStatus.mockResolvedValue({
      statuses: {},
      maxSessions: 3,
    });

    await sessionStore.loadSessions();

    // Session absent from batch status defaults to stopped (fresh load fallback)
    const loaded = sessionStore.sessions.find(s => s.id === 'session-1');
    expect(loaded?.status).toBe('stopped');
  });
});
