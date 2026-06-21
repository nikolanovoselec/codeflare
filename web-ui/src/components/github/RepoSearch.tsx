import { Component } from 'solid-js';
import { githubStore } from '../../stores/github';

interface RepoSearchProps {
  /** Mobile: the parent grabs the input so it can focus it synchronously inside
      the magnify-toggle tap handler — iOS Safari only opens the on-screen keyboard
      on a synchronous focus() within the user gesture (REQ-GITHUB-011). */
  inputRef?: (el: HTMLInputElement) => void;
}

// Search input bound to the store's searchQuery signal. Filtering happens
// client-side over already-loaded repos (githubStore.filteredRepos).
const RepoSearch: Component<RepoSearchProps> = (props) => {
  return (
    <div class="github-search-bar">
      <input
        ref={props.inputRef}
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
