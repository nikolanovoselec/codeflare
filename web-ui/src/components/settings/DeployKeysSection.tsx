import { Component, createSignal, onMount, Show, For } from 'solid-js';
import { getDeployKeys, updateDeployKeys } from '../../api/client';
import type { DeployKeysResponse } from '../../api/client';
import ProviderRow from './ProviderRow';
import { GitHubIcon, CloudflareIcon } from './BrandIcons';
import { getGithubTokenUrl, GITHUB_TIERS, CLOUDFLARE_TOKEN_PAGE, SCOPES_DOCS_URL, CLOUDFLARE_BRAND_COLOR } from '../../lib/token-scopes';

interface CloudflareAccount {
  id: string;
  name: string;
}

const DeployKeysSection: Component = () => {
  const [githubToken, setGithubToken] = createSignal('');
  const [githubSaving, setGithubSaving] = createSignal(false);
  const [githubMessage, setGithubMessage] = createSignal<string | null>(null);
  const [githubError, setGithubError] = createSignal<string | null>(null);

  const [cfToken, setCfToken] = createSignal('');
  const [cfAccountId, setCfAccountId] = createSignal<string | undefined>();
  const [cfAccounts, setCfAccounts] = createSignal<CloudflareAccount[]>([]);
  const [cfSaving, setCfSaving] = createSignal(false);
  const [cfMessage, setCfMessage] = createSignal<string | null>(null);
  const [cfError, setCfError] = createSignal<string | null>(null);

  const githubConnected = () => githubToken().startsWith('****');
  const cfConnected = () => cfToken().startsWith('****');

  onMount(() => {
    getDeployKeys()
      .then((keys: DeployKeysResponse) => {
        if (keys.githubToken) setGithubToken(keys.githubToken);
        if (keys.cloudflareApiToken) setCfToken(keys.cloudflareApiToken);
        if (keys.cloudflareAccountId) setCfAccountId(keys.cloudflareAccountId);
      })
      .catch(() => {});
  });

  const handleSaveGithub = async (token: string) => {
    setGithubSaving(true);
    setGithubMessage(null);
    setGithubError(null);
    try {
      const result = await updateDeployKeys({ githubToken: token });
      setGithubToken(result.githubToken || '');
      setGithubMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setGithubSaving(false);
    }
  };

  const handleDisconnectGithub = async () => {
    setGithubSaving(true);
    setGithubMessage(null);
    setGithubError(null);
    try {
      await updateDeployKeys({ githubToken: null });
      setGithubToken('');
      setGithubMessage('Disconnected.');
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setGithubSaving(false);
    }
  };

  const handleSaveCloudflare = async (token: string) => {
    setCfSaving(true);
    setCfMessage(null);
    setCfError(null);
    try {
      const result = await updateDeployKeys({ cloudflareApiToken: token });
      setCfToken(result.cloudflareApiToken || '');
      if (result.cloudflareAccountId) setCfAccountId(result.cloudflareAccountId);
      if (result.cloudflareAccounts && result.cloudflareAccounts.length > 1) {
        setCfAccounts(result.cloudflareAccounts);
        setCfMessage('Select your account below.');
      } else {
        setCfAccounts([]);
        setCfMessage('Connected. Takes effect on next session.');
      }
    } catch (error) {
      setCfError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setCfSaving(false);
    }
  };

  const handleSelectAccount = async (accountId: string) => {
    setCfSaving(true);
    setCfError(null);
    try {
      await updateDeployKeys({ cloudflareAccountId: accountId });
      setCfAccountId(accountId);
      setCfAccounts([]);
      setCfMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setCfError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setCfSaving(false);
    }
  };

  const handleDisconnectCloudflare = async () => {
    setCfSaving(true);
    setCfMessage(null);
    setCfError(null);
    try {
      await updateDeployKeys({ cloudflareApiToken: null });
      setCfToken('');
      setCfAccountId(undefined);
      setCfAccounts([]);
      setCfMessage('Disconnected.');
    } catch (error) {
      setCfError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setCfSaving(false);
    }
  };

  return (
    <>
      <p class="settings-hint" style={{ "margin-bottom": "var(--space-2)" }}>
        Connect your accounts so every session can push code and deploy automatically.
      </p>
      <ol class="provider-steps">
        <li>Click a button below to open the provider</li>
        <li>Scroll down, confirm and create the token</li>
        <li>Come back here, paste the token and save</li>
      </ol>

      <ProviderRow
        icon={GitHubIcon}
        name="GitHub"
        brandColor="#24292f"
        placeholder="github_pat_..."
        connected={githubConnected()}
        onSave={(token) => { void handleSaveGithub(token); }}
        onDisconnect={() => { void handleDisconnectGithub(); }}
        saving={githubSaving()}
        disconnecting={githubSaving()}
        message={githubMessage()}
        error={githubError()}
        testId="deploy-github-row"
        tierOptions={{
          tiers: GITHUB_TIERS,
          getUrl: getGithubTokenUrl,
          docsUrl: SCOPES_DOCS_URL,
        }}
      />

      <ProviderRow
        icon={CloudflareIcon}
        name="Cloudflare"
        brandColor="#f38020"
        externalUrl={CLOUDFLARE_TOKEN_PAGE}
        externalLabel="Open Cloudflare"
        placeholder="Cloudflare API token..."
        connected={cfConnected()}
        onSave={(token) => { void handleSaveCloudflare(token); }}
        onDisconnect={() => { void handleDisconnectCloudflare(); }}
        saving={cfSaving()}
        disconnecting={cfSaving()}
        message={cfMessage()}
        error={cfError()}
        testId="deploy-cf-row"
        instructions={<>Press <span style={{color: CLOUDFLARE_BRAND_COLOR, "font-weight": "600"}}>"Open Cloudflare"</span> below, click <span style={{color: CLOUDFLARE_BRAND_COLOR, "font-weight": "600"}}>"Create Token"</span>, then use the <span style={{color: CLOUDFLARE_BRAND_COLOR, "font-weight": "600"}}>"Edit Cloudflare Workers"</span> template. Select your account and zones, then create the token.</>}
      />

      {/* Cloudflare multi-account dropdown */}
      <Show when={cfAccounts().length > 1}>
        <div class="provider-row-expand" data-testid="deploy-cf-account-select">
          <select
            class="provider-row-token-input"
            value={cfAccountId() || ''}
            onChange={(e) => { const val = e.currentTarget.value; if (val) void handleSelectAccount(val); }}
            data-testid="deploy-cf-account-dropdown"
          >
            <option value="" disabled>Choose an account...</option>
            <For each={cfAccounts()}>
              {(account) => <option value={account.id}>{account.name}</option>}
            </For>
          </select>
        </div>
      </Show>

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint" data-testid="deploy-keys-hint">
          Tokens take effect on next session start. Used by git push, gh CLI, and wrangler.
        </span>
      </div>
    </>
  );
};

export default DeployKeysSection;
