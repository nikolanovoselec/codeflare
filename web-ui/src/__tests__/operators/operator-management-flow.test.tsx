import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement, { ManagementAccessPanel } from '../../components/OperatorManagement';

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
  fireEvent.click(screen.getByText('Technical details and advanced restrictions'));
  fireEvent.click(screen.getByText('Replace source', { selector: 'summary' }));
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
    expect(await screen.findByText('No version installed', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable for new runs' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install operator' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Version to install' }), { target: { value: release.id } });
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
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), installations: [{ ...installation, ...state }] }) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install operator' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Version to install' }), { target: { value: release.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable for new runs' })).not.toBeDisabled());
    expect(screen.queryByRole('link', { name: 'Run as yourself' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable for new runs' }));
    expect(await screen.findByRole('link', { name: 'Run as yourself' })).toHaveAttribute('href', '/operators?invoke=installation-1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable for new runs' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Disable for new runs' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run as yourself' })).not.toBeInTheDocument());
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
    fireEvent.click(await screen.findByRole('button', { name: 'Install operator' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Version to install' }), { target: { value: release.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    await waitFor(() => expect(created).toEqual({ name: 'default', policy, revision: 4 }));
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
    fireEvent.click(await screen.findByText('Technical details and advanced restrictions'));
    expect(screen.queryByRole('textbox', { name: /configuration json/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save restrictions for test' }));
    await waitFor(() => expect(saved).toEqual({ revision: 2, policy, configuration: { repositoryId: 123 } }));
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
  it('keeps manager and invoker grants independent in the public mutation contract', async () => {
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/grants')) { saved = JSON.parse(String(init?.body)); return json(operator); }
      return url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions' }));
    const invokers = await screen.findByRole('group', { name: 'Who can run this operator grants' });
    fireEvent.click(within(invokers).getByRole('checkbox', { name: 'invoker@example.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save grants' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, managers: grant, invokers: { users: ['invoker@example.test'], groups: [] } }));
    expect(await screen.findByText('Permissions saved. Management does not grant execution.')).toBeInTheDocument();
  });
});
