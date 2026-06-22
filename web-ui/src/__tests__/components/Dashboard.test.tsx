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

// Controllable GitHub enablement for the right-column face logic. `enabled` is a real
// reactive signal so a test can flip it DURING mount (e.g. from inside loadStatus) and
// watch the GitHub face appear — proving the deadlock fix end-to-end, not just the call.
vi.mock('../../stores/github', async () => {
  const { createSignal } = await vi.importActual<typeof import('solid-js')>('solid-js');
  const [enabled, setEnabled] = createSignal(false);
  return {
    githubStore: {
      get enabled() { return enabled(); },
      _setEnabled: (v: boolean) => setEnabled(v),
      // Dashboard kicks this off on mount to break the enabled-gates-the-panel
      // deadlock (status is loaded outside the gated GitHub panel).
      loadStatus: vi.fn(),
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
    // clearAllMocks clears call history but NOT a queued mockImplementationOnce, so
    // reset loadStatus fully — otherwise an unconsumed once-impl from one test could
    // leak into the next. (The end-to-end deadlock test queues one such impl.)
    vi.mocked(githubStore.loadStatus).mockReset();
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
    expect(screen.getByTestId('storage-flip-btn')).toBeInTheDocument();
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

  it('REQ-GITHUB-010: the split/flip decision uses the VIEWPORT width, not the right-column width (a narrow column on a wide viewport must not flip)', () => {
    let roCb: () => void = () => {};
    const RealRO = (globalThis as any).ResizeObserver;
    const RealRAF = globalThis.requestAnimationFrame;
    const realInnerWidth = window.innerWidth;
    class CapRO { constructor(cb: () => void) { roCb = cb; } observe() {} unobserve() {} disconnect() {} }
    (globalThis as any).ResizeObserver = CapRO;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    (window as any).innerWidth = 1024; // pin a wide viewport, do not rely on the jsdom default
    try {
      (githubStore as any)._setEnabled(true);
      render(() => <Dashboard {...defaultProps} />);
      const right = screen.getByTestId('dashboard-panel-right') as HTMLElement;
      // Wide viewport (1024) but a NARROW own column-width and enough height to split.
      // If the decision (wrongly) used the column width (400 < 600) it would flip;
      // using window.innerWidth (1024) it must stay split.
      Object.defineProperty(right, 'clientWidth', { configurable: true, value: 400 });
      Object.defineProperty(right, 'clientHeight', { configurable: true, value: 800 });
      roCb();
      expect(right.getAttribute('data-layout')).not.toBe('flip');
    } finally {
      (globalThis as any).ResizeObserver = RealRO;
      (globalThis as any).requestAnimationFrame = RealRAF;
      (window as any).innerWidth = realInnerWidth;
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
