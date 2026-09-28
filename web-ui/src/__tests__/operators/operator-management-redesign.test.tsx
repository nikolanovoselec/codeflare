import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement, { ManagementAccessPanel } from '../../components/OperatorManagement';

const grant = { users: ['owner@example.test'], groups: [{ issuer: 'example', id: 'saved-group' }] };
const policy = { capabilities: ['session', 'storage'], resourceProfileId: 'review-profile' };
const operator = { id: 'operator-1', revision: 3, name: 'Conductor Review', description: 'Reviews pull requests at protected boundaries.',
  repositoryUrl: 'https://github.com/example/conductor', repositoryId: 123, profile: 'conductor', realm: 'internal',
  enabled: true, installedGithubReleaseId: 456, installedTagName: 'v0.1.2', installedPublishedAt: '2026-09-25T12:00:00Z', managers: grant, invokers: { users: [], groups: [] }, policy,
  source: { kind: 'github-release', repositoryUrl: 'https://github.com/example/conductor', repositoryId: 123,
    credentialConfigured: true, approvedWorkflow: null } };
const release = { id: 'release-1', operatorId: 'operator-1', githubReleaseId: 456, sourceCommit: 'abc', manifestDigest: 'a'.repeat(64),
  bundleDigest: 'b'.repeat(64), interfaceVersion: 1, approved: true, name: 'Conductor Review', description: operator.description,
  tagName: 'v0.1.2', publishedAt: '2026-09-25T12:00:00Z' };
const installed = { id: 'installation-1', operatorId: 'operator-1', name: 'default', releaseId: release.id, revision: 2, enabled: true, policy };
const choices = { users: ['owner@example.test'], groups: [], unresolvedGroups: ['not-verified'], capabilities: ['session', 'storage'],
  resourceProfileIds: ['review-profile'], ceiling: { capabilities: ['session', 'storage'], resourceProfileIds: ['review-profile'] } };
