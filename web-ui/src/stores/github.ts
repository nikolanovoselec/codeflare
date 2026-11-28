import { createStore, produce } from 'solid-js/store';
import { ApiError } from '../api/fetch-helper';
import * as githubApi from '../api/github';
import type { GithubStatus, GithubRepo } from '../api/github';
import { DASHBOARD_LIST_FRESHNESS_MS } from '../lib/constants';

interface GithubState {
  // null until the first status load resolves. The panel renders nothing
  // while status is null OR status.enabled is false.
  status: GithubStatus | null;
  statusLoaded: boolean;
  repos: GithubRepo[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  repoErrorCode?: string;
  initialRepoFailure: boolean;
  searchQuery: string;
}

const initialState: GithubState = {
  status: null,
  statusLoaded: false,
  repos: [],
  page: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  repoErrorCode: undefined,
  initialRepoFailure: false,
  searchQuery: '',
};

const [state, setState] = createStore<GithubState>({ ...initialState });
let lastRepoAttemptAt: number | undefined;
let repoGeneration = 0;
let statusGeneration = 0;
let loadingFirstPage = false;

function resetRepos() {
  repoGeneration++;
  lastRepoAttemptAt = undefined;
  loadingFirstPage = false;
  setState({ repos: [], page: 0, hasMore: false, loading: false, loadingMore: false, searchQuery: '', error: null, repoErrorCode: undefined, initialRepoFailure: false });
}

export const githubStore = {
  get status() { return state.status; },
  get statusLoaded() { return state.statusLoaded; },
  get enabled() { return state.status?.enabled === true; },
  get connected() { return state.status?.connected === true; },
  get login() { return state.status?.login; },
  get source() { return state.status?.source; },
  get repos() { return state.repos; },
  get page() { return state.page; },
  get hasMore() { return state.hasMore; },
  get loading() { return state.loading; },
  get loadingMore() { return state.loadingMore; },
  get error() { return state.error; },
  get repoErrorCode() { return state.repoErrorCode; },
  get canRetryInitialRepos() {
    return state.status?.connected === true && state.initialRepoFailure && state.page === 0 && !state.loading && !loadingFirstPage;
  },
  async retryInitialRepos() {
    if (githubStore.canRetryInitialRepos) await githubStore.loadRepos();
  },
  get searchQuery() { return state.searchQuery; },

  // Client-side filter over the already-loaded repos, by full_name.
  // Mirrors StorageBrowser's searchQuery filter chain.
  get filteredRepos() {
    const q = state.searchQuery.trim().toLowerCase();
    if (!q) return state.repos;
    return state.repos.filter((r) => r.full_name.toLowerCase().includes(q));
  },

  setSearchQuery(query: string) {
    setState('searchQuery', query);
  },

  async loadStatus() {
    const generation = ++statusGeneration;
    try {
      const status = await githubApi.getGithubStatus();
      if (generation !== statusGeneration) return;
      const previous = state.status;
      if (previous?.enabled !== status.enabled || previous?.connected !== status.connected
        || previous?.login !== status.login || previous?.source !== status.source) resetRepos();
      setState({ status, statusLoaded: true });
      if (status.enabled && status.connected && !loadingFirstPage && !state.loadingMore && state.page <= 1
        && state.repoErrorCode !== 'NOT_CONNECTED'
        && (lastRepoAttemptAt === undefined || Date.now() - lastRepoAttemptAt >= DASHBOARD_LIST_FRESHNESS_MS)) {
        await githubStore.loadRepos({ silent: state.page === 1 });
      }
    } catch (err) {
      if (generation !== statusGeneration) return;
      setState('statusLoaded', true);
      if (state.page === 0) setState('error', err instanceof Error ? err.message : String(err));
    }
  },

  // Manual reload starts a new first page immediately, even during a background request.
  async loadRepos({ silent = false } = {}) {
    const generation = ++repoGeneration;
    lastRepoAttemptAt = Date.now();
    loadingFirstPage = true;
    setState({ loading: !silent, loadingMore: false, error: null, repoErrorCode: undefined, initialRepoFailure: false });
    try {
      const result = await githubApi.getGithubRepos(1);
      if (generation !== repoGeneration) return;
      setState({ repos: result.repos, page: result.page, hasMore: result.hasMore });
    } catch (err) {
      if (generation !== repoGeneration) return;
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'NOT_CONNECTED' || !silent) {
        setState({ error: err instanceof Error ? err.message : String(err), repoErrorCode: code,
          initialRepoFailure: !silent && code !== 'NOT_CONNECTED' && state.page === 0
            && (!(err instanceof ApiError) || err.status === 0 || err.status === 429 || err.status >= 500) });
      }
    } finally {
      if (generation === repoGeneration) {
        loadingFirstPage = false;
        setState('loading', false);
      }
    }
  },

  // Fetch the next page and append (pagination via hasMore).
  async loadMore() {
    if (!state.hasMore || state.loadingMore || state.loading) return;
    // An explicit continuation wins over a quiet page-one refresh.
    const generation = ++repoGeneration;
    loadingFirstPage = false;
    setState(produce((s) => {
      s.loadingMore = true;
      s.error = null;
      s.repoErrorCode = undefined;
      s.initialRepoFailure = false;
    }));
    try {
      const result = await githubApi.getGithubRepos(state.page + 1);
      if (generation !== repoGeneration) return;
      setState(produce((s) => {
        s.repos = [...s.repos, ...result.repos];
        s.page = result.page;
        s.hasMore = result.hasMore;
        s.loadingMore = false;
      }));
    } catch (err) {
      if (generation !== repoGeneration) return;
      setState(produce((s) => {
        s.error = err instanceof Error ? err.message : String(err);
        s.repoErrorCode = err instanceof ApiError ? err.code : undefined;
        s.loadingMore = false;
      }));
    }
  },

  async disconnect() {
    try {
      await githubApi.disconnectGithub();
      statusGeneration++;
      resetRepos();
      setState('status', state.status ? { ...state.status, connected: false, login: undefined, source: undefined } : null);
    } catch (err) {
      setState('error', err instanceof Error ? err.message : String(err));
    }
  },
};

/** @internal test-only */
export function _resetForTests() {
  statusGeneration++;
  resetRepos();
  setState(produce((s) => {
    Object.assign(s, { ...initialState });
  }));
}
