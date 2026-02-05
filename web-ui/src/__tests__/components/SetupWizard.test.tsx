import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiXml } from '@mdi/js';
import SetupWizard from '../../components/setup/SetupWizard';

// Mock the API client
vi.mock('../../api/client', () => ({
  getSetupStatus: vi.fn(),
  getUser: vi.fn(),
}));

// Mock the SplashCursor component (WebGL-based, not testable in jsdom)
vi.mock('../../components/SplashCursor', () => ({
  default: () => <div data-testid="splash-cursor" />,
}));

// Mock the setup store
vi.mock('../../stores/setup', () => ({
  setupStore: {
    step: 1,
  },
}));

import { getSetupStatus, getUser } from '../../api/client';
const mockedGetSetupStatus = vi.mocked(getSetupStatus);
const mockedGetUser = vi.mocked(getUser);

describe('SetupWizard', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Default: not yet configured (first-time setup, authorized immediately)
    mockedGetSetupStatus.mockResolvedValue({ configured: false });
    mockedGetUser.mockResolvedValue({ role: 'admin', authenticated: true } as any);
  });

  afterEach(() => {
    cleanup();
  });

  describe('KittScanner', () => {
    it('should render KittScanner inside setup-container when authorized', async () => {
      render(() => <SetupWizard />);

      await waitFor(() => {
        const container = document.querySelector('.setup-container');
        expect(container).toBeInTheDocument();
        const kittScanner = container?.querySelector('.kitt-scanner');
        expect(kittScanner).toBeInTheDocument();
      });
    });

    it('should render KittScanner inside setup-container during loading state', () => {
      // Before onMount resolves, authState is 'loading'
      mockedGetSetupStatus.mockReturnValue(new Promise(() => {})); // never resolves
      render(() => <SetupWizard />);

      const container = document.querySelector('.setup-container');
      expect(container).toBeInTheDocument();
      const kittScanner = container?.querySelector('.kitt-scanner');
      expect(kittScanner).toBeInTheDocument();
    });

    it('should render KittScanner inside setup-container when denied', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true });
      mockedGetUser.mockResolvedValue({ role: 'viewer', authenticated: true } as any);

      render(() => <SetupWizard />);

      await waitFor(() => {
        const container = document.querySelector('.setup-container');
        expect(container).toBeInTheDocument();
        const kittScanner = container?.querySelector('.kitt-scanner');
        expect(kittScanner).toBeInTheDocument();
      });
    });
  });

  describe('Icon swap: mdiXml replaces mdiBrain', () => {
    it('should use mdiXml icon path in the loading state logo', () => {
      // Use a never-resolving promise so authState stays 'loading' (no async contamination)
      mockedGetSetupStatus.mockReturnValue(new Promise(() => {}));

      const { container } = render(() => <SetupWizard />);

      const logo = container.querySelector('.setup-logo-icon');
      expect(logo).toBeInTheDocument();
      const svgPath = logo?.querySelector('path');
      expect(svgPath).toBeInTheDocument();
      expect(svgPath?.getAttribute('d')).toBe(mdiXml);
    });
  });
});
