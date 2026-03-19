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
}));

import { getAuthStatus, getPublicTiers, subscribe } from '../../api/client';

const mockedGetAuthStatus = vi.mocked(getAuthStatus);
const mockedGetPublicTiers = vi.mocked(getPublicTiers);
const mockedSubscribe = vi.mocked(subscribe);

const MOCK_PUBLIC_TIERS = [
  { id: 'free', displayName: 'Free', monthlySeconds: 7200, maxSessions: 1, priceMonthly: 0, advancedPriceMonthly: null, description: 'Get started for free', trialQuotaHours: 0, sessionModes: ['default'], canLogin: true, order: 2, isDefault: false },
  { id: 'standard', displayName: 'Starter', monthlySeconds: 144000, maxSessions: 3, priceMonthly: 1900, advancedPriceMonthly: 2400, description: 'For individual developers', trialQuotaHours: 40, sessionModes: ['default', 'advanced'], canLogin: true, order: 4, isDefault: true },
  { id: 'advanced', displayName: 'Advanced', monthlySeconds: 288000, maxSessions: 5, priceMonthly: 3900, advancedPriceMonthly: 4400, description: '', trialQuotaHours: 80, sessionModes: ['default', 'advanced'], canLogin: true, order: 5, isDefault: false },
  { id: 'max', displayName: 'Max', monthlySeconds: 576000, maxSessions: 10, priceMonthly: 6900, advancedPriceMonthly: 7400, description: 'For professional teams', trialQuotaHours: 160, sessionModes: ['default', 'advanced'], canLogin: true, order: 6, isDefault: false },
  { id: 'unlimited', displayName: 'Team', monthlySeconds: null, maxSessions: 10, priceMonthly: null, advancedPriceMonthly: null, description: 'Enterprise-grade access', trialQuotaHours: 0, sessionModes: ['default', 'advanced'], canLogin: true, order: 7, isDefault: false },
];

const TIER_BTN_PATTERN = /get started|start trial/i;

/** Helper: render, wait for load, click "See subscription tiers" to open tier view */
async function openTierView() {
  render(() => <SubscribePage />);
  await vi.advanceTimersByTimeAsync(0);
  await waitFor(() => {
    expect(screen.getByText(/See subscription tiers/i)).toBeInTheDocument();
  });
  fireEvent.click(screen.getByText(/See subscription tiers/i));
  await waitFor(() => {
    expect(screen.getByTestId('tier-grid')).toBeInTheDocument();
  });
}

describe('SubscribePage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default: pending user with NO turnstile key
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
    mockedSubscribe.mockResolvedValue({ success: true, tier: 'free', trialQuotaHours: 0, onboardingComplete: false });

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

  describe('Home View (all users)', () => {
    it('should show features list and "See subscription tiers" for pending users', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Ready to code in seconds/)).toBeInTheDocument();
        expect(screen.getByText(/See subscription tiers/i)).toBeInTheDocument();
      });
    });

    it('should show orange clock icon for pending users', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const pendingIcon = document.querySelector('.subscribe-status-icon--pending');
        expect(pendingIcon).toBeInTheDocument();
      });
    });

    it('should show green checkmark and Continue for active users', async () => {
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
        const activeIcon = document.querySelector('.subscribe-status-icon--active');
        expect(activeIcon).toBeInTheDocument();
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
      // No tier button for blocked users
      expect(screen.queryByText(/See subscription tiers/i)).not.toBeInTheDocument();
    });
  });

  describe('Tier View (shared layout)', () => {
    it('should show mode selector and tier cards after clicking "See subscription tiers"', async () => {
      await openTierView();

      expect(screen.getByTestId('mode-selector')).toBeInTheDocument();
      expect(screen.getAllByText('Free').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Starter').length).toBeGreaterThanOrEqual(1);
    });

    it('should show tier prices on cards', async () => {
      await openTierView();

      expect(screen.getByText(/\$19/)).toBeInTheDocument();
      expect(screen.getByText(/\$69/)).toBeInTheDocument();
    });

    it('should show subscribe buttons per tier card', async () => {
      await openTierView();

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      expect(buttons.length).toBeGreaterThanOrEqual(5);
    });

    it('should call subscribe API when a tier button is clicked', async () => {
      await openTierView();

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      expect(buttons[0]).not.toBeDisabled();
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockedSubscribe).toHaveBeenCalledWith('free', '');
      });
    });

    it('should redirect to /app/onboarding after subscribe', async () => {
      await openTierView();

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/onboarding');
      });
    });

    it('should go back to home view when "Back" is clicked', async () => {
      await openTierView();

      fireEvent.click(screen.getByText('Back'));

      await waitFor(() => {
        expect(screen.getByText(/Ready to code in seconds/)).toBeInTheDocument();
        expect(screen.queryByTestId('tier-grid')).not.toBeInTheDocument();
      });
    });
  });

  describe('Active User Tier View', () => {
    it('should show Current Plan and Switch Plan buttons', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });

      await openTierView();

      expect(screen.getByText('Current Plan')).toBeInTheDocument();
      expect(screen.getAllByText('Switch Plan').length).toBeGreaterThanOrEqual(1);
    });

    it('should show mode selector for active users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });

      await openTierView();

      expect(screen.getByTestId('mode-selector')).toBeInTheDocument();
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

      const buttons = screen.getAllByRole('button', { name: TIER_BTN_PATTERN });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/failed|error/i)).toBeInTheDocument();
      });
    });
  });

  describe('Navigation', () => {
    it('should not have logout link (logout is in username dropdown)', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.queryByText(/log\s*out/i)).not.toBeInTheDocument();
      });
    });
  });
});
