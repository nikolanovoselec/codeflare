import { Component, createSignal, onMount } from 'solid-js';
import { mdiGithub, mdiCloud } from '@mdi/js';
import OAuthConnectCard from '../connect/OAuthConnectCard';
import { createConnections } from '../../lib/oauth-connections';
import { githubConnectUrl } from '../../api/github';
import { cloudflareConnectUrl } from '../../api/cloudflare';
import { GITHUB_TIERS, CLOUDFLARE_TIERS, type ScopeTier } from '../../lib/token-scopes';

/**
 * Settings "Push & Deploy" accordion. Each provider connects via OAuth ("Connect"
 * → the Worker 302s to the provider → returns connected), reusing the shared
 * OAuthConnectCard + the createConnections data hook (same as Guided Setup). No
 * token paste. Available to every authenticated user, independent of the advanced-
 * gated dashboard repo panel.
 */
const DeployKeysSection: Component = () => {
  const conn = createConnections();
  const [githubTier, setGithubTier] = createSignal<ScopeTier>('recommended');
  const [cfTier, setCfTier] = createSignal<ScopeTier>('recommended');

  onMount(() => { void conn.refresh(); });

  return (
    <>
      <p class="settings-hint type-hint" style={{ 'margin-bottom': 'var(--space-2)' }}>
        Connect your accounts so every session can push code and deploy automatically.
      </p>

      <OAuthConnectCard
        provider="github"
        icon={mdiGithub}
        name="GitHub"
        status={conn.github().status}
        identity={conn.github().identity}
        connectUrl={githubConnectUrl()}
        onDisconnect={() => { void conn.disconnectGithub(); }}
        tierOptions={{ tiers: GITHUB_TIERS, selected: githubTier(), onSelect: (v) => setGithubTier(v) }}
      />

      <OAuthConnectCard
        provider="cloudflare"
        icon={mdiCloud}
        name="Cloudflare"
        status={conn.cloudflare().status}
        identity={conn.cloudflare().identity}
        connectUrl={cloudflareConnectUrl()}
        onDisconnect={() => { void conn.disconnectCloudflare(); }}
        accounts={conn.cloudflare().accounts}
        selectedAccountId={conn.cloudflare().accountId}
        onSelectAccount={(id) => { void conn.selectCloudflareAccount(id); }}
        tierOptions={{ tiers: CLOUDFLARE_TIERS, selected: cfTier(), onSelect: (v) => setCfTier(v) }}
      />

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint type-hint" data-testid="deploy-keys-hint">
          Connections take effect on next session start. Used by git push, gh CLI, and wrangler.
        </span>
      </div>
    </>
  );
};

export default DeployKeysSection;
