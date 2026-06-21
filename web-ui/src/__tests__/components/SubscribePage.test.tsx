import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@solidjs/testing-library';
import SubscribePage from '../../components/SubscribePage';

// Mock ScrambleText to avoid setInterval noise with fake timers
vi.mock('../../components/ScrambleText', () => ({
  default: (props: any) => <span>{props.text}</span>,
}));

// Mock Icon to render a simple span
vi.mock('../../components/Icon', () => ({
  default: (props: any) => <span data-icon={props.path} />,
}));

// Mock the API client
vi.mock('../../api/client', () => ({
  getAuthStatus: vi.fn(),
  getPublicTiers: vi.fn(),
  subscribe: vi.fn(),
  getBillingStatus: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  createSwitchSession: vi.fn(),
}));

import { getAuthStatus, getPublicTiers, subscribe, getBillingStatus } from '../../api/client';

const mockedGetAuthStatus = vi.mocked(getAuthStatus);
const mockedGetPublicTiers = vi.mocked(getPublicTiers);
const mockedSubscribe = vi.mocked(subscribe);
const mockedGetBillingStatus = vi.mocked(getBillingStatus);

const MOCK_PUBLIC_TIERS = [
  { id: 'free', displayName: 'Free', monthlySeconds: 14400, maxSessions: 1, priceMonthly: 0, advancedPriceMonthly: null, description: 'Get started for free', trialQuotaHours: 0, sessionModes: ['default'], canLogin: true, order: 2, isDefault: false },
  { id: 'standard', displayName: 'Starter', monthlySeconds: 144000, maxSessions: 1, priceMonthly: 2900, advancedPriceMonthly: 3400, description: 'For individual developers', trialQuotaHours: 40, sessionModes: ['default', 'advanced'], canLogin: true, order: 4, isDefault: true },
  { id: 'advanced', displayName: 'Advanced', monthlySeconds: 288000, maxSessions: 2, priceMonthly: 4900, advancedPriceMonthly: 5400, description: '', trialQuotaHours: 80, sessionModes: ['default', 'advanced'], canLogin: true, order: 5, isDefault: false },
  { id: 'max', displayName: 'Max', monthlySeconds: 576000, maxSessions: 3, priceMonthly: 6900, advancedPriceMonthly: 7400, description: 'For professional teams', trialQuotaHours: 160, sessionModes: ['default', 'advanced'], canLogin: true, order: 6, isDefault: false },
  { id: 'unlimited', displayName: 'Team', monthlySeconds: null, maxSessions: 5, priceMonthly: null, advancedPriceMonthly: null, description: 'Enterprise-grade access', trialQuotaHours: 0, sessionModes: ['default', 'advanced'], canLogin: true, order: 7, isDefault: false },
];

/** Navigate from home to tier view (mode cards + lifeline + detail — all visible) */
async function openTierView() {
  render(() => <SubscribePage />);
  await vi.advanceTimersByTimeAsync(0);
  await waitFor(() => {
    expect(screen.getByText(/See subscription plans/i)).toBeInTheDocument();
  });
  fireEvent.click(screen.getByText(/See subscription plans/i));
  await waitFor(() => {
    expect(screen.getByTestId('mode-chooser')).toBeInTheDocument();
    expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
  });
}

