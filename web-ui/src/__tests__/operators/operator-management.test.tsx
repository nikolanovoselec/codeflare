import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';

const getSetupStatus = vi.fn();
const getUser = vi.fn();
const getAdminConfiguration = vi.fn();

vi.mock('../../api/client', () => ({
  getSetupStatus: (...args: unknown[]) => getSetupStatus(...args),
  getUser: (...args: unknown[]) => getUser(...args),
  getAdminConfiguration: (...args: unknown[]) => getAdminConfiguration(...args),
  getAuthProviders: vi.fn(),
  getOnboardingConfig: vi.fn(),
  getAuthStatus: vi.fn(),
}));
vi.mock('../../components/Layout', () => ({ default: () => <div data-testid="workspace" /> }));
vi.mock('../../components/setup/SetupWizard', () => ({ default: () => <div /> }));
vi.mock('../../stores/session', () => ({ sessionStore: { stopAllPolling: vi.fn(), setEnterpriseMode: vi.fn(), setSaasMode: vi.fn(), setAllowedAgents: vi.fn() } }));
vi.mock('../../stores/storage', () => ({ storageStore: { setWorkerName: vi.fn(), setDownloadsDisabled: vi.fn() } }));
vi.mock('../../stores/terminal', () => ({ terminalStore: { disposeAll: vi.fn() } }));

import App from '../../App';

const longName = 'release-operator-with-an-intentionally-long-name-that-must-remain-actionable-on-every-supported-viewport';
let width: number;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  width = window.innerWidth;
  window.history.replaceState({}, '', '/operators');
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  getSetupStatus.mockResolvedValue({ configured: true });
  getAdminConfiguration.mockResolvedValue({ mode: 'enterprise', revision: 1, applicableSections: [], sections: { domain: {} } });
  getUser.mockResolvedValue({
    email: 'manager@example.test', authenticated: true, bucketName: 'operators', role: 'user',
    enterpriseMode: true, operatorManagementEligible: true, saasMode: false, onboardingComplete: true, accessTier: 'advanced',
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url, 'https://operators.example.test').pathname === '/api/operator-management/operators') {
      return response({ items: [{ id: 'operator-1', name: longName, profile: 'conductor', realm: 'internal', enabled: false }], cursor: null });
    }
    return response({ error: 'Not found' }, 404);
  }));
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  vi.unstubAllGlobals();
  cleanup();
});

