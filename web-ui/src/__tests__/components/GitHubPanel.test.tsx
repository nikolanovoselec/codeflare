import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiConnection } from '@mdi/js';

// API mocks (hoisted so the vi.mock factory can reference them).
const mockGetGithubStatus = vi.hoisted(() => vi.fn());
const mockGetGithubRepos = vi.hoisted(() => vi.fn());
const mockDisconnectGithub = vi.hoisted(() => vi.fn());

vi.mock('../../api/github', () => ({
  getGithubStatus: (...args: unknown[]) => mockGetGithubStatus(...args),
  getGithubRepos: (...args: unknown[]) => mockGetGithubRepos(...args),
  disconnectGithub: (...args: unknown[]) => mockDisconnectGithub(...args),
  githubConnectUrl: () => '/api/github/connect',
}));

import GitHubPanel from '../../components/github/GitHubPanel';
import { _resetForTests } from '../../stores/github';

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    full_name: 'octocat/hello',
    name: 'hello',
    owner: 'octocat',
    private: false,
    visibility: 'public',
    default_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('GitHubPanel Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    mockGetGithubRepos.mockResolvedValue({ repos: [], page: 1, hasMore: false });
    mockDisconnectGithub.mockResolvedValue({ success: true });
    // Reset URL query so onMount's ?github= handling is inert by default.
    window.history.replaceState({}, '', '/app/');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when status.enabled is false', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: false, connected: false });

    render(() => <GitHubPanel />);

    // Wait for the status load to resolve, then assert no panel is rendered.
    await waitFor(() => expect(mockGetGithubStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('github-panel')).not.toBeInTheDocument();
  });

  it('renders the ConnectCard with connect target /api/github/connect when not connected', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: false });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-connect-card')).toBeInTheDocument());
    const btn = screen.getByTestId('github-connect-btn');
    expect(btn.getAttribute('data-href')).toBe('/api/github/connect');
    // No repo rows in the not-connected state.
    expect(screen.queryByTestId('github-repo-row')).not.toBeInTheDocument();
  });

  it('clicking Connect navigates to the connect URL', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: false });
    // Mirror the LoginPage test pattern: replace window.location with a
    // writable stub carrying the fields onMount reads (search/pathname) so
    // the navigation assignment is observable on .href.
    const originalLocation = window.location;
    const mockLocation = { href: '', search: '', pathname: '/app/' };
    Object.defineProperty(window, 'location', { value: mockLocation, writable: true });

    render(() => <GitHubPanel />);
    await waitFor(() => expect(screen.getByTestId('github-connect-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('github-connect-btn'));

    expect(mockLocation.href).toBe('/api/github/connect');

    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('renders exactly N RepoRow elements for N repos when connected', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValueOnce({
      repos: [
        makeRepo({ full_name: 'octocat/a', name: 'a' }),
        makeRepo({ full_name: 'octocat/b', name: 'b' }),
        makeRepo({ full_name: 'octocat/c', name: 'c' }),
      ],
      page: 1,
      hasMore: false,
    });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getAllByTestId('github-repo-row')).toHaveLength(3));
  });

  it('renders a private-variant badge element for a private repo', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValueOnce({
      repos: [makeRepo({ full_name: 'octocat/secret', name: 'secret', private: true, visibility: 'private' })],
      page: 1,
      hasMore: false,
    });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-repo-row')).toBeInTheDocument());
    const row = screen.getByTestId('github-repo-row');
    expect(row.getAttribute('data-private')).toBe('true');
    const badge = screen.getByTestId('github-repo-badge');
    expect(badge.classList.contains('github-repo-badge--private')).toBe(true);
    expect(badge.classList.contains('github-repo-badge--public')).toBe(false);
  });

  it('renders an enabled Clone button carrying repo + branch data', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValueOnce({
      repos: [makeRepo({ full_name: 'octocat/hello', default_branch: 'trunk' })],
      page: 1,
      hasMore: false,
    });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-repo-clone-btn')).toBeInTheDocument());
    const clone = screen.getByTestId('github-repo-clone-btn') as HTMLButtonElement;
    expect(clone.disabled).toBe(false);
    expect(clone.getAttribute('data-repo')).toBe('octocat/hello');
    expect(clone.getAttribute('data-branch')).toBe('trunk');
  });

  it('search input filters the rendered row count', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValueOnce({
      repos: [
        makeRepo({ full_name: 'octocat/alpha', name: 'alpha' }),
        makeRepo({ full_name: 'octocat/beta', name: 'beta' }),
        makeRepo({ full_name: 'octocat/alphabet', name: 'alphabet' }),
      ],
      page: 1,
      hasMore: false,
    });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getAllByTestId('github-repo-row')).toHaveLength(3));

    const input = screen.getByTestId('github-search-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'alpha' } });

    // 'alpha' matches octocat/alpha and octocat/alphabet, not octocat/beta.
    await waitFor(() => expect(screen.getAllByTestId('github-repo-row')).toHaveLength(2));
  });

  it('clicking Disconnect calls the API and flips to the not-connected state', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValueOnce({ repos: [makeRepo()], page: 1, hasMore: false });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-disconnect-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('github-disconnect-btn'));

    await waitFor(() => expect(mockDisconnectGithub).toHaveBeenCalled());
    // After disconnect the connected header is gone and the connect card returns.
    await waitFor(() => {
      expect(screen.queryByTestId('github-connected-header')).not.toBeInTheDocument();
      expect(screen.getByTestId('github-connect-card')).toBeInTheDocument();
    });
  });

  it('shows a non-blocking error and strips the param on ?github=denied', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: false });
    window.history.replaceState({}, '', '/app/?github=denied');

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-return-error')).toBeInTheDocument());
    // The query param is stripped (history.replaceState to pathname).
    expect(window.location.search).toBe('');
  });

  it('refresh control reloads the repo list', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValue({ repos: [makeRepo()], page: 1, hasMore: false });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-refresh-btn')).toBeInTheDocument());
    const before = mockGetGithubRepos.mock.calls.length;
    fireEvent.click(screen.getByTestId('github-refresh-btn'));
    await waitFor(() => expect(mockGetGithubRepos.mock.calls.length).toBeGreaterThan(before));
  });

  it('disconnect control is an icon button using the connection icon', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });

    render(() => <GitHubPanel />);

    const btn = await waitFor(() => screen.getByTestId('github-disconnect-btn'));
    expect(btn.querySelector('path')?.getAttribute('d')).toBe(mdiConnection);
  });

  it('connected login links out to the GitHub profile in a new tab', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });

    render(() => <GitHubPanel />);

    const link = (await waitFor(() => screen.getByTestId('github-connected-login'))) as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://github.com/octocat');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('repo name links to the repo on GitHub in a new tab', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    mockGetGithubRepos.mockResolvedValueOnce({
      repos: [makeRepo({ full_name: 'octocat/hello' })],
      page: 1,
      hasMore: false,
    });

    render(() => <GitHubPanel />);

    const link = (await waitFor(() => screen.getByTestId('github-repo-link'))) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/octocat/hello');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('renders every repo inside the scroll container (the 10-row cap is a CSS viewport, not truncation)', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: true, login: 'octocat' });
    const repos = Array.from({ length: 15 }, (_, i) => makeRepo({ full_name: `octocat/r${i}`, name: `r${i}` }));
    mockGetGithubRepos.mockResolvedValueOnce({ repos, page: 1, hasMore: false });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-repo-rows')).toBeInTheDocument());
    expect(screen.getAllByTestId('github-repo-row')).toHaveLength(15);
  });

  it('renders the mobile flip control only when onFlip is provided, and fires it', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: false });
    const onFlip = vi.fn();

    render(() => <GitHubPanel onFlip={onFlip} />);

    await waitFor(() => expect(screen.getByTestId('github-flip-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('github-flip-btn'));
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('omits the flip control when onFlip is not provided', async () => {
    mockGetGithubStatus.mockResolvedValueOnce({ enabled: true, connected: false });

    render(() => <GitHubPanel />);

    await waitFor(() => expect(screen.getByTestId('github-panel')).toBeInTheDocument());
    expect(screen.queryByTestId('github-flip-btn')).not.toBeInTheDocument();
  });
});
