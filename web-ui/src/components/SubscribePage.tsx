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
  mdiSourceBranch,
  mdiLightningBolt,
  mdiCheck,
  mdiGiftOutline,
  mdiStarOutline,
  mdiFlash,
  mdiAccountGroupOutline,
  mdiConsole,
  mdiFileDocumentOutline,
  mdiRobotOutline,
  mdiSync,
  mdiWrenchOutline,
  mdiBookOpenPageVariantOutline,
  mdiHeadCogOutline,
  mdiCloudOutline,
  mdiTimerOutline,
  mdiShieldCheckOutline,
  mdiCallSplit,
  mdiInfinity,
  mdiShieldAccountOutline,
  mdiPuzzleOutline,
  mdiArrowUpBold,
  mdiMonitorMultiple,
  mdiTrendingUp,
  mdiClockFast,
  mdiMicrophonePlus,
  mdiAutorenew,
} from '@mdi/js';
import { getAuthStatus, getPublicTiers, subscribe, createCheckoutSession, createPortalSession, createSwitchSession, getBillingStatus } from '../api/client';
import { formatDuration } from '../lib/format';
import { logger } from '../lib/logger';
import ScrambleText from './ScrambleText';
import Icon from './Icon';
import { useScrambleText } from '../lib/use-scramble-text';
import { FEATURES } from '../lib/marketing-content';
import '../styles/subscribe-page.css';
import '../styles/login-page.css';

interface StripePrice {
  amount: number;
  currency: string;
}

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
  maxStorageBytes?: number | null;
  stripePrice?: StripePrice;
  stripeAdvancedPrice?: StripePrice;
}

type SubscribePhase = 'home' | 'tiers';


/** Per-tier feature bullets. Use '{sessions}' as placeholder — replaced at render
 *  time with the actual maxSessions value from tier config (admin-configurable). */
const TIER_FEATURES: Record<string, string[]> = {
  free: ['All agents, ready instantly', 'Persistent cloud storage', 'GitHub & Cloudflare deploy'],
  standard: ['Everything in Free', 'Unlocks Pro mode', 'Configurable idle timeout', 'Priority support'],
  advanced: ['Everything in Starter', 'Run {sessions} sessions at once', 'Work across parallel branches', 'Priority support'],
  max: ['Everything in Advanced', 'Run {sessions} sessions at once', '4x the compute of Starter', 'OpenClaw Integration'],
  unlimited: ['Everything in Max', 'Unlimited compute hours', 'Run {sessions} sessions at once', 'OpenClaw Integration', 'Dedicated support'],
};

/** Features that show a "COMING SOON" badge */
const COMING_SOON_FEATURES = new Set(['OpenClaw Integration']);

/** Per-feature icon mapping for tier detail panel */
const FEATURE_ICONS: Record<string, string> = {
  'All agents, ready instantly': mdiRobotOutline,
  'Persistent cloud storage': mdiCloudOutline,
  'GitHub & Cloudflare deploy': mdiSourceBranch,
  'Everything in Free': mdiArrowUpBold,
  'Everything in Starter': mdiArrowUpBold,
  'Everything in Advanced': mdiArrowUpBold,
  'Everything in Max': mdiArrowUpBold,
  'Unlocks Pro mode': mdiStarOutline,
  'Configurable idle timeout': mdiTimerOutline,
  'Priority support': mdiShieldCheckOutline,
  'Work across parallel branches': mdiCallSplit,
  '4x the compute of Starter': mdiLightningBolt,
  'OpenClaw Integration': mdiPuzzleOutline,
  'Unlimited compute hours': mdiInfinity,
  'Dedicated support': mdiShieldAccountOutline,
};

/** Resolve icon for a feature string — handles dynamic "Run N sessions" */
function getFeatureIcon(feature: string): string {
  if (/^Run \d+ sessions? at once$/.test(feature)) return mdiMonitorMultiple;
  return FEATURE_ICONS[feature] ?? mdiCheck;
}

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
const STANDARD_MODE_FEATURES: Array<{ icon: string; text: string | (() => JSX.Element) }> = [
  { icon: mdiRobotOutline, text: 'Choose your agent — or just use Bash' },
  { icon: mdiConsole, text: 'Full Linux terminal per session' },
  { icon: mdiSync, text: 'Persistent storage with auto-sync' },
  { icon: mdiSourceBranch, text: () => <><span style={{ color: '#3b82f6' }}>GitHub</span> & <span style={{ color: '#f38020' }}>Cloudflare</span> built in</> },
  { icon: mdiLightningBolt, text: 'Specialized skills to build & deploy' },
  { icon: mdiMicrophonePlus, text: 'Voice input — talk to your terminal' },
  { icon: mdiFileDocumentOutline, text: 'One click to start, zero to configure' },
];

