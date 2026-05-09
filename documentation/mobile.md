# Mobile Terminal

Technical reference for the mobile terminal implementation covering keyboard handling, touch input, scroll stability, and terminal rendering.

**Audience:** Developers

---

## Cursor Visibility

The xterm cursor is visible (enabled as of Claude Code 1.0.12+ / Copilot 1.0.12+). Previously, the cursor was hidden via CSS `display: none` on `.xterm-cursor-block`, `.xterm-cursor-outline`, `.xterm-cursor-bar`, and `.xterm-cursor-underline`, and via transparent theme colors.

**Current configuration:**
- `cursorBlink: true`, `cursorStyle: 'bar'`
- Cursor color: `#e4e4f0`, cursor accent: `#1a2332`
- CSS that hid cursor elements has been removed
- `applyCursorVisibility()` no longer hides cursor in alternate buffer mode (only honors DECTCEM hide sequences)

**Rationale:** Newer CLI versions (Copilot 1.0.12+, Claude Code) rely on xterm's native cursor layer instead of rendering their own via ANSI escape sequences. This provides better cursor synchronization and eliminates the need for client-side hiding tricks.

**Historical note:** On mobile, previous versions disabled xterm's cursor to avoid "orange square" duplication where both the DOM cursor and CLI's ANSI cursor were visible. The iframe compositor jail code remains as a precaution for the genuine Android IME native caret problem (separate from xterm's DOM cursor).

## Keyboard Management

### VirtualKeyboard API

The `overlaysContent` flag must be managed carefully throughout the terminal lifecycle:

- **Enable** when the terminal textarea is focused (`enableVirtualKeyboardOverlay`)
- **Disable** on terminal exit (`disableVirtualKeyboardOverlay`) so other inputs get normal browser resizing
- `overlaysContent` must be enabled BEFORE focus to beat the keyboard/layout race

### Samsung Internet Quirks

Samsung Internet's bottom navigation bar inflates viewport height, causing the VirtualKeyboard API to report incorrect dimensions.

**Solution:** VirtualKeyboard API with `overlaysContent = true` for accurate keyboard dimensions. Samsung-specific compensation via user settings toggle (`samsungAddressBarTop`) since Samsung exposes NO API to detect address bar position (exhaustively tested 6+ approaches -- all return identical values regardless of position).

Samsung Internet on Android has several quirks with the VirtualKeyboard API. The fixes below are minimal, event-driven patches applied on top of the stable `df1dcfc` baseline (no polling, no timers for state verification, no delayed rechecks).

#### Stale `geometrychange` Ignore Window

Samsung fires a cached stale `geometrychange` event immediately when `overlaysContent` is toggled. The stale event carries whatever `boundingRect` was last cached, which can leave the terminal at half height on re-entry (git: Fix 2).

**Solution:** `mobile.ts` tracks `overlaysContentChangedAt = Date.now()` in both `enableVirtualKeyboardOverlay()` and `disableVirtualKeyboardOverlay()`. The `handleGeometryChange` handler ignores events within 50ms of the toggle. Real user-initiated keyboard events arrive well after this window.

**CRITICAL: Guard on actual toggle only.** The timestamp must ONLY be stamped when `overlaysContent` actually changes value (e.g., `false->true`). If `enableVirtualKeyboardOverlay()` is called when `overlaysContent` is already `true` (a no-op), it must NOT restamp `overlaysContentChangedAt`. Restamping on no-ops restarts the 50ms ignore window, which eats the REAL `geometrychange` event that follows the stale one -- leaving `keyboardHeight` at 0 with the keyboard visually open (the "gap" bug).

This was the root cause of a persistent Samsung bug where the dashboard->terminal path worked but visibility return didn't: on dashboard entry, the keyboard lifecycle effect sets `overlaysContent=true` well before the user taps, so `enableVirtualKeyboardOverlay()` is a no-op (no stamp, no window). On visibility return, `overlaysContent` was `false` (from blur), so the enable call was a real toggle -- stamping the window and eating both stale and real events.

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

**Diagnosed via debug overlay:**
```
First keyboard open (correct):   baselineInnerH=1009, vpGrowth=47, getKbHeight=436
Second keyboard open (broken):   baselineInnerH=1105, vpGrowth=0,  getKbHeight=483
```
The 47px gap (483 - 436) is exactly the missing `viewportGrowth` compensation.

**Final solution:** Removed ALL `baselineInnerHeight` updates from:
- `handleGeometryChange` keyboard-close branch (was the primary corruption source)
- `forceResetKeyboardState()` (called on visibility return, terminal exit)
- `resetKeyboardStateIfStale()` (called on terminal re-entry)

Baseline now only changes at:
1. Module initialization: `let baselineInnerHeight = window.innerHeight`
2. Galaxy Fold screen-switch resize handler: `if (!vkOpen() && delta > 200)` -- this handles genuine physical screen changes (folded <-> unfolded, ~800px delta) that cannot be confused with keyboard/bar transitions

### Samsung Focusout Handler

Samsung doesn't fire `geometrychange` when the back button dismisses the keyboard. Without detection, keyboard state signals stay stale (git: Fix 1).

**Solution:** `useTerminal.ts` registers a `focusout` listener on the terminal input element (only on Samsung). When `focusout` fires while `isVirtualKeyboardOpen()` is true, it calls `forceResetKeyboardState()` to zero all signals. The listener is cleaned up on terminal deactivation.

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

**Historical context:** These bugs were masked before infinite WS retries and `hasConnected` latch because the old retry limit (10 attempts -> error state) would show an error overlay, forcing the user to navigate away and back -- which triggered full keyboard cleanup.

### FitAddon Management

Three code paths can trigger `fitAddon.fit()` (git: Fix 3):
1. **Keyboard refit** (debounced 150ms)
2. **Active-state effect** (immediate `requestAnimationFrame`)
3. **ResizeObserver** (immediate `requestAnimationFrame`)

A `kbDebounceTimer` variable (timer ID, not boolean) gates the ResizeObserver. When the keyboard refit starts its debounce timer, `kbDebounceTimer` is set to the timer ID. The ResizeObserver checks `kbDebounceTimer !== null` and skips `fit()` when active. The timer callback sets it back to `null`. Using the timer ID (vs. a boolean flag) prevents a race condition where cleanup of the debounce timer doesn't properly clear the gate.

**Scroll preservation after `fit()`:** Every `fit()` call site must preserve or restore scroll position, because `fit()` recalculates terminal dimensions and can reset the viewport to the top. The rules are:

- **Mobile with keyboard open:** Always call `scrollToBottom()` after `fit()`. The user expects to see the prompt whenever the keyboard is open.
- **Desktop / mobile without keyboard:** Check `isAtBottom()` *before* `fit()`. If the user was following output (viewport at bottom), call `scrollToBottom()` after `fit()`. If the user had scrolled up into scrollback, preserve their position.
- **Zero-height guard:** All `fit()` call sites check `containerEl.clientHeight === 0` and bail early. Inactive terminals have `height: 0` via CSS; calling `fit()` on a zero-height container calculates `rows = 0`, which clamps `viewportY` and corrupts scroll state when the terminal re-expands.

This applies to all three `fit()` paths above, plus the init-overlay refit and keyboard lifecycle refit.

## Touch Input

### Swipe Gestures

Horizontal swipe gestures (left/right arrow key simulation) use a `setInterval` repeat timer that fires every 80ms while the finger is held. `touchstart`/`touchmove` were registered in capture phase, but `touchend`/`touchcancel` were in bubble phase. When xterm.js's internal Gesture handler (on `.xterm-screen`) called `stopPropagation()` on `touchend` during its own gesture processing, the bubble-phase listener on the container never fired, leaving the repeat timer running indefinitely (git: Fix 7).

**Solution:** Register `touchend`/`touchcancel` in capture phase (`{ capture: true }`) matching `touchstart`/`touchmove`. Our handler now fires before xterm's, guaranteeing the repeat timer is always cleared.

### Input Architecture

The mobile terminal input system uses several techniques to work around browser/OS limitations:

1. **Iframe compositor jail** -- Separate compositor context for Android IME caret containment
2. **`_syncTextArea` (NOT frozen)** -- xterm repositions its hidden textarea to the cursor on every render. This must remain active so the browser's focus-scroll targets the cursor position (bottom of terminal) rather than `(0,0)`. Freezing it was a premature optimization (~30 style recalcs/sec on a single hidden element) that caused the scroll-to-top bug (git: Fix 8). Note: on mobile, CSS `!important` overrides `_syncTextArea`'s positioning (textarea stays at 0,0 for the compositor jail), so additional guards are needed (git: Fix 9).
3. **`createElement` monkey-patch** -- Uses `input[type=password]` instead of textarea (scoped to `terminal.open()`) to suppress autocorrect at OS level. Voice input is handled separately via the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) in `speech-input.ts` -- completely decoupled from the keyboard/iframe input system. On mobile, the floating microphone button starts recognition. On desktop, a small mic icon in the bottom-right corner and `Ctrl+Space` keyboard shortcut toggle voice input. Final transcribed text is sent directly to `terminal.input()`. `continuous=false` and `interimResults=false` for reliability -- each tap/shortcut is one utterance (tap, speak, pause, text sent, auto-deactivates). Hidden on browsers that don't support the API. **Permission prompt handling:** On first use, the browser shows a microphone permission prompt. On mobile this appears behind the virtual keyboard. The mic button checks `navigator.permissions.query({name: 'microphone'})` -- if state is `'prompt'`, it blurs the iframe input (dismissing the keyboard) before calling `recognition.start()` so the user sees the prompt. Same pattern for clipboard paste (`clipboard-read` permission). Composition events (`compositionstart`/`compositionend`) buffer swipe typing text until the IME commits.
4. **`isFocused` getter override** -- Live reference via `iframe.contentDocument?.hasFocus()` avoids stale state
5. **VK API toggle** -- `overlaysContent` must be enabled BEFORE focus to beat the keyboard/layout race
6. **Touch scroll via `terminal.scrollLines()`** -- When keyboard is closed, vertical swipes in `touch-gestures.ts` scroll the terminal buffer directly via `terminal.scrollLines()`. xterm 6.0.0's `SmoothScrollableElement` uses JS-based scrolling that doesn't support native touch; `.xterm-viewport` no longer has scrollable content. The gesture handler accumulates pixel deltas and converts to line-granularity scroll, with sensitivity derived from terminal font metrics (`fontSize * lineHeight`)

