import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement, { ManagementAccessPanel } from '../../components/OperatorManagement';
import { getManagedOperator, getManagementChoices, type ManagementPolicy, type ManagementChoices } from '../../api/operator-management';

const grant = { users: ['manager@example.test'], groups: [] };
const policy = { capabilities: [], resourceProfileId: null };
const operator = { id: 'operator-1', revision: 3, repositoryUrl: 'https://github.com/acme/operator', repositoryId: 123,
  profile: 'conductor', realm: 'internal', enabled: false, managers: grant, invokers: { users: [], groups: [] }, policy,
  source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/operator', repositoryId: 123, credentialConfigured: true, approvedWorkflow: null } };
const release = { id: 'release-1', operatorId: 'operator-1', githubReleaseId: 456, sourceCommit: 'abc',
  manifestDigest: 'a'.repeat(64), bundleDigest: 'b'.repeat(64), interfaceVersion: 1, approved: false };
const installation = { id: 'installation-1', operatorId: 'operator-1', name: 'test', releaseId: null, revision: 2, enabled: false, policy };
const detail = () => ({ operator, releases: [release], installations: [installation], grants: { managers: grant, invokers: { users: [], groups: [] } } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const choices = { users: ['manager@example.test', 'invoker@example.test', 'delegate@example.test'], groups: [], unresolvedGroups: [],
  capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: [],
  ceiling: { capabilities: [], resourceProfileIds: [] } };
async function openSource() {
  await screen.findByRole('region', { name: 'Installed version' });
  fireEvent.click(screen.getByText('Change source', { selector: 'summary' }));
}
let serve: (url: URL, init?: RequestInit) => Response | Promise<Response>;
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  serve = url => url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    return Promise.resolve(url.pathname.endsWith('/options') ? json(choices) : serve(url, init));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('REQ-OPERATOR-049: management decisions and recovery', () => {
  it.each([undefined, false, true])('loads logging=%s through the public client and saves the single execution-diagnostics checkbox', async initial => {
    let loggingEnabled = initial;
    let revision = operator.revision;
    let saved: unknown;
    serve = (url, init) => {
      const current = () => ({ ...operator, revision, policy: { ...policy, ...(loggingEnabled === undefined ? {} : { loggingEnabled }) } });
      if (url.pathname.endsWith('/capabilities') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        saved = body; loggingEnabled = body.loggingEnabled; revision++;
        return json(current());
      }
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), operator: current() }) : json({ items: [current()], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const checkbox = await screen.findByRole('checkbox', { name: /Enable logging/ });
    expect(screen.getAllByRole('checkbox', { name: /Enable logging/ })).toHaveLength(1);
    expect((checkbox as HTMLInputElement).checked).toBe(initial ?? true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved).toEqual({ revision: operator.revision, capabilities: [], loggingEnabled: !(initial ?? true) }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save operator capabilities' })).toBeEnabled());
    expect((screen.getByRole('checkbox', { name: /Enable logging/ }) as HTMLInputElement).checked).toBe(!(initial ?? true));
    expect(screen.getByText(/Privacy and security audits remain unchanged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved).toEqual({ revision: operator.revision + 1, capabilities: [], loggingEnabled: !(initial ?? true) }));
  });

  it('distinguishes loading, empty and catalog failure with explicit retry', async () => {
    let resolve!: (value: Response) => void;
    serve = () => new Promise<Response>(done => { resolve = done; });
    render(() => <OperatorManagement userEmail="manager@example.test" />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading operators/i);
    resolve(json({ items: [], cursor: null }));
    expect(await screen.findByText(/no operators match/i)).toBeInTheDocument();
  });
  it('sends bounded cursor pagination and replaces the page instead of accumulating hidden records', async () => {
    serve = url => {
      expect(url.searchParams.get('limit')).toBe('50');
      return url.searchParams.get('cursor') === 'next'
        ? json({ items: [{ ...operator, id: 'operator-2', repositoryUrl: 'https://github.com/acme/second' }], cursor: null })
        : json({ items: [operator], cursor: 'next' });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('https://github.com/acme/second')).toBeInTheDocument();
    expect(screen.queryByText(operator.repositoryUrl)).not.toBeInTheDocument();
  });
  it('keeps a rejected source-edit secret out of the accessible error and clears the password', async () => {
    serve = (url, init) => url.pathname.endsWith('/source') && init?.method === 'POST'
      ? json({ error: 'fixture-private-pat rejected' }, 400)
      : url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement userEmail="manager@example.test" />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    await openSource();
    const secret = await screen.findByLabelText('Replacement repository-read PAT');
    fireEvent.input(secret, { target: { value: 'fixture-private-pat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace source' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid/i);
    expect(alert).not.toHaveTextContent('fixture-private-pat');
    await waitFor(() => expect(secret).toHaveValue(''));
  });
  it('shows distinct discovery, approval and enablement and requires reconciliation after a stale promotion', async () => {
    serve = (url, init) => init?.method === 'POST' ? json({ error: 'Conflict' }, 409)
      : url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    expect(await within(await screen.findByRole('region', { name: 'Installed version' })).findByText('No version installed', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install operator' }));
    fireEvent.click(screen.getByRole('radio', { name: /GitHub release #456/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/stale/i);
    expect(screen.getByRole('button', { name: 'Install selected version' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current state' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install selected version' })).not.toBeDisabled());
  });
  it('promotes an exact release without enabling, then explicitly enables and disables the named installation', async () => {
    let state: { releaseId: string | null; enabled: boolean; revision: number } = { releaseId: null, enabled: false, revision: 2 };
    serve = (url, init) => {
      if (url.pathname.endsWith('/promote')) {
        expect(JSON.parse(String(init?.body))).toEqual({ releaseId: release.id, revision: 2 });
        state = { releaseId: release.id, enabled: false, revision: 3 };
        return json({ ...installation, ...state });
      }
      if (url.pathname.endsWith('/enable')) {
        const body = JSON.parse(String(init?.body));
        expect(body.revision).toBe(state.revision);
        state = { ...state, enabled: body.enabled, revision: state.revision + 1 };
        return json({ ...installation, ...state });
      }
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), operator: { ...operator, name: 'Conductor Review' },
        installations: [{ ...installation, ...state }] }) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install operator' }));
    fireEvent.click(screen.getByRole('radio', { name: /GitHub release #456/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable' })).not.toBeDisabled());
    expect(screen.queryByRole('link', { name: 'Run as yourself' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable' })).not.toBeDisabled());
    expect(screen.queryByRole('link', { name: /run as yourself/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Review preparation.*protected.*pull request/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run as yourself' })).not.toBeInTheDocument());
  });
  it.each([true, false])('REQ-OPERATOR-058: AC1/2 management opens a Dispatcher with native approval=%s and an empty session catalog without starting until explicit submission', async nativeApproved => {
    const dispatcherPolicy = { capabilities: ['inference'], resourceProfileId: null,
      inference: { allowedSources: nativeApproved ? ['managed', 'pi-native'] : ['managed'], routeIds: ['account-default'],
        defaultRouteId: 'account-default', reasoningLevels: ['low'], defaultReasoningLevel: 'low', inheritUserDefaults: false } };
    const dispatcher = { ...operator, profile: 'dispatcher', repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher',
      policy: dispatcherPolicy };
    const writes: Array<{ path: string; body: unknown }> = [];
    serve = (url, init) => {
      if (init?.method === 'POST') {
        writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        if (url.pathname === '/api/operator-activities') return json({ activityId: 'management-assessment', startCapability: 'm'.repeat(43), startExpiresAt: Date.now() + 30000 });
        if (url.pathname === '/api/operator-activities/management-assessment/start') return json({ ok: true });
        return json({ error: 'No session or configuration mutation authorized' }, 403);
      }
      if (url.pathname === '/api/sessions') return json({ sessions: [] });
      if (url.pathname.endsWith('/operator-1')) return json({ ...detail(), operator: dispatcher,
        releases: [{ ...release, name: 'Renovate Dispatcher' }],
        installations: [{ ...installation, enabled: true, releaseId: release.id, policy: dispatcherPolicy }] });
      if (url.pathname.endsWith('/preview')) return json({ name: 'Renovate Dispatcher', version: 'v0.1.2', guidedAssessment: true, guidedMode: 'legacy-pull-request', requiresSourceHost: false });
      return url.pathname === '/api/operator-activities' ? json({ items: [] }) : json({ items: [dispatcher], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${dispatcher.repositoryUrl}` }));
    expect(screen.queryByRole('combobox', { name: 'test resource profile' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Runtime permissions' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /assess a pull request/i }));
    expect(await screen.findByRole('heading', { name: 'Assess a Renovate pull request' })).toBeInTheDocument();
    expect(window.location.search).toContain('invoke=installation-1');
    expect(screen.queryByRole('region', { name: 'Installed version' })).not.toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start assessment' });
    expect(start).toBeEnabled();
    expect(screen.queryByRole('combobox', { name: /source.*host/i })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'selected/repository' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '17' } });
    expect(writes).toEqual([]);
    fireEvent.click(start);
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    // Exact public wire demonstrates no implicit session lifecycle/settings write,
    // no source identity in child input, and start bound to the returned Activity.
    expect(writes).toEqual([
      { path: '/api/operator-activities', body: { installationId: 'installation-1', invocation: { repository: 'selected/repository', pullRequest: 17 } } },
      { path: '/api/operator-activities/management-assessment/start', body: { capability: 'm'.repeat(43) } },
    ]);
  });

  it('shows save success and failure next to Permissions rather than only at the page header', async () => {
    let fails = false;
    serve = (url, init) => url.pathname.endsWith('/grants') && init?.method === 'POST'
      ? fails ? json({ error: 'Conflict' }, 409) : json(operator)
      : url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }));
    const pane = screen.getByRole('region', { name: 'Access grants' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(within(pane).getByRole('status')).toHaveTextContent(/permissions saved/i));
    await waitFor(() => expect(within(pane).getByRole('button', { name: 'Save permissions' })).toBeEnabled());
    fails = true;
    fireEvent.click(within(pane).getByRole('button', { name: 'Save permissions' }));
    expect(await within(pane).findByRole('alert')).toHaveTextContent(/stale.*refresh/i);
  });

  it('confirms a restriction save beside its action without silently enabling the installation', async () => {
    serve = (url, init) => url.pathname.endsWith('/configure') && init?.method === 'POST'
      ? json({ ...installation, revision: 3 })
      : url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save restrictions for test' }));
    const installed = screen.getByRole('region', { name: 'Installed version' });
    await waitFor(() => expect(within(installed).getByRole('status')).toHaveTextContent(/restrictions saved/i));
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('shows verified tag and publication time on installed and selectable versions while labelling legacy records honestly', async () => {
    const tagged = { ...release, approved: true, tagName: 'v0.1.2', publishedAt: '2026-09-25T12:00:00Z' };
    serve = url => url.pathname.endsWith('/operator-1') ? json({ ...detail(), releases: [tagged, { ...release, id: 'release-legacy', githubReleaseId: 455 }],
      installations: [{ ...installation, releaseId: tagged.id }] }) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const installed = await screen.findByRole('region', { name: 'Installed version' });
    expect(await within(installed).findByText(/v0\.1\.2.*25.*2026/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Versions & updates' }));
    expect(screen.getAllByText('GitHub release #455', { selector: 'strong' })[0]).toBeVisible();
    expect(screen.getByRole('radio', { name: /GitHub release #455/ })).toBeInTheDocument();
  });

  it('reconciles the operator revision after discovery before first installation', async () => {
    let revision = 3;
    let created: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/releases/refresh')) { revision = 4; return json({ items: [release] }); }
      if (url.pathname.endsWith('/installations')) { created = JSON.parse(String(init?.body)); return json({ ...installation, revision: 1 }, 201); }
      if (url.pathname.endsWith('/promote')) return json({ ...installation, releaseId: release.id, revision: 2 });
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), operator: { ...operator, revision }, installations: [] }) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Versions & updates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh releases' }));
    fireEvent.click(screen.getByRole('button', { name: 'Installed version' }));
    const install = await screen.findByRole('button', { name: 'Install operator' });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    fireEvent.click(screen.getByRole('radio', { name: /GitHub release #456/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    await waitFor(() => expect(created).toEqual({ name: 'default', policy, revision: 4 }));
  });
  it.each(['promotion failed', 'promotion response lost'])('reconciles a created but unpinned installation when %s without a duplicate or automatic enable', async outcome => {
    let installations: Array<Omit<typeof installation, 'releaseId'> & { releaseId: string | null }> = [];
    let creates = 0; let promotions = 0; let enables = 0;
    serve = (url, init) => {
      if (url.pathname.endsWith('/installations') && init?.method === 'POST') {
        creates++; installations = [{ ...installation, revision: 1 }]; return json(installations[0], 201);
      }
      if (url.pathname.endsWith('/promote')) {
        promotions++;
        if (promotions === 1) {
          if (outcome === 'promotion response lost') installations = [{ ...installations[0], releaseId: release.id, revision: 2 }];
          return json({ error: 'Uncertain promotion' }, 503);
        }
        installations = [{ ...installations[0], releaseId: release.id, revision: 2 }];
        return json(installations[0]);
      }
      if (url.pathname.endsWith('/enable')) enables++;
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), operator: { ...operator, revision: installations.length ? 4 : 3 }, installations }) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install operator' }));
    fireEvent.click(screen.getByRole('radio', { name: /GitHub release #456/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/operation was not confirmed.*refresh current state/i);
    expect(creates).toBe(1);
    const refresh = screen.getByRole('button', { name: 'Refresh current state' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    if (outcome === 'promotion failed') {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Install operator' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Install operator' }));
      fireEvent.click(screen.getByRole('radio', { name: /GitHub release #456/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
      await waitFor(() => expect(promotions).toBe(2));
    } else {
      expect(await screen.findByText(`GitHub release #${release.githubReleaseId}`, { selector: 'strong' })).toBeInTheDocument();
      expect(promotions).toBe(1);
    }
    expect(creates).toBe(1);
    expect(enables).toBe(0);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Installed version' }))
      .getByText('Installed — not enabled', { selector: '[role="status"]' })).toBeVisible());
  });

  it('requires an explicit configuration choice when more than one is enabled', async () => {
    serve = url => url.pathname.endsWith('/operator-1') ? json({ ...detail(), installations: [
      { ...installation, releaseId: release.id, enabled: true },
      { ...installation, id: 'installation-2', name: 'secondary', releaseId: release.id, enabled: true },
    ] }) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const installed = await screen.findByRole('region', { name: 'Installed version' });
    expect(within(installed).getByText(/Enabled configurations: test, secondary/)).toBeInTheDocument();
    expect(within(installed).queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    fireEvent.change(within(installed).getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(within(installed).getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('distinguishes an installed pin with unavailable release details from no installation', async () => {
    serve = url => url.pathname.endsWith('/operator-1') ? json({ ...detail(), installations: [{ ...installation, releaseId: 'missing-release' }] }) : json({ items: [operator], cursor: null });
    render(() => <OperatorManagement />);
    expect(await screen.findByText('Open this operator to review its verified versions and purpose.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const installed = await screen.findByRole('region', { name: 'Installed version' });
    expect(within(installed).getByText('Installed version details unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install operator' })).not.toBeInTheDocument();
    expect(screen.queryByText('No version installed', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('edits source with a blank write-only credential and clears it on submission', async () => {
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/source')) { saved = JSON.parse(String(init?.body)); return json({ ...operator, revision: 4 }); }
      return url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    await openSource();
    const secret = await screen.findByLabelText('Replacement repository-read PAT');
    expect(secret).toHaveValue('');
    fireEvent.input(secret, { target: { value: 'fixture-replacement-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace source' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, repositoryUrl: operator.repositoryUrl, githubPat: 'fixture-replacement-secret' }));
    expect(secret).toHaveValue('');
    expect(screen.queryByText('fixture-replacement-secret')).not.toBeInTheDocument();
  });
  it('saves installation restrictions at the observed revision without discarding stored configuration', async () => {
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/configure')) { saved = JSON.parse(String(init?.body)); return json(installation); }
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), installations: [{ ...installation, configuration: { repositoryId: 123 } }] }) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    expect(screen.queryByRole('textbox', { name: /configuration json/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Save restrictions for test' }));
    await waitFor(() => expect(saved).toEqual({ revision: 2, policy, configuration: { repositoryId: 123 } }));
  });
  it('explains global action limits and scope labels without raw capability keys or suggesting that an ID provisions resources', async () => {
    serve = url => url.pathname.endsWith('/access')
      ? json({ revision: 1, managers: grant, ceiling: { capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'], resourceProfileIds: ['review-profile'] } })
      : json({ items: [], cursor: null });
    render(() => <ManagementAccessPanel />);
    const global = await screen.findByRole('region', { name: 'Operator eligibility and limits' });
    expect(await within(global).findByText(/upper limits.*not.*run/i)).toBeInTheDocument();
    expect(within(global).getByRole('checkbox', { name: /Session access/i })).toBeChecked();
    expect(within(global).getByRole('checkbox', { name: /Coding agent/i })).toBeChecked();
    expect(within(global).getByRole('checkbox', { name: /Scoped storage/i })).toBeChecked();
    expect(within(global).getByRole('checkbox', { name: /Inference/i })).toBeChecked();
    expect(within(global).getByRole('checkbox', { name: /Mediated requests/i })).toBeChecked();
    expect(within(global).queryByText(/^pi —/)).not.toBeInTheDocument();
    fireEvent.click(within(global).getByText('Conductor request IDs (advanced)', { selector: 'summary' }));
    expect(within(global).getByText(/requested session and storage.*same allowed ID/i)).toBeInTheDocument();
    expect(within(global).getByText(/not profiles you create/i)).toBeInTheDocument();
    expect(within(global).getByRole('textbox', { name: /Allowed request IDs/i })).toHaveValue('review-profile');
  });

  it('allows admin delegation through the Environment-owned global controls contract', async () => {
    const controls = { revision: 1, managers: grant, ceiling: { capabilities: ['fetch'], resourceProfileIds: [] } };
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/access')) {
        if (init?.method === 'POST') saved = JSON.parse(String(init.body));
        return json(controls);
      }
      return json({ items: [], cursor: null });
    };
    render(() => <ManagementAccessPanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'manager@example.test' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'delegate@example.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save management access' }));
    await waitFor(() => expect(saved).toEqual({ revision: 1, managers: { users: ['delegate@example.test'], groups: [] }, ceiling: controls.ceiling }));
  });
  it('reloads configured identity choices during explicit stale-state reconciliation', async () => {
    let optionsReads = 0;
    let saves = 0;
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, window.location.origin);
      if (url.pathname.endsWith('/options')) {
        optionsReads++;
        return Promise.resolve(json({ ...choices, users: optionsReads === 1 ? ['manager@example.test'] : ['manager@example.test', 'delegate@example.test'] }));
      }
      if (url.pathname.endsWith('/grants') && init?.method === 'POST') {
        saves++; return Promise.resolve(json({ error: 'Stale' }, 409));
      }
      return Promise.resolve(url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null }));
    }));
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }));
    const grants = await screen.findByRole('region', { name: 'Access grants' });
    expect(within(grants).queryByRole('checkbox', { name: 'delegate@example.test' })).not.toBeInTheDocument();
    const save = within(grants).getByRole('button', { name: 'Save permissions' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(saves).toBe(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh current state' }));
    expect(await within(grants).findAllByRole('checkbox', { name: 'delegate@example.test' })).toHaveLength(2);
    expect(optionsReads).toBe(2);
  });

  it('keeps manager and invoker grants independent in the public mutation contract', async () => {
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/grants')) { saved = JSON.parse(String(init?.body)); return json(operator); }
      return url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }));
    const invokers = await screen.findByRole('group', { name: 'Runners' });
    fireEvent.click(within(invokers).getByRole('checkbox', { name: 'invoker@example.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, managers: grant, invokers: { users: ['invoker@example.test'], groups: [] } }));
    expect(await screen.findByText('Permissions saved. Management does not grant execution.')).toBeInTheDocument();
  });
});


describe('REQ-OPERATOR-007: installation-only Pi reasoning', () => {
  it('saves the installation-only Low override without enabling the installation', async () => {
    let current = { ...installation, piReasoningOverride: undefined as string | undefined };
    let saved: Record<string, unknown> | undefined;
    serve = (url, init) => {
      if (url.pathname.endsWith('/configure') && init?.method === 'POST') {
        saved = JSON.parse(String(init.body));
        current = { ...current, piReasoningOverride: saved!.piReasoningOverride as string, revision: current.revision + 1 };
        return json(current);
      }
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), installations: [current] })
        : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const override = await screen.findByRole('combobox', { name: 'test Pi reasoning' });
    expect(override).toHaveValue('');
    fireEvent.change(override, { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for test' }));
    await waitFor(() => expect(saved).toMatchObject({ revision: 2, piReasoningOverride: 'low', policy }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'test Pi reasoning' })).toHaveValue('low'));
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });
});


describe('REQ-OPERATOR-007: management source approval controls', () => {
  const inference = { allowedSources: ['managed', 'pi-native'], routeIds: ['approved-route'], defaultRouteId: 'approved-route',
    reasoningLevels: ['low'], defaultReasoningLevel: 'low', inheritUserDefaults: false };

  it.each([
    { allowedSources: ['unapproved-source'] },
    { routeIds: ['approved-route', 'approved-route'] },
    { defaultRouteId: 'unapproved-route' },
    { reasoningLevels: ['unsupported-level'] },
    { defaultReasoningLevel: 'high' },
    { unexpectedAuthority: true },
  ])('rejects malformed inference restrictions from the management wire contract: %j', async invalid => {
    serve = () => json({ ...detail(), operator: { ...operator, policy: { ...policy, inference: { ...inference, ...invalid } } } });
    await expect(getManagedOperator(operator.id)).rejects.toThrow();
  });

  it('retains canonical operator and installation restrictions when saving unrelated settings through the real client', async () => {
    let operatorSave: any; let installationSave: any;
    const configuration = { unrelated: { keep: true } };
    serve = (url, init) => {
      const currentOperator = { ...operator, policy: { ...policy, inference } };
      const currentInstallation = { ...installation, policy: { ...policy, inference }, configuration, piReasoningOverride: 'low' };
      if (url.pathname.endsWith('/capabilities') && init?.method === 'POST') {
        operatorSave = JSON.parse(String(init.body));
        return json({ ...currentOperator, revision: 4 });
      }
      if (url.pathname.endsWith('/configure') && init?.method === 'POST') {
        installationSave = JSON.parse(String(init.body));
        return json({ ...currentInstallation, revision: 3 });
      }
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), operator: currentOperator, installations: [currentInstallation] })
        : json({ items: [currentOperator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const native = await screen.findByRole('checkbox', { name: 'Operator approve Pi-native source' });
    expect(native).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Operator allow low reasoning' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Operator allow high reasoning' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable logging/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(operatorSave).toMatchObject({ inference, loggingEnabled: false }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save restrictions for test' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for test' }));
    await waitFor(() => expect(installationSave).toEqual({ revision: 2, policy: { ...policy, inference }, configuration, piReasoningOverride: 'low' }));
  });

  it('leaves legacy native approval off and requires explicit reasoning choices without broadening either policy', async () => {
    let saved: any;
    serve = (url, init) => {
      if (url.pathname.endsWith('/capabilities') && init?.method === 'POST') {
        saved = JSON.parse(String(init.body)); return json({ ...operator, policy: { ...policy, inference: saved.inference } });
      }
      return url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    const native = await screen.findByRole('checkbox', { name: 'Operator approve Pi-native source' });
    expect(native).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'test approve Pi-native source' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'test approve Pi-native source' })).toBeDisabled();
    fireEvent.click(native);
    expect(screen.getByRole('checkbox', { name: 'Operator allow high reasoning' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Operator allow low reasoning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved).toMatchObject({ inference: { allowedSources: ['managed', 'pi-native'], routeIds: [],
      defaultRouteId: null, reasoningLevels: ['low'], defaultReasoningLevel: null, inheritUserDefaults: false } }));
    expect(screen.getByRole('checkbox', { name: 'test approve Pi-native source' })).not.toBeChecked();
  });
});

// Local fixtures deliberately do not widen the ordinary management choices above.
describe('REQ-OPERATOR-007/049/075: installation Gateway selection', () => {
  const routes = [
    { id: 'opus', label: 'Opus', reasoningLevels: ['minimal', 'low'] },
    { id: 'cheap', label: 'Cheaper route', reasoningLevels: ['off', 'low'] },
    { id: 'off-only', label: 'Off-only route', reasoningLevels: ['off'] },
  ] satisfies NonNullable<ManagementChoices['managedRoutes']>;
  function fixture(input: { missing?: boolean; levelsMissing?: boolean; savedRoute?: string | null; savedLevel?: 'low' | null; allGranted?: boolean } = {}) {
    const inference: NonNullable<ManagementPolicy['inference']> = {
      allowedSources: ['managed', 'pi-native'], routeIds: input.allGranted ? ['opus', 'cheap', 'off-only']
        : input.savedRoute === 'retired-route' ? ['opus', 'retired-route'] : ['opus'],
      defaultRouteId: input.savedRoute === undefined ? 'opus' : input.savedRoute,
      reasoningLevels: input.allGranted ? ['off', 'minimal', 'low'] : ['minimal', 'low'],
      defaultReasoningLevel: input.savedLevel === undefined ? 'low' : input.savedLevel, inheritUserDefaults: true,
    };
    let currentOperator = { ...operator, policy: { ...policy, inference } };
    let installations = [
      { ...installation, policy: { ...policy, inference }, configuration: { unrelated: { keep: true } }, piReasoningOverride: 'low' as const },
      { ...installation, id: 'installation-2', name: 'second', policy: { ...policy, inference: { ...inference, defaultRouteId: null, defaultReasoningLevel: null } },
        configuration: { unrelated: { keep: true } }, piReasoningOverride: 'low' as const },
    ];
    let failure = 0;
    vi.stubGlobal('fetch', vi.fn((inputUrl: string, init?: RequestInit) => {
      const url = new URL(inputUrl, window.location.origin);
      if (url.pathname.endsWith('/options')) return Promise.resolve(json({ ...choices, ...(input.missing ? {} : { managedRoutes: input.levelsMissing ? routes.map(route => route.id === 'opus' ? { ...route, reasoningLevels: ['minimal'] } : route) : routes }) }));
      if (url.pathname.endsWith('/capabilities') && init?.method === 'POST') {
        const { revision, ...changes } = JSON.parse(String(init.body));
        if (revision !== currentOperator.revision) return Promise.resolve(json({ error: 'Conflict' }, 409));
        currentOperator = { ...currentOperator, revision: revision + 1, policy: { ...currentOperator.policy, ...changes } };
        installations = installations.map(item => ({ ...item, enabled: false }));
        return Promise.resolve(json(currentOperator));
      }
      if (url.pathname.endsWith('/configure') && init?.method === 'POST') {
        if (failure) return Promise.resolve(json({ error: failure === 409 ? 'Conflict' : 'Unavailable' }, failure));
        const body = JSON.parse(String(init.body));
        const id = url.pathname.split('/').at(-2);
        const saved = installations.find(item => item.id === id)!;
        if (saved.revision !== body.revision) return Promise.resolve(json({ error: 'Conflict' }, 409));
        const updated = { ...saved, ...body, revision: saved.revision + 1, enabled: false };
        installations = installations.map(item => item.id === id ? updated : item);
        return Promise.resolve(json(updated));
      }
      return Promise.resolve(url.pathname.endsWith('/operator-1')
        ? json({ ...detail(), operator: currentOperator, installations }) : json({ items: [currentOperator], cursor: null }));
    }));
    return {
      reject: (status: number) => { failure = status; },
      grantCheap: (scope: 'operator' | 'installation') => {
        if (scope === 'operator') currentOperator = { ...currentOperator, policy: { ...policy, inference: { ...inference, routeIds: ['opus', 'cheap'] } } };
        else installations = installations.map(item => ({ ...item, policy: { ...item.policy,
          inference: { ...item.policy.inference, routeIds: ['opus', 'cheap'] } } }));
      },
    };
  }
  async function open() {
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-1' } });
    return screen.findByRole('combobox', { name: 'test Managed Gateway route' });
  }
  async function reopen() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to catalog' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Back to catalog' }));
    return open();
  }
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for test' }));

  it('saves an explicit per-installation route independently, preserving Native Low, grants and configuration on server readback and reopen', async () => {
    fixture({ allGranted: true, savedRoute: null, savedLevel: null });
    render(() => <OperatorManagement />);
    const route = await open();
    expect(route).toHaveValue('');
    fireEvent.change(route, { target: { value: 'opus' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'test Managed reasoning' }), { target: { value: 'minimal' } });
    save();
    await screen.findByText(/Restrictions saved\. Enable new runs separately/);
    const read = await getManagedOperator(operator.id);
    expect(read.installations[0]).toMatchObject({ revision: 3, enabled: false, configuration: { unrelated: { keep: true } }, piReasoningOverride: 'low',
      policy: { inference: { allowedSources: ['managed', 'pi-native'], routeIds: ['opus', 'cheap', 'off-only'],
        reasoningLevels: ['off', 'minimal', 'low'], defaultRouteId: 'opus', defaultReasoningLevel: 'minimal', inheritUserDefaults: false } } });
    expect(read.installations[1].policy.inference?.defaultRouteId).toBeNull();
    expect(read.operator.policy.inference?.inheritUserDefaults).toBe(true);
    expect(read.grants).toEqual(detail().grants);
    expect(await reopen()).toHaveValue('opus');
    expect(screen.getByRole('combobox', { name: 'test Managed reasoning' })).toHaveValue('minimal');
    expect(screen.getByRole('combobox', { name: 'test Pi reasoning' })).toHaveValue('low');
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(await screen.findByRole('combobox', { name: 'second Managed Gateway route' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: 'second Managed Gateway route' }), { target: { value: 'cheap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for second' }));
    await waitFor(async () => expect((await getManagedOperator(operator.id)).installations[1].policy.inference?.defaultRouteId).toBe('cheap'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-1' } });
    expect(await screen.findByRole('combobox', { name: 'test Managed Gateway route' })).toHaveValue('opus');
  });

  it.each(['operator', 'installation'] as const)('does not offer a cheaper catalog route until both policies explicitly grant it (%s first)', async first => {
    const state = fixture();
    render(() => <OperatorManagement />);
    const select = await open();
    expect(within(select).queryByRole('option', { name: 'Cheaper route' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'test Managed reasoning' })).queryByRole('option', { name: 'Off' })).not.toBeInTheDocument();
    state.grantCheap(first); // Explicit permission edit outside this default-selection form.
    expect(within(await reopen()).queryByRole('option', { name: 'Cheaper route' })).not.toBeInTheDocument();
    state.grantCheap(first === 'operator' ? 'installation' : 'operator');
    const refreshed = await reopen();
    expect(within(refreshed).getByRole('option', { name: 'Cheaper route' })).toBeInTheDocument();
    expect(refreshed).toHaveValue('opus');
  });

  it('explicit route approvals persist separately before selecting a cheaper installation default', async () => {
    fixture();
    render(() => <OperatorManagement />);
    await open();
    const installationGrant = () => screen.getByRole('checkbox', { name: 'test allow Gateway route Cheaper route' });
    expect(installationGrant()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Operator allow Gateway route Cheaper route' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(async () => expect((await getManagedOperator(operator.id)).operator.policy.inference?.routeIds).toEqual(['opus', 'cheap']));
    await waitFor(() => expect(installationGrant()).toBeEnabled());
    expect((await getManagedOperator(operator.id)).installations[0].policy.inference?.routeIds).toEqual(['opus']);
    expect(within(screen.getByRole('combobox', { name: 'test Managed Gateway route' })).queryByRole('option', { name: 'Cheaper route' })).not.toBeInTheDocument();
    fireEvent.click(installationGrant());
    save();
    await waitFor(async () => expect((await getManagedOperator(operator.id)).installations[0].policy.inference?.routeIds).toEqual(['opus', 'cheap']));
    expect(await reopen()).toHaveValue('opus');
    fireEvent.change(screen.getByRole('combobox', { name: 'test Managed Gateway route' }), { target: { value: 'cheap' } });
    save();
    await waitFor(async () => expect((await getManagedOperator(operator.id)).installations[0]).toMatchObject({
      enabled: false, piReasoningOverride: 'low', configuration: { unrelated: { keep: true } },
      policy: { inference: { defaultRouteId: 'cheap', defaultReasoningLevel: 'low', routeIds: ['opus', 'cheap'],
        reasoningLevels: ['minimal', 'low'], allowedSources: ['managed', 'pi-native'], inheritUserDefaults: false } },
    }));
    expect(await reopen()).toHaveValue('cheap');
    expect((await getManagedOperator(operator.id)).installations[1].policy.inference?.defaultRouteId).toBeNull();
  });

  it('keeps Provider default null distinct from Off and clears a route to Not configured without account inheritance', async () => {
    fixture({ allGranted: true, savedLevel: null });
    render(() => <OperatorManagement />);
    await open();
    const reasoning = () => screen.getByRole('combobox', { name: 'test Managed reasoning' });
    expect(reasoning()).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: 'test Managed Gateway route' }), { target: { value: 'cheap' } });
    fireEvent.change(reasoning(), { target: { value: 'off' } });
    save();
    await waitFor(async () => expect((await getManagedOperator(operator.id)).installations[0].policy.inference?.defaultReasoningLevel).toBe('off'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save restrictions for test' })).toBeEnabled());
    fireEvent.change(reasoning(), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'test Managed Gateway route' }), { target: { value: '' } });
    save();
    await waitFor(async () => expect((await getManagedOperator(operator.id)).installations[0].policy.inference).toMatchObject({
      defaultRouteId: null, defaultReasoningLevel: null, inheritUserDefaults: false }));
    expect(await reopen()).toHaveValue('');
    expect(reasoning()).toHaveValue('');
  });

  it.each([false, true])('retains unavailable saved route and reasoning on an unrelated Native save with metadata missing=%s', async missing => {
    fixture({ missing, savedRoute: missing ? 'opus' : 'retired-route' });
    render(() => <OperatorManagement />);
    const route = await open();
    expect(within(route).getByRole('option', { name: /unavailable, retained/ })).toBeInTheDocument();
    expect(screen.getByText(/The saved Gateway route or reasoning is unavailable/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'test Pi reasoning' }), { target: { value: 'minimal' } });
    save();
    await screen.findByText(/Restrictions saved\. Enable new runs separately/);
    const read = await getManagedOperator(operator.id);
    expect(read.installations[0]).toMatchObject({ enabled: false, piReasoningOverride: 'minimal', policy: { inference: {
      defaultRouteId: missing ? 'opus' : 'retired-route', defaultReasoningLevel: 'low', inheritUserDefaults: true,
      routeIds: missing ? ['opus'] : ['opus', 'retired-route'], allowedSources: ['managed', 'pi-native'] } } });
    expect(await reopen()).toHaveValue(missing ? 'opus' : 'retired-route');
  });

  it('retains a saved non-executable level visibly when saving unrelated Native settings', async () => {
    fixture({ levelsMissing: true });
    render(() => <OperatorManagement />);
    await open();
    const reasoning = screen.getByRole('combobox', { name: 'test Managed reasoning' });
    expect(reasoning).toHaveValue('low');
    expect(within(reasoning).getByRole('option', { name: /low · unavailable, retained/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'test Pi reasoning' }), { target: { value: 'minimal' } });
    save();
    await screen.findByText(/Restrictions saved\. Enable new runs separately/);
    expect((await getManagedOperator(operator.id)).installations[0]).toMatchObject({ piReasoningOverride: 'minimal',
      policy: { inference: { defaultRouteId: 'opus', defaultReasoningLevel: 'low', reasoningLevels: ['minimal', 'low'] } } });
    await reopen();
    expect(screen.getByRole('combobox', { name: 'test Managed reasoning' })).toHaveValue('low');
  });

  it('retains incompatible reasoning after a route change and requires an explicit compatible choice before save', async () => {
    fixture({ allGranted: true });
    render(() => <OperatorManagement />);
    fireEvent.change(await open(), { target: { value: 'off-only' } });
    expect(screen.getByRole('combobox', { name: 'test Managed reasoning' })).toHaveValue('low');
    expect(screen.getByText(/choose a compatible reasoning level and route/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save restrictions for test' })).toBeDisabled();
    expect((await getManagedOperator(operator.id)).installations[0].policy.inference?.defaultRouteId).toBe('opus');
    fireEvent.change(screen.getByRole('combobox', { name: 'test Managed reasoning' }), { target: { value: 'off' } });
    save();
    await waitFor(async () => expect((await getManagedOperator(operator.id)).installations[0].policy.inference).toMatchObject({ defaultRouteId: 'off-only', defaultReasoningLevel: 'off' }));
  });

  it.each([409, 503])('shows a rejected Gateway save (%s) without substitution, enablement or server changes', async status => {
    const state = fixture({ allGranted: true });
    render(() => <OperatorManagement />);
    fireEvent.change(await open(), { target: { value: 'cheap' } });
    state.reject(status);
    save();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect((await getManagedOperator(operator.id)).installations[0]).toMatchObject({ enabled: false,
      policy: { inference: { defaultRouteId: 'opus', defaultReasoningLevel: 'low' } } });
    expect(await reopen()).toHaveValue('opus');
  });
});

// Public options wire contract: bounded, unique nonsecret route metadata only.
describe('REQ-OPERATOR-007: management options route metadata decoding', () => {
  const route = { id: 'opus', label: 'Opus', reasoningLevels: ['minimal', 'low'] };
  it('decodes exact executable levels and accepts older choices without inventing route eligibility', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...choices, managedRoutes: [route] })));
    expect((await getManagementChoices()).managedRoutes).toEqual([route]);
    vi.stubGlobal('fetch', vi.fn(async () => json(choices)));
    expect((await getManagementChoices()).managedRoutes).toBeUndefined();
  });
  it.each([
    { case: 'untrimmed ID', managedRoutes: [{ ...route, id: ' opus' }] },
    { case: 'oversized ID', managedRoutes: [{ ...route, id: 'x'.repeat(129) }] },
    { case: 'oversized label', managedRoutes: [{ ...route, label: 'x'.repeat(257) }] },
    { case: 'unknown reasoning', managedRoutes: [{ ...route, reasoningLevels: ['automatic'] }] },
    { case: 'duplicate levels', managedRoutes: [{ ...route, reasoningLevels: ['low', 'low'] }] },
    { case: 'duplicate routes', managedRoutes: [route, route] },
    { case: 'too many routes', managedRoutes: Array.from({ length: 129 }, (_, index) => ({ ...route, id: `route-${index}` })) },
    { case: 'private binding', managedRoutes: [{ ...route, providerConfigId: 'private-provider-binding' }] },
  ])('rejects malformed or over-bounded route projection $case', async ({ managedRoutes }) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...choices, managedRoutes })));
    await expect(getManagementChoices()).rejects.toThrow();
  });
});