/** Pro mode features for mode card */
const PRO_MODE_FEATURES: Array<{ icon: string; text: string }> = [
  { icon: mdiHeadCogOutline, text: 'Agent builds a knowledge graph' },
  { icon: mdiTrendingUp, text: 'Gets smarter every session' },
  { icon: mdiClockFast, text: 'Auto-prunes context over time' },
  { icon: mdiWrenchOutline, text: 'Curated skills, rules & agents' },
  { icon: mdiBookOpenPageVariantOutline, text: 'Advanced commands & workflows' },
  { icon: mdiAutorenew, text: 'Continuous skillset improvement' },
  { icon: mdiCallSplit, text: 'Built-in second opinion from other LLMs' },
  { icon: mdiRocketLaunchOutline, text: 'Never start from scratch again' },
];

const SubscribePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [checkoutPolling, setCheckoutPolling] = createSignal(false);
  const [error, setError] = createSignal('');
  const [tiers, setTiers] = createSignal<TierInfo[]>([]);
  const [isBlocked, setIsBlocked] = createSignal(false);
  const [isActive, setIsActive] = createSignal(false);
  const [turnstileReady, setTurnstileReady] = createSignal(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = createSignal('');
  const [subscribing, setSubscribing] = createSignal<string | null>(null);
  const [userEmail, setUserEmail] = createSignal('');
  const [currentTierId, setCurrentTierId] = createSignal<string | null>(null);
  const [globalMode, setGlobalMode] = createSignal<'default' | 'advanced'>('default');
  const [subscribePhase, setSubscribePhase] = createSignal<SubscribePhase>('home');
  const [selectedTierId, setSelectedTierId] = createSignal('advanced');
  const [trialUsed, setTrialUsed] = createSignal(false);
  const [currentMode, setCurrentMode] = createSignal<'default' | 'advanced'>('default');
  const [billingStatus, setBillingStatus] = createSignal<string | null>(null);
  const [portalLoading, setPortalLoading] = createSignal(false);
  const [capacityReached, setCapacityReached] = createSignal(false);
  const [contactSent, setContactSent] = createSignal(false);
  const [showReportButton, setShowReportButton] = createSignal(false);

  let observer: MutationObserver | null = null;
  let tierPhaseRef: HTMLDivElement | undefined;
  let polling = true;
  let pollReportTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    polling = false;
    if (pollReportTimer) clearTimeout(pollReportTimer);
  });

  onMount(async () => {
    // Detect Stripe checkout redirect: ?checkout=success or ?checkout=canceled
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'canceled') {
      // User returned from Stripe without completing — reset button state
      window.history.replaceState({}, '', window.location.pathname);
      setSubscribing(null);
    }
    if (params.get('checkout') === 'success') {
      // Remove query param from URL without reload
      window.history.replaceState({}, '', window.location.pathname);
      setCheckoutPolling(true);
      // Poll until KV is updated. Stripe webhook writes KV,
      // we keep checking every 3 seconds until hasSubscribed is true.
      // After 5 minutes, show a "Report a problem" button.
      const POLL_INTERVAL = 3000;
      const REPORT_DELAY = 5 * 60 * 1000;
      pollReportTimer = setTimeout(() => setShowReportButton(true), REPORT_DELAY);
      while (polling) {
        try {
          const pollStatus = await getAuthStatus();
          if (pollStatus.hasSubscribed) {
            if (pollReportTimer) clearTimeout(pollReportTimer);
            window.location.href = pollStatus.onboardingComplete ? '/app/' : '/app/onboarding';
            return;
          }
        } catch { /* ignore poll errors */ }
        if (!polling) break;
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
      }
    }

    try {
      const [status, tiersData, billing] = await Promise.all([
        getAuthStatus(),
        getPublicTiers().catch((err) => { logger.error('getPublicTiers failed:', err); return { tiers: [] }; }),
        getBillingStatus().catch(() => null),
      ]);

      if (status.email) setUserEmail(status.email);

      setTiers(tiersData.tiers as TierInfo[]);

      const tier = status.subscriptionTier ?? status.accessTier;

      if (tier === 'blocked') {
        setIsBlocked(true);
        setLoading(false);
        return;
      }

      // Stripe is source of truth for paid subscriptions, but admin-managed tiers
      // (unlimited) have no Stripe subscription. Use KV hasSubscribed as fallback
      // when billing endpoint returns no subscription or is unavailable.
      const stripeActive = billing && !!billing.stripeSubscriptionId && !!billing.billingStatus;
      const hasActiveSubscription = stripeActive || status.hasSubscribed === true;

      if (hasActiveSubscription) {
        setIsActive(true);
        const ct = status.subscriptionTier ?? status.accessTier ?? 'advanced';
        setCurrentTierId(ct);
        if (TIER_ORDER.includes(ct as typeof TIER_ORDER[number])) {
          setSelectedTierId(ct);
        }
      }

      setBillingStatus(billing?.billingStatus ?? status.billingStatus ?? null);
      if (status.userCapacityReached === true) {
        setCapacityReached(true);
      }

      if (status.trialUsed === true) {
        setTrialUsed(true);
      }

      // Use subscribedMode (from user record, set by subscribe endpoint) not
      // sessionMode (from preferences, changed by Settings toggle). The subscribe
      // page shows what the user PAID for, not what they last toggled in Settings.
      const mode = status.subscribedMode ?? status.sessionMode ?? 'default';
      setCurrentMode(mode);
      setGlobalMode(mode);

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

  // Scroll to top when entering tier phase. Skip in jsdom (test environment)
  // because jsdom logs a "Not implemented: Window.scrollTo" warning every call.
  createEffect(() => {
    if (subscribePhase() !== 'tiers') return;
    if (typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom')) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const mode = globalMode() === 'advanced' ? 'advanced' : 'default';
    setSubscribing(tierId);
    setError('');

    try {
      // Free tier: existing direct subscribe flow
      // Paid tiers: redirect to Stripe Checkout
      const tierData = tiers().find(t => t.id === tierId);
      const isPaid = tierData && (
        mode === 'advanced'
          ? !!(tierData.stripeAdvancedPrice || tierData.stripePrice) || (tierData.advancedPriceMonthly ?? tierData.priceMonthly ?? 0) > 0
          : !!tierData.stripePrice || (tierData.priceMonthly ?? 0) > 0
      );

      if (isPaid && isActive()) {
        // Existing subscriber switching plans — deep-link to portal confirmation page
        try {
          const { portalUrl } = await createSwitchSession(tierId, mode);
          window.location.href = portalUrl;
          return;
        } catch {
          // Subscription no longer exists on Stripe — backend cleaned KV.
          // Fall through to checkout for re-subscription.
          setIsActive(false);
        }
      }
      if (isPaid) {
        const { checkoutUrl } = await createCheckoutSession(tierId, mode);
        window.location.href = checkoutUrl;
      } else {
        const result = await subscribe(tierId, token, mode);
        if (!result.onboardingComplete) {
          window.location.href = '/app/onboarding';
        } else {
          window.location.href = '/app/';
        }
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

  /** Format a Stripe price for display (e.g., "CHF 29", "$49", "€49"). */
  function formatStripePrice(price: StripePrice): string {
    const amount = (price.amount / 100).toFixed(0);
    switch (price.currency) {
      case 'CHF': return `CHF ${amount}`;
      case 'EUR': return `\u20AC${amount}`;
      case 'GBP': return `\u00A3${amount}`;
      default: return `$${amount}`;
    }
  }

  /** Get display price for the selected tier + mode, or null if free/contact/no Stripe data. */
  function getDisplayPrice(tier: TierInfo): string | null {
    const price = globalMode() === 'advanced' ? tier.stripeAdvancedPrice : tier.stripePrice;
    if (price) return formatStripePrice(price);
    // Fallback to config price if no Stripe data
    const cents = globalMode() === 'advanced'
      ? (tier.advancedPriceMonthly ?? tier.priceMonthly)
      : tier.priceMonthly;
    if (cents != null && cents > 0) return `$${(cents / 100).toFixed(0)}`;
    return null; // free or contact — no price shown
  }

  function isFree(tier: TierInfo): boolean {
    if (globalMode() === 'advanced' && tier.advancedPriceMonthly != null) {
      return tier.advancedPriceMonthly === 0;
    }
    return tier.priceMonthly === 0;
  }

  function getTrialBadge(tier: TierInfo): string | null {
    if (trialUsed()) return null;
    // CF-021: Trial is always in usage hours — trialDays fallback removed
    const trialHours = tier.trialQuotaHours ?? 0;
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
  const scrambledSpecs = useScrambleText(() => {
    const t = selectedTier();
    if (!t) return '';
    const hours = t.monthlySeconds !== null ? formatDuration(t.monthlySeconds!) : 'Unlimited';
    const sessions = `${t.maxSessions} parallel ${t.maxSessions === 1 ? 'session' : 'sessions'}`;
    const storageBytes = t.maxStorageBytes;
    const storage = storageBytes != null
      ? (storageBytes >= 1073741824 ? `${(storageBytes / 1073741824).toFixed(0)} GB` : `${Math.round(storageBytes / 1048576)} MB`)
      : 'Unlimited';
    return `${hours} / month  ·  ${sessions}  ·  ${storage} storage`;
  });
  const scrambledTagline = useScrambleText(() => selectedTier()?.description ?? '');
  const scrambledPrice = useScrambleText(() => {
    const t = selectedTier();
    if (!t) return '';
    return getDisplayPrice(t) ?? '';
  });
  const scrambledTrialBadge = useScrambleText(() => {
    const t = selectedTier();
    if (!t) return '';
    return getTrialBadge(t) ?? '';
  });
  // Max 5 feature bullets per tier — create 5 scramble slots
  // Replace {sessions} placeholder with actual maxSessions from tier config
  const scrambledFeatures = Array.from({ length: 5 }, (_, idx) =>
    useScrambleText(() => {
      const t = selectedTier();
      if (!t) return '';
      const raw = (TIER_FEATURES[t.id] ?? [])[idx] ?? '';
      return raw.replace('{sessions}', String(t.maxSessions));
    }),
  );

  /** Scramble animations for Pro mode expand */
  const scrambledProLabel = useScrambleText(
    () => globalMode() === 'advanced' ? '+ Pro features' : '',
  );
  const scrambledProFeatures = PRO_MODE_FEATURES.map((f) =>
    useScrambleText(() => globalMode() === 'advanced' ? f.text : ''),
  );


  /** Content width: wide for mode and tier phases */
  const contentClass = () => {
    return subscribePhase() === 'tiers' ? 'login-content subscribe-content' : 'login-content';
  };

  /** Whether the user changed mode but not tier */
  const isModeChange = () => isActive() && selectedTierId() === currentTierId() && globalMode() !== currentMode();

  /** Whether selected tier is the contact-us (Team/unlimited) tier */
  const isContactTier = () => selectedTierId() === 'unlimited';

  /** CTA button label */
  function ctaLabel(): string {
    const tier = selectedTier();
    if (!tier) return 'Select';
    if (isContactTier()) return contactSent() ? "We'll be in touch" : "Let's talk";
    if (subscribing() === tier.id) return isActive() ? 'Switching...' : 'Subscribing...';
    if (isModeChange()) return globalMode() === 'advanced' ? 'Upgrade to Pro' : 'Switch to Standard';
    if (isActive() && tier.id === currentTierId()) return 'Current Plan';
    if (isActive()) return 'Switch Plan';
    if (isFree(tier)) return 'Get Started';
    return trialUsed() ? 'Subscribe' : 'Start Trial';
  }

  /** CTA disabled state */
  function ctaDisabled(): boolean {
    const tier = selectedTier();
    if (!tier) return true;
    if (isContactTier()) return false; // always clickable
    if (subscribing() !== null) return true;
    if (capacityReached() && !isActive()) return true;
    if (isActive() && tier.id === currentTierId() && !isModeChange()) return true;
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
          An ephemeral IDE where AI coding agents reach their full potential.
          Fully autonomous. No boundaries. Zero risk.
        </p>

        <Show when={!loading()} fallback={
          <div class="subscribe-loading">
            {checkoutPolling() ? (
              <>
                <p><ScrambleText text="Activating your subscription — this may take a minute..." /></p>
                <Show when={showReportButton()}>
                  <a
                    href={`mailto:hello@graymatter.ch?subject=${encodeURIComponent('Subscription problem')}&body=${encodeURIComponent(`Hi,\n\nI completed a Stripe checkout but my subscription hasn't activated yet.\n\nEmail: ${userEmail()}\nDate: ${new Date().toISOString()}\n\nPlease help.\n`)}`}
                    class="subscribe-logout-button"
                    style={{ 'margin-top': '1rem', display: 'inline-block' }}
                  >
                    Report a problem
                  </a>
                </Show>
              </>
            ) : 'Loading...'}
          </div>
        }>
          {/* Error display */}
          <Show when={error()}>
            <div class="subscribe-error">{error()}</div>
          </Show>

          {/* Capacity reached */}
          <Show when={capacityReached() && !isActive()}>
            <div class="subscribe-error">Subscriptions are currently full. Please try again later.</div>
          </Show>

          {/* Blocked */}
          <Show when={isBlocked()}>
            <div class="subscribe-status">
              <span class="subscribe-status-text subscribe-status-text--blocked">Blocked</span>
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
                    <span class="subscribe-status-text subscribe-status-text--pending">Not Subscribed</span>
                    <Show when={userEmail()}>
                      <div class="subscribe-email">{userEmail()}</div>
                    </Show>
                  </>
                }>
                  <span class="subscribe-status-text subscribe-status-text--active">Subscribed</span>
                  <Show when={userEmail()}>
                    <div class="subscribe-email">{userEmail()}</div>
                  </Show>
                  <a href="/app/" class="subscribe-action-button">Continue</a>
                </Show>
              </div>

              <div class="subscribe-home-actions">
                <button
                  type="button"
                  class="subscribe-logout-button"
                  onClick={() => setSubscribePhase('tiers')}
                >
                  See subscription plans
                </button>
                <Show when={billingStatus()}>
                  <button
                    type="button"
                    class="subscribe-logout-button subscribe-manage-button"
                    disabled={portalLoading()}
                    onClick={async () => {
                      setPortalLoading(true);
                      try {
                        const { portalUrl } = await createPortalSession();
                        window.location.href = portalUrl;
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to open billing portal.');
                        setPortalLoading(false);
                      }
                    }}
                  >
                    {portalLoading() ? 'Loading...' : 'Manage Subscription'}
                  </button>
                  <p class="subscribe-portal-note">Changes may take a few minutes to activate.</p>
                </Show>
              </div>
            </Show>

            {/* ── Tier selection: detail panel → lifeline → mode section ── */}
            <Show when={subscribePhase() === 'tiers'}>
              <div ref={tierPhaseRef}>
                {/* Detail panel for selected tier — TOP */}
                <Show when={selectedTier()} fallback={
                  <div class="subscribe-error">No subscription tiers available.</div>
                }>
                  {(_tier) => (
                    <div class="subscribe-detail-panel" data-testid="tier-detail-panel">
                      <h3 class="subscribe-detail-name">{scrambledName()}</h3>
                      <Show when={scrambledPrice()}>
                        <div class="subscribe-detail-price">
                          <span class="subscribe-tier-price-amount">{scrambledPrice()}</span>
                          <span class="subscribe-tier-price-period">/mo</span>
                        </div>
                      </Show>
                      <Show when={scrambledTagline()}>
                        <p class="subscribe-detail-tagline">{scrambledTagline()}</p>
                      </Show>
                      <div class="subscribe-detail-specs">
                        <span>{(() => {
                          const text = scrambledSpecs();
                          // Colorize: hours in blue, "month" in orange, session count in green
                          const match = text.match(/^(.+?)\s*\/\s*(month\S*)\s*(·\s*)(\d+)(\s+parallel\s+.*)$/);
                          if (!match) {
                            // Fallback: try simpler hours/month split
                            const simple = text.match(/^(.+?)\s*\/\s*(month.*)$/);
                            if (!simple) return text;
                            return <>{<span style={{ color: '#3b82f6' }}>{simple[1]}</span>} / {<span style={{ color: '#f38020' }}>{simple[2]}</span>}</>;
                          }
                          const [, hours, month, sep, count, sessions] = match;
                          return <>{<span style={{ color: '#3b82f6' }}>{hours}</span>} / {<span style={{ color: '#f38020' }}>{month}</span>} {sep}{<span style={{ color: '#22c55e' }}>{count}</span>}{sessions}</>;
                        })()}</span>
                      </div>

                      <ul class="subscribe-tier-features">
                        <For each={scrambledFeatures}>
                          {(scrambled) => (
                            <Show when={scrambled()}>
                              <li class="subscribe-tier-feature-item">
                                <Icon path={getFeatureIcon(scrambled())} size={14} />
                                <span>
                                  {scrambled()}
                                  {COMING_SOON_FEATURES.has(scrambled()) && (
                                    <span class="subscribe-coming-soon-badge">COMING SOON</span>
                                  )}
                                </span>
                              </li>
                            </Show>
                          )}
                        </For>
                      </ul>

                      <Show when={scrambledTrialBadge()}>
                        <div class="subscribe-tier-badge">{scrambledTrialBadge()}</div>
                      </Show>

                      <button
                        type="button"
                        class="subscribe-tier-btn subscribe-tier-btn--primary"
                        disabled={ctaDisabled() || contactSent()}
                        onClick={() => {
                          if (isContactTier()) {
                            setContactSent(true);
                            // Notify admins via Resend that user wants Team access
                            void fetch('/api/auth/contact-team', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                              body: JSON.stringify({ plan: selectedTier()?.displayName ?? 'Custom' }),
                            }).catch(() => {});
                            return;
                          }
                          void handleSubscribe(selectedTierId());
                        }}
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

                {/* Lifeline — CSS dashed line through icon centers */}
                <div class="subscribe-lifeline" data-testid="lifeline-rail">
                  <div class="subscribe-lifeline-track" />
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
                                <span class={`subscribe-lifeline-icon ${isActive() && currentTierId() === tierId ? 'subscribe-lifeline-icon--current' : ''}`}>
                                  <Icon path={TIER_ICONS[tierId] ?? mdiStarOutline} size={20} />
                                </span>
                                <span class="subscribe-lifeline-label">{td().displayName}</span>
                              </button>
                            )}
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                </div>

                {/* Mode section — toggle + Pro card (animated) + Standard card */}
                <div class="subscribe-mode-section" data-testid="mode-chooser">
                  <div class="subscribe-mode-toggle">
                    <button
                      type="button"
                      class="subscribe-mode-toggle-btn"
                      classList={{
                        'subscribe-mode-toggle-btn--active': globalMode() === 'default',
                        'subscribe-mode-toggle-btn--current': isActive() && currentMode() === 'default',
                      }}
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
                        'subscribe-mode-toggle-btn--current': isActive() && currentMode() === 'advanced',
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

                  {/* Pro card — animates in above Standard */}
                  <div class={`subscribe-pro-expand ${globalMode() === 'advanced' ? 'subscribe-pro-expand--open' : ''}`}>
                    <div class="subscribe-pro-expand-inner">
                      <div class="subscribe-mode-card subscribe-mode-card--pro">
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
                        <p class="subscribe-mode-card-feature" style={{ "margin-top": "1rem", color: "rgba(113, 113, 122, 0.6)", display: "block" }}>
                          Pro features are designed for Claude Code. Other agents receive rules and agent definitions but may not support all capabilities.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Standard card — always visible */}
                  <div class="subscribe-mode-card subscribe-mode-card--standard">
                    <ul class="subscribe-mode-card-features">
                      <For each={STANDARD_MODE_FEATURES}>
                        {(f) => (
                          <li class="subscribe-mode-card-feature">
                            <Icon path={f.icon} size={16} />
                            <span>{typeof f.text === 'function' ? f.text() : f.text}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                    <p class="subscribe-mode-card-feature" style={{ "margin-top": "1rem", color: "rgba(113, 113, 122, 0.6)", display: "block" }}>
                      Voice input requires a compatible browser like Chrome or Samsung Internet.
                    </p>
                    <p class="subscribe-mode-card-feature" style={{ "margin-top": "0.5rem", color: "rgba(113, 113, 122, 0.6)", display: "block" }}>
                      Coding agent subscription is <span style={{ color: '#22c55e', "font-weight": "700" }}>NOT INCLUDED</span>, bring your own.
                    </p>
                  </div>
                </div>

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
        <p class="login-footer login-footer-legal"><a href="https://graymatter.ch" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', 'text-decoration': 'none' }}>&copy; 2026 Gray Matter GmbH</a></p>
      </div>
    </div>
  );
};

export default SubscribePage;
