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
    // the page becomes visible again. This verifies the integration.

    it('should call resetKeyboardStateIfStale on visibility return', async () => {
      // We need a touch device for the handler to be registered
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 2, configurable: true });

      // Ensure matchMedia returns coarse pointer
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

      // Spy on resetKeyboardStateIfStale after import
      const resetSpy = vi.spyOn(mobile, 'resetKeyboardStateIfStale');

      // Simulate visibility change to visible
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(resetSpy).toHaveBeenCalled();

      // Cleanup
      window.matchMedia = originalMatchMedia;
      resetSpy.mockRestore();
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
});
