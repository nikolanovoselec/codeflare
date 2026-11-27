import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/fetch-helper';
import { getGithubRepos, getGithubStatus } from '../../api/github';
import type { GithubRepo } from '../../api/github';
import { _resetForTests, githubStore } from '../../stores/github';

vi.mock('../../api/github', () => ({ getGithubRepos: vi.fn(), getGithubStatus: vi.fn(), disconnectGithub: vi.fn() }));

const repo = (full_name: string): GithubRepo => ({
  full_name, name: full_name.split('/')[1], owner: full_name.split('/')[0],
  private: false, visibility: 'public', default_branch: 'main', updated_at: '2026-11-20T12:00:00Z',
});

const repos = vi.mocked(getGithubRepos);
const status = vi.mocked(getGithubStatus);

describe('Dashboard GitHub listing freshness', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    status.mockResolvedValue({ enabled: true, connected: true, login: 'owner', source: 'oauth' });
  });
  afterEach(() => vi.useRealTimers());

  it('REQ-GITHUB-002 AC7: reuses fresh repositories and quietly refreshes stale results without clearing search', async () => {
    repos.mockResolvedValueOnce({ repos: [repo('owner/original')], page: 1, hasMore: false })
      .mockResolvedValueOnce({ repos: [repo('owner/original'), repo('owner/new-repo')], page: 1, hasMore: false });
    await githubStore.loadStatus();
    githubStore.setSearchQuery('owner/');
    await vi.advanceTimersByTimeAsync(299_999);
    await githubStore.loadStatus();
    expect(githubStore.filteredRepos.map(row => row.full_name)).toEqual(['owner/original']);
    await vi.advanceTimersByTimeAsync(1);
    await githubStore.loadStatus();
    expect(githubStore.searchQuery).toBe('owner/');
    expect(githubStore.filteredRepos.map(row => row.full_name)).toEqual(['owner/original', 'owner/new-repo']);
  });

  it('REQ-GITHUB-002 AC7: a failed background refresh leaves rows visible and does not retry on the next return', async () => {
    repos.mockResolvedValueOnce({ repos: [repo('owner/old')], page: 1, hasMore: false })
      .mockRejectedValueOnce(new Error('GitHub unavailable'))
      .mockResolvedValueOnce({ repos: [repo('owner/reloaded')], page: 1, hasMore: false });
    await githubStore.loadStatus();
    await vi.advanceTimersByTimeAsync(300_000);
    await githubStore.loadStatus();
    await githubStore.loadStatus();
    expect(githubStore.error).toBeNull();
    expect(githubStore.repos.map(row => row.full_name)).toEqual(['owner/old']);
    await githubStore.loadRepos();
    expect(githubStore.repos.map(row => row.full_name)).toEqual(['owner/reloaded']);
  });

  it('REQ-GITHUB-332: retries a transient first-page failure to a confirmed empty list', async () => {
    repos.mockRejectedValueOnce(new ApiError('GitHub unavailable', 503, 'Service Unavailable'))
      .mockResolvedValueOnce({ repos: [], page: 1, hasMore: false });
    await githubStore.loadStatus();
    expect(githubStore.canRetryInitialRepos).toBe(true);
    await githubStore.retryInitialRepos();
    expect(githubStore.page).toBe(1);
    expect(githubStore.repos).toEqual([]);
    expect(githubStore.error).toBeNull();
    expect(githubStore.canRetryInitialRepos).toBe(false);
  });

  it('REQ-GITHUB-332: preserves reconnect-required status without retrying the list', async () => {
    repos.mockRejectedValueOnce(Object.assign(new ApiError('GitHub is not connected', 409, 'Conflict'), { code: 'NOT_CONNECTED' }))
      .mockResolvedValueOnce({ repos: [repo('owner/should-not-load')], page: 1, hasMore: false });
    await githubStore.loadStatus();
    await githubStore.retryInitialRepos();
    await vi.advanceTimersByTimeAsync(300_000);
    await githubStore.loadStatus();
    expect(githubStore.repoErrorCode).toBe('NOT_CONNECTED');
    expect(githubStore.repos).toEqual([]);
  });

  it('REQ-GITHUB-332: a failed continuation keeps already loaded pages on automatic retry', async () => {
    repos.mockResolvedValueOnce({ repos: [repo('owner/first')], page: 1, hasMore: true })
      .mockResolvedValueOnce({ repos: [repo('owner/second')], page: 2, hasMore: true })
      .mockRejectedValueOnce(new Error('GitHub unavailable'))
      .mockResolvedValueOnce({ repos: [repo('owner/replaced')], page: 1, hasMore: false });
    await githubStore.loadStatus();
    await githubStore.loadMore();
    await githubStore.loadMore();
    await githubStore.retryInitialRepos();
    expect(githubStore.repos.map(row => row.full_name)).toEqual(['owner/first', 'owner/second']);
    expect(githubStore.error).toBe('GitHub unavailable');
  });

  it('REQ-GITHUB-002 AC7: preserves loaded pages until manual reload or account change', async () => {
    repos.mockResolvedValueOnce({ repos: [repo('owner/first')], page: 1, hasMore: true })
      .mockResolvedValueOnce({ repos: [repo('owner/second')], page: 2, hasMore: false });
    await githubStore.loadStatus();
    await githubStore.loadMore();
    await vi.advanceTimersByTimeAsync(300_000);
    await githubStore.loadStatus();
    expect(githubStore.repos.map(row => row.full_name)).toEqual(['owner/first', 'owner/second']);
    repos.mockResolvedValueOnce({ repos: [repo('owner/reloaded')], page: 1, hasMore: false });
    await githubStore.loadRepos();
    expect(githubStore.repos.map(row => row.full_name)).toEqual(['owner/reloaded']);
    status.mockResolvedValueOnce({ enabled: true, connected: true, login: 'other', source: 'oauth' });
    repos.mockResolvedValueOnce({ repos: [repo('other/fresh')], page: 1, hasMore: false });
    await githubStore.loadStatus();
    expect(githubStore.repos.map(row => row.full_name)).toEqual(['other/fresh']);
  });
});
