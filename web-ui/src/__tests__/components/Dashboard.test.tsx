import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@solidjs/testing-library';
import { createRoot, createSignal } from 'solid-js';
import { mdiChevronDoubleLeft, mdiChevronDoubleRight, mdiReflectHorizontal, mdiViewCompactOutline, mdiXml } from '@mdi/js';
import Dashboard from '../../components/Dashboard';
import { createMigrationRetry, MigrationRetryNotice } from '../../components/MigrationRetryNotice';
import { sessionStore } from '../../stores/session';
import { storageStore } from '../../stores/storage';
import { githubStore } from '../../stores/github';
import * as storageApi from '../../api/storage';
import * as githubApi from '../../api/github';
import type { GithubRepo } from '../../api/github';
import { ApiError } from '../../api/fetch-helper';
import * as vaultCache from '../../lib/vault-cache';
import * as gravatar from '../../lib/gravatar';
import type { AgentType, SessionWithStatus } from '../../types';

const availabilityMock = vi.hoisted(() => ({
  set: undefined as undefined | ((unavailable: boolean) => void),
}));

const viewportMock = vi.hoisted(() => ({
  setViewport: undefined as undefined | ((viewport: 'mobile' | 'tablet' | 'desktop') => void),
}));

vi.mock('../../lib/mobile', async () => {
  const actual = await vi.importActual<typeof import('../../lib/mobile')>('../../lib/mobile');
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [viewport, setViewport] = createSignal<'mobile' | 'tablet' | 'desktop'>('desktop');
  viewportMock.setViewport = setViewport;
  return {
    ...actual,
    getTerminalViewportClass: viewport,
    createTerminalViewportClass: () => viewport,
  };
});

// Mock child components to isolate Dashboard testing
vi.mock('../../components/SessionStatCard', () => ({
  default: (props: any) => (
    <div data-testid={`session-card-${props.session.id}`}>
      <span data-testid="session-name">{props.session.name}</span>
      <button data-testid={`select-${props.session.id}`} onClick={props.onSelect}>Select</button>
      <button data-testid={`menu-${props.session.id}`} onClick={(event) => props.onMenuClick?.(event, props.session)}>Menu</button>
    </div>
  )
}));

vi.mock('../../components/ScrambleText', () => ({
  default: (props: any) => <span class={props.class}>{props.text}</span>
}));

vi.mock('../../components/StorageBrowser', () => ({
  default: () => <div data-testid="storage-browser" />
}));

// Stub GitHubPanel so its onMount status load does not run; expose the flip
// callback so the mobile face-swap can be exercised structurally.
vi.mock('../../components/github/GitHubPanel', () => ({
  default: (props: any) => (
    <div data-testid="github-panel-stub">
      <button data-testid="gh-stub-repo">Example repository</button>
      {props.onFlip && <button class="github-flip-btn" data-testid="gh-stub-flip" onClick={() => props.onFlip()}>Show storage</button>}
    </div>
  )
}));

const initialRepoPage = vi.hoisted(() => ({ page: 0, hasMore: false, loading: false, error: null as string | null, canRetryInitialRepos: false, repoErrorCode: undefined as string | undefined }));

// Controllable GitHub enablement for the right-column face logic. `enabled` is a real
// reactive signal so a test can flip it DURING mount (e.g. from inside loadStatus) and
// watch the GitHub face appear — proving the deadlock fix end-to-end, not just the call.
vi.mock('../../stores/github', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [enabled, setEnabled] = createSignal(false);
  const [login, setLogin] = createSignal<string>();
  const [source, setSource] = createSignal<'app' | 'oauth'>('oauth');
  const [repos, setRepos] = createSignal<GithubRepo[]>([]);
  const [repoPage, setRepoPage] = createSignal(initialRepoPage);
  return {
    githubStore: {
      get enabled() { return enabled(); },
      get connected() { return !!login(); },
      get login() { return login(); },
      get source() { return login() ? source() : undefined; },
      get repos() { return repos(); },
      get page() { return repoPage().page; },
      get hasMore() { return repoPage().hasMore; },
      get loading() { return repoPage().loading; },
      get error() { return repoPage().error; },
      get canRetryInitialRepos() { return repoPage().canRetryInitialRepos; },
      get repoErrorCode() { return repoPage().repoErrorCode; },
      _setEnabled: (v: boolean) => {
        setEnabled(v);
        if (!v) { setLogin(undefined); setSource('oauth'); setRepos([]); setRepoPage(initialRepoPage); }
      },
      _setRepoPage: setRepoPage,
      _setSource: setSource,
      _setLogin: setLogin,
      _setRepos: setRepos,
      // Dashboard kicks this off on mount to break the enabled-gates-the-panel
      // deadlock (status is loaded outside the gated GitHub panel).
      loadStatus: vi.fn(),
      retryInitialRepos: vi.fn(async () => {}),
    },
  };
});

vi.mock('../../components/StatCards', () => ({
  default: (props: any) => (
    <div data-testid="stat-cards" data-stats={JSON.stringify(props.stats)} />
  )
}));

vi.mock('../../components/FilePreview', () => ({
  default: (props: any) => (
    <div data-testid="file-preview">
      <button data-testid="fp-back" onClick={props.onBack}>Back</button>
      <button data-testid="fp-download" onClick={props.onDownload}>Download</button>
    </div>
  )
}));

vi.mock('../../components/Icon', () => ({
  default: (props: any) => <svg data-testid="icon" data-path={props.path}><path d={props.path} /></svg>
}));

vi.mock('../../components/SessionLimitPopup', () => ({
  default: (props: any) => {
    (window as any).__sessionLimitPopupProps = props;
    return (
      <div data-testid="session-limit-popup" data-open={props.isOpen}>
        <button data-testid="slp-dismiss" onClick={props.onClose}>Got it</button>
      </div>
    );
  }
}));

vi.mock('../../stores/session', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [sessions, setSessions] = createSignal<SessionWithStatus[]>([]);
  const [r2Ready, setR2Ready] = createSignal(true);
  const [statusUnavailable, setStatusUnavailable] = createSignal(false);
  availabilityMock.set = setStatusUnavailable;
  let _isAtLimit = false;
  let _maxSessions = 3;
  const [_preseedUpgrading, setPreseedUpgrading] = createSignal(false);
  const [bucketMigrating, setBucketMigrating] = createSignal(false);
  let _bucketMigrationPercent: number | null = null;
  const [bucketMigrationHaltedAt, setBucketMigrationHaltedAt] = createSignal<string | null>(null);
  const [_managedReleaseStatus, setManagedReleaseStatus] = createSignal<'current' | 'upgrading' | 'update_pending' | null>(null);
  let _managedReleaseProgress: { phase: 'planning' | 'writing' | 'finalizing'; completed: number; total: number } | null = null;
  let _enterpriseMode = false;
  let _sessionMode = 'advanced';
  let _herdrEnabled = false;
  let defaultWorkspace: 'terminal' | 'vscode' | undefined;
  let agents: AgentType[] | null = ['pi'];
  return {
    sessionStore: {
      get sessions() { return sessions(); },
      _setSessions: setSessions,
      cloneRepositoryIntoSession: vi.fn().mockResolvedValue({ outcome: 'cloned', path: '/home/user/workspace/newest' }),
      get maxSessions() { return _maxSessions; },
      get r2Ready() { return r2Ready(); },
      get statusUnavailable() { return statusUnavailable(); },
      get preseedUpgrading() { return _preseedUpgrading(); },
      preseedUpgradeFailed: false,
      managedReleaseBlockedReason: null,
      retryPreseedUpgrade: vi.fn().mockResolvedValue(undefined),
      refreshSessionAncillaryStatus: vi.fn().mockResolvedValue(undefined),
      runPreseedUpdate: vi.fn(async (operation: () => Promise<unknown>) => operation()),
      get bucketMigrating() { return bucketMigrating(); },
      get bucketMigrationPercent() { return _bucketMigrationPercent; },
      get bucketMigrationHaltedAt() { return bucketMigrationHaltedAt(); },
      get managedReleaseStatus() { return _managedReleaseStatus(); },
      get managedReleaseProgress() { return _managedReleaseProgress; },
      get enterpriseMode() { return _enterpriseMode; },
      get preferences() { return { sessionMode: _sessionMode, herdrEnabled: _herdrEnabled, defaultWorkspace }; },
      get allowedAgents() { return agents; },
      _setAllowedAgents: (value: AgentType[] | null) => { agents = value; },
      isAtSessionLimit: () => _isAtLimit,
      startR2Polling: vi.fn(),
      updatePreferences: vi.fn().mockResolvedValue(undefined),
      killSession: vi.fn().mockResolvedValue(undefined),
      _setSessionMode: (v: string) => { _sessionMode = v; },
      _setHerdrEnabled: (enabled: boolean) => { _herdrEnabled = enabled; },
      _setDefaultWorkspace: (workspace?: 'terminal' | 'vscode') => { defaultWorkspace = workspace; },
      _setTestLimit: (atLimit: boolean, max?: number) => {
        _isAtLimit = atLimit;
        if (max !== undefined) _maxSessions = max;
      },
      _setR2Ready: setR2Ready,
      _setPreseedUpgrading: (upgrading: boolean) => { setPreseedUpgrading(upgrading); },
      _setBucketMigrating: setBucketMigrating,
      _setBucketMigrationPercent: (v: number | null) => { _bucketMigrationPercent = v; },
      _setBucketMigrationHaltedAt: setBucketMigrationHaltedAt,
      _setManagedReleaseStatus: setManagedReleaseStatus,
      _setManagedReleaseProgress: (v: typeof _managedReleaseProgress) => { _managedReleaseProgress = v; },
      _setEnterpriseMode: (v: boolean) => { _enterpriseMode = v; },
    },
    isAtUsageQuota: () => false,
    getUsageState: () => ({ monthlySeconds: 0, monthlyQuotaSeconds: null }),
  };
});

let showRealCreateDialog = false;
vi.mock('../../components/CreateSessionDialog', async (importOriginal) => {
  const { default: RealDialog } = await importOriginal<typeof import('../../components/CreateSessionDialog')>();
  return { default: (props: any) => {
    if (showRealCreateDialog) return <RealDialog {...props} />;
    // Store props on window for inspection in tests
    (window as any).__createSessionDialogProps = props;
    return (
      <div data-testid="create-session-dialog" data-open={props.isOpen}>
        <button data-testid="csd-select-agent" onClick={() => props.onSelect('claude-code')}>
          Select Agent
        </button>
      </div>
    );
  } };
});

vi.mock('../../stores/storage', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [stats, setStats] = createSignal<unknown>(null);
  return {
    storageStore: {
      get stats() { return stats(); },
      get previewFile() { return null; },
      get downloadsDisabled() { return false; },
      get downloadsNoticeOpen() { return false; },
      showDownloadsNotice: vi.fn(),
      dismissDownloadsNotice: vi.fn(),
      fetchStats: vi.fn(),
      _setStats: setStats,
      closePreview: vi.fn(),
      searchFiles: vi.fn((query: string) => {
        if (query === 'test-file') {
          return { objects: [{ key: 'workspace/test-file.ts', size: 100, lastModified: '2024-01-01' }], prefixes: [] };
        }
        return { objects: [], prefixes: [] };
      }),
      browse: vi.fn(),
    }
  };
});

vi.mock('../../api/storage', () => ({
  getDownloadUrl: vi.fn(() => 'https://example.com/download'),
  recreateAgentConfigs: vi.fn(),
}));

const { retryBucketMigration } = vi.hoisted(() => ({
  retryBucketMigration: vi.fn<(haltedAt: string) => Promise<{ success: true }>>(),
}));
vi.mock('../../api/client', async original => ({
  ...await original<typeof import('../../api/client')>(),
  retryBucketMigration,
}));

vi.mock('../../lib/vault-cache', () => ({
  sweepOrphanVaultCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/operator-activities', async original => ({
  ...await original<typeof import('../../api/operator-activities')>(),
  listOperatorActivities: vi.fn().mockResolvedValue({ items: [] }),
  cancelOperatorActivity: vi.fn(),
}));

vi.mock('../../components/TipsRotator', () => ({
  default: () => <div data-testid="tips-card" />
}));

let mockMultiView: any = null;

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    reconcileMultiView: vi.fn(() => mockMultiView),
    openMultiView: vi.fn(() => true),
  },
}));

const githubFixture = githubStore as typeof githubStore & {
  _setRepos: (repos: GithubRepo[]) => void;
  _setRepoPage: (page: typeof initialRepoPage) => void;
};
const { _setSessions: setStoreSessions } = sessionStore as typeof sessionStore & {
  _setSessions: (sessions: SessionWithStatus[]) => void;
};
const newestRepo: GithubRepo = {
  name: 'newest', full_name: 'team/newest', owner: 'team', private: true,
  visibility: 'private', default_branch: 'trunk', updated_at: '2026-03-04T11:48:00Z',
};

const mockSessions: SessionWithStatus[] = [
  { id: 'sess1', name: 'Test Session 1', createdAt: '2024-01-15T10:00:00Z', lastAccessedAt: '2024-01-15T12:00:00Z', status: 'running' },
  { id: 'sess2', name: 'Test Session 2', createdAt: '2024-01-14T10:00:00Z', lastAccessedAt: '2024-01-14T12:00:00Z', status: 'stopped' },
];

// Test-local recovery fields keep this RED suite compilable before the public API lands.
const upgradeRecovery = sessionStore as typeof sessionStore & {
  preseedUpgradeFailed: boolean;
  retryPreseedUpgrade: () => Promise<void>;
};
const { _setBucketMigrationHaltedAt: setBucketMigrationHaltedAt } = sessionStore as typeof sessionStore & {
  _setBucketMigrationHaltedAt: (haltedAt: string | null) => void;
};

// REQ-ENTERPRISE-015: Enterprise-mode admin and dropdown suppressions
// REQ-VAULT-034: Legacy session vault marker cleanup

