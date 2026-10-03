import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiViewDashboardOutline, mdiMicrosoftVisualStudioCode } from '@mdi/js';
import Header from '../../components/Header';
import { createSignal } from 'solid-js';
import type { SessionWithStatus, SleepAfterOption } from '../../types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const headerStyles = readFileSync(resolve('src/styles/header.css'), 'utf8');
const designTokens = readFileSync(resolve('src/styles/design-tokens.css'), 'utf8');

// jsdom retains a selected var(...) rather than resolving inherited custom
// properties. Read the actual cascade and let CSSOM normalize the literal;
// this is not a substitute for real-browser rendering acceptance.
function renderedColor(element: Element): string {
  let color = getComputedStyle(element).color;
  const variable = /^var\((--[\w-]+)\)$/.exec(color);
  if (variable) {
    let owner: Element | null = element;
    color = '';
    while (owner && !color) {
      color = getComputedStyle(owner).getPropertyValue(variable[1]).trim();
      owner = owner.parentElement;
    }
    if (!color) throw new Error(`Missing rendered color property ${variable[1]}`);
  }
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.append(probe);
  try { return getComputedStyle(probe).color; }
  finally { probe.remove(); }
}

// Mock isMobile - default to desktop (false)
const isMobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/mobile', () => ({
  isMobile: () => isMobileMock.value,
  isTouchDevice: () => isMobileMock.value,
}));

// Mock SessionSwitcher
vi.mock('../../components/SessionSwitcher', () => ({
  default: (props: any) => (
    <div data-testid="session-switcher" data-active-session={props.activeSessionId} />
  ),
}));

// Mock terminal store with authUrl signal
const terminalStoreMock = vi.hoisted(() => ({
  authUrl: null as string | null,
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    get authUrl() {
      return terminalStoreMock.authUrl;
    },
  },
}));

const sessionStoreState = vi.hoisted(() => ({
  activeSessionId: 'session-1' as string | null,
  error: null as string | null,
  saasMode: false as boolean,
  enterpriseMode: false as boolean,
  sleepAfter: '30m' as SleepAfterOption,
}));

// Mock getUsageState - returns usage data for the header dropdown display
// Real getUsageState() always returns an object (never null) — see session.ts line 734
const usageStateMock = vi.hoisted(() => ({
  value: { monthlySeconds: 0, monthlyQuotaSeconds: null } as { monthlySeconds: number; monthlyQuotaSeconds: number | null },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get activeSessionId() {
      return sessionStoreState.activeSessionId;
    },
    get error() {
      return sessionStoreState.error;
    },
    get saasMode() {
      return sessionStoreState.saasMode;
    },
    get enterpriseMode() {
      return sessionStoreState.enterpriseMode;
    },
    preferences: {
      get sleepAfter() {
        return sessionStoreState.sleepAfter;
      },
    },
  },
  getUsageState: () => usageStateMock.value,
}));

const defaultSessionProps = {
  sessions: [] as any[],
  activeSessionId: null as string | null,
  onSelectSession: () => {},
  onStopSession: () => {},
  onDeleteSession: () => {},
  onCreateSession: () => {},
};

// REQ-ENTERPRISE-015: Enterprise-mode admin and dropdown suppressions
// REQ-AUTH-017: Gravatar integration
// REQ-VAULT-018: Vault control gating and on-demand prewarm trigger

