import { Component, createSignal, onMount, Show, For } from 'solid-js';
import { mdiGithub, mdiCloudOutline, mdiCheck, mdiAlertCircleOutline } from '@mdi/js';
import Icon from '../Icon';
import Button from '../ui/Button';
import { getDeployKeys, updateDeployKeys } from '../../api/client';
import type { DeployKeysResponse } from '../../api/client';

// GitHub fine-grained PAT template URL with broad scopes pre-filled.
// Repository: contents, administration, workflows, actions, actions_variables,
//   pull_requests, issues, deployments, environments, pages, secrets,
//   statuses, repository_hooks, merge_queues, security_events, custom_properties
// Account: email_addresses, metadata
const GITHUB_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Codeflare&description=Push+%26+deploy+from+Codeflare&expires_in=90'
  + '&contents=write&administration=write&workflows=write&actions=write&actions_variables=write'
  + '&pull_requests=write&issues=write&deployments=write&environments=write&pages=write'
  + '&secrets=write&statuses=write&repository_hooks=write&merge_queues=write'
  + '&security_events=write&custom_properties=write&discussions=write'
  + '&metadata=read&email_addresses=read';

// Cloudflare template URL with full Codeflare-level scopes pre-filled.
// Account: Workers Scripts, KV, Routes, R2, D1, Pages, Containers, Access, API Tokens, Account Settings
// Zone: DNS, Zone read
// Decoded JSON array in CLOUDFLARE_TOKEN_SCOPES below.
const CLOUDFLARE_TOKEN_SCOPES = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'pages', type: 'edit' },
  { key: 'containers', type: 'edit' },
  { key: 'access', type: 'edit' },
  { key: 'access_acct', type: 'edit' },
  { key: 'account_api_tokens', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'zone', type: 'read' },
  { key: 'zone_dns', type: 'edit' },
];
const CLOUDFLARE_TOKEN_URL =
  `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(CLOUDFLARE_TOKEN_SCOPES))}&accountId=%2A&zoneId=all&name=Codeflare`;

interface CloudflareAccount {
  id: string;
  name: string;
}

