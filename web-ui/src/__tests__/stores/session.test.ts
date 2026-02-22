import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// MOCK-DRIFT RISK: terminalStore is a shallow stub. Real store manages WebSocket
// connections per session/terminal, xterm instances, FitAddon registration, and
// reconnection logic. dispose() in the real store tears down WebSockets and xterm;
// here it's a no-op. sendInputToTerminal writes to the WebSocket in production.
vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    dispose: vi.fn(),
    disposeSession: vi.fn(),
    triggerLayoutResize: vi.fn(),
  },
  sendInputToTerminal: vi.fn(() => false),
  registerProcessNameCallback: vi.fn(),
}));

// MOCK-DRIFT RISK: Overrides polling/timing constants to speed up tests.
// Real values are much larger (e.g. STARTUP_POLL_INTERVAL_MS is ~2000ms).
// Uses importOriginal to preserve non-overridden exports and reduce drift.
vi.mock('../../lib/constants', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    STARTUP_POLL_INTERVAL_MS: 1500,
    MAX_STARTUP_POLL_ERRORS: 10,
    MAX_TERMINALS_PER_SESSION: 6,
  };
});

// MOCK-DRIFT RISK: API client is fully stubbed. Real functions call baseFetch
// which sends HTTP requests with Zod validation, redirect detection, and auth
// headers. Any new API functions added to client.ts must be added here too,
// or tests importing sessionStore will fail with missing exports.
vi.mock('../../api/client', () => ({
  getSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  updateSession: vi.fn(),
  getBatchSessionStatus: vi.fn().mockResolvedValue({}),
  getStartupStatus: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  getPresets: vi.fn().mockResolvedValue([]),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  getPreferences: vi.fn().mockResolvedValue({}),
  updatePreferences: vi.fn().mockResolvedValue({}),
}));

// Import after mocks
import { sessionStore } from '../../stores/session';
import * as api from '../../api/client';
import * as terminal from '../../stores/terminal';

// Get typed mocks
const mockGetSessions = vi.mocked(api.getSessions);
const mockCreateSession = vi.mocked(api.createSession);
const mockDeleteSession = vi.mocked(api.deleteSession);
const mockGetBatchSessionStatus = vi.mocked(api.getBatchSessionStatus);
const mockGetStartupStatus = vi.mocked(api.getStartupStatus);
const mockStopSession = vi.mocked(api.stopSession);
const mockSendInputToTerminal = vi.mocked(terminal.sendInputToTerminal);

