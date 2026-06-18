import { Component, Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiGithub } from '@mdi/js';
import Icon from '../Icon';
import TierChooserDialog from '../connect/TierChooserDialog';
import { githubConnectUrl } from '../../api/github';
import { GITHUB_TIERS, type ScopeTier } from '../../lib/token-scopes';
import { sessionStore } from '../../stores/session';

// The "Connect GitHub" affordance in the dashboard repo panel. Connect is a
// top-level browser navigation (the Worker 302s to GitHub and returns to
// /app/?github=connected). In non-enterprise modes the button opens a tier
// chooser (a popover on desktop, a bottom sheet on mobile — the "+ New Session"
// pattern); picking a level connects with ?tier=. Enterprise uses an admin-
// configured GitHub App whose fixed permissions ignore the tier, so the button
// connects directly with a bare URL and no dialog.
const ConnectCard: Component = () => {
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [tier, setTier] = createSignal<ScopeTier>('recommended');
  const [btnRef, setBtnRef] = createSignal<HTMLButtonElement>();

  const connect = (t?: ScopeTier) => {
    const base = githubConnectUrl();
    if (sessionStore.enterpriseMode || !t) {
      window.location.href = base;
      return;
    }
    const sep = base.includes('?') ? '&' : '?';
    window.location.href = `${base}${sep}tier=${encodeURIComponent(t)}`;
  };

  const onButtonClick = () => {
    if (sessionStore.enterpriseMode) {
      connect();
      return;
    }
    setDialogOpen(true);
  };

  const onPick = (t: ScopeTier) => {
    setTier(t);
    setDialogOpen(false);
    connect(t);
  };

  return (
    <div class="github-connect-card" data-testid="github-connect-card">
      <Icon path={mdiGithub} size={32} class="github-connect-icon" />
      <p class="github-connect-text">Connect your GitHub account to browse your repositories.</p>
      <button
        type="button"
        ref={setBtnRef}
        class="github-connect-btn"
        data-testid="github-connect-btn"
        data-href={githubConnectUrl()}
        onClick={onButtonClick}
      >
        <Icon path={mdiGithub} size={16} />
        <span>Connect GitHub</span>
      </button>
      {/* Portal escapes .dashboard-panel's backdrop-filter, which otherwise
          becomes the containing block for the dialog's position:fixed (mirrors
          how Dashboard.tsx mounts CreateSessionDialog — the "+ New Session"
          picker). Without it the popover/bottom-sheet positions against the
          panel box instead of the viewport. */}
      <Show when={!sessionStore.enterpriseMode}>
        <Portal>
          <TierChooserDialog
            open={dialogOpen()}
            onClose={() => setDialogOpen(false)}
            anchorRef={btnRef()}
            provider="github"
            tiers={GITHUB_TIERS}
            selected={tier()}
            onPick={onPick}
          />
        </Portal>
      </Show>
    </div>
  );
};

export default ConnectCard;
