import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiXml } from '@mdi/js';
import Dashboard from '../../components/Dashboard';
import { sessionStore } from '../../stores/session';
import { storageStore } from '../../stores/storage';
import type { SessionWithStatus } from '../../types';

// Mock child components to isolate Dashboard testing
vi.mock('../../components/SessionStatCard', () => ({
  default: (props: any) => (
    <div data-testid={`session-card-${props.session.id}`}>
      <span data-testid="session-name">{props.session.name}</span>
      <button data-testid={`select-${props.session.id}`} onClick={props.onSelect}>Select</button>
    </div>
  )
}));

vi.mock('../../components/StorageBrowser', () => ({
  default: () => <div data-testid="storage-browser" />
}));

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
  default: (props: any) => <svg data-testid="icon" data-path={props.path} />
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
  return {
    sessionStore: {
      get sessions() { return []; },
      get maxSessions() { return _maxSessions; },
      get r2Ready() { return _r2Ready; },
      isAtSessionLimit: () => _isAtLimit,
      startR2Polling: vi.fn(),
      _setTestLimit: (atLimit: boolean, max?: number) => {
        _isAtLimit = atLimit;
        if (max !== undefined) _maxSessions = max;
      },
      _setR2Ready: (ready: boolean) => { _r2Ready = ready; },
    },
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

vi.mock('../../components/TipsRotator', () => ({
  default: () => <div data-testid="tips-card" />
}));

const mockSessions: SessionWithStatus[] = [
  { id: 'sess1', name: 'Test Session 1', createdAt: '2024-01-15T10:00:00Z', lastAccessedAt: '2024-01-15T12:00:00Z', status: 'running' },
  { id: 'sess2', name: 'Test Session 2', createdAt: '2024-01-14T10:00:00Z', lastAccessedAt: '2024-01-14T12:00:00Z', status: 'stopped' },
];

describe('Dashboard', () => {
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
    onLogout: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // === Initialization Tests ===

  it('calls storageStore.fetchStats on mount', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(storageStore.fetchStats).toHaveBeenCalledTimes(1);
  });

  it('calls sessionStore.startR2Polling on mount', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(sessionStore.startR2Polling).toHaveBeenCalledTimes(1);
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

  it('renders logout button in panel header', () => {
    render(() => <Dashboard {...defaultProps} />);

    expect(screen.getByTestId('dashboard-logout-button')).toBeInTheDocument();
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

  it('calls onLogout when logout button clicked', () => {
    const onLogout = vi.fn();
    render(() => <Dashboard {...defaultProps} onLogout={onLogout} />);

    fireEvent.click(screen.getByTestId('dashboard-logout-button'));

    expect(onLogout).toHaveBeenCalledTimes(1);
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

});
