declare global {
  interface Window {
    turnstile?: {
      reset: () => void;
      render: (...args: unknown[]) => string;
    };
  }
}

import { Component, onMount, onCleanup, createSignal, Show, For } from 'solid-js';
import { getAuthStatus, getPublicTiers, subscribe } from '../api/client';
import { formatDuration } from '../lib/format';
import { logger } from '../lib/logger';
import ScrambleText from './ScrambleText';
import '../styles/subscribe-page.css';

interface TierInfo {
  id: string;
  displayName: string;
  monthlySeconds: number | null;
  maxSessions: number;
  priceMonthly: number | null;
  description: string;
  trialDays: number;
  sessionModes: string[];
}

const SubscribePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [tiers, setTiers] = createSignal<TierInfo[]>([]);
  const [isBlocked, setIsBlocked] = createSignal(false);
  const [isActive, setIsActive] = createSignal(false);
  const [_onboardingComplete, setOnboardingComplete] = createSignal(false);
  const [turnstileReady, setTurnstileReady] = createSignal(false);
  const [subscribing, setSubscribing] = createSignal<string | null>(null);

  let observer: MutationObserver | null = null;

  onMount(async () => {
    try {
      const [status, tiersData] = await Promise.all([
        getAuthStatus(),
        getPublicTiers().catch(() => ({ tiers: [] })),
      ]);

      const tier = status.subscriptionTier ?? status.accessTier;
      setOnboardingComplete(status.onboardingComplete === true);

      if (tier === 'blocked') {
        setIsBlocked(true);
        setLoading(false);
        return;
      }

      // Already subscribed (non-pending active tier) — blocked already handled above
      if (tier !== 'pending') {
        setIsActive(true);
        setLoading(false);
        return;
      }

      // Pending — show tier selection
      setTiers(tiersData.tiers as TierInfo[]);

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
    // Restore scroll
    document.documentElement.style.overflow = '';
  });

  // Prevent scroll on this page
  onMount(() => {
    document.documentElement.style.overflow = 'hidden';
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

  function formatPrice(cents: number | null): string {
    if (cents === null || cents === 0) return 'Free';
    return `$${(cents / 100).toFixed(0)}/mo`;
  }

  return (
    <div class="login-page">
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="login-content">
        <div class="login-logo">
          <img src="/logo-original-transparent.png" alt="Codeflare" class="login-logo-img" />
        </div>

        <h1 class="login-title">
          <ScrambleText text="Codeflare" class="login-title-scramble" />
        </h1>

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

          {/* Active state */}
          <Show when={isActive()}>
            <div class="subscribe-status">
              <div class="subscribe-status-icon subscribe-status-icon--active">
                <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
              </div>
              <h2 class="subscribe-title">Your Account is Active</h2>
              <a href="/app/" class="subscribe-action-button">Continue</a>
            </div>
          </Show>

          {/* Tier selection (pending users) */}
          <Show when={!isBlocked() && !isActive()}>
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
                      <div class="subscribe-tier-price">{formatPrice(tier.priceMonthly)}</div>
                    </div>
                    <p class="subscribe-tier-description">{tier.description}</p>
                    <div class="subscribe-tier-features">
                      <div class="subscribe-tier-feature">
                        <span>{tier.monthlySeconds !== null ? formatDuration(tier.monthlySeconds) : 'Unlimited'}</span>
                        <span class="subscribe-tier-feature-label">monthly</span>
                      </div>
                      <div class="subscribe-tier-feature">
                        <span>{tier.maxSessions}</span>
                        <span class="subscribe-tier-feature-label">sessions</span>
                      </div>
                      <div class="subscribe-tier-feature">
                        <span>{tier.sessionModes.includes('advanced') ? 'Normal + Advanced' : 'Normal'}</span>
                        <span class="subscribe-tier-feature-label">modes</span>
                      </div>
                    </div>
                    <Show when={tier.trialDays > 0}>
                      <div class="subscribe-tier-badge">{tier.trialDays}-day free trial</div>
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

            {/* Turnstile widget */}
            <div class="subscribe-turnstile" id="turnstile-container" data-testid="turnstile-container">
              <div class="cf-turnstile" data-sitekey="" data-callback="onTurnstileSuccess" />
            </div>
          </Show>
        </Show>

        {/* Logout */}
        <a href="/cdn-cgi/access/logout" class="subscribe-logout-button">Log out</a>
      </div>
    </div>
  );
};

export default SubscribePage;
