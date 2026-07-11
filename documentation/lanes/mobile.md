# Mobile Terminal

Technical reference for the mobile terminal implementation covering keyboard handling, touch input, scroll stability, and terminal rendering.

**Audience:** Developers

---

## Contents

- [MultiView Availability](#multiview-availability)
- [Cursor Visibility](#cursor-visibility)
- [Keyboard Management](#keyboard-management)
- [Touch Input](#touch-input)
- [xterm 6.1 Color-Scheme Report Suppression (git: Fix 21)](#xterm-61-color-scheme-report-suppression-git-fix-21)
- [Scroll Stability](#scroll-stability)
- [WebSocket Recovery](#websocket-recovery)
- [Scroll-Stability Integration Test Plan](#scroll-stability-integration-test-plan)

## MultiView Availability

Mobile phone viewports implement [REQ-TERM-012](../../sdd/spec/terminal.md#req-term-012-multiview-virtual-session-workspace) and [REQ-TERM-013](../../sdd/spec/terminal.md#req-term-013-multiview-selection-flow) as single-session terminal surfaces. `web-ui/src/lib/mobile.ts::getTerminalViewportClass` supplies the shared capacity class, and `web-ui/src/components/SessionDropdown.tsx::SessionDropdown` hides the MultiView control when that capacity is zero, so mobile users cannot enter MultiView selection or open tiled session panes. Existing browser-local MultiView membership is preserved while hidden; returning to tablet or desktop can show and reopen the saved `MultiView #1` if at least two member sessions are still running or initializing.

## Cursor Visibility

The xterm cursor is visible (enabled as of Claude Code 1.0.12+ / Copilot 1.0.12+). Previously, the cursor was hidden via CSS `display: none` on `.xterm-cursor-block`, `.xterm-cursor-outline`, `.xterm-cursor-bar`, and `.xterm-cursor-underline`, and via transparent theme colors.

**Current configuration:**
- `cursorBlink: true`, `cursorStyle: 'bar'`
- Cursor color: `#e4e4f0`, cursor accent: `#1a2332`
- CSS that hid cursor elements has been removed
- `applyCursorVisibility()` no longer hides cursor in alternate buffer mode (only honors DECTCEM hide sequences)

**Rationale:** Newer CLI versions (Copilot 1.0.12+, Claude Code) rely on xterm's native cursor layer instead of rendering their own via ANSI escape sequences. This provides better cursor synchronization and eliminates the need for client-side hiding tricks.

**Historical note:** Previous versions hid the xterm cursor on mobile to avoid "orange square" duplication. The iframe compositor jail remains for the Android IME native caret problem.

## Keyboard Management

### VirtualKeyboard API

The `overlaysContent` flag must be managed carefully throughout the terminal lifecycle:

- **Enable** when the terminal textarea is focused (`enableVirtualKeyboardOverlay`)
- **Disable** on terminal exit (`disableVirtualKeyboardOverlay`) so other inputs get normal browser resizing — but NOT on a pane-to-pane focus handoff (see [Multi-pane focus handoff](#multi-pane-focus-handoff))
- `overlaysContent` must be enabled BEFORE focus to beat the keyboard/layout race

### Multi-pane focus handoff

The virtual-keyboard signals (`vkOpen`, `keyboardHeight`) and `overlaysContent` are a single shared resource for the whole window, owned by the focused terminal pane. When several terminal panes are visible (tiling layouts, tablet MultiView) and focus moves between panes while the keyboard is open, the keyboard must stay open and the newly focused pane keeps keyboard mode rather than dropping to keyboard-closed/freescroll.

`web-ui/src/lib/mobile.ts::isFocusOnTerminalInput` is the single discriminator: it reports whether `document.activeElement` is a terminal input iframe (class `terminal-input-iframe`). The three per-pane focus-loss teardown sites gate on it so a handoff does not tear the shared keyboard down:

- `useTerminal.ts` keyboard-lifecycle `onCleanup` — skips `iframeInput.blur()`, `disableVirtualKeyboardOverlay()`, and `forceResetKeyboardState()` when focus is still on a terminal input.
- `terminal-mobile-input.ts` per-input blur debounce — skips `disableVirtualKeyboardOverlay()` on handoff.
- `useTerminal.ts` Samsung `focusout` — defers one tick (so the focus transition settles), then skips `forceResetKeyboardState()` on handoff.

A real exit (focus on a non-terminal element, or terminal unmount) is not a handoff, so those sites — and the unconditional iframe-removal cleanup in `setupMobileInput` — still tear the keyboard down. Implements [REQ-MOB-015](../../sdd/spec/mobile.md#req-mob-015-virtual-keyboard-persists-across-terminal-pane-focus-handoff).

### Background prewarm focus safety

Vault browser prewarm runs in a hidden same-origin iframe while the user may already be typing in the terminal. It is intentionally not delayed by terminal focus or an open virtual keyboard. Instead, `injectVaultPrewarmFocusGuard()` makes only the valid-token prewarm shell focus-inert before SilverBullet app scripts run: script `focus()`, `select()`, and `window.focus()` calls are no-ops, focus-in events inside the hidden document are blurred, and `startVaultPrewarm()` restores the previously focused terminal/input element if the outer iframe captures parent focus. Normal user-opened Vault tabs do not carry prewarm parameters and keep regular editor focus behavior. Vault browser prewarm implements [REQ-MOB-014](../../sdd/spec/mobile.md#req-mob-014-mobile-background-surface-focus-isolation) and [REQ-VAULT-020](../../sdd/spec/vault.md#req-vault-020-vault-prewarm-focus-safety).

### Samsung Internet Quirks

Samsung Internet's bottom navigation bar inflates viewport height, causing the VirtualKeyboard API to report incorrect dimensions.

**Solution:** VirtualKeyboard API with `overlaysContent = true` for accurate keyboard dimensions. Samsung-specific compensation via user settings toggle (`samsungAddressBarTop`) since Samsung exposes NO API to detect address bar position (exhaustively tested 6+ approaches -- all return identical values regardless of position).

Samsung Internet on Android has several quirks with the VirtualKeyboard API. The fixes below are minimal, event-driven patches applied on top of the stable `df1dcfc` baseline (no polling, no timers for state verification, no delayed rechecks).

#### Stale `geometrychange` Ignore Window

Samsung fires a cached stale `geometrychange` event immediately when `overlaysContent` is toggled. The stale event carries whatever `boundingRect` was last cached, which can leave the terminal at half height on re-entry (git: Fix 2).

**Solution:** `mobile.ts` tracks `overlaysContentChangedAt = Date.now()` in both `enableVirtualKeyboardOverlay()` and `disableVirtualKeyboardOverlay()`. The `handleGeometryChange` handler ignores events within 50ms of the toggle. Real user-initiated keyboard events arrive well after this window.

**CRITICAL: Guard on actual toggle only.** The timestamp must ONLY be stamped when `overlaysContent` actually changes value (e.g., `false->true`). If `enableVirtualKeyboardOverlay()` is called when `overlaysContent` is already `true` (a no-op), it must NOT restamp `overlaysContentChangedAt`. Restamping on no-ops restarts the 50ms ignore window, which eats the REAL `geometrychange` event that follows the stale one -- leaving `keyboardHeight` at 0 with the keyboard visually open (the "gap" bug).

Root cause of a persistent Samsung bug: on dashboard entry the enable call was a no-op (no stamp); on visibility return it was a real toggle that ate both stale and real events.

#### `baselineInnerHeight` / `viewportGrowth` Compensation

Samsung's bottom navigation bar creates a "locked layout viewport" bug:
- When the keyboard opens, the bottom bar hides, growing `window.innerHeight`
- The CSS layout viewport does NOT update, creating a gap between terminal content and keyboard
- `baselineInnerHeight` captures the pre-keyboard `innerHeight` for comparison
- `viewportGrowth` = `innerHeight - baselineInnerHeight` represents the nav bar space
- `getKeyboardHeight()` subtracts `viewportGrowth` from `boundingRect.height` (only with bottom address bar, narrow screens)

#### `baselineInnerHeight` Immutability

`baselineInnerHeight` captures `window.innerHeight` at module initialization (page load). It must NEVER be updated during keyboard close, force resets, or stale-state checks. The only exception is the Galaxy Fold screen-switch resize handler (delta > 200px) (git: Fix 4, revised).

**Why:** Samsung fires `geometrychange` with `height=0` (keyboard closed) BEFORE the bottom navigation bar returns to the screen. At this point, `window.innerHeight` is still inflated by ~47px (the space the bottom bar occupied). Any code that updates `baselineInnerHeight` during keyboard close grabs this inflated value, which poisons `viewportGrowth` to 0 on all subsequent keyboard opens -- producing a persistent ~47px gap between the terminal and keyboard.

**Fix:** Removed ALL `baselineInnerHeight` updates from keyboard-close, `forceResetKeyboardState()`, and `resetKeyboardStateIfStale()`. Baseline only changes at module initialization and the Galaxy Fold screen-switch resize handler (`delta > 200px`) which handles genuine physical screen changes.

### Samsung Focusout Handler

Samsung doesn't fire `geometrychange` when the back button dismisses the keyboard. Without detection, keyboard state signals stay stale (git: Fix 1).

**Solution:** `useTerminal.ts` registers a `focusout` listener on the terminal input element (only on Samsung). When `focusout` fires it defers one tick for the focus transition to settle, then — only if focus has left the terminal (`isFocusOnTerminalInput()` is false, i.e. not a pane-to-pane handoff) and `isVirtualKeyboardOpen()` is true — calls `forceResetKeyboardState()` to zero all signals. A handoff to a sibling terminal pane keeps the keyboard (see [Multi-pane focus handoff](#multi-pane-focus-handoff)). The listener is cleaned up on terminal deactivation.

### Visibility Return Reset

When the browser is backgrounded and returned to, keyboard state signals (`keyboardHeight`, `vkOpen`, `viewportGrowth`) can be stale because (git: Fix 6):
- `disableVirtualKeyboardOverlay()` fires on blur (backgrounding) but does NOT reset signals
- `geometrychange` events are frozen or fall within the 50ms stale-ignore window
- On Samsung, `forceResetKeyboardState()` zeros signals on `focusout`, but `overlaysContent` stays `false`

**Chrome symptom:** Ghost padding at bottom -- `keyboardHeight()` stuck non-zero with keyboard closed.
**Samsung symptom:** No floating buttons + scrollable page -- `overlaysContent=false` means `geometrychange` never sets `vkOpen=true` when keyboard reopens.

**Why `forceResetKeyboardState()` instead of `resetKeyboardStateIfStale()`:** `boundingRect.height` returns stale cached values when the browser resumes -- the `visibilitychange` event fires before the compositor updates layout metrics. A conditional check (is keyboard closed?) always passes because the stale cache says height=0, but the signals may already be wrong in other ways. Unconditional zeroing is the only reliable approach.

**Solution (Chrome):** Two complementary fixes:
1. `terminal-mobile-input.ts` `restoreFocusIfNeeded()` calls `forceResetKeyboardState()` + `enableVirtualKeyboardOverlay()` BEFORE refocusing the input. This ensures signals are zeroed and `overlaysContent` is `true` when the keyboard opens.
2. `Layout.tsx` visibility handler calls `forceResetKeyboardState()` as fallback for when focus restore doesn't fire (input was not focused when backgrounded, or readOnly guard is active). Then delays `enableVirtualKeyboardOverlay()` by 300ms so Samsung's stale events settle before the toggle.

**Solution (Samsung -- Dashboard Bounce):** Samsung's VirtualKeyboard compositor state is fundamentally unreliable on browser resume. No combination of signal resets, delayed toggles, or stale-event windows reliably fixes it. The only path that consistently works is deactivating and reactivating the session -- this triggers the full Terminal keyboard lifecycle cleanup (onCleanup effects, `disableVirtualKeyboardOverlay`) and re-initialization (onMount effects, `enableVirtualKeyboardOverlay`).

`Layout.tsx` visibility handler detects Samsung via `isSamsungBrowser` and performs an automatic "dashboard bounce":
1. `forceResetKeyboardState()` -- zero all signals immediately
2. `sessionStore.setActiveSession(null)` + `setViewState('dashboard')` -- deactivate session (triggers Terminal cleanup)
3. After 50ms: `sessionStore.setActiveSession(sessionId)` + `setViewState('terminal')` -- reactivate (triggers Terminal re-init)
4. `reconnectOnVisibilityReturn()` -- reconnect any dropped WebSockets

The 50ms delay gives SolidJS time to process the null state and run cleanup effects before re-initialization begins. The user doesn't see the dashboard (50ms is below perception threshold).

**Samsung-specific input resume:** `terminal-mobile-input.ts` `restoreFocusIfNeeded()` does NOT auto-focus on Samsung (which would open the keyboard and trigger stale `geometrychange` events). Instead, it delays `enableVirtualKeyboardOverlay()` by 300ms so the compositor settles, then leaves the keyboard closed for the user to tap when ready. The 300ms delay ensures Samsung's delayed stale `geometrychange` events (which can arrive up to ~200ms after toggle) are caught by the 50ms ignore window from the delayed toggle.


### FitAddon Management

Three code paths can trigger `fitAddon.fit()` (git: Fix 3):
1. **Keyboard refit** (debounced 150ms)
2. **Active-state effect** (immediate `requestAnimationFrame`)
3. **ResizeObserver** (immediate `requestAnimationFrame`)

A `kbDebounceTimer` variable (timer ID, not boolean) gates the ResizeObserver. When the keyboard refit starts its debounce timer, `kbDebounceTimer` is set to the timer ID. The ResizeObserver checks `kbDebounceTimer !== null` and skips `fit()` when active. The timer callback sets it back to `null`. Using the timer ID (vs. a boolean flag) prevents a race condition where cleanup of the debounce timer doesn't properly clear the gate.

**Scroll preservation after `fit()`:** Every `fit()` call site must preserve or restore scroll position, because `fit()` recalculates terminal dimensions and can reset the viewport to the top. The rules are:

- **Mobile with keyboard open:** Always call `scrollToBottom()` after `fit()`. The user expects to see the prompt whenever the keyboard is open.
- **Desktop / mobile without keyboard:** Check `isAtBottom()` *before* `fit()`. If the user was following output (viewport at bottom), call `scrollToBottom()` after `fit()`. If the user had scrolled up into scrollback, preserve their position.
- **Zero-height guard:** All `fit()` call sites check `containerEl.clientHeight === 0` and bail early.
    - Inactive terminals have `height: 0` via CSS; calling `fit()` on a zero-height container calculates `rows = 0`, which clamps `viewportY` and corrupts scroll state when the terminal re-expands.

This applies to all three `fit()` paths above, plus the init-overlay refit and keyboard lifecycle refit.

## Touch Input

### Swipe Gestures

Horizontal swipe gestures (left/right arrow key simulation) use a `setInterval` repeat timer that fires every 80ms while the finger is held. `touchstart`/`touchmove` were registered in capture phase, but `touchend`/`touchcancel` were in bubble phase. When xterm.js's internal Gesture handler (on `.xterm-screen`) called `stopPropagation()` on `touchend` during its own gesture processing, the bubble-phase listener on the container never fired, leaving the repeat timer running indefinitely (git: Fix 7).

**Solution:** Register `touchend`/`touchcancel` in capture phase (`{ capture: true }`) matching `touchstart`/`touchmove`. Our handler now fires before xterm's, guaranteeing the repeat timer is always cleared.

**xterm 6.1 Gesture shield (git: Fix 20).** xterm 6.1 (`6.1.0-beta.288`) vendored VS Code's touch-scroll rewrite (upstream PR #5377, absent from 6.0.0), which registers a document-level `Gesture` singleton via `MouseService` → `Gesture.addTarget(.xterm-screen)` and calls `preventDefault()` on any `touchstart`/`touchend` starting inside the terminal. Per the Touch Events spec that cancels the browser's synthesized `click` — codeflare's ONLY mobile-keyboard-open trigger (`Terminal.tsx` `on:click`) — so upgrading past 6.0.0 silently broke tap-to-open-keyboard on mobile (the keyboard never appeared; scrolling still worked).

Fix: a bubble-phase `stopPropagation` "Gesture shield" for `touchstart`/`touchmove`/`touchend` on the terminal container in `attachSwipeGestures()` (`web-ui/src/lib/touch-gestures.ts`) — codeflare's own capture-phase handlers still run first, `stopPropagation()` (never `preventDefault`) does not affect browser click synthesis, and xterm's document-level Gesture singleton never sees a terminal-container touch. Removed on terminal cleanup. Covered by `touch-gestures.test.ts` (shield blocks container-origin touches from reaching document-level listeners; outside-container touches unaffected; cleanup removes the shield). Kept on top of the beta pin rather than reverting it — pinning an intermediate build is impossible (both breaking commits are ancestors of #5770's branch, the Pi-flicker mitigation this repo needs; see [Pi Terminal Flicker](troubleshooting.md#pi-terminal-flicker-or-scrollback-snaps-to-the-bottom)). ([REQ-MOB-002](../../sdd/spec/mobile.md#req-mob-002-virtual-keyboard-opens-reliably-on-tap) AC6)

**Fullscreen alternate-buffer scroll routing (git: Fix 22).** Claude Code `/tui fullscreen` renders conversation history inside the alternate screen and captures wheel reports, so `terminal.scrollLines()` cannot move that application-owned history. Desktop wheel events already reach Claude; mobile swipes did not because the Gesture shield deliberately keeps xterm's document-level touch handler out. `attachSwipeGestures()` now detects an alternate buffer with wheel-capable mouse tracking and emits one line-mode `WheelEvent` per accumulated touch line on `terminal.element`. xterm retains ownership of mouse-protocol encoding, the route works with the keyboard open or closed, and the shield continues preserving tap-to-open-keyboard. Normal-buffer swipes still use `terminal.scrollLines()`. ([REQ-MOB-005](../../sdd/spec/mobile.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll) AC8)

### Input Architecture

The mobile terminal input system uses several techniques to work around browser/OS limitations:

1. **Iframe compositor jail** -- Separate compositor context for Android IME caret containment
2. **`_syncTextArea` (NOT frozen)**

   xterm repositions its hidden textarea to the cursor on every render. This must remain active so the browser's focus-scroll targets the cursor position at the bottom of the terminal, not `(0,0)`.

   Freezing it was a premature optimization (~30 style recalcs/sec on one hidden element) that caused the scroll-to-top bug (git: Fix 8). On mobile, CSS `!important` overrides `_syncTextArea` positioning for the compositor jail, so additional guards are needed (git: Fix 9).
3. **`createElement` monkey-patch**

   Uses `input[type=password]` instead of textarea, scoped to `terminal.open()`, to suppress autocorrect at OS level. Voice input is handled separately via the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) in `speech-input.ts`, completely decoupled from the keyboard/iframe input system.

   The floating microphone button starts recognition on mobile. On desktop, a small mic icon in the bottom-right corner and `Ctrl+Space` toggle voice input. Final transcribed text is sent directly to `terminal.input()`. For reliability, `continuous=false` and `interimResults=false` make each tap/shortcut one utterance: tap, speak, pause, send text, auto-deactivates.

   Browsers without the API hide the feature. On first use, the browser shows a microphone permission prompt.

   On mobile this appears behind the virtual keyboard. The mic button checks `navigator.permissions.query({name: 'microphone'})`; if state is `'prompt'`, it blurs the iframe input, dismissing the keyboard before `recognition.start()`. The same pattern handles clipboard paste (`clipboard-read` permission). Composition events (`compositionstart`/`compositionend`) buffer swipe typing text until the IME commits.
4. **`isFocused` getter override** -- Live reference via `iframe.contentDocument?.hasFocus()` avoids stale state
5. **VK API toggle** -- `overlaysContent` must be enabled BEFORE focus to beat the keyboard/layout race
6. **Touch scroll routing**

   With the keyboard closed and normal scrollback active, vertical swipes in `touch-gestures.ts` scroll the terminal buffer through `terminal.scrollLines()`. xterm 6.0.0's `SmoothScrollableElement` uses JS-based scrolling rather than native overflow, so the gesture handler accumulates pixel deltas and converts them to lines using the terminal font metrics.

   An alternate-screen application with wheel-capable mouse tracking owns its own history. The same accumulated lines become DOM wheel events on xterm's terminal element, allowing xterm to encode application mouse reports instead of attempting to move nonexistent terminal scrollback.

## xterm 6.1 Color-Scheme Report Suppression (git: Fix 21)

Not touch-related — filed here as a sibling xterm-6.1 regression (backed by `REQ-TERM-019` AC2, fixed in `useTerminal.ts`, not `touch-gestures.ts`).

xterm 6.1's default-on color-scheme reporting (upstream PR #5628) answers `CSI ?996n` and pushes `CSI ?997;1n` on every theme change once a TUI enables DECSET 2031. `applyCursorVisibility()` reassigns `options.theme` on every DECTCEM (cursor show/hide) toggle, so a 2031-enabled TUI (Claude Code, which toggles the cursor constantly and has a known echo gap — anthropics/claude-code#41570) gets flooded with `?997` reports it echoes at the prompt (visible as a literal `^[[?997;1n` and a corrupted status line). Fix: `vtExtensions: { colorSchemeQuery: false }` passed to the `Terminal` constructor in `useTerminal.ts` — a public typed xterm option that gates both the `996` reply and the `2031` push, restoring exact 6.0.0 byte behavior. Covered by `useTerminal.test.ts` (constructor contract: `vtExtensions.colorSchemeQuery === false`). ([REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards) AC2)

## Scroll Stability

### Root Cause

`@xterm/xterm` is pinned to `6.1.0-beta.288`. Its deferred viewport-DOM synchronization fixes Pi's full-scrollback flicker and its full-buffer trim now preserves the visible content for a scrolled-up user. The older xterm 6.0 correction history below remains relevant only to bottom-following and genuine focus-reset protection; post-write distance correction is no longer part of the integration.

xterm 6.0.0 replaced `.xterm-viewport` (native `overflow-y: scroll` with a scroll-area div) with VS Code's `SmoothScrollableElement` (JS-based scrolling via transforms). Despite this, the terminal would jump to the top of scrollback during burst output (git: Fix 8). Root cause was a vicious cycle between two performance hacks:

**`_syncTextArea` freeze + scroll guard vicious cycle:**

1. `_syncTextArea` was frozen (replaced with a no-op) to avoid ~30 style recalcs/sec on xterm's hidden textarea during burst output. This left the textarea stuck at `(0,0)` instead of following the cursor.

2. With the textarea at `(0,0)`, the browser's focus validation engine would force-scroll containers to reveal the focused element, causing a visual snap to the top.

3. A capture-phase "scroll guard" was added to counteract this -- intercepting native scroll events on `.xterm-viewport`, `.xterm-screen`, `.xterm-scrollable-element`, and `.xterm`, forcing `scrollTop/scrollLeft` back to `0`.

4. **The scroll guard was the actual bug.**

     xterm 6.0.0's `SmoothScrollableElement` still uses `.xterm-viewport`'s native `scrollTop` as the synchronization mechanism between the scrollbar and `viewportY`. Forcing `scrollTop = 0` on viewport scroll events told xterm the user scrolled to the absolute top of the buffer, setting `viewportY = 0`.

**Solution:** Remove both hacks. `_syncTextArea` stays active so the textarea follows the cursor -- the browser's focus-scroll then targets the cursor position (bottom of terminal), not `(0,0)`. The scroll guard is no longer needed because the focus-scroll no longer causes a snap to top. The ~30 style recalcs/sec on a single hidden element is negligible compared to the scroll corruption it was preventing.

**Three-layer fix** (git: Fix 9, extended by Fix 10):

1. **CSS: Kill native scroll on viewport** -- `.xterm .xterm-viewport { overflow: hidden !important; }`. Since xterm 6.0.0's viewport div is empty (SmoothScrollableElement handles scrolling), this has no side effects. Originally mobile-only (`@media (pointer: coarse)`); extended to all devices.

2. **Synchronous bottom-following guard** -- `useScrollCorrection()` handles xterm's `onScroll` event before paint. It re-anchors only a terminal that was following output and yields to recent user scroll intent.

3. **Scroll-drop detector**

   `useTerminal` subscribes to xterm's `onScroll` event and monitors for sudden ydisp drops to 0 when ybase is high. If detected, it immediately corrects via `queueMicrotask(() => scrollToBottom())`.

   This catches resets from any source: write path, resize, keyboard, or browser focus-validation.

**Verification (git: Fix 10):** Deep analysis of xterm 6.0.0 source confirmed that `.xterm-viewport` is genuinely empty (`CoreBrowserTerminal.ts` creates a bare `<div>` with no children), no xterm code reads/writes `_viewportElement.scrollTop`, mouse wheel is handled by `SmoothScrollableElement` JS (`scrollableElement.ts`), and the visible scrollbar is the overlay widget (`.xterm-scrollable-element > .scrollbar`). `overflow: hidden` on an empty element has zero functional impact on xterm.

**Additional hardening:**
- All `fitAddon.fit()` call sites are guarded with `containerEl.clientHeight === 0` checks to prevent zero-row dimension calculations during CSS visibility transitions (inactive terminals have `height: 0`).
- All `scrollToBottom()` call sites check `viewportY >= baseY` before scrolling to preserve manual scrollback position.
- `flushWriteBuffer()` batches output only; it does not alter scroll position after a write. xterm 6.1 owns the scrolled-up full-buffer anchor.
- `refitAllTerminals()` skips the resize WS message if dimensions didn't change.

### Distance-Based Detection

Absolute `ydisp === 0` detection false-positived during scrollback trimming: xterm legitimately decrements ydisp as old lines are removed (399->398->...->1->0). The detector therefore compares adjacent **distance from bottom** values (`baseY - ydisp`) and only treats a direct jump from a deep viewport to zero as suspicious. During a browser focus reset, ydisp snaps to 0 while baseY stays large, causing distance to jump dramatically (git: Fix 15, supersedes Fix 14).

**Detection predicates:** A browser reset is detected when ALL of the following hold:
- `previousYdisp > 20`
- `ybase > 20`
- `distanceDrift > 20` (impossible during normal trimming which changes distance by at most 1-2 lines)

**Distance-based restoration:** Restores using `targetY = currentBaseY - savedDistanceFromBottom`, applied as a **delta** (`targetY - currentY`). This is trim-safe because it uses the user's relative position, not absolute coordinates.

### xterm 6.1 Native Full-Buffer Anchoring

When the 1000-line scrollback is full, xterm 6.1 shifts `viewportY` upward as old lines trim so the same visible content remains under a scrolled-up user. Codeflare's older post-write distance guard interpreted a multi-line shift as drift and called `scrollLines` back toward the former distance from bottom. Under Pi's dense 33ms output batches, that correction repeatedly overrode xterm and made scrollback snap toward the live prompt.

`flushWriteBuffer()` now only coalesces and writes output. The obsolete post-write correction and its suppression counter are removed. `useScrollCorrection()` remains responsible for bottom-following re-anchor and true focus resets, and still yields immediately to recent wheel, pointer, or navigation-key intent.

#### Keyboard-Open Suppression

With the keyboard open, normal terminal scrollback is bottom-anchored: output auto-follows and vertical swipes send arrow keys. Fullscreen application scrolling is the deliberate exception: its wheel reports change application-owned history without moving xterm's viewport. Multiple independent xterm scroll mechanisms previously fought during keyboard-open output (git: Fix 16):

1. Keyboard height change effect called `scrollToBottom()` (leading + trailing edge)
2. ResizeObserver called `scrollToBottom()` ~18 times during 300ms keyboard animation
3. Scroll-reset detector could fire on side effects of the above

**Solution:**
1. **Skip scroll-reset detector when keyboard open** -- the detector handles xterm viewport resets; fullscreen wheel reports do not alter that viewport. Early return in `onScroll` when `isVirtualKeyboardOpen()`.
2. **Remove ResizeObserver scrollToBottom when keyboard open** -- the keyboard height change effect already handles fit + scrollToBottom during animation. ResizeObserver adding concurrent scrolls was redundant and caused thrash.

The keyboard height effect remains the source of truth for keyboard-transition refits; the pre-paint scroll-event handler preserves bottom-following output.

### Bottom-Following Re-Anchor

Users at the bottom following output saw constant flashing/jitter during rapid output with scrollback trimming. The post-write callback correction ran AFTER xterm rendered, causing a visible two-frame glitch: frame 1 shows wrong position, frame 2 shows corrected position (git: Fix 19).

**Root cause:** `terminal.write(data, callback)` is async -- the callback fires after xterm processes data AND renders via rAF. The correction arrives too late to prevent the bad frame from being painted.

**Key insight (validated by GPT-5.4 + Gemini 3.1 Pro):** xterm's `onScroll` event fires synchronously during the parse loop, BEFORE the rAF render pass. Correcting viewport position in the `onScroll` handler means the fix is applied before the canvas paints -- the bad frame is never visible.

**Solution:**

1. **Bottom-following correction moved to `onScroll` handler** (`useTerminal.ts`) -- when `wasFollowingOutput` is true and `ydisp < ybase`, call `scrollToBottom()` immediately. Uses `isCorrectingScroll` flag to prevent recursion.
    - Checks recent user intent (wheel/pointerdown/keydown) to avoid trapping users at the bottom when they intentionally scroll up.

2. **No write-side correction** (`terminal.ts`) -- `flushWriteBuffer` delegates the scrolled-up anchor to xterm 6.1 and never calls `scrollLines` after output.

### Scroll Stability Overhaul Context

Earlier iterations introduced overlapping scroll-correction mechanisms that fought each other (oscillation on mobile with keyboard open). The overhaul (git: Fix 13) simplified to:
- Narrowed reset detection to `ydisp === 0` (browser focus-reset always snaps to 0)
- Removed `drop > 3` heuristic (xterm natively adjusts viewportY during trim)
- Added `isCorrectingScroll` re-entrancy guard
- External scroll intent API (`lib/terminal-scroll-intent.ts`) so floating buttons don't trigger the detector
- Scrollback reduced from 10,000 to 1,000 lines; virtual scroll disabled (`CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1`)

## WebSocket Recovery

### Retryable Close Codes

The WebSocket reconnection logic retries on a set of close codes (`WS_RETRYABLE_CLOSE_CODES`) rather than only on `1006` (Abnormal Closure). This covers server shutdown (1001), unexpected conditions (1011), service restart (1012), and try-again-later (1013). Normal closure (1000) does NOT trigger retry. Custom close code **4503** (`WS_CONTAINER_STOPPED_CODE`) is sent by the Container DO and terminal route when the container is not running -- the client treats this as authoritative and stops retrying immediately. Network errors (1006) retry indefinitely; KV polling handles session status (git: Fix 5).

---

## Scroll-Stability Integration Test Plan

[REQ-MOB-004](../../sdd/spec/mobile.md#req-mob-004-scroll-drop-detection-during-burst-output) (scroll-drop detection during burst output) and [REQ-MOB-012](../../sdd/spec/mobile.md#req-mob-012-scroll-anchoring-during-keyboard-transitions) (scroll anchoring during keyboard transitions) describe xterm.js scroll behaviour wired through module-internal helpers in `web-ui/src/stores/terminal.ts` and `web-ui/src/hooks/useTerminal.ts`. The right verification surface is a Playwright E2E suite running under `E2E_MOBILE=1` in the `e2e-ui-mobile` workflow job (extension to `e2e/ui/mobile-specific.test.ts`).

### REQ-MOB-004 test scenarios

1. **Burst output retains bottom anchor.** Start a session, open a terminal tab, send `for i in {1..2000}; do echo "line $i"; done` via the WS, wait for output to settle.
    - Assert `page.evaluate(() => terminal.buffer.active.viewportY >= terminal.buffer.active.baseY)` returns true (no scroll drop).
2. **Focus loss/regain does not reset viewport.** Defocus the terminal, refocus via `page.evaluate(() => document.body.click())`, assert viewport remains at bottom (no `ydisp` drop to 0).
3. **Viewport overflow style.** Inspect computed style of `.xterm .xterm-viewport`, assert `overflow: hidden` is present (xterm 6.0.0 `SmoothScrollableElement` invariant).

### REQ-MOB-012 test scenarios

1. **Keyboard-open burst pins to bottom.** Tap terminal to open the virtual keyboard, send a burst, assert viewport remains pinned to bottom with no flicker (scroll-reset detector is silent because the keyboard-open branch is taken).
2. **Scrolled-up users keep visible content during output.** Fill the 1000-line scrollback, scroll up by ~100 lines, continue streaming output, and assert the same surviving content remains visible instead of snapping toward the bottom.
3. **Keyboard transition does not override manual scrollback.** With the keyboard closed, scroll up during active output and assert no post-write programmatic scroll runs.

The Verification fields in [`sdd/spec/mobile.md`](../../sdd/spec/mobile.md) point at this plan; CQ-1 truth check resolves on test file annotation once the Playwright suite is written.

---

## Specification Coverage

- [REQ-MOB-001](../../sdd/spec/mobile.md#req-mob-001-terminal-fully-usable-on-mobile-devices) - Terminal fully usable on mobile devices
- [REQ-MOB-002](../../sdd/spec/mobile.md#req-mob-002-virtual-keyboard-opens-reliably-on-tap) - Virtual keyboard opens reliably on tap
- [REQ-MOB-003](../../sdd/spec/mobile.md#req-mob-003-samsung-internet-keyboard-viewport-state) - Samsung Internet keyboard viewport state
- [REQ-MOB-005](../../sdd/spec/mobile.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll) - Swipe gestures send arrow keys or scroll
- [REQ-MOB-006](../../sdd/spec/mobile.md#req-mob-006-sticky-ctrl-button-for-mobile) - Sticky Ctrl button for mobile
- [REQ-MOB-007](../../sdd/spec/mobile.md#req-mob-007-voice-input-via-web-speech-api) - Voice input via Web Speech API
- [REQ-MOB-008](../../sdd/spec/mobile.md#req-mob-008-cursor-visible-for-all-supported-agents) - Cursor visible for all supported agents
- [REQ-MOB-009](../../sdd/spec/mobile.md#req-mob-009-visibility-return-recovers-keyboard-state) - Visibility return recovers keyboard state
- [REQ-MOB-010](../../sdd/spec/mobile.md#req-mob-010-fitaddon-fit-calls-are-coordinated) - FitAddon fit calls are coordinated
- [REQ-MOB-011](../../sdd/spec/mobile.md#req-mob-011-samsung-internet-keyboard-state-recovery) - Samsung Internet keyboard state recovery
- [REQ-MOB-013](../../sdd/spec/mobile.md#req-mob-013-mobile-input-system-platform-compatibility) - Mobile input-system platform compatibility
- [REQ-MOB-014](../../sdd/spec/mobile.md#req-mob-014-mobile-background-surface-focus-isolation) - Mobile background-surface focus isolation

---

## Related Documentation
- [Architecture](architecture.md#frontend-solidjs-xtermjs) - Frontend architecture
- [Architecture](architecture.md#terminal-server-node-pty) - Terminal server
- [Container](container.md#container-startup) - Container startup
- [Troubleshooting](troubleshooting.md) - Common failure modes