describe('Session Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.useFakeTimers();

    // Default mock implementations
    mockGetSessions.mockResolvedValue([]);
    mockGetBatchSessionStatus.mockResolvedValue({});
    mockGetStartupStatus.mockRejectedValue(new Error('Not found'));
    sessionStore._resetMissCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStore.stopAllPolling();
  });

  describe('loadSessions', () => {
    it('should load sessions from API', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          name: 'Test Session 1',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
        {
          id: 'session-2',
          name: 'Test Session 2',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ];
      mockGetSessions.mockResolvedValue(mockSessions);

      await sessionStore.loadSessions();

      expect(sessionStore.sessions.length).toBe(2);
      expect(sessionStore.sessions[0].id).toBe('session-1');
      expect(sessionStore.sessions[1].id).toBe('session-2');
    });

    it('should set loading state during fetch', async () => {
      let resolvePromise: (value: any) => void;
      mockGetSessions.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const loadPromise = sessionStore.loadSessions();
      expect(sessionStore.loading).toBe(true);

      resolvePromise!([]);
      await loadPromise;

      expect(sessionStore.loading).toBe(false);
    });

    it('should set error on API failure', async () => {
      mockGetSessions.mockRejectedValue(new Error('Network error'));

      await sessionStore.loadSessions();

      expect(sessionStore.error).toBe('Network error');
    });

    it('should use batch status endpoint', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ];
      mockGetSessions.mockResolvedValue(mockSessions);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' },
      });
      mockGetStartupStatus.mockResolvedValue({
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          container: 'container-1',
          bucketName: 'test-bucket',
          path: '/workspace',
        },
      });

      await sessionStore.loadSessions();

      expect(mockGetBatchSessionStatus).toHaveBeenCalled();
    });

    it('should recognize running sessions on fresh page load', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          name: 'Running Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ];
      mockGetSessions.mockResolvedValue(mockSessions);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' },
      });

      await sessionStore.loadSessions();

      // On fresh load, batch-status says running → session should be recognized as running
      const session = sessionStore.sessions.find(s => s.id === 'session-1');
      expect(session?.status).toBe('running');
    });

    it('should initialize terminals for sessions already known as running', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          name: 'Running Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ];
      mockGetSessions.mockResolvedValue(mockSessions);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' },
      });
      mockGetStartupStatus.mockResolvedValue({
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          container: 'container-1',
          bucketName: 'test-bucket',
          path: '/workspace',
        },
      });

      // First load — session arrives as 'stopped' (fresh load, no existingStatuses)
      await sessionStore.loadSessions();
      // Simulate user having started the session
      sessionStore.updateSessionStatus('session-1', 'running');
      // Second load — now existingStatuses has 'running', so terminals initialize
      await sessionStore.loadSessions();

      const terminals = sessionStore.getTerminalsForSession('session-1');
      expect(terminals).not.toBeNull();
      expect(terminals!.tabs.length).toBeGreaterThan(0);
    });

    it('should keep already-running sessions running regardless of startupStage', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          name: 'Starting Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ];
      mockGetSessions.mockResolvedValue(mockSessions);
      // Even with startupStage 'verifying', a running container should stay 'running'
      // to avoid Terminal unmount/remount loops
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: false, startupStage: 'verifying' },
      });

      // First load — fresh page, session arrives as 'stopped'
      await sessionStore.loadSessions();
      // Simulate user started this session
      sessionStore.updateSessionStatus('session-1', 'running');
      // Second load — existingStatuses has 'running', so it stays 'running'
      await sessionStore.loadSessions();

      const session = sessionStore.sessions.find((s: { id: string }) => s.id === 'session-1');
      expect(session?.status).toBe('running');
      expect(sessionStore.isSessionInitializing('session-1')).toBe(false);
    });

    it('should discard stale results from concurrent loadSessions calls', async () => {
      let resolveFirst: (value: any) => void;
      let resolveSecond: (value: any) => void;
      mockGetSessions
        .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
        .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
      mockGetBatchSessionStatus.mockResolvedValue({});

      const firstCall = sessionStore.loadSessions();
      const secondCall = sessionStore.loadSessions();

      // Both calls proceed (generation counter allows concurrent calls)
      expect(mockGetSessions).toHaveBeenCalledTimes(2);

      // Resolve second call first (newer generation wins)
      resolveSecond!([{ id: 'session-new', name: 'New', createdAt: 'now', lastAccessedAt: 'now' }]);
      await secondCall;

      // Resolve first call later (stale generation, results discarded)
      resolveFirst!([{ id: 'session-old', name: 'Old', createdAt: 'then', lastAccessedAt: 'then' }]);
      await firstCall;

      // Only the newer generation's sessions should be in state
      expect(sessionStore.sessions.some(s => s.id === 'session-new')).toBe(true);
      expect(sessionStore.sessions.some(s => s.id === 'session-old')).toBe(false);
    });
  });

  describe('createSession', () => {
    it('should create session and add to state', async () => {
      const newSession = {
        id: 'new-session',
        name: 'New Session',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      };
      mockCreateSession.mockResolvedValue(newSession);

      const result = await sessionStore.createSession('New Session');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('new-session');
      expect(sessionStore.sessions.some((s) => s.id === 'new-session')).toBe(true);
    });

    it('should set session status to stopped initially', async () => {
      const newSession = {
        id: 'new-session',
        name: 'New Session',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      };
      mockCreateSession.mockResolvedValue(newSession);

      await sessionStore.createSession('New Session');

      const session = sessionStore.sessions.find((s) => s.id === 'new-session');
      expect(session?.status).toBe('stopped');
    });

    it('should return null on API failure', async () => {
      mockCreateSession.mockRejectedValue(new Error('Create failed'));

      const result = await sessionStore.createSession('New Session');

      expect(result).toBeNull();
      expect(sessionStore.error).toBe('Create failed');
    });
  });

  describe('deleteSession', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      await sessionStore.loadSessions();
    });

    it('should delete session from state', async () => {
      mockDeleteSession.mockResolvedValue(undefined);

      await sessionStore.deleteSession('session-1');

      expect(sessionStore.sessions.some((s) => s.id === 'session-1')).toBe(false);
    });

    it('should clear active session if deleted', async () => {
      mockDeleteSession.mockResolvedValue(undefined);
      sessionStore.setActiveSession('session-1');

      await sessionStore.deleteSession('session-1');

      expect(sessionStore.activeSessionId).toBeNull();
    });

    it('should clean up terminal state', async () => {
      mockDeleteSession.mockResolvedValue(undefined);
      sessionStore.initializeTerminalsForSession('session-1');

      await sessionStore.deleteSession('session-1');

      expect(sessionStore.getTerminalsForSession('session-1')).toBeNull();
    });
  });

  describe('stopSession', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      mockGetBatchSessionStatus.mockResolvedValue({ 'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' } });
      mockGetStartupStatus.mockResolvedValue({
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          container: 'container-1',
          bucketName: 'test-bucket',
          path: '/workspace',
        },
      });
      // First load (fresh) — session arrives as 'stopped'
      await sessionStore.loadSessions();
      // Simulate user started the session
      sessionStore.updateSessionStatus('session-1', 'running');
      sessionStore.initializeTerminalsForSession('session-1');
    });

    it('should set status to stopping immediately then stopped after polling', async () => {
      mockStopSession.mockResolvedValue(undefined);
      // First poll returns 'stopping', second returns 'stopped'
      mockGetBatchSessionStatus
        .mockResolvedValueOnce({ 'session-1': { status: 'stopping' as any, ptyActive: false } })
        .mockResolvedValueOnce({ 'session-1': { status: 'stopped', ptyActive: false } });

      const stopPromise = sessionStore.stopSession('session-1');

      // Immediately after call, status should be 'stopping'
      const sessionImmediate = sessionStore.sessions.find((s) => s.id === 'session-1');
      expect(sessionImmediate?.status).toBe('stopping');

      // Advance timer for polling
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      await stopPromise;

      const session = sessionStore.sessions.find((s) => s.id === 'session-1');
      expect(session?.status).toBe('stopped');
    });

    it('should preserve terminal state (dispose without cleanup)', async () => {
      mockStopSession.mockResolvedValue(undefined);
      mockGetBatchSessionStatus.mockResolvedValue({ 'session-1': { status: 'stopped', ptyActive: false } });

      const stopPromise = sessionStore.stopSession('session-1');
      await vi.advanceTimersByTimeAsync(3000);
      await stopPromise;

      // stopSession disposes WebSockets/xterm but preserves tab structure
      // so tiling layout survives restart. Only deleteSession wipes terminal state.
      expect(sessionStore.getTerminalsForSession('session-1')).not.toBeNull();
    });

    it('should clear initialization state if in progress', async () => {
      mockStopSession.mockResolvedValue(undefined);
      mockGetBatchSessionStatus.mockResolvedValue({ 'session-1': { status: 'stopped', ptyActive: false } });

      // Simulate session being in initializing state
      sessionStore.initializeTerminalsForSession('session-1');

      const stopPromise = sessionStore.stopSession('session-1');
      await vi.advanceTimersByTimeAsync(3000);
      await stopPromise;

      expect(sessionStore.isSessionInitializing('session-1')).toBe(false);
    });
  });

  describe('setActiveSession', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      await sessionStore.loadSessions();
    });

    it('should set active session ID', () => {
      sessionStore.setActiveSession('session-1');

      expect(sessionStore.activeSessionId).toBe('session-1');
    });

    it('should update lastAccessedAt', () => {
      const before = sessionStore.sessions[0].lastAccessedAt;

      // Advance time slightly
      vi.advanceTimersByTime(1000);

      sessionStore.setActiveSession('session-1');

      const after = sessionStore.sessions[0].lastAccessedAt;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it('should allow setting to null', () => {
      sessionStore.setActiveSession('session-1');
      sessionStore.setActiveSession(null);

      expect(sessionStore.activeSessionId).toBeNull();
    });
  });

  describe('clearError', () => {
    it('should clear error state', async () => {
      mockGetSessions.mockRejectedValue(new Error('Test error'));
      await sessionStore.loadSessions();
      expect(sessionStore.error).not.toBeNull();

      sessionStore.clearError();

      expect(sessionStore.error).toBeNull();
    });
  });

  describe('getActiveSession', () => {
    beforeEach(async () => {
      // Clear active session first
      sessionStore.setActiveSession(null);

      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      await sessionStore.loadSessions();
    });

    it('should return active session', () => {
      sessionStore.setActiveSession('session-1');

      const active = sessionStore.getActiveSession();

      expect(active?.id).toBe('session-1');
    });

    it('should return undefined when no active session', () => {
      // Ensure active session is cleared
      sessionStore.setActiveSession(null);

      const active = sessionStore.getActiveSession();

      expect(active).toBeUndefined();
    });
  });

  describe('isSessionInitializing', () => {
    it('should return false for non-initializing session', () => {
      expect(sessionStore.isSessionInitializing('session-1')).toBe(false);
    });
  });

  describe('getInitProgressForSession', () => {
    it('should return null for non-initializing session', () => {
      expect(sessionStore.getInitProgressForSession('session-1')).toBeNull();
    });
  });

  describe('dismissInitProgressForSession', () => {
    it('should clear initialization state for session', async () => {
      // Load a stopped session first so the store knows about it
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      mockGetBatchSessionStatus.mockResolvedValue({ 'session-1': { status: 'stopped', ptyActive: false } });
      await sessionStore.loadSessions();

      // startSession sets initializingSessionIds synchronously before calling the API
      const mockStartSession = vi.mocked(api.startSession);
      mockStartSession.mockReturnValue(() => {}); // cleanup function
      // Don't await — the promise won't resolve since mock callbacks aren't called
      sessionStore.startSession('session-1');

      expect(sessionStore.isSessionInitializing('session-1')).toBe(true);

      sessionStore.dismissInitProgressForSession('session-1');

      expect(sessionStore.isSessionInitializing('session-1')).toBe(false);
    });
  });

  describe('metrics from batch-status', () => {
    beforeEach(async () => {
      // Clear stale polling intervals from previous tests (fake timer reset invalidates handles)
      sessionStore.stopAllPolling();

      // Reset session state so the next loadSessions sees a fresh transition to 'running'
      mockGetSessions.mockResolvedValue([]);
      mockGetBatchSessionStatus.mockResolvedValue({});
      await sessionStore.loadSessions();

      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      mockGetBatchSessionStatus.mockResolvedValue({ 'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' } });

      await sessionStore.loadSessions();
    });

    it('should populate metrics from batch-status during loadSessions', async () => {
      // batch-status returns metrics from KV (pushed by container schedule)
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': {
          status: 'running',
          ptyActive: true,
          metrics: { cpu: '25%', mem: '512MB', hdd: '1.2GB', syncStatus: 'success', updatedAt: '2026-02-20T00:00:00Z' },
        },
      });
      await sessionStore.loadSessions();

      const metrics = sessionStore.getMetricsForSession('session-1');

      expect(metrics).not.toBeNull();
      expect(metrics!.cpu).toBe('25%');
      expect(metrics!.mem).toBe('512MB');
      expect(metrics!.hdd).toBe('1.2GB');
    });

    it('should populate metrics from batch-status during refreshSessionStatuses', async () => {
      // First load sessions
      await sessionStore.loadSessions();

      // Now refresh with updated metrics
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': {
          status: 'running',
          ptyActive: true,
          metrics: { cpu: '80%', mem: '2GB', hdd: '3GB', syncStatus: 'success', updatedAt: '2026-02-20T01:00:00Z' },
        },
      });
      await sessionStore.refreshSessionStatuses();

      const metrics = sessionStore.getMetricsForSession('session-1');
      expect(metrics).not.toBeNull();
      expect(metrics!.cpu).toBe('80%');
      expect(metrics!.mem).toBe('2GB');
    });

    it('stopAllPolling should stop all active startup polling', async () => {
      await sessionStore.loadSessions();
      mockGetStartupStatus.mockClear();

      sessionStore.stopAllPolling();

      await vi.advanceTimersByTimeAsync(5000);

      // No new polls should have happened
      expect(mockGetStartupStatus.mock.calls.length).toBe(0);
    });
  });

  describe('renameSession', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Original Name',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      await sessionStore.loadSessions();
    });

    it('should call API and update local state', async () => {
      const mockUpdateSession = vi.mocked(api.updateSession);
      mockUpdateSession.mockResolvedValue({
        id: 'session-1',
        name: 'New Name',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });

      await sessionStore.renameSession('session-1', 'New Name');

      expect(mockUpdateSession).toHaveBeenCalledWith('session-1', { name: 'New Name' });
      const session = sessionStore.sessions.find((s: { id: string }) => s.id === 'session-1');
      expect(session?.name).toBe('New Name');
    });

    it('should set error on API failure', async () => {
      const mockUpdateSession = vi.mocked(api.updateSession);
      mockUpdateSession.mockRejectedValue(new Error('Rename failed'));

      await sessionStore.renameSession('session-1', 'New Name');

      expect(sessionStore.error).toBe('Rename failed');
    });

    it('should not update state if session not found locally', async () => {
      const mockUpdateSession = vi.mocked(api.updateSession);
      mockUpdateSession.mockResolvedValue({
        id: 'nonexistent',
        name: 'New Name',
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });

      await sessionStore.renameSession('nonexistent', 'New Name');

      // API was still called
      expect(mockUpdateSession).toHaveBeenCalledWith('nonexistent', { name: 'New Name' });
      // Original session unchanged
      const session = sessionStore.sessions.find((s: { id: string }) => s.id === 'session-1');
      expect(session?.name).toBe('Original Name');
    });
  });

  describe('bookmarks', () => {
    it('saveBookmarkForSession should capture ordered tabs 2-6 and infer commands from live process', async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Bookmark Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
          tabConfig: [{ id: '1', command: 'claude', label: 'claude' }],
        },
      ]);
      await sessionStore.loadSessions();
      sessionStore.initializeTerminalsForSession('session-1');
      sessionStore.addTerminalTab('session-1'); // tab 2
      sessionStore.addTerminalTab('session-1'); // tab 3
      sessionStore.reorderTerminalTabs('session-1', ['1', '3', '2']);
      sessionStore.updateTerminalLabel('session-1', '2', 'yazi');
      sessionStore.updateTerminalLabel('session-1', '3', 'lazygit');

      const mockSavePreset = vi.mocked(api.savePreset);
      mockSavePreset.mockResolvedValue({
        id: 'preset-1',
        name: 'Dev Tools',
        tabs: [
          { id: '3', command: 'lazygit', label: 'lazygit' },
          { id: '2', command: 'yazi', label: 'yazi' },
        ],
        createdAt: new Date().toISOString(),
      });

      await sessionStore.saveBookmarkForSession('session-1', '  Dev Tools  ');

      expect(mockSavePreset).toHaveBeenCalledWith({
        name: 'Dev Tools',
        tabs: [
          { id: '3', command: 'lazygit', label: 'lazygit' },
          { id: '2', command: 'yazi', label: 'yazi' },
        ],
      });
    });

    it('applyPresetToSession should apply tab order, persist tabConfig, and auto-launch commands', async () => {
      const now = new Date().toISOString();
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Bookmark Session',
          createdAt: now,
          lastAccessedAt: now,
          tabConfig: [{ id: '1', command: 'claude', label: 'claude' }],
        },
      ]);
      await sessionStore.loadSessions();
      sessionStore.initializeTerminalsForSession('session-1');
      sessionStore.addTerminalTab('session-1'); // tab 2
      sessionStore.addTerminalTab('session-1'); // tab 3
      sessionStore.addTerminalTab('session-1'); // tab 4 (removed by preset apply)

      const preset = {
        id: 'preset-1',
        name: 'Workspace Tools',
        createdAt: now,
        tabs: [
          { id: '2', command: 'yazi', label: 'yazi' },
          { id: '3', command: 'lazygit', label: 'lazygit' },
        ],
      };
      vi.mocked(api.getPresets).mockResolvedValue([preset]);
      await sessionStore.loadPresets();

      vi.mocked(api.updateSession).mockResolvedValue({
        id: 'session-1',
        name: 'Bookmark Session',
        createdAt: now,
        lastAccessedAt: now,
        tabConfig: [
          { id: '1', command: 'claude', label: 'claude' },
          { id: '2', command: 'yazi', label: 'yazi' },
          { id: '3', command: 'lazygit', label: 'lazygit' },
        ],
      });
      mockSendInputToTerminal.mockReturnValue(true);

      const applied = await sessionStore.applyPresetToSession('session-1', 'preset-1');

      expect(applied).toBe(true);
      expect(terminal.terminalStore.dispose).toHaveBeenCalledWith('session-1', '4');
      expect(vi.mocked(api.updateSession)).toHaveBeenCalledWith('session-1', {
        tabConfig: [
          { id: '1', command: 'claude', label: 'claude' },
          { id: '2', command: 'yazi', label: 'yazi' },
          { id: '3', command: 'lazygit', label: 'lazygit' },
        ],
      });
      expect(mockSendInputToTerminal).toHaveBeenCalledWith('session-1', '2', 'yazi\n');
      expect(mockSendInputToTerminal).toHaveBeenCalledWith('session-1', '3', 'lazygit\n');

      const terminals = sessionStore.getTerminalsForSession('session-1');
      expect(terminals?.tabOrder).toEqual(['1', '2', '3']);
      expect(terminals?.tabs.map((tab) => tab.id)).toEqual(['1', '2', '3']);
    });
  });

  describe('tab invariants', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Immutable Tab Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      await sessionStore.loadSessions();
      sessionStore.initializeTerminalsForSession('session-1');
      sessionStore.addTerminalTab('session-1'); // tab 2
    });

    it('removeTerminalTab should reject removing tab 1', () => {
      const before = sessionStore.getTerminalsForSession('session-1');
      const beforeIds = before?.tabs.map((tab) => tab.id) || [];
      const beforeOrder = before?.tabOrder || [];

      const removed = sessionStore.removeTerminalTab('session-1', '1');

      expect(removed).toBe(false);
      expect(terminal.terminalStore.dispose).not.toHaveBeenCalledWith('session-1', '1');

      const after = sessionStore.getTerminalsForSession('session-1');
      expect(after?.tabs.map((tab) => tab.id)).toEqual(beforeIds);
      expect(after?.tabOrder).toEqual(beforeOrder);
    });
  });

  describe('refreshSessionStatuses consecutive-miss threshold', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'stopped', ptyActive: false },
      });
      await sessionStore.loadSessions();
    });

    it('should not remove session after 1 miss', async () => {
      // Session missing from batch status
      mockGetBatchSessionStatus.mockResolvedValue({});

      await sessionStore.refreshSessionStatuses();

      expect(sessionStore.sessions.some(s => s.id === 'session-1')).toBe(true);
    });

    it('should not remove session after 2 misses', async () => {
      mockGetBatchSessionStatus.mockResolvedValue({});

      await sessionStore.refreshSessionStatuses();
      await sessionStore.refreshSessionStatuses();

      expect(sessionStore.sessions.some(s => s.id === 'session-1')).toBe(true);
    });

    it('should remove session after 3 consecutive misses', async () => {
      mockGetBatchSessionStatus.mockResolvedValue({});

      await sessionStore.refreshSessionStatuses();
      await sessionStore.refreshSessionStatuses();
      await sessionStore.refreshSessionStatuses();

      expect(sessionStore.sessions.some(s => s.id === 'session-1')).toBe(false);
    });

    it('should reset miss counter when session reappears', async () => {
      // Miss once
      mockGetBatchSessionStatus.mockResolvedValue({});
      await sessionStore.refreshSessionStatuses();

      // Miss twice
      await sessionStore.refreshSessionStatuses();

      // Reappear — counter resets
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'stopped', ptyActive: false },
      });
      await sessionStore.refreshSessionStatuses();

      // Miss again — should survive (counter reset to 0, now at 1)
      mockGetBatchSessionStatus.mockResolvedValue({});
      await sessionStore.refreshSessionStatuses();
      await sessionStore.refreshSessionStatuses();

      expect(sessionStore.sessions.some(s => s.id === 'session-1')).toBe(true);

      // Third miss after reset — now removed
      await sessionStore.refreshSessionStatuses();
      expect(sessionStore.sessions.some(s => s.id === 'session-1')).toBe(false);
    });
  });

  describe('updateSessionStatus does not start metrics polling', () => {
    beforeEach(async () => {
      mockGetSessions.mockResolvedValue([
        {
          id: 'session-1',
          name: 'Test Session',
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString(),
        },
      ]);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'stopped', ptyActive: false },
      });
      await sessionStore.loadSessions();
    });

    it('should not start metrics polling when setting status to running', async () => {
      mockGetStartupStatus.mockClear();

      sessionStore.updateSessionStatus('session-1', 'running');

      // Advance time — no polling should have started
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockGetStartupStatus).not.toHaveBeenCalled();
    });

    it('should stop metrics polling when setting status to stopped', async () => {
      // Manually start metrics polling first
      sessionStore.initializeTerminalsForSession('session-1');
      mockGetStartupStatus.mockResolvedValue({
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          container: 'container-1',
          bucketName: 'test-bucket',
          path: '/workspace',
          cpu: '5%',
          mem: '256MB',
        },
      });

      // loadSessions with running status starts polling via initializeTerminalsForSession path
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, startupStage: 'ready' },
      });
      await sessionStore.loadSessions();

      mockGetStartupStatus.mockClear();

      // Setting to stopped should stop polling
      sessionStore.updateSessionStatus('session-1', 'stopped');

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockGetStartupStatus).not.toHaveBeenCalled();
    });
  });

  describe('KV-pushed metrics', () => {
    it('should populate sessionMetrics from batch-status metrics during refresh', async () => {
      mockGetSessions.mockResolvedValue([{
        id: 'session-1', name: 'Test', createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      }]);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, metrics: { cpu: '25%', mem: '512MB', hdd: '1.2GB', syncStatus: 'success' } },
      });
      await sessionStore.loadSessions();

      const metrics = sessionStore.getMetricsForSession('session-1');
      expect(metrics).toBeTruthy();
      expect(metrics?.cpu).toBe('25%');
      expect(metrics?.mem).toBe('512MB');
      expect(metrics?.hdd).toBe('1.2GB');
    });

    it('should populate sessionMetrics via loadSessions from batch-status', async () => {
      mockGetSessions.mockResolvedValue([{
        id: 'session-1', name: 'Test', createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      }]);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'stopped', ptyActive: false, metrics: { cpu: '10%', mem: '128MB', hdd: '500MB', syncStatus: 'syncing' } },
      });

      await sessionStore.loadSessions();

      const metrics = sessionStore.getMetricsForSession('session-1');
      expect(metrics).toBeTruthy();
      expect(metrics?.cpu).toBe('10%');
      expect(metrics?.mem).toBe('128MB');
      expect(metrics?.hdd).toBe('500MB');
    });

    it('should update metrics on subsequent refreshSessionStatuses polls', async () => {
      mockGetSessions.mockResolvedValue([{
        id: 'session-1', name: 'Test', createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(),
      }]);
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, metrics: { cpu: '10%', mem: '256MB', hdd: '1GB', syncStatus: 'success' } },
      });
      await sessionStore.loadSessions();

      // Verify initial metrics
      expect(sessionStore.getMetricsForSession('session-1')?.cpu).toBe('10%');

      // Update batch-status with new metrics
      mockGetBatchSessionStatus.mockResolvedValue({
        'session-1': { status: 'running', ptyActive: true, metrics: { cpu: '75%', mem: '1024MB', hdd: '2GB', syncStatus: 'success' } },
      });
      await sessionStore.refreshSessionStatuses();

      // Verify updated metrics
      const metrics = sessionStore.getMetricsForSession('session-1');
      expect(metrics?.cpu).toBe('75%');
      expect(metrics?.mem).toBe('1024MB');
      expect(metrics?.hdd).toBe('2GB');
    });
  });

  describe('localStorage persistence', () => {
    it('should persist terminal state to localStorage', () => {
      // Use a unique session ID to avoid conflicts
      const uniqueSessionId = `session-persist-${Date.now()}`;
      sessionStore.initializeTerminalsForSession(uniqueSessionId);

      const stored = localStorage.getItem('codeflare:terminalsPerSession');
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed[uniqueSessionId]).toBeDefined();

      // Cleanup
      sessionStore.cleanupTerminalsForSession(uniqueSessionId);
    });

    it('should restore terminal state from localStorage on store initialization', () => {
      // Use a unique session ID
      const uniqueSessionId = `session-restore-${Date.now()}`;

      // Pre-populate localStorage
      const mockState = {
        [uniqueSessionId]: {
          tabs: [{ id: '1', createdAt: new Date().toISOString() }],
          activeTabId: '1',
          tabOrder: ['1'],
          tiling: { enabled: false, layout: 'tabbed' },
        },
      };
      localStorage.setItem('codeflare:terminalsPerSession', JSON.stringify(mockState));

      // Re-initialize the session
      sessionStore.initializeTerminalsForSession(uniqueSessionId);

      const terminals = sessionStore.getTerminalsForSession(uniqueSessionId);
      expect(terminals).not.toBeNull();

      // Cleanup
      sessionStore.cleanupTerminalsForSession(uniqueSessionId);
    });

    it('should restore tab 1 if persisted state is missing it', () => {
      const uniqueSessionId = `session-missing-tab1-${Date.now()}`;
      const mockState = {
        [uniqueSessionId]: {
          tabs: [{ id: '2', createdAt: new Date().toISOString() }],
          activeTabId: '2',
          tabOrder: ['2'],
          tiling: { enabled: false, layout: 'tabbed' },
        },
      };
      localStorage.setItem('codeflare:terminalsPerSession', JSON.stringify(mockState));

      sessionStore.initializeTerminalsForSession(uniqueSessionId);

      const terminals = sessionStore.getTerminalsForSession(uniqueSessionId);
      expect(terminals).not.toBeNull();
      expect(terminals!.tabs.map((tab) => tab.id)).toEqual(['1', '2']);
      expect(terminals!.tabOrder).toEqual(['1', '2']);
      expect(terminals!.activeTabId).toBe('2');

      sessionStore.cleanupTerminalsForSession(uniqueSessionId);
    });
  });
});
