import { Component, For, Show } from 'solid-js';
import { githubStore } from '../../stores/github';
import RepoRow from './RepoRow';

// Renders the filtered repo list with loading / empty states and a
// "Load more" affordance gated on hasMore. Pure composition over RepoRow.
const RepoList: Component = () => {
  return (
    <div class="github-repo-list" data-testid="github-repo-list">
      <Show when={githubStore.loading}>
        <div class="github-loading" data-testid="github-loading">
          <div class="github-loading-spinner" />
          <span>Loading repositories...</span>
        </div>
      </Show>

      <Show when={!githubStore.loading && githubStore.error}>
        <div class="github-error" data-testid="github-error">
          <p>{githubStore.error}</p>
          <button
            type="button"
            class="github-retry-btn"
            data-testid="github-retry-btn"
            onClick={() => void githubStore.loadRepos()}
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!githubStore.loading && !githubStore.error && githubStore.repos.length === 0}>
        <div class="github-empty" data-testid="github-empty" data-empty-state="no-repositories">
          You currently have no repositories, start a session and create one.
        </div>
      </Show>

      <Show when={!githubStore.loading && !githubStore.error && githubStore.repos.length > 0 && githubStore.filteredRepos.length === 0}>
        <div class="github-empty" data-testid="github-empty" data-empty-state="no-search-results">
          No repositories found.
        </div>
      </Show>

      <Show when={!githubStore.loading && !githubStore.error && githubStore.filteredRepos.length > 0}>
        <div class="github-repo-rows" data-testid="github-repo-rows">
          <For each={githubStore.filteredRepos}>
            {(repo) => <RepoRow repo={repo} />}
          </For>
        </div>

        <Show when={githubStore.hasMore}>
          <button
            type="button"
            class="github-load-more-btn"
            data-testid="github-load-more-btn"
            disabled={githubStore.loadingMore}
            onClick={() => void githubStore.loadMore()}
          >
            {githubStore.loadingMore ? 'Loading...' : 'Load more'}
          </button>
        </Show>
      </Show>
    </div>
  );
};

export default RepoList;
