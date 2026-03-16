import { Component, onMount, createSignal, Show, For, type JSX } from 'solid-js';
import {
  mdiRocketLaunchOutline,
  mdiCellphoneLink,
  mdiCloudLockOutline,
  mdiCellphoneScreenshot,
  mdiSourceBranch,
  mdiLightningBolt,
} from '@mdi/js';
import { getAuthProviders, getAuthStatus } from '../api/client';
import { CloudflareIcon } from './settings/BrandIcons';
import type { AuthProvider } from '../types';
import ScrambleText from './ScrambleText';
import Icon from './Icon';
import { logger } from '../lib/logger';
import '../styles/login-page.css';

const GITHUB_ICON = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" role="presentation">
    <path d="M12 2C6.48 2 2 6.58 2 12.24c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.58 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.08 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.05A9.25 9.25 0 0 1 12 6.4a9.2 9.2 0 0 1 2.5.35c1.9-1.32 2.74-1.05 2.74-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.64 1.03 2.76 0 3.95-2.33 4.82-4.56 5.07.36.31.68.92.68 1.86 0 1.34-.01 2.42-.01 2.75 0 .27.18.59.69.49A10.26 10.26 0 0 0 22 12.24C22 6.58 17.52 2 12 2z" />
  </svg>
);

const GOOGLE_ICON = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" role="presentation">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

const GRAYMATTER_ICON = (
  <svg viewBox="0 0 32 32" width="20" height="20" fill="none" role="presentation">
    <rect x="0" y="0" width="20" height="20" fill="#808080" />
    <rect x="5" y="5" width="20" height="20" fill="#FFFFFF" />
    <rect x="10" y="10" width="20" height="20" fill="#CCCCCC" />
  </svg>
);

function getProviderIcon(provider: AuthProvider) {
  switch (provider.type) {
    case 'github': return GITHUB_ICON;
    case 'google': return GOOGLE_ICON;
    default: break;
  }
  if (provider.name.toLowerCase().includes('gray matter')) return GRAYMATTER_ICON;
  return null;
}

const FEATURES: Array<{ icon: string; content: () => JSX.Element }> = [
  { icon: mdiRocketLaunchOutline, content: () => <>Ready to code in seconds</> },
  { icon: mdiCellphoneLink, content: () => <>Runs on any device with a browser</> },
  { icon: mdiSourceBranch, content: () => <><span style={{ color: '#3b82f6' }}>GitHub</span> & <span style={{ color: '#f38020' }}>Cloudflare</span> integration</> },
  { icon: mdiCloudLockOutline, content: () => <>Data persisted & encrypted at rest</> },
  { icon: mdiCellphoneScreenshot, content: () => <>Optimized for mobiles & foldables</> },
  { icon: mdiLightningBolt, content: () => <>From idea to deployment in minutes</> },
];

const LoginPage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [providers, setProviders] = createSignal<AuthProvider[]>([]);
  const [blocked, setBlocked] = createSignal(false);

  onMount(async () => {
    try {
      const status = await getAuthStatus();
      if (status.accessTier === 'standard' || status.accessTier === 'advanced') {
        window.location.href = '/app/';
        return;
      }
      if (status.accessTier === 'pending') {
        window.location.href = '/app/subscribe';
        return;
      }
      if (status.accessTier === 'blocked') {
        setBlocked(true);
        setLoading(false);
        return;
      }
    } catch {
      // Not authenticated — show login
    }

    try {
      const result = await getAuthProviders();
      if (result.providers.length === 0) {
        setError('No identity providers configured.');
        setLoading(false);
        return;
      }
      setProviders(result.providers);
    } catch (err) {
      logger.error('Failed to load auth providers:', err);
      setError('Failed to load identity providers.');
    }

    setLoading(false);
  });

  return (
    <div class="login-page">
      {/* Floating particle layers */}
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="login-content">
        {/* Logo with float animation */}
        <div class="login-logo">
          <img src="/logo-original-transparent.png" alt="Codeflare" class="login-logo-img" />
        </div>

        {/* Title with scramble animation */}
        <h1 class="login-title">
          <ScrambleText text="Codeflare" class="login-title-scramble" />
        </h1>

        <p class="login-subtitle">
          Five coding agents in the palm of your hand.
          Ready when you are, wherever you are.
        </p>

        {/* Feature highlights */}
        <div class="login-features">
          <For each={FEATURES}>
            {(feature, i) => (
              <div class="login-feature" style={{ 'animation-delay': `${0.3 + i() * 0.1}s` }}>
                <span class="login-feature-icon">
                  <Icon path={feature.icon} size={16} />
                </span>
                <span class="login-feature-text">{feature.content()}</span>
              </div>
            )}
          </For>
        </div>

        <Show when={loading()}>
          <div class="login-loading">
            <div class="login-spinner" />
          </div>
        </Show>

        <Show when={blocked()}>
          <div class="login-error">
            Your account has been blocked. Please contact your administrator.
          </div>
        </Show>

        <Show when={error()}>
          <div class="login-error">{error()}</div>
        </Show>

        <Show when={!loading() && !blocked() && !error() && providers().length > 0}>
          <div class="login-providers">
            <For each={providers()}>
              {(provider) => (
                <a
                  href="/app/"
                  class="login-provider-button"
                  data-provider={provider.type}
                  onClick={(e) => { e.preventDefault(); window.location.href = '/app/'; }}
                >
                  <span class="login-provider-icon">
                    {getProviderIcon(provider)}
                  </span>
                  Continue with {provider.name}
                </a>
              )}
            </For>
          </div>
        </Show>

        <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: '#f6821f' }}>Region: Earth</span> on <CloudflareIcon size={14} style={{ display: 'inline-block', 'vertical-align': 'middle', 'margin-left': '2px' }} /></p>
      </div>
    </div>
  );
};

export default LoginPage;