## Scroll Stability

### Root Cause

xterm 6.0.0 replaced `.xterm-viewport` (native `overflow-y: scroll` with a scroll-area div) with VS Code's `SmoothScrollableElement` (JS-based scrolling via transforms). Despite this, the terminal would jump to the top of scrollback during burst output (git: Fix 8). Root cause was a vicious cycle between two performance hacks:

**`_syncTextArea` freeze + scroll guard vicious cycle:**

1. `_syncTextArea` was frozen (replaced with a no-op) to avoid ~30 style recalcs/sec on xterm's hidden textarea during burst output. This left the textarea stuck at `(0,0)` instead of following the cursor.

2. With the textarea at `(0,0)`, the browser's focus validation engine would force-scroll containers to reveal the focused element, causing a visual snap to the top.

3. A capture-phase "scroll guard" was added to counteract this -- intercepting native scroll events on `.xterm-viewport`, `.xterm-screen`, `.xterm-scrollable-element`, and `.xterm`, forcing `scrollTop/scrollLeft` back to `0`.

4. **The scroll guard was the actual bug.** xterm 6.0.0's `SmoothScrollableElement` still uses `.xterm-viewport`'s native `scrollTop` as the synchronization mechanism between the scrollbar and `viewportY`. Forcing `scrollTop = 0` on viewport scroll events told xterm the user scrolled to the absolute top of the buffer, setting `viewportY = 0`.

