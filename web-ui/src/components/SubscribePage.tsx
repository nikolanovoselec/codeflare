declare global {
  interface Window {
    turnstile?: {
      reset: () => void;
      render: (...args: unknown[]) => string;
    };
  }
}

import { Component, onMount, onCleanup, createSignal, Show, For, type JSX } from 'solid-js';
import {
  mdiRocketLaunchOutline,
  mdiCellphoneLink,
  mdiCloudLockOutline,
  mdiCellphoneScreenshot,
  mdiSourceBranch,
  mdiLightningBolt,
} from '@mdi/js';
import { getAuthStatus, getPublicTiers, subscribe } from '../api/client';
import { formatDuration } from '../lib/format';
import { logger } from '../lib/logger';
import ScrambleText from './ScrambleText';
import Icon from './Icon';
import '../styles/subscribe-page.css';
import '../styles/login-page.css';

interface TierInfo {
  id: string;
  displayName: string;
  monthlySeconds: number | null;
  maxSessions: number;
  priceMonthly: number | null;
  advancedPriceMonthly?: number | null;
  description: string;
  trialQuotaHours?: number;
  trialDays?: number; // backward compat
  sessionModes: string[];
}

/** Per-card mode state: which price flavor is selected */
type ModeSelection = Record<string, 'default' | 'advanced'>;

const DEFAULT_FEATURES = [
  'Browser-based IDE',
  'Terminal access',
  'File browser',
  'Agent selection',
  'Workspace storage',
  'R2 sync',
];

const ADVANCED_FEATURES = [
  'Everything in Standard, plus:',
  'Curated skills, rules & agents',
  'MCP servers for knowledge graph memory',
  'Multi-LLM workflows',
];

const FEATURES: Array<{ icon: string; content: () => JSX.Element }> = [
  { icon: mdiRocketLaunchOutline, content: () => <>Ready to code in seconds</> },
  { icon: mdiCellphoneLink, content: () => <>Runs on any device with a browser</> },
  { icon: mdiSourceBranch, content: () => <><span style={{ color: '#3b82f6' }}>GitHub</span> & <span style={{ color: '#f38020' }}>Cloudflare</span> integration</> },
  { icon: mdiCloudLockOutline, content: () => <>Data persisted & encrypted at rest</> },
  { icon: mdiCellphoneScreenshot, content: () => <>Optimized for mobiles & foldables</> },
  { icon: mdiLightningBolt, content: () => <>From idea to deployment in minutes</> },
];

const SubscribePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [tiers, setTiers] = createSignal<TierInfo[]>([]);
  const [isBlocked, setIsBlocked] = createSignal(false);
  const [isActive, setIsActive] = createSignal(false);
  const [turnstileReady, setTurnstileReady] = createSignal(false);
  const [subscribing, setSubscribing] = createSignal<string | null>(null);
  const [modeSelections, setModeSelections] = createSignal<ModeSelection>({});
  const [currency, setCurrency] = createSignal('USD');
  const [showTiers, setShowTiers] = createSignal(false);
  const [userEmail, setUserEmail] = createSignal('');

  let observer: MutationObserver | null = null;

  onMount(async () => {
    try {
      const [status, tiersData] = await Promise.all([
        getAuthStatus(),
        getPublicTiers().catch((err) => { logger.error('getPublicTiers failed:', err); return { tiers: [] }; }),
      ]);

      if (status.currency) {
        setCurrency(status.currency);
      }

      if (status.email) {
        setUserEmail(status.email);
      }

      // Store tiers for ALL users (active users need them for "See subscription tiers")
      setTiers(tiersData.tiers as TierInfo[]);

      const tier = status.subscriptionTier ?? status.accessTier;

      if (tier === 'blocked') {
        setIsBlocked(true);
        setLoading(false);
        return;
      }

      // Show tier selection for:
      // 1. Pending users (new, haven't chosen a tier yet)
      // 2. Users who were admin-promoted but never self-subscribed (hasSubscribed=false)
      // Show "Active" only for users who explicitly subscribed (hasSubscribed=true)
      if (status.hasSubscribed === true) {
        setIsActive(true);
        setLoading(false);
        return;
      }

      // Load Turnstile
      if (status.turnstileSiteKey) {
        loadTurnstileScript();
        startTurnstileWatch();
      } else {
        // No Turnstile configured — enable buttons immediately
        setTurnstileReady(true);
      }
    } catch (err) {
      logger.error('Failed to load subscribe page:', err);
      setError('Unable to load subscription options. Please try again.');
    }
    setLoading(false);
  });

  onCleanup(() => {
    if (observer) observer.disconnect();
  });

  function loadTurnstileScript() {
    if (document.querySelector('script[src*="challenges.cloudflare.com"]')) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  function startTurnstileWatch() {
    const container = document.getElementById('turnstile-container');
    if (!container) return;

    const checkToken = () => {
      const input = container.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]') as HTMLTextAreaElement | HTMLInputElement | null;
      if (input?.value) {
        setTurnstileReady(true);
        return true;
      }
      return false;
    };

    if (checkToken()) return;

    observer = new MutationObserver(() => {
      if (checkToken() && observer) {
        observer.disconnect();
        observer = null;
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  function getTurnstileToken(): string | null {
    const container = document.getElementById('turnstile-container');
    if (!container) return null;
    const input = container.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]') as HTMLTextAreaElement | HTMLInputElement | null;
    return input?.value || null;
  }

  async function handleSubscribe(tierId: string) {
    const token = getTurnstileToken() || '';
    setSubscribing(tierId);
    setError('');

    try {
      const result = await subscribe(tierId, token);
      // Redirect based on onboarding status
      if (!result.onboardingComplete) {
        window.location.href = '/app/onboarding';
      } else {
        window.location.href = '/app/';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subscription failed. Please try again.');
      setSubscribing(null);
      if (window.turnstile) {
        try { window.turnstile.reset(); } catch { /* ignore */ }
      }
      setTurnstileReady(false);
      startTurnstileWatch();
    }
  }

  function formatPrice(cents: number | null, cur?: string): string {
    if (cents === null || cents === 0) return 'Free';
    const code = cur ?? currency();
    const amount = (cents / 100).toFixed(0);
    switch (code) {
      case 'EUR': return `\u20AC${amount}/mo`;
      case 'GBP': return `\u00A3${amount}/mo`;
      case 'CHF': return `CHF ${amount}/mo`;
      default: return `$${amount}/mo`;
    }
  }

  function getSelectedMode(tierId: string): 'default' | 'advanced' {
    return modeSelections()[tierId] ?? 'default';
  }

  function setMode(tierId: string, mode: 'default' | 'advanced') {
    setModeSelections((prev) => ({ ...prev, [tierId]: mode }));
  }

  function supportsAdvanced(tier: TierInfo): boolean {
    return tier.sessionModes.includes('advanced');
  }

  function getDisplayPrice(tier: TierInfo): string {
    if (getSelectedMode(tier.id) === 'advanced' && tier.advancedPriceMonthly != null) {
      return formatPrice(tier.advancedPriceMonthly);
    }
    return formatPrice(tier.priceMonthly);
  }

  function getTrialBadge(tier: TierInfo): string | null {
    const trialHours = tier.trialQuotaHours ?? tier.trialDays ?? 0;
    if (trialHours <= 0) return null;
    return `Try free — billed after ${trialHours}h used`;
  }

  /** Use narrow layout for active users (unless they've expanded tiers), wide for pending */
  const contentClass = () => {
    if (isActive() && !showTiers()) return 'login-content';
    if (!isBlocked() && !isActive()) return 'login-content subscribe-content';
    if (showTiers()) return 'login-content subscribe-content';
    return 'login-content';
  };

  return (
    <div class="login-page">
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class={contentClass()}>
        <div class="login-logo">
          <img src="/logo-original-transparent.png" alt="Codeflare" class="login-logo-img" />
        </div>

        <h1 class="login-title">
          <ScrambleText text="Codeflare" class="login-title-scramble" />
        </h1>

        <p class="login-subtitle">
          Five coding agents in the palm of your hand.
          Ready when you are, wherever you are.
        </p>

        <Show when={!loading()} fallback={
          <div class="subscribe-loading">Loading...</div>
        }>
          {/* Blocked state */}
          <Show when={isBlocked()}>
            <div class="subscribe-status">
              <div class="subscribe-status-icon subscribe-status-icon--blocked">
                <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z"/></svg>
              </div>
              <h2 class="subscribe-title">Account Blocked</h2>
              <p class="subscribe-message">Your account has been blocked. Contact an administrator for help.</p>
            </div>
          </Show>

          {/* Active state — main branch layout: features, checkmark, email, Continue */}
          <Show when={isActive()}>
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

            <div class="subscribe-status">
              <div class="subscribe-status-icon subscribe-status-icon--active">
                <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
              </div>
              <Show when={userEmail()}>
                <div class="subscribe-email">{userEmail()}</div>
              </Show>
              <a href="/app/" class="subscribe-action-button">Continue</a>
            </div>

            {/* "See subscription tiers" button — reveals tier cards below */}
            <Show when={!showTiers()}>
              <button
                type="button"
                class="subscribe-logout-button"
                onClick={() => setShowTiers(true)}
              >
                See subscription tiers
              </button>
            </Show>

            {/* Tier cards revealed on click */}
            <Show when={showTiers()}>
              <div class="subscribe-tier-grid" data-testid="tier-grid">
                <For each={tiers()}>
                  {(tier) => (
                    <div class="subscribe-tier-card" classList={{ 'subscribe-tier-card--highlight': tier.id === 'standard' }}>
                      <div class="subscribe-tier-header">
                        <h3 class="subscribe-tier-name">{tier.displayName}</h3>
                        <div class="subscribe-tier-price">{getDisplayPrice(tier)}</div>
                      </div>
                      <div class="subscribe-tier-features">
                        <div class="subscribe-tier-feature">
                          <span>{tier.monthlySeconds !== null ? formatDuration(tier.monthlySeconds) : 'Unlimited'}</span>
                          <span class="subscribe-tier-feature-label">monthly</span>
                        </div>
                        <div class="subscribe-tier-feature">
                          <span>{tier.maxSessions}</span>
                          <span class="subscribe-tier-feature-label">sessions</span>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Tier selection (pending users) */}
          <Show when={!isBlocked() && !isActive()}>
            {/* Features comparison */}
            <div class="subscribe-features">
              <div class="subscribe-features-col">
                <h3 class="subscribe-features-heading">Standard Mode</h3>
                <For each={DEFAULT_FEATURES}>
                  {(feature) => (
                    <div class="subscribe-feature-item">
                      <span class="subscribe-feature-check">&#10003;</span>
                      <span>{feature}</span>
                    </div>
                  )}
                </For>
              </div>
              <div class="subscribe-features-col">
                <h3 class="subscribe-features-heading">Pro Mode</h3>
                <For each={ADVANCED_FEATURES}>
                  {(feature) => (
                    <div class="subscribe-feature-item">
                      <span class="subscribe-feature-check">&#10003;</span>
                      <span>{feature}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <p class="login-subtitle">Choose your plan to get started.</p>

            <Show when={error()}>
              <div class="subscribe-error">{error()}</div>
            </Show>

            <div class="subscribe-tier-grid">
              <For each={tiers()}>
                {(tier) => (
                  <div class="subscribe-tier-card" classList={{ 'subscribe-tier-card--highlight': tier.id === 'standard' }}>
                    <div class="subscribe-tier-header">
                      <h3 class="subscribe-tier-name">{tier.displayName}</h3>
                      <div class="subscribe-tier-price">{getDisplayPrice(tier)}</div>
                    </div>

                    {/* Mode toggle for paid tiers with advanced */}
                    <Show when={supportsAdvanced(tier) && tier.priceMonthly !== null && tier.priceMonthly > 0}>
                      <div class="subscribe-mode-toggle">
                        <button
                          type="button"
                          class="subscribe-mode-btn"
                          classList={{ 'subscribe-mode-btn--active': getSelectedMode(tier.id) === 'default' }}
                          onClick={() => setMode(tier.id, 'default')}
                        >
                          Standard
                        </button>
                        <button
                          type="button"
                          class="subscribe-mode-btn"
                          classList={{ 'subscribe-mode-btn--active': getSelectedMode(tier.id) === 'advanced' }}
                          onClick={() => setMode(tier.id, 'advanced')}
                        >
                          Pro
                        </button>
                      </div>
                    </Show>

                    <div class="subscribe-tier-features">
                      <div class="subscribe-tier-feature">
                        <span>{tier.monthlySeconds !== null ? formatDuration(tier.monthlySeconds) : 'Unlimited'}</span>
                        <span class="subscribe-tier-feature-label">monthly</span>
                      </div>
                      <div class="subscribe-tier-feature">
                        <span>{tier.maxSessions}</span>
                        <span class="subscribe-tier-feature-label">sessions</span>
                      </div>
                    </div>
                    <Show when={getTrialBadge(tier)}>
                      {(badge) => (
                        <div class="subscribe-tier-badge">{badge()}</div>
                      )}
                    </Show>
                    <button
                      type="button"
                      class="subscribe-tier-btn"
                      disabled={!turnstileReady() || subscribing() !== null}
                      onClick={() => void handleSubscribe(tier.id)}
                    >
                      {subscribing() === tier.id ? 'Subscribing...' : tier.priceMonthly ? 'Start Trial' : 'Get Started'}
                    </button>
                  </div>
                )}
              </For>
            </div>

            {/* Disabled continue button for pending users */}
            <button type="button" class="subscribe-action-button" disabled>
              Continue to Codeflare
            </button>

            {/* Turnstile widget */}
            <div class="subscribe-turnstile" id="turnstile-container" data-testid="turnstile-container">
              <div class="cf-turnstile" data-sitekey="" data-callback="onTurnstileSuccess" />
            </div>
          </Show>
        </Show>

        {/* Logout — always visible */}
        <a href="/cdn-cgi/access/logout" class="subscribe-logout-button">Log out</a>

        <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: '#f38020' }}>Region: Earth</span></p>
      </div>
    </div>
  );
};

export default SubscribePage;
