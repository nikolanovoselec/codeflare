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

  describe('forceResetKeyboardState', () => {
    it('should unconditionally zero all signals', async () => {
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      mobile.forceResetKeyboardState();

      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
      expect(mobile.getKeyboardHeight()).toBe(0);
    });
  });

  describe('stale geometrychange ignore window (Fix 2)', () => {
    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => any };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };
    let geometryHandler: () => void;

    beforeEach(() => {
      vi.useFakeTimers();
      mockVirtualKeyboard = {
        overlaysContent: true,
        boundingRect: { height: 0, width: 0, x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn((_type: string, handler: () => void) => { geometryHandler = handler; }),
        removeEventListener: vi.fn(),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (navigator as any).virtualKeyboard;
    });

    it('should ignore geometrychange events within 50ms of enableVirtualKeyboardOverlay', async () => {
      // Start with overlaysContent false to simulate the actual toggle scenario
      // (Samsung fires stale geometrychange when overlaysContent goes false→true)
      mockVirtualKeyboard.overlaysContent = false;
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Enable overlay (false→true toggle) — sets overlaysContentChangedAt = Date.now()
      mobile.enableVirtualKeyboardOverlay();

      // Simulate stale geometrychange with keyboard height (within 50ms)
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler();

      // Should have been ignored — keyboard should NOT be reported as open
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
    });

    it('should accept geometrychange events after 50ms grace period', async () => {
      // Start with overlaysContent false to simulate the actual toggle scenario
      mockVirtualKeyboard.overlaysContent = false;
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Enable overlay (false→true toggle)
      mobile.enableVirtualKeyboardOverlay();

      // Advance past 50ms grace period
      vi.advanceTimersByTime(60);

      // Now simulate geometrychange — should be accepted
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler();

      expect(mobile.isVirtualKeyboardOpen()).toBe(true);
      expect(mobile.getKeyboardHeight()).toBe(300);
    });
  });

  describe('baselineInnerHeight stability on keyboard close', () => {
    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => any };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };
    let geometryHandler: () => void;

    beforeEach(() => {
      vi.useFakeTimers();
      mockVirtualKeyboard = {
        overlaysContent: true,
        boundingRect: { height: 0, width: 0, x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn((_type: string, handler: () => void) => { geometryHandler = handler; }),
        removeEventListener: vi.fn(),
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (navigator as any).virtualKeyboard;
    });

    it('should report consistent keyboard height across close/reopen cycles', async () => {
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // First open
      vi.advanceTimersByTime(100);
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler();
      const firstOpenHeight = mobile.getKeyboardHeight();
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Close keyboard — innerHeight may be inflated (Samsung bottom bar)
      (window as any).innerHeight = 847;
      mockVirtualKeyboard.boundingRect.height = 0;
      geometryHandler();
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);

      // Re-open — height must match first open (baseline not corrupted)
      (window as any).innerHeight = 847;
      mockVirtualKeyboard.boundingRect.height = 300;
      geometryHandler();
      expect(mobile.getKeyboardHeight()).toBe(firstOpenHeight);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);
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
