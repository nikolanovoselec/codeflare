/**
 * AC coverage for REQ-MOB-001, REQ-MOB-002, REQ-MOB-004, REQ-MOB-010, REQ-MOB-012
 *
 * Scope: ACs that are unit-testable in jsdom with vitest.
 * Playwright candidates (real device/browser required) are documented below.
 *
 * PLAYWRIGHT CANDIDATES (not covered here):
 *   REQ-MOB-001 AC1 - terminal renders on real mobile viewport (Playwright + Android emulator)
 *   REQ-MOB-001 AC2 - touch input / command execution identical to desktop (Playwright E2E)
 *   REQ-MOB-001 AC3 - e2e-ui-mobile CI job passes (CI job, not a unit test)
 *   REQ-MOB-002 AC5 - iframe compositor jail (not exported; Playwright + Android IME)
 *   REQ-MOB-002 AC7 - isFocused via iframe.contentDocument.hasFocus() (not exported; Playwright)
 *   REQ-MOB-004 AC1 - .xterm-viewport overflow:hidden CSS rule (visual / Playwright)
 *   REQ-MOB-004 AC2 - _syncTextArea not frozen (xterm internal; Playwright)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Module-level mocks before any import ---

vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(() => ({ samsungAddressBarTop: true })),
}));

// ============================================================================
// REQ-MOB-001: Terminal fully usable on mobile devices
// ACs covered: AC4, AC5, AC6
// AC1/AC2/AC3 are Playwright candidates (documented above)
// ============================================================================

describe('REQ-MOB-001: Terminal fully usable on mobile devices', () => {
  // AC4 + AC5: keyboard open/close triggers layout adjustment via getKeyboardHeight signal
  describe('AC4 + AC5: layout adjusts when virtual keyboard opens or closes (VirtualKeyboard API)', () => {
    let mockVirtualKeyboard: {
      overlaysContent: boolean;
      boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => object };
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };
    let geometryHandler: () => void;

    beforeEach(() => {
      vi.useFakeTimers();
      mockVirtualKeyboard = {
        overlaysContent: true,
        boundingRect: { height: 0, width: 375, x: 0, y: 0, top: 0, right: 375, bottom: 0, left: 0, toJSON: () => ({}) },
        addEventListener: vi.fn((_type: string, handler: () => void) => { geometryHandler = handler; }),
        removeEventListener: vi.fn(),
      };
      Object.defineProperty(navigator, 'virtualKeyboard', {
        value: mockVirtualKeyboard,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (navigator as any).virtualKeyboard;
    });

    it('REQ-MOB-001 AC4: keyboard height is non-zero after geometrychange fires with keyboard open', async () => {
      // REQ-MOB-001 AC4: terminal adjusts layout when virtual keyboard opens
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Allow past the 50ms ignore window
      vi.advanceTimersByTime(60);

      // Simulate keyboard open
      mockVirtualKeyboard.boundingRect.height = 336;
      geometryHandler();

      // Height signal must be non-zero - proves layout will reduce terminal height
      expect(mobile.getKeyboardHeight()).toBe(336);
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);
    });

    it('REQ-MOB-001 AC4: keyboard height returns to zero after keyboard closes', async () => {
      // REQ-MOB-001 AC4: terminal adjusts back when keyboard closes
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      vi.advanceTimersByTime(60);

      // Open
      mockVirtualKeyboard.boundingRect.height = 336;
      geometryHandler();
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);

      // Close
      mockVirtualKeyboard.boundingRect.height = 0;
      geometryHandler();
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
      expect(mobile.getKeyboardHeight()).toBe(0);
    });

    it('REQ-MOB-001 AC5: visualViewport resize event triggers keyboard state update (fallback path)', async () => {
      // REQ-MOB-001 AC5: FitAddon recalculates on viewport changes via visualViewport resize
      // This tests the fallback detection path (iOS Safari / Firefox)
      delete (navigator as any).virtualKeyboard;

      let resizeHandler: (() => void) | undefined;
      const mockVisualViewport = {
        height: 844,
        width: 390,
        addEventListener: vi.fn((type: string, handler: () => void) => {
          if (type === 'resize') resizeHandler = handler;
        }),
        removeEventListener: vi.fn(),
      };

      Object.defineProperty(window, 'visualViewport', {
        value: mockVisualViewport,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(document.documentElement, 'clientHeight', {
        value: 844,
        configurable: true,
      });

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // Simulate viewport shrinking when keyboard opens (iOS pattern)
      mockVisualViewport.height = 504;
      resizeHandler!();

      // Keyboard state updated - proves refit trigger path is active
      expect(mobile.isVirtualKeyboardOpen()).toBe(true);
      expect(mobile.getKeyboardHeight()).toBe(340);
    });
  });

  // AC6: fit() call sites guard against zero-height containers
  describe('AC6: fit() sites guard against zero-height containers', () => {
    it('REQ-MOB-001 AC6: getKeyboardHeight returns 0 when keyboard state is clean (safe baseline for fit guards)', async () => {
      // REQ-MOB-001 AC6: The zero-height guard (containerEl.clientHeight === 0) is implemented
      // in useTerminal.ts. This test verifies the state machine that drives those guards:
      // when no keyboard is detected, height is 0, so fit() must not proceed on a zero container.
      // The guard logic reads containerEl.clientHeight > 0 before calling fitAddon.fit().
      delete (navigator as any).virtualKeyboard;

      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      // With no keyboard detected, height should be 0
      expect(mobile.getKeyboardHeight()).toBe(0);
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
    });

    it('REQ-MOB-001 AC6: forceResetKeyboardState zeros all signals (guards can rely on clean state)', async () => {
      // REQ-MOB-001 AC6: After forceReset, height is 0 - fit guard will skip correctly
      vi.resetModules();
      const mobile = await import('../../lib/mobile');

      mobile.forceResetKeyboardState();

      expect(mobile.getKeyboardHeight()).toBe(0);
      expect(mobile.isVirtualKeyboardOpen()).toBe(false);
    });
  });
});

// ============================================================================
// REQ-MOB-002: Virtual keyboard opens reliably on tap
// ACs covered: AC1, AC2, AC3, AC4, AC6
// AC5 (iframe compositor) and AC7 (isFocused) are Playwright candidates
// ============================================================================

describe('REQ-MOB-002: Virtual keyboard opens reliably on tap', () => {
  let mockVirtualKeyboard: {
    overlaysContent: boolean;
    boundingRect: { height: number; width: number; x: number; y: number; top: number; right: number; bottom: number; left: number; toJSON: () => object };
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  let geometryHandler: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mockVirtualKeyboard = {
      overlaysContent: false,
      boundingRect: { height: 0, width: 375, x: 0, y: 0, top: 0, right: 375, bottom: 0, left: 0, toJSON: () => ({}) },
      addEventListener: vi.fn((_type: string, handler: () => void) => { geometryHandler = handler; }),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (navigator as any).virtualKeyboard;
  });

  it('REQ-MOB-002 AC1: enableVirtualKeyboardOverlay sets overlaysContent=true immediately (before focus)', async () => {
    // REQ-MOB-002 AC1: overlaysContent is set BEFORE focus, beating the layout race condition.
    // The call must be synchronous - not deferred to rAF or microtask.
    Object.defineProperty(navigator, 'virtualKeyboard', {
      value: mockVirtualKeyboard,
      configurable: true,
      writable: true,
    });

    vi.resetModules();
    const mobile = await import('../../lib/mobile');

    expect(mockVirtualKeyboard.overlaysContent).toBe(false);
    mobile.enableVirtualKeyboardOverlay();
    // Must be synchronous - check immediately after call, no awaiting
    expect(mockVirtualKeyboard.overlaysContent).toBe(true);
  });

  it('REQ-MOB-002 AC1: enableVirtualKeyboardOverlay does NOT restamp ignore window on repeated calls (constraint)', async () => {
    // REQ-MOB-002 AC1 + constraint: redundant calls must not restamp the 50ms window
    Object.defineProperty(navigator, 'virtualKeyboard', {
      value: mockVirtualKeyboard,
      configurable: true,
      writable: true,
    });

    vi.resetModules();
    const mobile = await import('../../lib/mobile');

    // First call: false->true toggle, stamps window
    mobile.enableVirtualKeyboardOverlay();
    const firstCallDone = Date.now();

    // Advance time slightly
    vi.advanceTimersByTime(30);

    // Second call: already true, must NOT restamp
    mobile.enableVirtualKeyboardOverlay();

    // Advance past 50ms from first call
    vi.advanceTimersByTime(30);

    // geometrychange should now be accepted (window from first call expired)
    mockVirtualKeyboard.boundingRect.height = 336;
    geometryHandler();

    expect(mobile.isVirtualKeyboardOpen()).toBe(true);
    expect(firstCallDone).toBeLessThanOrEqual(Date.now());
  });

  it('REQ-MOB-002 AC2: disableVirtualKeyboardOverlay sets overlaysContent=false on terminal exit', async () => {
    // REQ-MOB-002 AC2: other inputs receive normal browser resizing after terminal exit
    mockVirtualKeyboard.overlaysContent = true;
    Object.defineProperty(navigator, 'virtualKeyboard', {
      value: mockVirtualKeyboard,
      configurable: true,
      writable: true,
    });

    vi.resetModules();
    const mobile = await import('../../lib/mobile');

    mobile.disableVirtualKeyboardOverlay();
    expect(mockVirtualKeyboard.overlaysContent).toBe(false);
  });

  it('REQ-MOB-002 AC3: geometrychange event registers on the VirtualKeyboard API at module init', async () => {
    // REQ-MOB-002 AC3: geometrychange event is used to detect keyboard height changes
    Object.defineProperty(navigator, 'virtualKeyboard', {
      value: mockVirtualKeyboard,
      configurable: true,
      writable: true,
    });

    vi.resetModules();
    await import('../../lib/mobile');

    // The module must register a geometrychange listener at init time
    expect(mockVirtualKeyboard.addEventListener).toHaveBeenCalledWith(
      'geometrychange',
      expect.any(Function),
    );
  });

  it('REQ-MOB-002 AC4: getKeyboardHeight returns keyboard height so terminal can reduce its own height', async () => {
    // REQ-MOB-002 AC4: terminal height is reduced by keyboard height to avoid content obscuring
    mockVirtualKeyboard.overlaysContent = true;
    Object.defineProperty(navigator, 'virtualKeyboard', {
      value: mockVirtualKeyboard,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });

    vi.resetModules();
    const mobile = await import('../../lib/mobile');

    vi.advanceTimersByTime(60);
    mockVirtualKeyboard.boundingRect.height = 300;
    geometryHandler();

    const height = mobile.getKeyboardHeight();
    // Height must be exactly what was reported - proves reduction signal is correct
    expect(height).toBe(300);
    expect(height).toBeGreaterThan(0);
  });

  // REQ-MOB-002 AC6 (the document.createElement monkey-patch that swaps xterm's
  // textarea for a password input during terminal.open(), then restores it) is
  // covered by a GENUINE behavioral test that mounts the hook on a touch device
  // and drives a textarea creation through the patch, in
  // web-ui/src/__tests__/hooks/useTerminal.test.ts ("swaps a textarea created
  // during terminal.open() for a password input and restores createElement
  // afterward"). The previous source-string-matching assertion was theater
  // and has been removed.

});

// ============================================================================
// REQ-MOB-004: Scroll-drop detection during burst output
//
// AC3 (post-write bottom-alignment guard) + AC4 (scroll-drop-to-zero detection)
// + AC5 (distance-based detection / small-drift ignore) are now covered by
// GENUINE behavioral tests that drive the real onScroll handler in
// web-ui/src/__tests__/hooks/useScrollCorrection.test.ts. The previous
// source-string-matching assertions here were theater (they passed even if
// the production detector were deleted) and have been removed.
//
// AC1 (CSS overflow:hidden) is a Playwright candidate.
// AC2 (_syncTextArea) is an xterm internal / Playwright candidate.
// ============================================================================

// ============================================================================
// REQ-MOB-010: FitAddon fit calls are coordinated
// ACs covered: AC1, AC2, AC3, AC4, AC5, AC6
// ============================================================================

describe('REQ-MOB-010: FitAddon fit calls are coordinated', () => {
  // REQ-MOB-010 AC1 (three fit() trigger paths) is covered by GENUINE
  // behavioral tests that mount the hook and drive each path in
  // web-ui/src/__tests__/hooks/useTerminal.test.ts:
  //   - keyboard refit path: "keyboard height refit" describe (fit() fires on
  //     keyboard open/close transitions).
  //   - active-state path: lifecycle tests mount the hook and fit() runs in the
  //     active-state effect's requestAnimationFrame.
  //   - ResizeObserver path: "kbDebounceTimer race fix" exercises the observer
  //     callback calling fit().
  // The previous source-string-matching assertion was theater and has been
  // removed.

  // REQ-MOB-010 AC2 (kbDebounceTimer gate short-circuits the ResizeObserver),
  // AC3 (scrollToBottom after fit() when the keyboard is open), and AC4
  // (isAtBottom gate before scrollToBottom on the no-keyboard path) are covered
  // by GENUINE behavioral tests that mount the hook and drive the keyboard
  // signals in web-ui/src/__tests__/hooks/useTerminal.test.ts:
  //   AC2 -> "should skip fitAddon.fit() in active-state effect when
  //          kbDebouncePending is true" + "kbDebounceTimer race fix".
  //   AC3 -> "should scroll to bottom when keyboard opens" / "mid-animation
  //          height adjustments while keyboard stays open".
  //   AC4 -> "should NOT scroll to bottom when keyboard closes".
  // The previous source-string-matching assertions were theater and have
  // been removed.

  it('REQ-MOB-010 AC5: when keyboard is open, isVirtualKeyboardOpen() returns true so ResizeObserver skips scrollToBottom', async () => {
    // REQ-MOB-010 AC5: ResizeObserver must not call scrollToBottom when keyboard is open
    // because the keyboard height change effect already handles that path.
    // We verify the gate condition: isVirtualKeyboardOpen() correctly returns true.
    let geometryHandler: (() => void) | undefined;
    const mockVirtualKeyboard = {
      overlaysContent: true,
      boundingRect: { height: 0, width: 375, x: 0, y: 0, top: 0, right: 375, bottom: 0, left: 0, toJSON: () => ({}) },
      addEventListener: vi.fn((_type: string, handler: () => void) => { geometryHandler = handler; }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, 'virtualKeyboard', {
      value: mockVirtualKeyboard,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });

    vi.resetModules();
    vi.useFakeTimers();
    const mobile = await import('../../lib/mobile');

    vi.advanceTimersByTime(60);
    mockVirtualKeyboard.boundingRect.height = 336;
    geometryHandler!();

    // Gate condition for ResizeObserver: keyboard IS open, so RO must skip scrollToBottom
    expect(mobile.isVirtualKeyboardOpen()).toBe(true);

    vi.useRealTimers();
    delete (navigator as any).virtualKeyboard;
  });

  // REQ-MOB-010 AC6 (a refit with unchanged dimensions sends no resize message)
  // is now covered by a GENUINE behavioral test that injects a terminal + an
  // OPEN WebSocket via registerLayoutDeps and asserts ws.send is/ isn't called,
  // in web-ui/src/__tests__/stores/terminal-layout.test.ts. The previous test
  // here registered a fitAddon with no terminal, so it only hit the early
  // `!terminal` branch and never exercised the dimension comparison — removed.
});

// ============================================================================
// REQ-MOB-012: Scroll anchoring during keyboard transitions
// ACs covered: AC1, AC2, AC3, AC4
// ============================================================================

// All REQ-MOB-012 ACs are now covered by GENUINE behavioral tests that drive
// the real onScroll handler (and the suppression marker / keyboard gate it
// consumes) in web-ui/src/__tests__/hooks/useScrollCorrection.test.ts:
//   AC1 (suppression marker bracketing): "skips correction while the
//        programmatic-scroll suppression marker is set".
//   AC2 (keyboard-open detector skip): "skips all correction when the mobile
//        keyboard is open" (+ the touch-AND-keyboard gate negative control).
//   AC3 (bottom-following synchronous re-anchor): "re-anchors a bottom-following
//        terminal when scrollback trimming displaces it".
//   AC4 (scrolled-up relative position preserved): "restores a scrolled-up user
//        after a browser focus reset snaps viewport to 0".
// The previous source-string-matching assertions here were theater (they
// passed even if the production hook were deleted) and have been removed.
//
// NOTE: the store-side begin/endProgrammaticScroll counter internals are not
// exported (module-private in stores/terminal.ts); only the consumer-observable
// behavior (isProgrammaticScrollSuppressed gating the detector) is unit-testable
// without reaching into private state, which the AC1 test above does.