**Solution:** Remove both hacks. `_syncTextArea` stays active so the textarea follows the cursor -- the browser's focus-scroll then targets the cursor position (bottom of terminal), not `(0,0)`. The scroll guard is no longer needed because the focus-scroll no longer causes a snap to top. The ~30 style recalcs/sec on a single hidden element is negligible compared to the scroll corruption it was preventing.

**Three-layer fix** (git: Fix 9, extended by Fix 10):

1. **CSS: Kill native scroll on viewport** -- `.xterm .xterm-viewport { overflow: hidden !important; }`. Since xterm 6.0.0's viewport div is empty (SmoothScrollableElement handles scrolling), this has no side effects. Originally mobile-only (`@media (pointer: coarse)`); extended to all devices.

2. **Synchronous post-write scroll guard** -- `flushWriteBuffer()` checks `viewportY < baseY` both synchronously (inside the write callback) AND in `requestAnimationFrame`. The synchronous check catches resets that happen during the write/render cycle, before the browser paints the wrong frame.

3. **Scroll-drop detector** -- `useTerminal` subscribes to xterm's `onScroll` event and monitors for sudden ydisp drops to 0 when ybase is high. If detected, immediately corrects via `queueMicrotask(() => scrollToBottom())`. This catches resets from ANY source (write path, resize, keyboard, browser focus-validation) regardless of the triggering mechanism.

**Verification (git: Fix 10):** Deep analysis of xterm 6.0.0 source confirmed that `.xterm-viewport` is genuinely empty (`CoreBrowserTerminal.ts:426-428` creates a bare `<div>` with no children), no xterm code reads/writes `_viewportElement.scrollTop`, mouse wheel is handled by `SmoothScrollableElement` JS (`scrollableElement.ts:370-389`), and the visible scrollbar is the overlay widget (`.xterm-scrollable-element > .scrollbar`). `overflow: hidden` on an empty element has zero functional impact on xterm.

