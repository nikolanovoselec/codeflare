import { Component, onMount, createSignal, Show, For } from 'solid-js';
import { getDeployKeys, updateDeployKeys, getLlmKeys, updateLlmKeys, markOnboardingComplete } from '../api/client';
import type { DeployKeysResponse, LlmKeysResponse } from '../api/client';
import ProviderRow from './settings/ProviderRow';
import { GitHubIcon, CloudflareIcon, AnthropicIcon, OpenAIIcon, GeminiIcon } from './settings/BrandIcons';
import ScrambleText from './ScrambleText';
import Icon from './Icon';
import { mdiArrowRight } from '@mdi/js';
import { logger } from '../lib/logger';
import '../styles/login-page.css';
import '../styles/onboarding-page.css';

// GitHub fine-grained PAT template URL with Copilot scopes
const GITHUB_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Codeflare&description=Push+%26+deploy+from+Codeflare&expires_in=90'
  + '&contents=write&administration=write&workflows=write&actions=write&actions_variables=write'
  + '&pull_requests=write&issues=write&deployments=write&environments=write&pages=write'
  + '&secrets=write&statuses=write&repository_hooks=write&merge_queues=write'
  + '&security_events=write&custom_properties=write&discussions=write'
  + '&metadata=read&email_addresses=read'
  + '&user_copilot_requests=read&copilot_messages=read&copilot_editor_context=read';

// Cloudflare template URL (same as DeployKeysSection)
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