describe('Header Component / REQ-VAULT-012 (vault button render and readiness gating) / REQ-AUTH-016 (header user dropdown)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreState.activeSessionId = 'session-1';
    sessionStoreState.error = null;
    sessionStoreState.saasMode = false;
    sessionStoreState.enterpriseMode = false;
    sessionStoreState.sleepAfter = '30m';
    isMobileMock.value = false;
    terminalStoreMock.authUrl = null;
    usageStateMock.value = { monthlySeconds: 0, monthlyQuotaSeconds: null };
  });

  afterEach(() => {
    cleanup();
  });

  it('shows separate Operator Management navigation only for an eligible enterprise user', async () => {
    sessionStoreState.enterpriseMode = true;
    const view = render(() => <Header {...defaultSessionProps} operatorManagementEligible />);
    await fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.getByTestId('header-user-dropdown-operators')).toHaveAttribute('href', '/operators');
    view.unmount();

    render(() => <Header {...defaultSessionProps} />);
    await fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.queryByTestId('header-user-dropdown-operators')).not.toBeInTheDocument();
  });

  describe('REQ-SESSION-036: Header sleep countdown', () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const runningSession = (overrides: Partial<SessionWithStatus> = {}): SessionWithStatus => ({
      id: 'session-1', name: 'Current session', status: 'running',
      createdAt: minutesAgo(60), lastAccessedAt: minutesAgo(1),
      lastStartedAt: minutesAgo(29), lastActiveAt: minutesAgo(22), ...overrides,
    });
    let stylesheet: HTMLStyleElement;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      // Apply the production stylesheet so severity assertions observe rendered
      // treatment, rather than inspecting classes or recreating CSS in the test.
      stylesheet = document.createElement('style');
      stylesheet.textContent = `${designTokens}\n${headerStyles}`;
      document.head.append(stylesheet);
    });

    afterEach(() => {
      cleanup();
      stylesheet.remove();
      vi.useRealTimers();
    });

    it.each([
      { remainingMs: 600_001, visible: false },
      { remainingMs: 600_000, visible: false },
      { remainingMs: 599_999, visible: true },
      { remainingMs: 1, visible: true },
      { remainingMs: 0, visible: false },
    ])('REQ-SESSION-036 AC2: shows the Header countdown only below ten minutes and before expiry ($remainingMs ms remaining)', ({ remainingMs, visible }) => {
      const session = runningSession({ lastStartedAt: minutesAgo(31), lastActiveAt: new Date(now - (1_800_000 - remainingMs)).toISOString() });
      render(() => <Header {...defaultSessionProps} sessions={[session]} activeSessionId={session.id} />);

      if (visible) expect(screen.getByTestId('header-timer-button')).toBeVisible();
      else expect(screen.queryByTestId('header-timer-button')).not.toBeInTheDocument();
    });

    it('REQ-SESSION-036 AC1: opens the active running session countdown and explains idle stopping', () => {
      const active = runningSession();
      const other = runningSession({ id: 'other-session', lastActiveAt: minutesAgo(26) });
      render(() => <Header {...defaultSessionProps} sessions={[other, active]} activeSessionId={active.id} />);

      const timer = screen.getByRole('button', { name: '< 10 min' });
      expect(screen.queryByTestId('header-timer-dropdown')).not.toBeInTheDocument();
      fireEvent.click(timer);
      expect(screen.getByTestId('header-timer-dropdown')).toBeVisible();
      expect(screen.getByTestId('header-timer-dropdown')).toHaveTextContent('< 10 min');
      expect(screen.getByTestId('header-timer-dropdown')).toHaveTextContent('When this timer expires, your session will stop.');
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('header-timer-dropdown')).not.toBeInTheDocument();
    });

    it.each([
      { remainingMs: 300_000, bucket: '< 10 min', color: 'rgb(245, 158, 11)', pulse: '2s', ac: 'AC3' },
      { remainingMs: 299_999, bucket: '< 5 min', color: 'rgb(239, 68, 68)', pulse: '1s', ac: 'AC4' },
    ])('REQ-SESSION-036 $ac: renders $bucket with its warning or critical treatment ($remainingMs ms remaining)', ({ remainingMs, bucket, color, pulse }) => {
      const session = runningSession({ lastActiveAt: new Date(now - (1_800_000 - remainingMs)).toISOString() });
      render(() => <Header {...defaultSessionProps} sessions={[session]} activeSessionId={session.id} />);

      const timer = screen.getByRole('button', { name: bucket });
      expect(timer).toBeVisible();
      const treatment = getComputedStyle(timer);
      expect(renderedColor(timer)).toBe(color);
      expect(treatment.animation).toContain(pulse);
      fireEvent.click(timer);
      expect(screen.getByTestId('header-timer-dropdown')).toHaveTextContent(bucket);
    });

    it.each([{ state: 'absent' }, { state: 'stopped' }])('REQ-SESSION-036 AC5: hides the Header countdown when the active session is $state even when another session is running', ({ state }) => {
      const active = runningSession({ status: 'stopped' });
      const other = runningSession({ id: 'other-session' });
      render(() => <Header {...defaultSessionProps} sessions={state === 'absent' ? [other] : [active, other]} activeSessionId={active.id} />);

      expect(screen.queryByTestId('header-timer-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('header-timer-dropdown')).not.toBeInTheDocument();
    });

    it('REQ-SESSION-036 AC6: recomputes the configured idle countdown as time passes without session updates', () => {
      sessionStoreState.sleepAfter = '15m';
      const session = runningSession({ lastStartedAt: minutesAgo(6), lastActiveAt: minutesAgo(5) });
      render(() => <Header {...defaultSessionProps} sessions={[session]} activeSessionId={session.id} />);
      expect(screen.queryByTestId('header-timer-button')).not.toBeInTheDocument();

      vi.advanceTimersByTime(15_000);
      fireEvent.click(screen.getByRole('button', { name: '< 10 min' }));
      expect(screen.getByTestId('header-timer-dropdown')).toHaveTextContent('< 10 min');
      vi.advanceTimersByTime(300_000);
      expect(screen.getByRole('button', { name: '< 5 min' })).toBeVisible();
      expect(screen.getByTestId('header-timer-dropdown')).toHaveTextContent('< 5 min');
      vi.advanceTimersByTime(285_000);
      expect(screen.queryByTestId('header-timer-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('header-timer-dropdown')).not.toBeInTheDocument();
    });

    it.each([
      { context: 'no terminal input', lastStartedAt: minutesAgo(25), lastActiveAt: undefined, bucket: '< 10 min' },
      { context: 'expired prior-run input', lastStartedAt: minutesAgo(25), lastActiveAt: minutesAgo(40), bucket: '< 10 min' },
      { context: 'recent restart with prior-run input', lastStartedAt: minutesAgo(1), lastActiveAt: minutesAgo(25), bucket: null },
    ])('REQ-SESSION-036 AC7: uses current-run start before new input ($context)', ({ lastStartedAt, lastActiveAt, bucket }) => {
      const session = runningSession({ lastStartedAt, lastActiveAt });
      render(() => <Header {...defaultSessionProps} sessions={[session]} activeSessionId={session.id} />);

      if (bucket) expect(screen.getByRole('button', { name: bucket })).toBeVisible();
      else expect(screen.queryByTestId('header-timer-button')).not.toBeInTheDocument();
    });

    it('REQ-SESSION-036 AC7: uses current-run terminal input instead of run start and resets after new input', () => {
      const [session, setSession] = createSignal(runningSession({ lastStartedAt: minutesAgo(29), lastActiveAt: minutesAgo(22) }));
      render(() => <Header {...defaultSessionProps} sessions={[session()]} activeSessionId={session().id} />);
      expect(screen.getByRole('button', { name: '< 10 min' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: '< 10 min' }));
      expect(screen.getByTestId('header-timer-dropdown')).toBeVisible();

      setSession({ ...session(), lastActiveAt: new Date(now).toISOString() });
      expect(screen.queryByTestId('header-timer-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('header-timer-dropdown')).not.toBeInTheDocument();
    });
  });

  describe('Default Rendering', () => {
    it('should render with required elements', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);

      const logo = screen.getByTestId('header-logo');
      expect(logo).toBeInTheDocument();

      const settingsButton = screen.getByTestId('header-settings-button');
      expect(settingsButton).toBeInTheDocument();

      const userMenu = screen.getByTestId('header-user-menu');
      expect(userMenu).toBeInTheDocument();
    });

    it('should render logo with dashboard icon', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      const logo = screen.getByTestId('header-logo');
      const icon = logo.querySelector('svg');

      expect(icon).toBeInTheDocument();
    });

    it('should use mdiViewDashboardOutline icon path for the logo', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      const logo = screen.getByTestId('header-logo');
      const svgPath = logo.querySelector('svg path');

      expect(svgPath).toBeInTheDocument();
      expect(svgPath?.getAttribute('d')).toBe(mdiViewDashboardOutline);
    });
  });

  describe('Vault button behavior', () => {
    it('does not render the Vault button when no open handler is provided', () => {
      render(() => <Header {...defaultSessionProps} />);

      expect(screen.queryByTestId('header-vault-button')).not.toBeInTheDocument();
    });

    it('keeps the Vault button visible and explains when browser prewarm is still running', () => {
      const onVaultOpen = vi.fn();
      render(() => <Header {...defaultSessionProps} onVaultOpen={onVaultOpen} vaultStatus="prewarming" />);

      const button = screen.getByTestId('header-vault-button');
      fireEvent.click(button);

      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('data-vault-status', 'prewarming');
      expect(screen.getByTestId('header-vault-status')).toBeInTheDocument();
      expect(onVaultOpen).not.toHaveBeenCalled();
    });

    it('dismisses the guarded Vault feedback when the user clicks elsewhere', () => {
      const onVaultOpen = vi.fn();
      render(() => <Header {...defaultSessionProps} onVaultOpen={onVaultOpen} vaultStatus="prewarming" />);

      fireEvent.click(screen.getByTestId('header-vault-button'));
      expect(screen.getByTestId('header-vault-status')).toBeInTheDocument();

      fireEvent.click(document.body);

      expect(screen.queryByTestId('header-vault-status')).not.toBeInTheDocument();
      expect(onVaultOpen).not.toHaveBeenCalled();
    });

    it('opens the Vault only after prewarm reaches ready', () => {
      const onVaultOpen = vi.fn();
      render(() => <Header {...defaultSessionProps} onVaultOpen={onVaultOpen} vaultStatus="ready" />);

      const button = screen.getByTestId('header-vault-button');
      fireEvent.click(button);

      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'false');
      expect(button).toHaveAttribute('data-vault-status', 'ready');
      expect(onVaultOpen).toHaveBeenCalledOnce();
    });

    it('lets the user retry timeout and error states explicitly', () => {
      const onVaultOpen = vi.fn();
      const { unmount } = render(() => <Header {...defaultSessionProps} onVaultOpen={onVaultOpen} vaultStatus="timeout" />);
      const timeoutButton = screen.getByTestId('header-vault-button');
      expect(timeoutButton).toHaveAttribute('aria-disabled', 'false');
      expect(timeoutButton).toHaveAttribute('data-vault-status', 'timeout');
      fireEvent.click(timeoutButton);
      expect(onVaultOpen).toHaveBeenCalledTimes(1);
      unmount();

      render(() => <Header {...defaultSessionProps} onVaultOpen={onVaultOpen} vaultStatus="error" />);
      const errorButton = screen.getByTestId('header-vault-button');
      expect(errorButton).toHaveAttribute('aria-disabled', 'false');
      expect(errorButton).toHaveAttribute('data-vault-status', 'error');
      fireEvent.click(errorButton);
      expect(onVaultOpen).toHaveBeenCalledTimes(2);
    });
  });

  // REQ-IDE-001/003: the browser-IDE (OpenVSCode) header button. The Show gate
  // renders it only when the parent (Layout, for an advanced running session)
  // passes onVscodeOpen; clicking invokes that handler (which opens the IDE tab).
  describe('Browser IDE button / REQ-IDE-001, REQ-IDE-003 (per-session VS Code)', () => {
    it('does not render the IDE button when no open handler is provided', () => {
      render(() => <Header {...defaultSessionProps} />);
      expect(screen.queryByTestId('header-vscode-button')).not.toBeInTheDocument();
    });

    it('renders the IDE button and invokes the handler on click when provided', () => {
      const onVscodeOpen = vi.fn();
      render(() => <Header {...defaultSessionProps} onVscodeOpen={onVscodeOpen} />);

      const button = screen.getByTestId('header-vscode-button');
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('title');
      fireEvent.click(button);
      expect(onVscodeOpen).toHaveBeenCalledOnce();
    });

    it('uses the Microsoft VS Code icon', () => {
      render(() => <Header {...defaultSessionProps} onVscodeOpen={vi.fn()} />);
      const svgPath = screen.getByTestId('header-vscode-button').querySelector('svg path');
      expect(svgPath?.getAttribute('d')).toBe(mdiMicrosoftVisualStudioCode);
    });
  });

  describe('REQ-OPERATOR-040: Enterprise operator placement', () => {
    it('places the operator control between VS Code and Storage in a terminal header', () => {
      sessionStoreState.enterpriseMode = true;
      render(() => <Header {...defaultSessionProps} onVscodeOpen={vi.fn()} />);

      const vscode = screen.getByTestId('header-vscode-button');
      const operator = screen.getByRole('button', { name: 'Operator activity' });
      const storage = screen.getByTestId('header-storage-button');
      expect(vscode.compareDocumentPosition(operator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(operator.compareDocumentPosition(storage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the operator control after the user control on the dashboard', () => {
      sessionStoreState.enterpriseMode = true;
      render(() => <Header {...defaultSessionProps} />);

      const user = screen.getByTestId('header-user-menu');
      const operator = screen.getByRole('button', { name: 'Operator activity' });
      expect(user.compareDocumentPosition(operator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('User Name Display', () => {
    it('should show user name when provided', () => {
      render(() => <Header {...defaultSessionProps} userName="test@example.com" />);
      const userMenu = screen.getByTestId('header-user-menu');

      expect(userMenu).toHaveTextContent('test@example.com');
    });

    it('should show default avatar when no user name', () => {
      render(() => <Header {...defaultSessionProps} />);
      const userMenu = screen.getByTestId('header-user-menu');
      const icon = userMenu.querySelector('svg');

      expect(icon).toBeInTheDocument();
    });
  });

  describe('Storage Button', () => {
    it('should render file-cabinet icon button with correct testid', () => {
      render(() => <Header {...defaultSessionProps} />);

      const storageButton = screen.getByTestId('header-storage-button');
      expect(storageButton).toBeInTheDocument();
    });

    it('should call onStoragePanelToggle when clicked', () => {
      const handleToggle = vi.fn();
      render(() => <Header {...defaultSessionProps} onStoragePanelToggle={handleToggle} />);

      const storageButton = screen.getByTestId('header-storage-button');
      fireEvent.click(storageButton);

      expect(handleToggle).toHaveBeenCalledTimes(1);
    });

    it('should not throw when clicked without handler', () => {
      render(() => <Header {...defaultSessionProps} />);
      const storageButton = screen.getByTestId('header-storage-button');

      expect(() => fireEvent.click(storageButton)).not.toThrow();
    });
  });

  describe('Settings Button', () => {
    it('should call onSettingsClick when clicked', () => {
      const handleSettingsClick = vi.fn();
      render(() => <Header {...defaultSessionProps} onSettingsClick={handleSettingsClick} />);

      const settingsButton = screen.getByTestId('header-settings-button');
      fireEvent.click(settingsButton);

      expect(handleSettingsClick).toHaveBeenCalledTimes(1);
    });

    it('should not throw when clicked without handler', () => {
      render(() => <Header {...defaultSessionProps} />);
      const settingsButton = screen.getByTestId('header-settings-button');

      expect(() => fireEvent.click(settingsButton)).not.toThrow();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible button labels', () => {
      render(() => <Header {...defaultSessionProps} />);

      const settingsButton = screen.getByTestId('header-settings-button');
      expect(settingsButton).toHaveAttribute('title');
    });
  });

  describe('Logo', () => {
    it('should show dashboard icon on desktop', () => {
      isMobileMock.value = false;
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} onLogoClick={() => {}} />);

      const logo = screen.getByTestId('header-logo');
      const svg = logo.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(logo).toHaveClass('header-logo--clickable');
    });

    it('should call onLogoClick on desktop when logo is clicked', () => {
      isMobileMock.value = false;
      const handleLogoClick = vi.fn();
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} onLogoClick={handleLogoClick} />);

      fireEvent.click(screen.getByTestId('header-logo'));
      expect(handleLogoClick).toHaveBeenCalledTimes(1);
    });

    it('should always use mdiViewDashboardOutline icon (never mdiMenu), even on mobile', () => {
      isMobileMock.value = true;
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);

      const logo = screen.getByTestId('header-logo');
      const svgPath = logo.querySelector('svg path');
      expect(svgPath?.getAttribute('d')).toBe(mdiViewDashboardOutline);
    });
  });

  describe('Session Switcher', () => {
    it('renders SessionSwitcher component', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      expect(screen.getByTestId('session-switcher')).toBeInTheDocument();
    });

    it('does not render "Codeflare" title text', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      expect(screen.queryByText('Codeflare')).not.toBeInTheDocument();
    });

    it('does not render hamburger menu icon on mobile', () => {
      isMobileMock.value = true;
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      const logo = screen.getByTestId('header-logo');
      const svgPath = logo.querySelector('svg path');
      expect(svgPath?.getAttribute('d')).toBe(mdiViewDashboardOutline);
    });
  });

  describe('Usage Dropdown Item', () => {
    // Usage is a per-user consumption surface in every deployment mode; only
    // quota and subscription actions remain SaaS-specific.

    it('should show formatted spent time when usage data is available', () => {
      // 2h 15m = 8100 seconds, quota = 10h = 36000 seconds
      usageStateMock.value = { monthlySeconds: 8100, monthlyQuotaSeconds: 36000 };
      render(() => <Header {...defaultSessionProps} />);

      // Open user menu
      fireEvent.click(screen.getByTestId('header-user-menu'));

      const usageItem = screen.getByTestId('header-user-dropdown-usage');
      expect(usageItem).toBeInTheDocument();
      // Should show compact duration format: "2h 15m / 10h"
      expect(usageItem.textContent).toMatch(/2h 15m/);
      expect(usageItem.textContent).toMatch(/10h/);
    });

    it('should show "Usage" without time when no usage data is available', () => {
      // Default state: 0 seconds used, no quota — matches real getUsageState() initial state
      usageStateMock.value = { monthlySeconds: 0, monthlyQuotaSeconds: null };
      render(() => <Header {...defaultSessionProps} />);

      // Open user menu
      fireEvent.click(screen.getByTestId('header-user-menu'));

      const usageItem = screen.getByTestId('header-user-dropdown-usage');
      expect(usageItem).toBeInTheDocument();
      expect(usageItem.textContent).toContain('Usage');
      // Should NOT contain time formatting (monthlySeconds is 0 and quota is null)
      expect(usageItem.textContent).not.toMatch(/\d+h\s*\d+m/);
    });

    it('should show usage with unlimited quota (no denominator)', () => {
      // 5h = 18000 seconds, unlimited quota = null
      usageStateMock.value = { monthlySeconds: 18000, monthlyQuotaSeconds: null };
      render(() => <Header {...defaultSessionProps} />);

      // Open user menu
      fireEvent.click(screen.getByTestId('header-user-menu'));

      const usageItem = screen.getByTestId('header-user-dropdown-usage');
      expect(usageItem).toBeInTheDocument();
      // Should show "5h"
      expect(usageItem.textContent).toMatch(/5h/);
    });

    it('should show zero usage correctly', () => {
      usageStateMock.value = { monthlySeconds: 0, monthlyQuotaSeconds: 3600 };
      render(() => <Header {...defaultSessionProps} />);

      // Open user menu
      fireEvent.click(screen.getByTestId('header-user-menu'));

      const usageItem = screen.getByTestId('header-user-dropdown-usage');
      expect(usageItem).toBeInTheDocument();
      // Should show "0s / 1h"
      expect(usageItem.textContent).toMatch(/0s/);
    });
  });

  describe('Auth URL Button', () => {
    it('renders auth URL button when terminalStore.authUrl is set', () => {
      terminalStoreMock.authUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc';
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn');
      expect(authBtn).toBeInTheDocument();
      expect(authBtn?.textContent).toContain('Open URL');
    });

    it('does NOT render auth URL button when terminalStore.authUrl is null', () => {
      terminalStoreMock.authUrl = null;
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn');
      expect(authBtn).not.toBeInTheDocument();
    });

    it('auth URL button has bounce animation class', () => {
      terminalStoreMock.authUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc';
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn');
      expect(authBtn).toBeInTheDocument();
      // The button or its container should have the bounce-in animation class
      expect(authBtn?.className).toContain('header-auth-url-bounce-in');
    });

    it('clicking auth URL button calls window.open with the URL', () => {
      const testUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc';
      terminalStoreMock.authUrl = testUrl;

      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn') as HTMLElement;
      expect(authBtn).toBeInTheDocument();
      fireEvent.click(authBtn);

      expect(openSpy).toHaveBeenCalledWith(testUrl, '_blank', 'noopener');
      openSpy.mockRestore();
    });
  });

  // REQ-SUB-023 AC1/AC3/AC6/AC7: Subscription remains SaaS-only while Usage
  // and supported self-service actions stay available outside enterprise.
  describe('Subscription/Usage gating', () => {
    it('shows the Subscription menu item in SaaS mode', () => {
      sessionStoreState.saasMode = true;
      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-user-menu'));

      expect(screen.getByTestId('header-user-dropdown-profile')).toBeInTheDocument();
    });

    it('shows Usage but hides Subscription in onboarding/default mode', () => {
      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-user-menu'));

      expect(screen.queryByTestId('header-user-dropdown-profile')).not.toBeInTheDocument();
      expect(screen.getByTestId('header-user-dropdown-usage')).toBeInTheDocument();
      expect(screen.getByTestId('header-user-dropdown-onboarding')).toBeInTheDocument();
      expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
    });

  });

  // REQ-SUB-023 AC1/AC3-AC5: enterprise keeps the read-only Usage action while
  // Subscription, Guided Setup, and Logout remain suppressed.
  describe('enterprise user menu', () => {
    it('shows Guided Setup and Logout outside enterprise mode', () => {
      render(() => <Header {...defaultSessionProps} />);
      fireEvent.click(screen.getByTestId('header-user-menu'));
      expect(screen.getByTestId('header-user-dropdown-onboarding')).toBeInTheDocument();
      expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
    });

    it('opens a Usage-only dropdown in enterprise mode', () => {
      sessionStoreState.enterpriseMode = true;
      render(() => <Header {...defaultSessionProps} />);
      expect(screen.getByTestId('header-user-menu')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('header-user-menu'));
      expect(screen.getByTestId('header-user-dropdown')).toBeInTheDocument();
      expect(screen.getByTestId('header-user-dropdown-usage')).toBeInTheDocument();
      expect(screen.queryByTestId('header-user-dropdown-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('header-user-dropdown-onboarding')).not.toBeInTheDocument();
      expect(screen.queryByTestId('header-user-dropdown-logout')).not.toBeInTheDocument();
    });
  });
});
