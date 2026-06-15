import { Component, Show } from 'solid-js';
import { mdiGithub } from '@mdi/js';
import Icon from '../Icon';
import { githubStore } from '../../stores/github';

// Shows the connected login and a Disconnect button. Disconnect calls the
// store action (which POSTs /api/github/disconnect and flips to the
// not-connected state).
const ConnectedHeader: Component = () => {
  return (
    <div class="github-connected-header" data-testid="github-connected-header">
      <Icon path={mdiGithub} size={18} class="github-connected-icon" />
      <span class="github-connected-login" data-testid="github-connected-login">
        <Show when={githubStore.login} fallback="Connected">
          {githubStore.login}
        </Show>
      </span>
      <button
        type="button"
        class="github-disconnect-btn"
        data-testid="github-disconnect-btn"
        onClick={() => void githubStore.disconnect()}
      >
        Disconnect
      </button>
    </div>
  );
};

export default ConnectedHeader;
