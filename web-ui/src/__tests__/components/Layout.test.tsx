import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { SessionWithStatus } from '../../types';

// Mock all child components to isolate Layout testing
vi.mock('../../components/Header', () => ({
  default: (props: any) => {
    // Store props on window for inspection in tests (CF-075 vault gating).
    (window as any).__headerProps = props;
    return <header data-testid="header" />;
  }
}));

vi.mock('../../components/TerminalArea', () => ({
  default: (props: any) => {
    // Store props on window for inspection in tests
    (window as any).__terminalAreaProps = props;
    return (
      <main data-testid="terminal-area">
        Terminal Area
      </main>
    );
  }
}));

vi.mock('../../components/SplashCursor', () => ({
  default: () => <div data-testid="splash-cursor" />
}));

vi.mock('../../components/SettingsPanel', () => ({
  default: (_props: any) => <div data-testid="settings-panel" />
}));

vi.mock('../../components/StoragePanel', () => ({
  default: (_props: any) => <div data-testid="storage-panel" />
}));

const vaultProbeMock = vi.hoisted(() => ({
  start: vi.fn(),
  latestOptions: null as any,
  cancel: vi.fn(),
}));

vi.mock('../../lib/vault-readiness', () => ({
  startVaultReadinessProbe: (opts: any) => {
    vaultProbeMock.latestOptions = opts;
    vaultProbeMock.start(opts);
    return vaultProbeMock.cancel;
  },
}));

const vaultPrewarmMock = vi.hoisted(() => ({
  start: vi.fn(),
  latestOptions: null as any,
  cancel: vi.fn(),
}));

vi.mock('../../lib/vault-prewarm', () => ({
  DEFAULT_VAULT_PREWARM_TIMEOUT_MS: 300000,
  startVaultPrewarm: (opts: any) => {
    vaultPrewarmMock.latestOptions = opts;
    vaultPrewarmMock.start(opts);
    return { cancel: vaultPrewarmMock.cancel, prewarmId: 'test-prewarm', iframe: document.createElement('iframe') };
  },
}));

const vaultLocalReadinessMock = vi.hoisted(() => ({
  check: vi.fn(async (_sessionId?: string) => ({ ready: true, recordedDbs: ['sb_data_a', 'sb_files_b'], hasIndexedDbDatabasesApi: true } as any)),
  keyRecoverable: vi.fn(async (_sessionId?: string) => true),
}));

vi.mock('../../lib/vault-local-readiness', () => ({
  checkVaultLocalReadiness: (sessionId: string) => vaultLocalReadinessMock.check(sessionId),
  checkVaultKeyRecoverable: (sessionId: string) => vaultLocalReadinessMock.keyRecoverable(sessionId),
}));

const vaultPrewarmProof = {
  ready: true,
  recordedDbs: ['sb_data_a', 'sb_files_b'],
  hasIndexedDbDatabasesApi: true,
  contentReady: true,
  spaceSyncCompleted: true,
  indexReady: true,
  requiredFiles: ['CONFIG.md', 'Index.md', 'STYLES.md'],
  listedFileCount: 42,
};

