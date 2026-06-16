import { createStore, produce } from 'solid-js/store';
import * as githubApi from '../api/github';
import type { GithubStatus, GithubRepo } from '../api/github';

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
  searchQuery: '',
};

const [state, setState] = createStore<GithubState>({ ...initialState });

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
    setState('error', null);
    try {
      const status = await githubApi.getGithubStatus();
      setState(produce((s) => {
        s.status = status;
        s.statusLoaded = true;
      }));
      // Auto-load the first page of repos once we know we're connected.
      if (status.enabled && status.connected) {
        await githubStore.loadRepos();
      }
    } catch (err) {
      setState(produce((s) => {
        s.statusLoaded = true;
        s.error = err instanceof Error ? err.message : String(err);
      }));
    }
  },

  // Load the first page (resets the list). Used on initial connect.
  async loadRepos() {
    setState(produce((s) => {
      s.loading = true;
      s.error = null;
    }));
    try {
      const result = await githubApi.getGithubRepos(1);
      setState(produce((s) => {
        s.repos = result.repos;
        s.page = result.page;
        s.hasMore = result.hasMore;
        s.loading = false;
      }));
    } catch (err) {
      setState(produce((s) => {
        s.error = err instanceof Error ? err.message : String(err);
        s.loading = false;
      }));
    }
  },

  // Fetch the next page and append (pagination via hasMore).
  async loadMore() {
    if (!state.hasMore || state.loadingMore || state.loading) return;
    setState(produce((s) => {
      s.loadingMore = true;
      s.error = null;
    }));
    try {
      const result = await githubApi.getGithubRepos(state.page + 1);
      setState(produce((s) => {
        s.repos = [...s.repos, ...result.repos];
        s.page = result.page;
        s.hasMore = result.hasMore;
        s.loadingMore = false;
      }));
    } catch (err) {
      setState(produce((s) => {
        s.error = err instanceof Error ? err.message : String(err);
        s.loadingMore = false;
      }));
    }
  },

  async disconnect() {
    try {
      await githubApi.disconnectGithub();
      setState(produce((s) => {
        // Flip to the not-connected state and clear loaded repos.
        s.status = s.status ? { ...s.status, connected: false, login: undefined, source: undefined } : s.status;
        s.repos = [];
        s.page = 0;
        s.hasMore = false;
        s.searchQuery = '';
        s.error = null;
      }));
    } catch (err) {
      setState('error', err instanceof Error ? err.message : String(err));
    }
  },
};

/** @internal test-only */
export function _resetForTests() {
  setState(produce((s) => {
    Object.assign(s, { ...initialState });
  }));
}
