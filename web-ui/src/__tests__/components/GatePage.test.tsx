import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import GatePage from '../../components/GatePage';

// Mock the API client
vi.mock('../../api/client', () => ({
  getAuthStatus: vi.fn(),
}));

import { getAuthStatus } from '../../api/client';

const mockedGetAuthStatus = vi.mocked(getAuthStatus);

describe('GatePage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default: pending user
    mockedGetAuthStatus.mockResolvedValue({
      email: 'user@example.com',
      accessTier: 'pending',
      role: 'user',
    });

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

  describe('Pending State', () => {
    it('should show "Account Pending Approval" message', async () => {
      render(() => <GatePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/account pending approval/i)).toBeInTheDocument();
      });
    });

    it('should show email from auth status', async () => {
      render(() => <GatePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText('user@example.com')).toBeInTheDocument();
      });
    });
  });

  describe('Auto-redirect', () => {
    it('should auto-redirect to /app/ when status becomes active', async () => {
      // First call: pending, second call: active
      mockedGetAuthStatus
        .mockResolvedValueOnce({
          email: 'user@example.com',
          accessTier: 'pending',
          role: 'user',
        })
        .mockResolvedValueOnce({
          email: 'user@example.com',
          accessTier: 'standard',
          role: 'user',
        });

      render(() => <GatePage />);

      // Wait for initial render with pending state
      await waitFor(() => {
        expect(screen.getByText(/account pending approval/i)).toBeInTheDocument();
      });

      // Advance timer to trigger next poll (10 seconds)
      await vi.advanceTimersByTimeAsync(10_000);

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
        role: 'user',
      });

      render(() => <GatePage />);

      // Flush the initial async fetchStatus call
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Account Blocked/)).toBeInTheDocument();
      });
    });
  });

  describe('Navigation', () => {
    it('should have logout link to /auth/logout', async () => {
      render(() => <GatePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const logoutLink = screen.getByText(/log\s*out/i);
        expect(logoutLink).toBeInTheDocument();
        expect(logoutLink.closest('a')).toHaveAttribute('href', '/auth/logout');
      });
    });
  });

  describe('Polling', () => {
    it('should poll every 10 seconds', async () => {
      render(() => <GatePage />);

      // Wait for initial fetch
      await waitFor(() => {
        expect(mockedGetAuthStatus).toHaveBeenCalledTimes(1);
      });

      // Advance 10 seconds for second poll
      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => {
        expect(mockedGetAuthStatus).toHaveBeenCalledTimes(2);
      });

      // Advance another 10 seconds for third poll
      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => {
        expect(mockedGetAuthStatus).toHaveBeenCalledTimes(3);
      });
    });
  });
});
