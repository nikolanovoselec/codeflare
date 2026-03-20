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

/** Navigate from home to tier view (mode cards + lifeline + detail — all visible) */
async function openTierView() {
  render(() => <SubscribePage />);
  await vi.advanceTimersByTimeAsync(0);
  await waitFor(() => {
    expect(screen.getByText(/See subscription tiers/i)).toBeInTheDocument();
  });
  fireEvent.click(screen.getByText(/See subscription tiers/i));
  await waitFor(() => {
    expect(screen.getByTestId('mode-chooser')).toBeInTheDocument();
    expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
  });
}

describe('SubscribePage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

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

  describe('Home View', () => {
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
        expect(document.querySelector('.subscribe-status-icon--pending')).toBeInTheDocument();
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
        expect(document.querySelector('.subscribe-status-icon--active')).toBeInTheDocument();
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
      expect(screen.queryByText(/See subscription tiers/i)).not.toBeInTheDocument();
    });
  });

  describe('Mode Cards + Lifeline (single page)', () => {
    it('should render mode cards and lifeline together', async () => {
      await openTierView();

      expect(screen.getByTestId('mode-card-standard')).toBeInTheDocument();
      expect(screen.getByTestId('mode-card-pro')).toBeInTheDocument();
      expect(screen.getByTestId('lifeline-rail')).toBeInTheDocument();
    });

    it('Standard card shows feature bullets', async () => {
      await openTierView();

      expect(screen.getByText('Terminal')).toBeInTheDocument();
      expect(screen.getByText('File browser')).toBeInTheDocument();
    });

    it('Pro card shows feature bullets', async () => {
      await openTierView();

      expect(screen.getByText('Knowledge graph')).toBeInTheDocument();
      expect(screen.getByText('Multi-LLM')).toBeInTheDocument();
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
        expect(screen.getByText(/Ready to code in seconds/)).toBeInTheDocument();
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

    it('detail panel shows tier price', async () => {
      await openTierView();

      await waitFor(() => {
        expect(screen.getByText(/\$39/)).toBeInTheDocument();
      });
    });

    it('clicking Pro mode card changes prices', async () => {
      await openTierView();

      fireEvent.click(screen.getByTestId('mode-card-pro'));

      await waitFor(() => {
        // Price should update to advanced pricing ($44 for Advanced tier)
        expect(screen.getByText(/\$44/)).toBeInTheDocument();
      });
    });

    it('shows "This is you" for active users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
        hasSubscribed: true,
      });

      await openTierView();

      await waitFor(() => {
        expect(screen.getByText('This is you')).toBeInTheDocument();
      });
    });

    it('does NOT show "This is you" for pending users', async () => {
      await openTierView();
      expect(screen.queryByText('This is you')).not.toBeInTheDocument();
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
        expect(mockedSubscribe).toHaveBeenCalledWith('free', '');
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
        expect(screen.getByText(/Ready to code in seconds/)).toBeInTheDocument();
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

  describe('Navigation', () => {
    it('should not have logout link', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.queryByText(/log\s*out/i)).not.toBeInTheDocument();
      });
    });
  });
});
