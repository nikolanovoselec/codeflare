import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@solidjs/testing-library';
import { createSignal, For, Show } from 'solid-js';
import type { SessionWithStatus } from '../../types';
import PiWorkspaceMode from '../../components/PiWorkspaceMode';

const retryMigration = vi.hoisted(() => vi.fn());
const appAuth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('../../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  retryBucketMigration: retryMigration,
  getSetupStatus: async () => ({ configured: true }),
  getUser: (...args: unknown[]) => appAuth.getUser(...args),
}));
vi.mock('../../api/mcp-portals', () => ({ getMcpPortalStatuses: async () => [] }));

const navigationRendering = vi.hoisted(() => ({ realTerminalArea: false, realSettingsPanel: false, realDashboard: false }));
const cloudflare = vi.hoisted(() => ({ getStatus: vi.fn(), selectAccount: vi.fn() }));
vi.mock('../../api/cloudflare', () => ({
  getCloudflareStatus: cloudflare.getStatus,
  selectCloudflareAccount: cloudflare.selectAccount,
  disconnectCloudflare: vi.fn(),
  cloudflareConnectUrl: () => '/api/cloudflare/connect',
}));

vi.mock('../../components/Dashboard', async importOriginal => {
  const ActualDashboard = (await importOriginal<typeof import('../../components/Dashboard')>()).default;
  return { default: (props: any) => navigationRendering.realDashboard ? <ActualDashboard {...props} /> : <section aria-label="Session dashboard">
    <span>{props.userName}</span>
    <Show when={props.workspaceMode}>{mode => <PiWorkspaceMode {...mode()} presentation="segments" />}</Show>
    <For each={props.sessions}>{session => <span>{session.name}</span>}</For>
    <button onClick={() => props.onStartSession('abcdef0123456789')}>Start session</button>
    <button onClick={() => props.onOpenSessionById('abcdef0123456789')}>Return to session</button>
    <button onClick={() => props.onOpenSessionById('abcdef0123456789', 'terminal')}>Open in Terminal</button>
  </section> };
});
vi.mock('../../components/Terminal', async () => {
  const { sessionStore } = await import('../../stores/session');
  const { Show } = await import('solid-js');
  return { default: (props: any) => <Show when={sessionStore.isSessionInitializing(props.sessionId)}
    fallback={<div data-testid="workspace-content">Workspace</div>}>
    <div data-testid="startup-progress">
      {sessionStore.sessions.find(session => session.id === props.sessionId)?.status === 'running' ? 'Ready to open' : 'Starting'}
      <button onClick={props.onInitComplete}>Open workspace</button>
    </div>
  </Show> };
});
vi.mock('../../components/TerminalTabs', () => ({ default: () => <div role="tablist" aria-label="Terminals" /> }));
vi.mock('../../components/FloatingTerminalButtons', () => ({ default: () => <div /> }));

// Existing isolated tests keep their lightweight child; navigation regressions
// opt into the actual TerminalArea to exercise its dashboard render boundary.
vi.mock('../../components/Header', () => ({
  default: (props: any) => {
    // Store props on window for inspection in tests (CF-075 vault gating).
    (window as any).__headerProps = props;
    return (
      <header data-testid="header">
        <button onClick={props.onLogoClick}>Dashboard</button>
        <Show when={props.workspaceMode}>{mode => <PiWorkspaceMode {...mode()} presentation="segments" />}</Show>
      </header>
    );
  }
}));

vi.mock('../../components/TerminalArea', async () => {
  const ActualTerminalArea = (await vi.importActual<typeof import('../../components/TerminalArea')>('../../components/TerminalArea')).default;
  return { default: (props: any) => {
    if (navigationRendering.realTerminalArea) return <ActualTerminalArea {...props} />;
    // Store props on window for inspection in tests
    (window as any).__terminalAreaProps = props;
    return (
      <main data-testid="terminal-area">
        Terminal Area
        {props.repositoryRestoreNotices}
      </main>
    );
  } };
});

vi.mock('../../components/SplashCursor', () => ({
  default: () => <div data-testid="splash-cursor" />
}));

vi.mock('../../components/SettingsPanel', async importOriginal => {
  const { default: ActualSettingsPanel } = await importOriginal<typeof import('../../components/SettingsPanel')>();
  return { default: (props: any) => {
    if (navigationRendering.realSettingsPanel) return <ActualSettingsPanel {...props} />;
    (window as any).__settingsPanelProps = props;
    return <div data-testid="settings-panel" />;
  } };
});

vi.mock('../../components/StoragePanel', () => ({
  default: (props: any) => {
    (window as any).__storagePanelProps = props;
    return <div data-testid="storage-panel" />;
  }
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
  keyRecoverable: vi.fn(async (_sessionId?: string) => true),
}));

vi.mock('../../lib/vault-local-readiness', () => ({
  checkVaultKeyRecoverable: (sessionId: string) => vaultLocalReadinessMock.keyRecoverable(sessionId),
}));

const vaultPrewarmProof = {
  scope: `${window.location.origin}/api/vault/0123456789abcdef0123456789abcdef/`,
  contentReady: true,
  spaceSyncCompleted: true,
  indexReady: true,
  requiredFiles: ['CONFIG.md', 'Index.md', 'STYLES.md'],
  listedFileCount: 42,
};

// Session store mock with controllable state.
// Module-level variables allow tests to set up specific states before rendering.
let mockSessions: any[] = [];
let mockRepositoryNotices: Record<string, { status: 'restoring' | 'complete' | 'issues'; repo?: string; outcome?: 'cloned' | 'exists' | 'failed' | 'tracking-unconfirmed' }> = {};
let mockMigrationHalt: string | null = null;
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
    get bucketMigrationHaltedAt() { readSessionStoreVersion(); return mockMigrationHalt; },
    refreshSessionAncillaryStatus: vi.fn().mockResolvedValue(undefined),
    startR2Polling: vi.fn(),
    isAtSessionLimit: vi.fn(() => false),
    get repositoryRestoreNotices() { readSessionStoreVersion(); return mockRepositoryNotices; },
    dismissRepositoryRestore: (id: string) => {
      delete mockRepositoryNotices[id];
      bumpSessionStoreVersion();
    },
    get activeSessionId() { readSessionStoreVersion(); return mockActiveSessionId; },
    get saasMode() { readSessionStoreVersion(); return mockSaasMode; },
    get error() { return null; },
    get loading() { return false; },
    loadSessions: vi.fn(),
    setActiveSession: vi.fn((id: string | null) => { mockActiveSessionId = id; bumpSessionStoreVersion(); }),
    getActiveSession: vi.fn(() => {
      readSessionStoreVersion();
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
    setEnterpriseMode: vi.fn(),
    setSaasMode: vi.fn(),
    setAllowedAgents: vi.fn(),
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
    startSessionListPolling: vi.fn(),
    stopSessionListPolling: vi.fn(),
    get preferences() { readSessionStoreVersion(); return mockPreferences; },
  },
  getUsageWarningLevel: vi.fn(() => 'none'),
  isAtUsageQuota: vi.fn(() => false),
  getDismissedQuotaLevel: vi.fn(() => null),
  setDismissedQuotaLevel: vi.fn(),
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: { reconnect: vi.fn(), triggerLayoutResize: vi.fn(), disposeAll: vi.fn(), setParked: vi.fn(), getConnectionState: vi.fn(() => 'disconnected') },
  reconnectDisconnectedTerminals: vi.fn(),
  reconnectOnVisibilityReturn: vi.fn(),
  scheduleDisconnect: vi.fn(),
  cancelScheduledDisconnect: vi.fn(),
}));

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    reconcileMultiView: vi.fn(() => null),
    getActiveWorkspace: vi.fn(() => mockActiveWorkspace),
    getVisiblePanes: vi.fn(() => {
      readSessionStoreVersion();
      return navigationRendering.realTerminalArea
        ? mockVisiblePanes.map(pane => ({ ...pane, id: `${pane.sessionId}:${pane.terminalId}`, source: 'session' }))
        : mockVisiblePanes;
    }),
    getFocusedPaneId: vi.fn(() => null),
    getLayout: vi.fn(() => 'tabbed'),
    isTerminalSession: vi.fn((session: SessionWithStatus | undefined) => !!session && session.workspace !== 'vscode'),
    setDashboardWorkspace: vi.fn(() => { mockActiveWorkspace = { kind: 'dashboard' }; mockVisiblePanes = []; bumpSessionStoreVersion(); }),
    setSingleSessionWorkspace: vi.fn((sessionId: string, terminalId = '1') => {
      if (mockActiveWorkspace.kind === 'session' && mockActiveWorkspace.sessionId === sessionId
          && mockVisiblePanes[0]?.terminalId === terminalId) return;
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
vi.mock('../../lib/mobile', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/mobile')>(),
  forceResetKeyboardState: vi.fn(),
  enableVirtualKeyboardOverlay: vi.fn(),
  cleanupDebugOverlay: vi.fn(),
  get isSamsungBrowser() { return mockIsSamsungBrowser; },
}));