// Session store mock with controllable state.
// Module-level variables allow tests to set up specific states before rendering.
let mockSessions: any[] = [];
let mockActiveSessionId: string | null = null;
let mockPreferences: Record<string, any> = {};
let mockVisiblePanes: Array<{ sessionId: string; terminalId: string }> = [];
let mockTerminalsForSession: any = null;
let mockTilingForSession: any = null;
let mockTabOrder: string[] = [];
let mockSaasMode = false;
let mockActiveWorkspace: { kind: 'dashboard' } | { kind: 'session'; sessionId: string } | { kind: 'multiview'; id: 'multiview:1' } = { kind: 'dashboard' };
let readSessionStoreVersion = () => 0;
let bumpSessionStoreVersion = () => {};

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() { readSessionStoreVersion(); return mockSessions; },
    get activeSessionId() { readSessionStoreVersion(); return mockActiveSessionId; },
    get saasMode() { readSessionStoreVersion(); return mockSaasMode; },
    get error() { return null; },
    get loading() { return false; },
    loadSessions: vi.fn(),
    setActiveSession: vi.fn((id: string | null) => { mockActiveSessionId = id; bumpSessionStoreVersion(); }),
    getActiveSession: vi.fn(() => {
      if (!mockActiveSessionId) return null;
      return mockSessions.find((s: any) => s.id === mockActiveSessionId) || null;
    }),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    deleteSession: vi.fn(),
    createSession: vi.fn(),
    dismissInitProgressForSession: vi.fn(),
    clearError: vi.fn(),
    isSessionInitializing: vi.fn(() => false),
    getInitProgressForSession: vi.fn(() => null),
    getMetricsForSession: vi.fn(() => null),
    stopAllPolling: vi.fn(),
    getTerminalsForSession: vi.fn(() => mockTerminalsForSession),
    initializeTerminalsForSession: vi.fn(),
    addTerminalTab: vi.fn(),
    removeTerminalTab: vi.fn(),
    setActiveTerminalTab: vi.fn(),
    cleanupTerminalsForSession: vi.fn(),
    reorderTerminalTabs: vi.fn(),
    setTilingLayout: vi.fn(),
    getTilingForSession: vi.fn(() => mockTilingForSession),
    getTabOrder: vi.fn(() => mockTabOrder),
    renameSession: vi.fn(),
    loadPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    loadPresets: vi.fn(),
    startSessionListPolling: vi.fn(),
    stopSessionListPolling: vi.fn(),
    presets: [],
    get preferences() { readSessionStoreVersion(); return mockPreferences; },
  },
  getUsageWarningLevel: vi.fn(() => 'none'),
  isAtUsageQuota: vi.fn(() => false),
  setUsageState: vi.fn(),
  getDismissedQuotaLevel: vi.fn(() => null),
  setDismissedQuotaLevel: vi.fn(),
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: { reconnect: vi.fn(), triggerLayoutResize: vi.fn() },
  reconnectDisconnectedTerminals: vi.fn(),
  reconnectOnVisibilityReturn: vi.fn(),
  scheduleDisconnect: vi.fn(),
  cancelScheduledDisconnect: vi.fn(),
}));

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    getActiveWorkspace: vi.fn(() => mockActiveWorkspace),
    getVisiblePanes: vi.fn(() => mockVisiblePanes),
    setDashboardWorkspace: vi.fn(() => { mockActiveWorkspace = { kind: 'dashboard' }; mockVisiblePanes = []; bumpSessionStoreVersion(); }),
    setSingleSessionWorkspace: vi.fn((sessionId: string, terminalId = '1') => {
      mockActiveWorkspace = { kind: 'session', sessionId };
      mockVisiblePanes = [{ sessionId, terminalId }];
      bumpSessionStoreVersion();
    }),
    openMultiView: vi.fn(() => {
      mockActiveWorkspace = { kind: 'multiview', id: 'multiview:1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }, { sessionId: 'sess2', terminalId: '1' }];
      bumpSessionStoreVersion();
      return true;
    }),
    closeMultiView: vi.fn(() => {
      mockActiveWorkspace = { kind: 'dashboard' };
      mockVisiblePanes = [];
      bumpSessionStoreVersion();
    }),
  },
}));

let mockIsSamsungBrowser = false;
vi.mock('../../lib/mobile', () => ({
  forceResetKeyboardState: vi.fn(),
  enableVirtualKeyboardOverlay: vi.fn(),
  cleanupDebugOverlay: vi.fn(),
  get isSamsungBrowser() { return mockIsSamsungBrowser; },
}));

import { forceResetKeyboardState } from '../../lib/mobile';
import { reconnectDisconnectedTerminals, reconnectOnVisibilityReturn } from '../../stores/terminal';
import { getUsageWarningLevel, getDismissedQuotaLevel, setDismissedQuotaLevel } from '../../stores/session';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';
import Layout, { clearPrewarmingVaultStatus } from '../../components/Layout';

// Helper to create a mock session
function createMockSession(overrides: Partial<any> = {}) {
  return {
    id: 'sess1',
    name: 'Test Session',
    createdAt: '2024-01-15T10:00:00Z',
    lastAccessedAt: '2024-01-15T12:00:00Z',
    status: 'running',
    ...overrides,
  };
}

