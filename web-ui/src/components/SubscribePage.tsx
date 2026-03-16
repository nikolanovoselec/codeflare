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
  mdiSourceBranch,
  mdiCloudLockOutline,
  mdiCellphoneScreenshot,
  mdiLightningBolt,
} from '@mdi/js';
import { getAuthStatus, requestAccess } from '../api/client';
import type { AuthStatus } from '../types';
import ScrambleText from './ScrambleText';
import Icon from './Icon';
import { logger } from '../lib/logger';
import { CloudflareIcon } from './settings/BrandIcons';
import '../styles/login-page.css';
import '../styles/subscribe-page.css';

const FEATURES: Array<{ icon: string; content: () => JSX.Element }> = [
  { icon: mdiRocketLaunchOutline, content: () => <>Ready to code in seconds</> },
  { icon: mdiCellphoneLink, content: () => <>Runs on any device with a browser</> },
  { icon: mdiSourceBranch, content: () => <><span style={{ color: '#3b82f6' }}>GitHub</span> & <span style={{ color: '#f38020' }}>Cloudflare</span> integration</> },
  { icon: mdiCloudLockOutline, content: () => <>Data persisted & encrypted at rest</> },
  { icon: mdiCellphoneScreenshot, content: () => <>Optimized for mobiles & foldables</> },
  { icon: mdiLightningBolt, content: () => <>From idea to deployment in minutes</> },
];

const POLL_INTERVAL_MS = 10_000;

const SubscribePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [status, setStatus] = createSignal<AuthStatus | null>(null);
  const [error, setError] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [submitted, setSubmitted] = createSignal(false);
  const [turnstileReady, setTurnstileReady] = createSignal(false);

  let pollInterval: ReturnType<typeof setInterval> | undefined;

  async function fetchStatus() {
    try {
      const result = await getAuthStatus();
      setStatus(result);
      setError('');

      if (result.requestedAt) {
        setSubmitted(true);
      }

      if (result.accessTier === 'pending' && !result.requestedAt && result.turnstileSiteKey) {
        loadTurnstileScript();
        startTurnstileWatch();
      }

      if (result.accessTier === 'standard' || result.accessTier === 'advanced') {
        // Stop polling — user is approved, show the active state UI
        if (pollInterval) clearInterval(pollInterval);
      }

      if (result.accessTier === 'blocked') {
        if (pollInterval) clearInterval(pollInterval);
      }
    } catch (err) {
      logger.error('Failed to fetch auth status:', err);
      setError('Unable to check account status. Retrying...');
    }
    setLoading(false);
  }

  function loadTurnstileScript() {
    if (document.querySelector('script[src*="challenges.cloudflare.com"]')) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  onMount(() => {
    fetchStatus();
    pollInterval = setInterval(fetchStatus, POLL_INTERVAL_MS);
  });

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  function checkTurnstileToken(): boolean {
    const tokenInput = document.querySelector(
      'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]'
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    return Boolean(tokenInput?.value);
  }

  let turnstileObserver: MutationObserver | undefined;

  function startTurnstileWatch() {
    if (turnstileObserver) return;
    if (checkTurnstileToken()) {
      setTurnstileReady(true);
      return;
    }
    turnstileObserver = new MutationObserver(() => {
      if (checkTurnstileToken()) {
        setTurnstileReady(true);
        turnstileObserver?.disconnect();
        turnstileObserver = undefined;
      }
    });
    turnstileObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
  }

  onCleanup(() => {
    turnstileObserver?.disconnect();
  });

  async function handleRequestAccess() {
    const tokenInput = document.querySelector(
      'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]'
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    const turnstileToken = tokenInput?.value || '';

    if (!turnstileToken) {
      setError('Please complete the CAPTCHA verification.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await requestAccess(turnstileToken);
      setSubmitted(true);
      if (window.turnstile?.reset) {
        window.turnstile.reset();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed. Please try again.');
      if (window.turnstile?.reset) {
        window.turnstile.reset();
      }
      setTurnstileReady(false);
    } finally {
      setSubmitting(false);
    }
  }

  const isPending = () => status()?.accessTier === 'pending';
  const isBlocked = () => status()?.accessTier === 'blocked';
  const isActive = () => {
    const tier = status()?.accessTier;
    return tier === 'standard' || tier === 'advanced';
  };
  const hasTurnstile = () => Boolean(status()?.turnstileSiteKey);

  return (
    <div class="login-page">
      {/* Reuse login page layout: particles, logo, title, features */}
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="login-content">
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

        <Show when={!loading()}>
          {/* Active user */}
          <Show when={isActive()}>
            <div class="subscribe-status-icon subscribe-status-icon--active">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <h2 class="subscribe-title">Your Access is Active</h2>
            <p class="subscribe-message">Your account is approved and ready to use.</p>
            <div class="subscribe-email">{status()!.email}</div>
            <a href="/app/" class="subscribe-action-button">Continue</a>
          </Show>

          {/* Pending — not yet requested */}
          <Show when={isPending() && !submitted()}>
            <div class="subscribe-status-icon">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z" />
              </svg>
            </div>
            <h2 class="subscribe-title">Request Access</h2>
            <p class="subscribe-message">
              Complete the verification below to request access.
              An administrator will review your request.
            </p>
            <div class="subscribe-email">{status()!.email}</div>

            <Show
              when={hasTurnstile()}
              fallback={
                <div class="login-error">
                  Access requests are not configured. Please contact an administrator.
                </div>
              }
            >
              <div class="subscribe-turnstile" data-testid="turnstile-container">
                <div
                  class="cf-turnstile"
                  data-sitekey={status()!.turnstileSiteKey!}
                  data-theme="dark"
                  data-size="flexible"
                />
              </div>

              <button
                type="button"
                class="subscribe-action-button"
                disabled={!turnstileReady() || submitting()}
                onClick={handleRequestAccess}
              >
                {submitting() ? 'Submitting...' : 'Request Access'}
              </button>
            </Show>
          </Show>

          {/* Pending — submitted */}
          <Show when={isPending() && submitted()}>
            <div class="subscribe-status-icon">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8m.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z" />
              </svg>
            </div>
            <h2 class="subscribe-title">Pending Approval</h2>
            <p class="subscribe-message">
              Your access request has been submitted and is waiting for administrator approval.
              This page will automatically redirect when your access is granted.
            </p>
            <div class="subscribe-email">{status()!.email}</div>
            <div class="subscribe-polling">
              <span class="subscribe-pulse" />
              <span class="subscribe-polling-text">Checking status...</span>
            </div>
          </Show>

          {/* Blocked */}
          <Show when={isBlocked()}>
            <div class="subscribe-status-icon subscribe-status-icon--blocked">
              <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z" />
              </svg>
            </div>
            <h2 class="subscribe-title">Account Blocked</h2>
            <p class="subscribe-message">
              Your account has been blocked by an administrator.
              Please contact support if you believe this is an error.
            </p>
            <div class="subscribe-email">{status()!.email}</div>
          </Show>

          <Show when={error()}>
            <div class="login-error">{error()}</div>
          </Show>

          <a
            href="/cdn-cgi/access/logout"
            class="subscribe-logout-button"
            onClick={(e) => { e.preventDefault(); window.location.href = `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(window.location.origin + '/')}`; }}
          >Log out</a>
        </Show>

        <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: '#f6821f' }}>Region: Earth</span> on <CloudflareIcon size={14} style={{ display: 'inline-block', 'vertical-align': 'middle', 'margin-left': '2px' }} /></p>
      </div>
    </div>
  );
};

export default SubscribePage;