import { forceResetKeyboardState } from '../../lib/mobile';
import { reconnectDisconnectedTerminals, reconnectOnVisibilityReturn, terminalStore } from '../../stores/terminal';
import { getUsageWarningLevel, getDismissedQuotaLevel, setDismissedQuotaLevel } from '../../stores/session';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';
import App from '../../App';
import { sessionStore } from '../../stores/session';
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
    navigationRendering.realTerminalArea = false;
    navigationRendering.realSettingsPanel = false;
    navigationRendering.realDashboard = false;
    mockMigrationHalt = null;
    retryMigration.mockReset();
    mockSessions = [];
    mockRepositoryNotices = {};
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
    vaultLocalReadinessMock.keyRecoverable.mockClear();
    vaultLocalReadinessMock.keyRecoverable.mockResolvedValue(true);
    localStorage.clear();
    window.history.replaceState(null, '', '/app/');
    delete (window as any).__terminalAreaProps;
    delete (window as any).__headerProps;
  });

  it('REQ-GITHUB-320: shows restore progress on the Dashboard and dismisses a partial outcome', () => {
    mockSessions = [createMockSession({ name: 'Payments workspace' })];
    mockRepositoryNotices = { sess1: { status: 'restoring' } };
    render(() => <Layout />);
    expect(screen.getByText('Restoring repositories…')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Activity notifications' })).getByText('Payments workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss repository restore notification' })).toBeInTheDocument();
    mockRepositoryNotices = { sess1: { status: 'issues' } };
    bumpSessionStoreVersion();
    expect(screen.getByText('Some repositories weren’t restored')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss repository restore notification' }));
    expect(screen.queryByText('Some repositories weren’t restored')).toBeNull();
  });

  it.each([false, true])('REQ-GITHUB-320: places restore notice after the open session tabs and dismisses it while restoring', async manualClone => {
    navigationRendering.realTerminalArea = true;
    const sessionId = 'abcdef0123456789';
    mockSessions = [createMockSession({ id: sessionId })];
    mockRepositoryNotices = { [sessionId]: { status: 'restoring', ...(manualClone ? { repo: 'octocat/hello' } : {}) } };
    window.history.replaceState(null, '', `/app/session/${sessionId}`);
    render(() => <Layout />);
    const tabs = await screen.findByRole('tablist', { name: 'Terminals' });
    const notice = screen.getByRole('region', { name: 'Activity notifications' });
    expect(tabs.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const title = manualClone ? 'Cloning repository…' : 'Restoring repositories…';
    expect(within(notice).getByText(title)).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', {
      name: manualClone ? 'Dismiss repository clone notification' : 'Dismiss repository restore notification',
    }));
    expect(screen.queryByText(title)).toBeNull();
    expect(tabs).toBeInTheDocument();
  });

  it.each([
    ['chat', 'terminal', {}, 'chat'],
    ['terminal', 'chat', {}, 'terminal'],
    ['chat', 'chat', {}, undefined],
    ['terminal', 'chat', { herdrEnabled: true }, undefined],
    ['terminal', 'chat', { defaultWorkspace: 'vscode' }, undefined],
    ['terminal', 'chat', { herdrEnabled: true }, undefined, true],
    ['terminal', 'chat', { defaultWorkspace: 'vscode' }, undefined, true],
  ] as const)('opens a running Pi workspace using preference %s from %s with settings %j', async (preferred, initial, settings, target, explicit?: boolean) => {
    navigationRendering.realTerminalArea = true;
    const id = 'abcdef0123456789';
    const prefix = `/api/pi-web/${id}/`;
    const chatUrl = `${prefix}g/7/?session=saved-pi&view=chat`;
    let surface: string = initial;
    const requested: string[] = [];
    mockPreferences = { defaultPiSurface: preferred, ...settings };
    mockSessions = [createMockSession({ id, workspace: 'terminal', agentType: 'pi', generation: 7 })];
    mockVisiblePanes = [{ sessionId: id, terminalId: '1' }];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url !== `${prefix}_switch?generation=7` && url !== `${prefix}_switch`) return Response.json({});
      if (init?.method === 'POST') {
        surface = JSON.parse(String(init.body)).target;
        requested.push(surface);
      }
      return Response.json({ phase: 'complete', surface, ...(surface === 'chat' && { chatUrl }) });
    });
    try {
      render(() => <Layout />);
      fireEvent.click(await screen.findByRole('button', { name: explicit === true ? 'Open in Terminal' : 'Return to session' }));
      if ((target ?? initial) === 'chat') await screen.findByTitle('Pi Chat');
      else await screen.findByTestId('workspace-content');
      expect(requested).toEqual(target ? [target] : []);
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it.each([{ herdrEnabled: true }, { defaultWorkspace: 'vscode' }])('hides Dashboard mode navigation with settings %j', preferences => {
    navigationRendering.realTerminalArea = true;
    mockPreferences = preferences;
    render(() => <Layout />);
    expect(screen.queryByRole('group', { name: 'Workspace mode' })).not.toBeInTheDocument();
  });

  it('saves the mode from Dashboard without selecting a session', async () => {
    const { sessionStore } = await import('../../stores/session');
    navigationRendering.realTerminalArea = true;
    render(() => <Layout />);
    vi.mocked(sessionStore.updatePreferences).mockImplementationOnce(async preferences => {
      mockPreferences = { ...mockPreferences, ...preferences };
      bumpSessionStoreVersion();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Vibe — Chat' }));
    expect(await screen.findByRole('button', { name: 'Vibe — Chat', pressed: true })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeVisible();
    expect(sessionStore.startSession).not.toHaveBeenCalled();
  });

  it('reconnects a dropped parked Terminal only after making it foreground', async () => {
    navigationRendering.realTerminalArea = true;
    const id = 'abcdef0123456789';
    const key = `${id}:1`;
    mockSessions = [createMockSession({ id, workspace: 'terminal', agentType: 'bash', generation: 7 })];
    window.history.replaceState(null, '', `/app/session/${id}`);
    let connected = true;
    let parked = false;
    const reconnects: string[] = [];
    vi.mocked(terminalStore.getConnectionState).mockImplementation(() => connected ? 'connected' : 'disconnected');
    vi.mocked(terminalStore.setParked).mockImplementation((_id, _tab, value) => { parked = value; });
    vi.mocked(reconnectDisconnectedTerminals).mockImplementation((_id, visible) => {
      if (!parked && !connected && visible?.includes(key)) {
        reconnects.push(key);
        connected = true;
      }
    });
    try {
      render(() => <Layout />);
      const pane = await screen.findByTestId('workspace-content');
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      expect(parked).toBe(true);
      connected = false;
      bumpSessionStoreVersion();
      expect(reconnects).toEqual([]);
      fireEvent.click(await screen.findByRole('button', { name: 'Return to session' }));
      expect(reconnects).toEqual([key]);
      expect(screen.getByTestId('workspace-content')).toBe(pane);
    } finally {
      cleanup();
      vi.mocked(terminalStore.setParked).mockReset();
      vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected');
      vi.mocked(reconnectDisconnectedTerminals).mockReset();
    }
  });

  it.each(['generation replacement', 'page exit'])('retains one mounted Terminal pane on Dashboard and discards it on %s', async invalidation => {
    navigationRendering.realTerminalArea = true;
    const id = 'abcdef0123456789';
    mockSessions = [createMockSession({ id, workspace: 'terminal', agentType: 'bash', generation: 7 })];
    window.history.replaceState(null, '', `/app/session/${id}`);
    vi.mocked(terminalStore.getConnectionState).mockReturnValue('connected');
    try {
      render(() => <Layout />);
      const pane = await screen.findByTestId('workspace-content');
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      expect(pane).toBeInTheDocument();
      expect(pane).not.toBeVisible();
      fireEvent.click(await screen.findByRole('button', { name: 'Return to session' }));
      expect(screen.getByTestId('workspace-content')).toBe(pane);
      expect(pane).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      if (invalidation === 'page exit') window.dispatchEvent(new Event('pagehide'));
      else {
        mockSessions = [{ ...mockSessions[0], generation: 8 }];
        bumpSessionStoreVersion();
      }
      expect(pane).not.toBeInTheDocument();
    } finally { vi.mocked(terminalStore.getConnectionState).mockReturnValue('disconnected'); }
  });

  it.each(['generation replacement', 'page exit'])('reuses the open Chat frame on Dashboard return and discards it on %s', async invalidation => {
    navigationRendering.realTerminalArea = true;
    const id = 'abcdef0123456789';
    mockSessions = [createMockSession({ id, workspace: 'terminal', agentType: 'pi', generation: 7 })];
    window.history.replaceState(null, '', `/app/session/${id}`);
    const switches: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/_switch')) switches.push(url);
      const generation = /_switch\?generation=(7|8)$/.exec(url)?.[1];
      return generation ? Response.json({ phase: 'active', surface: 'chat', chatUrl: `/api/pi-web/${id}/g/${generation}/?view=chat` }) : Response.json({});
    });
    try {
      render(() => <Layout />);
      const frame = await screen.findByTitle('Pi Chat');
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      expect(frame).toBeInTheDocument();
      expect(frame).not.toBeVisible();
      mockPreferences = { defaultPiSurface: 'terminal' };
      bumpSessionStoreVersion();
      fireEvent.click(await screen.findByRole('button', { name: 'Return to session' }));
      expect(screen.getByTitle('Pi Chat')).toBe(frame);
      expect(frame).toBeVisible();
      expect(switches).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      if (invalidation === 'page exit') window.dispatchEvent(new Event('pagehide'));
      else {
        mockSessions = [{ ...mockSessions[0], generation: 8 }];
        bumpSessionStoreVersion();
      }
      expect(frame).not.toBeInTheDocument();
      expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it('keeps the repository restore notice visible across Classic Chat and Terminal switches', async () => {
    navigationRendering.realTerminalArea = true;
    const sessionId = 'abcdef0123456789';
    const prefix = `/api/pi-web/${sessionId}/`;
    const chatUrl = `${prefix}g/7/?session=saved-pi&view=chat`;
    let surface = 'chat';
    mockSessions = [createMockSession({ id: sessionId, workspace: 'terminal', agentType: 'pi', generation: 7 })];
    mockVisiblePanes = [{ sessionId, terminalId: '1' }];
    mockRepositoryNotices = { [sessionId]: { status: 'restoring' } };
    window.history.replaceState(null, '', `/app/session/${sessionId}`);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url !== `${prefix}_switch?generation=7` && url !== `${prefix}_switch`) return Response.json({});
      if (init?.method === 'POST') surface = JSON.parse(String(init.body)).target;
      return Response.json({ phase: 'complete', surface, ...(surface === 'chat' && { chatUrl }) });
    });
    try {
      render(() => <Layout />);
      await screen.findByTitle('Pi Chat');
      const notice = screen.getByText('Restoring repositories…');
      fireEvent.click(screen.getByRole('button', { name: 'Code — Terminal' }));
      await waitFor(() => expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument());
      expect(notice).toBeVisible();
      fireEvent.click(await screen.findByRole('button', { name: 'Vibe — Chat' }));
      await screen.findByTitle('Pi Chat');
      expect(notice).toBeVisible();
      const { sessionStore } = await import('../../stores/session');
      expect(sessionStore.updatePreferences).toHaveBeenCalledWith({ defaultPiSurface: 'terminal' });
      expect(sessionStore.updatePreferences).toHaveBeenCalledWith({ defaultPiSurface: 'chat' });
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it.each([{ herdrEnabled: true }, { defaultWorkspace: 'vscode' }])('withdraws switch retry without replacing the running Chat when settings change to %j', async preferences => {
    navigationRendering.realTerminalArea = true;
    const id = 'abcdef0123456789';
    mockSessions = [createMockSession({ id, workspace: 'terminal', agentType: 'pi', generation: 7 })];
    window.history.replaceState(null, '', `/app/session/${id}`);
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!url.startsWith(`/api/pi-web/${id}/_switch`)) return Response.json({});
      if (init?.method === 'POST') requests.push(url);
      return Response.json({ phase: 'failed', surface: 'chat', target: 'terminal',
        requestId: 'd00c2f0c-c268-44ad-a23a-384e27941ad1', chatUrl: `/api/pi-web/${id}/g/7/?view=chat` });
    });
    try {
      render(() => <Layout />);
      const retry = await screen.findByRole('button', { name: 'Retry switch' });
      const frame = screen.getByTitle('Pi Chat');
      mockPreferences = preferences;
      bumpSessionStoreVersion();
      expect(screen.queryByRole('button', { name: 'Retry switch' })).not.toBeInTheDocument();
      fireEvent.click(retry);
      expect(requests).toEqual([]);
      expect(screen.getByTitle('Pi Chat')).toBe(frame);
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it('keeps the original native terminal reachable when a post-quit terminal switch needs a retry', async () => {
    navigationRendering.realTerminalArea = true;
    const sessionId = 'abcdef0123456789';
    mockSessions = [createMockSession({ id: sessionId, workspace: 'terminal', agentType: 'pi', generation: 7 })];
    mockVisiblePanes = [{ sessionId, terminalId: '1' }];
    window.history.replaceState(null, '', `/app/session/${sessionId}`);
    const requestId = 'd00c2f0c-c268-44ad-a23a-384e27941ad1';
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url !== `/api/pi-web/${sessionId}/_switch?generation=7` && url !== `/api/pi-web/${sessionId}/_switch`) {
        return Response.json({});
      }
      if (init?.method === 'POST') requests.push(JSON.parse(String(init.body)));
      return Response.json({ phase: 'failed', target: 'terminal', surface: null, requestId });
    });
    try {
      render(() => <Layout />);
      const retry = await screen.findByRole('button', { name: 'Retry switch' });
      expect(screen.getByTestId('workspace-content')).toBeVisible();
      expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
      fireEvent.click(retry);
      await waitFor(() => expect(requests).toEqual([{ generation: 7, requestId, target: 'terminal' }]));
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it('REQ-ENTERPRISE-323: shares clone notices and preserves retry acknowledgment when returning to Dashboard', async () => {
    navigationRendering.realDashboard = true;
    navigationRendering.realTerminalArea = true;
    const sessionId = 'abcdef0123456789';
    mockSessions = [createMockSession({ id: sessionId })];
    mockRepositoryNotices = { [sessionId]: { status: 'restoring', repo: 'octocat/hello' } };
    mockMigrationHalt = '2026-11-21T14:23:45.678Z';
    retryMigration.mockResolvedValueOnce({ success: true });
    render(() => <Layout />);

    const overlay = within(screen.getByRole('region', { name: 'Activity notifications' }));
    expect(overlay.getByText('Cloning repository…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));
    expect(await overlay.findByText('Retry accepted. Waiting for updated migration status.')).toBeInTheDocument();
    expect(overlay.getByText('Cloning repository…')).toBeInTheDocument();

    window.history.pushState(null, '', `/app/session/${sessionId}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry migration' })).not.toBeInTheDocument());
    expect(overlay.getByText('Retry accepted. Waiting for updated migration status.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    const retry = await screen.findByRole('button', { name: 'Retry migration' });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(retryMigration.mock.calls).toEqual([[mockMigrationHalt]]);
  });

  it.each([
    { status: 'restoring' as const, outcome: undefined, title: 'Cloning repository…' },
    { status: 'complete' as const, outcome: 'cloned' as const, title: 'Repository cloned' },
    { status: 'issues' as const, outcome: 'exists' as const, title: 'Repository folder already exists' },
    { status: 'issues' as const, outcome: 'tracking-unconfirmed' as const, title: 'Repository cloned; automatic restore not confirmed' },
    { status: 'issues' as const, outcome: 'failed' as const, title: 'Repository clone failed' },
  ])('REQ-GITHUB-320 AC6: renders live-clone identity and outcomes in the shared notice', ({ status, outcome, title }) => {
    mockSessions = [createMockSession({ name: 'Payments workspace' })];
    mockRepositoryNotices = { sess1: { status, outcome, repo: 'octocat/hello' } };
    render(() => <Layout />);
    const notice = screen.getByRole('region', { name: 'Activity notifications' });
    expect(within(notice).getByText(title)).toBeInTheDocument();
    expect(within(notice).getByText('Payments workspace')).toBeInTheDocument();
    expect(within(notice).getByText('octocat/hello')).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss repository clone notification' }));
    expect(within(notice).queryByText(title)).toBeNull();
  });

  it('REQ-STOR-018 AC7: visibility return preserves loaded pages while manual Reload replaces them', async () => {
    const { storageStore, _resetForTests } = await import('../../stores/storage');
    const storageApi = await import('../../api/storage');
    const object = (key: string) => ({ key, size: 1, lastModified: '2026-11-21T00:00:00Z' });
    const browse = vi.spyOn(storageApi, 'browseStorage')
      .mockResolvedValueOnce({ objects: [object('Notes/first.md')], prefixes: [], isTruncated: true, nextContinuationToken: 'next' })
      .mockResolvedValueOnce({ objects: [object('Notes/second.md')], prefixes: [], isTruncated: false })
      .mockResolvedValue({ objects: [object('Notes/reloaded.md')], prefixes: [], isTruncated: false });
    const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    _resetForTests();
    try {
      render(() => <Layout />);
      await storageStore.browse('Notes/');
      await storageStore.loadMore();
      const loaded = ['Notes/first.md', 'Notes/second.md'];
      expect(storageStore.objects.map(item => item.key)).toEqual(loaded);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(storageStore.objects.map(item => item.key)).toEqual(loaded);
      expect(storageStore.currentPrefix).toBe('Notes/');
      await storageStore.refresh();
      expect(storageStore.objects.map(item => item.key)).toEqual(['Notes/reloaded.md']);
    } finally {
      browse.mockRestore();
      _resetForTests();
      if (hidden) Object.defineProperty(document, 'hidden', hidden);
      else Reflect.deleteProperty(document, 'hidden');
    }
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('REQ-AGENT-239 AC1: the account-selection return opens Integrations and lets the owner pick an account', async () => {
    navigationRendering.realSettingsPanel = true;
    appAuth.getUser.mockResolvedValue({ email: 'owner@example.com', role: 'user', authenticated: true });
    const accounts = [{ id: 'a', name: 'Account A' }, { id: 'b', name: 'Account B' }];
    let selected: string | undefined;
    cloudflare.getStatus.mockImplementation(async () => ({ configured: true, connected: true,
      ...(selected ? { accountId: selected } : { accounts }) }));
    cloudflare.selectAccount.mockImplementation(async (accountId: string) => {
      selected = accountId;
      return { success: true, accountId };
    });
    window.history.replaceState(null, '', '/app/?cloudflare=select-account');

    render(() => <App />);
    const panel = within(await screen.findByRole('dialog', { name: 'Settings' }));
    expect(panel.getByRole('button', { name: 'Integrations' })).toHaveAttribute('aria-expanded', 'true');
    const integrations = within(panel.getByRole('region', { name: 'Integrations' }));
    const picker = await integrations.findByRole('combobox', { name: 'Cloudflare account' });
    fireEvent.change(picker, { target: { value: 'b' } });
    expect(await integrations.findByText('Account ID')).toBeVisible();
    expect(integrations.getByText('b', { exact: true })).toBeVisible();
    expect(window.location.search).toBe('');
  });

  it('REQ-AGENT-239 AC6: Integrations retries loading missing Cloudflare accounts without restarting OAuth', async () => {
    navigationRendering.realSettingsPanel = true;
    appAuth.getUser.mockResolvedValue({ email: 'owner@example.com', role: 'user', authenticated: true });
    let finishRead!: (value: { configured: true; connected: true; accounts: { id: string; name: string }[] }) => void;
    cloudflare.getStatus.mockResolvedValueOnce({ configured: true, connected: true })
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    window.history.replaceState(null, '', '/app/?cloudflare=select-account');

    render(() => <App />);
    const panel = within(await screen.findByRole('dialog', { name: 'Settings' }));
    const integrations = within(panel.getByRole('region', { name: 'Integrations' }));
    const retry = await integrations.findByRole('button', { name: 'Retry loading accounts' });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(retry).not.toHaveAttribute('aria-disabled', 'true'));
    expect(retry).toHaveFocus();
    expect(integrations.getByText('Connected', { exact: true })).toBeVisible();
    expect(integrations.queryByRole('combobox')).not.toBeInTheDocument();
    retry.blur();
    expect(retry).not.toHaveFocus();
    const readsBeforeRetry = cloudflare.getStatus.mock.calls.length;
    fireEvent.click(retry);
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(cloudflare.getStatus).toHaveBeenCalledTimes(readsBeforeRetry + 1);
    finishRead({ configured: true, connected: true, accounts: [{ id: 'a', name: 'Account A' }] });
    const picker = await integrations.findByRole('combobox', { name: 'Cloudflare account' });
    await waitFor(() => expect(picker).toHaveFocus());
    expect(within(picker).getByRole('option', { name: 'Account A' })).toHaveValue('a');
    expect(integrations.queryByRole('button', { name: 'Retry loading accounts' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/app/');
    expect(window.location.search).toBe('');
    expect(cloudflare.selectAccount).not.toHaveBeenCalled();
  });

  it('REQ-AGENT-239 AC4: a failed Cloudflare return offers retry in Integrations without disconnecting', async () => {
    navigationRendering.realSettingsPanel = true;
    appAuth.getUser.mockResolvedValue({ email: 'owner@example.com', role: 'user', authenticated: true });
    cloudflare.getStatus.mockResolvedValue({ configured: true, connected: true, accountId: 'saved' });
    window.history.replaceState(null, '', '/app/?cloudflare=error');

    render(() => <App />);
    const panel = within(await screen.findByRole('dialog', { name: 'Settings' }));
    const integrations = within(panel.getByRole('region', { name: 'Integrations' }));
    expect(integrations.getByRole('alert')).toHaveTextContent('Try again');
    expect(await integrations.findByRole('button', { name: 'Re-authorize' })).toBeEnabled();
    expect(integrations.getByText('saved', { exact: true })).toBeVisible();
    expect(window.location.search).toBe('');
  });

  it('REQ-AGENT-239 AC5: a no-accounts return explains how to retry without disconnecting', async () => {
    navigationRendering.realSettingsPanel = true;
    appAuth.getUser.mockResolvedValue({ email: 'owner@example.com', role: 'user', authenticated: true });
    cloudflare.getStatus.mockResolvedValue({ configured: true, connected: true, accountId: 'saved' });
    window.history.replaceState(null, '', '/app/?cloudflare=no-accounts');

    render(() => <App />);
    const panel = within(await screen.findByRole('dialog', { name: 'Settings' }));
    const integrations = within(panel.getByRole('region', { name: 'Integrations' }));
    expect(integrations.getByRole('alert')).toHaveTextContent(/choose a Cloudflare account.*try again/i);
    expect(await integrations.findByRole('button', { name: 'Re-authorize' })).toBeEnabled();
    expect(integrations.queryByRole('combobox')).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('REQ-OPERATOR-033 AC5: real Layout never renders cached A sessions under B while B reload is pending', async () => {
    navigationRendering.realTerminalArea = true;
    mockSessions = [createMockSession({ name: 'A private session' })];
    let owner = 'A@example.com';
    appAuth.getUser.mockImplementation(async () => ({ email: owner, role: 'user', authenticated: true }));
    // Match the real session store: loadSessions retains the cached catalog
    // until the new owner's API read settles, rather than clearing it on entry.
    let finishReload!: () => void;
    const reload = new Promise<void>(resolve => { finishReload = resolve; });
    vi.mocked(sessionStore.loadSessions).mockImplementation(() => owner === 'B@example.com' ? reload : Promise.resolve());
    const originalLocation = window.location;
    const navigation: string[] = [];
    Object.defineProperty(window, 'location', { configurable: true, value: {
      get pathname() { return originalLocation.pathname; },
      get search() { return originalLocation.search; },
      get hash() { return originalLocation.hash; },
      get origin() { return originalLocation.origin; },
      assign: (url: string) => navigation.push(url),
    } });
    try {
      render(() => <App />);
      expect(await screen.findByText('A private session')).toBeVisible();
      expect(screen.getByText('A@example.com')).toBeVisible();
      owner = 'B@example.com';
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
      await waitFor(() => expect(navigation).toEqual(['/app/']));
      // Navigation is deliberately held: no new-owner shell may consume any
      // old module-global catalog, active workspace or storage cache meantime.
      expect(screen.queryByText('B@example.com')).not.toBeInTheDocument();
      expect(screen.queryByText('A private session')).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Session dashboard' })).not.toBeInTheDocument();
      finishReload();
      await reload;
      await Promise.resolve();
      expect(screen.queryByText('A private session')).not.toBeInTheDocument();
    } finally {
      finishReload();
      vi.mocked(sessionStore.loadSessions).mockReset();
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });

  describe('REQ-TERM-027 AC3: canonical session deep links', () => {
    it('selects a loaded user-owned session from /app/session/:sessionId without implicitly starting it', async () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running' })];
      window.history.replaceState(null, '', `/app/session/${sessionId}`);

      render(() => <Layout />);

      await waitFor(() => expect(mockActiveSessionId).toBe(sessionId));
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith(sessionId, '1', expect.objectContaining({ id: sessionId }));
      expect((await import('../../stores/session')).sessionStore.startSession).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe(`/app/session/${sessionId}`);
    });

    it('normalizes a VS Code session deep link to the dashboard without terminal or popup ownership', async () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running', workspace: 'vscode' })];
      window.history.replaceState(null, '', `/app/session/${sessionId}`);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);

        await waitFor(() => expect(window.location.pathname).toBe('/app/'));
        expect(mockActiveSessionId).toBeNull();
        expect(mockActiveWorkspace).toEqual({ kind: 'dashboard' });
        expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalledWith(sessionId, expect.anything(), expect.anything());
        expect((await import('../../stores/session')).sessionStore.startSession).not.toHaveBeenCalled();
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });

    it('rejects malformed or unknown session paths to the dashboard without starting a container', async () => {
      mockSessions = [createMockSession({ id: 'abcdef0123456789', status: 'stopped' })];
      window.history.replaceState(null, '', '/app/session/unknown000000000');

      render(() => <Layout />);

      await waitFor(() => expect(window.location.pathname).toBe('/app/'));
      expect(mockActiveSessionId).toBeNull();
      expect((await import('../../stores/session')).sessionStore.startSession).not.toHaveBeenCalled();
    });

    it('updates the canonical pathname when dashboard selection opens a session and when logo returns', async () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running' })];
      render(() => <Layout />);

      (window as any).__terminalAreaProps.onDashboardSessionSelect(sessionId);
      await waitFor(() => expect(window.location.pathname).toBe(`/app/session/${sessionId}`));
      (window as any).__headerProps.onLogoClick();
      await waitFor(() => expect(window.location.pathname).toBe('/app/'));
    });
  });

  describe('REQ-SESSION-037: navigation through the real dashboard render boundary', () => {
    it.each([
      [390, 'back', 'success'], [1440, 'back', 'success'],
      [390, 'dashboard', 'success'], [1440, 'dashboard', 'success'],
      [390, 'back', 'failure'], [1440, 'back', 'failure'],
      [390, 'dashboard', 'failure'], [1440, 'dashboard', 'failure'],
    ] as const)('preserves startup navigation at %s px via %s through background %s', async (width, action, outcome) => {
      navigationRendering.realTerminalArea = true;
      const previousWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      const { sessionStore } = await import('../../stores/session');
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'stopped' })];
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const startup = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      const commands: string[] = [];
      let initializing = false;
      vi.mocked(sessionStore.isSessionInitializing).mockImplementation(id => {
        readSessionStoreVersion();
        return initializing && id === sessionId;
      });
      vi.mocked(sessionStore.dismissInitProgressForSession).mockImplementation(() => {
        initializing = false;
        bumpSessionStoreVersion();
      });
      vi.mocked(sessionStore.startSession).mockImplementation(async id => {
        commands.push(`start:${id}`);
        initializing = true;
        mockSessions = [{ ...mockSessions[0], status: 'initializing' }];
        bumpSessionStoreVersion();
        try {
          await startup;
          mockSessions = [{ ...mockSessions[0], status: 'running' }];
        } catch (error) {
          initializing = false;
          mockSessions = [{ ...mockSessions[0], status: 'error' }];
          throw error;
        } finally {
          bumpSessionStoreVersion();
        }
      });
      vi.mocked(sessionStore.stopSession).mockImplementation(async id => { commands.push(`stop:${id}`); });
      try {
        render(() => <Layout />);
        await Promise.resolve(); // authenticated session-list routing has settled
        fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
        await waitFor(() => expect(screen.getByTestId('startup-progress')).toHaveTextContent('Starting'));
        if (action === 'back') window.history.back();
        else fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
        await waitFor(() => expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument());
        expect(window.location.pathname).toBe('/app/');
        fireEvent.click(screen.getByRole('button', { name: 'Return to session' }));
        await waitFor(() => expect(screen.getByTestId('startup-progress')).toHaveTextContent('Starting'));
        fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
        await waitFor(() => expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument());
        if (outcome === 'failure') fail(Error('startup failed'));
        else finish();
        await startup.catch(() => {});
        await waitFor(() => expect(screen.getByRole('region', { name: 'Session dashboard' })).toBeInTheDocument());
        if (outcome === 'success') {
          fireEvent.click(screen.getByRole('button', { name: 'Return to session' }));
          await waitFor(() => expect(screen.getByTestId('startup-progress')).toHaveTextContent('Ready to open'));
          fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
          expect(screen.getByTestId('workspace-content')).toBeInTheDocument();
        }
        expect(commands).toEqual([`start:${sessionId}`]); // Start/Stop wire-command contract
      } finally {
        finish();
        vi.mocked(sessionStore.isSessionInitializing).mockReturnValue(false);
        vi.mocked(sessionStore.startSession).mockReset();
        vi.mocked(sessionStore.stopSession).mockReset();
        vi.mocked(sessionStore.dismissInitProgressForSession).mockReset();
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
      }
    });
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
  // CF-075 // REQ-VAULT-033 / REQ-VAULT-018: advanced-mode affordance + readiness gates.
  //
  // The Header renders its vault button only when it receives an onVaultOpen
  // prop. Layout passes onVaultOpen only when there is an active session AND
  // the session mode is 'advanced' (sessionStore.preferences.sessionMode).
  // In default mode the prop is undefined, so the button never renders.
  // We assert the gating by inspecting the prop Layout hands to Header.
  // =========================================================================

  // REQ-IDE-003 AC6: the browser-IDE (OpenVSCode) button is gated like the vault
  // PLUS a running-session requirement. Layout passes onVscodeOpen only for an
  // active, advanced-mode, RUNNING session; otherwise the prop is undefined and
  // Header never renders the button. Asserted by inspecting the prop + the URL.
  describe('Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)', () => {
    it('does NOT pass onVscodeOpen when the active session is default mode', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'default' };

      render(() => <Layout />);

      expect((window as any).__headerProps.onVscodeOpen).toBeUndefined();
    });

    it('does NOT pass onVscodeOpen when the advanced session is initializing (not yet running)', () => {
      // An initializing session renders the Header (the terminal view is up), so
      // this exercises the status==='running' gate directly: the IDE button must
      // stay hidden until the container is fully running. (A stopped session
      // instead shows the dashboard with no Header at all -- a different path.)
      mockSessions = [createMockSession({ status: 'initializing' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);

      expect((window as any).__headerProps.onVscodeOpen).toBeUndefined();
    });

    it('passes onVscodeOpen (IDE button shown) for an advanced, running session', () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);

      expect(typeof (window as any).__headerProps.onVscodeOpen).toBe('function');
    });

    it('the passed handler synchronously opens the validated session URL with its stable named target (REQ-IDE-002)', () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running' })];
      mockActiveSessionId = sessionId;
      mockPreferences = { sessionMode: 'advanced' };
      const handle = { closed: false, focus: vi.fn(), close: vi.fn() } as unknown as Window;
      let invokingHandler = false;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {
        expect(invokingHandler).toBe(true);
        return handle;
      });

      try {
        render(() => <Layout />);
        invokingHandler = true;
        (window as any).__headerProps.onVscodeOpen();
        invokingHandler = false;

        expect(openSpy).toHaveBeenCalledWith(
          `/api/vscode/${sessionId}/`,
          `codeflare-vscode-${sessionId}`,
        );
      } finally {
        openSpy.mockRestore();
      }
    });

    it('does not retain Browser IDE handles across Layout remounts', () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running' })];
      mockActiveSessionId = sessionId;
      mockPreferences = { sessionMode: 'advanced' };
      const openSpy = vi.spyOn(window, 'open')
        .mockReturnValueOnce({ closed: false, focus: vi.fn() } as unknown as Window)
        .mockReturnValueOnce({ closed: false, focus: vi.fn() } as unknown as Window);

      try {
        render(() => <Layout />);
        (window as any).__headerProps.onVscodeOpen();
        cleanup();
        render(() => <Layout />);
        (window as any).__headerProps.onVscodeOpen();

        expect(openSpy).toHaveBeenCalledTimes(2);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-IDE-050 AC3: surfaces bounded popup-blocked feedback through the existing Layout error seam', async () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running' })];
      mockActiveSessionId = sessionId;
      mockPreferences = { sessionMode: 'advanced' };
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        (window as any).__headerProps.onVscodeOpen();
        expect(openSpy).toHaveBeenCalledOnce();
        await waitFor(() => expect((window as any).__terminalAreaProps.error).toBeTruthy());
        const firstFeedback = (window as any).__terminalAreaProps.error;

        (window as any).__headerProps.onVscodeOpen();
        expect(openSpy).toHaveBeenCalledTimes(2);
        expect((window as any).__terminalAreaProps.error).toBe(firstFeedback);

        (window as any).__terminalAreaProps.onDismissError();
        await waitFor(() => expect((window as any).__terminalAreaProps.error).toBeNull());
      } finally {
        openSpy.mockRestore();
      }
    });

    it('does not close a retained Browser IDE window when its session stops or is deleted', async () => {
      const sessionId = 'abcdef0123456789';
      mockSessions = [createMockSession({ id: sessionId, status: 'running' })];
      mockActiveSessionId = sessionId;
      mockPreferences = { sessionMode: 'advanced' };
      const handle = { closed: false, focus: vi.fn(), close: vi.fn() } as unknown as Window;
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => handle);

      try {
        render(() => <Layout />);
        (window as any).__headerProps.onVscodeOpen();
        await (window as any).__terminalAreaProps.onStopSession(sessionId);
        await (window as any).__terminalAreaProps.onDeleteSession(sessionId);

        expect(handle.close).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });
  });

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

    it('REQ-VAULT-018: stays available (no auto-prewarm) until click 1, then breathes preparing -> armed', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);

      // Server not ready yet: idle, no prewarm.
      expect(vaultPrewarmMock.start).not.toHaveBeenCalled();
      expect((window as any).__headerProps.vaultReady).toBe(false);
      vaultProbeMock.latestOptions.setLatch();

      // Server ready -> clickable 'available', but we do NOT prewarm automatically.
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      expect(vaultPrewarmMock.start).not.toHaveBeenCalled();
      expect((window as any).__headerProps.vaultReady).toBe(false);

      // Click 1 starts the on-demand prewarm; the button breathes accent.
      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
      expect((window as any).__headerProps.vaultStatus).toBe('preparing');
      expect((window as any).__headerProps.vaultReady).toBe(false);

      // Indexing completes -> the poll arms the button green (key recoverable by default).
      vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));
      expect((window as any).__headerProps.vaultReady).toBe(true);
    });

    it('REQ-VAULT-019 AC2: completed prewarm cannot arm or open a Vault without a recoverable key', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      vaultLocalReadinessMock.keyRecoverable.mockResolvedValue(false);
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
        await (window as any).__headerProps.onVaultOpen();
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect(vaultLocalReadinessMock.keyRecoverable).toHaveBeenCalled());
        expect((window as any).__headerProps.vaultStatus).toBe('preparing');
        expect((window as any).__headerProps.vaultReady).toBe(false);
        await (window as any).__headerProps.onVaultOpen();
        expect(open).not.toHaveBeenCalled();
      } finally { open.mockRestore(); }
    });

    it('ignores legacy persistent readiness markers until the user starts a fresh prepare', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      localStorage.setItem('vault-session-sess1-prewarmed', '1');
      localStorage.setItem('vault-session-sess1-scope', `${window.location.origin}/api/vault/oldscope/`);

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();

      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      expect(vaultPrewarmMock.start).not.toHaveBeenCalled();
      expect((window as any).__headerProps.vaultReady).toBe(false);
    });

    it('REQ-VAULT-019 AC1 + REQ-VAULT-022 AC1: a cold-path armed click opens without re-verification', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

        // Click 1 -> on-demand prewarm; completion arms the button green (cold path).
        await (window as any).__headerProps.onVaultOpen();
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        // Click 2 (intent === 'armed'): opens synchronously without re-verification or a second prewarm.
        const prewarmCallsBeforeOpen = vaultPrewarmMock.start.mock.calls.length;
        const keyChecksBeforeOpen = vaultLocalReadinessMock.keyRecoverable.mock.calls.length;
        await (window as any).__headerProps.onVaultOpen();
        expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/.codeflare-bootstrap', '_blank', 'noopener');
        expect(vaultPrewarmMock.start.mock.calls.length).toBe(prewarmCallsBeforeOpen);
        expect(vaultLocalReadinessMock.keyRecoverable.mock.calls.length).toBe(keyChecksBeforeOpen);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-VAULT-024 AC6: the open click navigates the new tab to the bootstrap-hop URL, not the bare shell', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

        await (window as any).__headerProps.onVaultOpen(); // click 1 -> prewarm
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        // Click 2 opens through the key-arming bootstrap-hop (arms the SW encryption
        // key before the editor boots, so the first open never races __cfRecover into
        // a /.auth 403), NOT the bare shell.
        await (window as any).__headerProps.onVaultOpen();
        expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/.codeflare-bootstrap', '_blank', 'noopener');
        expect(openSpy).not.toHaveBeenCalledWith('/api/vault/sess1/', '_blank', 'noopener');
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-VAULT-022 AC6: stays green (armed) after the open click and on subsequent opens — ready means green, always', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

        await (window as any).__headerProps.onVaultOpen(); // click 1 -> prewarm
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        // Click 2 opens; the button STAYS green (no settle to neutral) because the
        // vault is ready (pw === 'ready'). Green is permanent once ready — identical
        // on mobile/tablet/desktop, with no reload-dependent settle state.
        await (window as any).__headerProps.onVaultOpen();
        expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/.codeflare-bootstrap', '_blank', 'noopener');
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        // A further click still opens, and the button is still green.
        openSpy.mockClear();
        await (window as any).__headerProps.onVaultOpen();
        await waitFor(() => expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/.codeflare-bootstrap', '_blank', 'noopener'));
        expect((window as any).__headerProps.vaultStatus).toBe('armed');
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-VAULT-020: click 1 starts the prewarm even when terminal input is focused', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const input = document.createElement('textarea');
      input.className = 'xterm-helper-textarea';
      document.body.append(input);
      input.focus();

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
      expect(document.activeElement).toBe(input);
      expect((window as any).__headerProps.vaultStatus).toBe('preparing');
    });

    it('keeps Header vaultReady false when the on-demand prewarm times out', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalled());
      vaultPrewarmMock.latestOptions.onError('timeout', 'slow index');

      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('timeout'));
      expect((window as any).__headerProps.vaultReady).toBe(false);
    });

    it('retries a timed-out prewarm only after another user click', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));
      vaultPrewarmMock.latestOptions.onError('timeout', 'slow index');
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('timeout'));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1);

      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(2));
      expect((window as any).__headerProps.vaultReady).toBe(false);
      expect((window as any).__headerProps.vaultStatus).toBe('preparing');
    });

    it('cancels an in-flight browser prewarm when Layout unmounts', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      const { unmount } = render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      await (window as any).__headerProps.onVaultOpen();
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

    it('REQ-VAULT-018 AC4: dashboard departure cancels the in-flight iframe and return resumes preparation', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));
      expect((window as any).__headerProps.vaultStatus).toBe('preparing');

      (window as any).__headerProps.onLogoClick();
      await waitFor(() => expect(mockActiveSessionId).toBeNull());
      await waitFor(() => expect(vaultPrewarmMock.cancel).toHaveBeenCalledTimes(1));

      (window as any).__terminalAreaProps.onDashboardSessionSelect('sess1');
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(2));
      expect((window as any).__headerProps.vaultStatus).toBe('preparing');
    });

    it('REQ-VAULT-019 AC5: temporary mobile deactivation preserves intent and remounts preparation', async () => {
      mockIsSamsungBrowser = true;
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));

      vi.useFakeTimers();
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      expect(mockActiveSessionId).toBeNull();
      expect(vaultPrewarmMock.cancel).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      expect(mockActiveSessionId).toBe('sess1');
      expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(2);
      expect((window as any).__headerProps.vaultStatus).toBe('preparing');
    });

    it('REQ-VAULT-022 AC6: preserves a running session readiness latch across dashboard departure and return', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
        await (window as any).__headerProps.onVaultOpen();
        await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));
        vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        (window as any).__headerProps.onLogoClick();
        await waitFor(() => expect(mockActiveSessionId).toBeNull());
        (window as any).__terminalAreaProps.onDashboardSessionSelect('sess1');

        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));
        expect(vaultProbeMock.latestOptions.initiallyReady()).toBe(true);
        expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1);

        await (window as any).__headerProps.onVaultOpen();
        expect(openSpy).toHaveBeenCalledWith('/api/vault/sess1/.codeflare-bootstrap', '_blank', 'noopener');
        expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1);
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-VAULT-022 AC6: preserves armed state through the mobile visibility-return dashboard bounce', async () => {
      mockIsSamsungBrowser = true;
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));
      vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

      vi.useFakeTimers();
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(mockActiveSessionId).toBeNull();

      await vi.advanceTimersByTimeAsync(50);
      expect(mockActiveSessionId).toBe('sess1');
      expect((window as any).__headerProps.vaultStatus).toBe('armed');
      expect(vaultProbeMock.latestOptions.initiallyReady()).toBe(true);
      expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1);
    });

    it('REQ-VAULT-019 AC4: authoritative stop prunes Vault state so restart re-derives from scratch', async () => {
      mockSessions = [createMockSession({ status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };

      render(() => <Layout />);
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1));
      vaultPrewarmMock.latestOptions.onReady(vaultPrewarmProof);
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

      mockSessions = [createMockSession({ status: 'stopped' })];
      bumpSessionStoreVersion();
      await waitFor(() => expect((window as any).__terminalAreaProps.showTerminal).toBe(false));

      mockSessions = [createMockSession({ status: 'running' })];
      bumpSessionStoreVersion();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('idle'));
      expect(vaultProbeMock.latestOptions.initiallyReady()).toBe(false);

      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
      expect(vaultPrewarmMock.start).toHaveBeenCalledTimes(1);
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
    it('REQ-TERM-043 AC6: OPEN dismisses readiness without directly manipulating transport', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__terminalAreaProps?.onOpenSessionById).toBeTypeOf('function'));
      vi.mocked(reconnectDisconnectedTerminals).mockClear();
      vi.mocked(reconnectOnVisibilityReturn).mockClear();

      (window as any).__terminalAreaProps.onOpenSessionById('sess1');

      expect(sessionStore.dismissInitProgressForSession).toHaveBeenCalledWith('sess1');
      expect(reconnectOnVisibilityReturn).not.toHaveBeenCalled();
      expect(reconnectDisconnectedTerminals).not.toHaveBeenCalled();
    });

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
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess2', '1', expect.objectContaining({ id: 'sess2' }));
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
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess2', '1', expect.objectContaining({ id: 'sess2' }));
      expect(sessionStore.startSession).not.toHaveBeenCalled();
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
    });

    it('REQ-IDE-048 AC2: header selection returns a running VS Code session to dashboard ownership', async () => {
      const { sessionStore } = await import('../../stores/session');
      const terminalSessionId = 'abcdef0123456789';
      const vscodeSessionId = 'fedcba9876543210';
      mockSessions = [
        createMockSession({ id: terminalSessionId, status: 'running' }),
        createMockSession({ id: vscodeSessionId, status: 'running', workspace: 'vscode' }),
      ];
      mockActiveSessionId = terminalSessionId;
      mockActiveWorkspace = { kind: 'session', sessionId: terminalSessionId };
      mockVisiblePanes = [{ sessionId: terminalSessionId, terminalId: '1' }];
      window.history.replaceState(null, '', `/app/session/${terminalSessionId}`);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        await waitFor(() => expect((window as any).__headerProps?.onSelectSession).toBeTypeOf('function'));

        (window as any).__headerProps.onSelectSession(vscodeSessionId);

        await waitFor(() => expect((window as any).__terminalAreaProps.showTerminal).toBe(false));
        expect(sessionStore.setActiveSession).toHaveBeenLastCalledWith(null);
        expect(mockActiveWorkspace).toEqual({ kind: 'dashboard' });
        expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalledWith(vscodeSessionId, expect.anything(), expect.anything());
        expect(window.location.pathname).toBe('/app/');
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-IDE-048 AC2: dashboard selection keeps a running VS Code session dashboard-owned', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess-vscode', status: 'running', workspace: 'vscode' })];
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        (window as any).__terminalAreaProps.onDashboardSessionSelect('sess-vscode');

        expect(sessionStore.setActiveSession).not.toHaveBeenCalledWith('sess-vscode');
        expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalledWith('sess-vscode', expect.anything());
        expect((window as any).__terminalAreaProps.showTerminal).toBe(false);
        expect(window.location.pathname).toBe('/app/');
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-IDE-050 AC6: keeps Settings dashboard-owned without opening the terminal Storage panel', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess-vscode', status: 'running', workspace: 'vscode' })];
      mockActiveSessionId = null;
      mockActiveWorkspace = { kind: 'dashboard' };

      render(() => <Layout />);
      (window as any).__terminalAreaProps.onSettingsClick();

      await waitFor(() => expect((window as any).__settingsPanelProps.isOpen).toBe(true));
      expect((window as any).__storagePanelProps.isOpen).toBe(false);
      expect(sessionStore.setActiveSession).not.toHaveBeenCalledWith('sess-vscode');
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalled();
      expect(mockActiveWorkspace).toEqual({ kind: 'dashboard' });
    });

    it.each([
      ['saved Vibe default', { defaultPiSurface: 'chat' }, 'pi', 'classic', undefined, ['chat']],
      ['saved Code default', { defaultPiSurface: 'terminal' }, 'pi', 'classic', undefined, ['terminal']],
      ['explicit choice', { defaultPiSurface: 'chat' }, 'pi', 'classic', 'terminal', ['terminal']],
      ['Herdr preference', { defaultPiSurface: 'chat', herdrEnabled: true }, 'pi', 'classic', undefined, []],
      ['VS Code default', { defaultPiSurface: 'chat', defaultWorkspace: 'vscode' }, 'pi', 'classic', undefined, []],
      ['stale explicit choice with Herdr', { herdrEnabled: true }, 'pi', 'classic', 'chat', []],
      ['stale explicit choice with VS Code default', { defaultWorkspace: 'vscode' }, 'pi', 'classic', 'chat', []],
      ['existing Herdr session', { defaultPiSurface: 'chat' }, 'pi', 'herdr', undefined, []],
      ['non-Pi session', { defaultPiSurface: 'chat' }, 'bash', 'classic', undefined, []],
    ] as const)('applies the eligible Pi surface at Dashboard Start: %s', async (_label, preferences, agentType, terminalMode, explicit, expected) => {
      const { sessionStore } = await import('../../stores/session');
      const id = 'abcdef0123456789';
      mockSessions = [createMockSession({ id, status: 'stopped', workspace: 'terminal', agentType, terminalMode })];
      mockPreferences = preferences;
      vi.mocked(sessionStore.startSession).mockResolvedValue(undefined as never);
      render(() => <Layout />);
      (window as any).__terminalAreaProps.onDashboardSessionSelect(id, explicit);
      expect(sessionStore.startSession).toHaveBeenCalledWith(id, ...expected);
    });

    it('REQ-IDE-049 AC1: stopped VS Code selection starts while remaining on dashboard', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess-vscode', status: 'stopped', workspace: 'vscode' })];
      vi.mocked(sessionStore.startSession).mockReturnValue(new Promise(() => {}) as any);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        (window as any).__terminalAreaProps.onDashboardSessionSelect('sess-vscode');

        expect(sessionStore.startSession).toHaveBeenCalledWith('sess-vscode');
        expect(sessionStore.setActiveSession).not.toHaveBeenCalledWith('sess-vscode');
        expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalledWith('sess-vscode', expect.anything());
        expect((window as any).__terminalAreaProps.showTerminal).toBe(false);
        expect(window.location.pathname).toBe('/app/');
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
    });

    it('REQ-IDE-049 AC1: explicit stopped-session start stays dashboard-owned for VS Code', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess-vscode', status: 'stopped', workspace: 'vscode' })];
      let resolveStart: (() => void) | undefined;
      vi.mocked(sessionStore.startSession).mockImplementation(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        const starting = (window as any).__terminalAreaProps.onStartSession('sess-vscode');
        await waitFor(() => expect(sessionStore.startSession).toHaveBeenCalledWith('sess-vscode'));

        expect(sessionStore.setActiveSession).not.toHaveBeenCalledWith('sess-vscode');
        expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalledWith('sess-vscode', expect.anything());
        expect((window as any).__terminalAreaProps.showTerminal).toBe(false);
        expect(window.location.pathname).toBe('/app/');
        expect(openSpy).not.toHaveBeenCalled();

        resolveStart?.();
        await starting;
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
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
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess2', '1', expect.objectContaining({ id: 'sess2' }));
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

    it.each([{ herdrEnabled: true }, { defaultWorkspace: 'vscode' }])('does not submit a stale explicit Chat choice on create with settings %j', async preferences => {
      const { sessionStore } = await import('../../stores/session');
      mockPreferences = preferences;
      const id = 'abcdef0123456789';
      const session = createMockSession({ id, status: 'stopped', agentType: 'pi',
        workspace: 'defaultWorkspace' in preferences ? 'vscode' : 'terminal',
        terminalMode: 'herdrEnabled' in preferences ? 'herdr' : 'classic' }) as SessionWithStatus;
      vi.mocked(sessionStore.createSession).mockResolvedValue(session);
      vi.mocked(sessionStore.startSession).mockResolvedValue(undefined);
      render(() => <Layout />);
      await (window as any).__terminalAreaProps.onCreateSession('New Session', 'pi', undefined, 'chat');
      expect(sessionStore.createSession).toHaveBeenCalledWith('New Session', 'pi', undefined);
      expect(sessionStore.startSession).toHaveBeenCalledWith(id);
    });

    it.each([
      ['pi', 'terminal', ['chat']],
      ['bash', 'terminal', []],
      ['pi', 'vscode', []],
    ] as const)('uses the saved Vibe default only when the newly created %s workspace (%s) is eligible', async (agentType, workspace, startArgs) => {
      const { sessionStore } = await import('../../stores/session');
      mockPreferences = { defaultPiSurface: 'chat' };
      const id = 'abcdef0123456789';
      vi.mocked(sessionStore.createSession).mockResolvedValue(createMockSession({ id, status: 'stopped', agentType,
        workspace, terminalMode: 'classic' }) as SessionWithStatus);
      vi.mocked(sessionStore.startSession).mockResolvedValue(undefined);
      render(() => <Layout />);
      await (window as any).__terminalAreaProps.onCreateSession('New Session', agentType);
      expect(sessionStore.createSession).toHaveBeenCalledWith('New Session', agentType, undefined);
      expect(sessionStore.startSession).toHaveBeenCalledWith(id, ...startArgs);
    });

    it('preserves the last explicitly chosen agent when Vibe launches Pi', async () => {
      mockPreferences = { lastAgentType: 'bash', defaultPiSurface: 'chat' };
      const id = 'abcdef0123456789';
      vi.mocked(sessionStore.createSession).mockResolvedValue(createMockSession({ id, status: 'stopped', agentType: 'pi', workspace: 'terminal' }) as SessionWithStatus);
      vi.mocked(sessionStore.startSession).mockResolvedValue(undefined);
      render(() => <Layout />);
      await (window as any).__terminalAreaProps.onCreateSession('New Session', 'pi', undefined, 'chat', true);
      expect(sessionStore.startSession).toHaveBeenCalledWith(id, 'chat');
      expect(mockPreferences.lastAgentType).toBe('bash');
      expect(vi.mocked(sessionStore.updatePreferences).mock.calls.some(([prefs]) => prefs.lastAgentType !== undefined)).toBe(false);
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
      expect(terminalWorkspaceStore.setSingleSessionWorkspace).toHaveBeenCalledWith('sess-new', '1', expect.objectContaining({ id: 'sess-new' }));
      expect((window as any).__terminalAreaProps.showTerminal).toBe(true);
      expect((window as any).__terminalAreaProps.viewState).not.toBe('dashboard');

      resolveStart?.();
      await createPromise;
    });

    it('REQ-IDE-048 AC2: creating a VS Code session leaves terminal view and starts on dashboard', async () => {
      const { sessionStore } = await import('../../stores/session');
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];
      const newSession = createMockSession({
        id: 'sess-vscode', name: 'Editor Session', status: 'stopped', workspace: 'vscode',
      }) as SessionWithStatus;
      vi.mocked(sessionStore.createSession).mockImplementation(async () => {
        mockSessions = [...mockSessions, newSession];
        bumpSessionStoreVersion();
        return newSession;
      });
      let resolveStart: (() => void) | undefined;
      vi.mocked(sessionStore.startSession).mockImplementation(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      try {
        render(() => <Layout />);
        await waitFor(() => expect((window as any).__headerProps?.onCreateSession).toBeTypeOf('function'));

        const createPromise = (window as any).__headerProps.onCreateSession('Editor Session');
        await waitFor(() => expect(sessionStore.startSession).toHaveBeenCalledWith('sess-vscode'));

        expect(sessionStore.setActiveSession).toHaveBeenLastCalledWith(null);
        expect(mockActiveWorkspace).toEqual({ kind: 'dashboard' });
        expect(terminalWorkspaceStore.setSingleSessionWorkspace).not.toHaveBeenCalledWith('sess-vscode', expect.anything());
        expect((window as any).__terminalAreaProps.showTerminal).toBe(false);
        expect(window.location.pathname).toBe('/app/');
        expect(openSpy).not.toHaveBeenCalled();

        resolveStart?.();
        await createPromise;
        expect((window as any).__terminalAreaProps.showTerminal).toBe(false);
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }
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
  // REQ-SUB-018 AC1 / AC4 — usage quota banner surfacing + dismissibility
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

    it('REQ-SUB-018 AC5: a dismissed 95% warning also hides the lower 80% warning', () => {
      mockSaasMode = true;
      vi.mocked(getUsageWarningLevel).mockReturnValue('80');
      vi.mocked(getDismissedQuotaLevel).mockReturnValue('95');
      render(() => <Layout />);
      expect(screen.queryByTestId('usage-warning-80')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-95')).not.toBeInTheDocument();
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

    it('offers the subscription upgrade from the SaaS quota-exceeded banner', () => {
      mockSaasMode = true;
      vi.mocked(getUsageWarningLevel).mockReturnValue('100');
      vi.mocked(getDismissedQuotaLevel).mockReturnValue('95');

      render(() => <Layout />);

      const banner = screen.getByTestId('usage-warning-100');
      expect(banner).toBeVisible();
      expect(banner).toHaveTextContent('Monthly compute quota exceeded. Sessions cannot start until quota resets.');
      const upgrade = within(banner).getByRole('link', { name: 'Upgrade plan' });
      expect(upgrade).toBeVisible();
      expect(upgrade).toHaveAttribute('href', '/app/subscribe');
      expect(within(banner).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    });

    it('AC3: surfaces no usage banner outside SaaS mode even at 100% usage', () => {
      mockSaasMode = false;
      vi.mocked(getUsageWarningLevel).mockReturnValue('100');

      render(() => <Layout />);

      expect(screen.queryByTestId('usage-warning-80')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-95')).not.toBeInTheDocument();
      expect(screen.queryByTestId('usage-warning-100')).not.toBeInTheDocument();
      expect(screen.queryByText(/Monthly compute quota exceeded/)).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Upgrade plan' })).not.toBeInTheDocument();
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
  // REQ-VAULT-036 AC1 — vault open-intent is cleared when authoritative
  // session status says the target session has stopped. View departure alone
  // is not a stop and must preserve the running session's in-memory Vault state.
  // =========================================================================

  describe('REQ-VAULT-019 AC4 (vault open-intent clearing)', () => {
    it('REQ-VAULT-036 AC1: opening the Vault tab clears intent before a later readiness loss', async () => {
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      const openedUrls: string[] = [];
      const open = vi.spyOn(window, 'open').mockImplementation((url) => {
        openedUrls.push(String(url));
        return { closed: false } as Window;
      });

      try {
        render(() => <Layout />);
        vaultProbeMock.latestOptions.setLatch();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
        await (window as any).__headerProps.onVaultOpen();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('preparing'));
        const preparation = vaultPrewarmMock.latestOptions;
        preparation.onReady(vaultPrewarmProof);
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('armed'));

        await (window as any).__headerProps.onVaultOpen();
        expect(openedUrls).toEqual(['/api/vault/sess1/.codeflare-bootstrap']);
        expect((window as any).__headerProps.vaultStatus).toBe('armed');

        // A ready prewarm and a stale armed intent both look green. Drive a
        // late readiness error through the existing fixture callback so the
        // public state can distinguish them without reading the private signal.
        preparation.onError('error', 'late readiness loss');
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));
        expect((window as any).__headerProps.vaultReady).toBe(false);
        expect(openedUrls).toEqual(['/api/vault/sess1/.codeflare-bootstrap']);

        // No automatic reprepare/reopen: a fresh user gesture starts preparation
        // rather than opening again from the discarded armed intent.
        await (window as any).__headerProps.onVaultOpen();
        await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('preparing'));
        expect(openedUrls).toEqual(['/api/vault/sess1/.codeflare-bootstrap']);
      } finally {
        open.mockRestore();
      }
    });

    it('clears the open-intent (vaultStatus leaves "preparing") when the session stops', async () => {
      mockSessions = [createMockSession({ id: 'sess1', status: 'running' })];
      mockActiveSessionId = 'sess1';
      mockPreferences = { sessionMode: 'advanced' };
      mockActiveWorkspace = { kind: 'session', sessionId: 'sess1' };
      mockVisiblePanes = [{ sessionId: 'sess1', terminalId: '1' }];

      render(() => <Layout />);
      await waitFor(() => expect((window as any).__headerProps?.onVaultOpen).toBeTypeOf('function'));
      vaultProbeMock.latestOptions.setLatch();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('available'));

      // Click 1 starts the on-demand prepare; with the key unrecoverable the poll
      // never arms, so the button reflects 'preparing'.
      await (window as any).__headerProps.onVaultOpen();
      await waitFor(() => expect((window as any).__headerProps.vaultStatus).toBe('preparing'));

      // Authoritative session status, rather than active view selection, owns
      // cleanup. A real stop clears the pending intent and readiness state.
      mockSessions = [createMockSession({ id: 'sess1', status: 'stopped' })];
      bumpSessionStoreVersion();

      await waitFor(() => expect((window as any).__headerProps.vaultStatus).not.toBe('preparing'));
    });
  });

});
