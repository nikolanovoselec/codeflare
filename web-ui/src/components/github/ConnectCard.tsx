import { Component, Show, createSignal } from 'solid-js';
import { mdiGithub } from '@mdi/js';
import Icon from '../Icon';
import ScopeTierPicker from '../connect/ScopeTierPicker';
import { githubConnectUrl } from '../../api/github';
import { GITHUB_TIERS, type ScopeTier } from '../../lib/token-scopes';
import { sessionStore } from '../../stores/session';

// The "Connect GitHub" affordance in the dashboard repo panel. Connect is a
// top-level browser navigation (the Worker 302s to GitHub and returns to
// /app/?github=connected), so this assigns window.location.href rather than
// calling fetch. In non-enterprise modes the user picks a scope level, appended
// as ?tier=; enterprise uses an admin-configured GitHub App whose fixed
// permissions ignore the tier, so the picker is hidden and the URL stays bare.
const ConnectCard: Component = () => {
  const [tier, setTier] = createSignal<ScopeTier>('recommended');
  const href = () => {
    const base = githubConnectUrl();
    if (sessionStore.enterpriseMode) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}tier=${encodeURIComponent(tier())}`;
  };

  return (
    <div class="github-connect-card" data-testid="github-connect-card">
      <Icon path={mdiGithub} size={32} class="github-connect-icon" />
      <p class="github-connect-text">Connect your GitHub account to browse your repositories.</p>
      <Show when={!sessionStore.enterpriseMode}>
        <ScopeTierPicker provider="github" tiers={GITHUB_TIERS} selected={tier()} onSelect={(t) => setTier(t)} />
      </Show>
      <button
        type="button"
        class="github-connect-btn"
        data-testid="github-connect-btn"
        data-href={href()}
        onClick={() => { window.location.href = href(); }}
      >
        <Icon path={mdiGithub} size={16} />
        <span>Connect GitHub</span>
      </button>
    </div>
  );
};

export default ConnectCard;
