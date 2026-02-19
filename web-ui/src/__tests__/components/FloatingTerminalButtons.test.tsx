import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';
import FloatingTerminalButtons from '../../components/FloatingTerminalButtons';
import { terminalStore } from '../../stores/terminal';
import { sessionStore } from '../../stores/session';

// Mocks for mobile detection
const mobileMock = vi.hoisted(() => ({
  isTouchDevice: vi.fn(() => true),
  isVirtualKeyboardOpen: vi.fn(() => true),
  getKeyboardHeight: vi.fn(() => 300),
  resetKeyboardStateIfStale: vi.fn(),
  forceResetKeyboardState: vi.fn(),
}));

const settingsMock = vi.hoisted(() => ({
  showButtonLabels: true as boolean | undefined,
}));

vi.mock('../../lib/mobile', () => mobileMock);

vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(() => ({ showButtonLabels: settingsMock.showButtonLabels })),
}));

vi.mock('../../lib/touch-gestures', () => ({
  sendTerminalKey: vi.fn(),
}));

const terminalStoreMock = vi.hoisted(() => ({
  authUrl: null as string | null,
  normalUrl: null as string | null,
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getTerminal: vi.fn(() => null),
    get authUrl() { return terminalStoreMock.authUrl; },
    get normalUrl() { return terminalStoreMock.normalUrl; },
  },
}));

vi.mock('../../stores/session', () => ({
  sessionStore: {
    activeSessionId: null,
    getTerminalsForSession: vi.fn(() => null),
  },
}));

describe('FloatingTerminalButtons', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mobileMock.isTouchDevice.mockReturnValue(true);
    mobileMock.isVirtualKeyboardOpen.mockReturnValue(true);
    mobileMock.getKeyboardHeight.mockReturnValue(300);

    settingsMock.showButtonLabels = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    (sessionStore as any).activeSessionId = null;
    vi.mocked(terminalStore.getTerminal).mockReturnValue(undefined as any);
    vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue(undefined as any);
    terminalStoreMock.authUrl = null;
    terminalStoreMock.normalUrl = null;
  });

  describe('Label Visibility', () => {
    it('renders labels with visible class when buttons appear', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const labels = document.querySelectorAll('.floating-btn-label');
      expect(labels.length).toBeGreaterThan(0);
      labels.forEach((label) => {
        expect(label).toHaveClass('visible');
      });
    });

    it('removes visible class from labels after 3 seconds', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const labels = document.querySelectorAll('.floating-btn-label');
      expect(labels.length).toBeGreaterThan(0);

      // Labels should be visible initially
      labels.forEach((label) => {
        expect(label).toHaveClass('visible');
      });

      // Advance past the 3-second timeout
      vi.advanceTimersByTime(3000);

      labels.forEach((label) => {
        expect(label).not.toHaveClass('visible');
      });
    });

    it('does not show visible labels when setting is disabled', () => {
      settingsMock.showButtonLabels = false;

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const labels = document.querySelectorAll('.floating-btn-label');
      labels.forEach((label) => {
        expect(label).not.toHaveClass('visible');
      });
    });
  });

  describe('Label Content', () => {
    it('renders correct label text for each button', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const labels = document.querySelectorAll('.floating-btn-label');
      const labelTexts = Array.from(labels).map((l) => l.textContent);

      // Copy URL buttons are conditional on hasAuthUrl/hasNormalUrl, so neither will appear
      expect(labelTexts).toContain('PASTE');
      expect(labelTexts).toContain('TAB');
      expect(labelTexts).toContain('ESCAPE / CANCEL');
      expect(labelTexts).toContain('SCROLL TO BOTTOM');
    });
  });

  describe('Button Row Structure', () => {
    it('wraps each button in a floating-btn-row container', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const rows = document.querySelectorAll('.floating-btn-row');
      // 5 always-visible buttons (paste, tab, esc, page-up, scroll-to-bottom) — copy URL is conditional
      expect(rows.length).toBe(5);

      rows.forEach((row) => {
        expect(row.querySelector('.floating-btn-label')).toBeInTheDocument();
        expect(row.querySelector('.floating-terminal-btn')).toBeInTheDocument();
      });
    });
  });

  describe('Conditional Rendering', () => {
    it('does not render when not on mobile', () => {
      mobileMock.isTouchDevice.mockReturnValue(false);

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const buttons = document.querySelector('.floating-terminal-buttons');
      expect(buttons).not.toBeInTheDocument();
    });

    it('does not render when terminal is not shown', () => {
      render(() => <FloatingTerminalButtons showTerminal={false} />);

      const buttons = document.querySelector('.floating-terminal-buttons');
      expect(buttons).not.toBeInTheDocument();
    });

    it('does not render when virtual keyboard is closed', () => {
      mobileMock.isVirtualKeyboardOpen.mockReturnValue(false);

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const buttons = document.querySelector('.floating-terminal-buttons');
      expect(buttons).not.toBeInTheDocument();
    });
  });

  describe('Desktop URL Button (removed — moved to Header)', () => {
    it('does NOT render desktop URL button (auth URL button now lives in Header)', () => {
      mobileMock.isTouchDevice.mockReturnValue(false);
      mobileMock.isVirtualKeyboardOpen.mockReturnValue(false);

      // Mock a terminal with a URL in the buffer
      const mockBuffer = {
        length: 2,
        getLine: (y: number) => {
          const lines = [
            { isWrapped: false, translateToString: () => 'Visit this URL:' },
            { isWrapped: false, translateToString: () => 'https://console.anthropic.com/oauth/authorize?client_id=abc123' },
          ];
          return lines[y] || null;
        },
      };

      // Configure session store to return an active session
      (sessionStore as any).activeSessionId = 'test-session';
      vi.mocked(sessionStore.getTerminalsForSession).mockReturnValue({ activeTabId: '1' } as any);
      vi.mocked(terminalStore.getTerminal).mockReturnValue({
        buffer: { active: mockBuffer },
        cols: 80,
      } as any);

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      // Trigger the URL check interval (URL_CHECK_INTERVAL_MS = 2000)
      vi.advanceTimersByTime(2000);

      // Desktop URL button should no longer exist in FloatingTerminalButtons
      const desktopBtn = document.querySelector('.desktop-url-button');
      expect(desktopBtn).not.toBeInTheDocument();
    });

    it('does not render mobile buttons on desktop', () => {
      mobileMock.isTouchDevice.mockReturnValue(false);

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const mobileButtons = document.querySelector('.floating-terminal-buttons');
      expect(mobileButtons).not.toBeInTheDocument();
    });
  });
});
