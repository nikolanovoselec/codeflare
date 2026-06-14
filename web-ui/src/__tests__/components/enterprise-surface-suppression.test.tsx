/**
 * REQ-ENTERPRISE-008: Enterprise Frontend Surface Suppression.
 *
 * In enterprise mode the SaaS/admin surfaces must not render; with the flag unset
 * everything renders byte-identically (AC6). This file renders the real components
 * and asserts each surface is absent in enterprise mode and present otherwise:
 *   - Header username dropdown: Usage + Subscription (AC2)
 *   - SettingsPanel Administration: Manage Users + Manage Subscriptions (AC1)
 *   - SettingsPanel / SessionSection: Standard/Pro selector (AC3)
 *
 * Layout quota banners (AC4) and prop threading live in
 * enterprise-layout-suppression.test.tsx (Layout's child mocks would conflict
 * with the real-component renders here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import Header from '../../components/Header';
import SettingsPanel from '../../components/SettingsPanel';
import SessionSection from '../../components/settings/SessionSection';

// ---------------------------------------------------------------------------
// Shared module mocks (one factory per module path — covers every component
// rendered in this file).
// ---------------------------------------------------------------------------
vi.mock('../../lib/mobile', () => ({
  isMobile: () => false,
  isTouchDevice: () => false,
  getKeyboardHeight: () => 0,
  get isSamsungBrowser() { return false; },
}));

vi.mock('../../components/SessionSwitcher', () => ({
  default: () => <div data-testid="session-switcher" />,
}));

vi.mock('../../components/UsageInlineBadge', () => ({
  default: () => <span data-testid="usage-badge" />,
}));

// SettingsPanel children we don't assert on — stub to avoid their API deps.
vi.mock('../../components/settings/AppearanceSection', () => ({ default: () => <div data-testid="appearance-section" /> }));
vi.mock('../../components/settings/DeployKeysSection', () => ({ default: () => <div data-testid="deploy-section" /> }));
vi.mock('../../components/settings/LlmKeysSection', () => ({ default: () => <div data-testid="llm-section" /> }));

vi.mock('../../stores/terminal', () => ({
  terminalStore: { get authUrl() { return null; } },
}));

const sessionStoreState = vi.hoisted(() => ({
  preferences: { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: undefined } as Record<string, unknown>,
  presets: [] as unknown[],
  activeSessionId: null as string | null,
  error: null as string | null,
  saasMode: false as boolean,
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get preferences() { return sessionStoreState.preferences; },
    get presets() { return sessionStoreState.presets; },
    get activeSessionId() { return sessionStoreState.activeSessionId; },
    get error() { return sessionStoreState.error; },
    get saasMode() { return sessionStoreState.saasMode; },
    loadPresets: vi.fn(async () => undefined),
    saveBookmarkForSession: vi.fn(async () => null),
    applyPresetToSession: vi.fn(async () => true),
    deletePreset: vi.fn(async () => undefined),
    renamePreset: vi.fn(async () => null),
    updatePreferences: vi.fn(async () => undefined),
  },
  getUsageState: () => ({ monthlySeconds: 0, monthlyQuotaSeconds: null }),
}));

vi.mock('../../api/client', () => ({
  getUser: vi.fn(async () => ({ email: 'admin@example.com', authenticated: true, role: 'admin', subscribedMode: 'advanced', hasSubscribed: true })),
  getLlmKeys: vi.fn(async () => ({})),
  updateLlmKeys: vi.fn(async () => ({})),
  getDeployKeys: vi.fn(async () => ({})),
  updateDeployKeys: vi.fn(async () => ({})),
  deleteDeployKeys: vi.fn(async () => undefined),
}));

vi.mock('../../api/storage', () => ({
  recreateGettingStartedDocs: vi.fn(async () => ({ success: true, bucketCreated: false, written: [], skipped: [] })),
  recreateAgentConfigs: vi.fn(async () => ({ success: true, written: [], deleted: [] })),
}));

vi.mock('../../lib/settings', () => ({
  defaultSettings: {},
  loadSettings: () => ({}),
  saveSettings: vi.fn(),
}));

const headerProps = {
  sessions: [],
  activeSessionId: null,
  onSelectSession: () => {},
  onStopSession: () => {},
  onDeleteSession: () => {},
  onCreateSession: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: undefined };
  sessionStoreState.presets = [];
  sessionStoreState.activeSessionId = null;
  sessionStoreState.error = null;
  sessionStoreState.saasMode = false;
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// AC2 — Header username dropdown
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-008 AC2: Header username dropdown', () => {
  it('hides Usage and Subscription in enterprise mode', () => {
    render(() => <Header {...headerProps} enterpriseMode />);
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.queryByTestId('header-user-dropdown-usage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('header-user-dropdown-profile')).not.toBeInTheDocument();
    // Non-SaaS items remain.
    expect(screen.getByTestId('header-user-dropdown-onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
  });

  it('hides Usage and Subscription in onboarding/default mode (not enterprise, not SaaS)', () => {
    render(() => <Header {...headerProps} />);
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.queryByTestId('header-user-dropdown-usage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('header-user-dropdown-profile')).not.toBeInTheDocument();
    // Non-billing items remain.
    expect(screen.getByTestId('header-user-dropdown-onboarding')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-logout')).toBeInTheDocument();
  });

  it('renders Usage and Subscription in SaaS mode (AC6)', () => {
    sessionStoreState.saasMode = true;
    render(() => <Header {...headerProps} />);
    fireEvent.click(screen.getByTestId('header-user-menu'));
    expect(screen.getByTestId('header-user-dropdown-usage')).toBeInTheDocument();
    expect(screen.getByTestId('header-user-dropdown-profile')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC3 — SettingsPanel Administration + session-mode selector
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-008 AC1/AC3: SettingsPanel', () => {
  const panelProps = { isOpen: true, onClose: () => {}, currentUserEmail: 'admin@example.com', currentUserRole: 'admin' as const };

  it('hides Manage Users, Manage Subscriptions, and the mode selector in enterprise mode', () => {
    render(() => <SettingsPanel {...panelProps} enterpriseMode />);
    expect(screen.queryByText('Manage Users')).not.toBeInTheDocument();
    expect(screen.queryByText('Manage Subscriptions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-mode-control')).not.toBeInTheDocument();
    // Setup Wizard stays — admins still configure the deployment.
    expect(screen.getByText('Setup Wizard')).toBeInTheDocument();
  });

  it('keeps Manage Users but hides Manage Subscriptions + the mode selector in onboarding/default mode', () => {
    render(() => <SettingsPanel {...panelProps} />);
    // Manage Users is admin, not billing — it stays outside enterprise.
    expect(screen.getByText('Manage Users')).toBeInTheDocument();
    // SaaS-billing surfaces are gated on saasMode.
    expect(screen.queryByText('Manage Subscriptions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-mode-control')).not.toBeInTheDocument();
  });

  it('renders all admin surfaces and the mode selector in SaaS mode (AC6)', () => {
    sessionStoreState.saasMode = true;
    render(() => <SettingsPanel {...panelProps} />);
    expect(screen.getByText('Manage Users')).toBeInTheDocument();
    expect(screen.getByText('Manage Subscriptions')).toBeInTheDocument();
    expect(screen.getByTestId('session-mode-control')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC3 — SessionSection mode selector (isolated)
// ---------------------------------------------------------------------------
describe('REQ-ENTERPRISE-008 AC3: SessionSection mode selector', () => {
  const sectionProps = {
    currentSessionMode: () => 'default' as const,
    canUseAdvanced: () => true,
    fastStartEnabled: () => true,
    workspaceSyncEnabled: () => false,
    clipboardAccess: () => false,
    sleepAfter: () => '30m',
    canChangeSleepAfter: () => true,
    isFreeUser: () => false,
    recreateDocsLoading: () => false,
    recreateDocsMessage: () => null,
    recreateDocsError: () => null,
    recreateAgentLoading: () => false,
    recreateAgentMessage: () => null,
    recreateAgentError: () => null,
    onSessionModeChange: () => {},
    onFastStartToggle: () => {},
    onWorkspaceSyncToggle: () => {},
    onSleepAfterChange: () => {},
    onRecreateDocs: () => {},
    onRecreateAgentConfigs: () => {},
    updateSetting: () => {},
  };

  it('does not render the Standard/Pro selector outside SaaS mode (enterprise/onboarding/default)', () => {
    render(() => <SessionSection {...sectionProps} saasMode={() => false} />);
    expect(screen.queryByTestId('session-mode-control')).not.toBeInTheDocument();
  });

  it('renders the Standard/Pro selector in SaaS mode', () => {
    render(() => <SessionSection {...sectionProps} saasMode={() => true} />);
    expect(screen.getByTestId('session-mode-control')).toBeInTheDocument();
  });

  it('does not render the selector when no saasMode accessor is provided (treated as not SaaS)', () => {
    render(() => <SessionSection {...sectionProps} />);
    expect(screen.queryByTestId('session-mode-control')).not.toBeInTheDocument();
  });
});
