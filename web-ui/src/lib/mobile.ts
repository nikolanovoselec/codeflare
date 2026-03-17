import { createSignal } from 'solid-js';
import { loadSettings } from './settings';

/** Navigator with non-standard properties used for mobile keyboard detection. */
interface ExtendedNavigator extends Navigator {
  virtualKeyboard?: {
    overlaysContent: boolean;
    boundingRect: DOMRect;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  };
  userAgentData?: {
    platform: string;
    brands: Array<{ brand: string; version: string }>;
  };
  connection?: {
    effectiveType: string;
    downlink: number;
    rtt: number;
  };
}

/** Module-level typed navigator reference — single cast point for the entire module. */
const nav: ExtendedNavigator = typeof navigator !== 'undefined'
  ? navigator as ExtendedNavigator
  : {} as ExtendedNavigator;

// Module-level singleton signals
// Guard matchMedia for test environments (jsdom doesn't provide it)
const mobileQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width: 640px)')
  : null;

const [mobile, setMobile] = createSignal(mobileQuery?.matches ?? false);

if (mobileQuery) {
  const handleMobileChange = (e: MediaQueryListEvent) => setMobile(e.matches);
  mobileQuery.addEventListener('change', handleMobileChange);
}

export function isMobile(): boolean {
  return mobile();
}

// Touch device detection — targets phones/tablets with coarse (finger) input.
// Uses maxTouchPoints to confirm touch hardware, plus pointer:coarse to exclude
// desktops/laptops with touchscreens (e.g. Windows Surface) where mobile UI
// (floating buttons, keyboard padding) would be unwanted.
// Plain function (not reactive) — touch capability never changes mid-session.
export function isTouchDevice(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return navigator.maxTouchPoints > 0 &&
    (window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : true);
}

// Virtual keyboard detection — two strategies:
// 1. VirtualKeyboard API (Chrome Android 94+, Samsung Internet 17+, Edge 94+):
//    Uses overlaysContent=true so the browser doesn't resize the viewport.
//    geometrychange event gives exact keyboard height via boundingRect.
//    Enabled dynamically only when the terminal textarea is focused (see
//    enableVirtualKeyboardOverlay / disableVirtualKeyboardOverlay).
// 2. Fallback (iOS Safari, Firefox): clientHeight - visualViewport.height.
//    clientHeight is stable across keyboard open/close on iOS, unlike innerHeight
//    which is unreliable on Samsung Internet.
const [vkOpen, setVkOpen] = createSignal(false);
const [keyboardHeight, setKeyboardHeight] = createSignal(0);

// Track whether VirtualKeyboard API is being used (for consumers to know)
let usingVirtualKeyboardAPI = false;

// Samsung Internet UA detection. Samsung's bottom address bar creates a
// "locked layout viewport" bug: when the keyboard opens and the bottom bar
// hides, window.innerHeight grows but the CSS layout viewport (used for
// height:100%, flex:1, etc.) does NOT update. This creates a gap between
// terminal content and keyboard. We compensate by subtracting the viewport
// growth from keyboard height — but ONLY on Samsung Internet, because
// Chrome/Firefox resize the layout viewport correctly.
//
// UA detection is used instead of runtime heuristics (innerHeight comparison)
// because Chrome's URL bar hiding also changes innerHeight, causing false
// positives that break Chrome button positioning.
export const isSamsungBrowser = typeof navigator !== 'undefined'
  ? /SamsungBrowser/i.test(navigator.userAgent) : false;

/**
 * Detect iOS/iPadOS devices. Used for platform-specific focus behavior:
 * iOS Safari requires synchronous .focus() in user-gesture handlers to
 * open the virtual keyboard, while Android needs setTimeout(0) for
 * reliable cross-frame iframe focus timing.
 */
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

let baselineInnerHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
const [viewportGrowth, setViewportGrowth] = createSignal(0);

// Stale geometrychange ignore window: Samsung fires a cached stale geometrychange
// when overlaysContent is toggled. We ignore events within 50ms of the toggle.
let overlaysContentChangedAt = 0;


