/**
 * REQ-ENTERPRISE-008 AC5: a first-time (auto-provisioned) enterprise user is routed
 * to the app home, never to /app/subscribe or the self-serve onboarding flow.
 *
 * App.tsx performs the first-login redirect imperatively in onMount. We swap
 * window.location for a URL so an href assignment updates pathname without a real
 * navigation, then assert whether the onboarding redirect fired.
 */
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

vi.mock('../../stores/session', () => ({
  sessionStore: {
    stopAllPolling: vi.fn(),
    setEnterpriseMode: vi.fn(),
  },
}));

vi.mock('../../stores/storage', () => ({
  storageStore: { setWorkerName: vi.fn() },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: { disposeAll: vi.fn() },
}));

import App from '../../App';

let originalLocation: Location;

beforeEach(() => {
  vi.clearAllMocks();
  originalLocation = window.location;
  // A URL stands in for window.location: assigning .href updates .pathname
  // (relative URLs resolve against the base) but performs no real navigation.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: new URL('http://localhost/app'),
  });
  getSetupStatusMock.mockResolvedValue({ configured: true });
  getOnboardingConfigMock.mockResolvedValue({ active: false, turnstileSiteKey: null });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  cleanup();
});

describe('REQ-ENTERPRISE-008 AC5: enterprise first-login routing', () => {
  it('does not redirect an un-onboarded enterprise user to /app/onboarding', async () => {
    getUserMock.mockResolvedValue({
      email: 'new@example.com',
      authenticated: true,
      bucketName: 'b',
      role: 'user',
      saasMode: true,
      enterpriseMode: true,
      onboardingComplete: false,
      subscriptionTier: 'unlimited',
      accessTier: 'advanced',
    });

    render(() => <App />);

    await waitFor(() => expect(getUserMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());
    // No imperative redirect happened — still on the app home.
    expect(window.location.pathname).toBe('/app');
  });

  it('still redirects an un-onboarded non-enterprise SaaS user to /app/onboarding (AC6)', async () => {
    getUserMock.mockResolvedValue({
      email: 'saas@example.com',
      authenticated: true,
      bucketName: 'b',
      role: 'user',
      saasMode: true,
      enterpriseMode: false,
      onboardingComplete: false,
      subscriptionTier: 'advanced',
      accessTier: 'advanced',
    });

    render(() => <App />);

    await waitFor(() => expect(window.location.pathname).toBe('/app/onboarding'));
  });
});