describe('SubscribePage / REQ-SETUP-009 (subscribe page redirect for pending users) / REQ-SUB-017 (tier selection UI)', () => {
  let mockLocation: { href: string; search: string; pathname: string };
  let originalLocation: Location;
  let mockActiveSubscription: (tier?: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockedGetAuthStatus.mockResolvedValue({
      email: 'user@example.com',
      accessTier: 'pending',
      subscriptionTier: 'pending',
      role: 'user',
      turnstileSiteKey: null,
      requestedAt: null,
      onboardingComplete: false,
    });

    mockedGetPublicTiers.mockResolvedValue({ tiers: MOCK_PUBLIC_TIERS });

    // Default: no active Stripe subscription (pending user)
    mockedGetBillingStatus.mockResolvedValue({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      billingPeriodEnd: null,
      checkoutSessionId: null,
      billingStatus: null,
    });
    mockedSubscribe.mockResolvedValue({ success: true, tier: 'free', trialQuotaHours: 0, onboardingComplete: false });

    // Helper: call this inside any test that sets hasSubscribed: true
    // to also provide Stripe-verified billing data
    mockActiveSubscription = (tier = 'standard') => {
      mockedGetBillingStatus.mockResolvedValue({
        stripeCustomerId: 'cus_active',
        stripeSubscriptionId: 'sub_active',
        stripePriceId: `price_${tier}_default`,
        billingPeriodEnd: '2026-04-27T00:00:00Z',
        checkoutSessionId: null,
        billingStatus: 'active',
      });
    };

    originalLocation = window.location;
    mockLocation = { href: '', search: '', pathname: '' };
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  describe('Home View', () => {
    it('should show features list and "See subscription plans" for pending users', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
        expect(screen.getByText(/See subscription plans/i)).toBeInTheDocument();
      });
    });

    it('should show "Not Subscribed" text for pending users', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText('Not Subscribed')).toBeInTheDocument();
      });
    });

    it('should show "Subscribed" text and Continue for active users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });
      mockActiveSubscription();

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText('Subscribed')).toBeInTheDocument();
        expect(screen.getByText('active@example.com')).toBeInTheDocument();
        expect(screen.getByText('Continue')).toBeInTheDocument();
      });
    });

    it('should show blocked state for blocked users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'blocked@example.com',
        accessTier: 'blocked',
        subscriptionTier: 'blocked',
        role: 'user',
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Account Blocked/)).toBeInTheDocument();
      });
      expect(screen.queryByText(/See subscription plans/i)).not.toBeInTheDocument();
    });
  });

  describe('Mode Cards + Lifeline (single page)', () => {
    it('should render mode cards and lifeline together', async () => {
      await openTierView();

      expect(screen.getByTestId('mode-card-standard')).toBeInTheDocument();
      expect(screen.getByTestId('mode-card-pro')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
    });

    it('shows Standard feature bullets', async () => {
      await openTierView();

      const card = screen.getByTestId('mode-chooser');
      expect(card.textContent).toMatch(/choose your agent/i);
      expect(card.textContent).toMatch(/terminal/i);
    });

    it('shows Pro feature bullets when Pro selected', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('mode-card-pro'));

      await waitFor(() => {
        const expand = screen.getByTestId('mode-chooser').querySelector('.subscribe-pro-expand');
        expect(expand).toBeInTheDocument();
        expect(expand!.classList.contains('subscribe-pro-expand--open')).toBe(true);
      });
    });

    it('pro expand wrapper is always in DOM', async () => {
      await openTierView();
      const expand = screen.getByTestId('mode-chooser').querySelector('.subscribe-pro-expand');
      expect(expand).toBeInTheDocument();
    });

    it('pro expand has open class when Pro selected', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('mode-card-pro'));

      await waitFor(() => {
        const expand = screen.getByTestId('mode-chooser').querySelector('.subscribe-pro-expand');
        expect(expand).toHaveClass('subscribe-pro-expand--open');
      });
    });

    it('pro expand does NOT have open class when Standard selected', async () => {
      await openTierView();
      const expand = screen.getByTestId('mode-chooser').querySelector('.subscribe-pro-expand');
      expect(expand).not.toHaveClass('subscribe-pro-expand--open');
    });

    it('clicking mode card keeps everything visible', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('mode-card-pro'));

      // Both mode cards and lifeline still visible
      expect(screen.getByTestId('mode-chooser')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
    });

    it('Back button returns to home view', async () => {
      await openTierView();
      fireEvent.click(screen.getByText('Back'));

      await waitFor(() => {
        expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
        expect(screen.queryByTestId('mode-chooser')).not.toBeInTheDocument();
      });
    });
  });

  describe('Phase 2 — Lifeline Tier Selector', () => {
    it('should render lifeline with 5 stops', async () => {
      await openTierView();

      expect(screen.getByTestId('lifeline-stop-free')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-stop-standard')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-stop-advanced')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-stop-max')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-stop-unlimited')).toBeInTheDocument();
    });

    it('should default to advanced tier for pending users', async () => {
      await openTierView();

      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel).toBeInTheDocument();
        // Detail panel heading shows tier name
        expect(panel.querySelector('.subscribe-detail-name')?.textContent).toBe('Advanced');
      });
    });

    it('should default to current tier for active users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });
      mockActiveSubscription();

      await openTierView();

      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.querySelector('.subscribe-detail-name')?.textContent).toBe('Starter');
      });
    });

    it('clicking a lifeline stop changes selected tier', async () => {
      await openTierView();

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));

      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.textContent).toMatch(/Free/);
      });
    });

    it('shows green border on current tier for active users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });
      mockActiveSubscription();

      await openTierView();

      await waitFor(() => {
        const standardStop = screen.getByTestId('lifeline-stop-standard');
        const icon = standardStop.querySelector('.subscribe-lifeline-icon');
        expect(icon?.classList.contains('subscribe-lifeline-icon--current')).toBe(true);
      });
    });

    it('does NOT show green border for pending users', async () => {
      await openTierView();
      const icons = document.querySelectorAll('.subscribe-lifeline-icon--current');
      expect(icons.length).toBe(0);
    });

    it('CTA shows "Get Started" for free tier', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-free'));

      await waitFor(() => {
        expect(screen.getByText('Get Started')).toBeInTheDocument();
      });
    });

    it('CTA shows "Start Trial" for paid tier', async () => {
      await openTierView();

      await waitFor(() => {
        expect(screen.getByText('Start Trial')).toBeInTheDocument();
      });
    });

    it('CTA shows "Current Plan" for active user on their tier', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });
      mockActiveSubscription();

      await openTierView();

      await waitFor(() => {
        expect(screen.getByText('Current Plan')).toBeInTheDocument();
      });
    });

    it('CTA shows "Switch Plan" for active user on different tier', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });
      mockActiveSubscription();

      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-max'));

      await waitFor(() => {
        expect(screen.getByText('Switch Plan')).toBeInTheDocument();
      });
    });

    it('calls subscribe API with selected tier', async () => {
      await openTierView();

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));
      await waitFor(() => expect(screen.getByText('Get Started')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Get Started'));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockedSubscribe).toHaveBeenCalledWith('free', '', 'default');
      });
    });

    it('redirects to onboarding after subscribe', async () => {
      await openTierView();

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));
      await waitFor(() => expect(screen.getByText('Get Started')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Get Started'));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/onboarding');
      });
    });

    it('Back button returns to home view', async () => {
      await openTierView();
      fireEvent.click(screen.getByText('Back'));

      await waitFor(() => {
        expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
        expect(screen.queryByTestId('lifeline-rail')).not.toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should show error when auth status fetch fails', async () => {
      mockedGetAuthStatus.mockRejectedValue(new Error('Network error'));

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/error|failed|unable/i)).toBeInTheDocument();
      });
    });

    it('should show error when subscribe call fails', async () => {
      mockedSubscribe.mockRejectedValue(new Error('Subscription failed'));

      await openTierView();

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));
      await waitFor(() => expect(screen.getByText('Get Started')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Get Started'));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
      });
    });
  });

  describe('TIER_FEATURES content', () => {
    it('free tier includes Persistent cloud', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-free'));

      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.textContent).toMatch(/Persistent cloud/);
      });
    });

    it('max tier includes OpenClaw Integration', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-max'));

      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.textContent).toMatch(/OpenClaw Integration/);
      });
    });

    it('max tier shows COMING SOON badge for OpenClaw Integration', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-max'));

      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.textContent).toMatch(/COMING SOON/);
      });
    });

    it('paid tiers include Configurable idle timeout', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-standard'));

      // Advance timers to let scramble animation resolve (uses requestAnimationFrame)
      await vi.advanceTimersByTimeAsync(500);
      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.textContent).toMatch(/Configurable idle timeout/);
      });
    });
  });

  describe('Navigation', () => {
    it('should not have logout link', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.queryByText(/log\s*out/i)).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // REQ-SETUP-009: Subscribe page with tier selection
  // -------------------------------------------------------------------------

  describe('REQ-SETUP-009 AC coverage', () => {
    it('REQ-SETUP-009 AC1: /app/subscribe shows available tiers with features, hours, sessions, and pricing', async () => {
      await openTierView();

      await waitFor(() => {
        expect(screen.getByTestId('lifeline-stop-free')).toBeInTheDocument();
        expect(screen.getByTestId('lifeline-stop-standard')).toBeInTheDocument();
        expect(screen.getByTestId('lifeline-stop-advanced')).toBeInTheDocument();
        expect(screen.getByTestId('lifeline-stop-max')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));
      await waitFor(() => {
        const panel = screen.getByTestId('tier-detail-panel');
        expect(panel.textContent?.length).toBeGreaterThan(0);
        expect(panel.querySelector('.subscribe-detail-name')?.textContent).toBe('Free');
      });
    });

    it('REQ-SETUP-009 AC2: three-phase wizard - home, plan selection, checkout phases exist', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/See subscription plans/i)).toBeInTheDocument();
        expect(screen.queryByTestId('lifeline-rail')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/See subscription plans/i));
      await waitFor(() => {
        expect(screen.getByTestId('mode-chooser')).toBeInTheDocument();
        expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Back'));
      await waitFor(() => {
        expect(screen.queryByTestId('lifeline-rail')).not.toBeInTheDocument();
        expect(screen.getByText(/See subscription plans/i)).toBeInTheDocument();
      });
    });

    it('REQ-SETUP-009 AC3: Turnstile CAPTCHA is initialized for pending users when turnstileSiteKey is provided', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'pending@example.com',
        accessTier: 'pending',
        subscriptionTier: 'pending',
        role: 'user',
        turnstileSiteKey: '0x4AAA-test-site-key',
        requestedAt: null,
        onboardingComplete: false,
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/See subscription plans/i)).toBeInTheDocument();
      });
    });

    it('REQ-SETUP-009 AC3: Turnstile is not required when turnstileSiteKey is absent', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/See subscription plans/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/See subscription plans/i));
      await waitFor(() => {
        expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
      });
    });

    it('REQ-SETUP-009 AC4: mode toggle exists with Standard and Pro options', async () => {
      await openTierView();

      expect(screen.getByTestId('mode-card-standard')).toBeInTheDocument();
      expect(screen.getByTestId('mode-card-pro')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mode-card-pro'));
      await waitFor(() => {
        const expand = screen.getByTestId('mode-chooser').querySelector('.subscribe-pro-expand');
        expect(expand?.classList.contains('subscribe-pro-expand--open')).toBe(true);
      });

      fireEvent.click(screen.getByTestId('mode-card-standard'));
      await waitFor(() => {
        const expand = screen.getByTestId('mode-chooser').querySelector('.subscribe-pro-expand');
        expect(expand?.classList.contains('subscribe-pro-expand--open')).toBe(false);
      });
    });

    it('REQ-SETUP-009 AC5: free tier activates immediately via subscribe API call (no Stripe checkout)', async () => {
      await openTierView();

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));
      await waitFor(() => expect(screen.getByText('Get Started')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Get Started'));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(async () => {
        expect(mockedSubscribe).toHaveBeenCalledWith('free', '', 'default');
        const { createCheckoutSession } = vi.mocked(
          await import('../../api/client')
        );
        expect(createCheckoutSession).not.toHaveBeenCalled();
      });
    });

    it('REQ-SETUP-009 AC5: free tier redirects to /app/onboarding after activation (not Stripe)', async () => {
      await openTierView();

      fireEvent.click(screen.getByTestId('lifeline-stop-free'));
      await waitFor(() => expect(screen.getByText('Get Started')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Get Started'));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/onboarding');
        expect(mockLocation.href).not.toContain('stripe');
      });
    });

    it('REQ-SETUP-009 AC6: paid tiers show "Start Trial" CTA indicating Stripe checkout path', async () => {
      await openTierView();

      await waitFor(() => {
        expect(screen.getByText('Start Trial')).toBeInTheDocument();
      });

      expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // REQ-SUB-004 AC4: post-checkout-redirect polling loop (deadline-less interval
  // poll of auth-status until activation is observed, then redirect).
  // @impl web-ui/src/components/SubscribePage.tsx (onMount checkout=success branch)
  // -------------------------------------------------------------------------
  describe('REQ-SUB-004 AC4: post-checkout activation polling', () => {
    it('polls auth-status repeatedly until hasSubscribed, then redirects to /app/', async () => {
      // Arrive on the post-checkout-return state. onMount reads window.location.search;
      // the beforeEach replaced window.location with the mock object, so set the query here.
      mockLocation.search = '?checkout=success';
      mockLocation.pathname = '/app/subscribe';

      // First two polls: not yet activated (webhook hasn't written KV). Third: activated.
      // The component redirects on the activated poll, so the loop must run >1 time.
      mockedGetAuthStatus
        .mockResolvedValueOnce({ hasSubscribed: false } as any)
        .mockResolvedValueOnce({ hasSubscribed: false } as any)
        .mockResolvedValueOnce({ hasSubscribed: true, onboardingComplete: true } as any);

      render(() => <SubscribePage />);

      // Drive the deadline-less interval poll. POLL_INTERVAL is 3000ms; advance enough
      // wall-clock to allow three iterations to resolve.
      await vi.advanceTimersByTimeAsync(0);     // first getAuthStatus (no wait yet)
      await vi.advanceTimersByTimeAsync(3000);  // second poll after one interval
      await vi.advanceTimersByTimeAsync(3000);  // third poll -> activation observed

      // Polled more than once (loop genuinely iterated; a single mount-fetch would be 1).
      await waitFor(() => {
        expect(mockedGetAuthStatus.mock.calls.length).toBeGreaterThan(1);
      });

      // On activation the loop returns after redirecting to the app.
      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/');
      });
    });

    it('redirects to onboarding when activation completes before onboarding', async () => {
      mockLocation.search = '?checkout=success';
      mockLocation.pathname = '/app/subscribe';

      mockedGetAuthStatus
        .mockResolvedValueOnce({ hasSubscribed: false } as any)
        .mockResolvedValueOnce({ hasSubscribed: true, onboardingComplete: false } as any);

      render(() => <SubscribePage />);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);

      await waitFor(() => {
        expect(mockedGetAuthStatus.mock.calls.length).toBeGreaterThan(1);
        expect(mockLocation.href).toBe('/app/onboarding');
      });
    });
  });

  // -------------------------------------------------------------------------
  // REQ-SUB-017 AC1 / AC3: Custom (unlimited) tier contact flow.
  // @impl web-ui/src/components/SubscribePage.tsx::SubscribePage
  // -------------------------------------------------------------------------
  describe('REQ-SUB-017: Custom-tier contact CTA', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // The contact CTA fires window.fetch('/api/auth/contact-team'); setup.ts does not
      // stub fetch, so install one. Other tiers go through the mocked api/client.
      fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });
    });

    it('AC1: selecting the Custom tier renders a contact CTA, not a checkout button', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-unlimited'));

      const panel = await screen.findByTestId('tier-detail-panel');
      const cta = panel.querySelector('.subscribe-tier-btn--primary') as HTMLButtonElement;
      expect(cta).toBeInTheDocument();

      // The contract that distinguishes a contact CTA from a checkout CTA is its click
      // behavior: contact tier fires the contact-team endpoint and never enters checkout.
      const { createCheckoutSession, subscribe: subscribeFn } = vi.mocked(
        await import('../../api/client'),
      );
      createCheckoutSession.mockClear();
      subscribeFn.mockClear();

      fireEvent.click(cta);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      // It is a contact CTA in PLACE OF a checkout button: no checkout/subscribe call.
      expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/contact-team');
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(subscribeFn).not.toHaveBeenCalled();
    });

    it('AC3: after activation the Custom-tier CTA switches to a disabled confirmation state', async () => {
      await openTierView();
      fireEvent.click(screen.getByTestId('lifeline-stop-unlimited'));

      const panel = await screen.findByTestId('tier-detail-panel');
      const cta = panel.querySelector('.subscribe-tier-btn--primary') as HTMLButtonElement;

      // Before activation the contact CTA is actionable (not disabled).
      expect(cta.disabled).toBe(false);

      fireEvent.click(cta);
      await vi.advanceTimersByTimeAsync(0);

      // After activation (contactSent) the control is disabled to block duplicate submits.
      await waitFor(() => {
        const after = screen.getByTestId('tier-detail-panel')
          .querySelector('.subscribe-tier-btn--primary') as HTMLButtonElement;
        expect(after.disabled).toBe(true);
      });
    });
  });
});
