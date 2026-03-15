import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@solidjs/testing-library';
import SubscribePage from '../../components/SubscribePage';

// Mock the API client
vi.mock('../../api/client', () => ({
  getAuthStatus: vi.fn(),
  requestAccess: vi.fn(),
}));

import { getAuthStatus, requestAccess } from '../../api/client';

const mockedGetAuthStatus = vi.mocked(getAuthStatus);
const mockedRequestAccess = vi.mocked(requestAccess);

describe('SubscribePage', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default: pending user with turnstile key, no request yet
    mockedGetAuthStatus.mockResolvedValue({
      email: 'user@example.com',
      accessTier: 'pending',
      role: 'user',
      turnstileSiteKey: '0xTESTKEY',
      requestedAt: null,
    });

    mockedRequestAccess.mockResolvedValue({ success: true });

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

  describe('Pending State (no request yet)', () => {
    it('should show "Request Access" title for pending user', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Request Access/ })).toBeInTheDocument();
      });
    });

    it('should show email from auth status', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText('user@example.com')).toBeInTheDocument();
      });
    });

    it('should show Turnstile container when site key is present', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByTestId('turnstile-container')).toBeInTheDocument();
      });
    });

    it('should show disabled Request Access button until Turnstile validates', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const button = screen.getByRole('button', { name: /Request Access/ });
        expect(button).toBeInTheDocument();
        expect(button).toBeDisabled();
      });
    });

    it('should enable button after Turnstile token appears in DOM', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Request Access/ })).toBeDisabled();
      });

      // Simulate Turnstile widget creating a hidden input with token
      // MutationObserver fires synchronously in jsdom when DOM changes
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'test-token-123';
      container.appendChild(input);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Request Access/ })).not.toBeDisabled();
      });
    });

    it('should submit request with Turnstile token on button click', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Request Access/ })).toBeInTheDocument();
      });

      // Simulate Turnstile token — MutationObserver detects the DOM change
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'valid-token';
      container.appendChild(input);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Request Access/ })).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button', { name: /Request Access/ }));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(mockedRequestAccess).toHaveBeenCalledWith('valid-token');
      });
    });
  });

  describe('Pending State (request submitted)', () => {
    it('should show "Pending Approval" after successful request submission', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      // Simulate token + submit
      const container = screen.getByTestId('turnstile-container');
      const input = document.createElement('input');
      input.name = 'cf-turnstile-response';
      input.value = 'valid-token';
      container.appendChild(input);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Request Access/ })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /Request Access/ }));
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Pending Approval/)).toBeInTheDocument();
      });
    });

    it('should show "Pending Approval" when requestedAt is already set', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'pending',
        role: 'user',
        turnstileSiteKey: '0xTESTKEY',
        requestedAt: '2025-01-01T00:00:00Z',
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Pending Approval/)).toBeInTheDocument();
      });
    });

    it('should show polling indicator when waiting for approval', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'pending',
        role: 'user',
        turnstileSiteKey: '0xTESTKEY',
        requestedAt: '2025-01-01T00:00:00Z',
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Checking status/)).toBeInTheDocument();
      });
    });
  });

  describe('Active User', () => {
    it('should show active status for standard users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'active@example.com',
        accessTier: 'standard',
        role: 'user',
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Your Access is Active/)).toBeInTheDocument();
        expect(screen.getByText('Continue')).toBeInTheDocument();
        expect(mockLocation.href).toBe('');
      });
    });

    it('should show active status for advanced users', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'admin@example.com',
        accessTier: 'advanced',
        role: 'admin',
      });

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Your Access is Active/)).toBeInTheDocument();
        expect(screen.getByText('Continue')).toBeInTheDocument();
        expect(mockLocation.href).toBe('');
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

      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        expect(screen.getByText(/Account Blocked/)).toBeInTheDocument();
      });
    });
  });

  describe('Active user view', () => {
    it('should show active status with Continue button when approved during polling', async () => {
      mockedGetAuthStatus
        .mockResolvedValueOnce({
          email: 'user@example.com',
          accessTier: 'pending',
          role: 'user',
          turnstileSiteKey: '0xTESTKEY',
          requestedAt: '2025-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({
          email: 'user@example.com',
          accessTier: 'standard',
          role: 'user',
        });

      render(() => <SubscribePage />);

      await waitFor(() => {
        expect(screen.getByText(/Pending Approval/)).toBeInTheDocument();
      });

      // Advance timer to trigger next poll (10 seconds)
      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => {
        expect(screen.getByText(/Your Access is Active/)).toBeInTheDocument();
        expect(screen.getByText('Continue')).toBeInTheDocument();
      });
    });
  });

  describe('Navigation', () => {
    it('should have logout link to /cdn-cgi/access/logout', async () => {
      render(() => <SubscribePage />);
      await vi.advanceTimersByTimeAsync(0);

      await waitFor(() => {
        const logoutLink = screen.getByText(/log\s*out/i);
        expect(logoutLink).toBeInTheDocument();
        expect(logoutLink.closest('a')).toHaveAttribute('href', '/cdn-cgi/access/logout');
      });
    });
  });

  describe('Polling', () => {
    it('should poll every 10 seconds', async () => {
      render(() => <SubscribePage />);

      await waitFor(() => {
        expect(mockedGetAuthStatus).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => {
        expect(mockedGetAuthStatus).toHaveBeenCalledTimes(2);
      });

      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => {
        expect(mockedGetAuthStatus).toHaveBeenCalledTimes(3);
      });
    });
  });
});
