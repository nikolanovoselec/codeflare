import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiXml } from '@mdi/js';
import SetupWizard from '../../components/setup/SetupWizard';

// Mock the API client
vi.mock('../../api/client', () => ({
  getSetupStatus: vi.fn(),
  getUser: vi.fn(),
}));

// Mock the setup store
vi.mock('../../stores/setup', () => ({
  setupStore: {
    step: 1,
    enterpriseMode: false,
    saasMode: false,
    tokenDetecting: false,
    tokenDetected: false,
    tokenDetectError: null,
    accountInfo: null,
    detectToken: vi.fn(),
    nextStep: vi.fn(),
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

  describe('operator shell states', () => {
    it('renders the first-run operator shell when authorized', async () => {
      render(() => <SetupWizard />);
      await waitFor(() => {
        expect(document.querySelector('.setup-journey-layout')).toBeInTheDocument();
        expect(document.body.textContent).toContain('Deployment readiness');
      });
    });

    it('renders a bounded loading shell while setup status resolves', () => {
      mockedGetSetupStatus.mockReturnValue(new Promise(() => {}));
      render(() => <SetupWizard />);
      expect(document.querySelector('.setup-container--message')).toBeInTheDocument();
      expect(document.body.textContent).toContain('Loading');
    });

    it('renders the denied recovery shell for non-admins', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true });
      mockedGetUser.mockResolvedValue({ role: 'viewer', authenticated: true } as any);
      render(() => <SetupWizard />);
      await waitFor(() => {
        expect(document.body.textContent).toContain('Access denied');
        expect(document.body.textContent).toContain('Only administrators');
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
