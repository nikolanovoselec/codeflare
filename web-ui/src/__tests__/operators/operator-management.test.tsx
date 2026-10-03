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
    // Navigation does not await the real management component's lazy import.
    await vi.dynamicImportSettled();
    expect(await screen.findByText(longName)).toBeInTheDocument();
    expect(screen.queryByText('Endpoint URL')).not.toBeInTheDocument();
  });

  it('renders the separate management area for an authorized manager rather than Administration navigation', async () => {
    render(() => <App />);

    expect(await screen.findByRole('heading', { name: 'Operators', level: 1 })).toBeInTheDocument();
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

  it('makes the installed version primary and updates the existing installation without creating another', async () => {
    const mutations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url, 'https://operators.example.test').pathname;
      if (path === '/api/operator-management/options') return response({ users: ['manager@example.test'], groups: [],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: [],
        ceiling: { capabilities: [], resourceProfileIds: [] } });
      if (path === '/api/operator-management/operators') return response({ items: [
        { id: 'operator-1', name: 'Review operator', profile: 'conductor', realm: 'internal', enabled: true },
      ], cursor: null });
      if (request.method === 'POST') {
        mutations.push(path);
        if (path === '/api/operator-management/installations/installation-1/promote') return response({ id: 'installation-1',
          operatorId: 'operator-1', name: 'Integration', releaseId: 'release-0', revision: 3, enabled: false,
          policy: { capabilities: [], resourceProfileId: null }, configuration: {} });
      }
      if (path === '/api/operator-management/operators/operator-1') return response({
        operator: { id: 'operator-1', name: 'Review operator', profile: 'conductor', realm: 'internal',
          enabled: true, revision: 3, repositoryId: 42, repositoryUrl: 'https://github.com/acme/review',
          managers: { users: [], groups: [] }, invokers: { users: [], groups: [] },
          policy: { capabilities: [], resourceProfileId: null },
          source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/review',
            repositoryId: 42, credentialConfigured: true, approvedWorkflow: { id: 7, ref: 'refs/heads/develop' } } },
        releases: [{ id: 'release-1', operatorId: 'operator-1', githubReleaseId: 17,
          name: 'Review operator', description: 'Checks repository changes under an approved Review policy.',
          sourceCommit: 'a'.repeat(40), manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64),
          interfaceVersion: 1, approved: true },
          { id: 'release-0', operatorId: 'operator-1', githubReleaseId: 15,
            name: 'Review operator', description: 'Checks repository changes under an approved Review policy.',
            sourceCommit: 'd'.repeat(40), manifestDigest: 'e'.repeat(64), bundleDigest: 'f'.repeat(64),
            interfaceVersion: 1, approved: true }],
        installations: [{ id: 'installation-2', operatorId: 'operator-1', name: 'Secondary', releaseId: 'release-0',
          revision: 2, enabled: false, policy: { capabilities: [], resourceProfileId: null } },
          { id: 'installation-1', operatorId: 'operator-1', name: 'Integration', releaseId: 'release-1',
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
    expect(within(sections).getByRole('button', { name: 'Installed version' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sections).getByRole('button', { name: 'Versions & updates' })).toBeInTheDocument();
    expect(screen.getByText('GitHub release #17', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable for new runs' })).toBeInTheDocument();
    const configurationChoice = screen.getByRole('combobox', { name: 'Installed configuration' });
    fireEvent.change(configurationChoice, { target: { value: 'installation-2' } });
    expect(screen.getByText('GitHub release #15', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable for new runs' })).toBeInTheDocument();
    fireEvent.change(configurationChoice, { target: { value: 'installation-1' } });
    expect(screen.queryByRole('button', { name: 'Create disabled installation' })).not.toBeInTheDocument();
    expect(within(overview).getByText('Checks repository changes under an approved Review policy.')).toBeInTheDocument();
    expect(screen.getAllByText('GitHub release #15', { selector: 'strong' })[0]).not.toBeVisible();
    fireEvent.click(within(sections).getByRole('button', { name: 'Versions & updates' }));
    expect(screen.getAllByText('GitHub release #15', { selector: 'strong' })[0]).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Other available versions' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /GitHub release #15/ }));
    expect(screen.getByText(/new runs will remain disabled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    await waitFor(() => expect(mutations).toContain('/api/operator-management/installations/installation-1/promote'));
    expect(mutations).not.toContain('/api/operator-management/operators/operator-1/installations');
  });

  it('offers guided first installation, pins the exact release, and never enables it automatically', async () => {
    const mutations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/api/operator-management/options') return response({ users: ['manager@example.test'], groups: [],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: [],
        ceiling: { capabilities: ['inference'], resourceProfileIds: [] } });
      if (path === '/api/operator-management/operators' && request.method === 'GET') return response({ items: [
        { id: 'operator-1', name: 'Dispatcher', profile: 'dispatcher', realm: 'internal', enabled: false }], cursor: null });
      if (path === '/api/operator-management/operators/operator-1') return response({ operator: {
        id: 'operator-1', name: 'Dispatcher', profile: 'dispatcher', realm: 'internal', enabled: false,
        revision: 1, repositoryId: 1, repositoryUrl: 'https://github.com/acme/dispatcher',
        managers: { users: ['manager@example.test'], groups: [] }, invokers: { users: [], groups: [] },
        policy: { capabilities: ['inference'], resourceProfileId: null }, source: { kind: 'github-release',
          repositoryUrl: 'https://github.com/acme/dispatcher', repositoryId: 1, credentialConfigured: true, approvedWorkflow: null },
      }, releases: [{ id: 'release-1', operatorId: 'operator-1', githubReleaseId: 17,
        description: 'Read-only pull-request assessment.', sourceCommit: 'a'.repeat(40),
        manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64), interfaceVersion: 1, approved: true }],
      installations: [], grants: { managers: { users: ['manager@example.test'], groups: [] }, invokers: { users: [], groups: [] } } });
      if (request.method === 'POST') {
        mutations.push(path);
        if (path.endsWith('/installations')) return response({ id: 'install-1', name: 'default', operatorId: 'operator-1',
          releaseId: null, revision: 1, enabled: false, policy: { capabilities: ['inference'], resourceProfileId: null }, configuration: {} }, 201);
        if (path.endsWith('/promote')) return response({ id: 'install-1', name: 'default', operatorId: 'operator-1',
          releaseId: 'release-1', revision: 2, enabled: false, policy: { capabilities: ['inference'], resourceProfileId: null }, configuration: {} });
      }
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Dispatcher' }));
    const installed = await screen.findByRole('region', { name: 'Installed version' });
    expect(within(installed).getByText('No version installed')).toBeInTheDocument();
    fireEvent.click(within(installed).getByRole('button', { name: 'Install operator' }));
    fireEvent.click(screen.getByRole('radio', { name: /GitHub release #17/ }));
    fireEvent.click(screen.getByRole('button', { name: /install selected version/i }));
    await waitFor(() => expect(mutations).toEqual([
      '/api/operator-management/operators/operator-1/installations', '/api/operator-management/installations/install-1/promote']));
    expect(mutations).not.toContain('/api/operator-management/installations/install-1/enable');
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

  it.each([403, 404])('REQ-AUTH-009/REQ-OPERATOR-049: denied catalog %i offers native session renewal without operator details', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Access denied' }, status)));
    render(() => <App />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not authorized|access denied/i);
    const signIn = within(alert).getByRole('link', { name: 'Sign in again' });
    // Intentional navigation contract: the backend, not SPA routing, renews the session.
    expect(signIn).toHaveAttribute('href', '/auth/logout');
    const navigation = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    fireEvent(signIn, navigation);
    expect(navigation.defaultPrevented).toBe(false);
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

  it('does not present realm as a registration choice, catalog filter, or permission boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/api/operator-management/options') return response({ users: ['manager@example.test'], groups: [],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: [],
        ceiling: { capabilities: [], resourceProfileIds: [] } });
      if (path === '/api/operator-management/operators') return response({ items: [
        { id: 'operator-1', name: 'Review operator', profile: 'conductor', realm: 'external', enabled: false }], cursor: null });
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    expect(await screen.findByText('Review operator')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Realm' })).not.toBeInTheDocument();
    expect(screen.queryByText(/external/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Register operator' }));
    expect(screen.getByRole('region', { name: 'Register operator' })).not.toHaveTextContent('Operator realm');
  });

  it('assigns only configured users, stable groups and supported limits without free-text identities', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/api/operator-management/options') return response({ users: ['manager@example.test', 'invoker@example.test'],
        groups: [{ issuer: 'https://team.cloudflareaccess.com', id: 'review-team' }], unresolvedGroups: ['Display Team'],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: ['review-profile'],
        ceiling: { capabilities: ['inference', 'fetch'], resourceProfileIds: ['review-profile'] } });
      if (path === '/api/operator-management/operators' && request.method === 'POST') {
        calls.push(await request.json());
        return response({ id: 'new-operator', revision: 1, profile: 'dispatcher', realm: 'internal',
          enabled: false, repositoryId: 1, repositoryUrl: 'https://github.com/acme/review',
          managers: { users: [], groups: [] }, invokers: { users: [], groups: [] },
          policy: { capabilities: [], resourceProfileId: null }, source: { kind: 'github-release',
            repositoryUrl: 'https://github.com/acme/review', repositoryId: 1, credentialConfigured: true, approvedWorkflow: null } }, 201);
      }
      if (path === '/api/operator-management/operators') return response({ items: [], cursor: null });
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Register operator' }));
    const form = screen.getByRole('region', { name: 'Register operator' });
    const invoker = within(form).getByRole('group', { name: /initial invoker/i });
    expect(await within(invoker).findByRole('checkbox', { name: /invoker@example.test/i })).toBeInTheDocument();
    expect(within(form).getAllByRole('checkbox', { name: /review-team/i })).toHaveLength(2);
    expect(within(form).getByText(/unverified configured groups cannot be assigned: Display Team/i)).toBeInTheDocument();
    expect(within(form).queryByRole('checkbox', { name: /Display Team/i })).not.toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: /inference/i })).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: /operator resource profile/i })).toBeInTheDocument();
    expect(within(form).queryByRole('textbox', { name: /manager users|manager groups|operator capabilities/i })).not.toBeInTheDocument();
    fireEvent.click(within(invoker).getByRole('checkbox', { name: /invoker@example.test/i }));
    fireEvent.click(within(invoker).getByRole('checkbox', { name: /review-team/i }));
    fireEvent.click(within(form).getByRole('checkbox', { name: /inference/i }));
    fireEvent.change(within(form).getByRole('combobox', { name: /operator resource profile/i }), { target: { value: 'review-profile' } });
    fireEvent.input(within(form).getByRole('textbox', { name: 'GitHub repository URL' }), { target: { value: 'https://github.com/acme/review' } });
    fireEvent.input(within(form).getByLabelText('Repository-read PAT'), { target: { value: 'opaque-token' } });
    fireEvent.submit(within(form).getByRole('button', { name: 'Register source' }).closest('form')!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ invokers: { users: ['invoker@example.test'],
      groups: [{ issuer: 'https://team.cloudflareaccess.com', id: 'review-team' }] },
      policy: { capabilities: ['inference'], resourceProfileId: 'review-profile' } });
  });

  it('requires explicit usable registration limits before accepting a source', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/api/operator-management/options') return response({ users: ['manager@example.test'], groups: [],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: ['review-profile'],
        ceiling: { capabilities: ['session'], resourceProfileIds: ['review-profile'] } });
      if (path === '/api/operator-management/operators') return response({ items: [], cursor: null });
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Register operator' }));
    const form = screen.getByRole('region', { name: 'Register operator' });
    const restrictions = await within(form).findByRole('group', { name: 'Operator actions and scope' });
    const session = await within(restrictions).findByRole('checkbox', { name: /session access/i });
    expect(within(form).getByRole('button', { name: 'Register source' })).toBeDisabled();
    expect(within(form).getByText(/initial capabilities and scope within environment limits/i)).toBeInTheDocument();
    fireEvent.click(session);
    expect(within(form).getByRole('button', { name: 'Register source' })).toBeDisabled();
    const resource = within(restrictions).getByRole('combobox', { name: 'Operator resource profile' });
    await within(resource).findByRole('option', { name: 'review-profile' });
    fireEvent.change(resource, { target: { value: 'review-profile' } });
    expect(resource).toHaveValue('review-profile');
    expect(session).toBeChecked();
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Register source' })).toBeEnabled());
  });

  it('keeps persisted configuration when saving restrictions, without an unused JSON editor', async () => {
    const saves: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/api/operator-management/options') return response({ users: [], groups: [],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: [],
        ceiling: { capabilities: ['inference'], resourceProfileIds: [] } });
      if (path === '/api/operator-management/operators') return response({ items: [
        { id: 'operator-1', name: 'Test operator', profile: 'dispatcher', realm: 'internal', enabled: false }], cursor: null });
      if (path === '/api/operator-management/operators/operator-1') return response({
        operator: { id: 'operator-1', name: 'Test operator', profile: 'dispatcher', realm: 'internal', enabled: false,
          revision: 1, repositoryId: 1, repositoryUrl: 'https://github.com/acme/review',
          managers: { users: [], groups: [] }, invokers: { users: [], groups: [] }, policy: { capabilities: ['inference'], resourceProfileId: null },
          source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/review', repositoryId: 1,
            credentialConfigured: true, approvedWorkflow: null } }, releases: [],
        installations: [{ id: 'install-1', operatorId: 'operator-1', name: 'Runner', releaseId: null, revision: 1,
          enabled: false, policy: { capabilities: [], resourceProfileId: null }, configuration: { existing: 'keep' } }],
        grants: { managers: { users: [], groups: [] }, invokers: { users: [], groups: [] } },
      });
      if (path === '/api/operator-management/installations/install-1/configure') {
        saves.push(await request.json());
        return response({ id: 'install-1', operatorId: 'operator-1', name: 'Runner', releaseId: null, revision: 2,
          enabled: false, policy: { capabilities: ['inference'], resourceProfileId: null }, configuration: { existing: 'keep' } });
      }
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Test operator' }));
    const installed = await screen.findByRole('region', { name: 'Installed version' });
    fireEvent.click(within(installed).getByText('Technical details', { selector: 'summary' }));
    expect(within(installed).queryByRole('textbox', { name: /configuration json/i })).not.toBeInTheDocument();
    const restrictions = await within(installed).findByRole('group', { name: 'Installation restrictions' });
    fireEvent.click(within(restrictions).getByRole('checkbox', { name: /inference/i }));
    fireEvent.click(within(installed).getByRole('button', { name: /save restrictions for runner/i }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ policy: { capabilities: ['inference'], resourceProfileId: null },
      configuration: { existing: 'keep' } });
  });

  it('keeps saved identities absent from this session’s choices through unrelated grant edits and allows deliberate removal', async () => {
    const saves: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/api/operator-management/options') return response({ users: ['manager@example.test', 'invoker@example.test'], groups: [],
        capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: [],
        ceiling: { capabilities: [], resourceProfileIds: [] } });
      if (path === '/api/operator-management/operators') return response({ items: [
        { id: 'operator-1', name: 'Test operator', profile: 'dispatcher', realm: 'internal', enabled: false }], cursor: null });
      if (path === '/api/operator-management/operators/operator-1') return response({
        operator: { id: 'operator-1', name: 'Test operator', profile: 'dispatcher', realm: 'internal', enabled: false,
          revision: 1, repositoryId: 1, repositoryUrl: 'https://github.com/acme/review',
          managers: { users: ['manager@example.test', 'missing@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'former-team' }] }, invokers: { users: [], groups: [] },
          policy: { capabilities: [], resourceProfileId: null }, source: { kind: 'github-release',
            repositoryUrl: 'https://github.com/acme/review', repositoryId: 1, credentialConfigured: true, approvedWorkflow: null } },
        releases: [], installations: [], grants: { managers: { users: ['manager@example.test', 'missing@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'former-team' }] },
          invokers: { users: [], groups: [] } },
      });
      if (path === '/api/operator-management/operators/operator-1/grants') {
        saves.push(await request.json());
        return response({ id: 'operator-1', profile: 'dispatcher', realm: 'internal', enabled: false, revision: 2,
          repositoryId: 1, repositoryUrl: 'https://github.com/acme/review',
          managers: { users: ['manager@example.test', 'missing@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'former-team' }] },
          invokers: { users: [], groups: [] }, policy: { capabilities: [], resourceProfileId: null },
          source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/review', repositoryId: 1,
            credentialConfigured: true, approvedWorkflow: null } });
      }
      return response({ error: 'Not found' }, 404);
    }));
    render(() => <App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Test operator' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }));
    const grants = await screen.findByRole('region', { name: /access grants/i });
    expect(within(grants).getByText(/missing@example.test.*not listed.*retained/i)).toBeInTheDocument();
    expect(within(grants).getByText(/former-team.*not listed.*retained/i)).toBeInTheDocument();
    const invokers = within(grants).getByRole('group', { name: 'Runners' });
    fireEvent.click(within(invokers).getByRole('checkbox', { name: 'invoker@example.test' }));
    fireEvent.click(within(grants).getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ managers: { users: ['manager@example.test', 'missing@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'former-team' }] },
      invokers: { users: ['invoker@example.test'], groups: [] } });
    await waitFor(() => expect(within(grants).getByRole('button', { name: 'Save permissions' })).toBeEnabled());
    fireEvent.click(within(grants).getByRole('checkbox', { name: /missing@example.test/i }));
    fireEvent.click(within(grants).getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toMatchObject({ managers: { users: ['manager@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'former-team' }] } });
  });

  it('disables permission saves when identity choices are unavailable', async () => {
    const grants = { users: [], groups: [] };
    const operator = { id: 'operator-1', name: 'Test operator', profile: 'dispatcher', realm: 'internal', enabled: false,
      revision: 1, repositoryId: 1, repositoryUrl: 'https://github.com/acme/review',
      managers: grants, invokers: grants, policy: { capabilities: [], resourceProfileId: null },
      source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/review', repositoryId: 1,
        credentialConfigured: true, approvedWorkflow: null } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/api/operator-management/operators') return response({ items: [operator], cursor: null });
      if (path === '/api/operator-management/operators/operator-1') return response({ operator,
        releases: [], installations: [], grants: { managers: grants, invokers: grants } });
      return response({ error: 'Unavailable' }, 503);
    }));
    render(() => <App />);
    expect(await screen.findByText(/identity choices.*unavailable/i)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Test operator' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }));
    const permissions = await screen.findByRole('region', { name: 'Access grants' });
    expect(within(permissions).getByRole('button', { name: 'Save permissions' })).toBeDisabled();
  });
});
