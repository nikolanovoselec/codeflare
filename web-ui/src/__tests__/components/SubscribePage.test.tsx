import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@solidjs/testing-library';
import SubscribePage from '../../components/SubscribePage';

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
  { id: 'free', displayName: 'Free', monthlySeconds: 3600, maxSessions: 1, priceMonthly: 0, description: 'Get started for free', trialDays: null },
  { id: 'standard', displayName: 'Standard', monthlySeconds: 36000, maxSessions: 3, priceMonthly: 10, description: '10 hours per month', trialDays: 7 },
  { id: 'advanced', displayName: 'Advanced', monthlySeconds: 72000, maxSessions: 5, priceMonthly: 25, description: '20 hours per month', trialDays: 7 },
  { id: 'max', displayName: 'Max', monthlySeconds: 180000, maxSessions: 10, priceMonthly: 50, description: '50 hours per month', trialDays: 7 },
];

describe('SubscribePage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default: pending user with turnstile key
    mockedGetAuthStatus.mockResolvedValue({
      email: 'user@example.com',
      accessTier: 'pending',
      subscriptionTier: 'pending',
      role: 'user',
      turnstileSiteKey: '0xTESTKEY',
      requestedAt: null,
      onboardingComplete: false,
    });

    mockedGetPublicTiers.mockResolvedValue({ tiers: MOCK_PUBLIC_TIERS });
    mockedSubscribe.mockResolvedValue({ success: true });

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
    it('should fetch public tiers and show 4 tier cards', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockedGetPublicTiers).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Free')).toBeInTheDocument();
        expect(screen.getByText('Standard')).toBeInTheDocument();
        expect(screen.getByText('Advanced')).toBeInTheDocument();
        expect(screen.getByText('Max')).toBeInTheDocument();
      });
    });

    it('should display tier prices on cards', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/\$0/)).toBeInTheDocument();
        expect(screen.getByText(/\$10/)).toBeInTheDocument();
        expect(screen.getByText(/\$25/)).toBeInTheDocument();
        expect(screen.getByText(/\$50/)).toBeInTheDocument();
      });
    });

    it('should display tier descriptions', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/get started for free/i)).toBeInTheDocument();
        expect(screen.getByText(/10 hours per month/i)).toBeInTheDocument();
      });
    });

    it('should show a subscribe button per tier card', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
        expect(buttons.length).toBeGreaterThanOrEqual(4);
      });
    });
  });

  describe('Turnstile Verification', () => {
    it('should show Turnstile widget for pending users', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });
    });

    it('should disable subscribe buttons until Turnstile is ready', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
        buttons.forEach((button) => {
          expect(button).toBeDisabled();
        });
      });
    });

    it('should enable subscribe buttons after Turnstile token appears', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });

      // Simulate Turnstile widget creating a hidden input with token
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'test-token-123';
      container.appendChild(input);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
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
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });

      // Simulate Turnstile token
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'valid-token';
      container.appendChild(input);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
        expect(buttons[0]).not.toBeDisabled();
      });

      // Click the first tier card's subscribe button (Free)
      const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
      fireEvent.click(buttons[0]);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockedSubscribe).toHaveBeenCalledWith(
          expect.objectContaining({ tierId: 'free' }),
          expect.any(String), // turnstile token
        );
      });
    });

    it('should redirect to /app/onboarding after success when onboardingComplete=false', async () => {
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

      // Simulate Turnstile token
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'valid-token';
      container.appendChild(input);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
        expect(buttons[0]).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
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
        turnstileSiteKey: '0xTESTKEY',
        requestedAt: null,
        onboardingComplete: true,
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });

      // Simulate Turnstile token
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'valid-token';
      container.appendChild(input);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
        expect(buttons[0]).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
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
      expect(screen.queryAllByRole('button', { name: /subscribe|select|choose|get started/i })).toHaveLength(0);
    });
  });

  describe('Active User', () => {
    it('should show active state with Continue button for already-subscribed users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
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
    it('should show error when fetching tiers fails', async () => {
      mockedGetPublicTiers.mockRejectedValue(new Error('Network error'));

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
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });

      // Simulate Turnstile token
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'valid-token';
      container.appendChild(input);

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
        expect(buttons[0]).not.toBeDisabled();
      });

      const buttons = screen.getAllByRole('button', { name: /subscribe|select|choose|get started/i });
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
