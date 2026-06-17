import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { within } from '@testing-library/dom';
import { createSignal } from 'solid-js';
import SettingsPanel from '../../components/SettingsPanel';
import { loadSettings, saveSettings, defaultSettings } from '../../lib/settings';
import type { Settings } from '../../lib/settings';
import * as storageApi from '../../api/storage';

const mobileState = vi.hoisted(() => ({ mobile: false, samsung: false }));

const sessionStoreState = vi.hoisted(() => ({
  preferences: { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: undefined } as { workspaceSyncEnabled: boolean | undefined; fastStartEnabled: boolean | undefined; sessionMode?: string | undefined },
  updatePreferences: vi.fn(async () => undefined),
  // The Standard/Pro session-mode selector is SaaS-gated (REQ-ENTERPRISE-008 AC3);
  // these tests exercise its behavior, so default to SaaS mode.
  saasMode: true as boolean,
}));

vi.mock('../../lib/mobile', () => ({
  isTouchDevice: () => mobileState.mobile,
  get isSamsungBrowser() { return mobileState.samsung; },
}));

const mockGetLlmKeys = vi.hoisted(() => vi.fn());
const mockUpdateLlmKeys = vi.hoisted(() => vi.fn());
const mockGetDeployKeys = vi.hoisted(() => vi.fn());
const mockUpdateDeployKeys = vi.hoisted(() => vi.fn());

// Defaults
mockGetLlmKeys.mockResolvedValue({});
mockUpdateLlmKeys.mockResolvedValue({});
mockGetDeployKeys.mockResolvedValue({});
mockUpdateDeployKeys.mockResolvedValue({});

vi.mock('../../api/client', () => ({
  getLlmKeys: () => mockGetLlmKeys(),
  updateLlmKeys: (body: unknown) => mockUpdateLlmKeys(body),
  getDeployKeys: () => mockGetDeployKeys(),
  updateDeployKeys: (body: unknown) => mockUpdateDeployKeys(body),
  deleteDeployKeys: vi.fn(async () => undefined),
  getUser: vi.fn(async () => ({ email: 'test@example.com', authenticated: true, bucketName: 'test', subscribedMode: 'advanced', hasSubscribed: true })),
}));

