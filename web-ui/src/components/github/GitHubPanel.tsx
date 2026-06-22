import { Component, Show, onMount, createSignal } from 'solid-js';
import { mdiFlipVertical } from '@mdi/js';
import { githubStore } from '../../stores/github';
import { isTouchDevice, scrollFieldAboveKeyboard } from '../../lib/mobile';
import ConnectCard from './ConnectCard';
import ConnectedHeader from './ConnectedHeader';
import RepoSearch from './RepoSearch';
import RepoList from './RepoList';
import IconButton from '../ui/IconButton';
import '../../styles/github-panel.css';

interface GitHubPanelProps {
  /** When provided, renders a mobile-only flip control in the header that
      swaps this panel for the R2 storage panel. */
  onFlip?: () => void;
}

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
const GitHubPanel: Component<GitHubPanelProps> = (props) => {
  const [returnError, setReturnError] = createSignal<string | null>(null);

  // REQ-GITHUB-011: the repository search is disclosed on demand on EVERY breakpoint
  // — hidden behind a magnify toggle so the list keeps its full whole-row viewport,
  // revealed (and focused) on tap/click, hidden again on a second tap. Only the
  // on-screen-keyboard scroll-into-view is touch-specific.
  const touch = isTouchDevice();
  const [searchOpen, setSearchOpen] = createSignal(false);
  let searchInput: HTMLInputElement | undefined;
  const toggleSearch = () => {
    const next = !searchOpen();
    setSearchOpen(next);
    if (next) {
      // The input mounts synchronously when searchOpen flips; focus it in the same
      // tap handler so iOS Safari opens the on-screen keyboard (it only does so on a
      // synchronous focus() within the user gesture).
      searchInput?.focus();
      // On touch only, scroll it above the on-screen keyboard once it animates in —
      // the panel sits low on mobile, so the keyboard would otherwise cover the field.
      if (touch && searchInput) scrollFieldAboveKeyboard(searchInput);
    } else {
      // Closing clears the filter so a hidden search box never silently narrows the list.
      githubStore.setSearchQuery('');
    }
  };

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
    // Only load status if it has not already been loaded. The Dashboard now kicks
    // off loadStatus() on its own mount (to break the enabled-gates-the-panel
    // deadlock), so by the time this panel mounts status is already loaded; loading
    // it again would fire a second /status (+ /repos for a connected user) whose
    // failure could clobber the first success and hide the loaded rows behind an
    // error. Standalone use (no prior load) still loads here. (REQ-GITHUB-007)
    if (!githubStore.statusLoaded) void githubStore.loadStatus();
  });

  return (
    <Show when={githubStore.enabled}>
      <section class="github-panel" data-testid="github-panel">
        <div class="github-panel-header">
          <h2 class="github-panel-title">GitHub Browser</h2>
          <Show when={props.onFlip}>
            <IconButton
              icon={mdiFlipVertical}
              label="Show storage"
              onClick={() => props.onFlip!()}
              class="github-flip-btn"
              testId="github-flip-btn"
            />
          </Show>
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
          <ConnectedHeader
            onToggleSearch={toggleSearch}
            searchOpen={searchOpen()}
          />
          <Show when={searchOpen()}>
            <RepoSearch inputRef={(el) => (searchInput = el)} />
          </Show>
          <RepoList />
        </Show>
      </section>
    </Show>
  );
};

export default GitHubPanel;
