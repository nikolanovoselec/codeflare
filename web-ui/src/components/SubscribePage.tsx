declare global {
  interface Window {
    turnstile?: {
      reset: () => void;
      render: (...args: unknown[]) => string;
    };
  }
}

import { Component, onMount, onCleanup, createSignal, createEffect, createMemo, Show, For, type JSX } from 'solid-js';
import {
  mdiRocketLaunchOutline,
  mdiCellphoneLink,
  mdiCloudLockOutline,
  mdiCellphoneScreenshot,
  mdiSourceBranch,
  mdiLightningBolt,
  mdiCheck,
  mdiGiftOutline,
  mdiStarOutline,
  mdiFlash,
  mdiAccountGroupOutline,
  mdiMenuUp,
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
import { useScrambleText } from '../lib/use-scramble-text';
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
  trialDays?: number;
  sessionModes: string[];
}

type SubscribePhase = 'home' | 'tiers';

/** Home view feature highlights */
const FEATURES: Array<{ icon: string; content: () => JSX.Element }> = [
  { icon: mdiRocketLaunchOutline, content: () => <>Ready to code in seconds</> },
  { icon: mdiCellphoneLink, content: () => <>Runs on any device with a browser</> },
  { icon: mdiSourceBranch, content: () => <><span style={{ color: '#3b82f6' }}>GitHub</span> & <span style={{ color: '#f38020' }}>Cloudflare</span> integration</> },
  { icon: mdiCloudLockOutline, content: () => <>Data persisted & encrypted at rest</> },
  { icon: mdiCellphoneScreenshot, content: () => <>Optimized for mobiles & foldables</> },
  { icon: mdiLightningBolt, content: () => <>From idea to deployment in minutes</> },
];

/** Per-tier feature bullets for detail panel */
const TIER_FEATURES: Record<string, string[]> = {
  free: ['1 concurrent session', 'Standard mode only', '2 hours compute / month', 'Community support'],
  standard: ['3 concurrent sessions', 'Standard + Pro modes', '40 hours compute / month', '40h free trial', 'R2 cloud sync'],
  advanced: ['5 concurrent sessions', 'Standard + Pro modes', '80 hours compute / month', '80h free trial', 'Priority support'],
  max: ['10 concurrent sessions', 'Standard + Pro modes', '160 hours compute / month', '160h free trial', 'Priority support'],
  unlimited: ['10 concurrent sessions', 'Standard + Pro modes', 'Unlimited compute', 'Dedicated support', 'Custom SLA'],
};

/** Lifeline stop icons */
const TIER_ICONS: Record<string, string> = {
  free: mdiGiftOutline,
  standard: mdiRocketLaunchOutline,
  advanced: mdiStarOutline,
  max: mdiFlash,
  unlimited: mdiAccountGroupOutline,
};

/** Ordered tier ids for lifeline rendering */
const TIER_ORDER = ['free', 'standard', 'advanced', 'max', 'unlimited'] as const;

/** Standard mode features for mode card */
const STANDARD_MODE_FEATURES: Array<{ icon: string; text: string }> = [
  { icon: mdiRocketLaunchOutline, text: 'Browser-based VS Code IDE' },
  { icon: mdiConsole, text: 'Full Linux terminal' },
  { icon: mdiFileDocumentOutline, text: 'File browser & editor' },
  { icon: mdiRobotOutline, text: '5 AI coding agents' },
  { icon: mdiCloudOutline, text: 'Persistent workspace' },
  { icon: mdiSync, text: 'R2 cloud sync' },
];

/** Pro mode features for mode card */
const PRO_MODE_FEATURES: Array<{ icon: string; text: string }> = [
  { icon: mdiWrenchOutline, text: 'Curated skills, rules & agents' },
  { icon: mdiBookOpenPageVariantOutline, text: 'Knowledge graph memory (MCP)' },
  { icon: mdiLayersTripleOutline, text: 'Multi-LLM orchestration' },
  { icon: mdiHeadCogOutline, text: 'Advanced AI workflows' },
];

const SubscribePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [tiers, setTiers] = createSignal<TierInfo[]>([]);
  const [isBlocked, setIsBlocked] = createSignal(false);
  const [isActive, setIsActive] = createSignal(false);
  const [turnstileReady, setTurnstileReady] = createSignal(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = createSignal('');
  const [subscribing, setSubscribing] = createSignal<string | null>(null);
  const [currency, setCurrency] = createSignal('USD');
  const [userEmail, setUserEmail] = createSignal('');
  const [currentTierId, setCurrentTierId] = createSignal<string | null>(null);
  const [globalMode, setGlobalMode] = createSignal<'default' | 'advanced'>('default');
  const [subscribePhase, setSubscribePhase] = createSignal<SubscribePhase>('home');
  const [selectedTierId, setSelectedTierId] = createSignal('advanced');

  let observer: MutationObserver | null = null;
  let tierPhaseRef: HTMLDivElement | undefined;

  onMount(async () => {
    try {
      const [status, tiersData] = await Promise.all([
        getAuthStatus(),
        getPublicTiers().catch((err) => { logger.error('getPublicTiers failed:', err); return { tiers: [] }; }),
      ]);

      if (status.currency) setCurrency(status.currency);
      if (status.email) setUserEmail(status.email);

      setTiers(tiersData.tiers as TierInfo[]);

      const tier = status.subscriptionTier ?? status.accessTier;

      if (tier === 'blocked') {
        setIsBlocked(true);
        setLoading(false);
        return;
      }

      if (status.hasSubscribed === true) {
        setIsActive(true);
        const ct = status.subscriptionTier ?? status.accessTier ?? 'advanced';
        setCurrentTierId(ct);
        // Default lifeline selection to current tier if it's in the public list
        if (TIER_ORDER.includes(ct as typeof TIER_ORDER[number])) {
          setSelectedTierId(ct);
        }
      }

      // Preload Turnstile script for pending users
      if (!status.hasSubscribed && status.turnstileSiteKey) {
        setTurnstileSiteKey(status.turnstileSiteKey);
        loadTurnstileScript();
      }
      if (!status.hasSubscribed && !status.turnstileSiteKey) {
        setTurnstileReady(true);
      }
    } catch (err) {
      logger.error('Failed to load subscribe page:', err);
      setError('Unable to load subscription options. Please try again.');
    }
    setLoading(false);
  });

  // Initialize Turnstile when tier phase renders for pending users
  createEffect(() => {
    if (subscribePhase() === 'tiers' && !isActive() && !turnstileReady()) {
      renderTurnstileWidget();
      startTurnstileWatch();
    }
  });

  // Scroll to top when entering tier phase
  createEffect(() => {
    if (subscribePhase() === 'tiers') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
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

  function renderTurnstileWidget() {
    const key = turnstileSiteKey();
    if (!key || !window.turnstile) return;
    const container = document.getElementById('turnstile-container');
    if (!container) return;
    // Clear any previous widget content before re-rendering
    const existing = container.querySelector('.cf-turnstile');
    if (existing) existing.innerHTML = '';
    window.turnstile.render('#turnstile-container .cf-turnstile', {
      sitekey: key,
      callback: () => setTurnstileReady(true),
    });
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
      renderTurnstileWidget();
      startTurnstileWatch();
    }
  }

  function formatPrice(cents: number | null, cur?: string): string {
    if (cents === null) return 'Contact';
    if (cents === 0) return 'Free';
    const code = cur ?? currency();
    const amount = (cents / 100).toFixed(0);
    switch (code) {
      case 'EUR': return `\u20AC${amount}`;
      case 'GBP': return `\u00A3${amount}`;
      case 'CHF': return `CHF ${amount}`;
      default: return `$${amount}`;
    }
  }

  function getGlobalModePrice(tier: TierInfo): string {
    if (globalMode() === 'advanced' && tier.advancedPriceMonthly != null) {
      return formatPrice(tier.advancedPriceMonthly);
    }
    return formatPrice(tier.priceMonthly);
  }

  function isFree(tier: TierInfo): boolean {
    if (globalMode() === 'advanced' && tier.advancedPriceMonthly != null) {
      return tier.advancedPriceMonthly === 0;
    }
    return tier.priceMonthly === 0;
  }

  function isContact(tier: TierInfo): boolean {
    return tier.priceMonthly === null;
  }

  function getTrialBadge(tier: TierInfo): string | null {
    const trialHours = tier.trialQuotaHours ?? tier.trialDays ?? 0;
    if (trialHours <= 0) return null;
    return `${trialHours}h free trial`;
  }

  /** Currently selected tier data */
  const selectedTier = createMemo(() =>
    tiers().find(t => t.id === selectedTierId()) ?? tiers()[0] ?? null
  );

  /** Whether selected tier supports Pro mode */
  const selectedTierSupportsPro = createMemo(() => {
    const t = selectedTier();
    return t ? t.sessionModes.includes('advanced') : true;
  });

  // Force Standard mode when selected tier doesn't support Pro
  createEffect(() => {
    if (!selectedTierSupportsPro() && globalMode() === 'advanced') {
      setGlobalMode('default');
    }
  });

  /** Scramble animations for text that changes on tier/mode switch */
  const scrambledName = useScrambleText(() => selectedTier()?.displayName ?? '');
  const scrambledPrice = useScrambleText(() => {
    const t = selectedTier();
    return t ? getGlobalModePrice(t) : '';
  });
  const scrambledSpecs = useScrambleText(() => {
    const t = selectedTier();
    if (!t) return '';
    const hours = t.monthlySeconds !== null ? formatDuration(t.monthlySeconds!) : 'Unlimited';
    const sessions = `${t.maxSessions} ${t.maxSessions === 1 ? 'session' : 'sessions'}`;
    return `${hours} / month  ·  ${sessions}`;
  });

  /** Scramble animations for Pro mode expand */
  const scrambledProLabel = useScrambleText(
    () => globalMode() === 'advanced' ? '+ Pro features' : '',
  );
  const scrambledProFeatures = PRO_MODE_FEATURES.map((f) =>
    useScrambleText(() => globalMode() === 'advanced' ? f.text : ''),
  );

  /** Lifeline fill percentage (0% = first stop, 100% = last stop) */
  const lifelineProgress = createMemo(() => {
    const idx = TIER_ORDER.indexOf(selectedTierId() as typeof TIER_ORDER[number]);
    if (idx < 0) return 0;
    return (idx / (TIER_ORDER.length - 1)) * 100;
  });

  /** Content width: wide for mode and tier phases */
  const contentClass = () => {
    return subscribePhase() === 'tiers' ? 'login-content subscribe-content' : 'login-content';
  };

  /** CTA button label */
  function ctaLabel(): string {
    const tier = selectedTier();
    if (!tier) return 'Select';
    if (subscribing() === tier.id) return isActive() ? 'Switching...' : 'Subscribing...';
    if (isActive() && tier.id === currentTierId()) return 'Current Plan';
    if (isActive()) return 'Switch Plan';
    if (isFree(tier)) return 'Get Started';
    return 'Start Trial';
  }

  /** CTA disabled state */
  function ctaDisabled(): boolean {
    const tier = selectedTier();
    if (!tier) return true;
    if (subscribing() !== null) return true;
    if (isActive() && tier.id === currentTierId()) return true;
    if (!isActive() && !turnstileReady()) return true;
    return false;
  }

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

        <Show when={!loading()} fallback={<div class="subscribe-loading">Loading...</div>}>
          {/* Error display */}
          <Show when={error()}>
            <div class="subscribe-error">{error()}</div>
          </Show>

          {/* Blocked */}
          <Show when={isBlocked()}>
            <div class="subscribe-status">
              <div class="subscribe-status-icon subscribe-status-icon--blocked">
                <svg viewBox="0 0 24 24" width="32" height="32"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z"/></svg>
              </div>
              <h2 class="subscribe-title">Account Blocked</h2>
              <p class="subscribe-message">Your account has been blocked. Contact an administrator for help.</p>
            </div>
          </Show>

          {/* Main flow (active + pending) */}
          <Show when={!isBlocked()}>

            {/* ── Home view ── */}
            <Show when={subscribePhase() === 'home'}>
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
                onClick={() => setSubscribePhase('tiers')}
              >
                See subscription plans
              </button>
            </Show>

            {/* ── Tier selection: mode cards + lifeline + detail — all visible ── */}
            <Show when={subscribePhase() === 'tiers'}>
              <div ref={tierPhaseRef}>
                {/* Merged mode card with Standard/Pro toggle */}
                <div class="subscribe-mode-card-merged" data-testid="mode-chooser">
                  {/* Mode toggle at top */}
                  <div class="subscribe-mode-toggle">
                    <button
                      type="button"
                      class="subscribe-mode-toggle-btn"
                      classList={{ 'subscribe-mode-toggle-btn--active': globalMode() === 'default' }}
                      data-testid="mode-card-standard"
                      onClick={() => setGlobalMode('default')}
                    >
                      Standard
                    </button>
                    <button
                      type="button"
                      class="subscribe-mode-toggle-btn"
                      classList={{
                        'subscribe-mode-toggle-btn--active': globalMode() === 'advanced',
                        'subscribe-mode-toggle-btn--disabled': !selectedTierSupportsPro(),
                      }}
                      data-testid="mode-card-pro"
                      disabled={!selectedTierSupportsPro()}
                      onClick={() => {
                        if (!selectedTierSupportsPro()) return;
                        setGlobalMode('advanced');
                      }}
                    >
                      Pro
                    </button>
                  </div>

                  {/* Standard features (always visible) */}
                  <ul class="subscribe-mode-card-features">
                    <For each={STANDARD_MODE_FEATURES}>
                      {(f) => (
                        <li class="subscribe-mode-card-feature">
                          <Icon path={f.icon} size={16} />
                          <span>{f.text}</span>
                        </li>
                      )}
                    </For>
                  </ul>

                  {/* Pro features (animated expand/collapse) */}
                  <div class={`subscribe-pro-expand ${globalMode() === 'advanced' ? 'subscribe-pro-expand--open' : ''}`}>
                    <div class="subscribe-pro-expand-inner">
                      <div class="subscribe-mode-separator" />
                      <p class="subscribe-mode-pro-label">{scrambledProLabel()}</p>
                      <ul class="subscribe-mode-card-features subscribe-mode-card-features--pro">
                        <For each={PRO_MODE_FEATURES}>
                          {(f, i) => (
                            <li class="subscribe-mode-card-feature">
                              <Icon path={f.icon} size={16} />
                              <span>{scrambledProFeatures[i()]()}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Lifeline — straight dotted line through icon centers */}
                <div class="subscribe-lifeline" data-testid="lifeline-rail">
                  <svg class="subscribe-lifeline-svg" viewBox="0 0 500 4" preserveAspectRatio="none">
                    {/* Background: dotted line */}
                    <line
                      x1="50" y1="2" x2="450" y2="2"
                      stroke="rgba(255,255,255,0.15)" stroke-width="2"
                      stroke-dasharray="2 6" stroke-linecap="round"
                    />
                    {/* Active fill */}
                    <line
                      x1="50" y1="2" x2="450" y2="2"
                      stroke="#3b82f6" stroke-width="2"
                      stroke-dasharray="2 6" stroke-linecap="round"
                      clip-path={`inset(0 ${100 - lifelineProgress()}% 0 0)`}
                      style={{ transition: 'clip-path 400ms ease' }}
                    />
                  </svg>
                  <div class="subscribe-lifeline-stops">
                    <For each={[...TIER_ORDER]}>
                      {(tierId) => {
                        const tierData = () => tiers().find(t => t.id === tierId);
                        return (
                          <Show when={tierData()}>
                            {(td) => (
                              <button
                                type="button"
                                class="subscribe-lifeline-stop"
                                classList={{
                                  'subscribe-lifeline-stop--selected': selectedTierId() === tierId,
                                  'subscribe-lifeline-stop--passed': TIER_ORDER.indexOf(tierId as typeof TIER_ORDER[number]) <= TIER_ORDER.indexOf(selectedTierId() as typeof TIER_ORDER[number]),
                                }}
                                onClick={() => setSelectedTierId(tierId)}
                                data-testid={`lifeline-stop-${tierId}`}
                              >
                                <span class="subscribe-lifeline-icon">
                                  <Icon path={TIER_ICONS[tierId] ?? mdiStarOutline} size={20} />
                                </span>
                                <span class="subscribe-lifeline-label">{td().displayName}</span>
                                <Show when={isActive() && currentTierId() === tierId}>
                                  <div class="subscribe-lifeline-you">
                                    <Icon path={mdiMenuUp} size={20} />
                                    <span>This is you</span>
                                  </div>
                                </Show>
                              </button>
                            )}
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                </div>

                {/* Detail panel for selected tier */}
                <Show when={selectedTier()} fallback={
                  <div class="subscribe-error">No subscription tiers available.</div>
                }>
                  {(tier) => (
                    <div class="subscribe-detail-panel" data-testid="tier-detail-panel">
                      <h3 class="subscribe-detail-name">{scrambledName()}</h3>
                      <div class="subscribe-detail-price">
                        <span class="subscribe-tier-price-amount">{scrambledPrice()}</span>
                        <Show when={!isFree(tier()) && !isContact(tier())}>
                          <span class="subscribe-tier-price-period">/mo</span>
                        </Show>
                      </div>
                      <Show when={tier().description}>
                        <p class="subscribe-detail-tagline">{tier().description}</p>
                      </Show>
                      <div class="subscribe-detail-specs">
                        <span>{scrambledSpecs()}</span>
                      </div>

                      <ul class="subscribe-tier-features">
                        <For each={TIER_FEATURES[tier().id] ?? []}>
                          {(feature) => (
                            <li class="subscribe-tier-feature-item">
                              <Icon path={mdiCheck} size={14} />
                              <span>{feature}</span>
                            </li>
                          )}
                        </For>
                      </ul>

                      <Show when={getTrialBadge(tier())}>
                        {(badge) => <div class="subscribe-tier-badge">{badge()}</div>}
                      </Show>

                      <button
                        type="button"
                        class="subscribe-tier-btn subscribe-tier-btn--primary"
                        disabled={ctaDisabled()}
                        onClick={() => void handleSubscribe(selectedTierId())}
                      >
                        {ctaLabel()}
                      </button>

                    </div>
                  )}
                </Show>

                {/* Turnstile (pending users only — outside detail panel so always in DOM) */}
                <Show when={!isActive()}>
                  <div class="subscribe-turnstile" id="turnstile-container" data-testid="turnstile-container">
                    <div class="cf-turnstile" data-sitekey={turnstileSiteKey()} data-callback="onTurnstileSuccess" />
                  </div>
                </Show>

                <button
                  type="button"
                  class="subscribe-logout-button"
                  onClick={() => setSubscribePhase('home')}
                >
                  Back
                </button>
              </div>
            </Show>
          </Show>
        </Show>

        <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: '#f38020' }}>Region: Earth</span></p>
      </div>
    </div>
  );
};

export default SubscribePage;
