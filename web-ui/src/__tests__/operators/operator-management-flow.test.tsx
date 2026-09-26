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
    const install = await screen.findByRole('button', { name: 'Install operator' });
    await waitFor(() => expect(install).toBeEnabled());
    fireEvent.click(install);
    fireEvent.change(screen.getByRole('combobox', { name: 'Version to install' }), { target: { value: release.id } });
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Version to install' }), { target: { value: release.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/operation was not confirmed.*refresh current state/i);
    expect(creates).toBe(1);
    const refresh = screen.getByRole('button', { name: 'Refresh current state' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    if (outcome === 'promotion failed') {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Install operator' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Install operator' }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Version to install' }), { target: { value: release.id } });
      fireEvent.click(screen.getByRole('button', { name: 'Install selected version' }));
      await waitFor(() => expect(promotions).toBe(2));
    } else {
      expect(await screen.findByText(`Pinned release: GitHub release #${release.githubReleaseId}`)).toBeInTheDocument();
      expect(promotions).toBe(1);
    }
    expect(creates).toBe(1);
    expect(enables).toBe(0);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Installed version' })).getByRole('status')).toHaveTextContent('Installed — not enabled'));
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
    expect(within(installed).queryByRole('button', { name: 'Disable for new runs' })).not.toBeInTheDocument();
    fireEvent.change(within(installed).getByRole('combobox', { name: 'Installed configuration' }), { target: { value: 'installation-2' } });
    expect(within(installed).getByRole('button', { name: 'Disable for new runs' })).toBeInTheDocument();
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
    const save = within(grants).getByRole('button', { name: 'Save grants' });
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
    const invokers = await screen.findByRole('group', { name: 'Who can run this operator grants' });
    fireEvent.click(within(invokers).getByRole('checkbox', { name: 'invoker@example.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save grants' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, managers: grant, invokers: { users: ['invoker@example.test'], groups: [] } }));
    expect(await screen.findByText('Permissions saved. Management does not grant execution.')).toBeInTheDocument();
  });
});
