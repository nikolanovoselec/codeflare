import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { within } from '@testing-library/dom';
import SettingsPanel from '../../components/SettingsPanel';
import { loadSettings, saveSettings, defaultSettings } from '../../lib/settings';
import type { Settings } from '../../lib/settings';
import * as storageApi from '../../api/storage';

const mobileState = vi.hoisted(() => ({ mobile: false, samsung: false }));

const sessionStoreState = vi.hoisted(() => ({
  preferences: { workspaceSyncEnabled: false as boolean | undefined, fastStartEnabled: undefined as boolean | undefined },
  updatePreferences: vi.fn(async () => undefined),
}));

vi.mock('../../lib/mobile', () => ({
  isTouchDevice: () => mobileState.mobile,
  get isSamsungBrowser() { return mobileState.samsung; },
}));

vi.mock('../../api/client', () => ({}));

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

describe('SettingsPanel Component', () => {
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

      const toggle = screen.getByTestId('settings-workspace-sync-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).not.toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('toggles workspace sync preference via sessionStore', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: true };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-workspace-sync-toggle');
      fireEvent.click(toggle);

      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ workspaceSyncEnabled: true });
    });

    it('shows restart-required explanation text', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const hint = screen.getByTestId('settings-workspace-sync-hint');
      expect(hint.textContent).toContain('Restart the session');
      expect(hint.textContent).toContain('startup');
    });

    it('renders clean recreate-documentation row with action on the right', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const row = screen.getByTestId('settings-recreate-docs-row');
      expect(row).toBeInTheDocument();
      expect(row).toHaveClass('setting-row--split');

      const label = screen.getByTestId('settings-recreate-docs-label');
      expect(label.textContent).toBe('Recreate getting-started documentation');

      const button = within(row).getByRole('button', { name: 'Recreate' });
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('Recreate');
    });

    it('recreates getting-started docs via API', async () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const button = screen.getByRole('button', { name: 'Recreate' });
      await fireEvent.click(button);

      expect(mockRecreateGettingStartedDocs).toHaveBeenCalledTimes(1);
      const success = await screen.findByTestId('settings-recreate-docs-success');
      expect(success.textContent).toContain('Recreated 2');
    });

    it('shows error when recreate docs API fails', async () => {
      mockRecreateGettingStartedDocs.mockRejectedValueOnce(new Error('Seed failed'));
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const button = screen.getByRole('button', { name: 'Recreate' });
      await fireEvent.click(button);

      const error = await screen.findByTestId('settings-recreate-docs-error');
      expect(error.textContent).toContain('Seed failed');
    });
  });

  describe('Agent Startup Settings', () => {
    it('shows fast start toggle defaulted to ON (undefined treated as true)', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-fast-start-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('toggles fast start off via sessionStore.updatePreferences', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: undefined };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-fast-start-toggle');
      fireEvent.click(toggle);

      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ fastStartEnabled: false });
    });

    it('toggles fast start on when currently off', () => {
      sessionStoreState.preferences = { workspaceSyncEnabled: false, fastStartEnabled: false };
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const toggle = screen.getByTestId('settings-fast-start-toggle');
      expect(toggle).not.toHaveClass('toggle-on');
      fireEvent.click(toggle);

      expect(sessionStoreState.updatePreferences).toHaveBeenCalledWith({ fastStartEnabled: true });
    });

    it('shows hint text containing "instant startup" and "auto-update"', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

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
    it('renders "Appearance" group heading', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const heading = screen.getByText('Appearance');
      expect(heading.tagName).toBe('H3');
      expect(heading).toHaveClass('settings-group-title');
    });

    it('renders "Session Defaults" group heading', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

      const heading = screen.getByText('Session Defaults');
      expect(heading.tagName).toBe('H3');
      expect(heading).toHaveClass('settings-group-title');
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

      const heading = screen.getByText('Administration');
      expect(heading.tagName).toBe('H3');
      expect(heading).toHaveClass('settings-group-title');
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

      expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    });

    it('shows "Open Setup & User Management" button text for admins', () => {
      render(() => (
        <SettingsPanel
          isOpen={true}
          onClose={() => {}}
          currentUserRole="admin"
          currentUserEmail="admin@example.com"
        />
      ));

      expect(screen.getByRole('button', { name: 'Open Setup & User Management' })).toBeInTheDocument();
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

      const heading = screen.getByText('Administration');
      expect(heading).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open Setup & User Management' })).toBeInTheDocument();
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

      expect(screen.queryByText('Administration')).not.toBeInTheDocument();
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

    it('should have accessible toggle switch for workspace sync', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

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

      const toggle = screen.getByTestId('settings-clipboard-access-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).not.toHaveClass('toggle-on');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    it('should toggle clipboard access setting on when clicked', () => {
      render(() => <SettingsPanel isOpen={true} onClose={() => {}} />);

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

      const toggle = screen.queryByTestId('settings-clipboard-access-toggle');
      expect(toggle).not.toBeInTheDocument();
      mobileState.mobile = false;
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

      const warning = screen.getByTestId('settings-r2-warning');
      expect(warning).toBeInTheDocument();
      expect(warning.textContent).toContain('re-running setup');
      expect(warning.textContent).toContain('R2 credentials and per-user storage tokens');
      expect(warning.textContent).toContain('file sync and new sessions will break');
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
