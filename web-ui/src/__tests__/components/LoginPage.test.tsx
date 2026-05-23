import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import LoginPage from '../../components/LoginPage';

// Mock the API client
vi.mock('../../api/client', () => ({
  getAuthProviders: vi.fn(),
  getAuthStatus: vi.fn(),
}));

import { getAuthProviders, getAuthStatus } from '../../api/client';

const mockedGetAuthProviders = vi.mocked(getAuthProviders);
const mockedGetAuthStatus = vi.mocked(getAuthStatus);

describe('LoginPage / REQ-AUTH-013 (branded SaaS login page)', () => {
  let mockLocation: { href: string };
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no active user, providers available
    mockedGetAuthStatus.mockRejectedValue(new Error('Not authenticated'));
    mockedGetAuthProviders.mockResolvedValue({
      providers: [{ id: 'github', type: 'github', name: 'GitHub' }],
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
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  describe('Loading State', () => {
    it('should show loading spinner initially', () => {
      // Never resolve so the component stays in loading state
      mockedGetAuthStatus.mockReturnValue(new Promise(() => {}));

      const { container } = render(() => <LoginPage />);

      const spinner = container.querySelector('.login-spinner');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('Provider Rendering', () => {
    it('should render provider buttons after loading', async () => {
      mockedGetAuthProviders.mockResolvedValue({
        providers: [{ id: 'github', type: 'github', name: 'GitHub' }],
      });

      render(() => <LoginPage />);

      await waitFor(() => {
        expect(screen.getByText('Continue with GitHub')).toBeInTheDocument();
      });
    });

    it('should show "No identity providers" error when providers empty', async () => {
      mockedGetAuthProviders.mockResolvedValue({ providers: [] });

      render(() => <LoginPage />);

      await waitFor(() => {
        expect(screen.getByText(/no identity providers/i)).toBeInTheDocument();
      });
    });
  });

  describe('Auth Status Redirects', () => {
    it('should redirect to /app/ if getAuthStatus returns active user', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        role: 'user',
      });

      render(() => <LoginPage />);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/');
      });
    });

    it('should redirect to /app/subscribe if getAuthStatus returns pending user', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'pending',
        subscriptionTier: 'pending',
        role: 'user',
      });

      render(() => <LoginPage />);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/subscribe');
      });
    });

    it('should show blocked message if getAuthStatus returns blocked user', async () => {
      mockedGetAuthStatus.mockResolvedValue({
        email: 'user@example.com',
        accessTier: 'blocked',
        subscriptionTier: 'blocked',
        role: 'user',
      });

      render(() => <LoginPage />);

      await waitFor(() => {
        expect(screen.getByText(/blocked/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should show error when provider fetch fails', async () => {
      mockedGetAuthProviders.mockRejectedValue(new Error('Network error'));

      render(() => <LoginPage />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });
    });
  });
});
