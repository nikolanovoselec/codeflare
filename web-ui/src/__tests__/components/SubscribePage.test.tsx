import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@solidjs/testing-library';
import SubscribePage from '../../components/SubscribePage';

// Mock ScrambleText to avoid setInterval noise with fake timers
vi.mock('../../components/ScrambleText', () => ({
  default: (props: any) => <span>{props.text}</span>,
}));

// Mock the API client
vi.mock('../../api/client', () => ({
  getAuthStatus: vi.fn(),
  getPublicTiers: vi.fn(),
  subscribe: vi.fn(),
}));

import { getAuthStatus, getPublicTiers, subscribe } from '../../api/client';

const mockedGetAuthStatus = vi.mocked(getAuthStatus);
const mockedGetPublicTiers = vi.mocked(getPublicTiers);
const mockedSubscribe = vi.mocked(subscribe);

// Mock tiers with ALL required fields from TierObjectSchema:
// id, displayName, monthlySeconds, maxSessions, sessionModes, canLogin, order, isDefault, priceMonthly, trialQuotaHours, description
// Note: priceMonthly is in cents (formatPrice divides by 100)
const MOCK_PUBLIC_TIERS = [
  { id: 'free', displayName: 'Free', monthlySeconds: 7200, maxSessions: 1, priceMonthly: 0, advancedPriceMonthly: null, description: 'Get started for free', trialQuotaHours: 0, sessionModes: ['default'], canLogin: true, order: 2, isDefault: false },
  { id: 'standard', displayName: 'Starter', monthlySeconds: 144000, maxSessions: 3, priceMonthly: 1900, advancedPriceMonthly: 2400, description: 'For individual developers', trialQuotaHours: 40, sessionModes: ['default', 'advanced'], canLogin: true, order: 4, isDefault: true },
  { id: 'advanced', displayName: 'Advanced', monthlySeconds: 288000, maxSessions: 5, priceMonthly: 3900, advancedPriceMonthly: 4400, description: '', trialQuotaHours: 80, sessionModes: ['default', 'advanced'], canLogin: true, order: 5, isDefault: false },
  { id: 'max', displayName: 'Max', monthlySeconds: 576000, maxSessions: 10, priceMonthly: 6900, advancedPriceMonthly: 7400, description: 'For professional teams', trialQuotaHours: 160, sessionModes: ['default', 'advanced'], canLogin: true, order: 6, isDefault: false },
  { id: 'unlimited', displayName: 'Team', monthlySeconds: null, maxSessions: 10, priceMonthly: null, advancedPriceMonthly: null, description: 'Enterprise-grade access', trialQuotaHours: 0, sessionModes: ['default', 'advanced'], canLogin: true, order: 7, isDefault: false },
];

// Button text pattern: component renders "Get Started" (free) or "Start Trial" (paid)
const TIER_BTN_PATTERN = /get started|start trial/i;

describe('SubscribePage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default: pending user with NO turnstile key — buttons are enabled immediately
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
    mockedSubscribe.mockResolvedValue({ success: true, tier: 'free', trialDays: 0, onboardingComplete: false });

    // Mock window.location.href for redirect tests
    originalLocation = window.location;
    mockLocation = { href: '' };
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

  describe('Tier Selection', () => {
    it('should fetch public tiers and show 5 tier cards', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockedGetPublicTiers).toHaveBeenCalledTimes(1);
        // Tier names may appear multiple times (e.g., "Free" as name + price, "Unlimited" as name + hours)
        expect(screen.getAllByText('Free').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Starter').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Advanced').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Max').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Team').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should display tier prices on cards', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      // formatPrice: 0 -> "Free", 1900 -> "$19/mo", 6900 -> "$69/mo", null -> "Free"
      await waitFor(() => {
        expect(screen.getByText(/\$19/)).toBeInTheDocument();
        expect(screen.getByText(/\$69/)).toBeInTheDocument();
      });
    });

    it('should display features comparison section', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Standard Mode/i)).toBeInTheDocument();
        expect(screen.getByText(/Pro Mode/i)).toBeInTheDocument();
        expect(screen.getByText(/Terminal access/i)).toBeInTheDocument();
      });
    });

    it('should show a subscribe button per tier card', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
        expect(buttons.length).toBeGreaterThanOrEqual(5);
      });
    });
  });

  describe('Turnstile Verification', () => {
    it('should show Turnstile widget for pending users with turnstile key', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'pending',
        subscriptionTier: 'pending',
        role: 'user',
        turnstileSiteKey: '0xTESTKEY',
        requestedAt: null,
        onboardingComplete: false,
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });
    });

    it('should enable buttons immediately when no turnstile key is configured', async () => {
      // turnstileSiteKey: null -> turnstileReady set to true immediately
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
        buttons.forEach((button) => {
          expect(button).not.toBeDisabled();
        });
      });
    });
  });

  describe('Subscribe Action', () => {
    it('should call subscribe API when a tier card is clicked', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
        expect(buttons[0]).not.toBeDisabled();
      });

      // Click the first tier card's subscribe button (Free — "Get Started")
      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        // subscribe(tierId: string, turnstileToken: string)
        expect(mockedSubscribe).toHaveBeenCalledWith('free', '');
      });
    });

    it('should redirect to /app/onboarding after success when onboardingComplete=false', async () => {
      mockedSubscribe.mockResolvedValue({ success: true, tier: 'free', trialDays: 0, onboardingComplete: false });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
        expect(buttons[0]).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/onboarding');
      });
    });

    it('should redirect to /app/ after success when onboardingComplete=true', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'pending',
        subscriptionTier: 'pending',
        role: 'user',
        turnstileSiteKey: null,
        requestedAt: null,
        onboardingComplete: true,
      });
      mockedSubscribe.mockResolvedValue({ success: true, tier: 'free', trialDays: 0, onboardingComplete: true });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
        expect(buttons[0]).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/');
      });
    });
  });

  describe('Blocked State', () => {
    it('should show blocked message for blocked users', async () => {
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
    });

    it('should not show tier cards for blocked users', async () => {
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

      // No subscribe buttons should be visible for blocked users
      expect(screen.queryAllByRole('button', { name: TIER_BTN_PATTERN })).toHaveLength(0);
    });
  });

  describe('Active User', () => {
    it('should show active state with Continue button for already-subscribed users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Your Account is Active/)).toBeInTheDocument();
        expect(screen.getByText('Continue')).toBeInTheDocument();
      });
    });

    it('should show Continue button that links to /app/', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const continueLink = screen.getByText('Continue');
        expect(continueLink.closest('a')).toHaveAttribute('href', '/app/');
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

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
        expect(buttons[0]).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
      });
    });
  });

  describe('Navigation', () => {
    it('should have logout link', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const logoutLink = screen.getByText(/log\s*out/i);
        expect(logoutLink).toBeInTheDocument();
      });
    });
  });
});