describe('Layout Component / REQ-AUTH-014 (session expiry handling on 401)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions = [];
    mockActiveSessionId = null;
    mockPreferences = {};
    mockVisiblePanes = [];
    mockTerminalsForSession = null;
    mockTilingForSession = null;
    mockTabOrder = [];
    mockActiveWorkspace = { kind: 'dashboard' };
    mockSaasMode = false;
    const [sessionStoreVersion, setSessionStoreVersion] = createSignal(0);
    readSessionStoreVersion = sessionStoreVersion;
    bumpSessionStoreVersion = () => setSessionStoreVersion((value) => value + 1);
    mockIsSamsungBrowser = false;
    vaultProbeMock.start.mockClear();
    vaultProbeMock.cancel.mockClear();
    vaultProbeMock.latestOptions = null;
    vaultPrewarmMock.start.mockClear();
    vaultPrewarmMock.cancel.mockClear();
    vaultPrewarmMock.latestOptions = null;
    vaultLocalReadinessMock.check.mockClear();
    vaultLocalReadinessMock.check.mockResolvedValue({ ready: true, recordedDbs: ['sb_data_a', 'sb_files_b'], hasIndexedDbDatabasesApi: true });
    vaultLocalReadinessMock.keyRecoverable.mockClear();
    vaultLocalReadinessMock.keyRecoverable.mockResolvedValue(true);
    delete (window as any).__terminalAreaProps;
    delete (window as any).__headerProps;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // =========================================================================
  // Structure Tests
  // =========================================================================

  describe('Default Rendering', () => {
    it('renders the layout container', () => {
      render(() => <Layout />);

      const layout = document.querySelector('.layout');
      expect(layout).toBeInTheDocument();
    });

    it('renders TerminalArea component', () => {
      render(() => <Layout />);

      expect(screen.getByTestId('terminal-area')).toBeInTheDocument();
    });

    it('renders SettingsPanel component', () => {
      render(() => <Layout />);

      expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    });

    it('renders StoragePanel component as sibling of SettingsPanel', () => {
      render(() => <Layout />);

      expect(screen.getByTestId('storage-panel')).toBeInTheDocument();
      // Both should be siblings in the layout
      const settingsPanel = screen.getByTestId('settings-panel');
      const storagePanel = screen.getByTestId('storage-panel');
      expect(settingsPanel.parentElement).toBe(storagePanel.parentElement);
    });

    it('does NOT render AppSidebar', () => {
      render(() => <Layout />);

      expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Header Visibility
  //
  // After the viewState update:
  // - Header is shown when viewState is 'terminal' or 'expanding'
  // - Header is hidden when viewState is 'dashboard' or 'collapsing'
  //
  // Since viewState is derived from whether an active running/initializing
  // session exists, we test via session state.
  // =========================================================================

  describe('Header Visibility', () => {
    it('renders Header when viewState is terminal (active session exists)', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout />);

      expect(screen.getByTestId('header')).toBeInTheDocument();
    });

    it('does NOT render Header when viewState is dashboard (no active session)', () => {
      render(() => <Layout />);

      const header = screen.queryByTestId('header');
      expect(header).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // CF-075 // REQ-VAULT-012 / REQ-VAULT-018: advanced-mode affordance + readiness gates.
  //
  // The Header renders its vault button only when it receives an onVaultOpen
  // prop. Layout passes onVaultOpen only when there is an active session AND
  // the session mode is 'advanced' (sessionStore.preferences.sessionMode).
  // In default mode the prop is undefined, so the button never renders.
  // We assert the gating by inspecting the prop Layout hands to Header.
  // =========================================================================

  describe('Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)', () => {
    it('does NOT pass onVaultOpen (vault button hidden) when active session is default mode', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'default' };

      render(() => <Layout />);

      expect((window as any).__headerProps.onVaultOpen).toBeUndefined();
    });

    it('does NOT pass onVaultOpen when mode is unset (defaults to non-advanced)', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = {};

      render(() => <Layout />);

      expect((window as any).__headerProps.onVaultOpen).toBeUndefined();
    });

    it('passes onVaultOpen (vault button shown) when active session is advanced mode', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);

      expect(typeof (window as any).__headerProps.onVaultOpen).toBe('function');
    });

    it('keeps Header vaultReady false until browser prewarm reports ready', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);

      expect(vaultPrewarmMock.start).not.toHaveBeenCalled();
      expect((window as any).__headerProps.vaultReady).toBe(false);
      vaultProbeMock.latestOptions.setLatch();

      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
      expect((window as any).__headerProps.vaultStatus).toBe('prewarming');
      expect((window as any).__headerProps.vaultReady).toBe(false);

      vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
      await waitFor(() => expect((window as any).__headerProps.vaultReady).toBe(true));
      expect((window as any).__headerProps.vaultStatus).toBe('ready');
    });

    it('REQ-VAULT-020: starts browser prewarm even when terminal input is focused', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const input = document.createElement('textarea');
      input.className = 'xterm-helper-textarea';
      document.body.append(input);
      input.focus();

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();

      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
      expect(document.activeElement).toBe(input);
      expect((window as any).__headerProps.vaultStatus).toBe('prewarming');
    });

    it('REQ-VAULT-019: rechecks this browser cache before opening the Vault tab', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultReady).toBe(true));

        await (window as any).__headerProps.onVaultOpen();

        expect(vaultLocalReadinessMock.check).toHaveBeenCalledWith('sess1');
        // Key recoverability is verified before opening (the open-time guard).
        expect(vaultLocalReadinessMock.keyRecoverable).toHaveBeenCalledWith('sess1');
        expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/', '_blank', 'noopener');
      } finally {
        openSpy.mockRestore();
      }
    });

    it('enters preparing + restarts prewarm instead of opening when local Vault DB proof disappeared', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      vaultLocalReadinessMock.check.mockResolvedValue({
        ready: false,
        reason: 'missing-idb-database',
        recordedDbs: ['sb_data_a', 'sb_files_b'],
        hasIndexedDbDatabasesApi: true,
      });
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultReady).toBe(true));

        await (window as any).__headerProps.onVaultOpen();

        expect(openSpy).not.toHaveBeenCalled();
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(2));
        expect((window as any).__headerProps.vaultReady).toBe(false);
        // The button breathes accent ('preparing') instead of opening into .auth.
        expect((window as any).__headerProps.vaultStatus).toBe('preparing');
      } finally {
        openSpy.mockRestore();
      }
    });

    it('breathes preparing -> armed when the key becomes recoverable, then opens on the next click', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      // Local DBs are present; only the encryption key is not recoverable yet on
      // the first click, then becomes recoverable (the post-prewarm key flush).
      vaultLocalReadinessMock.keyRecoverable.mockResolvedValueOnce(false).mockResolvedValue(true);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultReady).toBe(true));

        // First click: key not recoverable -> preparing (breathe accent), no open.
        await (window as any).__headerProps.onVaultOpen();
        expect(openSpy).not.toHaveBeenCalled();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('preparing'));

        // The poll re-checks and arms once the key is recoverable (breathe green).
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        // Click on the armed (green) button opens the vault tab synchronously.
        await (window as any).__headerProps.onVaultOpen();
        expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/', '_blank', 'noopener');
      } finally {
        openSpy.mockRestore();
      }
    });

    it('keeps Header vaultReady false when browser prewarm times out', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();

      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
      vaultPrewarmMock.latestOptions.onError('timeout', 'slow index');

      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('timeout'));
      expect((window as any).__headerProps.vaultReady).toBe(false);
    });

    it('retries browser prewarm after a timeout without enabling Vault early', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();

      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));

      vi.useFakeTimers();
      try {
        vaultPrewarmMock.latestOptions.onError('timeout', 'slow index');
        await Promise.resolve();
        expect((window as any).__headerProps.vaultReady).toBe(false);
        expect((window as any).__headerProps.vaultStatus).toBe('timeout');

        await vi.advanceTimersByTimeAsync(9999);
        expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(2);
        expect((window as any).__headerProps.vaultReady).toBe(false);
        expect((window as any).__headerProps.vaultStatus).toBe('prewarming');
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels an in-flight browser prewarm when Layout unmounts', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      const { unmount } = render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());

      unmount();
      expect(vaultPrewarmMock.cancel).toHaveBeenCalled();
    });

    it('clearPrewarmingVaultStatus removes only stale in-flight prewarm state', () => {
      const before = {
        sess1: 'prewarming' as const,
        sess2: 'ready' as const,
      };

      expect(clearPrewarmingVaultStatus(before, 'sess1')).toEqual({ sess2: 'ready' });
      expect(clearPrewarmingVaultStatus(before, 'sess2')).toBe(before);
    });

    it('starts a fresh prewarm when the user returns after leaving mid-prewarm', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));

      mockActiveSessionId = null;
      bumpSessionStoreVersion();
      await waitFor(() => expect(vaultPrewarmMock.cancel).toHaveBeenCalled());

      mockActiveSessionId = 'sess1';
      bumpSessionStoreVersion();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(2));
      expect((window as any).__headerProps.vaultReady).toBe(false);
      expect((window as any).__headerProps.vaultStatus).toBe('prewarming');
    });

    it('does NOT pass onVaultOpen in advanced mode when there is no active session', () => {
      mockActiveSessionId = null;
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);

      // No active session => dashboard view => Header not rendered at all,
      // so onVaultOpen is never provided regardless of mode.
      expect((window as any).__headerProps?.onVaultOpen).toBeUndefined();
    });
  });

  // =========================================================================
  // SplashCursor at Layout Level
  //
  // After the update, SplashCursor moves from Dashboard to Layout.
  // It renders viewport-wide, behind everything, with a fading class
  // when transitioning to terminal view.
  // =========================================================================

  describe('SplashCursor', () => {
    it('renders SplashCursor at layout level', () => {
      render(() => <Layout />);

      // SplashCursor is rendered by Layout as a direct child of .layout
      // so it covers the entire viewport including the header area.
      const splashCursor = screen.queryByTestId('splash-cursor');
      expect(splashCursor).toBeInTheDocument();
      expect(document.querySelector('.layout')).toBeInTheDocument();
    });

    it('renders SplashCursor with a parent element when in terminal view', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout />);

      const splashCursor = screen.queryByTestId('splash-cursor');
      expect(splashCursor).toBeInTheDocument();
      // SplashCursor should be wrapped in a container element
      expect(splashCursor!.parentElement).toBeInstanceOf(HTMLElement);
    });

    it('removes fading class when in dashboard view', () => {
      // No active session => dashboard view
      render(() => <Layout />);

      const splashCursor = screen.queryByTestId('splash-cursor');
      if (splashCursor && splashCursor.parentElement) {
        expect(
          splashCursor.parentElement.classList.contains('splash-cursor-container--fading')
        ).toBe(false);
      }
    });
  });

  // =========================================================================
  // ViewState and TerminalArea Props
  //
  // The viewState machine transitions:
  //   dashboard -> expanding -> terminal -> collapsing -> dashboard
  //
  // viewState is passed to TerminalArea as a prop. We capture TerminalArea
  // props via the window.__terminalAreaProps spy set up in the mock.
  // =========================================================================

  describe('ViewState and TerminalArea Props', () => {
    it('passes showTerminal=false to TerminalArea when no active session', () => {
      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(props.showTerminal).toBe(false);
      expect(props.viewState).toBe('dashboard');
    });

    it('passes showTerminal=true to TerminalArea when active running session exists', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(props.showTerminal).toBe(true);
      expect(props.viewState).toBe('terminal');
    });

    it('passes showTerminal=true when active session is initializing', () => {
      mockSessions = [createMockSession({ status: 'initializing' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(props.showTerminal).toBe(true);
      expect(props.viewState).toBe('terminal');
    });

    it('passes showTerminal=false when active session is stopped', () => {
      mockSessions = [createMockSession({ status: 'stopped' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(props).toBeDefined();
      expect(props.showTerminal).toBe(false);
    });

    it('passes viewState to TerminalArea as a string', () => {
      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(typeof props.viewState).toBe('string');
    });

    it('passes error prop combining store error and terminal error', () => {
      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(props).toBeDefined();
      expect(props.error).toBeFalsy();
    });

    it('passes tiling-related callbacks as functions to TerminalArea', () => {
      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(typeof props.onTilingButtonClick).toBe('function');
      expect(typeof props.onSelectTilingLayout).toBe('function');
      expect(typeof props.onCloseTilingOverlay).toBe('function');
      expect(typeof props.onTileClick).toBe('function');
    });

    it('passes session lifecycle callbacks as functions to TerminalArea', () => {
      render(() => <Layout />);

      const props = (window as any).__terminalAreaProps;
      expect(typeof props.onOpenSessionById).toBe('function');
      expect(typeof props.onCreateSession).toBe('function');
      expect(typeof props.onStartSession).toBe('function');
      expect(typeof props.onDismissError).toBe('function');
    });
  });

  // =========================================================================
  // Terminal workspace transitions
  // =========================================================================

  describe('Terminal workspace transitions / REQ-TERM-011 through REQ-TERM-013', () => {
    it('REQ-TERM-012: activates MultiView from the header callback', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' }), createMockSession({ id: 'sess2', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onOpenMultiView).toBeTypeOf('function'));

      (window as any).__headerProps.onOpenMultiView();

      expect(terminalWorkspaceStore.openMultiView).toHaveBeenCalledTimes(1);
      expect(sessionStore.setActiveSession).toHaveBeenCalledWith(null);
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
    });

    it('REQ-TERM-012: deactivates MultiView through the Layout-owned header callback', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' }), createMockSession({ id: 'sess2', status: 'running' })];
      mockActiveSessionId = null;
      mockActiveWorkspace = { kind: 'multiview', id: 'multiview:1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }, { sessionId: 'sess2', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onCloseMultiView).toBeTypeOf('function'));

      (window as any).__headerProps.onCloseMultiView();

      expect(terminalWorkspaceStore.closeMultiView).toHaveBeenCalledTimes(1);
      expect(sessionStore.setActiveSession).toHaveBeenCalledWith(null);
      await waitFor(() => expect((window as any).__terminalAreaProps.showTerminal).toBe(false));
      expect((window as any).__terminalAreaProps.viewState).toBe('dashboard');
    });

    it('REQ-TERM-011: selecting a running session while in MultiView opens a single-session workspace', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' }), createMockSession({ id: 'sess2', status: 'running' })];
      mockActiveSessionId = null;
      mockActiveWorkspace = { kind: 'multiview', id: 'multiview:1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }, { sessionId: 'sess2', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onSelectSession).toBeTypeOf('function'));

      (window as any).__headerProps.onSelectSession('sess2');

      expect(sessionStore.setActiveSession).toHaveBeenCalledWith('sess2');
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess2', '1');
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
      expect(mockActiveWorkspace).toEqual({ kind: 'session', sessionId: 'sess2' });
    });

    it('REQ-TERM-011: selecting an initializing session opens it instead of silently doing nothing', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' }), createMockSession({ id: 'sess2', status: 'initializing' })];
      mockActiveSessionId = null;
      mockActiveWorkspace = { kind: 'multiview', id: 'multiview:1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }, { sessionId: 'sess2', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onSelectSession).toBeTypeOf('function'));

      (window as any).__headerProps.onSelectSession('sess2');

      expect(sessionStore.setActiveSession).toHaveBeenCalledWith('sess2');
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess2', '1');
      expect(sessionStore.startSession).not.toHaveBeenCalled();
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
    });

    it('REQ-TERM-011: dashboard button leaves terminal view immediately', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onLogoClick).toBeTypeOf('function'));

      (window as any).__headerProps.onLogoClick();

      expect(sessionStore.setActiveSession).toHaveBeenCalledWith(null);
      await waitFor(() => expect((window as any).__terminalAreaProps.showTerminal).toBe(false));
      expect((window as any).__terminalAreaProps.viewState).toBe('collapsing');
    });

    it('REQ-TERM-011: selecting a stopped session from the header switcher opens the starting terminal surface', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [
        createMockSession({ id: 'sess1', status: 'running' }),
        createMockSession({ id: 'sess2', status: 'stopped' }),
      ];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];
      vi.mocked(sessionStore.startSession).mockReturnValue(new Promise(() => {}) as any);

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onSelectSession).toBeTypeOf('function'));

      (window as any).__headerProps.onSelectSession('sess2');

      expect(sessionStore.setActiveSession).toHaveBeenCalledWith('sess2');
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess2', '1');
      expect(sessionStore.startSession).toHaveBeenCalledWith('sess2');
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
      expect((window as any).__terminalAreaProps.viewState).not.toBe('dashboard');
    });

    it('REQ-TERM-011: dashboard return cancels an in-flight terminal transition', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [
        createMockSession({ id: 'sess1', status: 'running' }),
        createMockSession({ id: 'sess2', status: 'stopped' }),
      ];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];
      vi.mocked(sessionStore.startSession).mockReturnValue(new Promise(() => {}) as any);

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onSelectSession).toBeTypeOf('function'));
      vi.useFakeTimers();

      (window as any).__headerProps.onSelectSession('sess2');
      (window as any).__headerProps.onLogoClick();
      await vi.advanceTimersByTimeAsync(1000);

      expect((window as any).__terminalAreaProps.showTerminal).toBe(false);
      expect((window as any).__terminalAreaProps.viewState).toBe('dashboard');
    });

    it('REQ-TERM-014: creating a session from terminal view keeps the starting surface visible', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];
      const newSession = createMockSession({ id: 'sess-new', name: 'New Session', status: 'stopped' }) as SessionWithStatus;
      vi.mocked(sessionStore.createSession).mockImplementation(async () => {
        mockSessions = [...mockSessions, newSession];
        bumpSessionStoreVersion();
        return newSession;
      });
      let resolveStart: (() => void) | undefined;
      vi.mocked(sessionStore.startSession).mockImplementation(() => new Promise<void>((resolve) => { resolveStart = resolve; }));

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onCreateSession).toBeTypeOf('function'));

      const createPromise = (window as any).__headerProps.onCreateSession('New Session');
      await waitFor(() => expect(sessionStore.startSession).toHaveBeenCalledWith('sess-new'));

      expect(mockActiveSessionId).toBe('sess-new');
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess-new', '1');
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
      expect((window as any).__terminalAreaProps.viewState).not.toBe('dashboard');

      resolveStart?.();
      await createPromise;
    });
  });

  // =========================================================================
  // Session Lifecycle
  // =========================================================================

  describe('Session Lifecycle', () => {
    it('calls loadSessions on mount', async () => {
      const { sessionStore } = await import('../../stores/session');
      render(() => <Layout />);

      expect(sessionStore.loadSessions).toHaveBeenCalled();
      expect(sessionStore.loadPresets).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Props Forwarding
  // =========================================================================

  describe('Props Forwarding', () => {
    it('passes userName to Header via props', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout userName="test@example.com" />);

      expect(screen.getByTestId('header')).toBeInTheDocument();
    });

    it('passes userRole to SettingsPanel via props', () => {
      render(() => <Layout userName="admin@example.com" userRole="admin" />);

      expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    });

    it('renders without optional props', () => {
      render(() => <Layout />);

      expect(document.querySelector('.layout')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Logout Behavior
  //
  // Logout is now handled by the Dashboard/Header user dropdown internally,
  // not via a prop from Layout. Layout no longer passes onLogout to TerminalArea.
  // =========================================================================

  describe('Logout Behavior', () => {
    it('does not pass onLogout prop to TerminalArea', () => {
      render(() => <Layout userName="test@example.com" userRole="user" />);

      const props = (window as any).__terminalAreaProps;
      expect(props.onLogout).toBeUndefined();
    });
  });

  // =========================================================================
  // Visibility Return: Keyboard State Reset
  //
  // When the browser tab regains focus, stale keyboard signals from
  // backgrounding must be cleared before WS reconnection.
  // =========================================================================

  describe('Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)', () => {
    it('calls forceResetKeyboardState on visibility return in terminal view', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '2' }];

      render(() => <Layout />);

      vi.mocked(forceResetKeyboardState).mockClear();
      vi.mocked(reconnectDisconnectedTerminals).mockClear();
      vi.mocked(reconnectOnVisibilityReturn).mockClear();

      // Simulate returning from backgrounded browser
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(forceResetKeyboardState).toHaveBeenCalled();
      expect(reconnectOnVisibilityReturn).toHaveBeenCalledWith(undefined, ['sess1:2']);
    });

    it('REQ-TERM-011: reconnects only visible tiled slots after visibility return', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '4' }];
      mockTerminalsForSession = { tabs: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }], activeTabId: '4' };
      mockTilingForSession = { enabled: true, layout: '2-split' };
      mockTabOrder = ['1', '2', '3', '4'];

      render(() => <Layout />);

      vi.mocked(reconnectOnVisibilityReturn).mockClear();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      const reconnectCalls = vi.mocked(reconnectOnVisibilityReturn).mock.calls;
      expect(reconnectCalls[reconnectCalls.length - 1]?.[1]).toEqual(['sess1:1', 'sess1:2']);
    });

    it('does NOT call forceResetKeyboardState when on dashboard', () => {
      // No active session = dashboard view
      render(() => <Layout />);

      vi.mocked(forceResetKeyboardState).mockClear();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(forceResetKeyboardState).not.toHaveBeenCalled();
    });

    it('Samsung: bounces through dashboard on visibility return to reset keyboard state', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockIsSamsungBrowser = true;
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';

      render(() => <Layout />);

      vi.mocked(sessionStore.setActiveSession).mockClear();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      // Should deactivate session immediately (dashboard bounce)
      expect(sessionStore.setActiveSession).toHaveBeenCalledWith(null);
    });
  });

  // =========================================================================
  // REQ-SUB-018 AC3 / AC6 — usage quota banner surfacing + dismissibility
  //
  // usageWarning() === getUsageWarningLevel(); the banners render only in SaaS
  // mode. We drive getUsageWarningLevel per threshold and assert the matching
  // data-testid banner is surfaced, and that the 100% banner is NOT dismissible.
  // =========================================================================

  describe('REQ-SUB-018 AC3/AC6 (usage quota banners)', () => {
    it('AC3: surfaces the 80% banner when usage warning level is 80 (SaaS)', () => {
      mockSaasMode = true;
      vi.mocked(getUsageWarningLevel).mockReturnValue('80');
      vi.mocked(getDismissedQuotaLevel).mockReturnValue(null);

      render(() => <Layout />);

      expect(screen.getByTestId('usage-warning-80')).toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-95')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-100')).not.toBeInTheDocument();
    });

    it('AC3: surfaces the 95% banner when usage warning level is 95 (SaaS)', () => {
      mockSaasMode = true;
      vi.mocked(getUsageWarningLevel).mockReturnValue('95');
      vi.mocked(getDismissedQuotaLevel).mockReturnValue(null);

      render(() => <Layout />);

      expect(screen.getByTestId('usage-warning-95')).toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-80')).not.toBeInTheDocument();
    });

    it('AC3: surfaces the 100% banner when usage warning level is 100 (SaaS)', () => {
      mockSaasMode = true;
      vi.mocked(getUsageWarningLevel).mockReturnValue('100');
      vi.mocked(getDismissedQuotaLevel).mockReturnValue(null);

      render(() => <Layout />);

      expect(screen.getByTestId('usage-warning-100')).toBeInTheDocument();
    });

    it('AC3: surfaces no usage banner outside SaaS mode even at 100% usage', () => {
      mockSaasMode = false;
      vi.mocked(getUsageWarningLevel).mockReturnValue('100');

      render(() => <Layout />);

      expect(screen.queryByTestId('usage-warning-80')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-95')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-100')).not.toBeInTheDocument();
    });

    it('AC6: the 80% and 95% banners carry a dismiss control; the 100% banner does not', () => {
      mockSaasMode = true;
      vi.mocked(getDismissedQuotaLevel).mockReturnValue(null);

      vi.mocked(getUsageWarningLevel).mockReturnValue('80');
      const { unmount: unmount80 } = render(() => <Layout />);
      const banner80 = screen.getByTestId('usage-warning-80');
      expect(banner80.querySelector('.layout-banner-dismiss')).toBeInTheDocument();
      unmount80();

      vi.mocked(getUsageWarningLevel).mockReturnValue('95');
      const { unmount: unmount95 } = render(() => <Layout />);
      const banner95 = screen.getByTestId('usage-warning-95');
      expect(banner95.querySelector('.layout-banner-dismiss')).toBeInTheDocument();
      unmount95();

      vi.mocked(getUsageWarningLevel).mockReturnValue('100');
      render(() => <Layout />);
      const banner100 = screen.getByTestId('usage-warning-100');
      // The exceeded banner cannot be dismissed — no dismiss button.
      expect(banner100.querySelector('.layout-banner-dismiss')).not.toBeInTheDocument();
    });

    it('AC6: dismissing the 80% banner records the dismissed level', async () => {
      mockSaasMode = true;
      vi.mocked(getUsageWarningLevel).mockReturnValue('80');
      vi.mocked(getDismissedQuotaLevel).mockReturnValue(null);

      render(() => <Layout />);

      const dismiss = screen
        .getByTestId('usage-warning-80')
        .querySelector('.layout-banner-dismiss') as HTMLButtonElement;
      dismiss.click();

      expect(setDismissedQuotaLevel).toHaveBeenCalledWith('80');
    });
  });

  // =========================================================================
  // REQ-VAULT-019 AC4 — vault open-intent is cleared when the target session
  // is no longer the active running session.
  //
  // handleVaultOpen sets the per-session open intent to 'preparing' when the
  // key is not recoverable; that intent overrides the button status (surfaced
  // to Header via the vaultStatus prop). When the active running session goes
  // away, the createEffect on activeRunningSid() clears the open intent, so the
  // button status reverts off 'preparing'.
  // =========================================================================

  describe('REQ-VAULT-019 AC4 (vault open-intent clearing)', () => {
    it('clears the open-intent (vaultStatus leaves "preparing") when the session is no longer active-running', async () => {
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];
      // Local readiness holds but the encryption key is NOT recoverable, so the
      // open path parks the session in 'preparing' instead of opening a tab.
      vaultLocalReadinessMock.check.mockResolvedValue({ ready: true, recordedDbs: ['sb_data_a'], hasIndexedDbDatabasesApi: true });
      vaultLocalReadinessMock.keyRecoverable.mockResolvedValue(false);

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onVaultOpen).toBeTypeOf('function'));

      await (window as any).__headerProps.onVaultOpen();

      // Intent took hold: the button reflects 'preparing'.
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('preparing'));

      // Session is no longer the active *running* session (mode flips so the
      // probe gate drops it) — the clearing effect should reset the intent.
      mockPreferences = { sessionMode: 'standard' };
      bumpSessionStoreVersion();

      await waitFor(() => expect((window as any).__headerProps.vaultStatus).not.toBe('preparing'));
    });
  });

});
