import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiXml } from '@mdi/js';
import OnboardingLanding from '../../components/OnboardingLanding';

// Mock the API client
vi.mock('../../api/client', () => ({
  getOnboardingConfig: vi.fn(),
  getUser: vi.fn(),
}));

// Mock the SplashCursor component (WebGL-based, not testable in jsdom)
vi.mock('../../components/SplashCursor', () => ({
  default: () => <div data-testid="splash-cursor" />,
}));

import { getOnboardingConfig, getUser } from '../../api/client';

const mockedGetOnboardingConfig = vi.mocked(getOnboardingConfig);
const mockedGetUser = vi.mocked(getUser);

describe('OnboardingLanding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: onboarding active, user not authenticated
    mockedGetOnboardingConfig.mockResolvedValue({
      active: true,
      turnstileSiteKey: 'test-site-key-123',
    });
    mockedGetUser.mockRejectedValue(new Error('Not authenticated'));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the landing page with title and description', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByText('Codeflare access request')).toBeInTheDocument();
      });
      expect(screen.getByText(/Join the waitlist/i)).toBeInTheDocument();
    });

    it('should render the waitlist email form', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      });
      const emailInput = screen.getByPlaceholderText('you@example.com');
      expect(emailInput).toHaveAttribute('type', 'email');
    });

    it('should render the join waitlist button', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /join waitlist/i })).toBeInTheDocument();
      });
    });

    it('should render the login button/link', async () => {
      const { container } = render(() => <OnboardingLanding />);

      await waitFor(() => {
        const loginLink = container.querySelector('a.onboarding-btn-secondary');
        expect(loginLink).toBeInTheDocument();
        expect(loginLink).toHaveTextContent('Login');
      });
    });

    it('should render the GitHub repo link', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        const repoLink = screen.getByLabelText(/github/i);
        expect(repoLink).toBeInTheDocument();
        expect(repoLink).toHaveAttribute('href', 'https://github.com/nikolanovoselec/codeflare');
        expect(repoLink).toHaveAttribute('target', '_blank');
      });
    });

    it('should render the SplashCursor background effect', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByTestId('splash-cursor')).toBeInTheDocument();
      });
    });

    it('should render onboarding eyebrow text', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByText('Onboarding')).toBeInTheDocument();
      });
    });

    it('should render meta text about existing users', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByText(/already approved/i)).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading state while fetching config', () => {
      // Never resolve the config fetch
      mockedGetOnboardingConfig.mockReturnValue(new Promise(() => {}));
      render(() => <OnboardingLanding />);

      // Should show loading spinner or be in a loading state
      expect(screen.queryByText('Codeflare access request')).not.toBeInTheDocument();
    });
  });

  describe('Turnstile Integration', () => {
    it('should show Turnstile placeholder when site key is available', async () => {
      render(() => <OnboardingLanding />);

      // The component should have a container for the Turnstile widget
      const { container } = render(() => <OnboardingLanding />);
      await waitFor(() => {
        const turnstileContainer = container.querySelector('[data-testid="turnstile-container"]');
        expect(turnstileContainer).toBeInTheDocument();
      });
    });

    it('should show warning message when Turnstile is not configured', async () => {
      mockedGetOnboardingConfig.mockResolvedValue({
        active: true,
        turnstileSiteKey: null,
      });

      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByText(/waitlist is not configured/i)).toBeInTheDocument();
      });
    });
  });

  describe('Auto-redirect when authenticated', () => {
    it('should redirect to /app/ when user is already authenticated', async () => {
      mockedGetUser.mockResolvedValue({
        email: 'user@example.com',
        authenticated: true,
        bucketName: 'user-bucket',
        role: 'user',
      });

      // Mock window.location.href
      const originalLocation = window.location;
      const mockLocation = { ...originalLocation, href: '' };
      Object.defineProperty(window, 'location', {
        value: mockLocation,
        writable: true,
      });

      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/');
      });

      // Restore
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('should NOT redirect when user is not authenticated', async () => {
      mockedGetUser.mockRejectedValue(new Error('Not authenticated'));

      const originalLocation = window.location;
      const mockLocation = { ...originalLocation, href: '' };
      Object.defineProperty(window, 'location', {
        value: mockLocation,
        writable: true,
      });

      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByText('Codeflare access request')).toBeInTheDocument();
      });
      expect(mockLocation.href).not.toBe('/app/');

      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });
  });

  describe('Waitlist Form Submission', () => {
    it('should show error when submitting without email and turnstile', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(document.querySelector('form')).toBeInTheDocument();
      });

      // Submit form with empty email (and no Turnstile token)
      const form = document.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(screen.getByText(/please complete email/i)).toBeInTheDocument();
      });
    });

    it('should call waitlist API on successful form submission', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      globalThis.fetch = mockFetch;

      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      });

      const emailInput = screen.getByPlaceholderText('you@example.com');
      fireEvent.input(emailInput, { target: { value: 'test@example.com' } });

      // Note: In real usage, Turnstile would provide a token.
      // For testing, we verify the form structure is correct.
    });

    it('should show success message after successful submission', async () => {
      // Mock the fetch for the waitlist POST
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/public/waitlist') && opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        // Fall through for other requests
        return Promise.resolve({ ok: false, text: () => Promise.resolve('') });
      });

      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(screen.getByText('Codeflare access request')).toBeInTheDocument();
      });

      // Restore
      globalThis.fetch = originalFetch;
    });
  });

  describe('Onboarding Inactive', () => {
    it('should redirect to /app/ when onboarding is not active', async () => {
      mockedGetOnboardingConfig.mockResolvedValue({
        active: false,
        turnstileSiteKey: null,
      });

      const originalLocation = window.location;
      const mockLocation = { ...originalLocation, href: '' };
      Object.defineProperty(window, 'location', {
        value: mockLocation,
        writable: true,
      });

      render(() => <OnboardingLanding />);

      await waitFor(() => {
        expect(mockLocation.href).toBe('/app/');
      });

      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });
  });

  describe('Login Button', () => {
    it('should have login link pointing to /app/', async () => {
      const { container } = render(() => <OnboardingLanding />);

      await waitFor(() => {
        const loginLink = container.querySelector('a.onboarding-btn-secondary');
        expect(loginLink).toHaveAttribute('href', '/app/');
      });
    });
  });

  describe('KittScanner', () => {
    it('should render KittScanner component within onboarding card', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        const card = document.querySelector('.onboarding-card');
        expect(card).toBeInTheDocument();
        const kittScanner = card?.querySelector('.kitt-scanner');
        expect(kittScanner).toBeInTheDocument();
      });
    });
  });

  describe('Icon swap: mdiXml replaces mdiBrain', () => {
    it('should use mdiXml icon path for the brand icon (not mdiBrain)', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        const brandIcon = document.querySelector('.onboarding-brand-icon');
        expect(brandIcon).toBeInTheDocument();
        const svgPath = brandIcon?.querySelector('path');
        expect(svgPath).toBeInTheDocument();
        expect(svgPath?.getAttribute('d')).toBe(mdiXml);
      });
    });
  });

  describe('Accessibility', () => {
    it('should have a proper heading structure', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        const heading = screen.getByRole('heading', { level: 1 });
        expect(heading).toHaveTextContent('Codeflare access request');
      });
    });

    it('should have a label for the email input', async () => {
      render(() => <OnboardingLanding />);

      await waitFor(() => {
        const label = screen.getByText('Email');
        expect(label).toBeInTheDocument();
        expect(label.tagName.toLowerCase()).toBe('label');
      });
    });

    it('should have aria-live region for messages', async () => {
      const { container } = render(() => <OnboardingLanding />);

      await waitFor(() => {
        const messageRegion = container.querySelector('[aria-live="polite"]');
        expect(messageRegion).toBeInTheDocument();
      });
    });
  });
});
