import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';

const grant = { users: ['owner@example.test'], groups: [{ issuer: 'example', id: 'saved-group' }] };
const policy = { capabilities: ['session', 'storage'], resourceProfileId: 'review-profile' };
const operator = { id: 'operator-1', revision: 3, name: 'Conductor Review', description: 'Reviews pull requests at protected boundaries.',
  repositoryUrl: 'https://github.com/example/conductor', repositoryId: 123, profile: 'conductor', realm: 'internal',
  enabled: true, managers: grant, invokers: { users: [], groups: [] }, policy,
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
    expect(screen.getByText('Conductor', { selector: '.admin-status' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Installed version' })).toHaveTextContent('v0.1.2');
    expect(screen.getByText('Conductor Review', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/protected pull request boundary/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Runtime permissions' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'default resource profile' })).toHaveValue('review-profile');
    expect(screen.getByText(/Environment.*allow/i)).toBeInTheDocument();
    expect(screen.getByText('Change source', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByText('Technical details', { selector: 'summary' })).toBeInTheDocument();
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