if (typeof window !== 'undefined') {
  if (nav.virtualKeyboard) {
    // Strategy 1: VirtualKeyboard API
    usingVirtualKeyboardAPI = true;
    const vk = nav.virtualKeyboard;

    const handleGeometryChange = () => {
      // Fix 2: Ignore stale events that fire immediately after overlaysContent toggle.
      // Samsung fires geometrychange with cached stale boundingRect on toggle.
      if (Date.now() - overlaysContentChangedAt < 50) return;

      // Only update signals when overlaysContent is true (we control layout).
      // When false, the browser handles viewport resizing and boundingRect is 0.
      if (vk.overlaysContent) {
        const height = vk.boundingRect.height;

        if (height > 0 && isSamsungBrowser) {
          // Samsung: track viewport growth from hidden bottom bar.
          const growth = Math.max(0, window.innerHeight - baselineInnerHeight);
          setViewportGrowth(growth);
        } else if (height <= 0) {
          // Keyboard closed — reset growth. Do NOT update baselineInnerHeight here:
          // Samsung fires geometrychange before the bottom bar returns, so
          // window.innerHeight is still inflated and would poison the baseline.
          setViewportGrowth(0);
        }

        setVkOpen(height > 0);
        setKeyboardHeight(height);
      } else {
        setVkOpen(false);
        setKeyboardHeight(0);
        setViewportGrowth(0);
      }
    };
    vk.addEventListener('geometrychange', handleGeometryChange);
    handleGeometryChange();

  } else if (window.visualViewport) {
    // Strategy 2: visualViewport fallback (iOS Safari, Firefox)
    // Use clientHeight as the stable baseline — it represents the layout viewport
    // and doesn't change with keyboard or nav bar on iOS.
    const KEYBOARD_THRESHOLD = 100;

    const handleResize = () => {
      const vv = window.visualViewport!;
      const baseline = document.documentElement.clientHeight;
      const diff = Math.max(0, baseline - vv.height);
      const isOpen = diff > KEYBOARD_THRESHOLD;
      setVkOpen(isOpen);
      setKeyboardHeight(isOpen ? diff : 0);
    };

    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', handleResize);
  }
}

// Dynamic toggle for VirtualKeyboard overlaysContent.
// Must be enabled when the terminal textarea is focused (so we get accurate
// boundingRect and control layout manually) and disabled when other inputs
// are focused (so the browser handles viewport resizing normally for forms).
export function enableVirtualKeyboardOverlay(): void {
  if (nav.virtualKeyboard) {
    // Only stamp the stale-event ignore window when actually toggling.
    // Re-stamping when already true would restart the 50ms window needlessly,
    // causing Fix 2 to eat the REAL geometrychange from a keyboard open.
    if (!nav.virtualKeyboard.overlaysContent) {
      overlaysContentChangedAt = Date.now();
    }
    nav.virtualKeyboard.overlaysContent = true;
  }
}

export function disableVirtualKeyboardOverlay(): void {
  if (nav.virtualKeyboard) {
    // Only stamp the stale-event ignore window when actually toggling.
    if (nav.virtualKeyboard.overlaysContent) {
      overlaysContentChangedAt = Date.now();
    }
    nav.virtualKeyboard.overlaysContent = false;
    // Don't manually reset signals — let the geometrychange handler do it.
    // Resetting immediately would cause a layout jump while the keyboard
    // is still animating closed.
  }
}

export function isVirtualKeyboardOpen(): boolean {
  return vkOpen();
}

// Keyboard height compensated for Samsung Internet's viewport growth.
// When the keyboard opens, Samsung hides the bottom nav bar, growing innerHeight
// by ~48px. With address bar at BOTTOM, this growth extends behind the address bar
// (off-screen), so vk.boundingRect.height includes ~48px of non-visible area —
// we subtract viewportGrowth. With address bar at TOP, the growth is on-screen,
// so the full vk.boundingRect.height is visible — no subtraction needed.
// Samsung exposes no API to detect address bar position, so we use a user setting.
// On wide screens (unfolded Fold, tablets >600px), Samsung resizes the layout
// viewport correctly regardless of bar position — no subtraction needed.
export function getKeyboardHeight(): number {
  if (isSamsungBrowser) {
    if (window.innerWidth > 600) return keyboardHeight();
    const barTop = loadSettings().samsungAddressBarTop !== false;
    if (barTop) return keyboardHeight();
  }
  return Math.max(0, keyboardHeight() - viewportGrowth());
}

// Reset stale keyboard state on terminal re-entry.
// Called when the terminal becomes active again (e.g. returning from dashboard).
// Reads the actual VirtualKeyboard API state and clears signals if the keyboard
// isn't open. This guarantees correct state on entry without relying on clean exit.
export function resetKeyboardStateIfStale(): void {
  if (!nav.virtualKeyboard) return;

  const actualHeight = nav.virtualKeyboard.boundingRect.height;
  if (actualHeight <= 0) {
    setVkOpen(false);
    setKeyboardHeight(0);
    setViewportGrowth(0);
  }
}

