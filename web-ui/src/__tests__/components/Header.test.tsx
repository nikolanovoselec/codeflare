import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import { mdiXml } from '@mdi/js';
import Header from '../../components/Header';

// Mock isMobile - default to desktop (false)
const isMobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/mobile', () => ({
  isMobile: () => isMobileMock.value,
}));

// Mock SessionSwitcher
vi.mock('../../components/SessionSwitcher', () => ({
  default: (props: any) => (
    <div data-testid="session-switcher" data-active-session={props.activeSessionId} />
  ),
}));

// Mock terminal store with authUrl signal
const terminalStoreMock = vi.hoisted(() => ({
  authUrl: null as string | null,
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    get authUrl() {
      return terminalStoreMock.authUrl;
    },
  },
}));

const sessionStoreState = vi.hoisted(() => ({
  activeSessionId: 'session-1' as string | null,
  presets: [] as Array<{ id: string; name: string; tabs: Array<{ id: string; command: string; label: string }>; createdAt: string }>,
  error: null as string | null,
  loadPresets: vi.fn(async () => undefined),
  saveBookmarkForSession: vi.fn(async () => ({ id: 'new-bookmark', name: 'My Bookmark', tabs: [], createdAt: new Date().toISOString() }) as { id: string; name: string; tabs: never[]; createdAt: string } | null),
  applyPresetToSession: vi.fn(async () => true),
  deletePreset: vi.fn(async () => undefined),
  renamePreset: vi.fn(async () => ({ id: 'preset-1', name: 'Renamed', tabs: [], createdAt: new Date().toISOString() })),
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    get activeSessionId() {
      return sessionStoreState.activeSessionId;
    },
    get presets() {
      return sessionStoreState.presets;
    },
    get error() {
      return sessionStoreState.error;
    },
    loadPresets: (...args: Parameters<typeof sessionStoreState.loadPresets>) =>
      sessionStoreState.loadPresets(...args),
    saveBookmarkForSession: (...args: Parameters<typeof sessionStoreState.saveBookmarkForSession>) =>
      sessionStoreState.saveBookmarkForSession(...args),
    applyPresetToSession: (...args: Parameters<typeof sessionStoreState.applyPresetToSession>) =>
      sessionStoreState.applyPresetToSession(...args),
    deletePreset: (...args: Parameters<typeof sessionStoreState.deletePreset>) =>
      sessionStoreState.deletePreset(...args),
    renamePreset: (...args: Parameters<typeof sessionStoreState.renamePreset>) =>
      sessionStoreState.renamePreset(...args),
  },
}));

const defaultSessionProps = {
  sessions: [] as any[],
  activeSessionId: null as string | null,
  onSelectSession: () => {},
  onStopSession: () => {},
  onDeleteSession: () => {},
  onCreateSession: () => {},
};