describe('Dashboard / REQ-SUB-019 (session limit popup in frontend)', () => {
  let noticeOverlay: HTMLElement;
  let migrationRetry: ReturnType<typeof createMigrationRetry>;
  let disposeMigrationRetry: () => void;
  const defaultProps = {
    get migrationRetry() { return migrationRetry; },
    sessions: mockSessions,
    onCreateSession: vi.fn(),
    onStartSession: vi.fn(),
    onOpenVscodeSession: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onOpenSessionById: vi.fn(),
    viewState: 'dashboard' as const,
    userName: 'nikola@novoselec.ch',
    onSettingsClick: vi.fn(),
  };

  beforeEach(() => {
    migrationRetry = createRoot(dispose => {
      disposeMigrationRetry = dispose;
      return createMigrationRetry();
    });
    vi.clearAllMocks();
    // clearAllMocks clears call history but NOT a queued mockImplementationOnce, so
    // reset loadStatus fully — otherwise an unconsumed once-impl from one test could
    // leak into the next. (The end-to-end deadlock test queues one such impl.)
    vi.mocked(githubStore.loadStatus).mockReset();
    vi.mocked(storageStore.fetchStats).mockReset();
    vi.mocked(sessionStore.startR2Polling).mockReset();
    vi.mocked(sessionStore.updatePreferences).mockReset().mockResolvedValue(undefined);
    vi.mocked(sessionStore.killSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(upgradeRecovery.retryPreseedUpgrade).mockReset().mockResolvedValue(undefined);
    upgradeRecovery.preseedUpgradeFailed = false;
    (sessionStore as { managedReleaseBlockedReason: 'runtime_incompatible' | null }).managedReleaseBlockedReason = null;
    vi.mocked(sessionStore.refreshSessionAncillaryStatus).mockReset().mockResolvedValue(undefined);
    vi.mocked(storageApi.recreateAgentConfigs).mockReset();
    retryBucketMigration.mockReset();
    (sessionStore as any)._setBucketMigrating(false);
    (sessionStore as any)._setBucketMigrationPercent(null);
    setBucketMigrationHaltedAt(null);
    (sessionStore as any)._setManagedReleaseStatus(null);
    (sessionStore as any)._setPreseedUpgrading(false);
    (storageStore as any)._setStats(null);
    (sessionStore as any)._setR2Ready(true);
    viewportMock.setViewport?.('desktop');
    availabilityMock.set?.(false);
  });

  afterEach(() => {
    cleanup();
    disposeMigrationRetry();
    vi.useRealTimers();
    (githubStore as any)._setEnabled(false);
    (sessionStore as any)._setEnterpriseMode(false);
    (sessionStore as any)._setSessionMode('advanced');
    (sessionStore as any)._setHerdrEnabled(false);
    (sessionStore as any)._setDefaultWorkspace();
    setStoreSessions([]);
    showRealCreateDialog = false;
    (sessionStore as any)._setManagedReleaseStatus(null);
    (sessionStore as any)._setManagedReleaseProgress(null);
    mockMultiView = null;
  });

  it.each(['desktop', 'mobile'] as const)('REQ-SESSION-010/029: %s announces unavailable status without replacing cards and clears on recovery', async viewport => {
    viewportMock.setViewport?.(viewport);
    render(() => <Dashboard {...defaultProps} />);
    availabilityMock.set?.(true);
    // Intentional availability-copy/accessibility contract, not a source or
    // implementation snapshot: retained cards are not presented as fresh data.
    const notice = await screen.findByText('Session status unavailable. Displayed state may be outdated.');
    expect(notice).toHaveAttribute('role', 'status');
    for (const session of mockSessions) expect(screen.getByTestId(`session-card-${session.id}`)).toBeInTheDocument();
    availabilityMock.set?.(false);
    await waitFor(() => expect(screen.queryByText('Session status unavailable. Displayed state may be outdated.')).not.toBeInTheDocument());
    for (const session of mockSessions) expect(screen.getByTestId(`session-card-${session.id}`)).toBeInTheDocument();
  });

  // === Deployment-mode account actions (REQ-SUB-023 AC2-AC7) ===

  it('shows Usage, Guided Setup, and Logout outside enterprise mode', () => {
    (sessionStore as any)._setEnterpriseMode(false);
    render(() => <Dashboard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.getByTestId('header-user-dropdown-usage')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
  });

  it('opens a Usage-only dropdown in enterprise mode', () => {
    (sessionStore as any)._setEnterpriseMode(true);
    render(() => <Dashboard {...defaultProps} />);
    expect(screen.getByTestId('header-user-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.getByTestId('header-user-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-usage')).toBeInTheDocument();
    expect(screen.queryByTestId('header-user-dropdown-profile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('header-user-dropdown-onboarding')).not.toBeInTheDocument();
    expect(screen.queryByTestId('header-user-dropdown-logout')).not.toBeInTheDocument();
  });

  it.each(['stopping', 'unreachable', 'starting'] as const)(
    'REQ-SESSION-035: offers non-deleting Stop recovery for a persisted %s dashboard session', status => {
      const stopped: string[] = [];
      render(() => <Dashboard {...defaultProps} sessions={[{
        id: 'recover', name: 'Recover', status, workspace: 'terminal',
        createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
      }]} onStopSession={id => stopped.push(id)}
        onDeleteSession={() => { throw Error('Stop recovery must not delete'); }} />);
      fireEvent.click(screen.getByTestId('menu-recover'));
      fireEvent.click(screen.getByRole('button', { name: status === 'stopping' ? 'Retry Stop' : 'Stop' }));
      expect(stopped).toEqual(['recover']);
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    },
  );

  it.each(['running', 'starting', 'unreachable', 'stopping'] as const)(
    'REQ-SESSION-038: dashboard KILL remains accessible for %s without entering the session', async status => {
      const killed: string[] = [];
      vi.mocked(sessionStore.killSession).mockImplementationOnce(async id => { killed.push(id); });
      render(() => <Dashboard {...defaultProps} sessions={[{
        id: 'recover', name: 'Recover', status, workspace: 'terminal',
        createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
      }, { id: 'untouched', name: 'Untouched', status: 'running', workspace: 'terminal',
        createdAt: '2024-01-01', lastAccessedAt: '2024-01-01' }]}
        onStartSession={() => { throw Error('KILL must not start a session'); }}
        onDeleteSession={() => { throw Error('KILL must not delete a session'); }} />);
      await fireEvent.click(screen.getByTestId('menu-recover'));
      // Intentional user action-order contract, shared with the in-session menu.
      expect([...screen.getByTestId('session-context-menu').querySelectorAll('button')]
        .map(button => button.textContent?.trim())).toEqual([
        'Rename', status === 'stopping' ? 'Retry Stop' : 'Stop', 'Kill', 'Delete',
      ]);
      await fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
      expect(killed).toEqual(['recover']);
      expect(screen.getByTestId('session-card-recover')).toBeInTheDocument();
      expect(screen.getByTestId('session-card-untouched')).toBeInTheDocument();
      expect(screen.queryByTestId('session-context-menu')).not.toBeInTheDocument();
    },
  );

  it('REQ-SESSION-038: dashboard does not offer KILL for a confirmed-stopped session', async () => {
    render(() => <Dashboard {...defaultProps} sessions={[{
      id: 'stopped', name: 'Stopped', status: 'stopped', workspace: 'terminal',
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }]} />);
    await fireEvent.click(screen.getByTestId('menu-stopped'));
    expect(screen.queryByRole('button', { name: 'Kill' })).not.toBeInTheDocument();
    expect(screen.getByTestId('context-menu-rename')).toBeInTheDocument();
    expect(screen.getByTestId('context-menu-delete')).toBeInTheDocument();
  });

  it.each(['stopped', 'running'] as const)('keeps lifecycle actions but no mode actions in a %s Pi card menu', async status => {
    const id = 'managed-pi';
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'terminal', onSelect: () => {} }} sessions={[{
      id, name: 'Managed Pi', status, workspace: 'terminal', agentType: 'pi', terminalMode: 'classic',
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }]} />);
    await fireEvent.click(screen.getByTestId(`menu-${id}`));
    const menu = within(screen.getByTestId('session-context-menu'));
    expect(menu.queryByRole('button', { name: /^(Start|Open) (Chat|Terminal)$/ })).not.toBeInTheDocument();
    expect(menu.getByRole('button', { name: 'Rename' })).toBeVisible();
    expect(menu.getByRole('button', { name: 'Delete' })).toBeVisible();
    if (status === 'running') expect(menu.getByRole('button', { name: 'Stop' })).toBeVisible();
    await fireEvent.click(screen.getByTestId(`select-${id}`));
    expect(defaultProps.onOpenSessionById).toHaveBeenCalledWith(id);
  });

  it.each(['Herdr', 'VS Code'])('keeps Classic Pi sessions reachable without offering mode actions under %s', async setting => {
    if (setting === 'Herdr') (sessionStore as any)._setHerdrEnabled(true);
    else (sessionStore as any)._setDefaultWorkspace('vscode');
    const id = 'managed-pi';
    render(() => <Dashboard {...defaultProps} sessions={[{
      id, name: 'Managed Pi', status: 'running', workspace: 'terminal', agentType: 'pi', terminalMode: 'classic',
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }]} />);
    await fireEvent.click(screen.getByTestId(`menu-${id}`));
    const menu = within(screen.getByTestId('session-context-menu'));
    expect(menu.queryByRole('button', { name: /\b(Chat|Terminal)\b/ })).not.toBeInTheDocument();
    expect(menu.getByRole('button', { name: 'Rename' })).toBeVisible();
    await fireEvent.click(screen.getByTestId(`select-${id}`));
    expect(defaultProps.onOpenSessionById).toHaveBeenCalledWith(id);
  });

  it.each([
    { agentType: 'bash', workspace: 'terminal', terminalMode: 'classic' },
    { agentType: 'pi', workspace: 'vscode', terminalMode: 'classic' },
    { agentType: 'pi', workspace: 'terminal', terminalMode: 'herdr' },
    { agentType: 'pi', workspace: 'terminal', terminalMode: 'classic', tabConfig: [{ id: '1', label: 'Terminal 1', command: '' }] },
  ] as const)('REQ-AGENT-272 AC1: omits handoff actions on an ineligible $agentType $workspace card', async ({ agentType, workspace, terminalMode, ...fields }) => {
    const id = 'ordinary';
    render(() => <Dashboard {...defaultProps} sessions={[{
      id, name: 'Ordinary session', status: 'running', workspace, agentType, terminalMode,
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01', editorReady: true,
      ...('tabConfig' in fields && fields.tabConfig && { tabConfig: [...fields.tabConfig] }),
    }]} />);

    await fireEvent.click(screen.getByTestId(`menu-${id}`));
    const menu = within(screen.getByTestId('session-context-menu'));
    expect(menu.queryByRole('button', { name: /\bChat\b/i })).not.toBeInTheDocument();
    expect(menu.queryByRole('button', { name: /\bTerminal\b/i })).not.toBeInTheDocument();
    expect(menu.getByRole('button', { name: 'Rename' })).toBeVisible();
  });

  it.each([false, true])('starts Pi from the agent picker without surface override buttons (Herdr: %s)', (enabled) => {
    (sessionStore as any)._setHerdrEnabled(enabled);
    showRealCreateDialog = true;
    render(() => <Dashboard {...defaultProps} workspaceMode={enabled ? undefined : { value: 'terminal', onSelect: () => {} }} />);
    fireEvent.click(screen.getByTestId('dashboard-new-session'));
    const dialog = within(screen.getByRole('dialog', { name: 'Create new session' }));
    expect(dialog.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument();
    fireEvent.click(dialog.getByTestId('csd-agent-pi'));
    expect(defaultProps.onCreateSession).toHaveBeenCalledWith('pi', undefined);
  });

  it('places the labeled desktop mode dropdown immediately before Profile', () => {
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'terminal', onSelect: () => {} }} />);
    const trigger = screen.getByRole('button', { name: 'Workspace mode: Code Mode' });
    expect(trigger).toHaveTextContent('Code Mode');
    const profile = screen.getByTestId('header-user-menu');
    const toolbarButtons = within(profile.closest('.header-actions') as HTMLElement).getAllByRole('button');
    expect(toolbarButtons[toolbarButtons.indexOf(profile) - 1]).toBe(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Vibe Mode' })).toBeVisible();
  });

  it('moves Dashboard Operators into Profile when its measured header is compact', async () => {
    (sessionStore as any)._setEnterpriseMode(true);
    let width = 300;
    const measurements: Array<() => void> = [];
    const layout = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 80 } as DOMRect);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { measurements.push(callback); }
      observe() {}
      disconnect() {}
    });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      expect(screen.queryByRole('button', { name: 'Operator activity' })).not.toBeInTheDocument();
      const profile = screen.getByTestId('header-user-menu');
      fireEvent.click(profile);
      const action = await within(screen.getByTestId('header-user-dropdown')).findByRole('button', { name: 'Operator activity' });
      fireEvent.click(action);
      const dialog = await screen.findByRole('dialog', { name: 'Operator activity' });
      expect(screen.queryByTestId('header-user-dropdown')).not.toBeInTheDocument();
      await waitFor(() => expect(dialog).toHaveFocus());
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close operators' }));
      expect(profile).toHaveFocus();
      width = 800;
      measurements.forEach(measure => measure());
      expect(screen.getByRole('button', { name: 'Operator activity' })).toBeVisible();
    } finally {
      cleanup();
      layout.mockRestore();
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each(['desktop', 'tablet'] as const)('discloses the existing GitHub and Storage browsers together in Vibe on %s', viewport => {
    viewportMock.setViewport?.(viewport);
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);

    const pull = screen.getByRole('button', { name: 'Show GitHub & Storage' });
    const browsers = screen.getByTestId('dashboard-panel-right');
    const github = screen.getByTestId('github-panel-stub');
    const storage = screen.getByTestId('storage-browser');
    expect(pull).toHaveAttribute('aria-expanded', 'false');
    expect(pull.querySelector('svg path')).toHaveAttribute('d', mdiChevronDoubleRight);
    expect(pull).toHaveAttribute('aria-controls', browsers.id);
    expect(browsers).toHaveAttribute('inert');
    expect(github).not.toBeVisible();
    expect(storage).not.toBeVisible();

    fireEvent.click(pull);
    expect(screen.getByRole('button', { name: 'Hide GitHub & Storage' })).toBe(pull);
    expect(pull).toHaveAttribute('aria-expanded', 'true');
    expect(pull.querySelector('svg path')).toHaveAttribute('d', mdiChevronDoubleLeft);
    expect(browsers).not.toHaveAttribute('inert');
    expect(github).toBeVisible();
    expect(storage).toBeVisible();
    fireEvent.click(pull);
    expect(pull).toHaveAttribute('aria-expanded', 'false');
    expect(browsers).toHaveAttribute('inert');
    expect(github).not.toBeVisible();
    expect(storage).not.toBeVisible();
  });

  it.each(['mobile', 'desktop'] as const)('only lets mobile Vibe pull the browsers open and closed (%s)', viewport => {
    viewportMock.setViewport?.(viewport);
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
    const page = screen.getByTestId('dashboard');
    page.style.overflowY = 'auto';
    Object.defineProperties(page, { clientHeight: { value: 250 }, scrollHeight: { value: 500 } });
    page.scrollTop = 100;
    const start = (x: number, y: number) => fireEvent.touchStart(page, { touches: [{ identifier: 1, clientX: x, clientY: y }] });
    const finish = (x: number, y: number) => {
      const point = { identifier: 1, clientX: x, clientY: y };
      fireEvent.touchMove(page, { touches: [point] });
      fireEvent.touchEnd(page, { changedTouches: [point] });
    };
    const closed = () => screen.getByRole('button', { name: 'Show GitHub & Storage' });
    start(100, 220);
    finish(100, 140);
    expect(closed()).toHaveAttribute('aria-expanded', 'false');
    page.scrollTop = 250;
    start(100, 220);
    finish(200, 190);
    expect(closed()).toHaveAttribute('aria-expanded', 'false');
    start(100, 220);
    finish(100, 140);
    if (viewport === 'mobile') {
      const open = () => screen.getByRole('button', { name: 'Hide GitHub & Storage' });
      expect(open()).toHaveAttribute('aria-expanded', 'true');
      start(100, 140);
      finish(100, 220);
      expect(open()).toHaveAttribute('aria-expanded', 'true');
      page.scrollTop = 0;
      start(100, 140);
      finish(100, 220);
    }
    expect(closed()).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses the existing single-face GitHub and Storage controls in the mobile Vibe drawer', async () => {
    viewportMock.setViewport?.('mobile');
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show GitHub & Storage' }));
    const storageHeading = () => screen.queryByRole('heading', { name: 'Storage Browser' });
    expect(storageHeading()).not.toBeInTheDocument();
    const showStorage = screen.getByRole('button', { name: 'Show storage' });
    showStorage.focus();
    fireEvent.click(showStorage, { detail: 0 });
    expect(screen.queryByRole('button', { name: 'Example repository' })).not.toBeInTheDocument();
    expect(storageHeading()).toBeVisible();
    const showGitHub = screen.getByRole('button', { name: 'Show GitHub' });
    await waitFor(() => expect(showGitHub).toHaveFocus());
    fireEvent.click(showGitHub, { detail: 0 });
    expect(screen.getByRole('button', { name: 'Example repository' })).toBeVisible();
    expect(storageHeading()).not.toBeInTheDocument();
    await waitFor(() => expect(showStorage).toHaveFocus());
    fireEvent.keyDown(showStorage, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Show GitHub & Storage' })).toHaveFocus();
  });

  it.each(['chat', 'terminal'] as const)('shows the Profile email only at the top of the open Dashboard menu in %s', mode => {
    const email = 'long.account.address.for.profile.acceptance@example.com';
    render(() => <Dashboard {...defaultProps} userName={email} workspaceMode={{ value: mode, onSelect: () => {} }} />);
    const profile = screen.getByRole('button', { name: 'User menu' });
    const verifyMenu = () => {
      expect(screen.queryByText(email)).not.toBeInTheDocument();
      fireEvent.click(profile);
      const menu = screen.getByTestId('header-user-dropdown');
      expect(within(menu).getByTitle(email)).toHaveTextContent(email);
      expect(within(menu).getByText(email)).toBeVisible();
      const actions = within(menu).getByRole('group', { name: 'Account actions' });
      expect(within(actions).queryByText(email)).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('header-user-dropdown-overlay'));
    };
    verifyMenu();
    if (mode === 'chat') {
      fireEvent.click(screen.getByRole('button', { name: 'Show Storage' }));
      verifyMenu();
    }
  });

  it('keeps Dashboard Profile actions reachable after the email is removed', () => {
    const [email, setEmail] = createSignal<string | undefined>('fixture@example.com');
    render(() => <Dashboard {...defaultProps} userName={email()} />);
    fireEvent.click(screen.getByRole('button', { name: 'User menu' }));
    expect(screen.getByText('fixture@example.com')).toBeVisible();
    setEmail(undefined);
    window.dispatchEvent(new Event('resize'));
    expect(screen.queryByText('fixture@example.com')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Account actions' })).getByRole('link', { name: /Usage/ })).toBeVisible();
  });

  it('closes the Vibe drawer from a focused browser and returns focus to the pull', () => {
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
    const pull = screen.getByRole('button', { name: 'Show GitHub & Storage' });
    fireEvent.click(pull);
    const browserControl = screen.getByTestId('gh-stub-repo');
    browserControl.focus();
    expect(browserControl).toHaveFocus();
    fireEvent.keyDown(browserControl, { key: 'Escape' });
    expect(pull).toHaveFocus();
    expect(pull).toHaveAttribute('aria-expanded', 'false');
    expect(browserControl).not.toBeVisible();
  });

  it('keeps the existing browser controls without a drawer pull in Code mode', () => {
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'terminal', onSelect: () => {} }} />);
    expect(screen.queryByRole('button', { name: 'Show GitHub & Storage' })).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-panel-right')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('github-panel-stub')).toBeInTheDocument();
    expect(screen.getByTestId('storage-browser')).toBeInTheDocument();
  });

  it('REQ-GITHUB-321: shows verified private, public and total repository counts in Vibe', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    githubFixture._setRepoPage({ ...initialRepoPage, page: 1 });
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts').mockResolvedValue({
      login: 'Octocat', counts: { private: 8, public: 3, total: 11 },
    });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      for (const [label, value] of [['Private repos', '8'], ['Public repos', '3'], ['Repos', '11']]) {
        const name = await details.findByText(label, { exact: true });
        expect(within(name.parentElement!).getByText(value, { exact: true })).toBeVisible();
      }
      expect(details.queryByText('NOTHING TO SHOW.')).not.toBeInTheDocument();
      expect(details.queryByText('GO BUILD SOMETHING.')).not.toBeInTheDocument();
    } finally { counts.mockRestore(); }
  });

  it.each([
    { counts: null },
    { login: 'hubot', counts: { public: 1, private: 2, total: 3 } },
  ])('REQ-GITHUB-321: shows the connected account and external profile without verified counts (%#)', async result => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts').mockResolvedValue(result);
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      const profile = await details.findByRole('link', { name: '@octocat' });
      expect(profile).toBeVisible();
      expect(details.queryByRole('link', { name: 'View GitHub profile' })).not.toBeInTheDocument();
      expect(profile).toHaveAttribute('href', 'https://github.com/octocat');
      expect(profile).toHaveAttribute('target', '_blank');
      expect(details.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
      expect(details.queryByRole('button', { name: 'Browse repositories' })).not.toBeInTheDocument();
      expect(details.queryByRole('button', { name: 'Click here to login with GitHub' })).not.toBeInTheDocument();
      await waitFor(() => expect(details.queryByText(/loading owned repository counts/i)).not.toBeInTheDocument());
      expect(details.queryByText(/^(?:Private repos|Public repos|Repos)$/)).not.toBeInTheDocument();
    } finally { counts.mockRestore(); }
  });

  it('REQ-GITHUB-327: shows the three latest valid repository shortcuts with their relative ages and no Start Chat action', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-04T12:00:00Z'));
    const requestUrl = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : input, window.location.href);
    const countsUrl = new URL('/api/github/owned-repo-counts', window.location.origin).href;
    let settleCounts!: (response: Response) => void;
    const pendingCounts = new Promise<Response>(resolve => { settleCounts = resolve; });
    const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = requestUrl(input);
      if (url.href === countsUrl) return pendingCounts;
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    });
    const repo = (name: string, updated_at: string): GithubRepo => ({
      ...newestRepo, name, owner: 'octocat', full_name: `octocat/${name}`, updated_at,
    });
    try {
      render(() => <Dashboard {...defaultProps} userName={undefined} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      expect(await details.findByText(/loading owned repository counts/i)).toBeVisible();
      expect(details.queryByText('NOTHING TO SHOW.')).not.toBeInTheDocument();
      githubFixture._setRepos([
        repo('older', '2026-02-28T12:00:00Z'), repo('third', '2026-03-01T12:00:00Z'), newestRepo,
        repo('invalid', 'not a date'), repo('second', '2026-03-04T07:00:00Z'),
      ]);
      const repoLinks = () => details.getAllByRole('link').filter(link => link !== details.getByRole('link', { name: '@octocat' }));
      expect(repoLinks()).toHaveLength(0);
      settleCounts(Response.json({ counts: null }));

      await details.findByRole('link', { name: 'team/newest' });
      const links = repoLinks();
      expect(links.map(link => link.textContent)).toEqual(['newest', 'second', 'third']);
      for (const [index, name, age] of [[0, 'team/newest', '12m ago'], [1, 'octocat/second', '5h ago'], [2, 'octocat/third', '3d ago']] as const) {
        expect(links[index]).toHaveAttribute('href', `https://github.com/${name}`);
        expect(links[index]).toHaveAccessibleName(name);
        expect(links[index]).toHaveAttribute('title', name);
        expect(links[index]).toHaveAttribute('target', '_blank');
        const label = `Clone into a session: ${name}`;
        const action = details.getByRole('button', { name: label });
        expect(action).toHaveAttribute('aria-label', label);
        expect(action).toHaveAttribute('title', 'Clone into a session');
        expect(action).toHaveTextContent(age);
      }
      expect(details.queryByRole('button', { name: /Start Chat/i })).not.toBeInTheDocument();
      expect(details.queryByText(/Start Chat/i)).not.toBeInTheDocument();

      // Suppress test-environment navigation, but let a click bubble to any card handler.
      const preventNavigation = (event: Event) => event.preventDefault();
      document.addEventListener('click', preventNavigation, { once: true });
      try { fireEvent.click(links[0]); }
      finally { document.removeEventListener('click', preventNavigation); }
      expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Clone repository' })).not.toBeInTheDocument();
      // The existing verified count read is allowed; repo shortcuts add no GitHub API reads.
      const githubRequests = requests.mock.calls.map(([input]) => requestUrl(input))
        .filter(({ pathname }) => pathname.startsWith('/api/github/'))
        .map(({ href }) => href);
      expect(githubRequests).toEqual([countsUrl]);
    } finally { requests.mockRestore(); clock.mockRestore(); }
  });

  it('REQ-GITHUB-327: the age action starts a Vibe session with the repository when no Pi session is running', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    githubFixture._setRepos([newestRepo]);
    const nonPiSessions = mockSessions.map(session => ({ ...session, agentType: 'codex' as const }));
    setStoreSessions(nonPiSessions);
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts').mockResolvedValue({ counts: null });
    try {
      render(() => <Dashboard {...defaultProps} sessions={nonPiSessions} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      fireEvent.click(await details.findByRole('button', { name: 'Clone into a session: team/newest' }));
      expect(defaultProps.onCreateSession).toHaveBeenCalledWith('pi', undefined, 'chat', true, 'team/newest');
      expect(screen.queryByRole('dialog', { name: 'Clone repository' })).not.toBeInTheDocument();
    } finally { counts.mockRestore(); }
  });

  it('REQ-GITHUB-327: the age action offers live and new sessions and clones into the selected live session', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    githubFixture._setRepos([newestRepo]);
    setStoreSessions([{ ...mockSessions[0]!, agentType: 'pi' },
      { ...mockSessions[1]!, status: 'running', agentType: 'codex' }]);
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts').mockResolvedValue({ counts: null });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      fireEvent.click(await details.findByRole('button', { name: 'Clone into a session: team/newest' }));
      const picker = within(await screen.findByRole('dialog', { name: 'Clone repository' }));
      expect(picker.getByText('Clone into a running session')).toBeVisible();
      expect(picker.getByText('Clone into a new session')).toBeVisible();
      expect(picker.getByRole('button', { name: /^New Pi session/ })).toBeEnabled();
      expect(picker.queryByRole('button', { name: /^Test Session 2|^Codex/ })).not.toBeInTheDocument();
      fireEvent.click(picker.getByRole('button', { name: /^Test Session 1\s*Running in Pi$/ }));
      expect(sessionStore.cloneRepositoryIntoSession).toHaveBeenCalledWith({ repo: 'team/newest', sessionId: 'sess1' });
      expect(screen.queryByRole('dialog', { name: 'Clone repository' })).not.toBeInTheDocument();
      expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
    } finally { counts.mockRestore(); }
  });

  it.each([
    initialRepoPage,
    { ...initialRepoPage, page: 1, loading: true },
    { ...initialRepoPage, page: 1, error: 'GitHub returned a server error' },
    { ...initialRepoPage, page: 1, hasMore: true },
  ])('REQ-GITHUB-327: only a settled empty repository list shows both empty-state lines (%#)', async page => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    githubFixture._setRepoPage(page);
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts').mockResolvedValue({ counts: null });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      await waitFor(() => expect(details.queryByText(/loading owned repository counts/i)).not.toBeInTheDocument());
      expect(details.queryByText('NOTHING TO SHOW.')).not.toBeInTheDocument();
      expect(details.queryByText('GO BUILD SOMETHING.')).not.toBeInTheDocument();

      githubFixture._setRepoPage({ ...initialRepoPage, page: 1 });
      expect(details.getByText('NOTHING TO SHOW.', { exact: true })).toBeVisible();
      expect(details.getByText('GO BUILD SOMETHING.', { exact: true })).toBeVisible();
    } finally { counts.mockRestore(); }
  });

  it('REQ-GITHUB-327: retries an unavailable list after Dashboard return and restores both empty lines', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts').mockResolvedValue({ counts: null });
    let finishRetry!: () => void;
    const pendingRetry = new Promise<void>(resolve => { finishRetry = resolve; });
    vi.mocked(githubStore.retryInitialRepos).mockImplementationOnce(async () => {
      githubFixture._setRepoPage({ ...initialRepoPage, loading: true });
      await pendingRetry;
      githubFixture._setRepoPage({ ...initialRepoPage, page: 1 });
    });
    try {
      githubFixture._setRepoPage({ ...initialRepoPage, loading: true });
      const firstVisit = render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      expect(await screen.findByText('Loading repositories…')).toBeVisible();
      firstVisit.unmount();

      vi.useFakeTimers();
      githubFixture._setRepoPage({ ...initialRepoPage, error: 'GitHub returned a server error', canRetryInitialRepos: true });
      const returnVisit = render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(details.getByText('CONNECTION TO GITHUB', { exact: true })).toBeVisible();
      expect(details.getByText('FAILED. RETRYING.', { exact: true })).toBeVisible();
      expect(details.queryByText('NOTHING TO SHOW.')).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5000);
      expect(details.getByText('CONNECTION TO GITHUB', { exact: true })).toBeVisible();
      expect(details.getByText('FAILED. RETRYING.', { exact: true })).toBeVisible();
      finishRetry();
      await vi.advanceTimersByTimeAsync(0);
      expect(details.queryByText('CONNECTION TO GITHUB')).not.toBeInTheDocument();
      expect(details.getByText('NOTHING TO SHOW.', { exact: true })).toBeVisible();
      expect(details.getByText('GO BUILD SOMETHING.', { exact: true })).toBeVisible();
      returnVisit.unmount();

      // The confirmed empty list is still usable while owned counts refresh.
      counts.mockImplementationOnce(() => new Promise(() => {}));
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const reopened = within(screen.getByRole('region', { name: 'GitHub Details' }));
      expect(reopened.getByText('NOTHING TO SHOW.', { exact: true })).toBeVisible();
      expect(reopened.getByText('GO BUILD SOMETHING.', { exact: true })).toBeVisible();
    } finally { vi.useRealTimers(); counts.mockRestore(); }
  });

  it('REQ-GITHUB-332: shows unavailable for a non-retryable list failure', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    githubFixture._setRepoPage({ ...initialRepoPage, error: 'Repository listing forbidden' });
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
    const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
    expect(await details.findByText('Repository shortcuts unavailable.')).toBeVisible();
    expect(details.queryByText('FAILED. RETRYING.')).not.toBeInTheDocument();
    expect(details.queryByText('NOTHING TO SHOW.')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-332: offers reconnection instead of retrying a disconnected repository list', async () => {
    vi.useFakeTimers();
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    githubFixture._setRepoPage({ ...initialRepoPage, error: 'GitHub is not connected', repoErrorCode: 'NOT_CONNECTED' });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      expect(details.getByRole('button', { name: 'Click here to login with GitHub' })).toBeVisible();
      await vi.advanceTimersByTimeAsync(5000);
      expect(details.queryByText('FAILED. RETRYING.')).not.toBeInTheDocument();
      expect(details.getByRole('button', { name: 'Click here to login with GitHub' })).toBeVisible();
    } finally { vi.useRealTimers(); }
  });

  it('announces a GitHub authorization failure while the Vibe drawer stays closed', async () => {
    (githubStore as any)._setEnabled(true);
    const previous = window.location.href;
    window.history.replaceState(window.history.state, '', '/app/?github=denied#dashboard');
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      expect(await details.findByRole('status')).toHaveTextContent('GitHub authorization was denied.');
      expect(screen.getByRole('button', { name: 'Show GitHub & Storage' })).toHaveAttribute('aria-expanded', 'false');
      expect(window.location.search).toBe('');
      expect(window.location.hash).toBe('#dashboard');
    } finally { window.history.replaceState(window.history.state, '', previous); }
  });

  it.each(['desktop', 'tablet', 'mobile'] as const)('adds half a New Session button height in both modes on %s', async viewport => {
    viewportMock.setViewport?.(viewport);
    (githubStore as any)._setEnabled(false);
    const previous = window.location.href;
    window.history.replaceState(window.history.state, '', '/app/?github=denied');
    const original = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'dashboard-new-session' ? new DOMRect(0, 0, 100, 40) : original.call(this);
    });
    try {
      const [mode, setMode] = createSignal<'chat' | 'terminal'>('chat');
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: mode(), onSelect: setMode }} />);
      const details = await screen.findByRole('region', { name: 'GitHub Details' });
      expect(within(details).getByRole('status')).toHaveTextContent('GitHub authorization was denied.');
      const padding = () => getComputedStyle(screen.getByTestId('dashboard-new-session').parentElement!).paddingBlockEnd;
      expect(padding()).toBe('20px');
      setMode('terminal');
      expect(padding()).toBe('20px');
    } finally {
      measure.mockRestore();
      window.history.replaceState(window.history.state, '', previous);
    }
  });

  it('sizes the Recent Sessions preview from the first four rendered cards', () => {
    (githubStore as any)._setEnabled(false);
    const cards = [48, 72, 60, 80];
    const sessions = cards.map((_, i) => ({ ...mockSessions[0]!, id: `preview-${i}` }));
    const [visible, setVisible] = createSignal(sessions.slice(0, 3));
    const resize = new EventTarget();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe() { resize.addEventListener('resize', this.callback); }
      disconnect() { resize.removeEventListener('resize', this.callback); }
    });
    const original = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = Number(this.dataset.testid?.split('session-card-preview-')[1]);
      return Number.isInteger(index) ? new DOMRect(0, cards.slice(0, index).reduce((sum, height) => sum + height + 8, 0), 200, cards[index]!) : original.call(this);
    });
    try {
      render(() => <Dashboard {...defaultProps} sessions={visible()} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const list = screen.getByTestId('session-card-preview-0').parentElement!;
      const previewHeight = () => list.style.getPropertyValue('--dashboard-session-limit');
      expect(previewHeight()).toBe('');
      setVisible(sessions);
      expect(previewHeight()).toBe('228px');
      cards[1] = 92;
      cards[3] = 100;
      resize.dispatchEvent(new Event('resize'));
      expect(previewHeight()).toBe('254px');
      fireEvent.click(screen.getByRole('button', { name: 'Show Storage' }));
      expect(previewHeight()).toBe('');
    } finally { measure.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('shows authoritative owned totals for a connected GitHub App account', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    (githubStore as any)._setSource('app');
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts')
      .mockResolvedValue({ login: 'octocat', counts: { private: 8, public: 3, total: 11 } });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      expect(await details.findByText('11', { exact: true })).toBeVisible();
    } finally { counts.mockRestore(); }
  });

  it('REQ-GITHUB-321: shows a verified public zero and omits unknown private and total counts', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    (githubStore as any)._setSource('app');
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts')
      .mockResolvedValue({ login: 'octocat', counts: { public: 0, private: null, total: null } });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      const publicLabel = await details.findByText('Public repos', { exact: true });
      expect(within(publicLabel.parentElement!).getByText('0', { exact: true })).toBeVisible();
      expect(details.queryByText(/^(?:Private repos|Repos|Unavailable)$/)).not.toBeInTheDocument();

      githubFixture._setRepoPage({ ...initialRepoPage, page: 1 });
      expect(details.getByText('NOTHING TO SHOW.')).toBeVisible();
      expect(details.getByText('GO BUILD SOMETHING.')).toBeVisible();
      expect(details.queryByText('Public repos', { exact: true })).not.toBeInTheDocument();
    } finally { counts.mockRestore(); }
  });

  it('clears previous repo counts while a different connected account loads', async () => {
    (githubStore as any)._setEnabled(true);
    (githubStore as any)._setLogin('octocat');
    const counts = vi.spyOn(githubApi, 'getGithubOwnedRepoCounts')
      .mockResolvedValueOnce({ login: 'octocat', counts: { private: 8, public: 3, total: 11 } })
      .mockImplementationOnce(() => new Promise(() => {}));
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      const details = within(screen.getByRole('region', { name: 'GitHub Details' }));
      expect(await details.findByText('11', { exact: true })).toBeVisible();
      (githubStore as any)._setLogin('hubot');
      expect(details.getByRole('link', { name: '@hubot' })).toBeVisible();
      expect(details.getByRole('status')).toHaveTextContent('Loading owned repository counts');
      expect(details.queryByText('11', { exact: true })).not.toBeInTheDocument();
    } finally { counts.mockRestore(); }
  });

  it('offers the existing GitHub connection flow from Vibe GitHub Details', async () => {
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
    const details = screen.getByRole('region', { name: 'GitHub Details' });
    fireEvent.click(within(details).getByRole('button', { name: 'Click here to login with GitHub' }));
    expect(await screen.findByTestId('github-tier-dialog')).toBeVisible();
  });

  it.each([false, true])('starts Pi Chat directly in Vibe unless the session limit is reached (%s)', atLimit => {
    showRealCreateDialog = true;
    (sessionStore as any)._setTestLimit(atLimit, 3);
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      fireEvent.click(screen.getByTestId('dashboard-new-session'));
      expect(screen.queryByRole('dialog', { name: 'Create new session' })).not.toBeInTheDocument();
      if (atLimit) expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
      else expect(defaultProps.onCreateSession).toHaveBeenCalledWith('pi', undefined, 'chat', true);
    } finally {
      (sessionStore as any)._setTestLimit(false);
    }
  });

  it.each([false, true])('REQ-IDE-048: New Session starts Pi directly in VS Code unless at the session limit (%s)', atLimit => {
    showRealCreateDialog = true;
    (sessionStore as any)._setDefaultWorkspace('vscode');
    (sessionStore as any)._setTestLimit(atLimit, 3);
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'terminal', onSelect: () => {} }} />);
      fireEvent.click(screen.getByTestId('dashboard-new-session'));
      expect(screen.queryByRole('dialog', { name: 'Create new session' })).not.toBeInTheDocument();
      if (atLimit) expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
      else expect(defaultProps.onCreateSession).toHaveBeenCalledExactlyOnceWith('pi', undefined, undefined, true);
    } finally {
      (sessionStore as any)._setTestLimit(false);
    }
  });

  it.each([{ agents: ['codex'] as const }, { agents: null }])('REQ-IDE-048: keeps the filtered VS Code picker without verified Pi (%j)', ({ agents }) => {
    showRealCreateDialog = true;
    (sessionStore as any)._setDefaultWorkspace('vscode');
    (sessionStore as any)._setAllowedAgents(agents ? [...agents] : null);
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'terminal', onSelect: () => {} }} />);
      fireEvent.click(screen.getByTestId('dashboard-new-session'));
      const picker = within(screen.getByRole('dialog', { name: 'Create new session' }));
      expect(picker.queryByRole('button', { name: /^Pi/ })).not.toBeInTheDocument();
      expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
      if (agents) {
        fireEvent.click(picker.getByRole('button', { name: /^Codex/ }));
        expect(defaultProps.onCreateSession).toHaveBeenCalledWith('codex', undefined);
      } else expect(picker.queryAllByRole('button')).toHaveLength(0);
    } finally { (sessionStore as any)._setAllowedAgents(['pi']); }
  });

  // === Initialization Tests ===

  it('REQ-IDE-049 AC1 / REQ-IDE-054 AC1: starts a stopped VS Code session from the whole card', () => {
    const sessions: SessionWithStatus[] = [{
      id: 'editor', name: 'Editor', workspace: 'vscode', status: 'stopped',
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }];
    render(() => <Dashboard {...defaultProps} sessions={sessions} />);

    fireEvent.click(screen.getByTestId('select-editor'));

    expect(defaultProps.onStartSession).toHaveBeenCalledWith('editor');
    expect(defaultProps.onOpenVscodeSession).not.toHaveBeenCalled();
    expect(defaultProps.onOpenSessionById).not.toHaveBeenCalledWith('editor');
  });

  it('REQ-SESSION-010 AC5 / REQ-AGENT-175 AC3: unreachable ready editor opens during pending update without starting', () => {
    (sessionStore as any)._setManagedReleaseStatus('update_pending');
    render(() => <Dashboard {...defaultProps} sessions={[{
      id: 'editor', name: 'Editor', workspace: 'vscode', status: 'unreachable', editorReady: true,
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }]} />);
    fireEvent.click(screen.getByTestId('select-editor'));
    expect(defaultProps.onOpenVscodeSession).toHaveBeenCalledWith('editor');
    expect(defaultProps.onStartSession).not.toHaveBeenCalled();
  });

  it('REQ-IDE-054 AC3: opens from the whole card only after editor readiness', () => {
    const sessions: SessionWithStatus[] = [{
      id: 'editor', name: 'Editor', workspace: 'vscode', status: 'running', editorReady: false,
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }];
    render(() => <Dashboard {...defaultProps} sessions={sessions} />);

    fireEvent.click(screen.getByTestId('select-editor'));
    expect(defaultProps.onOpenVscodeSession).not.toHaveBeenCalled();
    expect(defaultProps.onOpenSessionById).not.toHaveBeenCalledWith('editor');

    cleanup();
    render(() => <Dashboard {...defaultProps} sessions={[{ ...sessions[0], editorReady: true }]} />);
    fireEvent.click(screen.getByTestId('select-editor'));
    expect(defaultProps.onOpenVscodeSession).toHaveBeenCalledWith('editor');
    expect(defaultProps.onOpenSessionById).not.toHaveBeenCalledWith('editor');
  });

  it('REQ-IDE-049 AC2: editor failure exposes Retry plus Stop and Delete operations', () => {
    const sessions: SessionWithStatus[] = [{
      id: 'editor', name: 'Editor', workspace: 'vscode', status: 'error', editorReadyError: true,
      createdAt: '2024-01-01', lastAccessedAt: '2024-01-01',
    }];
    render(() => <Dashboard {...defaultProps} sessions={sessions} />);

    fireEvent.click(screen.getByTestId('select-editor'));
    expect(defaultProps.onStartSession).toHaveBeenCalledWith('editor');

    fireEvent.click(screen.getByTestId('menu-editor'));
    expect(screen.getByTestId('context-menu-stop')).toBeInTheDocument();
    expect(screen.getByTestId('context-menu-delete')).toBeInTheDocument();
  });

  it('REQ-TERM-012: keeps MultiView virtual and opens it from the dashboard icon action', () => {
    mockMultiView = {
      id: 'multiview:1',
      name: 'MultiView #1',
      memberSessionIds: ['sess1', 'sess2'],
      focusedSessionId: 'sess1',
      layout: '2-split',
    };

    const onOpenMultiView = vi.fn();
    render(() => <Dashboard {...defaultProps} onOpenMultiView={onOpenMultiView} />);

    expect(screen.getByTestId('session-card-sess1')).toBeInTheDocument();
    expect(screen.getByTestId('session-card-sess2')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-multiview-card')).not.toBeInTheDocument();

    const action = screen.getByTestId('dashboard-multiview-action');
    expect(action).toHaveAttribute('aria-label', 'Open MultiView');
    expect(action.querySelector('path')?.getAttribute('d')).toBe(mdiViewCompactOutline);

    fireEvent.click(action);
    expect(onOpenMultiView).toHaveBeenCalledTimes(1);
    expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
    expect(defaultProps.onOpenSessionById).not.toHaveBeenCalledWith('multiview:1');
  });

  it('REQ-TERM-013: reconciles MultiView against the current viewport after resize', async () => {
    render(() => <Dashboard {...defaultProps} />);

    const store = await import('../../stores/terminal-workspace');
    vi.mocked(store.terminalWorkspaceStore.reconcileMultiView).mockClear();

    viewportMock.setViewport?.('mobile');

    await waitFor(() => {
      expect(store.terminalWorkspaceStore.reconcileMultiView).toHaveBeenCalledWith(expect.any(Array), 'mobile');
    });
  });

  it('REQ-STOR-006 AC3: renders storage statistics returned by the mount refresh', () => {
    const refreshedStats = { totalSize: 4096, objectCount: 7, folderCount: 2 };
    vi.mocked(storageStore.fetchStats).mockImplementationOnce(async () => {
      (storageStore as any)._setStats(refreshedStats);
    });

    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('stat-cards')).toHaveAttribute('data-stats', JSON.stringify(refreshedStats));
  });

  it('REQ-STOR-001: transitions from storage setup to the browser when mount polling reports ready', async () => {
    vi.mocked(sessionStore.startR2Polling).mockImplementationOnce(async () => {
      (sessionStore as any)._setR2Ready(false);
      setTimeout(() => (sessionStore as any)._setR2Ready(true), 0);
    });

    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('storage-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-browser')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('storage-browser')).toBeInTheDocument());
    expect(screen.queryByTestId('storage-skeleton')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-007: loads GitHub status from the Dashboard on mount so the enabled-gated GitHub panel is not deadlocked', () => {
    render(() => <Dashboard {...defaultProps} />);

    // Status load is kicked off OUTSIDE the gated GitHub panel — otherwise an enabled
    // instance would never set `enabled`, so its panel (and connect card) never appears.
    expect(githubStore.loadStatus).toHaveBeenCalledTimes(1);
  });

  it('REQ-GITHUB-007: the Dashboard-triggered status load that enables GitHub reveals the GitHub face (deadlock fix, end-to-end)', () => {
    // Start disabled (the deadlock state: if status only loaded inside the gated panel
    // the face would never appear). The mocked loadStatus stands in for the real one —
    // when the Dashboard calls it on mount it flips enabled false→true, exactly as the
    // real store does after GET /status — and the GitHub face must then appear as default.
    (githubStore as any)._setEnabled(false);
    (githubStore.loadStatus as any).mockImplementationOnce(() => { (githubStore as any)._setEnabled(true); });
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    expect(right.querySelector('.panel-flip-face--github')).not.toBeNull();
    expect(right.getAttribute('data-face')).toBe('github');
  });

  it('does not sweep Vault IndexedDB caches from the non-authoritative dashboard session props', () => {
    render(() => <Dashboard {...defaultProps} sessions={[]} />);

    expect(vaultCache.sweepOrphanVaultCaches).not.toHaveBeenCalled();
  });

  // === Structural Tests ===

  it('renders dashboard-floating-panel (single floating panel)', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('dashboard-floating-panel')).toBeInTheDocument();
  });

  it('does NOT render old dashboard-panels container', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.queryByTestId('dashboard-panels')).not.toBeInTheDocument();
  });

  it('does NOT render splash-cursor (moved to Layout)', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.queryByTestId('splash-cursor')).not.toBeInTheDocument();
  });

  it('renders integrated header with logo text "Codeflare"', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByText('Codeflare')).toBeInTheDocument();
  });

  it('REQ-AUTH-017 AC1: renders the Gravatar belonging to the dashboard user', async () => {
    const probe = vi.spyOn(gravatar, 'gravatarExists').mockResolvedValue(true);
    try {
      render(() => <Dashboard {...defaultProps} userName="user@example.com" />);
      expect(await screen.findByRole('img', { name: 'Avatar' })).toHaveAttribute(
        'src', 'https://www.gravatar.com/avatar/b58996c504c5638798eb6b511e6f49af?s=48&d=404',
      );
      fireEvent.click(screen.getByRole('button', { name: 'User menu' }));
      expect(within(screen.getByTestId('header-user-dropdown')).getByText('user@example.com')).toBeVisible();
    } finally { probe.mockRestore(); }
  });

  it('REQ-SUB-019 AC2: the real limit popup shows counts and progress and dismisses without per-session actions', async () => {
    const { default: SessionLimitPopup } = await vi.importActual<typeof import('../../components/SessionLimitPopup')>('../../components/SessionLimitPopup');
    const { createSignal } = await import('solid-js');
    const [open, setOpen] = createSignal(true);
    render(() => <SessionLimitPopup isOpen={open()} onClose={() => setOpen(false)} sessionsRunning={2} sessionsLimit={3} />);
    const dialog = screen.getByRole('dialog', { name: 'Session limit reached' });
    expect(dialog).toHaveTextContent('You are running 2 of 3 allowed sessions.');
    expect(dialog.querySelector('.slp-progress-fill')).toHaveStyle({ width: '67%' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /stop|delete/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders settings button in panel header', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('dashboard-settings-button')).toBeInTheDocument();
  });

  // === REQ-OPERATOR-040 AC1: dashboard operator control ===

  it('REQ-OPERATOR-040 AC1: places the operator control between the user menu and settings in enterprise mode', () => {
    (sessionStore as any)._setEnterpriseMode(true);
    render(() => <Dashboard {...defaultProps} />);

    const user = screen.getByTestId('header-user-menu');
    const operator = screen.getByRole('button', { name: 'Operator activity' });
    const settings = screen.getByTestId('dashboard-settings-button');
    expect(user.compareDocumentPosition(operator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(operator.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('REQ-OPERATOR-040 AC1: opens the operator overview panel from the dashboard control', async () => {
    (sessionStore as any)._setEnterpriseMode(true);
    render(() => <Dashboard {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Operator activity' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Operators' })).toBeInTheDocument();
  });

  it('REQ-OPERATOR-040 AC1: hides the operator control outside enterprise mode', () => {
    (sessionStore as any)._setEnterpriseMode(false);
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.queryByRole('button', { name: 'Operator activity' })).not.toBeInTheDocument();
  });

  it('renders user dropdown menu when avatar clicked', () => {
    render(() => <Dashboard {...defaultProps} />);

    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.getByTestId('header-user-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
  });

  it('renders tips rotator in left column', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('tips-card')).toBeInTheDocument();
  });

  it('renders "+ New Session" button in left column', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('dashboard-new-session')).toBeInTheDocument();
  });

  it('renders session cards in left column', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('session-card-sess1')).toBeInTheDocument();
    expect(screen.getByTestId('session-card-sess2')).toBeInTheDocument();
  });

  it('renders StorageBrowser in right column', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('storage-browser')).toBeInTheDocument();
  });

  it('renders StatCards in footer', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('stat-cards')).toBeInTheDocument();
  });

  it('left column has dashboard-panel-left class', () => {
    render(() => <Dashboard {...defaultProps} />);

    const left = screen.getByTestId('dashboard-panel-left');
    expect(left.classList.contains('dashboard-panel-left')).toBe(true);
  });

  it('right column has dashboard-panel-right class', () => {
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    expect(right.classList.contains('dashboard-panel-right')).toBe(true);
  });

  // === Mobile right-column flip face (REQ-GITHUB-010) ===

  it('REQ-GITHUB-002 AC5: flips one GitHub/storage face at a time on mobile', () => {
    const RealRO = (globalThis as any).ResizeObserver;
    const RealRAF = globalThis.requestAnimationFrame;
    const RealCAF = globalThis.cancelAnimationFrame;
    const realInnerWidth = window.innerWidth;
    class CapRO { observe() {} unobserve() {} disconnect() {} }
    (globalThis as any).ResizeObserver = CapRO;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (globalThis as any).cancelAnimationFrame = () => {};
    (window as any).innerWidth = 500;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.matches('.panel-flip-face') ? 180 : 0 } as DOMRect;
    });
    try {
      viewportMock.setViewport?.('mobile');
      (githubStore as any)._setEnabled(true);
      const [mode, setMode] = createSignal<'terminal' | 'chat'>('terminal');
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: mode(), onSelect: setMode }} />);

      const right = screen.getByTestId('dashboard-panel-right') as HTMLElement;
      const githubFace = right.querySelector('.panel-flip-face--github')!;
      const storageFace = right.querySelector('.panel-flip-face--storage')!;
      expect(right.getAttribute('data-layout')).toBe('flip');
      expect(right.style.height).toBe('180px');
      expect(githubFace.getAttribute('data-active')).toBe('true');
      expect(storageFace.getAttribute('data-active')).toBe('false');

      fireEvent.click(screen.getByTestId('gh-stub-flip'));
      expect(githubFace.getAttribute('data-active')).toBe('false');
      expect(storageFace.getAttribute('data-active')).toBe('true');

      fireEvent.click(screen.getByTestId('storage-flip-btn'));
      expect(githubFace.getAttribute('data-active')).toBe('true');
      expect(storageFace.getAttribute('data-active')).toBe('false');

      setMode('chat');
      fireEvent.click(screen.getByRole('button', { name: 'Show GitHub & Storage' }));
      expect(right.style.height).toBe('180px');
      expect(screen.getByRole('button', { name: 'Example repository' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Show storage' }));
      expect(screen.queryByRole('button', { name: 'Example repository' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show GitHub' })).toBeVisible();
    } finally {
      bounds.mockRestore();
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (globalThis as any).cancelAnimationFrame = RealCAF;
      (window as any).innerWidth = realInnerWidth;
    }
  });

  it('REQ-GITHUB-010: forces the storage face active when GitHub is disabled so the empty GitHub panel cannot cover R2', () => {
    (githubStore as any)._setEnabled(false);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    // GitHub unavailable: its face is not rendered at all, so it cannot cover R2.
    expect(right.querySelector('.panel-flip-face--github')).toBeNull();
    const storageFace = right.querySelector('.panel-flip-face--storage')!;
    expect(storageFace.getAttribute('data-active')).toBe('true');
    expect(right.getAttribute('data-face')).toBe('storage');
    // Nothing to flip to, so no "Show GitHub" back control is offered.
    expect(screen.queryByTestId('storage-flip-btn')).not.toBeInTheDocument();
    // No GitHub panel => the storage panel carries no STORAGE header either
    // (the header is the parity row that only exists in enterprise mode).
    expect(screen.queryByTestId('files-panel-title')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-010: defaults to the GitHub face and offers the storage back-button when GitHub is enabled', () => {
    viewportMock.setViewport?.('mobile');
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    const githubFace = right.querySelector('.panel-flip-face--github')!;
    const storageFace = right.querySelector('.panel-flip-face--storage')!;
    expect(githubFace.getAttribute('data-active')).toBe('true');
    expect(storageFace.getAttribute('data-active')).toBe('false');
    expect(right.getAttribute('data-face')).toBe('github');
    expect(screen.getByTestId('storage-flip-btn')).toBeInTheDocument();
    // The storage panel gets a STORAGE header mirroring the GitHub panel header.
    expect(screen.getByTestId('files-panel-title')).toBeInTheDocument();
    expect(screen.getByTestId('files-panel-header')).toBeInTheDocument();
  });

  it('REQ-GITHUB-007: renders the GitHub face as the default for a standard (non-advanced, non-enterprise) session whenever GitHub is enabled — no session-tier gate', () => {
    (githubStore as any)._setEnabled(true);
    (sessionStore as any)._setSessionMode('standard'); // not advanced, not enterprise
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    // The GitHub face is rendered and leads — the advanced/enterprise gate is gone,
    // so a plain enabled session still gets the GitHub browser (connect card included).
    expect(right.querySelector('.panel-flip-face--github')).not.toBeNull();
    expect(right.getAttribute('data-face')).toBe('github');
    expect(screen.queryByTestId('storage-flip-btn')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-007: shows the GitHub face for an enterprise session regardless of session mode', () => {
    (githubStore as any)._setEnabled(true);
    (sessionStore as any)._setSessionMode('standard');
    (sessionStore as any)._setEnterpriseMode(true);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    expect(right.querySelector('.panel-flip-face--github')).not.toBeNull();
    expect(right.getAttribute('data-face')).toBe('github');
  });

  it('REQ-GITHUB-010: flips GitHub <-> storage when enabled and the flip controls are used', async () => {
    viewportMock.setViewport?.('mobile');
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    const showStorage = screen.getByTestId('gh-stub-flip');
    showStorage.focus();
    fireEvent.click(showStorage, { detail: 0 });
    expect(right.getAttribute('data-face')).toBe('storage');
    const showGitHub = screen.getByTestId('storage-flip-btn');
    await waitFor(() => expect(showGitHub).toHaveFocus());
    fireEvent.click(showGitHub, { detail: 0 });
    expect(right.getAttribute('data-face')).toBe('github');
    await waitFor(() => expect(showStorage).toHaveFocus());
  });

  it('REQ-GITHUB-010: wires the re-measure observers on the column box + row mutations, never watching the max-height (style) it writes (loop-free observer config)', () => {
    const roTargets: Element[] = [];
    const moCalls: Array<{ target: Element; options?: MutationObserverInit }> = [];
    const RealRO = (globalThis as any).ResizeObserver;
    const RealMO = (globalThis as any).MutationObserver;
    class SpyRO { observe(el: Element) { roTargets.push(el); } unobserve() {} disconnect() {} }
    class SpyMO {
      observe(el: Element, options?: MutationObserverInit) { moCalls.push({ target: el, options }); }
      disconnect() {} takeRecords() { return [] as MutationRecord[]; }
    }
    (globalThis as any).ResizeObserver = SpyRO;
    (globalThis as any).MutationObserver = SpyMO;
    try {
      (githubStore as any)._setEnabled(true);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right');
      const githubFace = right.querySelector('.panel-flip-face--github')!;
      const storageFace = right.querySelector('.panel-flip-face--storage')!;

      // The re-measure IS wired — gutting the observers entirely must fail this test.
      expect(roTargets).toContain(right);
      const columnMO = moCalls.filter((c) => c.target === right);
      expect(columnMO.length).toBeGreaterThan(0);

      // ...but never resize-observe the faces whose max-height we set: a ResizeObserver
      // on a face we resize WOULD fire on our own writes (a loop edge we must not add).
      expect(roTargets).not.toContain(githubFace);
      expect(roTargets).not.toContain(storageFace);

      // The column MutationObserver watches row add/remove only, NEVER attributes —
      // the max-height we write is a style attribute, so attribute observation would
      // feed our own writes back as re-measures.
      for (const c of columnMO) {
        expect(c.options?.childList).toBe(true);
        expect(c.options?.attributes).not.toBe(true);
      }
    } finally {
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).MutationObserver = RealMO;
    }
  });

  it('REQ-GITHUB-010: applies the measured natural height as a face max-height, holds steady on a redundant observer callback, and updates only when content height changes (behavioral fixed point — proves no thrash)', () => {
    let natural = 300;
    let roCb: () => void = () => {};
    const measuredWith = { maxHeight: '', flex: '', flexGrow: '' };
    const RealRO = (globalThis as any).ResizeObserver;
    const RealRAF = globalThis.requestAnimationFrame;
    const RealCAF = globalThis.cancelAnimationFrame;
    const origGBCR = HTMLElement.prototype.getBoundingClientRect;
    class CapRO { constructor(cb: () => void) { roCb = cb; } observe() {} unobserve() {} disconnect() {} }
    (globalThis as any).ResizeObserver = CapRO;
    // Run the rAF-debounced measure synchronously so we can drive it deterministically.
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (globalThis as any).cancelAnimationFrame = () => {};
    // Stub the face's content height, AND capture its style at the moment it is
    // measured — so we can prove measureNatural actually neutralized the face
    // (dropped max-height + flex) before reading the box. Asserting only the height
    // would still pass if the neutralization were removed; capturing the style makes
    // the test fail when the fix is reverted.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.classList?.contains('panel-flip-face--github')) {
        measuredWith.maxHeight = this.style.maxHeight;
        measuredWith.flex = this.style.flex;
        measuredWith.flexGrow = this.style.flexGrow;
      }
      return { height: natural, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    try {
      (githubStore as any)._setEnabled(true);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right');
      const githubFace = right.querySelector('.panel-flip-face--github') as HTMLElement;

      // Initial measure applied the natural content height...
      expect(githubFace.style.maxHeight).toBe('300px');
      // ...and it measured UNCONSTRAINED — proving the production fixed point rather
      // than assuming it (fails if measureNatural stops neutralizing the face).
      expect(measuredWith.maxHeight).toBe('none');
      expect(measuredWith.flex === '0 0 auto' || measuredWith.flexGrow === '0').toBe(true);
      // Redundant observer callback, unchanged content: stays put (idempotent / no thrash).
      natural = 300;
      roCb();
      expect(githubFace.style.maxHeight).toBe('300px');
      // Content grew: the next callback re-measures and updates.
      natural = 400;
      roCb();
      expect(githubFace.style.maxHeight).toBe('400px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGBCR;
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (globalThis as any).cancelAnimationFrame = RealCAF;
    }
  });

  it('REQ-GITHUB-010: sizes the GitHub face to its FULL list content (chrome + scroller.scrollHeight), not the collapsed scroller box — a long repo list is never undercounted', () => {
    let roCb: () => void = () => {};
    const CHROME = 120;    // header + search: the face box minus the (collapsed) scroller box
    const CONTENT = 1200;  // full scroll content of a long repo list (e.g. 20 rows)
    const RealRO = (globalThis as any).ResizeObserver;
    const RealRAF = globalThis.requestAnimationFrame;
    const RealCAF = globalThis.cancelAnimationFrame;
    const origGBCR = HTMLElement.prototype.getBoundingClientRect;
    class CapRO { constructor(cb: () => void) { roCb = cb; } observe() {} unobserve() {} disconnect() {} }
    (globalThis as any).ResizeObserver = CapRO;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (globalThis as any).cancelAnimationFrame = () => {};
    // Under the neutralized (flex:0 0 auto) measure the overflow:auto list lays out
    // COLLAPSED: the face box reports only its chrome and the scroller box reports ~0,
    // while the list's true height lives in scrollHeight. measureNatural must add
    // scrollHeight — reading the collapsed box is the undercount that showed 2 of 20 repos.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = this.classList?.contains('github-repo-rows')
        ? 0
        : this.classList?.contains('panel-flip-face--github')
          ? CHROME
          : 0;
      return { height, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    try {
      (githubStore as any)._setEnabled(true);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right');
      const githubFace = right.querySelector('.panel-flip-face--github') as HTMLElement;
      // The real GitHubPanel renders `.github-repo-rows`; the stub omits it, so inject
      // the scroller with a large scroll content but a collapsed laid-out box.
      const scroller = document.createElement('div');
      scroller.className = 'github-repo-rows';
      Object.defineProperty(scroller, 'scrollHeight', { value: CONTENT, configurable: true });
      githubFace.appendChild(scroller);
      // Re-measure now that the list content exists.
      roCb();
      // chrome (120) + full content (1200) = 1320 — NOT the collapsed 120-only box.
      expect(githubFace.style.maxHeight).toBe(`${CHROME + CONTENT}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGBCR;
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (globalThis as any).cancelAnimationFrame = RealCAF;
    }
  });

  it('REQ-GITHUB-010: sizes the Storage face to its full list content (chrome + scroller.scrollHeight) via the .storage-drop-zone selector', () => {
    let roCb: () => void = () => {};
    const CHROME = 90;
    const CONTENT = 1500;
    const RealRO = (globalThis as any).ResizeObserver;
    const RealRAF = globalThis.requestAnimationFrame;
    const RealCAF = globalThis.cancelAnimationFrame;
    const origGBCR = HTMLElement.prototype.getBoundingClientRect;
    class CapRO { constructor(cb: () => void) { roCb = cb; } observe() {} unobserve() {} disconnect() {} }
    (globalThis as any).ResizeObserver = CapRO;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (globalThis as any).cancelAnimationFrame = () => {};
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = this.classList?.contains('storage-drop-zone')
        ? 0
        : this.classList?.contains('panel-flip-face--storage')
          ? CHROME
          : 0;
      return { height, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    try {
      (githubStore as any)._setEnabled(true);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right');
      const storageFace = right.querySelector('.panel-flip-face--storage') as HTMLElement;
      const scroller = document.createElement('div');
      scroller.className = 'storage-drop-zone';
      Object.defineProperty(scroller, 'scrollHeight', { value: CONTENT, configurable: true });
      storageFace.appendChild(scroller);
      roCb();
      expect(storageFace.style.maxHeight).toBe(`${CHROME + CONTENT}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGBCR;
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (globalThis as any).cancelAnimationFrame = RealCAF;
    }
  });

  it('REQ-GITHUB-010: GitHub unavailable → GitHub face is not rendered and Storage is the sole face with no max-height cap (single-panel fills the full-height column)', () => {
    let roCb: () => void = () => {};
    const RealRO = (globalThis as any).ResizeObserver;
    const RealRAF = globalThis.requestAnimationFrame;
    const RealCAF = globalThis.cancelAnimationFrame;
    class CapRO { constructor(cb: () => void) { roCb = cb; } observe() {} unobserve() {} disconnect() {} }
    (globalThis as any).ResizeObserver = CapRO;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (globalThis as any).cancelAnimationFrame = () => {};
    try {
      (githubStore as any)._setEnabled(false);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right');
      // No empty GitHub face left in the column to push Storage down...
      expect(right.querySelector('.panel-flip-face--github')).toBeNull();
      // ...and Storage carries no measured cap, so it fills the full-height column
      // instead of capping to its content and pinning to the bottom with a gap above.
      const storageFace = right.querySelector('.panel-flip-face--storage') as HTMLElement;
      expect(storageFace).not.toBeNull();
      roCb();
      expect(storageFace.style.maxHeight).toBe('');
    } finally {
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (globalThis as any).cancelAnimationFrame = RealCAF;
    }
  });

  it.each(['desktop', 'tablet'] as const)('updates the open Vibe browser split as content changes on %s', async viewport => {
    viewportMock.setViewport?.(viewport);
    (githubStore as any)._setEnabled(true);
    let githubHeight = 180;
    let storageHeight = 580;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.matches('.panel-flip-face--github') ? githubHeight
        : this.matches('.panel-flip-face--storage') ? storageHeight : 0;
      return { height } as DOMRect;
    });
    try {
      render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'chat', onSelect: () => {} }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Show GitHub & Storage' }));
      const browsers = screen.getByTestId('dashboard-panel-right');
      const github = browsers.querySelector<HTMLElement>('.panel-flip-face--github');
      const storage = browsers.querySelector<HTMLElement>('.panel-flip-face--storage');
      const repo = document.createElement('div');
      repo.textContent = 'Sample repository';
      screen.getByTestId('github-panel-stub').append(repo);
      await waitFor(() => {
        expect(github).toHaveStyle({ maxHeight: '180px' });
        expect(storage).toHaveStyle({ maxHeight: '580px' });
      });
      githubHeight = 560;
      storageHeight = 150;
      const nextRepo = document.createElement('div');
      nextRepo.textContent = 'Another repository';
      repo.after(nextRepo);
      await waitFor(() => {
        expect(github).toHaveStyle({ maxHeight: '560px' });
        expect(storage).toHaveStyle({ maxHeight: '150px' });
      });
    } finally {
      cleanup();
      bounds.mockRestore();
    }
  });

  it.each(['desktop', 'tablet'] as const)('REQ-GITHUB-010: keeps both Code browsers without flip controls on %s', viewport => {
    viewportMock.setViewport?.(viewport);
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} workspaceMode={{ value: 'terminal', onSelect: () => {} }} />);
    expect(screen.getByTestId('github-panel-stub')).toBeVisible();
    expect(screen.getByTestId('storage-browser')).toBeVisible();
    expect(screen.queryByTestId('gh-stub-flip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('storage-flip-btn')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-012: sizes each mobile flip face to its own capped content height', () => {
    viewportMock.setViewport?.('mobile');
    const RealRAF = globalThis.requestAnimationFrame;
    const RealCAF = globalThis.cancelAnimationFrame;
    const origGBCR = HTMLElement.prototype.getBoundingClientRect;
    const realInnerWidth = window.innerWidth;
    const realInnerHeight = window.innerHeight;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (globalThis as any).cancelAnimationFrame = () => {};
    (window as any).innerWidth = 500;
    (window as any).innerHeight = 400;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = this.classList?.contains('panel-flip-face--github') ? 180
        : this.classList?.contains('panel-flip-face--storage') ? 420 : 0;
      return { height, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
    try {
      (githubStore as any)._setEnabled(true);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right') as HTMLElement;
      expect(right.style.height).toBe('180px');
      fireEvent.click(screen.getByTestId('gh-stub-flip'));
      expect(right.style.height).toBe('300px');
      (window as any).innerHeight = 600;
      window.dispatchEvent(new Event('resize'));
      expect(right.style.height).toBe('420px');
      fireEvent.click(screen.getByTestId('storage-flip-btn'));
      expect(right.style.height).toBe('180px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGBCR;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (globalThis as any).cancelAnimationFrame = RealCAF;
      (window as any).innerWidth = realInnerWidth;
      (window as any).innerHeight = realInnerHeight;
    }
  });

  // === Expansion Tests ===

  it('adds dashboard-floating-panel--expanded class when viewState is expanding', () => {
    render(() => <Dashboard {...defaultProps} viewState="expanding" />);

    const panel = screen.getByTestId('dashboard-floating-panel');
    expect(panel.classList.contains('dashboard-panel--expanded')).toBe(true);
  });

  it('does NOT have --expanded class when viewState is dashboard', () => {
    render(() => <Dashboard {...defaultProps} viewState="dashboard" />);

    const panel = screen.getByTestId('dashboard-floating-panel');
    expect(panel.classList.contains('dashboard-panel--expanded')).toBe(false);
  });

  it('starts with --expanded class when viewState is collapsing, removes on next frame', async () => {
    render(() => <Dashboard {...defaultProps} viewState="collapsing" />);

    const panel = screen.getByTestId('dashboard-floating-panel');
    // Immediately after render, --expanded should be present (collapsing starts from expanded state)
    expect(panel.classList.contains('dashboard-panel--expanded')).toBe(true);

    // Wait for the double-rAF to fire and remove the class
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    expect(panel.classList.contains('dashboard-panel--expanded')).toBe(false);
  });

  // === Interaction Tests ===

  it('REQ-SESSION-016 AC5: Dashboard mount sends the browser timezone and stays usable after rejection', async () => {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const timezone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ ...resolved, timeZone: 'Europe/Zurich' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[] = [];
    const created: unknown[][] = [];
    vi.mocked(sessionStore.updatePreferences).mockImplementationOnce(async prefs => {
      updates.push(prefs);
      throw new Error('Preference service unavailable');
    });
    try {
      render(() => <Dashboard {...defaultProps} onCreateSession={(...args) => { created.push(args); }} />);
      await waitFor(() => expect(updates).toEqual([{ userTimezone: 'Europe/Zurich' }]));
      // Let the actual best-effort helper handle the rejection, then exercise a real dashboard action.
      await Promise.resolve();
      fireEvent.click(screen.getByTestId('dashboard-new-session'));
      expect(screen.getByTestId('create-session-dialog').getAttribute('data-open')).toBe('true');
      fireEvent.click(screen.getByTestId('csd-select-agent'));
      expect(created).toEqual([['claude-code', undefined]]);
      expect(screen.getByTestId('dashboard-new-session')).toBeDefined();
    } finally {
      timezone.mockRestore();
      warning.mockRestore();
    }
  });

  it('REQ-ENTERPRISE-304: New Session opens the creation dialog when storage is ready and not migrating', () => {
    render(() => <Dashboard {...defaultProps} userName={undefined} />);

    expect(screen.queryByRole('button', { name: 'Retry migration' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create new session' }));

    const dialog = screen.getByTestId('create-session-dialog');
    expect(dialog).toHaveAttribute('data-open', 'true');
  });

  it('calls onCreateSession when agent is selected from dialog', () => {
    const onCreateSession = vi.fn();
    render(() => <Dashboard {...defaultProps} onCreateSession={onCreateSession} />);

    fireEvent.click(screen.getByTestId('dashboard-new-session'));
    fireEvent.click(screen.getByTestId('csd-select-agent'));

    expect(onCreateSession).toHaveBeenCalledWith('claude-code', undefined);
  });

  it('calls onOpenSessionById when session card selected', () => {
    const onOpenSessionById = vi.fn();
    render(() => <Dashboard {...defaultProps} onOpenSessionById={onOpenSessionById} />);

    fireEvent.click(screen.getByTestId('select-sess1'));

    expect(onOpenSessionById).toHaveBeenCalledWith('sess1');
  });

  it('calls onSettingsClick when settings button clicked', () => {
    const onSettingsClick = vi.fn();
    render(() => <Dashboard {...defaultProps} onSettingsClick={onSettingsClick} />);

    fireEvent.click(screen.getByTestId('dashboard-settings-button'));

    expect(onSettingsClick).toHaveBeenCalledTimes(1);
  });

  it('renders KittScanner inside the dashboard panel so it sits on the header, not above the centered panel', () => {
    render(() => <Dashboard {...defaultProps} />);

    const panel = screen.getByTestId('dashboard-floating-panel');
    const kittScanner = panel.querySelector('.kitt-scanner');
    expect(kittScanner).toBeInTheDocument();
    // Anchored to the panel (its parent), not the full-height wrapper — otherwise the
    // absolute scanner floats in the empty space above the now content-sized panel.
    expect(kittScanner?.parentElement).toBe(panel);
  });

  it('should use mdiXml icon path for the header logo (not mdiBrain)', () => {
    render(() => <Dashboard {...defaultProps} />);

    const logo = document.querySelector('.header-logo');
    expect(logo).toBeInTheDocument();
    const icon = logo?.querySelector('svg[data-path]');
    expect(icon).toBeInTheDocument();
    expect(icon?.getAttribute('data-path')).toBe(mdiXml);
  });

  it('logout dropdown item redirects to /auth/logout', () => {
    const originalLocation = window.location;
    const mockLocation = { ...originalLocation, href: '', origin: 'https://codeflare.example.com' };
    Object.defineProperty(window, 'location', { value: mockLocation, writable: true });

    render(() => <Dashboard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('header-user-menu'));
    fireEvent.click(screen.getByTestId('header-user-dropdown-logout'));

    expect(mockLocation.href).toBe('/auth/logout');

    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  // === Session Limit Tests ===

  it('REQ-SUB-013 AC3 / REQ-SUB-019: shows limit feedback without opening the create dialog', () => {
    (sessionStore as any)._setTestLimit(true, 3);
    render(() => <Dashboard {...defaultProps} />);

    fireEvent.click(screen.getByTestId('dashboard-new-session'));

    const popup = screen.getByTestId('session-limit-popup');
    expect(popup.getAttribute('data-open')).toBe('true');

    const dialog = screen.getByTestId('create-session-dialog');
    expect(dialog.getAttribute('data-open')).toBe('false');

    // Reset
    (sessionStore as any)._setTestLimit(false);
  });

  it('shows CreateSessionDialog when under limit', () => {
    (sessionStore as any)._setTestLimit(false, 3);
    render(() => <Dashboard {...defaultProps} />);

    fireEvent.click(screen.getByTestId('dashboard-new-session'));

    const dialog = screen.getByTestId('create-session-dialog');
    expect(dialog.getAttribute('data-open')).toBe('true');

    const popup = screen.getByTestId('session-limit-popup');
    expect(popup.getAttribute('data-open')).toBe('false');
  });

  it('applies limited CSS class when at session limit', () => {
    (sessionStore as any)._setTestLimit(true, 3);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn.classList.contains('dashboard-new-session-btn--limited')).toBe(true);

    // Reset
    (sessionStore as any)._setTestLimit(false);
  });

  // === R2 Readiness Tests ===

  it('should disable New Session button when r2Ready is false', () => {
    (sessionStore as any)._setR2Ready(false);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn).toBeDisabled();

    // Reset
    (sessionStore as any)._setR2Ready(true);
  });

  it('should enable New Session button when r2Ready is true', () => {
    (sessionStore as any)._setR2Ready(true);
    (sessionStore as any)._setTestLimit(false);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn).not.toBeDisabled();
  });

  it('should show storage skeleton when r2Ready is false', () => {
    (sessionStore as any)._setR2Ready(false);
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('storage-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-browser')).not.toBeInTheDocument();

    // Reset
    (sessionStore as any)._setR2Ready(true);
  });

  it('should show StorageBrowser when r2Ready is true', () => {
    (sessionStore as any)._setR2Ready(true);
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('storage-browser')).toBeInTheDocument();
    expect(screen.queryByTestId('storage-skeleton')).not.toBeInTheDocument();
  });

  // REQ-AGENT-049: preseed upgrade UI lockdown
  it('should disable new session button and show Updating during preseed upgrade', () => {
    (sessionStore as any)._setPreseedUpgrading(true);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toBe('Updating');
    expect(btn).toHaveAttribute('aria-label', 'Updating session environment');

    cleanup();
    (sessionStore as any)._setPreseedUpgrading(false);
  });

  it('should show normal button text when preseed upgrade is not running', () => {
    (sessionStore as any)._setPreseedUpgrading(false);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn.textContent).toBe('+ New Session');

    cleanup();
  });

  it('disables New Session while a managed release is update_pending', () => {
    (sessionStore as any)._setManagedReleaseStatus('update_pending');
    render(() => <Dashboard {...defaultProps} />);

    const button = screen.getByTestId('dashboard-new-session');
    expect(button).toBeDisabled();
    expect(button.textContent).toBe('Update pending');
    expect(button).toHaveAttribute('aria-label', 'Session environment update pending until session stops');
  });

  it.each([null, 'runtime_incompatible'] as const)('REQ-STOR-023 AC5 / REQ-AGENT-175: preserves the existing pending state without a separate recovery panel (%s)', (reason) => {
    (sessionStore as any)._setManagedReleaseStatus('update_pending');
    (sessionStore as { managedReleaseBlockedReason: 'runtime_incompatible' | null }).managedReleaseBlockedReason = reason;
    render(() => <Dashboard {...defaultProps} sessions={[]} />);

    const button = screen.getByTestId('dashboard-new-session');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Update pending');
    expect(button).toHaveAttribute('aria-label', 'Session environment update pending until session stops');
    expect(screen.queryByText('Update blocked')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check update status' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Stop any sessions/)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByTestId('create-session-dialog')).toHaveAttribute('data-open', 'false');
  });

  it('REQ-AGENT-175: the existing pending control advances through managed updating to ready', async () => {
    (sessionStore as any)._setManagedReleaseStatus('update_pending');
    render(() => <Dashboard {...defaultProps} sessions={[]} />);
    expect(screen.getByTestId('dashboard-new-session')).toBeDisabled();
    expect(screen.getByTestId('dashboard-new-session')).toHaveTextContent('Update pending');

    (sessionStore as any)._setManagedReleaseStatus('upgrading');
    await waitFor(() => expect(screen.getByTestId('dashboard-new-session')).toHaveTextContent('Upgrading'));
    expect(screen.getByTestId('dashboard-new-session')).toBeDisabled();

    (sessionStore as any)._setManagedReleaseStatus('current');
    await waitFor(() => expect(screen.getByTestId('dashboard-new-session')).toBeEnabled());
    expect(screen.getByTestId('dashboard-new-session')).toHaveTextContent('+ New Session');
    expect(screen.getByTestId('create-session-dialog')).toHaveAttribute('data-open', 'false');
  });

  it('REQ-AGENT-049: offers an actionable Retry upgrade after failure without creating a session or full Recreate', () => {
    upgradeRecovery.preseedUpgradeFailed = true;
    (sessionStore as any)._setPreseedUpgrading(false);
    (sessionStore as any)._setManagedReleaseStatus('upgrading');
    (sessionStore as any)._setManagedReleaseProgress({ phase: 'finalizing', completed: 61, total: 61 });
    render(() => <Dashboard {...defaultProps} sessions={[]} />);

    const retry = screen.getByRole('button', { name: /retry upgrade/i });
    expect(retry).toBeEnabled();
    expect(retry).toHaveTextContent('Retry upgrade');
    fireEvent.click(retry);

    expect(upgradeRecovery.retryPreseedUpgrade).toHaveBeenCalledTimes(1);
    expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-session-dialog')).toHaveAttribute('data-open', 'false');
    expect(storageApi.recreateAgentConfigs).not.toHaveBeenCalled();
    expect(screen.getByTestId('storage-browser')).toBeInTheDocument();
  });

  it('REQ-AGENT-213: recovery backup uses the existing full Recreate operation without retry or session creation', async () => {
    upgradeRecovery.preseedUpgradeFailed = true;
    vi.mocked(storageApi.recreateAgentConfigs).mockResolvedValue({ success: true, bucketCreated: false, written: ['file'], skipped: [], deleted: ['old-file'] });
    render(() => <Dashboard {...defaultProps} sessions={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Recreate Agent Skills & Rules' }));

    await waitFor(() => expect(storageApi.recreateAgentConfigs).toHaveBeenCalledTimes(1));
    expect(sessionStore.runPreseedUpdate).toHaveBeenCalledWith(storageApi.recreateAgentConfigs);
    expect(await screen.findByText('Recreated 1 agent config file(s). Removed 1 file(s) from previous mode.')).toHaveRole('status');
    expect(upgradeRecovery.retryPreseedUpgrade).not.toHaveBeenCalled();
    expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
  });

  it('REQ-AGENT-213: recovery hides during an update and returns after settlement', async () => {
    upgradeRecovery.preseedUpgradeFailed = true;
    let finish!: () => void;
    vi.mocked(storageApi.recreateAgentConfigs).mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ success: true, bucketCreated: false, written: [], skipped: [], deleted: [] });
    }));
    render(() => <Dashboard {...defaultProps} sessions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recreate Agent Skills & Rules' }));
    // The store's exclusion is covered by its real-store test. Drive its public
    // reactive state here to verify the dashboard's in-flight presentation.
    (sessionStore as any)._setPreseedUpgrading(true);
    expect(screen.queryByRole('button', { name: 'Recreate Agent Skills & Rules' })).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-new-session')).toBeDisabled();
    finish();
    expect(await screen.findByText('Recreated 0 agent config file(s).')).toHaveRole('status');
    (sessionStore as any)._setPreseedUpgrading(false);
    expect(screen.getByRole('button', { name: 'Recreate Agent Skills & Rules' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retry upgrade' })).toBeEnabled();
  });

  it('REQ-AGENT-213: recovery backup exposes Recreate failure and allows another explicit attempt', async () => {
    upgradeRecovery.preseedUpgradeFailed = true;
    vi.mocked(storageApi.recreateAgentConfigs).mockRejectedValueOnce(new Error('Storage unavailable'));
    render(() => <Dashboard {...defaultProps} sessions={[]} />);
    const button = screen.getByRole('button', { name: 'Recreate Agent Skills & Rules' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable'));
    expect(button).toBeEnabled();
    expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
  });

  it.each(['normal', 'in-flight', 'pending', 'migration'] as const)('REQ-AGENT-213: hides Recreate backup outside Retry upgrade state (%s)', (state) => {
    upgradeRecovery.preseedUpgradeFailed = state !== 'normal';
    (sessionStore as any)._setPreseedUpgrading(state === 'in-flight');
    (sessionStore as any)._setManagedReleaseStatus(state === 'pending' ? 'update_pending' : null);
    (sessionStore as any)._setBucketMigrating(state === 'migration');
    render(() => <Dashboard {...defaultProps} />);
    expect(screen.queryByRole('button', { name: 'Recreate Agent Skills & Rules' })).not.toBeInTheDocument();
  });

  it.each(['in-flight upgrade', 'update_pending'] as const)('REQ-STOR-037: Retry upgrade cannot bypass %s gating', (blockedBy) => {
    upgradeRecovery.preseedUpgradeFailed = true;
    (sessionStore as any)._setPreseedUpgrading(blockedBy === 'in-flight upgrade');
    (sessionStore as any)._setManagedReleaseStatus(blockedBy === 'update_pending' ? 'update_pending' : 'upgrading');
    render(() => <Dashboard {...defaultProps} sessions={[]} />);

    const retry = screen.queryByRole('button', { name: /retry upgrade/i });
    if (retry) expect(retry).toBeDisabled();
    expect(screen.getByTestId('dashboard-new-session')).toBeDisabled();
    if (blockedBy === 'update_pending') {
      expect(screen.getByTestId('dashboard-new-session')).toHaveTextContent('Update pending');
    }
    expect(upgradeRecovery.retryPreseedUpgrade).not.toHaveBeenCalled();
    expect(defaultProps.onCreateSession).not.toHaveBeenCalled();
    expect(storageApi.recreateAgentConfigs).not.toHaveBeenCalled();
  });

  it('REQ-AGENT-175 AC7: whole-button managed upgrade progress preserves centered text and ordinary completion color', () => {
    (sessionStore as any)._setManagedReleaseStatus('upgrading');
    render(() => <Dashboard {...defaultProps} />);

    const starting = screen.getByTestId('dashboard-new-session');
    expect(starting.textContent).toBe('Upgrading');
    expect(starting.getAttribute('style')).toContain('color-mix(in srgb, var(--color-accent) 72%, black) 0%');

    cleanup();
    (sessionStore as any)._setManagedReleaseProgress({ phase: 'writing', completed: 25, total: 100 });
    render(() => <Dashboard {...defaultProps} />);

    const button = screen.getByTestId('dashboard-new-session');
    expect(button).toBeDisabled();
    expect(button.textContent).toBe('Upgrading 25 / 100');
    expect(button).toHaveAttribute('aria-label', 'Upgrading managed resources, 25 of 100 complete');
    expect(button.getAttribute('style')).toContain('linear-gradient');
    expect(button.getAttribute('style')).toContain('var(--color-accent) 0%');
    expect(button.getAttribute('style')).toContain('var(--color-accent) 25%');
    expect(button.querySelector('[role="progressbar"]')).toBeNull();

    cleanup();
    (sessionStore as any)._setManagedReleaseProgress({ phase: 'writing', completed: 100, total: 100 });
    render(() => <Dashboard {...defaultProps} />);
    const complete = screen.getByTestId('dashboard-new-session');
    expect(complete.getAttribute('style')).toContain('var(--color-accent) 100%');
  });

  it('REQ-AGENT-175 AC6: shows planning and finalizing managed upgrade phases', () => {
    (sessionStore as any)._setManagedReleaseStatus('upgrading');
    (sessionStore as any)._setManagedReleaseProgress({ phase: 'planning', completed: 0, total: 0 });
    render(() => <Dashboard {...defaultProps} />);

    const planning = screen.getByTestId('dashboard-new-session');
    expect(planning.textContent).toBe('Upgrading');
    expect(planning).toHaveAttribute('aria-label', 'Upgrading managed resources');
    expect(planning.getAttribute('style')).toContain('color-mix(in srgb, var(--color-accent) 72%, black) 0%');

    cleanup();
    (sessionStore as any)._setManagedReleaseProgress({ phase: 'finalizing', completed: 100, total: 100 });
    render(() => <Dashboard {...defaultProps} />);

    const finalizing = screen.getByTestId('dashboard-new-session');
    expect(finalizing.textContent).toBe('Finalizing');
    expect(finalizing).toHaveAttribute('aria-label', 'Finalizing managed resources');
  });

  // REQ-ENTERPRISE-021 AC3: Governed Mode migrating-button label
  it('REQ-ENTERPRISE-021 AC3: disables the button and shows "Migrating" when migrating with no percent known yet', () => {
    (sessionStore as any)._setBucketMigrating(true);
    (sessionStore as any)._setBucketMigrationPercent(null);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/^Migrating$/);

    cleanup();
    (sessionStore as any)._setBucketMigrating(false);
  });

  it('REQ-ENTERPRISE-304: active migration shows its percent and does not offer Retry migration', () => {
    (sessionStore as any)._setBucketMigrating(true);
    (sessionStore as any)._setBucketMigrationPercent(42);
    render(() => <Dashboard {...defaultProps} userName={undefined} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Migrating 42%');
    expect(screen.queryByRole('button', { name: 'Retry migration' })).not.toBeInTheDocument();

    cleanup();
    (sessionStore as any)._setBucketMigrating(false);
    (sessionStore as any)._setBucketMigrationPercent(null);
  });

  const haltedAt = '2026-11-21T14:23:45.678Z';
  const renderMigrationDashboard = () => render(() => <>
    <section ref={el => { noticeOverlay = el; }}><MigrationRetryNotice retry={migrationRetry} /></section>
    <Dashboard {...defaultProps} userName={undefined} />
  </>);

  it.each([false, true])('REQ-ENTERPRISE-304: a halt keeps creation disabled and offers an icon-only retry (bucketMigrating=%s)', (bucketMigrating) => {
    (sessionStore as any)._setBucketMigrating(bucketMigrating);
    upgradeRecovery.preseedUpgradeFailed = true;
    setBucketMigrationHaltedAt(haltedAt);
    renderMigrationDashboard();

    const status = screen.getByTestId('dashboard-new-session');
    expect(status).toHaveTextContent(/^Migration halted$/);
    expect(status).toBeDisabled();
    const retry = screen.getByRole('button', { name: 'Retry migration' });
    expect(retry).toBeEnabled();
    expect(retry).toHaveAccessibleName('Retry migration');
    expect(retry).toHaveAttribute('title', 'Retry migration');
    expect(retry.textContent?.trim()).toBe('');
    expect(retry.querySelector('svg path')).toHaveAttribute('d', mdiReflectHorizontal);
    expect(screen.queryByRole('button', { name: 'Recreate Agent Skills & Rules' })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-213: clearing a halt does not transfer focus to seed recreation', () => {
    upgradeRecovery.preseedUpgradeFailed = true;
    setBucketMigrationHaltedAt(haltedAt);
    renderMigrationDashboard();

    const retry = screen.getByRole('button', { name: 'Retry migration' });
    retry.focus();
    expect(retry).toHaveFocus();
    setBucketMigrationHaltedAt(null);

    const recreate = screen.getByRole('button', { name: 'Recreate Agent Skills & Rules' });
    expect(retry).not.toBeInTheDocument();
    expect(recreate).toBeEnabled();
    expect(recreate).not.toHaveFocus();
  });

  it('REQ-ENTERPRISE-304: Retry migration submits the halt timestamp once while pending and does not unlock New Session on success', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    let finish!: (result: { success: true }) => void;
    retryBucketMigration.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderMigrationDashboard();

    const retry = screen.getByRole('button', { name: 'Retry migration' });
    const progress = within(noticeOverlay).getByRole('status');
    expect(progress.textContent).toBe('');
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleName('Retry migration');
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(progress).toHaveTextContent('Retrying migration');
    expect(progress).toBeVisible();
    expect(within(noticeOverlay).queryByRole('button', { name: 'Dismiss migration notification' })).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(retryBucketMigration.mock.calls).toEqual([[haltedAt]]);
    expect(upgradeRecovery.retryPreseedUpgrade).not.toHaveBeenCalled();
    expect(storageApi.recreateAgentConfigs).not.toHaveBeenCalled();
    const status = screen.getByTestId('dashboard-new-session');
    expect(status).toHaveTextContent(/^Migration halted$/);
    expect(status).toBeDisabled();
    expect(screen.getByTestId('create-session-dialog')).toHaveAttribute('data-open', 'false');

    finish({ success: true });
    await waitFor(() => expect(progress).toHaveTextContent('Retry accepted. Waiting for updated migration status.'));
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(retryBucketMigration.mock.calls).toEqual([[haltedAt]]);
    expect(progress).toBeInTheDocument();
    expect(status).toHaveTextContent(/^Migration halted$/);
    expect(status).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    setBucketMigrationHaltedAt('2026-11-21T14:25:00.000Z');
    expect(retry).toBeEnabled();
    expect(progress).not.toHaveTextContent('Retry accepted.');
    (sessionStore as any)._setBucketMigrating(true);
    setBucketMigrationHaltedAt(null);
    expect(screen.getByRole('button', { name: 'Migrating' })).toBeDisabled();
    expect(progress.textContent).toBe('');
  });

  it('REQ-ENTERPRISE-304: pending feedback survives the halt clearing before the retry settles', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    let finish!: (result: { success: true }) => void;
    retryBucketMigration.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderMigrationDashboard();

    const progress = within(noticeOverlay).getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));
    (sessionStore as any)._setBucketMigrating(true);
    setBucketMigrationHaltedAt(null);
    expect(screen.queryByRole('button', { name: 'Retry migration' })).not.toBeInTheDocument();
    expect(progress).toHaveTextContent('Retrying migration');
    expect(screen.getByRole('button', { name: 'Migrating' })).toBeDisabled();

    finish({ success: true });
    await waitFor(() => expect(progress).toHaveTextContent('Storage migration is running.'));
    expect(screen.getByRole('button', { name: 'Migrating' })).toBeDisabled();

    (sessionStore as any)._setBucketMigrating(false);
    expect(progress).toHaveTextContent('Storage is ready.');
    fireEvent.click(within(noticeOverlay).getByRole('button', { name: 'Dismiss migration notification' }));
    expect(progress.textContent).toBe('');
  });

  it('REQ-ENTERPRISE-304: a rejected retry is reported without rendering server markup or lifting the halt', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    retryBucketMigration.mockRejectedValueOnce(new ApiError(
      'Migration retry was rejected. <strong data-retry-error-probe>diagnostic</strong>', 409, 'Conflict',
    ));
    renderMigrationDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));

    expect(await within(noticeOverlay).findByRole('alert')).toHaveTextContent('Migration retry was rejected.');
    expect(document.querySelector('[data-retry-error-probe]')).not.toBeInTheDocument();
    const status = screen.getByTestId('dashboard-new-session');
    expect(status).toHaveTextContent(/^Migration halted$/);
    expect(status).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry migration' })).toBeEnabled();
  });

  it.each([
    new TypeError('Failed to fetch'),
    new ApiError('The migration status changed. Refresh the dashboard before retrying.', 409, 'Conflict'),
  ])('REQ-ENTERPRISE-323: reports running instead of retry failure after an updated status (%s)', async (error) => {
    setBucketMigrationHaltedAt(haltedAt);
    retryBucketMigration.mockRejectedValueOnce(error);
    vi.mocked(sessionStore.refreshSessionAncillaryStatus).mockImplementationOnce(async () => {
      (sessionStore as any)._setBucketMigrating(true);
      setBucketMigrationHaltedAt(null);
    });
    renderMigrationDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));

    expect(await within(noticeOverlay).findByText('Storage migration is running.')).toBeVisible();
    expect(within(noticeOverlay).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry migration' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Migrating' })).toBeDisabled();
    expect(retryBucketMigration.mock.calls).toEqual([[haltedAt]]);
  });

  it('REQ-ENTERPRISE-323: a sign-in redirect settles retry without refreshing status or showing a refusal', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    const error = new ApiError('Session expired. Redirecting to sign in.', 401, 'Unauthorized');
    error.authRedirect = true;
    retryBucketMigration.mockRejectedValueOnce(error);
    renderMigrationDashboard();

    const retry = screen.getByRole('button', { name: 'Retry migration' });
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    await waitFor(() => expect(retry).toBeEnabled());
    expect(within(noticeOverlay).getByRole('status').textContent).toBe('');
    expect(within(noticeOverlay).queryByRole('alert')).not.toBeInTheDocument();
    expect(sessionStore.refreshSessionAncillaryStatus).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-304 AC7: shows refusals before refresh and keeps dismissed notices hidden on resumption', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    retryBucketMigration.mockRejectedValueOnce(new ApiError('Stop your running sessions.', 409, 'Conflict'));
    let settleRefresh!: () => void;
    vi.mocked(sessionStore.refreshSessionAncillaryStatus).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { settleRefresh = resolve; });
      (sessionStore as any)._setBucketMigrationPercent(42);
      (sessionStore as any)._setBucketMigrating(true);
      setBucketMigrationHaltedAt(null);
    });
    renderMigrationDashboard();

    const retry = screen.getByRole('button', { name: 'Retry migration' });
    const overlay = within(noticeOverlay);
    fireEvent.click(retry);
    expect(await overlay.findByRole('alert')).toHaveTextContent('Stop your running sessions.');
    expect(retry).toBeEnabled();
    expect(overlay.queryByText('Retrying migration')).not.toBeInTheDocument();

    fireEvent.click(overlay.getByRole('button', { name: 'Dismiss migration notification' }));
    expect(overlay.queryByRole('alert')).not.toBeInTheDocument();
    settleRefresh();

    expect(await screen.findByRole('button', { name: 'Migrating 42%' })).toBeDisabled();
    expect(overlay.queryByRole('alert')).not.toBeInTheDocument();
    expect(overlay.getByRole('status').textContent).toBe('');
  });

  it('REQ-ENTERPRISE-304: a retry refusal belongs only to the halt that was retried', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    retryBucketMigration.mockRejectedValueOnce(new ApiError('Retry refused for the first halt', 409, 'Conflict'));
    renderMigrationDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry refused for the first halt');
    setBucketMigrationHaltedAt('2026-11-21T14:25:00.000Z');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry migration' })).toBeEnabled();
  });

  it('REQ-ENTERPRISE-304: a late refusal stays hidden after a different halt becomes current', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    let refuse!: (error: ApiError) => void;
    retryBucketMigration.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = reject; }));
    renderMigrationDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));
    setBucketMigrationHaltedAt('2026-11-21T14:25:00.000Z');
    expect(screen.getByRole('button', { name: 'Retry migration' })).toBeDisabled();
    refuse(new ApiError('Retry refused for the previous halt', 409, 'Conflict'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry migration' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('REQ-ENTERPRISE-323: a late retry acknowledgment does not revive feedback after a replacement halt clears', async () => {
    setBucketMigrationHaltedAt(haltedAt);
    let finish!: (result: { success: true }) => void;
    retryBucketMigration.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderMigrationDashboard();

    const progress = within(noticeOverlay).getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Retry migration' }));
    setBucketMigrationHaltedAt('2026-11-21T14:25:00.000Z');
    (sessionStore as any)._setBucketMigrating(true);
    setBucketMigrationHaltedAt(null);
    expect(progress).toHaveTextContent('Retrying migration');

    finish({ success: true });
    await waitFor(() => expect(progress).not.toHaveTextContent('Retrying migration'));
    expect(progress.textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Migrating' })).toBeDisabled();
  });

});
