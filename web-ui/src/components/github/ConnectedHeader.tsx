import { Component, Show } from 'solid-js';
import { mdiGithub, mdiSync, mdiConnection, mdiMagnify } from '@mdi/js';
import Icon from '../Icon';
import IconButton from '../ui/IconButton';
import { githubStore } from '../../stores/github';

interface ConnectedHeaderProps {
  /** Mobile only (REQ-GITHUB-011): when provided, a magnify control renders to the
      left of Refresh and toggles the search bar's visibility. Absent on desktop,
      where the search bar is always shown. */
  onToggleSearch?: () => void;
  /** Reflects the search bar's open state on the magnify toggle. */
  searchOpen?: boolean;
}

// Shows the connected login (linking out to the user's GitHub page), a Refresh
// control that reloads the repo list, and an icon Disconnect control. Disconnect
// calls the store action (POSTs /api/github/disconnect, flips to not-connected).
const ConnectedHeader: Component<ConnectedHeaderProps> = (props) => {
  return (
    <div class="github-connected-header" data-testid="github-connected-header">
      <Icon path={mdiGithub} size={18} class="github-connected-icon" />
      <Show
        when={githubStore.login}
        fallback={
          <span class="github-connected-login" data-testid="github-connected-login">
            Connected
          </span>
        }
      >
        {(login) => (
          <a
            class="github-connected-login"
            data-testid="github-connected-login"
            href={`https://github.com/${login()}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {login()}
          </a>
        )}
      </Show>
      <div class="github-connected-actions">
        <Show when={props.onToggleSearch}>
          <IconButton
            icon={mdiMagnify}
            label="Search repositories"
            active={props.searchOpen}
            onClick={() => props.onToggleSearch!()}
            testId="github-search-toggle-btn"
          />
        </Show>
        <IconButton
          icon={mdiSync}
          label="Refresh repositories"
          onClick={() => void githubStore.loadRepos()}
          disabled={githubStore.loading}
          spinning={githubStore.loading}
          testId="github-refresh-btn"
        />
        <IconButton
          icon={mdiConnection}
          label="Disconnect GitHub"
          onClick={() => void githubStore.disconnect()}
          testId="github-disconnect-btn"
        />
      </div>
    </div>
  );
};

export default ConnectedHeader;
