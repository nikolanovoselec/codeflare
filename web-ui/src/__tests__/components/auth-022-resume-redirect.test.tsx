/**
 * REQ-AUTH-022: session-expiry on resume → clean redirect, never a blank page.
 *
 * Mirrors the App-redirect harness (auth-007-app-redirect): window.location is a
 * stub, api/client + heavy stores/components are mocked. Assertions are by
 * data-testid / branch presence — never by UI copy.
 *
 *  - AC2: a 401 from getUser leaves the loading shell and shows the calm
 *         "redirecting" state (testid `auth-redirecting`), not the auth-error page.
 *  - AC3: RootPage renders a non-empty state for `redirect` mode (testid
 *         `root-redirecting`) instead of a blank document.
 *  - AC4: a render-time throw is caught by the top-level ErrorBoundary (testid
 *         `app-error-boundary`) rather than painting blank.
 *  - AC6: visibility and bfcache resume revalidate auth and replace a stale app
 *         shell with the redirecting state when the Access session expired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@solidjs/testing-library';
import { ApiError } from '../../api/fetch-helper';

const getSetupStatusMock = vi.fn();
const getUserMock = vi.fn();
const getOnboardingConfigMock = vi.fn();
const getAuthProvidersMock = vi.fn();
const getAuthStatusMock = vi.fn();

vi.mock('../../api/client', () => ({
  getSetupStatus: (...a: unknown[]) => getSetupStatusMock(...a),
  getUser: (...a: unknown[]) => getUserMock(...a),
  getOnboardingConfig: (...a: unknown[]) => getOnboardingConfigMock(...a),
  getAuthProviders: (...a: unknown[]) => getAuthProvidersMock(...a),
  getAuthStatus: (...a: unknown[]) => getAuthStatusMock(...a),
}));

let layoutShouldThrow = false;
vi.mock('../../components/Layout', () => ({
  default: () => {
    if (layoutShouldThrow) throw new Error('layout boom');
    return <div data-testid="layout">layout</div>;
  },
}));
vi.mock('../../components/setup/SetupWizard', () => ({ default: () => <div data-testid="setup-wizard">setup</div> }));
vi.mock('../../components/LoginPage', () => ({ default: () => <div data-testid="login-page">login</div> }));
vi.mock('../../components/OnboardingLanding', () => ({ default: () => <div data-testid="onboarding">onboarding</div> }));
vi.mock('../../stores/session', () => ({ sessionStore: { stopAllPolling: vi.fn(), setEnterpriseMode: vi.fn(), setSaasMode: vi.fn() } }));
vi.mock('../../stores/storage', () => ({ storageStore: { setWorkerName: vi.fn(), setDownloadsDisabled: vi.fn() } }));
vi.mock('../../stores/terminal', () => ({ terminalStore: { disposeAll: vi.fn() } }));

import App from '../../App';

let originalLocation: Location;

const authenticatedUser = {
  email: 'u@x', authenticated: true, bucketName: 'b', role: 'user',
  saasMode: false, enterpriseMode: false, onboardingComplete: true,
  subscriptionTier: 'advanced', accessTier: 'advanced',
} as const;

function stubLocation(pathname: string) {
  const stub: Record<string, unknown> = {
    pathname, search: '', hash: '', origin: 'http://localhost',
    host: 'localhost', hostname: 'localhost', protocol: 'http:', port: '',
    assign: () => {}, replace: () => {}, reload: () => {}, toString: () => `http://localhost${pathname}`,
  };
  Object.defineProperty(stub, 'href', { get: () => `http://localhost${pathname}`, set: () => {} });
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: stub });
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutShouldThrow = false;
  originalLocation = window.location;
  stubLocation('/app');
  getSetupStatusMock.mockResolvedValue({ configured: true });
  getOnboardingConfigMock.mockResolvedValue({ active: false, turnstileSiteKey: null });
  getAuthProvidersMock.mockResolvedValue({ providers: [] });
  getAuthStatusMock.mockResolvedValue({ saasMode: false });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  cleanup();
});

describe('REQ-AUTH-022 AC2: expired-session 401 shows the redirecting state, not a hung/blank or error page', () => {
  it('renders the redirecting state on an authRedirect 401 (Layout never mounts)', async () => {
    const err = new ApiError('Session expired — redirecting to sign in', 401, 'Unauthorized');
    err.authRedirect = true;
    getUserMock.mockRejectedValue(err);

    render(() => <App />);

    await waitFor(() => expect(screen.getByTestId('auth-redirecting')).toBeInTheDocument());
    expect(screen.queryByTestId('layout')).toBeNull();
  });

  it('treats a plain 401 (no authRedirect flag) as a redirecting state too', async () => {
    getUserMock.mockRejectedValue(new ApiError('unauthorized', 401, 'Unauthorized'));
    render(() => <App />);
    await waitFor(() => expect(screen.getByTestId('auth-redirecting')).toBeInTheDocument());
  });
});

describe('REQ-AUTH-022 AC6: restored app pages revalidate authentication', () => {
  it.each(['visibility', 'bfcache'] as const)(
    'moves a loaded app to the redirecting state after an expired %s resume',
    async (resumeKind) => {
      const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      let visibilityState: DocumentVisibilityState = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibilityState,
      });

      try {
        getUserMock.mockResolvedValueOnce(authenticatedUser);
        render(() => <App />);
        await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());

        const expired = new ApiError('expired', 401, 'Unauthorized');
        expired.authRedirect = true;
        getUserMock.mockRejectedValueOnce(expired);

        if (resumeKind === 'visibility') {
          visibilityState = 'hidden';
          document.dispatchEvent(new Event('visibilitychange'));
          visibilityState = 'visible';
          document.dispatchEvent(new Event('visibilitychange'));
        } else {
          const pageShow = new Event('pageshow');
          Object.defineProperty(pageShow, 'persisted', { value: true });
          window.dispatchEvent(pageShow);
        }

        await waitFor(() => expect(screen.getByTestId('auth-redirecting')).toBeInTheDocument());
        expect(screen.queryByTestId('layout')).toBeNull();
      } finally {
        if (originalVisibility) {
          Object.defineProperty(document, 'visibilityState', originalVisibility);
        } else {
          Reflect.deleteProperty(document, 'visibilityState');
        }
      }
    },
  );

  it('deduplicates overlapping resume events and keeps a valid app mounted', async () => {
    let resolveResume!: (user: typeof authenticatedUser) => void;
    getUserMock
      .mockResolvedValueOnce(authenticatedUser)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveResume = resolve; }));

    render(() => <App />);
    await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());

    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibilityState: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      document.dispatchEvent(new Event('visibilitychange'));
      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      const pageShow = new Event('pageshow');
      Object.defineProperty(pageShow, 'persisted', { value: true });
      window.dispatchEvent(pageShow);

      // Exactly one resumed request is a contract: both browser events commonly
      // describe the same restoration and must not duplicate auth traffic.
      await waitFor(() => expect(getUserMock).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('layout')).toBeInTheDocument();
      expect(screen.queryByTestId('auth-redirecting')).toBeNull();

      resolveResume(authenticatedUser);
      await waitFor(() => expect(screen.getByTestId('layout')).toBeInTheDocument());
    } finally {
      if (originalVisibility) {
        Object.defineProperty(document, 'visibilityState', originalVisibility);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });
});

describe('REQ-AUTH-022 AC3: RootPage renders a non-empty redirect state (no blank document)', () => {
  it('shows the root-redirecting state when no provider/onboarding mode applies', async () => {
    stubLocation('/');
    render(() => <App />);
    await waitFor(() => expect(screen.getByTestId('root-redirecting')).toBeInTheDocument());
  });
});

describe('REQ-AUTH-022 AC4: top-level ErrorBoundary catches a render throw', () => {
  it('renders the error-boundary fallback instead of a blank document', async () => {
    layoutShouldThrow = true;
    getUserMock.mockResolvedValue(authenticatedUser);

    render(() => <App />);

    await waitFor(() => expect(screen.getByTestId('app-error-boundary')).toBeInTheDocument());
  });
});
