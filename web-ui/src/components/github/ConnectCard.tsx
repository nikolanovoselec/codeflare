import { Component } from 'solid-js';
import { mdiGithub } from '@mdi/js';
import Icon from '../Icon';
import { githubConnectUrl } from '../../api/github';

// The "Connect GitHub" affordance. Connect is a top-level browser
// navigation (the Worker 302s to GitHub and returns to /app/?github=connected),
// so this assigns window.location.href rather than calling fetch.
const ConnectCard: Component = () => {
  const connect = () => {
    window.location.href = githubConnectUrl();
  };

  return (
    <div class="github-connect-card" data-testid="github-connect-card">
      <Icon path={mdiGithub} size={32} class="github-connect-icon" />
      <p class="github-connect-text">Connect your GitHub account to browse your repositories.</p>
      <button
        type="button"
        class="github-connect-btn"
        data-testid="github-connect-btn"
        data-href={githubConnectUrl()}
        onClick={connect}
      >
        <Icon path={mdiGithub} size={16} />
        <span>Connect GitHub</span>
      </button>
    </div>
  );
};

export default ConnectCard;
