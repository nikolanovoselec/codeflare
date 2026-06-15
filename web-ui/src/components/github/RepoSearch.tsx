import { Component } from 'solid-js';
import { githubStore } from '../../stores/github';

// Search input bound to the store's searchQuery signal. Filtering happens
// client-side over already-loaded repos (githubStore.filteredRepos).
const RepoSearch: Component = () => {
  return (
    <div class="github-search-bar">
      <input
        type="text"
        class="github-search-input"
        data-testid="github-search-input"
        placeholder="Search repositories..."
        value={githubStore.searchQuery}
        onInput={(e) => githubStore.setSearchQuery((e.target as HTMLInputElement).value)}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
      />
    </div>
  );
};

export default RepoSearch;
