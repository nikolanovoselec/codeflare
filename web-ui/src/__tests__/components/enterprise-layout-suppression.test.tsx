/**
 * REQ-ENTERPRISE-008 AC4 + prop threading.
 *
 * AC4: the monthly-quota warning banners and their "Upgrade" CTAs never render in
 * enterprise mode. This file also verifies Layout threads `enterpriseMode` into the
 * children that own the remaining suppressed surfaces (Header dropdown, Dashboard
 * dropdown via TerminalArea, SettingsPanel admin buttons), with the children stubbed
 * so their own deps stay out of this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';

vi.mock('../../components/Header', () => ({
  default: (props: Record<string, unknown>) => {
    (window as unknown as Record<string, unknown>).__headerProps = props;
    return <header data-testid="header" />;
  },
}));

vi.mock('../../components/TerminalArea', () => ({
  default: (props: Record<string, unknown>) => {
    (window as unknown as Record<string, unknown>).__terminalAreaProps = props;
    return <main data-testid="terminal-area" />;
  },
}));

vi.mock('../../components/SettingsPanel', () => ({
  default: (props: Record<string, unknown>) => {
    (window as unknown as Record<string, unknown>).__settingsPanelProps = props;
    return <div data-testid="settings-panel" />;
  },
}));

vi.mock('../../components/SplashCursor', () => ({ default: () => <div data-testid="splash-cursor" /> }));
vi.mock('../../components/StoragePanel', () => ({ default: () => <div data-testid="storage-panel" /> }));

const usageState = vi.hoisted(() => ({ warning: 'none' as string, dismissed: null as string | null, saasMode: false as boolean }));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get sessions() { return []; },
    get activeSessionId() { return null; },
    get error() { return null; },
    get preferences() { return {}; },
    get saasMode() { return usageState.saasMode; },
    loadSessions: vi.fn(),
    loadPresets: vi.fn(),
    loadPreferences: vi.fn(),
    getActiveSession: vi.fn(() => null),
    setActiveSession: vi.fn(),
    isSessionInitializing: vi.fn(() => false),
    startSessionListPolling: vi.fn(),
    stopSessionListPolling: vi.fn(),
    stopAllPolling: vi.fn(),
    refreshSessionStatuses: vi.fn(),
  },
  getUsageWarningLevel: vi.fn(() => usageState.warning),
  isAtUsageQuota: vi.fn(() => false),
  setUsageState: vi.fn(),
  getDismissedQuotaLevel: vi.fn(() => usageState.dismissed),
  setDismissedQuotaLevel: vi.fn((level: string) => { usageState.dismissed = level; }),
}));

vi.mock('../../stores/storage', () => ({
  storageStore: { fetchStats: vi.fn(), refresh: vi.fn() },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: { reconnect: vi.fn(), triggerLayoutResize: vi.fn(), disposeAll: vi.fn() },
  reconnectDisconnectedTerminals: vi.fn(),
  reconnectOnVisibilityReturn: vi.fn(),
  scheduleDisconnect: vi.fn(),
  cancelScheduledDisconnect: vi.fn(),
}));

vi.mock('../../lib/mobile', () => ({
  forceResetKeyboardState: vi.fn(),
  enableVirtualKeyboardOverlay: vi.fn(),
  cleanupDebugOverlay: vi.fn(),
  isSamsungBrowser: false,
}));

import Layout from '../../components/Layout';

beforeEach(() => {
  vi.clearAllMocks();
  usageState.warning = 'none';
  usageState.dismissed = null;
  usageState.saasMode = false;
  delete (window as unknown as Record<string, unknown>).__headerProps;
  delete (window as unknown as Record<string, unknown>).__terminalAreaProps;
  delete (window as unknown as Record<string, unknown>).__settingsPanelProps;
});

afterEach(() => cleanup());

describe('REQ-ENTERPRISE-008 AC4: quota banners render only in SaaS mode', () => {
  it('does not render the 100% banner in enterprise mode', () => {
    usageState.warning = '100';
    render(() => <Layout enterpriseMode />);
    expect(screen.queryByTestId('usage-warning-100')).not.toBeInTheDocument();
  });

  it('does not render the 100% banner in onboarding/default mode (not enterprise, not SaaS)', () => {
    usageState.warning = '100';
    render(() => <Layout />);
    expect(screen.queryByTestId('usage-warning-100')).not.toBeInTheDocument();
  });

  it('renders the 100% banner in SaaS mode (AC6)', () => {
    usageState.warning = '100';
    usageState.saasMode = true;
    render(() => <Layout />);
    expect(screen.getByTestId('usage-warning-100')).toBeInTheDocument();
  });

  it('does not render the 80% banner in enterprise mode', () => {
    usageState.warning = '80';
    render(() => <Layout enterpriseMode />);
    expect(screen.queryByTestId('usage-warning-80')).not.toBeInTheDocument();
  });

  it('does not render the 80% banner in onboarding/default mode (not enterprise, not SaaS)', () => {
    usageState.warning = '80';
    render(() => <Layout />);
    expect(screen.queryByTestId('usage-warning-80')).not.toBeInTheDocument();
  });

  it('renders the 80% banner in SaaS mode (AC6)', () => {
    usageState.warning = '80';
    usageState.saasMode = true;
    render(() => <Layout />);
    expect(screen.getByTestId('usage-warning-80')).toBeInTheDocument();
  });
});

describe('REQ-ENTERPRISE-008: Layout threads enterpriseMode to children that own suppressed surfaces', () => {
  it('passes enterpriseMode to TerminalArea (→ Dashboard dropdown) and SettingsPanel (admin buttons)', () => {
    render(() => <Layout enterpriseMode />);
    const ta = (window as unknown as Record<string, unknown>).__terminalAreaProps as { enterpriseMode?: boolean };
    const sp = (window as unknown as Record<string, unknown>).__settingsPanelProps as { enterpriseMode?: boolean };
    expect(ta.enterpriseMode).toBe(true);
    expect(sp.enterpriseMode).toBe(true);
  });

  it('passes enterpriseMode falsy to children when the flag is unset (AC6)', () => {
    render(() => <Layout />);
    const ta = (window as unknown as Record<string, unknown>).__terminalAreaProps as { enterpriseMode?: boolean };
    const sp = (window as unknown as Record<string, unknown>).__settingsPanelProps as { enterpriseMode?: boolean };
    expect(ta.enterpriseMode).toBeFalsy();
    expect(sp.enterpriseMode).toBeFalsy();
  });
});
