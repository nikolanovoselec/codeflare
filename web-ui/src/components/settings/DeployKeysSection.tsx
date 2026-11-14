import { Component, Show, createSignal, onMount } from 'solid-js';
import { mdiCloud } from '@mdi/js';
import OAuthConnectCard from '../connect/OAuthConnectCard';
import { createConnections } from '../../lib/oauth-connections';
import { cloudflareConnectUrl } from '../../api/cloudflare';
import { CLOUDFLARE_TIERS, type ScopeTier } from '../../lib/token-scopes';

/**
 * Settings Integrations reuses the compact OAuth card and shared connection hook.
 * A configured client makes Cloudflare available; the user still chooses Connect.
 */
const DeployKeysSection: Component = () => {
  const conn = createConnections();
  const [cfTier, setCfTier] = createSignal<ScopeTier>('recommended');

  onMount(() => { void conn.refreshCloudflare(); });

  return (
    <>
      <Show when={conn.cloudflare().availability === 'loading'}>
        <p class="settings-hint type-hint" role="status">Checking available integrations…</p>
      </Show>
      <Show when={conn.cloudflare().availability === 'error'}>
        <p class="settings-hint type-hint" role="alert">Integrations could not be loaded. Reload to try again.</p>
      </Show>
      <Show when={conn.cloudflare().availability === 'unconfigured'}>
        <p class="settings-hint type-hint">No integrations are configured for this environment.</p>
      </Show>
      <Show when={conn.cloudflare().availability === 'available'}>
        <p class="settings-hint type-hint" style={{ 'margin-bottom': 'var(--space-2)' }}>
          Connect your Cloudflare account to manage resources and deploy from your sessions.
        </p>

        <OAuthConnectCard
          compact
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
            Connections take effect on next session start. Used by Cloudflare tools such as wrangler.
          </span>
        </div>
      </Show>
    </>
  );
};

export default DeployKeysSection;
