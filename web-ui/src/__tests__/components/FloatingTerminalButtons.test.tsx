import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@solidjs/testing-library';
import FloatingTerminalButtons from '../../components/FloatingTerminalButtons';
import { terminalStore } from '../../stores/terminal';
import { sessionStore } from '../../stores/session';
import { terminalWorkspaceStore } from '../../stores/terminal-workspace';
import { sendTerminalKey } from '../../lib/touch-gestures';
import { setIframeInput } from '../../lib/xterm-internals';

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
  clipboardAccess: false as boolean | undefined,
}));

vi.mock('../../lib/mobile', () => mobileMock);

vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(() => ({ showButtonLabels: settingsMock.showButtonLabels, clipboardAccess: settingsMock.clipboardAccess })),
}));

vi.mock('../../lib/touch-gestures', () => ({
  sendTerminalKey: vi.fn(),
}));

const workspaceMock = vi.hoisted(() => ({
  focusedPaneId: null as string | null,
  panes: [] as Array<{ id: string; sessionId: string; terminalId: string }>,
}));

vi.mock('../../stores/terminal-workspace', () => ({
  terminalWorkspaceStore: {
    getFocusedPaneId: vi.fn(() => workspaceMock.focusedPaneId),
    getVisiblePanes: vi.fn(() => workspaceMock.panes),
  },
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
    sessions: [],
    getTerminalsForSession: vi.fn(() => ({ activeTabId: '1' })),
  },
}));

const speechMock = vi.hoisted(() => ({
  supported: true as boolean,
  permissionState: 'prompt' as 'granted' | 'denied' | 'prompt' | 'unknown',
}));

vi.mock('../../lib/speech-input', () => ({
  isSpeechSupported: vi.fn(() => speechMock.supported),
  isListening: vi.fn(() => false),
  startListening: vi.fn(() => true),
  stopListening: vi.fn(),
  getMicPermissionState: vi.fn(async () => speechMock.permissionState),
}));

// REQ-MOB-001: Terminal fully usable on mobile devices
// REQ-TERM-017: MultiView Pane Focus and Input Routing
// REQ-MOB-007: Voice input via Web Speech API

