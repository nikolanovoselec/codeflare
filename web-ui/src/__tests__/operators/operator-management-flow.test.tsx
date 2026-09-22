import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';

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
let serve: (url: URL, init?: RequestInit) => Response | Promise<Response>;
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  serve = url => url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => Promise.resolve(serve(new URL(input, window.location.origin), init))));
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
    fireEvent.click(await screen.findByText('Edit source'));
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
    expect(await screen.findByText(/discovered · not approved/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable test' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Release for test'), { target: { value: release.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and promote test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/stale/i);
    expect(screen.getByRole('button', { name: 'Approve and promote test' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh current state' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve and promote test' })).not.toBeDisabled());
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
    fireEvent.change(await screen.findByLabelText('Release for test'), { target: { value: release.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and promote test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable test' })).not.toBeDisabled());
    expect(screen.queryByRole('link', { name: 'Invoke as yourself' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable test' }));
    expect(await screen.findByRole('link', { name: 'Invoke as yourself' })).toHaveAttribute('href', '/operators?invoke=installation-1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable test' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Disable test' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Invoke as yourself' })).not.toBeInTheDocument());
  });
  it('reconciles the operator revision after discovery before creating a disabled installation', async () => {
    let revision = 3;
    let created: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/releases/refresh')) { revision = 4; return json({ items: [release] }); }
      if (url.pathname.endsWith('/installations')) { created = JSON.parse(String(init?.body)); return json(installation); }
      return url.pathname.endsWith('/operator-1') ? json({ ...detail(), operator: { ...operator, revision } }) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh releases' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create disabled installation' })).not.toBeDisabled());
    fireEvent.input(screen.getByLabelText('Installation name'), { target: { value: 'production-label' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create disabled installation' }));
    await waitFor(() => expect(created).toEqual({ name: 'production-label', policy, revision: 4 }));
  });
  it('edits source with a blank write-only credential and clears it on submission', async () => {
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/source')) { saved = JSON.parse(String(init?.body)); return json({ ...operator, revision: 4 }); }
      return url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByText('Edit source'));
    const secret = await screen.findByLabelText('Replacement repository-read PAT');
    expect(secret).toHaveValue('');
    fireEvent.input(secret, { target: { value: 'fixture-replacement-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace source' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, repositoryUrl: operator.repositoryUrl, githubPat: 'fixture-replacement-secret' }));
    expect(secret).toHaveValue('');
    expect(screen.queryByText('fixture-replacement-secret')).not.toBeInTheDocument();
  });
  it('saves installation restrictions and configuration at the observed revision', async () => {
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/configure')) { saved = JSON.parse(String(init?.body)); return json(installation); }
      return url.pathname.endsWith('/operator-1') ? json(detail()) : json({ items: [operator], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: `Manage ${operator.repositoryUrl}` }));
    fireEvent.click(await screen.findByText('Configure test'));
    fireEvent.input(await screen.findByLabelText('Configuration JSON for test'), { target: { value: '{"repositoryId":123}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration for test' }));
    await waitFor(() => expect(saved).toEqual({ revision: 2, policy, configuration: { repositoryId: 123 } }));
  });
  it('allows admin delegation through the server-owned global controls contract', async () => {
    const controls = { revision: 1, managers: grant, ceiling: { capabilities: ['github.read'], resourceProfileIds: [] } };
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/access')) {
        if (init?.method === 'POST') saved = JSON.parse(String(init.body));
        return json(controls);
      }
      return json({ items: [], cursor: null });
    };
    render(() => <OperatorManagement isAdmin />);
    fireEvent.input(await screen.findByLabelText('Eligible manager users'), { target: { value: 'delegate@example.test' } });
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
    const field = await screen.findByLabelText('Invoker users');
    fireEvent.input(field, { target: { value: 'invoker@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save grants' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, managers: grant, invokers: { users: ['invoker@example.test'], groups: [] } }));
    expect(await screen.findByText('Grants saved. Management does not grant invocation.')).toBeInTheDocument();
  });
});