describe('REQ-OPERATOR-049: /operators management interface', () => {
  it('opens the installed release catalog from the Enterprise Administration Operators URL', async () => {
    window.history.replaceState({}, '', '/admin/operators');
    render(() => <App />);

    await waitFor(() => expect(window.location.pathname).toBe('/operators'));
    expect(await screen.findByText(longName)).toBeInTheDocument();
    expect(screen.queryByText('Endpoint URL')).not.toBeInTheDocument();
  });

  it('renders the separate management area for an authorized manager rather than Administration navigation', async () => {
    render(() => <App />);

    expect(await screen.findByRole('heading', { name: /operators/i })).toBeInTheDocument();
    expect(await screen.findByText(longName)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register operator/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`manage ${longName}`, 'i') })).toBeInTheDocument();
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
  });

  it('uses Enterprise Administration navigation for admins while preserving manager access', async () => {
    getUser.mockResolvedValue({ email: 'admin@example.test', authenticated: true, bucketName: 'operators', role: 'admin',
      enterpriseMode: true, operatorManagementEligible: true, saasMode: false, onboardingComplete: true });
    render(() => <App />);

    const navigation = await screen.findByRole('navigation', { name: 'Administration' });
    expect(within(navigation).getByRole('link', { name: 'Operators' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('link', { name: 'Environment' })).toHaveAttribute('href', '/admin/environment');
    expect(screen.getByRole('button', { name: 'Open administration navigation' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Operator catalog' })).toBeInTheDocument();
  });

  it('makes the selected operator, pinned release and installation decision path navigable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url, 'https://operators.example.test').pathname;
      if (path === '/api/operator-management/operators') return response({ items: [
        { id: 'operator-1', name: 'Review operator', profile: 'conductor', realm: 'internal', enabled: true },
      ], cursor: null });
      if (path === '/api/operator-management/operators/operator-1') return response({
        operator: { id: 'operator-1', name: 'Review operator', profile: 'conductor', realm: 'internal',
          enabled: true, revision: 3, repositoryId: 42, repositoryUrl: 'https://github.com/acme/review',
          managers: { users: [], groups: [] }, invokers: { users: [], groups: [] },
          policy: { capabilities: [], resourceProfileId: null },
          source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/review',
            repositoryId: 42, credentialConfigured: true, approvedWorkflow: { id: 7, ref: 'refs/heads/develop' } } },
        releases: [{ id: 'release-1', operatorId: 'operator-1', githubReleaseId: 17,
          sourceCommit: 'a'.repeat(40), manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64),
          interfaceVersion: 1, approved: true, version: 'v0.1.2' }],
        installations: [{ id: 'installation-1', operatorId: 'operator-1', name: 'Integration', releaseId: 'release-1',
          revision: 2, enabled: true, policy: { capabilities: [], resourceProfileId: null } }],
        grants: { managers: { users: [], groups: [] }, invokers: { users: [], groups: [] } },
      });
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Review operator' }));

    const overview = await screen.findByRole('region', { name: 'Operator overview' });
    expect(within(overview).getByText('Review operator')).toBeInTheDocument();
    const sections = screen.getByRole('navigation', { name: 'Operator sections' });
    expect(within(sections).getByRole('link', { name: 'Installations' })).toHaveAttribute('href', '#operator-installations');
    expect(screen.getByRole('heading', { name: 'Installations' })).toBeInTheDocument();
    const installation = screen.getByRole('article', { name: 'Integration installation' });
    expect(within(installation).getByText('Enabled for new activities')).toBeInTheDocument();
    expect(within(installation).getByText('Pinned release: v0.1.2')).toBeInTheDocument();
    expect(within(installation).getByRole('button', { name: 'Disable Integration' })).toBeInTheDocument();
  });

  it('switches views on ordinary navigation without changing the current tab on modified clicks', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url, 'https://operators.example.test').pathname;
      if (path === '/api/operator-management/operators') return response({ items: [], cursor: null });
      if (path === '/api/operator-activities') return response({ items: [] });
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    expect(await screen.findByRole('region', { name: 'Operator catalog' })).toBeInTheDocument();
    const activity = screen.getByRole('link', { name: 'My activity' });
    expect(activity).toHaveAttribute('href', '/operators?view=activity');
    fireEvent.click(activity, { metaKey: true });
    expect(screen.getByRole('region', { name: 'Operator catalog' })).toBeInTheDocument();
    fireEvent.click(activity);
    await waitFor(() => expect(window.location.search).toBe('?view=activity'));
    expect(await screen.findByRole('heading', { name: 'My activity', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Operator catalog' })).not.toBeInTheDocument();
    const catalog = screen.getByRole('link', { name: 'Catalog' });
    expect(catalog).toHaveAttribute('href', '/operators');
    fireEvent.click(catalog, { ctrlKey: true });
    expect(screen.getByRole('heading', { name: 'My activity', level: 2 })).toBeInTheDocument();
    fireEvent.click(catalog);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(await screen.findByRole('region', { name: 'Operator catalog' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My activity', level: 2 })).not.toBeInTheDocument();
  });

  it('keeps a denied catalog non-enumerating and presents a recoverable access state without operator details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Not found' }, 404)));
    render(() => <App />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not authorized|access denied/i);
    expect(screen.queryByText(longName)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register operator/i })).not.toBeInTheDocument();
  });

  it.each([1280, 820, 390])('keeps long-name management controls visible and focusable at %ipx', async viewport => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: viewport });
    render(() => <App />);

    const manage = await screen.findByRole('button', { name: new RegExp(`manage ${longName}`, 'i') });
    manage.focus();
    expect(manage).toHaveFocus();
    expect(screen.getByRole('button', { name: /register operator/i })).toBeVisible();
  });

  it('retains the registration control and visible long error on a narrow viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    vi.stubGlobal('fetch', vi.fn(async () => response({
      error: 'Upstream registry verification failed for a deliberately long operator registration error.',
    }, 503)));
    render(() => <App />);

    const register = await screen.findByRole('button', { name: /register operator/i });
    register.focus();
    expect(register).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/verification failed/i));
    expect(screen.getByRole('button', { name: /register operator/i })).toBeVisible();
  });
});
