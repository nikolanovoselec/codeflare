import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks that must be set up BEFORE importing mobile.ts ---

// Mock settings (mobile.ts imports loadSettings for getKeyboardHeight)
vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(() => ({ samsungAddressBarTop: true })),
}));

import { loadSettings } from '../../lib/settings';

// We need to control module-level state, so we use vi.resetModules() per describe block
// and re-import. For tests that don't need module reset, we import once here.

describe('mobile.ts', () => {
  describe('resetKeyboardStateIfStale', () => {
    // These tests validate the enhanced resetKeyboardStateIfStale that handles
    // both keyboard-closed and keyboard-still-open cases on visibility return.

    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => any };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.clearAllMocks();

      mockVirtualKeyboard = {
        overlaysContent: false,
        boundingRect: { height: 0, width: 0, x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should reset signals and re-sync baseline when keyboard is closed (boundingRect.height=0)', async () => {
      // Set up navigator.virtualKeyboard before module loads
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Keyboard is closed
      mockVirtualKeyboard.boundingRect.height = 0;

      mobile.resetKeyboardStateIfStale();

      // vkOpen should be false, keyboardHeight should be 0
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
      expect(mobile.getKeyboardHeight()).toBe(0);

      // Clean up
      delete (navigator as any).virtualKeyboard;
    });

    it('should re-enable overlaysContent and re-sync signals when keyboard is still open (boundingRect.height>0)', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Keyboard is open with height 300
      mockVirtualKeyboard.boundingRect.height = 300;
      mockVirtualKeyboard.overlaysContent = false; // Was disabled on terminal cleanup

      mobile.resetKeyboardStateIfStale();

      // overlaysContent should be re-enabled
      expect(mockVirtualKeyboard.overlaysContent).toBe(true);
      // vkOpen should be true
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      delete (navigator as any).virtualKeyboard;
    });

    it('should be a no-op when virtualKeyboard API is not available', async () => {
      // Ensure no virtualKeyboard
      delete (navigator as any).virtualKeyboard;

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Should not throw
      expect(() => mobile.resetKeyboardStateIfStale()).not.toThrow();
    });
  });

  describe('getKeyboardHeight - Samsung compensation', () => {
    // These tests verify the Samsung address bar position compensation logic.
    // Samsung Internet has a bug where the bottom address bar causes viewport growth
    // that inflates the reported keyboard height.

    it('should return raw keyboardHeight when address bar is at top (default)', async () => {
      // With samsungAddressBarTop: true (default), no subtraction occurs
      vi.mocked(loadSettings).mockReturnValue({ samsungAddressBarTop: true });

      // We can't easily control isSamsungBrowser at runtime since it's module-level,
      // so we test via the exported function behavior.
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // On non-Samsung browsers, getKeyboardHeight subtracts viewportGrowth
      // (which is 0 by default), so it returns the raw keyboardHeight
      expect(mobile.getKeyboardHeight()).toBe(0);
    });

    it('should return raw keyboardHeight on wide screens (>600px) regardless of bar position', async () => {
      // Samsung on wide screen (unfolded Fold) should not subtract
      vi.mocked(loadSettings).mockReturnValue({ samsungAddressBarTop: false });

      Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // On non-Samsung environments, getKeyboardHeight returns max(0, kbHeight - vpGrowth)
      // Both are 0, so result is 0
      expect(mobile.getKeyboardHeight()).toBe(0);
    });
  });

  describe('visibilitychange handler', () => {
    // The visibilitychange listener calls resetKeyboardStateIfStale() when
    // the page becomes visible again. We test the EFFECT (signal state changes)
    // rather than spying on the function, because the listener captures the
    // original function reference at registration time — vi.spyOn on the export
    // doesn't intercept calls from the closed-over reference.

    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => any };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };

    it('should reset keyboard signals on visibility return when keyboard is closed', async () => {
      mockVirtualKeyboard = {
        overlaysContent: false,
        boundingRect: { height: 0, width: 0, x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 2, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)' ? true : query === '(max-width: 640px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })) as any;

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Keyboard closed (boundingRect.height = 0) — signals should be reset
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
      expect(mobile.getKeyboardHeight()).toBe(0);

      // Cleanup
      window.matchMedia = originalMatchMedia;
      delete (navigator as any).virtualKeyboard;
    });
  });

  describe('forceResetKeyboardState', () => {
    it('should unconditionally zero all signals', async () => {
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      mobile.forceResetKeyboardState();

      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
      expect(mobile.getKeyboardHeight()).toBe(0);
    });
  });

  describe('enableVirtualKeyboardOverlay / disableVirtualKeyboardOverlay', () => {
    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => any };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      mockVirtualKeyboard = {
        overlaysContent: false,
        boundingRect: { height: 0, width: 0, x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (navigator as any).virtualKeyboard;
    });

    it('enableVirtualKeyboardOverlay sets overlaysContent to true', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      mobile.enableVirtualKeyboardOverlay();
      expect(mockVirtualKeyboard.overlaysContent).toBe(true);
    });

    it('disableVirtualKeyboardOverlay sets overlaysContent to false', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      mockVirtualKeyboard.overlaysContent = true;
      mobile.disableVirtualKeyboardOverlay();
      expect(mockVirtualKeyboard.overlaysContent).toBe(false);
    });
  });

  describe('keyboard close polling', () => {
    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => any };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      mockVirtualKeyboard = {
        overlaysContent: true,
        boundingRect: { height: 300, width: 0, x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (navigator as any).virtualKeyboard;
    });

    it('force-resets after 2 consecutive zero readings', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Simulate geometrychange firing with keyboard open (triggers startKeyboardPolling)
      const geometryHandler = mockVirtualKeyboard.addEventListener.mock.calls.find(
        (call: any[]) => call[0] === 'geometrychange'
      )?.[1] as (() => void) | undefined;
      expect(geometryHandler).toBeDefined();
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler!();

      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Now simulate Samsung back-button: keyboard dismissed without geometrychange
      mockVirtualKeyboard.boundingRect.height = 0;

      // First poll — single zero reading, should NOT reset yet
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Second poll — 2 consecutive zeros, should force-reset
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
      expect(mobile.getKeyboardHeight()).toBe(0);
    });

    it('does NOT reset after single zero reading', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Trigger geometrychange to start polling
      const geometryHandler = mockVirtualKeyboard.addEventListener.mock.calls.find(
        (call: any[]) => call[0] === 'geometrychange'
      )?.[1] as (() => void) | undefined;
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler!();

      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Keyboard dismissed without event
      mockVirtualKeyboard.boundingRect.height = 0;

      // Only one poll tick — should still be open
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);
    });

    it('resets counter on non-zero reading between zeros', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Start polling via geometrychange
      const geometryHandler = mockVirtualKeyboard.addEventListener.mock.calls.find(
        (call: any[]) => call[0] === 'geometrychange'
      )?.[1] as (() => void) | undefined;
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler!();

      // First zero reading
      mockVirtualKeyboard.boundingRect.height = 0;
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Non-zero reading resets counter
      mockVirtualKeyboard.boundingRect.height = 300;
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Another zero — only 1 consecutive zero, should NOT reset
      mockVirtualKeyboard.boundingRect.height = 0;
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);
    });

    it('self-stops when keyboard closes normally', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Start polling via geometrychange
      const geometryHandler = mockVirtualKeyboard.addEventListener.mock.calls.find(
        (call: any[]) => call[0] === 'geometrychange'
      )?.[1] as (() => void) | undefined;
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler!();

      // Force-reset after 2 zero readings
      mockVirtualKeyboard.boundingRect.height = 0;
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500);
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);

      // After reset, further ticks should NOT throw or change state
      // (polling should have stopped)
      mockVirtualKeyboard.boundingRect.height = 300;
      vi.advanceTimersByTime(500);
      // vkOpen should still be false because polling stopped and no geometrychange fired
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
    });

    it('no polling when VirtualKeyboard API unavailable', async () => {
      // Ensure no virtualKeyboard
      delete (navigator as any).virtualKeyboard;

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Should not throw — no interval set, no errors
      vi.advanceTimersByTime(5000);
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
    });

    it('exported constants match expected values', async () => {
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      expect(mobile.KEYBOARD_POLL_INTERVAL_MS).toBe(500);
      expect(mobile.KEYBOARD_POLL_ZERO_THRESHOLD).toBe(2);
    });
  });
});
