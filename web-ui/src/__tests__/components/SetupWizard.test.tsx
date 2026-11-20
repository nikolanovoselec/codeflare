import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiXml } from '@mdi/js';
import SetupWizard from '../../components/setup/SetupWizard';
import ProgressStep from '../../components/setup/ProgressStep';

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
    onboardingMode: false,
    tokenDetecting: false,
    tokenDetected: false,
    tokenDetectError: null,
    accountInfo: null,
    detectToken: vi.fn(),
    loadExistingConfig: vi.fn().mockResolvedValue(true),
    nextStep: vi.fn(),
    configure: vi.fn(),
    configureSteps: [] as Array<{ step: string; status: string }>,
    setupComplete: false,
    configuring: false,
    configureError: null,
  },
}));

import { getSetupStatus, getUser } from '../../api/client';
import { setupStore } from '../../stores/setup';
const mockedGetSetupStatus = vi.mocked(getSetupStatus);
const mockedGetUser = vi.mocked(getUser);

describe('SetupWizard', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Default: not yet configured (first-time setup, authorized immediately)
    mockedGetSetupStatus.mockResolvedValue({ configured: false });
    mockedGetUser.mockResolvedValue({ role: 'admin', authenticated: true } as any);
    vi.mocked(setupStore.loadExistingConfig).mockResolvedValue(true);
    Object.assign(setupStore, { enterpriseMode: false, saasMode: false, onboardingMode: false, tokenDetected: false, accountInfo: null });
  });

  afterEach(() => {
    cleanup();
    Object.assign(setupStore, { configureSteps: [] });
  });

  it('REQ-ENTERPRISE-017 AC6: renders friendly labels for the executed enterprise configuration tasks', () => {
    Object.assign(setupStore, { configureSteps: [
      'configure_access_groups', 'configure_model_routing', 'configure_ai_gateway',
      'configure_browser_rendering', 'configure_strict_egress',
    ].map(step => ({ step, status: 'success' })) });
    const view = render(() => <ProgressStep />);
    expect(view.getByRole('heading', { name: 'Configuring Codeflare' })).toBeVisible();
    for (const label of ['Applying Access groups', 'Configuring model routing', 'Configuring AI Gateway',
      'Enabling Browser Rendering', 'Enabling strict Gateway egress']) {
      expect(view.getByText(label)).toBeVisible();
    }
  });

  describe('operator shell states', () => {
    it('renders the first-run operator shell when authorized', async () => {
      render(() => <SetupWizard />);
      await waitFor(() => {
        expect(document.querySelector('.setup-journey-layout')).toBeInTheDocument();
        expect(document.body.textContent).toContain('Deployment readiness');
      });
    });

    it('REQ-SETUP-022 AC2: hydrates completed Enterprise initialization before rendering recovery', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true, enterpriseMode: true });
      let resolveHydration!: (loaded: boolean) => void;
      vi.mocked(setupStore.loadExistingConfig).mockReturnValueOnce(new Promise<boolean>((resolve) => {
        resolveHydration = resolve;
      }));

      render(() => <SetupWizard />);
      await waitFor(() => expect(setupStore.loadExistingConfig).toHaveBeenCalledOnce());
      expect(document.body.textContent).toContain('Loading');
      expect(document.querySelector('.setup-journey-layout')).not.toBeInTheDocument();

      Object.assign(setupStore, { enterpriseMode: true });
      resolveHydration(true);

      await waitFor(() => {
        expect(document.body.textContent).toContain('Completed');
        expect(document.body.textContent).toContain('Enterprise');
      });
    });

    it('REQ-SETUP-022 AC6: shows the hydrated Onboarding deployment mode', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true, onboardingMode: true });
      vi.mocked(setupStore.loadExistingConfig).mockImplementationOnce(async () => {
        Object.assign(setupStore, { onboardingMode: true });
        return true;
      });

      render(() => <SetupWizard />);

      await waitFor(() => {
        expect(document.querySelector('[data-deployment-mode="onboarding"]')).toBeInTheDocument();
      });
    });

    it('REQ-SETUP-022 AC7: returns configured Initialization to Administration', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true });

      render(() => <SetupWizard />);

      await waitFor(() => {
        expect(document.querySelector('[data-testid="initialization-return"]')).toHaveAttribute('href', '/admin');
      });
    });

    it('REQ-SETUP-022 AC4: labels configured recovery as initialization review', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true, enterpriseMode: true });
      Object.assign(setupStore, {
        enterpriseMode: true,
        tokenDetected: true,
        accountInfo: { id: 'account-id', name: 'Enterprise account' },
      });

      render(() => <SetupWizard />);
      await waitFor(() => expect(document.body.textContent).toContain('Review initialization'));
      expect(document.body.textContent).not.toContain('Start setup');
    });

    it('REQ-SETUP-022 AC5: retains the first-run setup action', async () => {
      Object.assign(setupStore, {
        tokenDetected: true,
        accountInfo: { id: 'account-id', name: 'Enterprise account' },
      });

      render(() => <SetupWizard />);
      await waitFor(() => expect(document.body.textContent).toContain('Start setup'));
      expect(document.body.textContent).not.toContain('Review initialization');
    });

    it('REQ-SETUP-022 AC3: keeps configured recovery closed when hydration fails', async () => {
      mockedGetSetupStatus.mockResolvedValue({ configured: true, enterpriseMode: true });
      vi.mocked(setupStore.loadExistingConfig).mockResolvedValueOnce(false);

      render(() => <SetupWizard />);
      await waitFor(() => expect(document.body.textContent).toContain('Initialization settings could not be loaded'));
      expect(document.body.textContent).not.toContain('Completed');
      expect(document.querySelector('.setup-journey-layout')).not.toBeInTheDocument();
      expect(document.body.textContent).toContain('Retry');
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