vi.mock('../../api/storage', () => ({
  recreateGettingStartedDocs: vi.fn(async () => ({
    success: true,
    bucketCreated: false,
    written: ['Getting-Started.md', 'Documentation/README.md'],
    skipped: [],
  })),
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get preferences() {
      return sessionStoreState.preferences;
    },
    get saasMode() {
      return sessionStoreState.saasMode;
    },
    updatePreferences: (...args: Parameters<typeof sessionStoreState.updatePreferences>) =>
      sessionStoreState.updatePreferences(...args),
  },
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

describe('SettingsPanel Component / REQ-AGENT-019 (branded settings UI)', () => {
  const mockRecreateGettingStartedDocs = vi.mocked(storageApi.recreateGettingStartedDocs);

  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    mockRecreateGettingStartedDocs.mockResolvedValue({
      success: true,
      bucketCreated: false,
      written: ['Getting-Started.md', 'Documentation/README.md'],
      skipped: [],
    });
    sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
    sessionStoreState.updatePreferences.mockResolvedValue(undefined);
    mockGetLlmKeys.mockResolvedValue({});
    mockUpdateLlmKeys.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  describe('KittScanner', () => {
    it('should NOT render KittScanner inside settings panel', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('settings-panel');
      const kittScanner = panel.querySelector('.kitt-scanner');
      expect(kittScanner).not.toBeInTheDocument();
    });
  });

  describe('Panel Visibility', () => {
    it('should render when isOpen is true', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('settings-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveClass('open');
    });

    it('should not be visible when isOpen is false', () => {
      render(() => <SettingsPanel isOpen={false} onClose={() => {}} />);

      const panel = screen.getByTestId('settings-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).not.toHaveClass('open');
    });

    it('should show backdrop when open', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const backdrop = screen.getByTestId('settings-backdrop');
      expect(backdrop).toHaveClass('open');
    });

    it('should hide backdrop when closed', () => {
      render(() => <SettingsPanel isOpen={false} onClose={() => {}} />);

      const backdrop = screen.getByTestId('settings-backdrop');
      expect(backdrop).not.toHaveClass('open');
    });
  });

  describe('Close Button', () => {
    it('should call onClose when close button is clicked', () => {
      const handleClose = vi.fn();
      render(() => <SettingsPanel isOpen={true} onClose={handleClose} />);

      const closeButton = screen.getByTestId('settings-close-button');
      fireEvent.click(closeButton);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when backdrop is clicked', () => {
      const handleClose = vi.fn();
      render(() => <SettingsPanel isOpen={true} onClose={handleClose} />);

      const backdrop = screen.getByTestId('settings-backdrop');
      fireEvent.click(backdrop);

      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('R2 Sync Settings', () => {
    it('shows workspace sync toggle defaulted to off', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-workspace-sync-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).not.toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('toggles workspace sync preference via sessionStore', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: true };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-workspace-sync-toggle');
      fireEvent.click(toggle);

      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ workspaceSyncEnabled: true });
    });

    it('shows restart-required explanation text', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const hint = screen.getByTestId('settings-workspace-sync-hint');
      expect(hint.textContent).toContain('Restart the session');
      expect(hint.textContent).toContain('startup');
    });

    it('renders recreate documentation button', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const button = screen.getByTestId('settings-recreate-docs-label');
      expect(button).toBeInTheDocument();
    });

    it('recreates getting-started docs via API', async () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const button = screen.getByTestId('settings-recreate-docs-label');
      await fireEvent.click(button);

      expect(mockRecreateGettingStartedDocs).toHaveBeenCalledTimes(1);
      const success = await screen.findByTestId('settings-recreate-docs-success');
      expect(success.textContent).toContain('Recreated 2');
    });

    it('shows error when recreate docs API fails', async () => {
      mockRecreateGettingStartedDocs.mockRejectedValueOnce(new Error('Seed failed'));
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const button = screen.getByTestId('settings-recreate-docs-label');
      await fireEvent.click(button);

      const error = await screen.findByTestId('settings-recreate-docs-error');
      expect(error.textContent).toContain('Seed failed');
    });
  });

  describe('Session Mode', () => {
    it('renders segmented control with "Default" and "Advanced" options', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      expect(screen.getByTestId('session-mode-control')).toBeInTheDocument();
      expect(screen.getByTestId('session-mode-default')).toBeInTheDocument();
      expect(screen.getByTestId('session-mode-advanced')).toBeInTheDocument();
    });

    it('"Default" selected when sessionMode is undefined', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      expect(screen.getByTestId('session-mode-default')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('session-mode-advanced')).toHaveAttribute('aria-checked', 'false');
    });

    it('"Default" selected when sessionMode is "default"', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: 'default' } as typeof sessionStoreState.preferences;
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      expect(screen.getByTestId('session-mode-default')).toHaveAttribute('aria-checked', 'true');
    });

    it('"Advanced" selected when sessionMode is "advanced"', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: 'advanced' } as typeof sessionStoreState.preferences;
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      expect(screen.getByTestId('session-mode-advanced')).toHaveAttribute('aria-checked', 'true');
    });

    it('clicking "Advanced" calls updatePreferences with sessionMode "advanced"', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      fireEvent.click(screen.getByTestId('session-mode-advanced'));
      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ sessionMode: 'advanced' });
    });

    it('clicking "Default" calls updatePreferences with sessionMode "default"', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: 'advanced' } as typeof sessionStoreState.preferences;
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      fireEvent.click(screen.getByTestId('session-mode-default'));
      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ sessionMode: 'default' });
    });

    it('clicking already-selected mode is a no-op', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      fireEvent.click(screen.getByTestId('session-mode-default'));
      expect(sessionStoreState.updatePreferences).not.toHaveBeenCalled();
    });

    it('segmented control visible inside Session Defaults accordion', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const panel = screen.getByTestId('accordion-panel-session');
      const control = within(panel).getByTestId('session-mode-control');
      expect(control).toBeInTheDocument();
    });

    it('has accessible role="radiogroup" with aria-label', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const control = screen.getByTestId('session-mode-control');
      expect(control).toHaveAttribute('role', 'radiogroup');
      expect(control).toHaveAttribute('aria-label', 'Session mode');
    });

    it('each option has role="radio" with correct aria-checked', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined, sessionMode: 'advanced' } as typeof sessionStoreState.preferences;
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const defaultOpt = screen.getByTestId('session-mode-default');
      const advancedOpt = screen.getByTestId('session-mode-advanced');
      expect(defaultOpt).toHaveAttribute('role', 'radio');
      expect(advancedOpt).toHaveAttribute('role', 'radio');
      expect(defaultOpt).toHaveAttribute('aria-checked', 'false');
      expect(advancedOpt).toHaveAttribute('aria-checked', 'true');
    });

    it('hint text explains auto-update on mode switch', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const hint = screen.getByTestId('session-mode-hint');
      expect(hint.textContent).toContain('automatically');
    });

    it('Pro mode radio is disabled when subscribedMode is default', async () => {
      const { getUser } = await import('../../api/client');
      vi.mocked(getUser).mockResolvedValueOnce({
        email: 'test@example.com',
        authenticated: true,
        bucketName: 'test',
        subscribedMode: 'default',
        hasSubscribed: true,
      } as Awaited<ReturnType<typeof getUser>>);

      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      // Wait for the async getUser() call to resolve and update the signal
      await new Promise((r) => setTimeout(r, 50));

      const advancedRadio = screen.getByTestId('session-mode-advanced');
      expect(advancedRadio).toHaveAttribute('disabled');
    });
  });

  describe('Agent Startup Settings', () => {
    it('shows fast start toggle defaulted to ON (undefined treated as true)', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-fast-start-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('toggles fast start off via sessionStore.updatePreferences', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-fast-start-toggle');
      fireEvent.click(toggle);

      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ fastStartEnabled: false });
    });

    it('toggles fast start on when currently off', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: false };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-fast-start-toggle');
      expect(toggle).not.toHaveClass('toggle-on');
      fireEvent.click(toggle);

      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ fastStartEnabled: true });
    });

    it('shows hint text containing "instant startup" and "auto-update"', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const hint = screen.getByTestId('settings-fast-start-hint');
      expect(hint.textContent).toContain('instant startup');
      expect(hint.textContent).toContain('auto-update');
    });
  });

  describe('LocalStorage Persistence', () => {
    it('should save settings to localStorage when accent color changes', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const input = screen.getByTestId('accent-color-input');
      fireEvent.input(input, { target: { value: '#ff0000' } });

      expect(localStorageMock.setItem).toHaveBeenCalled();
      const lastCall = localStorageMock.setItem.mock.calls.slice(-1)[0];
      expect(lastCall[0]).toBe('codeflare-settings');

      const savedSettings = JSON.parse(lastCall[1]);
      expect(savedSettings.accentColor).toBe('#ff0000');
    });

    it('should load accent color from localStorage on mount', () => {
      const customSettings: Settings = { accentColor: '#ff0000' };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(customSettings));

      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const input = screen.getByTestId('accent-color-input');
      expect(input).toHaveValue('#ff0000');
    });
  });

  describe('Button Labels Toggle', () => {
    beforeEach(() => { mobileState.mobile = true; });
    afterEach(() => { mobileState.mobile = false; });

    it('shows button labels toggle defaulted to on', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-button-labels-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('toggles button labels off when clicked', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-button-labels-toggle');
      fireEvent.click(toggle);

      expect(localStorageMock.setItem).toHaveBeenCalled();
      const lastCall = localStorageMock.setItem.mock.calls.slice(-1)[0];
      const savedSettings = JSON.parse(lastCall[1]);
      expect(savedSettings.showButtonLabels).toBe(false);
    });

    it('loads button labels setting from localStorage', () => {
      const customSettings: Settings = { showButtonLabels: false };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(customSettings));

      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-button-labels-toggle');
      expect(toggle).not.toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('has accessible switch role', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-button-labels-toggle');
      expect(toggle).toHaveAttribute('role', 'switch');
      expect(toggle).toHaveAttribute('aria-checked');
    });
  });

  describe('Samsung Address Bar Toggle', () => {
    beforeEach(() => { mobileState.samsung = true; });
    afterEach(() => { mobileState.samsung = false; });

    it('should hide Samsung section when not Samsung browser', () => {
      mobileState.samsung = false;
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.queryByTestId('settings-samsung-bar-top-toggle');
      expect(toggle).not.toBeInTheDocument();
    });

    it('should show Samsung section when Samsung browser', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-samsung-bar-top-toggle');
      expect(toggle).toBeInTheDocument();
    });

    it('should default Samsung address bar toggle to on', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-samsung-bar-top-toggle');
      expect(toggle).toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('should toggle Samsung address bar setting off when clicked', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-samsung-bar-top-toggle');
      fireEvent.click(toggle);

      expect(localStorageMock.setItem).toHaveBeenCalled();
      const lastCall = localStorageMock.setItem.mock.calls.slice(-1)[0];
      const savedSettings = JSON.parse(lastCall[1]);
      expect(savedSettings.samsungAddressBarTop).toBe(false);
    });

    it('should load Samsung address bar setting from localStorage', () => {
      const customSettings: Settings = { samsungAddressBarTop: false };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(customSettings));

      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-samsung-bar-top-toggle');
      expect(toggle).not.toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('should have accessible switch role', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-samsung-bar-top-toggle');
      expect(toggle).toHaveAttribute('role', 'switch');
      expect(toggle).toHaveAttribute('aria-checked');
    });
  });

  describe('Group Structure', () => {
    it('renders "Appearance" group heading inside accordion header', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const header = screen.getByTestId('accordion-header-appearance');
      const titleSpan = header.querySelector('.settings-group-title');
      expect(titleSpan).toHaveTextContent('Appearance');
      // h3 wraps the button
      expect(header.parentElement?.tagName).toBe('H3');
    });

    it('renders "Session Defaults" group heading inside accordion header', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const header = screen.getByTestId('accordion-header-session');
      const titleSpan = header.querySelector('.settings-group-title');
      expect(titleSpan).toHaveTextContent('Session Defaults');
    });

    it('renders "Administration" group heading for admins', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));

      const header = screen.getByTestId('accordion-header-admin');
      const titleSpan = header.querySelector('.settings-group-title');
      expect(titleSpan).toHaveTextContent('Administration');
    });

    it('hides "Administration" group for non-admins', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="user"
          currentUserEmail="user@example.com"
        />
      ));

      expect(screen.queryByTestId('accordion-header-admin')).not.toBeInTheDocument();
    });

    it('shows "Setup Wizard" button for admins', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));
      fireEvent.click(screen.getByTestId('accordion-header-admin'));

      expect(screen.getByRole('button', { name: /Setup Wizard/ })).toBeInTheDocument();
    });
  });

  describe('Administration section', () => {
    it('shows administration section with setup button for admin', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));
      fireEvent.click(screen.getByTestId('accordion-header-admin'));

      const header = screen.getByTestId('accordion-header-admin');
      expect(header).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Setup Wizard/ })).toBeInTheDocument();
    });

    it('hides administration for non-admin', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="user"
          currentUserEmail="viewer@example.com"
        />
      ));

      expect(screen.queryByTestId('accordion-header-admin')).not.toBeInTheDocument();
    });

    it('does NOT render UserManagement component', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));

      expect(screen.queryByTestId('settings-user-management')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have correct ARIA attributes', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('settings-panel');
      expect(panel).toHaveAttribute('role', 'dialog');
      expect(panel).toHaveAttribute('aria-label', 'Settings');
    });

    it('should have aria-hidden when closed', () => {
      render(() => <SettingsPanel isOpen={false} onClose={() => {}} />);

      const panel = screen.getByTestId('settings-panel');
      expect(panel).toHaveAttribute('aria-hidden', 'true');
    });

    it('should not have aria-hidden when open', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('settings-panel');
      expect(panel).toHaveAttribute('aria-hidden', 'false');
    });

    it('is inert when closed and not inert when open (focus cannot be retained under aria-hidden)', () => {
      const { unmount } = render(() => <SettingsPanel isOpen={false} onClose={() => {}} />);
      expect(screen.getByTestId('settings-panel')).toHaveAttribute('inert');
      unmount();

      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      expect(screen.getByTestId('settings-panel')).not.toHaveAttribute('inert');
    });

    it('should have accessible toggle switch for workspace sync', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-workspace-sync-toggle');
      expect(toggle).toHaveAttribute('role', 'switch');
      expect(toggle).toHaveAttribute('aria-checked');
    });

    it('should have accessible close button', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const closeButton = screen.getByTestId('settings-close-button');
      expect(closeButton).toHaveAttribute('title', 'Close settings');
    });
  });

  describe('Clipboard Access Toggle', () => {
    it('should render clipboard access toggle defaulted to off', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-clipboard-access-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).not.toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('should toggle clipboard access setting on when clicked', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.getByTestId('settings-clipboard-access-toggle');
      fireEvent.click(toggle);

      expect(localStorageMock.setItem).toHaveBeenCalled();
      const lastCall = localStorageMock.setItem.mock.calls.slice(-1)[0];
      const savedSettings = JSON.parse(lastCall[1]);
      expect(savedSettings.clipboardAccess).toBe(true);
    });

    it('should hide clipboard toggle on mobile (paste always works)', () => {
      mobileState.mobile = true;
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-session'));

      const toggle = screen.queryByTestId('settings-clipboard-access-toggle');
      expect(toggle).not.toBeInTheDocument();
      mobileState.mobile = false;
    });
  });

  describe('LLM API Keys', () => {
    beforeEach(() => {
      sessionStoreState.preferences.sessionMode = 'advanced';
    });
    afterEach(() => {
      sessionStoreState.preferences.sessionMode = undefined;
    });

    it('renders LLM API Keys group heading', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const header = screen.getByTestId('accordion-header-llm');
      expect(header).toBeInTheDocument();
      const titleSpan = header.querySelector('.settings-group-title');
      expect(titleSpan).toHaveTextContent('LLM API Keys');
    });

    it('renders OpenAI and Gemini provider rows', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-llm'));

      expect(screen.getByTestId('llm-openai-row')).toBeInTheDocument();
      expect(screen.getByTestId('llm-gemini-row')).toBeInTheDocument();
    });

    it('shows explanation text', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-llm'));

      expect(screen.getByTestId('llm-keys-explanation')).toBeInTheDocument();
    });

    it('shows hint about next session start', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('accordion-header-llm'));

      const hint = screen.getByTestId('llm-keys-hint');
      expect(hint.textContent).toContain('next session start');
    });
  });

  describe('R2 Warning (admin)', () => {
    it('shows R2 warning hint in admin context', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));
      fireEvent.click(screen.getByTestId('accordion-header-admin'));

      const warning = screen.getByTestId('settings-r2-warning');
      expect(warning).toBeInTheDocument();
      expect(warning.textContent).toContain('re-run the Setup Wizard');
    });

    it('hides R2 warning hint for non-admin users', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="user"
          currentUserEmail="user@example.com"
        />
      ));

      expect(screen.queryByTestId('settings-r2-warning')).not.toBeInTheDocument();
    });
  });

  describe('Accordion behavior', () => {
    it('expands Appearance group by default', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const header = screen.getByTestId('accordion-header-appearance');
      expect(header).toHaveAttribute('aria-expanded', 'true');
    });

    it('collapses other groups by default', () => {
      sessionStoreState.preferences.sessionMode = 'advanced';
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const sessionHeader = screen.getByTestId('accordion-header-session');
      const llmHeader = screen.getByTestId('accordion-header-llm');
      expect(sessionHeader).toHaveAttribute('aria-expanded', 'false');
      expect(llmHeader).toHaveAttribute('aria-expanded', 'false');
      sessionStoreState.preferences.sessionMode = undefined;
    });

    it('clicking collapsed group opens it and closes current one', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const sessionHeader = screen.getByTestId('accordion-header-session');
      fireEvent.click(sessionHeader);

      expect(sessionHeader).toHaveAttribute('aria-expanded', 'true');
      const appearanceHeader = screen.getByTestId('accordion-header-appearance');
      expect(appearanceHeader).toHaveAttribute('aria-expanded', 'false');
    });

    it('clicking open group is a no-op (stays open)', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const appearanceHeader = screen.getByTestId('accordion-header-appearance');
      fireEvent.click(appearanceHeader);

      expect(appearanceHeader).toHaveAttribute('aria-expanded', 'true');
    });

    it('shows subtitles only on collapsed groups', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      // Appearance is open — no subtitle
      const appearanceSubtitle = screen.queryByTestId('accordion-subtitle-appearance');
      expect(appearanceSubtitle).not.toBeInTheDocument();

      // Session is collapsed — subtitle visible
      const sessionSubtitle = screen.getByTestId('accordion-subtitle-session');
      expect(sessionSubtitle).toBeInTheDocument();
    });

    it('toggles chevron class on open/close', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const appearanceHeader = screen.getByTestId('accordion-header-appearance');
      const appearanceChevron = appearanceHeader.querySelector('.accordion-chevron');
      expect(appearanceChevron).toHaveClass('accordion-chevron--open');

      const sessionHeader = screen.getByTestId('accordion-header-session');
      const sessionChevron = sessionHeader.querySelector('.accordion-chevron');
      expect(sessionChevron).not.toHaveClass('accordion-chevron--open');
    });

    it('headers are button elements inside h3 wrappers', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const header = screen.getByTestId('accordion-header-appearance');
      expect(header.tagName).toBe('BUTTON');
      expect(header.parentElement?.tagName).toBe('H3');
    });

    it('buttons have aria-controls pointing to panel IDs', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const header = screen.getByTestId('accordion-header-appearance');
      expect(header).toHaveAttribute('aria-controls', 'accordion-panel-appearance');
    });

    it('content regions have role=region, aria-labelledby, and aria-hidden', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const panel = screen.getByTestId('accordion-panel-appearance');
      expect(panel).toHaveAttribute('role', 'region');
      expect(panel).toHaveAttribute('aria-labelledby', 'accordion-header-appearance');
      expect(panel).toHaveAttribute('aria-hidden', 'false');

      const sessionPanel = screen.getByTestId('accordion-panel-session');
      expect(sessionPanel).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('Accordion reset on reopen', () => {
    it('resets to Appearance when panel is closed and reopened', () => {
      sessionStoreState.preferences.sessionMode = 'advanced';
      const [isOpen, setIsOpen] = createSignal(true);
      render(() => <SettingsPanel isOpen={isOpen()} onClose={() => setIsOpen(false)} />);

      // Switch to LLM group (only visible in advanced mode)
      const llmHeader = screen.getByTestId('accordion-header-llm');
      fireEvent.click(llmHeader);
      expect(llmHeader).toHaveAttribute('aria-expanded', 'true');

      // Close and reopen
      setIsOpen(false);
      setIsOpen(true);

      // Appearance should be expanded again
      const appearanceHeader = screen.getByTestId('accordion-header-appearance');
      expect(appearanceHeader).toHaveAttribute('aria-expanded', 'true');
      expect(llmHeader).toHaveAttribute('aria-expanded', 'false');
      sessionStoreState.preferences.sessionMode = undefined;
    });
  });

  describe('LLM API Keys explanation', () => {
    beforeEach(() => {
      sessionStoreState.preferences.sessionMode = 'advanced';
    });
    afterEach(() => {
      sessionStoreState.preferences.sessionMode = undefined;
    });

    it('shows explanation text with "Optional"', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      // Open LLM group first
      fireEvent.click(screen.getByTestId('accordion-header-llm'));

      const explanation = screen.getByTestId('llm-keys-explanation');
      expect(explanation.textContent).toContain('Optional');
    });
  });

  describe('Accordion admin group', () => {
    it('renders admin header for admin users (collapsed by default)', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));

      const adminHeader = screen.getByTestId('accordion-header-admin');
      expect(adminHeader).toBeInTheDocument();
      expect(adminHeader).toHaveAttribute('aria-expanded', 'false');
    });

    it('does not render admin header for non-admin users', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="user"
          currentUserEmail="user@example.com"
        />
      ));

      expect(screen.queryByTestId('accordion-header-admin')).not.toBeInTheDocument();
    });

    it('shows admin subtitle when collapsed', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));

      const subtitle = screen.getByTestId('accordion-subtitle-admin');
      expect(subtitle).toBeInTheDocument();
    });
  });
});

