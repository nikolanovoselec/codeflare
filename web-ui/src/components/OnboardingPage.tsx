import { Component, onMount, onCleanup, createSignal, Show, For, type JSX } from 'solid-js';
import { getDeployKeys, updateDeployKeys, markOnboardingComplete } from '../api/client';
import type { DeployKeysResponse } from '../api/client';
import ProviderRow from './settings/ProviderRow';
import { GitHubIcon, CloudflareIcon } from './settings/BrandIcons';
import ScrambleText from './ScrambleText';
import Icon from './Icon';
import { mdiArrowRight } from '@mdi/js';
import { logger } from '../lib/logger';
import { getGithubTokenUrl, GITHUB_TIERS, CLOUDFLARE_TOKEN_PAGE, SCOPES_DOCS_URL, CLOUDFLARE_BRAND_COLOR } from '../lib/token-scopes';
import '../styles/login-page.css';
import '../styles/onboarding-page.css';

interface CodingAgent {
  name: string;
  description: string;
  url: string;
  brandColor: string;
  icon: () => JSX.Element;
}

const CODING_AGENTS: CodingAgent[] = [
  {
    name: 'Claude Code',
    description: 'AI coding agent by Anthropic',
    url: 'https://console.anthropic.com/',
    brandColor: '#d4a27f',
    icon: () => (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M4.709 15.955l4.397-11.91h1.853l-4.476 11.91H4.709zm8.984 0l4.397-11.91h1.853l-4.476 11.91h-1.774z" />
      </svg>
    ),
  },
  {
    name: 'Codex',
    description: 'AI coding agent by OpenAI',
    url: 'https://platform.openai.com/signup',
    brandColor: '#10a37f',
    icon: () => (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M22.28 9.37a5.98 5.98 0 00-.52-4.93 6.07 6.07 0 00-6.55-2.89A5.98 5.98 0 0010.69.02a6.07 6.07 0 00-5.8 4.22 5.99 5.99 0 00-4 2.9 6.07 6.07 0 00.75 7.12 5.98 5.98 0 00.52 4.93 6.07 6.07 0 006.55 2.89 5.98 5.98 0 004.52 1.53 6.07 6.07 0 005.8-4.22 5.99 5.99 0 004-2.9 6.07 6.07 0 00-.75-7.12zM13.21 21.45c-1.24 0-2.44-.42-3.41-1.2l.17-.1 5.66-3.27a.92.92 0 00.46-.8V10.1l2.39 1.38c.03.01.04.04.05.07v6.61a4.55 4.55 0 01-5.32 4.49v.8zm-9.52-4.2a4.5 4.5 0 01-.54-3.05l.17.1 5.66 3.27a.93.93 0 00.92 0l6.91-3.99v2.76c0 .04-.01.07-.04.09l-5.72 3.3a4.56 4.56 0 01-7.36-2.48zM2.54 7.86a4.52 4.52 0 012.37-1.98v6.74c0 .33.18.64.46.8l6.91 3.99-2.39 1.38a.09.09 0 01-.09 0L4.08 15.5A4.56 4.56 0 012.54 7.86zm16.34 3.8l-6.91-3.99 2.39-1.38a.09.09 0 01.09 0l5.72 3.3a4.55 4.55 0 01-.7 8.22v-6.74a.93.93 0 00-.46-.8l-.13-.61zm2.38-3.1l-.17-.1-5.66-3.27a.93.93 0 00-.92 0L7.6 9.18V6.42c0-.04.01-.07.04-.09l5.72-3.3a4.56 4.56 0 017.1 4.72l-.2-.19zM6.72 13.9L4.33 12.52a.09.09 0 01-.05-.07V5.84A4.55 4.55 0 0111.73 3l-.17.1-5.66 3.27a.92.92 0 00-.46.8l-.72 6.73zm1.3-2.8L12 8.65l3.98 2.3v4.59L12 17.84l-3.98-2.3V11.1z" />
      </svg>
    ),
  },
  {
    name: 'Gemini',
    description: 'AI coding agent by Google',
    url: 'https://aistudio.google.com/',
    brandColor: '#4285f4',
    icon: () => (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z" />
      </svg>
    ),
  },
  {
    name: 'GitHub Copilot',
    description: 'AI coding agent by GitHub',
    url: 'https://github.com/features/copilot',
    brandColor: '#6e5494',
    icon: () => (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.58 2 12.24c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.58 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.08 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.05A9.25 9.25 0 0112 6.4a9.2 9.2 0 012.5.35c1.9-1.32 2.74-1.05 2.74-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.64 1.03 2.76 0 3.95-2.33 4.82-4.56 5.07.36.31.68.92.68 1.86 0 1.34-.01 2.42-.01 2.75 0 .27.18.59.69.49A10.26 10.26 0 0022 12.24C22 6.58 17.52 2 12 2z" />
      </svg>
    ),
  },
  {
    name: 'OpenCode',
    description: 'Open-source AI coding agent',
    url: 'https://opencode.ai/',
    brandColor: '#e5e5e5',
    icon: () => (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
      </svg>
    ),
  },
];

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

  const githubConnected = () => githubToken().startsWith('****');
  const cfConnected = () => cfToken().startsWith('****');

  onMount(async () => {
    // Override global overflow:hidden on html/body so this standalone page can scroll.
    // Capture previous values so cleanup restores exact prior state (not blank).
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';

    onCleanup(() => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    });

    try {
      const keys: DeployKeysResponse = await getDeployKeys();
      if (keys.githubToken) setGithubToken(keys.githubToken);
      if (keys.cloudflareApiToken) setCfToken(keys.cloudflareApiToken);
      if (keys.cloudflareAccountId) setCfAccountId(keys.cloudflareAccountId);
    } catch (err) {
      logger.warn('Failed to load deploy keys:', err);
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
              Create repositories and manage your code automatically.
            </p>
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
              testId="onboarding-github-row"
              tierOptions={{
                tiers: GITHUB_TIERS,
                getUrl: getGithubTokenUrl,
                docsUrl: SCOPES_DOCS_URL,
              }}
            />
          </div>

          {/* Section 2: Connect Cloudflare */}
          <div class="onboarding-section" data-testid="onboarding-cloudflare-section">
            <h2 class="onboarding-section-title">
              <span class="onboarding-step-number">2</span>
              Connect Cloudflare
            </h2>
            <p class="onboarding-section-description">
              Deploy your creations directly to Cloudflare and access from anywhere.
            </p>
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
              testId="onboarding-cloudflare-row"
              instructions={<>Press <span style={{color: CLOUDFLARE_BRAND_COLOR, "font-weight": "600"}}>"Open Cloudflare"</span> below, click <span style={{color: CLOUDFLARE_BRAND_COLOR, "font-weight": "600"}}>"Create Token"</span>, then use the <span style={{color: CLOUDFLARE_BRAND_COLOR, "font-weight": "600"}}>"Edit Cloudflare Workers"</span> template. Select your account and zones, then create the token.</>}
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

          {/* Section 3: Coding Agents */}
          <div class="onboarding-section" data-testid="onboarding-agents-section">
            <h2 class="onboarding-section-title">
              <span class="onboarding-step-number">3</span>
              Grab a Coding Agent subscription
            </h2>
            <p class="onboarding-section-description">
              Codeflare is your IDE — you need at least one coding agent subscription to start coding.
              Sign up with any of the providers below.
            </p>
            <div class="onboarding-agents-grid">
              <For each={CODING_AGENTS}>
                {(agent) => (
                  <a
                    href={agent.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="onboarding-agent-card"
                    data-testid={`onboarding-agent-${agent.name.toLowerCase().replace(/\s+/g, '-')}`}
                    style={{ '--agent-color': agent.brandColor }}
                  >
                    <span class="onboarding-agent-icon">{agent.icon()}</span>
                    <span class="onboarding-agent-info">
                      <span class="onboarding-agent-name">{agent.name}</span>
                      <span class="onboarding-agent-description">{agent.description}</span>
                    </span>
                  </a>
                )}
              </For>
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

        <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: '#f38020' }}>Region: Earth</span></p>
        <p class="login-footer login-footer-legal"><a href="https://graymatter.ch" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', 'text-decoration': 'none' }}>&copy; 2026 Gray Matter GmbH</a></p>
      </div>
    </div>
  );
};

export default OnboardingPage;