**Additional hardening:**
- All `fitAddon.fit()` call sites are guarded with `containerEl.clientHeight === 0` checks to prevent zero-row dimension calculations during CSS visibility transitions (inactive terminals have `height: 0`).
- All `scrollToBottom()` call sites check `viewportY >= baseY` before scrolling to preserve manual scrollback position.
- The post-write scroll snap in `flushWriteBuffer()` is deferred to the next animation frame via `requestAnimationFrame`, allowing xterm's `RenderService` and `SmoothScrollableElement` to complete their internal layout pass before checking `viewportY`.
- `refitAllTerminals()` skips the resize WS message if dimensions didn't change.

### Distance-Based Detection

Absolute `ydisp === 0` detection false-positived during scrollback trimming: xterm legitimately decrements ydisp as old lines are removed (399->398->...->1->0). The correct invariant is **distance from bottom** (`baseY - ydisp`), not absolute `ydisp`. During normal trimming, distance stays constant (both baseY and ydisp shift together). During a browser focus reset, ydisp snaps to 0 while baseY stays large, causing distance to jump dramatically (git: Fix 15, supersedes Fix 14).

**Detection predicates:** A browser reset is detected when ALL of the following hold:
- `previousYdisp > 20`
- `ybase > 20`
- `distanceDrift > 20` (impossible during normal trimming which changes distance by at most 1-2 lines)

**Distance-based restoration:** Restores using `targetY = currentBaseY - savedDistanceFromBottom`, applied as a **delta** (`targetY - currentY`). This is trim-safe because it uses the user's relative position, not absolute coordinates.

### Programmatic Scroll Suppression

During rapid output with scrollback trimming at 400 lines, the terminal oscillated -- jumping up, snapping down, producing visual artifacts. Root cause: `scrollToBottom()` and `scrollLines()` called by the post-write guard in `flushWriteBuffer()` fire synchronous `onScroll` events that the scroll-reset detector in `useTerminal.ts` misidentifies as browser focus resets (git: Fix 18).

**xterm 6.0.0 internal mechanism:** `Viewport._sync()` calls `setScrollDimensions()` BEFORE `setScrollPosition()`. During the dimension update, `ScrollState` constructor clamps `scrollTop` to `max(0, scrollHeight - height)`. This clamped value can leak as an `onScroll` event with `ydisp = 0`, which matches the detector's `suspiciousReset` predicate.

**Note:** Removing all custom corrections was attempted and REVERTED (git: Fix 17) -- xterm does NOT handle viewport position natively during trim. The post-write guard and onScroll detector ARE needed.

**Solution:**

1. **Suppression counter** (`scrollSuppressionCounts` map in `terminal.ts`) -- tracks when programmatic scroll corrections are in progress. Uses a counter (not boolean) to handle nested/overlapping corrections.

2. **Wrap post-write corrections** -- `beginProgrammaticScroll(key)` before `scrollToBottom()` / `scrollLines()`, `endProgrammaticScroll(key)` via `queueMicrotask()` after. The microtask ensures the suppression covers the entire synchronous `onScroll` cascade.

3. **Check suppression in onScroll detector** -- early return when `isProgrammaticScrollSuppressed()` is true, but still update tracking baselines (`previousYdisp`, `previousDistFromBottom`, `wasFollowingOutput`) so the next unsuppressed event compares against correct state.

This eliminates the feedback loop without weakening either protection mechanism. The onScroll detector remains active for genuine browser focus resets.

#### Keyboard-Open Suppression

With keyboard open, the terminal is in bottom-anchored mode: output auto-follows, touch scrolling is blocked (swipes send arrow keys instead). However, multiple independent scroll mechanisms were fighting each other during output with keyboard open (git: Fix 16):

1. `flushWriteBuffer` callback called `scrollToBottom()` every 33ms
2. Keyboard height change effect called `scrollToBottom()` (leading + trailing edge)
3. ResizeObserver called `scrollToBottom()` ~18 times during 300ms keyboard animation
4. Scroll-reset detector could fire on side effects of the above

**Solution:**
1. **Skip scroll-reset detector when keyboard open** -- the detector is for browser focus-reset bugs which can't happen in keyboard-open mode (touch events are blocked, user can't scroll). Early return in `onScroll` handler when `isVirtualKeyboardOpen()`.
2. **Remove ResizeObserver scrollToBottom when keyboard open** -- the keyboard height change effect already handles fit + scrollToBottom during animation. ResizeObserver adding concurrent scrolls was redundant and caused thrash.

