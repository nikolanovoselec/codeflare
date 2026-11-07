import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';
import { ApiError } from '../../api/fetch-helper';

const getSetupStatusMock = vi.fn();
const getUserMock = vi.fn();
const getOnboardingConfigMock = vi.fn();
const getPortalsMock = vi.fn().mockResolvedValue([]);
const recoverPortalMock = vi.fn();
vi.mock('../../api/mcp-portals', () => ({
  getMcpPortalStatuses: (...args: unknown[]) => getPortalsMock(...args),
  recoverMcpPortal: (...args: unknown[]) => recoverPortalMock(...args),
}));

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
    setEnterpriseMode: vi.fn(),
    setSaasMode: vi.fn(),
    setAllowedAgents: vi.fn(),
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
    expect(await screen.findByTestId('layout')).toBeInTheDocument();
    expect(screen.queryByTestId('administration-shell')).not.toBeInTheDocument();
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

describe('REQ-AGENT-226 AC6: authenticated app portal recovery', () => {
  let visibility: DocumentVisibilityState;
  let originalVisibility: PropertyDescriptor | undefined;
  let originalLocation: Location;
  let providerNavigation: string[];
  const owner = { email: 'owner@example.com', authenticated: true, role: 'user' };
  const providerUrl = 'https://portal.example/authorize?state=synthetic-owner-state';
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function changeVisibility(value: DocumentVisibilityState) {
    visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/app/session/abcdef0123456789');
    sessionStorage.clear();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    getSetupStatusMock.mockResolvedValue({ configured: true });
    getUserMock.mockResolvedValue({ email: 'owner@example.com', authenticated: true, role: 'user' });
    getPortalsMock.mockResolvedValue([{ name: 'alpha', url: 'https://alpha.example/mcp', connected: true }]);
    recoverPortalMock.mockResolvedValue({ state: 'unavailable' });
    visibility = 'visible';
    originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    originalLocation = window.location;
    providerNavigation = [];
    Object.defineProperty(window, 'location', { configurable: true, value: {
      get href() { return originalLocation.href; }, get pathname() { return originalLocation.pathname; },
      get search() { return originalLocation.search; }, get hash() { return originalLocation.hash; },
      get origin() { return originalLocation.origin; },
      assign: (url: string) => { providerNavigation.push(url); }, replace: () => {}, reload: () => {},
      toString: () => originalLocation.href,
    } });
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    getPortalsMock.mockResolvedValue([]); sessionStorage.clear();
  });

  it('silently renews the owner grant with Settings closed and keeps the active session', async () => {
    let grantReady = false;
    recoverPortalMock.mockImplementation(async () => { grantReady = true; return { state: 'ready' }; });
    render(() => <App />);
    expect(await screen.findByTestId('layout')).toBeInTheDocument();
    await waitFor(() => expect(grantReady).toBe(true));
    expect(window.location.pathname).toBe('/app/session/abcdef0123456789');
    expect(screen.queryByText('Authentication Error')).not.toBeInTheDocument();
  });

  it('does not renew portal grants when browser owner authentication fails', async () => {
    let grantReady = false;
    getUserMock.mockRejectedValue(new Error('not authenticated'));
    recoverPortalMock.mockImplementation(async () => { grantReady = true; return { state: 'ready' }; });
    render(() => <App />);
    await screen.findByTestId('layout'); // Existing DEV auth fallback does not confer owner authority.
    expect(grantReady).toBe(false);
  });

  it.each(['rejected', 'changed-owner'] as const)(
    'discards an old recovery response while resume owner authentication is pending (%s)', async outcome => {
      const recovery = deferred<{ state: 'authorization'; url: string }>();
      const authentication = deferred<typeof owner>();
      let oldRequestPending = true;
      let requestEntered = false;
      let currentOwnerRecovered = false;
      recoverPortalMock.mockImplementation(async () => {
        if (oldRequestPending) {
          oldRequestPending = false; requestEntered = true;
          return recovery.promise;
        }
        currentOwnerRecovered = true;
        return { state: 'ready' };
      });
      render(() => <App />);
      await screen.findByTestId('layout');
      await waitFor(() => expect(requestEntered).toBe(true));
      changeVisibility('hidden');
      getUserMock.mockImplementationOnce(() => authentication.promise);
      changeVisibility('visible');
      recovery.resolve({ state: 'authorization', url: providerUrl });
      await recovery.promise;
      await Promise.resolve();
      expect(providerNavigation).toEqual([]);
      expect(currentOwnerRecovered).toBe(false);
      if (outcome === 'rejected') {
        authentication.reject(new ApiError('Owner session expired', 401, 'Unauthorized'));
        await screen.findByTestId('auth-redirecting');
      } else {
        authentication.resolve({ ...owner, email: 'other-owner@example.com' });
        await waitFor(() => expect(currentOwnerRecovered).toBe(true));
      }
      expect(providerNavigation).toEqual([]);
    });

  it('resumes recovery on authenticated BFCache Back without remounting or repeating authorization', async () => {
    getPortalsMock.mockResolvedValue([
      { name: 'alpha', url: 'https://alpha.example/mcp', connected: true },
      { name: 'beta', url: 'https://beta.example/mcp', connected: true },
    ]);
    let betaRecovered = false;
    recoverPortalMock.mockImplementation(async (name: string, authorize: boolean) => {
      if (name === 'alpha') return authorize ? { state: 'authorization', url: providerUrl } : { state: 'unavailable' };
      betaRecovered = true;
      return { state: 'ready' };
    });
    render(() => <App />);
    const layout = await screen.findByTestId('layout');
    await waitFor(() => expect(providerNavigation).toEqual([providerUrl]));
    expect(betaRecovered).toBe(false);
    const back = new Event('pageshow');
    Object.defineProperty(back, 'persisted', { value: true });
    window.dispatchEvent(back);
    await waitFor(() => expect(betaRecovered).toBe(true));
    expect(screen.getByTestId('layout')).toBe(layout);
    expect(providerNavigation).toEqual([providerUrl]);
  });

});
