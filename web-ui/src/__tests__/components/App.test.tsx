import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';

const getSetupStatusMock = vi.fn();
const getUserMock = vi.fn();
const getOnboardingConfigMock = vi.fn();

vi.mock('../../api/client', () => ({
  getSetupStatus: (...args: unknown[]) => getSetupStatusMock(...args),
  getUser: (...args: unknown[]) => getUserMock(...args),
  getOnboardingConfig: (...args: unknown[]) => getOnboardingConfigMock(...args),
}));

vi.mock('../../components/Layout', () => ({
  default: () => <div data-testid="layout">layout</div>,
}));

vi.mock('../../components/setup/SetupWizard', () => ({
  default: () => <div data-testid="setup-wizard">setup</div>,
}));

vi.mock('../../components/OnboardingLanding', () => ({
  default: () => <div data-testid="onboarding-landing">onboarding</div>,
}));

vi.mock('../../components/admin/AdministrationLayout', () => ({
  default: (props: { children?: JSX.Element }) => <div data-testid="administration-shell">{props.children}</div>,
}));

vi.mock('../../components/admin/AdministrationOverview', () => ({
  default: () => <div data-testid="administration-overview" />,
}));

vi.mock('../../components/admin/EnvironmentIndex', () => ({
  default: () => <div data-testid="administration-environment" />,
  EnvironmentAreaDetail: () => <div data-testid="administration-environment-detail" />,
}));

vi.mock('../../components/admin/AnalyticsPage', () => ({
  default: () => <div data-testid="administration-analytics" />,
}));

vi.mock('../../components/admin/ReportsPage', () => ({
  default: () => <div data-testid="administration-reports" />,
}));

vi.mock('../../components/admin/ActivityPage', () => ({
  default: () => <div data-testid="administration-activity" />,
}));

vi.mock('../../components/admin/UserManagement', () => ({
  default: () => <div data-testid="administration-users" />,
}));

vi.mock('../../components/admin/SubscriptionManagement', () => ({
  default: () => <div data-testid="administration-subscriptions" />,
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    stopAllPolling: vi.fn(),
  },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    disposeAll: vi.fn(),
  },
}));

import App from '../../App';

// REQ-SETUP-003: three deployment modes — App routes to the setup wizard when the
// deployment is not yet configured.
describe('App setup routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Start at /app for setup guard tests (/ is now the onboarding route)
    window.history.replaceState({}, '', '/app');
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    getUserMock.mockResolvedValue({
      email: 'user@example.com',
      authenticated: true,
      bucketName: 'test-bucket',
      role: 'user',
    });
    getOnboardingConfigMock.mockResolvedValue({ active: false, turnstileSiteKey: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('redirects to /setup when setup is explicitly not configured', async () => {
    getSetupStatusMock.mockResolvedValue({ configured: false });

    render(() => <App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/setup');
    });

    expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
  });

  it('does not redirect to /setup when setup status check fails', async () => {
    getSetupStatusMock.mockRejectedValue(new Error('access redirect'));

    render(() => <App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/app');
    });

    await waitFor(() => {
      expect(screen.getByTestId('layout')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument();
  });
});

describe('REQ-SETUP-019 AC1: exposes Administration routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    getSetupStatusMock.mockResolvedValue({ configured: true });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    ['/admin', 'administration-overview'],
    ['/admin/environment', 'administration-environment'],
    ['/admin/analytics', 'administration-analytics'],
    ['/admin/reports', 'administration-reports'],
    ['/admin/activity', 'administration-activity'],
  ])('renders %s', async (path, testId) => {
    window.history.replaceState({}, '', path);
    render(() => <App />);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it('does not expose an Administration configuration page', async () => {
    window.history.replaceState({}, '', '/admin/configuration');
    render(() => <App />);
    await waitFor(() => expect(getSetupStatusMock).toHaveBeenCalled());
    expect(screen.queryByTestId('administration-environment')).not.toBeInTheDocument();
    expect(screen.queryByTestId('administration-overview')).not.toBeInTheDocument();
  });
});

describe('REQ-SETUP-019 AC3: embeds existing administration components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    getSetupStatusMock.mockResolvedValue({ configured: true });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    ['/admin/users', 'administration-users'],
    ['/admin/subscriptions', 'administration-subscriptions'],
  ])('renders the existing component at %s', async (path, testId) => {
    window.history.replaceState({}, '', path);
    render(() => <App />);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });
});

describe('App onboarding routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    getUserMock.mockRejectedValue(new Error('Not authenticated'));
    getOnboardingConfigMock.mockResolvedValue({ active: true, turnstileSiteKey: 'test-key' });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders OnboardingLanding at / route', async () => {
    render(() => <App />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-landing')).toBeInTheDocument();
    });
  });
});