const OnboardingPage: Component = () => {
  const [loading, setLoading] = createSignal(true);

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

  // LLM key state — Anthropic
  const [anthropicKey, setAnthropicKey] = createSignal('');
  const [anthropicSaving, setAnthropicSaving] = createSignal(false);
  const [anthropicMessage, setAnthropicMessage] = createSignal<string | null>(null);
  const [anthropicError, setAnthropicError] = createSignal<string | null>(null);

  // LLM key state — OpenAI (Codex)
  const [openaiKey, setOpenaiKey] = createSignal('');
  const [openaiSaving, setOpenaiSaving] = createSignal(false);
  const [openaiMessage, setOpenaiMessage] = createSignal<string | null>(null);
  const [openaiError, setOpenaiError] = createSignal<string | null>(null);

  // LLM key state — Gemini
  const [geminiKey, setGeminiKey] = createSignal('');
  const [geminiSaving, setGeminiSaving] = createSignal(false);
  const [geminiMessage, setGeminiMessage] = createSignal<string | null>(null);
  const [geminiError, setGeminiError] = createSignal<string | null>(null);

  const githubConnected = () => githubToken().startsWith('****');
  const cfConnected = () => cfToken().startsWith('****');
  const anthropicConnected = () => anthropicKey().startsWith('****');
  const openaiConnected = () => openaiKey().startsWith('****');
  const geminiConnected = () => geminiKey().startsWith('****');
  // Copilot uses the GitHub token from deploy keys
  const copilotConnected = () => githubConnected();

  onMount(async () => {
    try {
      const [deployKeys, llmKeys] = await Promise.all([
        getDeployKeys().catch(() => ({} as DeployKeysResponse)),
        getLlmKeys().catch(() => ({} as LlmKeysResponse)),
      ]);
      if (deployKeys.githubToken) setGithubToken(deployKeys.githubToken);
      if (deployKeys.cloudflareApiToken) setCfToken(deployKeys.cloudflareApiToken);
      if (deployKeys.cloudflareAccountId) setCfAccountId(deployKeys.cloudflareAccountId);
      if (llmKeys.anthropicApiKey) setAnthropicKey(llmKeys.anthropicApiKey);
      if (llmKeys.openaiApiKey) setOpenaiKey(llmKeys.openaiApiKey);
      if (llmKeys.geminiApiKey) setGeminiKey(llmKeys.geminiApiKey);
    } catch (err) {
      logger.warn('Failed to load keys:', err);
    } finally {
      setLoading(false);
    }
  });

  // GitHub handlers
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

  // Cloudflare handlers
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

  // LLM key handlers — Anthropic
  const handleSaveAnthropic = async (token: string) => {
    setAnthropicSaving(true);
    setAnthropicMessage(null);
    setAnthropicError(null);
    try {
      const result = await updateLlmKeys({ anthropicApiKey: token });
      setAnthropicKey(result.anthropicApiKey || '');
      setAnthropicMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setAnthropicError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setAnthropicSaving(false);
    }
  };

  const handleDisconnectAnthropic = async () => {
    setAnthropicSaving(true);
    setAnthropicMessage(null);
    setAnthropicError(null);
    try {
      await updateLlmKeys({ anthropicApiKey: null });
      setAnthropicKey('');
      setAnthropicMessage('Disconnected.');
    } catch (error) {
      setAnthropicError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setAnthropicSaving(false);
    }
  };

  // LLM key handlers — OpenAI (Codex)
  const handleSaveOpenai = async (token: string) => {
    setOpenaiSaving(true);
    setOpenaiMessage(null);
    setOpenaiError(null);
    try {
      const result = await updateLlmKeys({ openaiApiKey: token });
      setOpenaiKey(result.openaiApiKey || '');
      setOpenaiMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setOpenaiError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  const handleDisconnectOpenai = async () => {
    setOpenaiSaving(true);
    setOpenaiMessage(null);
    setOpenaiError(null);
    try {
      await updateLlmKeys({ openaiApiKey: null });
      setOpenaiKey('');
      setOpenaiMessage('Disconnected.');
    } catch (error) {
      setOpenaiError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  // LLM key handlers — Gemini
  const handleSaveGemini = async (token: string) => {
    setGeminiSaving(true);
    setGeminiMessage(null);
    setGeminiError(null);
    try {
      const result = await updateLlmKeys({ geminiApiKey: token });
      setGeminiKey(result.geminiApiKey || '');
      setGeminiMessage('Connected. Takes effect on next session.');
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : 'Failed to save.');
    } finally {
      setGeminiSaving(false);
    }
  };

  const handleDisconnectGemini = async () => {
    setGeminiSaving(true);
    setGeminiMessage(null);
    setGeminiError(null);
    try {
      await updateLlmKeys({ geminiApiKey: null });
      setGeminiKey('');
      setGeminiMessage('Disconnected.');
    } catch (error) {
      setGeminiError(error instanceof Error ? error.message : 'Failed.');
    } finally {
      setGeminiSaving(false);
    }
  };

  return (
    <div class="onboarding-page">
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="onboarding-content">
        {/* Header with logo and skip button */}
        <div class="onboarding-header">
          <div class="login-logo">
            <img src="/logo-original-transparent.png" alt="Codeflare" class="login-logo-img" />
          </div>
          <h1 class="login-title">
            <ScrambleText text="Codeflare" class="login-title-scramble" />
          </h1>
          <p class="login-subtitle">
            Get started by connecting your accounts and choosing a coding agent.
          </p>
        </div>

        {/* Skip button */}
        <a
          href="/app/"
          class="onboarding-skip-btn"
          data-testid="onboarding-skip"
          onClick={async (e) => { e.preventDefault(); await markOnboardingComplete().catch(() => {}); window.location.href = '/app/'; }}
        >
          Skip and continue to Codeflare
          <Icon path={mdiArrowRight} size={16} />
        </a>

        {/* 3-step instructions */}
        <ol class="provider-steps">
          <li>Click a provider button to open their console</li>
          <li>Create an <span style={{ color: '#4ade80' }}>API KEY</span> on the provider page</li>
          <li>Come back here, paste the key and save</li>
        </ol>

        <Show when={!loading()} fallback={
          <div class="login-loading">
            <div class="login-spinner" />
          </div>
        }>
          {/* Section 1: Connect GitHub */}
          <div class="onboarding-section" data-testid="onboarding-github-section">
            <h2 class="onboarding-section-title">
              <span class="onboarding-step-number">1</span>
              Connect GitHub
            </h2>
            <p class="onboarding-section-description">
              Connect your GitHub account so sessions can push code, create repos, and run CI.
            </p>
            <ProviderRow
              icon={GitHubIcon}
              name="GitHub"
              brandColor="#24292f"
              externalUrl={GITHUB_TOKEN_URL}
              externalLabel="Open GitHub"
              placeholder="github_pat_..."
              connected={githubConnected()}
              onSave={(token) => { void handleSaveGithub(token); }}
              onDisconnect={() => { void handleDisconnectGithub(); }}
              saving={githubSaving()}
              disconnecting={githubSaving()}
              message={githubMessage()}
              error={githubError()}
              testId="onboarding-github-row"
            />
          </div>

          {/* Section 2: Connect Cloudflare */}
          <div class="onboarding-section" data-testid="onboarding-cloudflare-section">
            <h2 class="onboarding-section-title">
              <span class="onboarding-step-number">2</span>
              Connect Cloudflare
            </h2>
            <p class="onboarding-section-description">
              Connect your Cloudflare account so sessions can deploy Workers, manage DNS, and use R2 storage.
            </p>
            <ProviderRow
              icon={CloudflareIcon}
              name="Cloudflare"
              brandColor="#f38020"
              externalUrl={CLOUDFLARE_TOKEN_URL}
              externalLabel="Open Cloudflare"
              placeholder="Cloudflare API token..."
              connected={cfConnected()}
              onSave={(token) => { void handleSaveCloudflare(token); }}
              onDisconnect={() => { void handleDisconnectCloudflare(); }}
              saving={cfSaving()}
              disconnecting={cfSaving()}
              message={cfMessage()}
              error={cfError()}
              testId="onboarding-cloudflare-row"
            />
            {/* Multi-account dropdown */}
            <Show when={cfAccounts().length > 1}>
              <div class="onboarding-cf-account-select" data-testid="onboarding-cf-account-select">
                <select
                  class="provider-row-token-input"
                  value={cfAccountId() || ''}
                  onChange={(e) => { const val = e.currentTarget.value; if (val) void handleSelectAccount(val); }}
                >
                  <option value="" disabled>Choose an account...</option>
                  <For each={cfAccounts()}>
                    {(account) => <option value={account.id}>{account.name}</option>}
                  </For>
                </select>
              </div>
            </Show>
          </div>

          {/* Section 3: Connect Coding Agents */}
          <div class="onboarding-section" data-testid="onboarding-agents-section">
            <h2 class="onboarding-section-title">
              <span class="onboarding-step-number">3</span>
              Connect Coding Agents
            </h2>
            <p class="onboarding-section-description">
              Connect your API keys so coding agents can run inside Codeflare sessions.
            </p>

            <ProviderRow
              icon={AnthropicIcon}
              name="Anthropic"
              brandColor="#d4a27f"
              externalUrl="https://console.anthropic.com/settings/keys"
              externalLabel="Open Anthropic"
              placeholder="sk-ant-..."
              connected={anthropicConnected()}
              onSave={(token) => { void handleSaveAnthropic(token); }}
              onDisconnect={() => { void handleDisconnectAnthropic(); }}
              saving={anthropicSaving()}
              disconnecting={anthropicSaving()}
              message={anthropicMessage()}
              error={anthropicError()}
              testId="onboarding-anthropic-row"
            />

            <ProviderRow
              icon={OpenAIIcon}
              name="Codex"
              brandColor="#10a37f"
              externalUrl="https://platform.openai.com/api-keys"
              externalLabel="Open OpenAI"
              placeholder="sk-..."
              connected={openaiConnected()}
              onSave={(token) => { void handleSaveOpenai(token); }}
              onDisconnect={() => { void handleDisconnectOpenai(); }}
              saving={openaiSaving()}
              disconnecting={openaiSaving()}
              message={openaiMessage()}
              error={openaiError()}
              testId="onboarding-codex-row"
            />

            <ProviderRow
              icon={GeminiIcon}
              name="Gemini"
              brandColor="#4285f4"
              externalUrl="https://aistudio.google.com/apikey"
              externalLabel="Open Google AI Studio"
              placeholder="AI..."
              connected={geminiConnected()}
              onSave={(token) => { void handleSaveGemini(token); }}
              onDisconnect={() => { void handleDisconnectGemini(); }}
              saving={geminiSaving()}
              disconnecting={geminiSaving()}
              message={geminiMessage()}
              error={geminiError()}
              testId="onboarding-gemini-row"
            />

            {/* Copilot status — read-only, derived from GitHub connection */}
            <div class="provider-row" data-testid="onboarding-copilot-row">
              <div class="provider-row-connected" style={{ opacity: copilotConnected() ? 1 : 0.6 }}>
                <span class="provider-row-icon">
                  <GitHubIcon size={28} />
                </span>
                <span class="provider-row-name">Copilot</span>
                <span class="provider-row-badge" style={{ background: copilotConnected() ? undefined : 'var(--color-bg-tertiary)' }}>
                  {copilotConnected() ? 'connected' : 'disconnected'}
                </span>
              </div>
            </div>

            {/* Info badges */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', "margin-top": 'var(--space-2)' }}>
              <span class="provider-row-badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>
                OpenCode
              </span>
              <span class="provider-row-badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>
                Bash
              </span>
            </div>
          </div>
        </Show>

        {/* Bottom continue button */}
        <a
          href="/app/"
          class="onboarding-continue-btn"
          data-testid="onboarding-continue"
          onClick={async (e) => { e.preventDefault(); await markOnboardingComplete().catch(() => {}); window.location.href = '/app/'; }}
        >
          Continue to Codeflare
          <Icon path={mdiArrowRight} size={16} />
        </a>

        <p class="login-footer">Made in Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span></p>
      </div>
    </div>
  );
};

export default OnboardingPage;