describe('Header Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStoreState.activeSessionId = 'session-1';
    sessionStoreState.presets = [];
    sessionStoreState.error = null;
    isMobileMock.value = false;
    terminalStoreMock.authUrl = null;
  });

  afterEach(() => {
    cleanup();
  });

  describe('Default Rendering', () => {
    it('should render with required elements', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);

      const logo = screen.getByTestId('header-logo');
      expect(logo).toBeInTheDocument();

      const settingsButton = screen.getByTestId('header-settings-button');
      expect(settingsButton).toBeInTheDocument();

      const userMenu = screen.getByTestId('header-user-menu');
      expect(userMenu).toBeInTheDocument();

      const bookmarksButton = screen.getByTestId('header-bookmarks-button');
      expect(bookmarksButton).toBeInTheDocument();
    });

    it('should render logo with XML icon', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      const logo = screen.getByTestId('header-logo');
      const icon = logo.querySelector('svg');

      expect(icon).toBeInTheDocument();
    });

    it('should use mdiXml icon path for the logo', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      const logo = screen.getByTestId('header-logo');
      const svgPath = logo.querySelector('svg path');

      expect(svgPath).toBeInTheDocument();
      expect(svgPath?.getAttribute('d')).toBe(mdiXml);
    });
  });

  describe('User Name Display', () => {
    it('should show user name when provided', () => {
      render(() => <Header {...defaultSessionProps} userName="test@example.com" />);
      const userMenu = screen.getByTestId('header-user-menu');

      expect(userMenu).toHaveTextContent('test@example.com');
    });

    it('should show default avatar when no user name', () => {
      render(() => <Header {...defaultSessionProps} />);
      const userMenu = screen.getByTestId('header-user-menu');
      const icon = userMenu.querySelector('svg');

      expect(icon).toBeInTheDocument();
    });
  });

  describe('Bookmarks', () => {
    it('opens name input and save button when clicked with no existing bookmarks', () => {
      sessionStoreState.presets = [];
      render(() => <Header {...defaultSessionProps} />);

      const bookmarksButton = screen.getByTestId('header-bookmarks-button');
      fireEvent.click(bookmarksButton);

      expect(screen.getByTestId('header-bookmark-name-input')).toBeInTheDocument();
      expect(screen.getByTestId('header-bookmark-save')).toBeInTheDocument();
    });

    it('saves bookmark when clicking save in create mode', async () => {
      sessionStoreState.presets = [];
      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      const input = screen.getByTestId('header-bookmark-name-input');
      fireEvent.input(input, { target: { value: 'Workspace Tools' } });
      fireEvent.click(screen.getByTestId('header-bookmark-save'));

      expect(sessionStoreState.saveBookmarkForSession).toHaveBeenCalledWith('session-1', 'Workspace Tools');
    });

    it('saves bookmark when pressing Enter in create mode', async () => {
      sessionStoreState.presets = [];
      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      const input = screen.getByTestId('header-bookmark-name-input');
      fireEvent.input(input, { target: { value: 'Workspace Tools' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(sessionStoreState.saveBookmarkForSession).toHaveBeenCalledWith('session-1', 'Workspace Tools');
    });

    it('shows saved bookmarks in dropdown and activates bookmark on row click', () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [
            { id: '2', command: 'yazi', label: 'yazi' },
            { id: '3', command: 'lazygit', label: 'lazygit' },
          ],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-item-preset-1'));

      expect(sessionStoreState.applyPresetToSession).toHaveBeenCalledWith('session-1', 'preset-1');
    });

    it('deletes bookmark via trash button', () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [{ id: '2', command: 'yazi', label: 'yazi' }],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-delete-preset-1'));

      expect(sessionStoreState.deletePreset).toHaveBeenCalledWith('preset-1');
    });

    it('shows error message when save fails', async () => {
      sessionStoreState.presets = [];
      sessionStoreState.saveBookmarkForSession = vi.fn(async (): Promise<{ id: string; name: string; tabs: never[]; createdAt: string } | null> => {
        sessionStoreState.error = 'Open at least one tab (2-6) before saving a bookmark';
        return null;
      });

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      const input = screen.getByTestId('header-bookmark-name-input');
      fireEvent.input(input, { target: { value: 'My Preset' } });
      fireEvent.click(screen.getByTestId('header-bookmark-save'));

      await waitFor(() => {
        expect(screen.getByTestId('header-bookmark-error')).toBeInTheDocument();
        expect(screen.getByTestId('header-bookmark-error')).toHaveTextContent('Open at least one tab (2-6) before saving a bookmark');
      });
    });

    it('shows rename input when pencil icon is clicked', () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [{ id: '2', command: 'yazi', label: 'yazi' }],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-rename-preset-1'));

      expect(screen.getByTestId('header-bookmark-rename-row-preset-1')).toBeInTheDocument();
      expect(screen.getByTestId('header-bookmark-rename-input-preset-1')).toBeInTheDocument();
      expect(screen.getByTestId('header-bookmark-rename-confirm-preset-1')).toBeInTheDocument();
      expect(screen.getByTestId('header-bookmark-rename-cancel-preset-1')).toBeInTheDocument();
    });

    it('calls renamePreset when confirming rename', async () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [{ id: '2', command: 'yazi', label: 'yazi' }],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-rename-preset-1'));

      const input = screen.getByTestId('header-bookmark-rename-input-preset-1');
      fireEvent.input(input, { target: { value: 'New Name' } });
      fireEvent.click(screen.getByTestId('header-bookmark-rename-confirm-preset-1'));

      expect(sessionStoreState.renamePreset).toHaveBeenCalledWith('preset-1', 'New Name');
    });

    it('cancels rename when cancel button is clicked', () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [{ id: '2', command: 'yazi', label: 'yazi' }],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-rename-preset-1'));

      // Rename row should be visible
      expect(screen.getByTestId('header-bookmark-rename-row-preset-1')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('header-bookmark-rename-cancel-preset-1'));

      // Rename row should be gone, original item should be back
      expect(screen.queryByTestId('header-bookmark-rename-row-preset-1')).not.toBeInTheDocument();
      expect(screen.getByTestId('header-bookmark-item-preset-1')).toBeInTheDocument();
    });

    it('confirms rename via Enter key', async () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [{ id: '2', command: 'yazi', label: 'yazi' }],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-rename-preset-1'));

      const input = screen.getByTestId('header-bookmark-rename-input-preset-1');
      fireEvent.input(input, { target: { value: 'New Name' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(sessionStoreState.renamePreset).toHaveBeenCalledWith('preset-1', 'New Name');
    });

    it('cancels rename via Escape key', () => {
      sessionStoreState.presets = [
        {
          id: 'preset-1',
          name: 'Dev Stack',
          createdAt: new Date().toISOString(),
          tabs: [{ id: '2', command: 'yazi', label: 'yazi' }],
        },
      ];

      render(() => <Header {...defaultSessionProps} />);

      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      fireEvent.click(screen.getByTestId('header-bookmark-rename-preset-1'));

      const input = screen.getByTestId('header-bookmark-rename-input-preset-1');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(screen.queryByTestId('header-bookmark-rename-row-preset-1')).not.toBeInTheDocument();
      expect(screen.getByTestId('header-bookmark-item-preset-1')).toBeInTheDocument();
    });

    it('clears error when reopening bookmarks menu', async () => {
      sessionStoreState.presets = [];
      sessionStoreState.saveBookmarkForSession = vi.fn(async (): Promise<{ id: string; name: string; tabs: never[]; createdAt: string } | null> => {
        sessionStoreState.error = 'Some error';
        return null;
      });

      render(() => <Header {...defaultSessionProps} />);

      // Open and trigger error
      fireEvent.click(screen.getByTestId('header-bookmarks-button'));
      const input = screen.getByTestId('header-bookmark-name-input');
      fireEvent.input(input, { target: { value: 'test' } });
      fireEvent.click(screen.getByTestId('header-bookmark-save'));

      await waitFor(() => {
        expect(screen.getByTestId('header-bookmark-error')).toBeInTheDocument();
      });

      // Close menu
      fireEvent.click(screen.getByTestId('header-bookmarks-button'));

      // Reopen menu
      fireEvent.click(screen.getByTestId('header-bookmarks-button'));

      // Error should be cleared
      expect(screen.queryByTestId('header-bookmark-error')).not.toBeInTheDocument();
    });
  });

  describe('Storage Button', () => {
    it('should render file-cabinet icon button with correct testid', () => {
      render(() => <Header {...defaultSessionProps} />);

      const storageButton = screen.getByTestId('header-storage-button');
      expect(storageButton).toBeInTheDocument();
    });

    it('should call onStoragePanelToggle when clicked', () => {
      const handleToggle = vi.fn();
      render(() => <Header {...defaultSessionProps} onStoragePanelToggle={handleToggle} />);

      const storageButton = screen.getByTestId('header-storage-button');
      fireEvent.click(storageButton);

      expect(handleToggle).toHaveBeenCalledTimes(1);
    });

    it('should not throw when clicked without handler', () => {
      render(() => <Header {...defaultSessionProps} />);
      const storageButton = screen.getByTestId('header-storage-button');

      expect(() => fireEvent.click(storageButton)).not.toThrow();
    });
  });

  describe('Settings Button', () => {
    it('should call onSettingsClick when clicked', () => {
      const handleSettingsClick = vi.fn();
      render(() => <Header {...defaultSessionProps} onSettingsClick={handleSettingsClick} />);

      const settingsButton = screen.getByTestId('header-settings-button');
      fireEvent.click(settingsButton);

      expect(handleSettingsClick).toHaveBeenCalledTimes(1);
    });

    it('should not throw when clicked without handler', () => {
      render(() => <Header {...defaultSessionProps} />);
      const settingsButton = screen.getByTestId('header-settings-button');

      expect(() => fireEvent.click(settingsButton)).not.toThrow();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible button labels', () => {
      render(() => <Header {...defaultSessionProps} />);

      const settingsButton = screen.getByTestId('header-settings-button');
      expect(settingsButton).toHaveAttribute('title');
    });
  });

  describe('Logo', () => {
    it('should show XML icon on desktop', () => {
      isMobileMock.value = false;
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} onLogoClick={() => {}} />);

      const logo = screen.getByTestId('header-logo');
      const svg = logo.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(logo).toHaveClass('header-logo--clickable');
    });

    it('should call onLogoClick on desktop when logo is clicked', () => {
      isMobileMock.value = false;
      const handleLogoClick = vi.fn();
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} onLogoClick={handleLogoClick} />);

      fireEvent.click(screen.getByTestId('header-logo'));
      expect(handleLogoClick).toHaveBeenCalledTimes(1);
    });

    it('should always use mdiXml icon (never mdiMenu), even on mobile', () => {
      isMobileMock.value = true;
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);

      const logo = screen.getByTestId('header-logo');
      const svgPath = logo.querySelector('svg path');
      expect(svgPath?.getAttribute('d')).toBe(mdiXml);
    });
  });

  describe('Session Switcher', () => {
    it('renders SessionSwitcher component', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      expect(screen.getByTestId('session-switcher')).toBeInTheDocument();
    });

    it('does not render "Codeflare" title text', () => {
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      expect(screen.queryByText('Codeflare')).not.toBeInTheDocument();
    });

    it('does not render hamburger menu icon on mobile', () => {
      isMobileMock.value = true;
      render(() => <Header sessions={[]} activeSessionId={null} onSelectSession={() => {}} onStopSession={() => {}} onDeleteSession={() => {}} onCreateSession={() => {}} />);
      const logo = screen.getByTestId('header-logo');
      const svgPath = logo.querySelector('svg path');
      expect(svgPath?.getAttribute('d')).toBe(mdiXml);
    });
  });

  describe('Auth URL Button', () => {
    it('renders auth URL button when terminalStore.authUrl is set', () => {
      terminalStoreMock.authUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc';
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn');
      expect(authBtn).toBeInTheDocument();
      expect(authBtn?.textContent).toContain('Open URL');
    });

    it('does NOT render auth URL button when terminalStore.authUrl is null', () => {
      terminalStoreMock.authUrl = null;
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn');
      expect(authBtn).not.toBeInTheDocument();
    });

    it('auth URL button has bounce animation class', () => {
      terminalStoreMock.authUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc';
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn');
      expect(authBtn).toBeInTheDocument();
      // The button or its container should have the bounce-in animation class
      expect(authBtn?.className).toContain('header-auth-url-bounce-in');
    });

    it('clicking auth URL button calls window.open with the URL', () => {
      const testUrl = 'https://console.anthropic.com/oauth/authorize?client_id=abc';
      terminalStoreMock.authUrl = testUrl;

      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(() => <Header {...defaultSessionProps} />);

      const authBtn = document.querySelector('.header-auth-url-btn') as HTMLElement;
      expect(authBtn).toBeInTheDocument();
      fireEvent.click(authBtn);

      expect(openSpy).toHaveBeenCalledWith(testUrl, '_blank', 'noopener');
      openSpy.mockRestore();
    });
  });
});