// Force-reset keyboard state on terminal exit.
// Unlike resetKeyboardStateIfStale (which checks VK API), this unconditionally
// zeros all signals. Used when we KNOW the keyboard context is ending (terminal
// deactivation, navigation away) and don't want to rely on async VK API events.
export function forceResetKeyboardState(): void {
  setVkOpen(false);
  setKeyboardHeight(0);
  setViewportGrowth(0);
}

// Samsung Galaxy Fold screen switch detection.
// When the Fold switches screens (folded/unfolded), innerHeight changes by ~800px
// but baselineInnerHeight stays stale. This listener resets the baseline on
// significant viewport changes when the keyboard is closed.
// Threshold of 200px cleanly separates Fold switches (~800px) from URL bar
// animation (~40-60px). Keyboard open (~300-500px) is blocked by vkOpen() check.
if (typeof window !== 'undefined' && isSamsungBrowser) {
  window.addEventListener('resize', () => {
    const delta = Math.abs(window.innerHeight - baselineInnerHeight);
    if (!vkOpen() && delta > 200) {
      baselineInnerHeight = window.innerHeight;
      setViewportGrowth(0);
    }
  });
}

// Debug overlay interval handle — stored so it can be cleaned up.
let debugIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Clean up the debug overlay interval to prevent memory leaks.
 * Safe to call even when no overlay is active.
 */
export function cleanupDebugOverlay(): void {
  if (debugIntervalId !== null) {
    clearInterval(debugIntervalId);
    debugIntervalId = null;
  }
}

// On-screen debug overlay for viewport/keyboard diagnostics.
// Activated by ?debug=1 URL parameter. Shows live values that update
// on geometrychange, visualViewport resize, and a 500ms fallback interval.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) {
  const overlay = document.createElement('div');
  overlay.id = 'vk-debug-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '99999',
    background: 'rgba(0,0,0,0.85)',
    color: '#0f0',
    fontFamily: 'monospace',
    fontSize: '11px',
    lineHeight: '1.4',
    padding: '6px 10px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    maxWidth: '100vw',
    borderBottomRightRadius: '6px',
  });
  document.body.appendChild(overlay);

  function updateOverlay() {
    const vv = window.visualViewport;
    const vkRect = nav.virtualKeyboard?.boundingRect;
    const vkH = vkRect?.height ?? 'N/A';
    const vvH = vv?.height ?? 'N/A';
    const innerH = window.innerHeight;
    const clientH = document.documentElement.clientHeight;
    const screenH = window.screen.height;
    const overlays = nav.virtualKeyboard?.overlaysContent ?? 'N/A';
    const growth = viewportGrowth();
    const total = getKeyboardHeight();
    const barTop = isSamsungBrowser ? loadSettings().samsungAddressBarTop !== false : false;

    // Attempt to read xterm's viewportY for scroll diagnostics
    let vpY: string = 'N/A';
    let baseY: string = 'N/A';
    let rows: string = 'N/A';
    try {
      const xtermEl = document.querySelector('.xterm');
      const termCore = xtermEl && (xtermEl as any)._core;
      if (termCore) {
        const buf = termCore._bufferService?.buffer;
        if (buf) {
          vpY = String(buf.ydisp);
          baseY = String(buf.ybase);
        }
        rows = String(termCore._bufferService?.rows ?? 'N/A');
      }
    } catch { /* ignore */ }

    overlay.textContent =
      `innerHeight:    ${innerH}\n` +
      `baselineInnerH: ${baselineInnerHeight}\n` +
      `clientHeight:   ${clientH}\n` +
      `screen.height:  ${screenH}\n` +
      `vv.height:      ${typeof vvH === 'number' ? vvH.toFixed(1) : vvH}\n` +
      `vk.boundingH:   ${typeof vkH === 'number' ? vkH.toFixed(1) : vkH}\n` +
      `overlaysContent:${overlays}\n` +
      `vpGrowth:       ${growth}\n` +
      `getKbHeight():  ${total}\n` +
      `vkOpen:         ${vkOpen()}\n` +
      `samsung:        ${isSamsungBrowser}\n` +
      `samsungBarTop:  ${barTop}\n` +
      `strategy:       ${usingVirtualKeyboardAPI ? 'VK API' : 'fallback'}\n` +
      `ydisp:          ${vpY}\n` +
      `ybase:          ${baseY}\n` +
      `rows:           ${rows}`;
  }

  if (nav.virtualKeyboard) {
    nav.virtualKeyboard.addEventListener('geometrychange', updateOverlay);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateOverlay);
    window.visualViewport.addEventListener('scroll', updateOverlay);
  }
  window.addEventListener('resize', updateOverlay);
  debugIntervalId = setInterval(updateOverlay, 500);
  updateOverlay();
}
