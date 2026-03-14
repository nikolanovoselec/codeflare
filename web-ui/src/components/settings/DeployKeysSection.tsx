import { Component, createSignal, onMount } from 'solid-js';
import { getDeployKeys, updateDeployKeys } from '../../api/client';
import type { DeployKeysResponse } from '../../api/client';
import ProviderRow from './ProviderRow';
import ConnectProviderModal from './ConnectProviderModal';
import type { ProviderConfig } from './ConnectProviderModal';
import { GitHubIcon, CloudflareIcon } from './BrandIcons';

// GitHub fine-grained PAT template URL with broad scopes pre-filled.
const GITHUB_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Codeflare&description=Push+%26+deploy+from+Codeflare&expires_in=90'
  + '&contents=write&administration=write&workflows=write&actions=write&actions_variables=write'
  + '&pull_requests=write&issues=write&deployments=write&environments=write&pages=write'
  + '&secrets=write&statuses=write&repository_hooks=write&merge_queues=write'
  + '&security_events=write&custom_properties=write&discussions=write'
  + '&metadata=read&email_addresses=read';

// Cloudflare template URL with full Codeflare-level scopes pre-filled.
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

const GITHUB_PROVIDER: ProviderConfig = {
  id: 'github',
  name: 'GitHub',
  icon: GitHubIcon,
  brandColor: '#24292f',
  externalUrl: GITHUB_TOKEN_URL,
  externalLabel: 'Open GitHub',
  placeholder: 'github_pat_...',
  instructions: [
    'Click "Open GitHub" to create a token with pre-selected permissions',
    'Click the green "Generate token" button and copy it',
    'Paste the token below and click Save',
  ],
};

const CLOUDFLARE_PROVIDER: ProviderConfig = {
  id: 'cloudflare',
  name: 'Cloudflare',
  icon: CloudflareIcon,
  brandColor: '#f38020',
  externalUrl: CLOUDFLARE_TOKEN_URL,
  externalLabel: 'Open Cloudflare',
  placeholder: 'Cloudflare API token...',
  instructions: [
    'Click "Open Cloudflare" to create a token with pre-selected permissions',
    'Click "Continue to summary" then "Create Token" and copy it',
    'Paste the token below and click Save',
  ],
};

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

  // Modal state
  const [modalProvider, setModalProvider] = createSignal<string | null>(null);

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

  const handleSaveGithub = async (token: string) => {
    if (githubSaving()) return;
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

  const handleSaveCloudflare = async (token: string) => {
    if (cfSaving()) return;
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
        setCfMessage('Multiple accounts found. Please select one.');
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
      <ProviderRow
        icon={GitHubIcon}
        name="GitHub"
        connected={githubConnected()}
        onConnect={() => { setGithubMessage(null); setGithubError(null); setModalProvider('github'); }}
        onDisconnect={() => { void handleDisconnectGithub(); }}
        disconnecting={githubSaving()}
        testId="deploy-github-row"
      />

      <ProviderRow
        icon={CloudflareIcon}
        name="Cloudflare"
        connected={cfConnected()}
        onConnect={() => { setCfMessage(null); setCfError(null); setModalProvider('cloudflare'); }}
        onDisconnect={() => { void handleDisconnectCloudflare(); }}
        disconnecting={cfSaving()}
        testId="deploy-cf-row"
      />

      <ConnectProviderModal
        isOpen={modalProvider() === 'github'}
        provider={GITHUB_PROVIDER}
        onClose={() => setModalProvider(null)}
        onSave={(token) => { void handleSaveGithub(token); }}
        connectedToken={githubConnected() ? githubToken() : undefined}
        saving={githubSaving()}
        message={githubMessage()}
        error={githubError()}
      />

      <ConnectProviderModal
        isOpen={modalProvider() === 'cloudflare'}
        provider={CLOUDFLARE_PROVIDER}
        onClose={() => setModalProvider(null)}
        onSave={(token) => { void handleSaveCloudflare(token); }}
        connectedToken={cfConnected() ? cfToken() : undefined}
        accounts={cfAccounts()}
        accountId={cfAccountId()}
        onSelectAccount={(id) => { void handleSelectAccount(id); }}
        saving={cfSaving()}
        message={cfMessage()}
        error={cfError()}
      />

      <div class="setting-row setting-row--column-gap">
        <span class="settings-hint" data-testid="deploy-keys-hint">
          Tokens take effect on next session start. Used by git push, gh CLI, and wrangler.
        </span>
      </div>
    </>
  );
};

export default DeployKeysSection;