The write callback's `scrollToBottom()` remains the single source of truth for bottom-anchoring during keyboard-open output.

### Bottom-Following Re-Anchor

Users at the bottom following output saw constant flashing/jitter during rapid output with scrollback trimming. The post-write callback correction ran AFTER xterm rendered, causing a visible two-frame glitch: frame 1 shows wrong position, frame 2 shows corrected position (git: Fix 19).

**Root cause:** `terminal.write(data, callback)` is async -- the callback fires after xterm processes data AND renders via rAF. The correction arrives too late to prevent the bad frame from being painted.

**Key insight (validated by GPT-5.4 + Gemini 3.1 Pro):** xterm's `onScroll` event fires synchronously during the parse loop, BEFORE the rAF render pass. Correcting viewport position in the `onScroll` handler means the fix is applied before the canvas paints -- the bad frame is never visible.

**Solution:**

1. **Bottom-following correction moved to `onScroll` handler** (`useTerminal.ts`) -- when `wasFollowingOutput` is true and `ydisp < ybase`, call `scrollToBottom()` immediately. Uses `isCorrectingScroll` flag to prevent recursion. Checks recent user intent (wheel/pointerdown/keydown) to avoid trapping users at the bottom when they intentionally scroll up.

2. **Write callback simplified** (`terminal.ts`) -- bottom-followers skip the callback entirely (handled by `onScroll`). Callback only handles scrolled-up user distance correction, which is less timing-sensitive.

3. **Suppression counter preserved** -- scrolled-up corrections in the write callback still use `beginProgrammaticScroll`/`endProgrammaticScroll` to prevent detector feedback.

### Write-Side Distance Guard

`flushWriteBuffer` tracks `beforeDistFromBottom` and corrects scrolled-up users if trim drifted their position by more than 5 lines. Previously only bottom-following users were corrected (git: Fix 15).

### Scroll Stability Overhaul Context

Earlier iterations (git: Fixes 9-12) introduced three overlapping scroll-correction mechanisms that fought each other during output, causing terminal oscillation (especially on mobile with keyboard open). The overhaul (git: Fix 13) replaced them with a minimal, targeted approach:

1. **Narrowed scroll-reset detection** (`hooks/useTerminal.ts`) -- changed from `ydisp < ybase` to `ydisp === 0`. The browser focus-reset bug always snaps to position 0 (scroll origin).

2. **Removed `drop > 3` heuristic** -- xterm.js natively adjusts viewportY when trimming scrollback lines to maintain visual stability. The heuristic was counterproductive.

3. **Simplified post-write guard** (`stores/terminal.ts`) -- kept only `wasAtBottom -> scrollToBottom` sync check. Removed `drop > 3` and rAF duplicate that fought with the onScroll detector.

4. **Added re-entrancy guard** -- `isCorrectingScroll` boolean prevents `scrollToBottom()` inside corrections from re-triggering the detector via synchronous `onScroll`.

5. **External scroll intent API** (`lib/terminal-scroll-intent.ts`) -- keyed by session:terminal. Floating buttons call `markScrollIntent()` before `scrollPages()`/`scrollToBottom()` so the detector recognizes out-of-tree UI actions.

6. **Reduced grace window** from 250ms to 150ms for tighter intent tracking.

7. **Reduced scrollback** from 10,000 to 1,000 lines (both frontend and headless). Virtual scroll is disabled (`CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1`), so xterm's scrollback buffer is the only history cap.

## WebSocket Recovery

### Retryable Close Codes

The WebSocket reconnection logic retries on a set of close codes (`WS_RETRYABLE_CLOSE_CODES`) rather than only on `1006` (Abnormal Closure). This covers server shutdown (1001), unexpected conditions (1011), service restart (1012), and try-again-later (1013). Normal closure (1000) does NOT trigger retry. Custom close code **4503** (`WS_CONTAINER_STOPPED_CODE`) is sent by the Container DO and terminal route when the container is not running -- the client treats this as authoritative and stops retrying immediately. Network errors (1006) retry indefinitely; KV polling handles session status (git: Fix 5).

---

## Related Documentation
- [Architecture](architecture.md#frontend-solidjs--xtermjs) - Frontend architecture
- [Architecture](architecture.md#terminal-server-node-pty) - Terminal server
- [Container](container.md#container-startup) - Container startup
- [Troubleshooting](troubleshooting.md) - Common failure modes
