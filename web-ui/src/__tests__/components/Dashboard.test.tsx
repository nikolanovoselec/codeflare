import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiViewCompactOutline, mdiXml } from '@mdi/js';
import Dashboard from '../../components/Dashboard';
import { sessionStore } from '../../stores/session';
import { storageStore } from '../../stores/storage';
import { githubStore } from '../../stores/github';
import * as vaultCache from '../../lib/vault-cache';
import type { SessionWithStatus } from '../../types';

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
      <button data-testid="gh-stub-flip" onClick={() => props.onFlip?.()}>flip</button>
    </div>
  )
}));

// Controllable GitHub enablement for the right-column face logic.
vi.mock('../../stores/github', () => {
  let _enabled = false;
  return {
    githubStore: {
      get enabled() { return _enabled; },
      _setEnabled: (v: boolean) => { _enabled = v; },
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

vi.mock('../../stores/session', () => {
  let _isAtLimit = false;
  let _maxSessions = 3;
  let _r2Ready = true;
  let _preseedUpgrading = false;
  let _enterpriseMode = false;
  let _sessionMode = 'advanced';
  return {
    sessionStore: {
      get sessions() { return []; },
      get maxSessions() { return _maxSessions; },
      get r2Ready() { return _r2Ready; },
      get preseedUpgrading() { return _preseedUpgrading; },
      get enterpriseMode() { return _enterpriseMode; },
      get preferences() { return { sessionMode: _sessionMode }; },
      isAtSessionLimit: () => _isAtLimit,
      startR2Polling: vi.fn(),
      _setSessionMode: (v: string) => { _sessionMode = v; },
      _setTestLimit: (atLimit: boolean, max?: number) => {
        _isAtLimit = atLimit;
        if (max !== undefined) _maxSessions = max;
      },
      _setR2Ready: (ready: boolean) => { _r2Ready = ready; },
      _setPreseedUpgrading: (upgrading: boolean) => { _preseedUpgrading = upgrading; },
      _setEnterpriseMode: (v: boolean) => { _enterpriseMode = v; },
    },
    isAtUsageQuota: () => false,
    getUsageState: () => ({ monthlySeconds: 0, monthlyQuotaSeconds: null }),
  };
});

vi.mock('../../components/CreateSessionDialog', () => ({
  default: (props: any) => {
    // Store props on window for inspection in tests
    (window as any).__createSessionDialogProps = props;
    return (
      <div data-testid="create-session-dialog" data-open={props.isOpen}>
        <button data-testid="csd-select-agent" onClick={() => props.onSelect('claude-code')}>
          Select Agent
        </button>
      </div>
    );
  }
}));

vi.mock('../../stores/storage', () => ({
  storageStore: {
    get stats() { return null; },
    get previewFile() { return null; },
    fetchStats: vi.fn(),
    closePreview: vi.fn(),
    searchFiles: vi.fn((query: string) => {
      if (query === 'test-file') {
        return { objects: [{ key: 'workspace/test-file.ts', size: 100, lastModified: '2024-01-01' }], prefixes: [] };
      }
      return { objects: [], prefixes: [] };
    }),
    browse: vi.fn(),
  }
}));

vi.mock('../../api/storage', () => ({
  getDownloadUrl: vi.fn(() => 'https://example.com/download'),
}));

vi.mock('../../lib/vault-cache', () => ({
  sweepOrphanVaultCaches: vi.fn().mockResolvedValue(undefined),
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

const mockSessions: SessionWithStatus[] = [
  { id: 'sess1', name: 'Test Session 1', createdAt: '2024-01-15T10:00:00Z', lastAccessedAt: '2024-01-15T12:00:00Z', status: 'running' },
  { id: 'sess2', name: 'Test Session 2', createdAt: '2024-01-14T10:00:00Z', lastAccessedAt: '2024-01-14T12:00:00Z', status: 'stopped' },
];

// REQ-ENTERPRISE-015: Enterprise-mode admin and dropdown suppressions
describe('Dashboard / REQ-SUB-019 (session limit popup in frontend)', () => {
  const defaultProps = {
    sessions: mockSessions,
    onCreateSession: vi.fn(),
    onStartSession: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onOpenSessionById: vi.fn(),
    viewState: 'dashboard' as const,
    userName: 'nikola@novoselec.ch',
    onSettingsClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    viewportMock.setViewport?.('desktop');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    (githubStore as any)._setEnabled(false);
    (sessionStore as any)._setEnterpriseMode(false);
    (sessionStore as any)._setSessionMode('advanced');
    mockMultiView = null;
  });

  // === Enterprise dropdown gating (REQ-ENTERPRISE-008 AC2/AC8/AC9) ===

  it('shows Guided Setup + Logout and hides Usage outside enterprise mode', () => {
    (sessionStore as any)._setEnterpriseMode(false);
    render(() => <Dashboard {...defaultProps} />);
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.getByTestId('header-user-dropdown-onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
    // Not SaaS and not enterprise -> Usage hidden.
    expect(screen.queryByTestId('header-user-dropdown-usage')).not.toBeInTheDocument();
  });

  it('keeps the avatar visible but opens no dropdown in enterprise mode', () => {
    (sessionStore as any)._setEnterpriseMode(true);
    render(() => <Dashboard {...defaultProps} />);
    // Avatar/username trigger stays rendered so the user sees their identity.
    expect(screen.getByTestId('header-user-menu')).toBeInTheDocument();
    // Every dropdown entry is gated away in enterprise (Usage 0-reports, Subscription
    // is SaaS billing, Guided Setup + Logout are admin/SSO concerns), so clicking the
    // avatar is inert — no dropdown opens.
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.queryByTestId('header-user-dropdown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('header-user-dropdown-usage')).not.toBeInTheDocument();
  });

  // === Initialization Tests ===

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

  it('calls storageStore.fetchStats on mount', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(storageStore.fetchStats).toHaveBeenCalledTimes(1);
  });

  it('calls sessionStore.startR2Polling on mount', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(sessionStore.startR2Polling).toHaveBeenCalledTimes(1);
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

  it('renders integrated header with user name when provided', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByText('nikola@novoselec.ch')).toBeInTheDocument();
  });

  it('renders settings button in panel header', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('dashboard-settings-button')).toBeInTheDocument();
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

  it('REQ-GITHUB-010: forces the storage face active when GitHub is disabled so the empty GitHub panel cannot cover R2', () => {
    (githubStore as any)._setEnabled(false);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    const githubFace = right.querySelector('.panel-flip-face--github')!;
    const storageFace = right.querySelector('.panel-flip-face--storage')!;
    expect(githubFace.getAttribute('data-active')).toBe('false');
    expect(storageFace.getAttribute('data-active')).toBe('true');
    expect(right.getAttribute('data-face')).toBe('storage');
    // Nothing to flip to, so no "Show GitHub" back control is offered.
    expect(screen.queryByTestId('storage-flip-btn')).not.toBeInTheDocument();
    // No GitHub panel => the storage panel carries no STORAGE header either
    // (the header is the parity row that only exists in enterprise mode).
    expect(screen.queryByTestId('files-panel-title')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-010: defaults to the GitHub face and offers the storage back-button when GitHub is enabled', () => {
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

  it('REQ-GITHUB-007: hides the GitHub face for a non-advanced non-enterprise session even when enabled (advanced gate)', () => {
    (githubStore as any)._setEnabled(true);
    (sessionStore as any)._setSessionMode('standard'); // not advanced
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    expect(right.getAttribute('data-face')).toBe('storage');
    expect(screen.queryByTestId('storage-flip-btn')).not.toBeInTheDocument();
  });

  it('REQ-GITHUB-007: shows the GitHub face for an enterprise session regardless of session mode', () => {
    (githubStore as any)._setEnabled(true);
    (sessionStore as any)._setSessionMode('standard');
    (sessionStore as any)._setEnterpriseMode(true);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    expect(right.getAttribute('data-face')).toBe('github');
  });

  it('REQ-GITHUB-010: flips GitHub <-> storage when enabled and the flip controls are used', () => {
    (githubStore as any)._setEnabled(true);
    render(() => <Dashboard {...defaultProps} />);

    const right = screen.getByTestId('dashboard-panel-right');
    // Flip to storage from the GitHub panel header control.
    fireEvent.click(screen.getByTestId('gh-stub-flip'));
    expect(right.getAttribute('data-face')).toBe('storage');
    // Flip back to GitHub from the storage back-button.
    fireEvent.click(screen.getByTestId('storage-flip-btn'));
    expect(right.getAttribute('data-face')).toBe('github');
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

  it('opens CreateSessionDialog when New Session button clicked', () => {
    render(() => <Dashboard {...defaultProps} />);

    fireEvent.click(screen.getByTestId('dashboard-new-session'));

    const dialog = screen.getByTestId('create-session-dialog');
    expect(dialog.getAttribute('data-open')).toBe('true');
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

  it('renders KittScanner component in dashboard', () => {
    render(() => <Dashboard {...defaultProps} />);

    const dashboard = screen.getByTestId('dashboard');
    const kittScanner = dashboard.querySelector('.kitt-scanner');
    expect(kittScanner).toBeInTheDocument();
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

  it('shows SessionLimitPopup instead of CreateSessionDialog when at limit', () => {
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
  it('should disable new session button and show Upgrading during preseed upgrade', () => {
    (sessionStore as any)._setPreseedUpgrading(true);
    render(() => <Dashboard {...defaultProps} />);

    const btn = screen.getByTestId('dashboard-new-session');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toBe('Upgrading');

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

});