describe('FloatingTerminalButtons / REQ-MOB-006 (sticky Ctrl button)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mobileMock.isTouchDevice.mockReturnValue(true);
    mobileMock.isVirtualKeyboardOpen.mockReturnValue(true);
    mobileMock.getKeyboardHeight.mockReturnValue(300);

    settingsMock.showButtonLabels = true;
    settingsMock.clipboardAccess = false;
    speechMock.supported = true;
    speechMock.permissionState = 'prompt';
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    (sessionStore as any).activeSessionId = null;
    vi.mocked(terminalStore.getTerminal).mockReturnValue(undefined as any);
    terminalStoreMock.authUrl = null;
    terminalStoreMock.normalUrl = null;
    workspaceMock.focusedPaneId = null;
    workspaceMock.panes = [];
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

  describe('Button Row Structure', () => {
    it('wraps each button in a floating-btn-row container', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const rows = document.querySelectorAll('.floating-btn-row');
      // 7 always-visible buttons when speech supported (paste, voice, tab, esc, ctrl, page-up, scroll-to-bottom) — copy URL is conditional
      expect(rows.length).toBe(7);

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

    it('shows 6 mobile button rows when speech not supported', () => {
      speechMock.supported = false;
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const rows = document.querySelectorAll('.floating-btn-row');
      expect(rows.length).toBe(6);
    });
  });

  describe('Voice input', () => {
    it('REQ-MOB-013 AC1: dismisses the mobile keyboard before speech may issue a first prompt when permission state is unknown', async () => {
      vi.useRealTimers();
      speechMock.permissionState = 'unknown';

      const iframeInput = document.createElement('input');
      document.body.appendChild(iframeInput);
      iframeInput.focus();
      const blurSpy = vi.spyOn(iframeInput, 'blur');
      const term = { input: vi.fn(), textarea: document.createElement('textarea') };
      setIframeInput(term as any, iframeInput);
      (sessionStore as any).activeSessionId = 'test-session';
      vi.mocked(terminalStore.getTerminal).mockReturnValue(term as any);
      const { startListening } = await import('../../lib/speech-input');

      render(() => <FloatingTerminalButtons showTerminal={true} />);
      screen.getByTitle('Voice Input').click();

      await vi.waitFor(() => expect(startListening).toHaveBeenCalledTimes(1));
      expect(blurSpy).toHaveBeenCalledTimes(1);
      expect(blurSpy.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(startListening).mock.invocationCallOrder[0],
      );
      iframeInput.remove();
    });
  });

  describe('Desktop Voice Button', () => {
    beforeEach(() => {
      mobileMock.isTouchDevice.mockReturnValue(false);
      speechMock.supported = true;
    });

    it('renders desktop mic button when not touch device and speech supported', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const mic = document.querySelector('.floating-mic-desktop');
      expect(mic).toBeInTheDocument();
      expect(mic!.querySelector('button')).toHaveAttribute('title', 'Voice Input (Ctrl+Space)');
    });

    it('hides desktop mic button when speech not supported', () => {
      speechMock.supported = false;
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const mic = document.querySelector('.floating-mic-desktop');
      expect(mic).not.toBeInTheDocument();
    });

    it('hides desktop mic button when terminal not shown', () => {
      render(() => <FloatingTerminalButtons showTerminal={false} />);

      const mic = document.querySelector('.floating-mic-desktop');
      expect(mic).not.toBeInTheDocument();
    });

    it('does not render mobile floating buttons on desktop', () => {
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const mobileButtons = document.querySelector('.floating-terminal-buttons');
      expect(mobileButtons).not.toBeInTheDocument();
    });
  });

  describe('Page navigation', () => {
    const setActiveTerminal = (bufferType: 'normal' | 'alternate') => {
      const bufferScrollLines = vi.fn();
      const refresh = vi.fn();
      const term = {
        rows: 24,
        buffer: { active: { type: bufferType, viewportY: 300, baseY: 1000 } },
        _core: { _bufferService: { scrollLines: bufferScrollLines } },
        scrollPages: vi.fn(),
        scrollToBottom: vi.fn(),
        refresh,
        textarea: document.createElement('textarea'),
      };
      (sessionStore as any).activeSessionId = 'test-session';
      vi.mocked(terminalStore.getTerminal).mockReturnValue(term as any);
      return { term, bufferScrollLines, refresh };
    };

    it('REQ-MOB-001 AC7: sends PageUp and PageDown to an alternate-screen application', () => {
      const { term, bufferScrollLines } = setActiveTerminal('alternate');
      vi.mocked(sendTerminalKey).mockClear();
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      screen.getByTitle('Page Up').click();
      screen.getByTitle('Scroll to Bottom').click();

      expect(vi.mocked(sendTerminalKey).mock.calls).toEqual([
        [term, '\x1b[5~'],
        [term, '\x1b[6~'],
      ]);
      expect(bufferScrollLines).not.toHaveBeenCalled();
      expect(term.scrollPages).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('REQ-MOB-001 AC6: navigates normal-buffer pages through the buffer scroll pipeline', () => {
      const { term, bufferScrollLines, refresh } = setActiveTerminal('normal');
      vi.mocked(sendTerminalKey).mockClear();
      render(() => <FloatingTerminalButtons showTerminal={true} />);

      screen.getByTitle('Page Up').click();
      screen.getByTitle('Scroll to Bottom').click();

      // Page up moves one page (rows - 1); bottom moves the exact buffer
      // distance — deltas come from the buffer, never from DOM scroll state.
      expect(bufferScrollLines.mock.calls).toEqual([[-23], [700]]);
      // Each direct buffer scroll must carry its own viewport repaint.
      expect(refresh.mock.calls).toEqual([[0, 23], [0, 23]]);
      expect(term.scrollPages).not.toHaveBeenCalled();
      expect(term.scrollToBottom).not.toHaveBeenCalled();
      expect(sendTerminalKey).not.toHaveBeenCalledWith(term, '\x1b[5~');
      expect(sendTerminalKey).not.toHaveBeenCalledWith(term, '\x1b[6~');
    });
  });

  describe('MultiView focused pane targeting', () => {
    it('REQ-TERM-012: sends floating-button keys to the focused MultiView pane when activeSessionId is null', () => {
      const paneA = { input: vi.fn(), textarea: document.createElement('textarea') };
      const paneB = { input: vi.fn(), textarea: document.createElement('textarea') };
      workspaceMock.panes = [
        { id: 'multiview:session-a:1', sessionId: 'session-a', terminalId: '1' },
        { id: 'multiview:session-b:1', sessionId: 'session-b', terminalId: '1' },
      ];
      workspaceMock.focusedPaneId = 'multiview:session-b:1';
      vi.mocked(terminalWorkspaceStore.getVisiblePanes).mockImplementation(() => workspaceMock.panes as any);
      vi.mocked(terminalWorkspaceStore.getFocusedPaneId).mockImplementation(() => workspaceMock.focusedPaneId);
      vi.mocked(terminalStore.getTerminal).mockImplementation((sessionId: string) => (sessionId === 'session-b' ? paneB : paneA) as any);

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      screen.getByTitle('TAB').click();

      expect(terminalStore.getTerminal).toHaveBeenCalledWith('session-b', '1');
      expect(sendTerminalKey).toHaveBeenCalledWith(paneB, '\t');
      expect(sendTerminalKey).not.toHaveBeenCalledWith(paneA, expect.anything());
    });
  });

  describe('Clipboard Access Guard', () => {
    it('should always read clipboard on mobile regardless of clipboardAccess setting', async () => {
      // Switch to real timers for this test — fake timers block async clipboard mocks
      vi.useRealTimers();

      settingsMock.clipboardAccess = false;

      const mockTerm = {
        paste: vi.fn(),
        textarea: document.createElement('textarea'),
      };
      (sessionStore as any).activeSessionId = 'test-session';
      vi.mocked(terminalStore.getTerminal).mockReturnValue(mockTerm as any);

      const readTextMock = vi.fn().mockResolvedValue('clipboard text');
      Object.assign(navigator, {
        clipboard: {
          readText: readTextMock,
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });

      render(() => <FloatingTerminalButtons showTerminal={true} />);

      const pasteBtn = screen.getByTitle('Paste');
      pasteBtn.click();

      // Mobile paste always works — clipboardAccess only gates desktop right-click paste
      await vi.waitFor(() => {
        expect(readTextMock).toHaveBeenCalled();
      });

      // Restore fake timers for subsequent tests
      vi.useFakeTimers();
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
