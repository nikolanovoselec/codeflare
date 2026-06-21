/**
 * REQ-AUTH-007 AC3 + AC5: the SaaS-mode frontend first-login redirects, performed
 * imperatively by App.tsx via `window.location.href`.
 *
 *  - AC3: a `pending`-tier user is redirected to the subscription page (/app/subscribe).
 *  - AC5: a first-time active user (onboardingComplete !== true) is redirected to the
 *         guided onboarding flow (/app/onboarding).
 *
 * Mirrors the established App-redirect harness in enterprise-app-routing.test.tsx:
 * window.location is replaced with a stub whose `href` setter records the assigned
 * value (no real navigation) so the imperative redirect target is observable.
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
    setSaasMode: vi.fn(),
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
  // Stub location: reading reflects /app; assigning .href records the value
  // (no navigation) so the imperative redirect target can be asserted.
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

describe('REQ-AUTH-007 AC3: pending user redirected to subscribe', () => {
  it('redirects a pending SaaS user to /app/subscribe', async () => {
    getUserMock.mockResolvedValue({
      email: 'pending@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: true, enterpriseMode: false, onboardingComplete: true,
      subscriptionTier: 'pending', accessTier: 'pending',
    });

    render(() => <App />);

    await waitFor(() => expect(assignedHref).toBe('/app/subscribe'));
  });

  it('falls back to accessTier when subscriptionTier is absent (effectiveTier pending → subscribe)', async () => {
    getUserMock.mockResolvedValue({
      email: 'pending2@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: true, enterpriseMode: false, onboardingComplete: true,
      accessTier: 'pending',
    });

    render(() => <App />);

    await waitFor(() => expect(assignedHref).toBe('/app/subscribe'));
  });

  it('does not redirect a pending user to subscribe outside SaaS mode', async () => {
    getUserMock.mockResolvedValue({
      email: 'pending3@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: false, enterpriseMode: false, onboardingComplete: true,
      subscriptionTier: 'pending', accessTier: 'pending',
    });

    render(() => <App />);

    await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());
    expect(assignedHref).toBeNull();
  });
});

describe('REQ-AUTH-007 AC5: first-time active user redirected to onboarding', () => {
  it('redirects a first-time active SaaS user to /app/onboarding', async () => {
    getUserMock.mockResolvedValue({
      email: 'active@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: true, enterpriseMode: false, onboardingComplete: false,
      subscriptionTier: 'advanced', accessTier: 'advanced',
    });

    render(() => <App />);

    await waitFor(() => expect(assignedHref).toBe('/app/onboarding'));
  });

  it('does not redirect to onboarding once onboarding is complete', async () => {
    getUserMock.mockResolvedValue({
      email: 'returning@example.com', authenticated: true, bucketName: 'b', role: 'user',
      saasMode: true, enterpriseMode: false, onboardingComplete: true,
      subscriptionTier: 'advanced', accessTier: 'advanced',
    });

    render(() => <App />);

    await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());
    expect(assignedHref).toBeNull();
  });
});