const DeployKeysSection: Component = () => {
  // GitHub state
  const [githubToken, setGithubToken] = createSignal('');
  const [githubSaving, setGithubSaving] = createSignal(false);
  const [githubMessage, setGithubMessage] = createSignal<string | null>(null);
  const [githubError, setGithubError] = createSignal<string | null>(null);

  // Cloudflare state
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
      .catch(() => { /* keys not loaded */ });
  });

  const handleSaveGithub = async () => {
    if (githubSaving()) return;
    const token = githubToken();
    if (token === '' || token.startsWith('****')) {
      setGithubError('Paste a new token to save.');
      return;
    }
    setGithubSaving(true);
    setGithubMessage(null);
    setGithubError(null);

    try {
      const result = await updateDeployKeys({ githubToken: token });
      setGithubToken(result.githubToken || '');
      setGithubMessage('GitHub connected. Takes effect on next session start.');
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : 'Failed to save GitHub token.');
    } finally {
      setGithubSaving(false);
    }
  };

  const handleDisconnectGithub = async () => {
    if (githubSaving()) return;
    setGithubSaving(true);
    setGithubMessage(null);
    setGithubError(null);

    try {
      await updateDeployKeys({ githubToken: null });
      setGithubToken('');
      setGithubMessage('GitHub disconnected.');
    } catch (error) {
      setGithubError(error instanceof Error ? error.message : 'Failed to disconnect GitHub.');
    } finally {
      setGithubSaving(false);
    }
  };

  const handleSaveCloudflare = async () => {
    if (cfSaving()) return;
    const token = cfToken();
    if (token === '' || token.startsWith('****')) {
      setCfError('Paste a new token to save.');
      return;
    }
    setCfSaving(true);
    setCfMessage(null);
    setCfError(null);

    try {
      const result = await updateDeployKeys({ cloudflareApiToken: token });
      setCfToken(result.cloudflareApiToken || '');
      if (result.cloudflareAccountId) {
        setCfAccountId(result.cloudflareAccountId);
      }
      if (result.cloudflareAccounts && result.cloudflareAccounts.length > 1) {
        setCfAccounts(result.cloudflareAccounts);
        setCfMessage('Multiple Cloudflare accounts found. Please select one below.');
      } else {
        setCfAccounts([]);
        setCfMessage('Cloudflare connected. Takes effect on next session start.');
      }
    } catch (error) {
      setCfError(error instanceof Error ? error.message : 'Failed to save Cloudflare token.');
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
      setCfMessage('Cloudflare connected. Takes effect on next session start.');
    } catch (error) {
      setCfError(error instanceof Error ? error.message : 'Failed to select account.');
    } finally {
      setCfSaving(false);
    }
  };

  const handleDisconnectCloudflare = async () => {
    if (cfSaving()) return;
    setCfSaving(true);
    setCfMessage(null);
    setCfError(null);

    try {
      await updateDeployKeys({ cloudflareApiToken: null });
      setCfToken('');
      setCfAccountId(undefined);
      setCfAccounts([]);
      setCfMessage('Cloudflare disconnected.');
    } catch (error) {
      setCfError(error instanceof Error ? error.message : 'Failed to disconnect Cloudflare.');
    } finally {
      setCfSaving(false);
    }
  };

  return (
    <>
      {/* GitHub */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiGithub} size={16} />
          <h3 class="settings-section-title">GitHub</h3>
          <Show when={githubConnected()}>
            <span class="deploy-status deploy-status--connected" data-testid="deploy-github-status">
              <Icon path={mdiCheck} size={14} /> Connected
            </span>
          </Show>
        </div>

        <Show when={!githubConnected()}>
          <div class="deploy-instructions" data-testid="deploy-github-instructions">
            <ol>
              <li>Click "Connect GitHub" — a new tab will open with permissions pre-selected</li>
              <li>Under Repository access, select <strong>"All repositories"</strong></li>
              <li>Scroll down and click the green <strong>"Generate token"</strong> button</li>
              <li>Copy the token that appears (you'll only see it once)</li>
              <li>Paste it below and click Save</li>
            </ol>
          </div>
          <div class="setting-row setting-row--column-gap">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(GITHUB_TOKEN_URL, '_blank')}
              data-testid="deploy-github-connect"
            >
              Connect GitHub
            </Button>
          </div>
        </Show>

        <div class="setting-row setting-row--column-gap">
          <Show when={githubConnected()}>
            <div class="deploy-connected-row">
              <span class="deploy-masked-token" data-testid="deploy-github-masked">{githubToken()}</span>
              <Button
                variant="ghost"
                size="sm"
                loading={githubSaving()}
                onClick={() => { void handleDisconnectGithub(); }}
                data-testid="deploy-github-disconnect"
              >
                Disconnect
              </Button>
            </div>
          </Show>
          <Show when={!githubConnected()}>
            <input
              type="password"
              id="settings-deploy-github-token"
              class="llm-key-input"
              value={githubToken()}
              placeholder="github_pat_..."
              autocomplete="off"
              onInput={(e) => setGithubToken(e.currentTarget.value)}
              data-testid="deploy-github-token-input"
            />
            <Button
              variant="secondary"
              size="sm"
              loading={githubSaving()}
              onClick={() => { void handleSaveGithub(); }}
              data-testid="deploy-github-save"
            >
              Save
            </Button>
          </Show>
          <Show when={githubMessage()}>
            {(message) => (
              <span class="settings-hint" data-testid="deploy-github-success">{message()}</span>
            )}
          </Show>
          <Show when={githubError()}>
            {(error) => (
              <span class="settings-error" data-testid="deploy-github-error">
                <Icon path={mdiAlertCircleOutline} size={14} /> {error()}
              </span>
            )}
          </Show>
        </div>
      </section>

      {/* Cloudflare */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiCloudOutline} size={16} />
          <h3 class="settings-section-title">Cloudflare</h3>
          <Show when={cfConnected()}>
            <span class="deploy-status deploy-status--connected" data-testid="deploy-cf-status">
              <Icon path={mdiCheck} size={14} /> Connected
            </span>
          </Show>
        </div>

        <Show when={!cfConnected()}>
          <div class="deploy-instructions" data-testid="deploy-cf-instructions">
            <ol>
              <li>Click "Connect Cloudflare" — a new tab will open with permissions pre-selected</li>
              <li>Under Account Resources, select your account (or "All accounts")</li>
              <li>Click the blue <strong>"Continue to summary"</strong> button at the bottom</li>
              <li>Click <strong>"Create Token"</strong></li>
              <li>Copy the token that appears (you'll only see it once)</li>
              <li>Paste it below and click Save</li>
            </ol>
          </div>
          <div class="setting-row setting-row--column-gap">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(CLOUDFLARE_TOKEN_URL, '_blank')}
              data-testid="deploy-cf-connect"
            >
              Connect Cloudflare
            </Button>
          </div>
        </Show>

        <div class="setting-row setting-row--column-gap">
          <Show when={cfConnected()}>
            <div class="deploy-connected-row">
              <span class="deploy-masked-token" data-testid="deploy-cf-masked">{cfToken()}</span>
              <Show when={cfAccountId()}>
                <span class="deploy-account-id" data-testid="deploy-cf-account-id">
                  Account: {cfAccountId()}
                </span>
              </Show>
              <Button
                variant="ghost"
                size="sm"
                loading={cfSaving()}
                onClick={() => { void handleDisconnectCloudflare(); }}
                data-testid="deploy-cf-disconnect"
              >
                Disconnect
              </Button>
            </div>
          </Show>
          <Show when={!cfConnected()}>
            <input
              type="password"
              id="settings-deploy-cf-token"
              class="llm-key-input"
              value={cfToken()}
              placeholder="Cloudflare API token..."
              autocomplete="off"
              onInput={(e) => setCfToken(e.currentTarget.value)}
              data-testid="deploy-cf-token-input"
            />
            <Button
              variant="secondary"
              size="sm"
              loading={cfSaving()}
              onClick={() => { void handleSaveCloudflare(); }}
              data-testid="deploy-cf-save"
            >
              Save
            </Button>
          </Show>

          {/* Account selection dropdown (multiple accounts) */}
          <Show when={cfAccounts().length > 1}>
            <div class="deploy-account-select" data-testid="deploy-cf-account-select">
              <label for="deploy-cf-account-dropdown">Select account:</label>
              <select
                id="deploy-cf-account-dropdown"
                class="deploy-account-dropdown"
                value={cfAccountId() || ''}
                onChange={(e) => { const val = e.currentTarget.value; if (val) void handleSelectAccount(val); }}
                data-testid="deploy-cf-account-dropdown"
              >
                <option value="" disabled>Choose an account...</option>
                <For each={cfAccounts()}>
                  {(account) => (
                    <option value={account.id}>{account.name}</option>
                  )}
                </For>
              </select>
            </div>
          </Show>

          <Show when={cfMessage()}>
            {(message) => (
              <span class="settings-hint" data-testid="deploy-cf-success">{message()}</span>
            )}
          </Show>
          <Show when={cfError()}>
            {(error) => (
              <span class="settings-error" data-testid="deploy-cf-error">
                <Icon path={mdiAlertCircleOutline} size={14} /> {error()}
              </span>
            )}
          </Show>
        </div>
      </section>

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint" data-testid="deploy-keys-hint">
          Tokens take effect on next session start. Used by git push, gh CLI, and wrangler.
        </span>
      </div>
    </>
  );
};

export default DeployKeysSection;