describe('Settings Helper Functions', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe('loadSettings', () => {
    it('should return default settings when localStorage is empty', () => {
      localStorageMock.getItem.mockReturnValue(null);

      const settings = loadSettings();
      expect(settings).toEqual(defaultSettings);
    });

    it('should return saved settings when available', () => {
      const customSettings: Settings = { accentColor: '#ff0000' };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(customSettings));

      const settings = loadSettings();
      expect(settings.accentColor).toBe('#ff0000');
    });

    it('should merge partial settings with defaults', () => {
      localStorageMock.getItem.mockReturnValue(JSON.stringify({ accentColor: '#00ff00' }));

      const settings = loadSettings();
      expect(settings.accentColor).toBe('#00ff00');
    });

    it('should default showButtonLabels to true', () => {
      localStorageMock.getItem.mockReturnValue(null);

      const settings = loadSettings();
      expect(settings.showButtonLabels).toBe(true);
    });

    it('should preserve showButtonLabels false from storage', () => {
      localStorageMock.getItem.mockReturnValue(JSON.stringify({ showButtonLabels: false }));

      const settings = loadSettings();
      expect(settings.showButtonLabels).toBe(false);
    });

    it('should return default settings on parse error', () => {
      localStorageMock.getItem.mockReturnValue('invalid json');

      const settings = loadSettings();
      expect(settings).toEqual(defaultSettings);
    });
  });

  describe('saveSettings', () => {
    it('should save settings to localStorage', () => {
      const customSettings: Settings = { accentColor: '#ff0000' };

      saveSettings(customSettings);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'codeflare-settings',
        JSON.stringify(customSettings)
      );
    });

    it('should not throw on localStorage error', () => {
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('Storage full');
      });

      expect(() => saveSettings(defaultSettings)).not.toThrow();
    });
  });
});
