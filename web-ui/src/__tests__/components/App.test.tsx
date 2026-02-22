import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@solidjs/testing-library';

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
