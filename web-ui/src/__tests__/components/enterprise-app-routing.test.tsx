/**
 * REQ-ENTERPRISE-008 AC5: a first-time (auto-provisioned) enterprise user is routed
 * to the app home, never to /app/subscribe or the self-serve onboarding flow.
 *
 * App.tsx performs the first-login redirect imperatively via `window.location.href`.
 * We replace window.location with a stub whose `href` setter records the assignment
 * (no real navigation), so we can assert whether the onboarding redirect fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@solidjs/testing-library';

const getSetupStatusMock = vi.fn();
const getUserMock = vi.fn();
const getOnboardingConfigMock = vi.fn();
const { setEnterpriseModeSpy } = vi.hoisted(() => ({ setEnterpriseModeSpy: vi.fn() }));

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
    setEnterpriseMode: setEnterpriseModeSpy,
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
let assignedHref: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  assignedHref = null;
  originalLocation = window.location;
  // A stub location: reading reflects /app; assigning .href records the value
  // (no navigation) so we can observe the imperative redirect.
  const stub: Record<string, unknown> = {
    pathname: '/app', search: '', hash: '', origin: 'http://localhost',
    host: 'localhost', hostname: 'localhost', protocol: 'http:', port: '',
    assign: (v: string) => { assignedHref = v; },
    replace: (v: string) => { assignedHref = v; },
    reload: () => {},
    toString: () => 'http://localhost/app',
  };
  Object.defineProperty(stub, 'href', {
    get: () => 'http://localhost/app',
    set: (v: string) => { assignedHref = v; },
  });
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: stub });
  getSetupStatusMock.mockResolvedValue({ configured: true });
  getOnboardingConfigMock.mockResolvedValue({ active: false, turnstileSiteKey: null });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  cleanup();
});

describe('REQ-ENTERPRISE-008 AC5: enterprise first-login routing', () => {
  it('does not redirect an un-onboarded enterprise user to onboarding/subscribe', async () => {
    getUserMock.mockResolvedValue({
      email: 'new@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: true, enterpriseMode: true, onboardingComplete: false,
      subscriptionTier: 'unlimited', accessTier: 'advanced',
    });

    render(() => <App />);

    // Wait until onMount has processed the user (setEnterpriseMode runs right before
    // the redirect guards), then assert no imperative redirect was recorded.
    await waitFor(() => expect(setEnterpriseModeSpy).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());
    expect(assignedHref).toBeNull();
  });

  it('still redirects an un-onboarded non-enterprise SaaS user to /app/onboarding (AC6)', async () => {
    getUserMock.mockResolvedValue({
      email: 'saas@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: true, enterpriseMode: false, onboardingComplete: false,
      subscriptionTier: 'advanced', accessTier: 'advanced',
    });

    render(() => <App />);

    await waitFor(() => expect(assignedHref).toBe('/app/onboarding'));
  });
});