const json = (value: unknown) => new Response(JSON.stringify(value));
let serve: (url: URL, init?: RequestInit) => Promise<Response> | Response;
beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  serve = url => url.pathname.endsWith('/operator-1')
    ? json({ operator, releases: [release, { ...release, id: 'release-legacy', tagName: undefined, publishedAt: undefined, githubReleaseId: 455 }],
      installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } })
    : json({ items: [operator], cursor: null });
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    return Promise.resolve(url.pathname.endsWith('/options') ? json(choices) : serve(url, init));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function open() {
  render(() => <OperatorManagement />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage Conductor Review' }));
  await screen.findByRole('region', { name: 'Installed version' });
}

describe('REQ-OPERATOR-049: operator task hierarchy', () => {
  it('presents the authored name, category and verified installed version in the catalog instead of an opaque release number', async () => {
    render(() => <OperatorManagement />);
    const catalog = await screen.findByRole('region', { name: 'Operator catalog' });
    const row = (await within(catalog).findByRole('button', { name: 'Manage Conductor Review' })).closest('li')!;
    expect(within(row).getByText('Conductor Review', { selector: 'strong' })).toBeInTheDocument();
    expect(within(row).getByText('Conductor')).toBeInTheDocument();
    expect(row).not.toHaveTextContent('(Conductor)');
    expect(row).toHaveTextContent('v0.1.2');
    expect(row).toHaveTextContent(/Published.*2026/);
    expect(row).not.toHaveTextContent('Pinned release #456');
    expect(within(catalog).queryByRole('heading', { name: 'Catalog' })).not.toBeInTheDocument();
  });

  it('REQ-OPERATOR-049: labels catalog enablement concisely for enabled and disabled operators', async () => {
    serve = () => json({ items: [operator, { ...operator, id: 'disabled', enabled: false, name: 'Disabled operator' }], cursor: null });
    render(() => <OperatorManagement />);
    const catalog = await screen.findByRole('region', { name: 'Operator catalog' });
    const enabledRow = (await within(catalog).findByRole('button', { name: 'Manage Conductor Review' })).closest('li')!;
    const disabledRow = (await within(catalog).findByRole('button', { name: 'Manage Disabled operator' })).closest('li')!;
    expect(within(enabledRow).getByText('Enabled')).toBeInTheDocument();
    expect(within(disabledRow).getByText('Disabled')).toBeInTheDocument();
    expect(enabledRow).not.toHaveTextContent('Enabled for new runs');
  });

  it('presents first-party display names without replacing verified package identity or collapsing release details into status', async () => {
    const firstParty = { ...operator, repositoryId: 1380652764, repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-conductor' };
    serve = url => url.pathname.endsWith('/operator-1')
      ? json({ operator: firstParty, releases: [release], installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } })
      : json({ items: [firstParty], cursor: null });
    render(() => <OperatorManagement />);
    const catalog = await screen.findByRole('region', { name: 'Operator catalog' });
    const row = (await within(catalog).findByRole('button', { name: 'Manage Pull Request Reviewer' })).closest('li')!;
    expect(within(row).getByText('Pull Request Reviewer', { selector: 'strong' })).toBeInTheDocument();
    expect(within(row).getByText('v0.1.2')).toBeInTheDocument();
    expect(within(row).getByText(/Published.*2026/)).toBeInTheDocument();
    expect(within(row).getByText('Enabled')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Pull Request Reviewer' }));
    expect(await screen.findByRole('heading', { name: 'Pull Request Reviewer' })).toBeInTheDocument();
    expect(screen.getByText('Conductor Review', { selector: 'dd' })).toBeInTheDocument();
    const technical = screen.getByText('Technical details', { selector: 'summary' }).parentElement!;
    expect(technical).toHaveTextContent('Core contract version');
    expect(technical).toHaveTextContent('Interface version');
    expect(technical).toHaveTextContent(/not the installed release version/);
  });

  it('presents Renovate Manager only for the verified first-party Dispatcher', async () => {
    serve = () => json({ items: [{ ...operator, repositoryId: 1380652724,
      repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher',
      profile: 'dispatcher', name: 'Renovate Dispatcher' }], cursor: null });
    render(() => <OperatorManagement />);
    const row = (await screen.findByRole('button', { name: 'Manage Renovate Manager' })).closest('li')!;
    expect(within(row).getByText('Renovate Manager', { selector: 'strong' })).toBeInTheDocument();
    expect(within(row).getByText('Dispatcher')).toBeInTheDocument();
    expect(row).not.toHaveTextContent('(Dispatcher)');
  });

  it('does not assign the first-party name to a third-party Dispatcher or a mismatched repository identity', async () => {
    const impersonators = [
      { ...operator, id: 'third-party', name: 'Renovate Dispatcher', profile: 'dispatcher', repositoryId: 818,
        repositoryUrl: 'https://github.com/acme/renovate-dispatcher' },
      { ...operator, id: 'wrong-id', name: 'Renovate Dispatcher', profile: 'dispatcher', repositoryId: 819,
        repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher' },
    ];
    serve = () => json({ items: impersonators, cursor: null });
    render(() => <OperatorManagement />);
    expect(await screen.findAllByRole('button', { name: 'Manage Renovate Dispatcher' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Manage Renovate Manager' })).not.toBeInTheDocument();
  });

  it('REQ-OPERATOR-058: carries a user-chosen editable repository and PR to the guided Dispatcher form without preparing activity', async () => {
    const dispatcher = { ...operator, name: 'Renovate Dispatcher', profile: 'dispatcher',
      repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher', repositoryId: 1380652724 };
    let preparations = 0;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') preparations++;
      if (url.pathname.endsWith('/preview')) return json({ name: 'Renovate Dispatcher', version: 'v0.1.2', guidedAssessment: true });
      if (url.pathname.endsWith('/operator-1')) return json({ operator: dispatcher, releases: [{ ...release, name: 'Renovate Dispatcher' }], installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } });
      return json({ items: [dispatcher], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Renovate Manager' }));
    await screen.findByRole('region', { name: 'Installed version' });
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository to assess' }), { target: { value: 'selected/repository' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request to assess' }), { target: { value: '1299' } });
    fireEvent.click(screen.getByRole('link', { name: 'Assess a pull request' }));
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveValue('selected/repository');
    expect(screen.getByRole('spinbutton', { name: 'Pull request number' })).toHaveValue(1299);
    expect(preparations).toBe(0);
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'changed/repository' } });
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('changed/repository');
    expect(preparations).toBe(0);
  });

  it('REQ-OPERATOR-058: never supplies a universal repository or PR when no target was selected', async () => {
    const dispatcher = { ...operator, name: 'Renovate Dispatcher', profile: 'dispatcher',
      repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher', repositoryId: 1380652724 };
    serve = url => url.pathname.endsWith('/operator-1')
      ? json({ operator: dispatcher, releases: [{ ...release, name: 'Renovate Dispatcher' }], installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } })
      : url.pathname.endsWith('/preview') ? json({ name: 'Renovate Dispatcher', version: 'v0.1.2', guidedAssessment: true })
      : json({ items: [dispatcher], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Renovate Manager' }));
    await screen.findByRole('region', { name: 'Installed version' });
    fireEvent.click(screen.getByRole('link', { name: 'Assess a pull request' }));
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveValue('');
    expect(screen.getByRole('spinbutton', { name: 'Pull request number' })).toHaveValue(null);
  });

  it('refreshes verified metadata for an older installed pin without changing its enablement', async () => {
    const old = { ...release, tagName: undefined, publishedAt: undefined };
    let refreshed = false;
    serve = url => url.pathname.endsWith('/releases/refresh')
      ? (refreshed = true, json({ items: [release] }))
      : url.pathname.endsWith('/operator-1')
        ? json({ operator, releases: [refreshed ? release : old], installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } })
        : json({ items: [operator], cursor: null });
    await open();
    const pane = screen.getByRole('region', { name: 'Installed version' });
    expect(pane).toHaveTextContent('Publication time unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh release details' }));
    await waitFor(() => expect(refreshed).toBe(true));
    await waitFor(() => expect(pane).toHaveTextContent(/v0\.1\.2.*Published.*2026/));
    expect(pane).toHaveTextContent('Enabled for new runs');
  });

  it('does not claim publication time is missing when only the version label is absent', async () => {
    serve = url => url.pathname.endsWith('/operator-1')
      ? json({ operator, releases: [{ ...release, tagName: undefined }], installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } })
      : json({ items: [operator], cursor: null });
    await open();
    const pane = screen.getByRole('region', { name: 'Installed version' });
    expect(pane).toHaveTextContent(/Published.*2026/);
    expect(pane).toHaveTextContent('Version label unavailable for this release.');
    expect(pane).not.toHaveTextContent('Publication time unavailable for this release.');
  });

  it('shows the selected installed version alongside the count when two configurations have one enabled pin', async () => {
    serve = url => url.pathname.endsWith('/operator-1') ? json({ operator, releases: [release], installations: [installed, { ...installed, id: 'installation-2', enabled: false }], grants: { managers: grant, invokers: { users: [], groups: [] } } })
      : json({ items: [{ ...operator, installationCount: 2 }], cursor: null });
    render(() => <OperatorManagement />);
    const catalog = await screen.findByRole('region', { name: 'Operator catalog' });
    const row = (await within(catalog).findByRole('button', { name: 'Manage Conductor Review' })).closest('li')!;
    expect(row).toHaveTextContent('2 configurations');
    expect(row).toHaveTextContent('Installed v0.1.2');
    expect(row).toHaveTextContent(/Published.*2026/);
  });

  it('does not pretend an unverified installed version is a release number', async () => {
    serve = url => url.pathname.endsWith('/operator-1') ? json({ operator, releases: [release], installations: [installed], grants: { managers: grant, invokers: { users: [], groups: [] } } })
      : json({ items: [{ ...operator, installedTagName: undefined, installedPublishedAt: undefined }], cursor: null });
    render(() => <OperatorManagement />);
    const catalog = await screen.findByRole('region', { name: 'Operator catalog' });
    const row = (await within(catalog).findByRole('button', { name: 'Manage Conductor Review' })).closest('li')!;
    expect(row).toHaveTextContent('Installed version details unavailable');
    expect(catalog).not.toHaveTextContent('Pinned release #456');
  });
  it('reveals Search beside Register, filters as the person types, and clears on close without a submit', async () => {
    const queries: string[] = [];
    serve = url => { queries.push(url.searchParams.get('query') ?? ''); return json({ items: [operator], cursor: null }); };
    render(() => <OperatorManagement />);
    const toggle = await screen.findByRole('button', { name: 'Search operators' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search operators' }), { target: { value: 'Review' } });
    await waitFor(() => expect(queries).toContain('Review'));
    expect(window.location.search).toContain('query=Review');
    expect(screen.queryByRole('button', { name: /^search$/i })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(queries[queries.length - 1]).toBe(''));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('ignores late search responses when a newer search has already resolved', async () => {
    let finish!: (response: Response) => void;
    serve = url => url.searchParams.get('query') === 'old'
      ? new Promise<Response>(resolve => { finish = resolve; })
      : json({ items: [{ ...operator, name: url.searchParams.get('query') || 'Conductor Review' }], cursor: null });
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('button', { name: 'Search operators' }));
    const input = screen.getByRole('searchbox', { name: 'Search operators' });
    fireEvent.input(input, { target: { value: 'old' } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.input(input, { target: { value: 'new' } });
    expect(await screen.findByText('new', { selector: 'strong' })).toBeInTheDocument();
    finish(json({ items: [{ ...operator, name: 'stale' }], cursor: null }));
    await waitFor(() => expect(screen.queryByText('stale', { selector: 'strong' })).not.toBeInTheDocument());
  });

  it('separates verified package identity from the category and keeps source replacement out of restrictions', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'Conductor Review' })).toBeInTheDocument();
    expect(screen.getByText('Conductor')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Installed version' })).toHaveTextContent('v0.1.2');
    expect(screen.getByText('Conductor Review', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/protected pull request boundary/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Runtime permissions' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'default resource profile' })).toHaveValue('review-profile');
    expect(screen.getByText(/Environment.*allow/i)).toBeInTheDocument();
    expect(screen.getByText('Change source', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText('Technical details', { selector: 'summary' })).toBeInTheDocument();
  });

  it('explains that allowed scope IDs match requests rather than creating profiles', async () => {
    serve = url => url.pathname.endsWith('/access')
      ? json({ revision: 1, managers: grant, ceiling: choices.ceiling }) : json({ items: [], cursor: null });
    render(() => <ManagementAccessPanel />);
    const advanced = await screen.findByText('Conductor request IDs (advanced)', { selector: 'summary' });
    fireEvent.click(advanced);
    expect(advanced.parentElement).toHaveTextContent(/not create a session or configure storage/i);
    expect(advanced.parentElement).toHaveTextContent(/same allowed ID/i);
  });

  it('offers each alternative version once with its description and publication date beside the choice', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Versions & updates' }));
    const pane = screen.getByRole('region', { name: 'Versions and updates' });
    const choice = within(pane).getByRole('radio', { name: /version unavailable/i });
    expect(choice.closest('label')).toHaveTextContent(/Publication time unavailable/);
    expect(choice.closest('label')).toHaveTextContent('Reviews pull requests at protected boundaries.');
    expect(within(pane).getAllByText('Reviews pull requests at protected boundaries.')).toHaveLength(1);
    expect(within(pane).getByRole('button', { name: 'Install selected version' })).toBeDisabled();
  });

  it('edits the operator capability ceiling after registration without silently editing an installation or keeping it enabled', async () => {
    let currentOperator = operator;
    let currentInstallation = installed;
    let saved: unknown;
    serve = (url, init) => {
      if (url.pathname.endsWith('/capabilities') && init?.method === 'POST') {
        saved = JSON.parse(String(init.body));
        currentOperator = { ...operator, revision: 4, policy: { ...policy, capabilities: ['session'] } };
        currentInstallation = { ...installed, enabled: false, revision: 3 };
        return json(currentOperator);
      }
      return url.pathname.endsWith('/operator-1')
        ? json({ operator: currentOperator, releases: [release], installations: [currentInstallation], grants: { managers: grant, invokers: { users: [], groups: [] } } })
        : json({ items: [currentOperator], cursor: null });
    };
    await open();
    const capabilities = within(screen.getByRole('region', { name: 'Runtime permissions' })).getByRole('group', { name: 'Operator capabilities' });
    fireEvent.click(within(capabilities).getByRole('checkbox', { name: /Scoped storage/i }));
    fireEvent.click(within(capabilities).getByRole('button', { name: 'Save operator capabilities' }));
    await waitFor(() => expect(saved).toEqual({ revision: 3, capabilities: ['session'] }));
    expect(await screen.findByRole('button', { name: 'Enable for new runs' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Installation restrictions' })).toHaveTextContent(/storage.*unavailable/i);
  });

  it('keeps saved missing grants, distinguishes unverified choices and shows local save feedback', async () => {
    let saved: unknown;
    const original = serve;
    serve = (url, init) => url.pathname.endsWith('/grants') && init?.method === 'POST'
      ? (saved = JSON.parse(String(init.body)), json(operator)) : original(url, init);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    const pane = screen.getByRole('region', { name: 'Access grants' });
    expect(within(pane).getByRole('group', { name: 'Managers' })).toBeInTheDocument();
    expect(within(pane).getByRole('group', { name: 'Runners' })).toBeInTheDocument();
    expect(within(pane).getByText(/unverified configured groups cannot be assigned: not-verified/i)).toBeInTheDocument();
    expect(within(pane).getByRole('checkbox', { name: /saved-group.*retained/i })).toBeChecked();
    fireEvent.click(within(pane).getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(saved).toMatchObject({ managers: grant }));
    expect(await within(pane).findByText(/permissions saved/i)).toBeVisible();
  });
});
