import { Component, Show, onMount, createSignal } from 'solid-js';
import { githubStore } from '../../stores/github';
import ConnectCard from './ConnectCard';
import ConnectedHeader from './ConnectedHeader';
import RepoSearch from './RepoSearch';
import RepoList from './RepoList';
import '../../styles/github-panel.css';

// Maps the ?github= return values (other than `connected`) to a
// non-blocking error message.
const RETURN_ERRORS: Record<string, string> = {
  denied: 'GitHub authorization was denied.',
  expired: 'The GitHub authorization request expired. Please try again.',
  error: 'Something went wrong connecting to GitHub. Please try again.',
  unavailable: 'GitHub connect is temporarily unavailable. Please try again later.',
};

// Container for the GitHub panel. Renders nothing when GitHub is not
// enabled (or status has not yet loaded). When connected, composes the
// connected header + search + repo list; otherwise the connect card.
const GitHubPanel: Component = () => {
  const [returnError, setReturnError] = createSignal<string | null>(null);

  onMount(() => {
    // Handle the OAuth return: ?github=connected|denied|expired|error|unavailable.
    const params = new URLSearchParams(window.location.search);
    const github = params.get('github');
    if (github) {
      // Strip the query param without a reload (mirrors SubscribePage).
      window.history.replaceState({}, '', window.location.pathname);
      if (github !== 'connected' && RETURN_ERRORS[github]) {
        setReturnError(RETURN_ERRORS[github]);
      }
    }
    void githubStore.loadStatus();
  });

  return (
    <Show when={githubStore.enabled}>
      <section class="github-panel" data-testid="github-panel">
        <div class="github-panel-header">
          <h2 class="github-panel-title">GitHub</h2>
        </div>

        <Show when={returnError()}>
          <div class="github-return-error" data-testid="github-return-error" role="status" aria-live="polite">
            {returnError()}
          </div>
        </Show>

        <Show
          when={githubStore.connected}
          fallback={<ConnectCard />}
        >
          <ConnectedHeader />
          <RepoSearch />
          <RepoList />
        </Show>
      </section>
    </Show>
  );
};

export default GitHubPanel;
