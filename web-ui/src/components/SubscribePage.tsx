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
  mdiConsole,
  mdiFileDocumentOutline,
  mdiRobotOutline,
  mdiCloudOutline,
  mdiSync,
  mdiWrenchOutline,
  mdiBookOpenPageVariantOutline,
  mdiLayersTripleOutline,
  mdiHeadCogOutline,
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

/** Standard mode features with MDI icons */
const STANDARD_MODE_FEATURES: Array<{ icon: string; text: string }> = [
  { icon: mdiRocketLaunchOutline, text: 'Browser-based IDE' },
  { icon: mdiConsole, text: 'Terminal access' },
  { icon: mdiFileDocumentOutline, text: 'File browser & editor' },
  { icon: mdiRobotOutline, text: 'Agent selection' },
  { icon: mdiCloudOutline, text: 'Workspace storage' },
  { icon: mdiSync, text: 'R2 cloud sync' },
];

/** Pro mode features with MDI icons */
const PRO_MODE_FEATURES: Array<{ icon: string; text: string }> = [
  { icon: mdiWrenchOutline, text: 'Curated skills, rules & agents' },
  { icon: mdiBookOpenPageVariantOutline, text: 'Knowledge graph memory (MCP)' },
  { icon: mdiLayersTripleOutline, text: 'Multi-LLM workflows' },
  { icon: mdiHeadCogOutline, text: 'Advanced AI orchestration' },
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
  const [currency, setCurrency] = createSignal('USD');
  const [showTiers, setShowTiers] = createSignal(false);
  const [userEmail, setUserEmail] = createSignal('');
  const [currentTierId, setCurrentTierId] = createSignal<string | null>(null);
  const [globalMode, setGlobalMode] = createSignal<'default' | 'advanced'>('default');

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

      // Active user = has explicitly subscribed
      if (status.hasSubscribed === true) {
        setIsActive(true);
        setCurrentTierId(status.subscriptionTier ?? status.accessTier ?? null);
      }

      // Load Turnstile for pending users (needed when they open tier view)
      if (!status.hasSubscribed) {
        if (status.turnstileSiteKey) {
          loadTurnstileScript();
          startTurnstileWatch();
        } else {
          setTurnstileReady(true);
        }
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

  /** Price based on the global mode selector */
  function getGlobalModePrice(tier: TierInfo): string {
    if (globalMode() === 'advanced' && tier.advancedPriceMonthly != null) {
      return formatPrice(tier.advancedPriceMonthly);
    }
    return formatPrice(tier.priceMonthly);
  }

  function getTrialBadge(tier: TierInfo): string | null {
    const trialHours = tier.trialQuotaHours ?? tier.trialDays ?? 0;
    if (trialHours <= 0) return null;
    return `Try free — billed after ${trialHours}h used`;
  }

  /** Narrow for home view, wide for tier view */
  const contentClass = () => showTiers() ? 'login-content subscribe-content' : 'login-content';

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
          {/* Error display (always visible regardless of state) */}
          <Show when={error()}>
            <div class="subscribe-error">{error()}</div>
          </Show>

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

          {/* ── Unified flow for active + pending users ── */}
          <Show when={!isBlocked()}>

            {/* Home view: features list + status */}
            <Show when={!showTiers()}>
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
                <Show when={isActive()} fallback={
                  <>
                    <div class="subscribe-status-icon subscribe-status-icon--pending">
                      <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
                    </div>
                    <Show when={userEmail()}>
                      <div class="subscribe-email">{userEmail()}</div>
                    </Show>
                  </>
                }>
                  <div class="subscribe-status-icon subscribe-status-icon--active">
                    <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                  </div>
                  <Show when={userEmail()}>
                    <div class="subscribe-email">{userEmail()}</div>
                  </Show>
                  <a href="/app/" class="subscribe-action-button">Continue</a>
                </Show>
              </div>

              <button
                type="button"
                class="subscribe-logout-button"
                onClick={() => setShowTiers(true)}
              >
                See subscription tiers
              </button>
            </Show>

            {/* Tier view: mode selector + tier grid (identical for everyone) */}
            <Show when={showTiers()}>
              {/* Mode selector: Standard / Pro columns with vertical divider */}
              <div class="subscribe-mode-selector" data-testid="mode-selector">
                <button
                  type="button"
                  class="subscribe-mode-col"
                  classList={{ 'subscribe-mode-col--active': globalMode() === 'default' }}
                  onClick={() => setGlobalMode('default')}
                >
                  <h3 class="subscribe-mode-heading">Standard</h3>
                  <p class="subscribe-mode-desc">Everything you need to code, build and deploy.</p>
                  <div class="subscribe-mode-features">
                    <For each={STANDARD_MODE_FEATURES}>
                      {(f) => (
                        <div class="subscribe-mode-feature">
                          <Icon path={f.icon} size={14} />
                          <span>{f.text}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </button>

                <div class="subscribe-mode-divider" />

                <button
                  type="button"
                  class="subscribe-mode-col"
                  classList={{ 'subscribe-mode-col--active': globalMode() === 'advanced' }}
                  onClick={() => setGlobalMode('advanced')}
                >
                  <h3 class="subscribe-mode-heading">Pro</h3>
                  <p class="subscribe-mode-desc">Standard plus AI orchestration and memory.</p>
                  <div class="subscribe-mode-features">
                    <For each={PRO_MODE_FEATURES}>
                      {(f) => (
                        <div class="subscribe-mode-feature">
                          <Icon path={f.icon} size={14} />
                          <span>{f.text}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </button>
              </div>

              <Show when={error()}>
                <div class="subscribe-error">{error()}</div>
              </Show>

              {/* Tier grid — prices react to globalMode */}
              <div class="subscribe-tier-grid" data-testid="tier-grid">
                <For each={tiers()}>
                  {(tier) => (
                    <div class="subscribe-tier-card" classList={{
                      'subscribe-tier-card--highlight': isActive() ? tier.id === currentTierId() : tier.id === 'standard',
                    }}>
                      <div class="subscribe-tier-header">
                        <h3 class="subscribe-tier-name">{tier.displayName}</h3>
                        <div class="subscribe-tier-price">{getGlobalModePrice(tier)}</div>
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
                      <Show when={getTrialBadge(tier)}>
                        {(badge) => (
                          <div class="subscribe-tier-badge">{badge()}</div>
                        )}
                      </Show>
                      <button
                        type="button"
                        class="subscribe-tier-btn"
                        disabled={isActive()
                          ? (tier.id === currentTierId() || subscribing() !== null)
                          : (!turnstileReady() || subscribing() !== null)}
                        onClick={() => void handleSubscribe(tier.id)}
                      >
                        {isActive()
                          ? (tier.id === currentTierId()
                            ? 'Current Plan'
                            : subscribing() === tier.id ? 'Switching...' : 'Switch Plan')
                          : (subscribing() === tier.id ? 'Subscribing...' : tier.priceMonthly ? 'Start Trial' : 'Get Started')}
                      </button>
                    </div>
                  )}
                </For>
              </div>

              {/* Turnstile (pending users only) */}
              <Show when={!isActive()}>
                <div class="subscribe-turnstile" id="turnstile-container" data-testid="turnstile-container">
                  <div class="cf-turnstile" data-sitekey="" data-callback="onTurnstileSuccess" />
                </div>
              </Show>

              <button
                type="button"
                class="subscribe-logout-button"
                onClick={() => setShowTiers(false)}
              >
                Back
              </button>
            </Show>
          </Show>
        </Show>

        <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: '#f38020' }}>Region: Earth</span></p>
      </div>
    </div>
  );
};

export default SubscribePage;
