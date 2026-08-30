# Mobile Terminal

Technical reference for the mobile terminal implementation covering keyboard handling, touch input, scroll stability, and terminal rendering.

**Audience:** Developers

**Owns:** mobile keyboard, touch, viewport, fit, scroll-ownership adaptations, platform limits, and deployed-device verification. **Does not own:** generic terminal protocol, WebSocket contracts, or landing-canvas implementation.

---

## Contents

- [Interaction and Focus Model](#interaction-and-focus-model)
- [Terminal Compatibility](#terminal-compatibility)
- [Scroll Stability](#scroll-stability)
- [Transport Recovery](#transport-recovery)
- [Behavioral Test Matrix](#behavioral-test-matrix)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Interaction and Focus Model

<a id="multiview-availability"></a>
### MultiView Availability

Mobile phone viewports implement [REQ-TERM-012](../../sdd/spec/terminal.md#req-term-012-multiview-virtual-session-workspace) and [REQ-TERM-013](../../sdd/spec/terminal.md#req-term-013-multiview-selection-flow) as single-session terminal surfaces. `web-ui/src/lib/mobile.ts::getTerminalViewportClass` supplies the shared capacity class, and `web-ui/src/components/SessionDropdown.tsx::SessionDropdown` hides the MultiView control when that capacity is zero, so mobile users cannot enter MultiView selection or open tiled session panes. Existing browser-local MultiView membership is preserved while hidden; returning to tablet or desktop can show and reopen the saved `MultiView #1` if at least two member sessions are still running or initializing.

### Cursor Visibility

The xterm cursor is visible (enabled as of Claude Code 1.0.12+ / Copilot 1.0.12+). Previously, the cursor was hidden via CSS `display: none` on `.xterm-cursor-block`, `.xterm-cursor-outline`, `.xterm-cursor-bar`, and `.xterm-cursor-underline`, and via transparent theme colors.

**Current configuration:**
- `cursorBlink: true`, `cursorStyle: 'bar'`
- Cursor color: `#e4e4f0`, cursor accent: `#1a2332`
- CSS that hid cursor elements has been removed
- `applyCursorVisibility()` no longer hides cursor in alternate buffer mode (only honors DECTCEM hide sequences)

**Rationale:** Newer CLI versions (Copilot 1.0.12+, Claude Code) rely on xterm's native cursor layer instead of rendering their own via ANSI escape sequences. This provides better cursor synchronization and eliminates the need for client-side hiding tricks.

**Historical note:** Previous versions hid the xterm cursor on mobile to avoid "orange square" duplication. The iframe compositor jail remains for the Android IME native caret problem.

### Keyboard Management

#### VirtualKeyboard API

The `overlaysContent` flag must be managed carefully throughout the terminal lifecycle:

- **Enable** when the terminal textarea is focused (`enableVirtualKeyboardOverlay`)
- **Disable** on terminal exit (`disableVirtualKeyboardOverlay`) so other inputs get normal browser resizing — but NOT on a pane-to-pane focus handoff (see [Multi-pane focus handoff](#multi-pane-focus-handoff))
- `overlaysContent` must be enabled BEFORE focus to beat the keyboard/layout race

#### Multi-pane focus handoff

The virtual-keyboard signals (`vkOpen`, `keyboardHeight`) and `overlaysContent` are a single shared resource for the whole window, owned by the focused Codeflare terminal surface. When several backend-session surfaces are visible in tablet MultiView and focus moves while the keyboard is open, the keyboard stays open and the newly focused surface keeps keyboard mode.

Classic retains the established tap, right-click, and buffer-authoritative gesture behavior. Herdr sessions translate hardware mouse clicks, drags, and wheels on xterm's actual `.xterm-screen` into SGR terminal input. A stationary touch is classified at trusted `touchend`, sends one press/release pair using one cell calculation, suppresses compatibility mouse events, then opens mobile input. Movement crossing the gesture threshold, long press, multi-touch, or cancellation does not activate a control. Herdr vertical swipes emit proportional wheel steps without inertia; Classic fullscreen swipes retain continuous wheel navigation and inertia. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::sendHerdrTap --> <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::focusMobileTerminal --> See [REQ-MOB-017](../../sdd/spec/mobile.md#req-mob-017-fullscreen-application-touch-scrolling), [REQ-MOB-020](../../sdd/spec/mobile.md#req-mob-020-terminal-touch-activation), and [REQ-TERM-036](../../sdd/spec/terminal.md#req-term-036-browser-pointer-interaction-with-herdr).

`web-ui/src/lib/mobile.ts::isFocusOnTerminalInput` is the single discriminator: it reports whether `document.activeElement` is a terminal input iframe (class `terminal-input-iframe`). The three per-pane focus-loss teardown sites gate on it so a handoff does not tear the shared keyboard down:

- `useTerminal.ts` keyboard-lifecycle `onCleanup` — skips `iframeInput.blur()`, `disableVirtualKeyboardOverlay()`, and `forceResetKeyboardState()` when focus is still on a terminal input.
- `terminal-mobile-input.ts` per-input blur debounce — skips `disableVirtualKeyboardOverlay()` on handoff.
- `useTerminal.ts` Samsung `focusout` — defers one tick (so the focus transition settles), then skips `forceResetKeyboardState()` on handoff.

A real exit (focus on a non-terminal element, or terminal unmount) is not a handoff, so those sites — and the unconditional iframe-removal cleanup in `setupMobileInput` — still tear the keyboard down. Implements [REQ-MOB-015](../../sdd/spec/mobile.md#req-mob-015-virtual-keyboard-persists-across-terminal-pane-focus-handoff).

#### Background prewarm focus safety

Vault browser prewarm runs in a hidden same-origin iframe while the user may already be typing in the terminal. It is intentionally not delayed by terminal focus or an open virtual keyboard. Instead, `injectVaultPrewarmFocusGuard()` makes only the valid-token prewarm shell focus-inert before SilverBullet app scripts run: script `focus()`, `select()`, and `window.focus()` calls are no-ops, focus-in events inside the hidden document are blurred, and `startVaultPrewarm()` restores the previously focused terminal/input element if the outer iframe captures parent focus. Normal user-opened Vault tabs do not carry prewarm parameters and keep regular editor focus behavior. Vault browser prewarm implements [REQ-MOB-014](../../sdd/spec/mobile.md#req-mob-014-mobile-background-surface-focus-isolation) and [REQ-VAULT-020](../../sdd/spec/vault.md#req-vault-020-vault-prewarm-focus-safety).

#### Samsung Internet Quirks

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

#### Samsung Focusout Handler

Samsung doesn't fire `geometrychange` when the back button dismisses the keyboard. Without detection, keyboard state signals stay stale (git: Fix 1).

**Solution:** `useTerminal.ts` registers a `focusout` listener on the terminal input element (only on Samsung). When `focusout` fires it defers one tick for the focus transition to settle, then — only if focus has left the terminal (`isFocusOnTerminalInput()` is false, i.e. not a pane-to-pane handoff) and `isVirtualKeyboardOpen()` is true — calls `forceResetKeyboardState()` to zero all signals. A handoff to a sibling terminal pane keeps the keyboard (see [Multi-pane focus handoff](#multi-pane-focus-handoff)). The listener is cleaned up on terminal deactivation.

#### Visibility Return Reset

When the browser is backgrounded and returned to, keyboard state signals (`keyboardHeight`, `vkOpen`, `viewportGrowth`) can be stale because (git: Fix 6):
- `disableVirtualKeyboardOverlay()` fires on blur (backgrounding) but does NOT reset signals
- `geometrychange` events are frozen or fall within the 50ms stale-ignore window
- On Samsung, `forceResetKeyboardState()` zeros signals on `focusout`, but `overlaysContent` stays `false`

**Chrome symptom:** Ghost padding at bottom -- `keyboardHeight()` stuck non-zero with keyboard closed.
**Samsung symptom:** No floating buttons + scrollable page -- `overlaysContent=false` means `geometrychange` never sets `vkOpen=true` when keyboard reopens.

**Why `forceResetKeyboardState()` instead of `resetKeyboardStateIfStale()`:** `boundingRect.height` returns stale cached values when the browser resumes -- the `visibilitychange` event fires before the compositor updates layout metrics. A conditional check (is keyboard closed?) always passes because the stale cache says height=0, but the signals may already be wrong in other ways. Unconditional zeroing is the only reliable approach.

**Solution (Chrome):** Two complementary fixes:
1. `terminal-mobile-input.ts` `restoreFocusIfNeeded()` calls `forceResetKeyboardState()` + `enableVirtualKeyboardOverlay()` BEFORE refocusing the input. This ensures signals are zeroed and `overlaysContent` is `true` when the keyboard opens.
2. `Layout.tsx` visibility handler calls `forceResetKeyboardState()` as fallback when focus restore doesn't fire (unfocused input or active readOnly guard), then delays `enableVirtualKeyboardOverlay()` by 300ms so Samsung's stale events settle before the toggle.

**Solution (Samsung -- Dashboard Bounce):** Samsung's VirtualKeyboard compositor state is fundamentally unreliable on browser resume. No combination of signal resets, delayed toggles, or stale-event windows reliably fixes it. The only path that consistently works is deactivating and reactivating the session -- this triggers the full Terminal keyboard lifecycle cleanup (onCleanup effects, `disableVirtualKeyboardOverlay`) and re-initialization (onMount effects, `enableVirtualKeyboardOverlay`).

`Layout.tsx` visibility handler detects Samsung via `isSamsungBrowser` and performs an automatic "dashboard bounce":
1. `forceResetKeyboardState()` -- zero all signals immediately
2. `sessionStore.setActiveSession(null)` + `setViewState('dashboard')` -- deactivate session (triggers Terminal cleanup)
3. After 50ms: `sessionStore.setActiveSession(sessionId)` + `setViewState('terminal')` -- reactivate (triggers Terminal re-init)
4. `reconnectOnVisibilityReturn()` -- reconnect any dropped WebSockets

The 50ms delay gives SolidJS time to process the null state and run cleanup effects before re-initialization begins. The user doesn't see the dashboard (50ms is below perception threshold).

**WebGL fallback:** Mobile GPU eviction can emit `webglcontextlost` while the app or public landing is backgrounded. Coarse-pointer backgrounding retires both decorative canvases proactively; context loss does the same on any device without requesting restoration. The simulations stop, their canvases leave compositing, and the root/body dark CSS background remains painted instead of a persistent bright gray or white layer. Implements [REQ-MOB-018](../../sdd/spec/mobile.md#req-mob-018-decorative-webgl-canvas-retirement) and [REQ-LANDING-009](../../sdd/spec/landing.md#req-landing-009-decorative-flare-failure-fallback).

**Samsung-specific input resume:** `terminal-mobile-input.ts` `restoreFocusIfNeeded()` does NOT auto-focus on Samsung (which would open the keyboard and trigger stale `geometrychange` events). Instead, it delays `enableVirtualKeyboardOverlay()` by 300ms so the compositor settles, then leaves the keyboard closed for the user to tap when ready. The 300ms delay ensures Samsung's delayed stale `geometrychange` events (which can arrive up to ~200ms after toggle) are caught by the 50ms ignore window from the delayed toggle.


#### FitAddon Management

Four mobile coordination paths discussed here can trigger `fitAddon.fit()` ([REQ-MOB-010](../../sdd/spec/mobile.md#req-mob-010-fitaddon-fit-calls-are-coordinated), [REQ-MOB-021](../../sdd/spec/mobile.md#req-mob-021-terminal-follows-visible-container-changes)):
1. **Keyboard refit** (debounced 150ms)
2. **Active-state effect** (immediate `requestAnimationFrame`)
3. **ResizeObserver** (immediate `requestAnimationFrame`)
4. **Herdr visibility return** (next `requestAnimationFrame`, followed by a full xterm refresh and same-size resize so the focused client requests a complete repaint)

In `web-ui/src/hooks/useTerminal.ts`, a `kbDebounceTimer` variable (timer ID, not boolean) gates the ResizeObserver. When the keyboard refit starts its debounce timer, `kbDebounceTimer` is set to the timer ID. The ResizeObserver checks `kbDebounceTimer !== null` and skips `fit()` when active. The timer callback sets it back to `null`. Using the timer ID instead of a boolean prevents timer cancellation from leaving the ResizeObserver gate set.

**Scroll preservation after `fit()`:** Scroll-owning refit paths preserve or restore position because `fit()` recalculates terminal dimensions and can reset the viewport to the top. The rules are:

- **Mobile with keyboard open:** Always anchor to the bottom after `fit()` via `scrollBufferToBottom()` (buffer-authoritative — the public `scrollToBottom()` resolves relative to clamp-vulnerable DOM scroll state, [AD110](../decisions/README.md#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops)).
- **Herdr Pi fullscreen keyboard opening:** Because xterm cannot anchor Pi-owned history, a trusted tap sends `End` after activation and before focus. Pi moves to live bottom. Open-keyboard taps preserve the viewport. ([REQ-MOB-022](../../sdd/spec/mobile.md#req-mob-022-herdr-mobile-input-focus-and-viewport) AC3-AC4)
- The user expects to see the prompt whenever the keyboard is open.
- **Desktop / mobile without keyboard:** Check `isAtBottom()` *before* `fit()`. If the user was following output (viewport at bottom), call `scrollBufferToBottom()` after `fit()`; if they had scrolled up into scrollback, preserve their position and call `resyncViewportScrollState()`.
- **Mounted and visible guard:** Every fit path requires a mounted terminal and prevents `fit()` from running while the container height is zero. The Herdr visibility-return path also requires the document to be visible. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
    - Inactive terminals have `height: 0` via CSS; calling `fit()` on a zero-height container calculates `rows = 0`, which clamps `viewportY` and corrupts scroll state when the terminal re-expands.

`resyncViewportScrollState()` re-commands the DOM scroll state from the buffer instead of letting it drift toward the next divergence jump. It applies to the keyboard, active-state, ResizeObserver, init-overlay, and keyboard-lifecycle refits. Visibility return instead performs a full refresh and repaint request after fitting.

### Touch Input

#### Swipe Gestures

Horizontal swipe gestures (left/right arrow key simulation) use a `setInterval` repeat timer that fires every 80ms while the finger is held. `touchstart`/`touchmove` were registered in capture phase, but `touchend`/`touchcancel` were in bubble phase. When xterm.js's internal Gesture handler (on `.xterm-screen`) called `stopPropagation()` on `touchend` during its own gesture processing, the bubble-phase listener on the container never fired, leaving the repeat timer running indefinitely (git: Fix 7).

**Solution:** Register `touchend`/`touchcancel` in capture phase (`{ capture: true }`) matching `touchstart`/`touchmove`. Our handler now fires before xterm's, guaranteeing the repeat timer is always cleared.

**xterm 6.1 Gesture shield (git: Fix 20).** xterm 6.1 (`6.1.0-beta.292`) vendored VS Code's touch-scroll rewrite (upstream PR #5377, absent from 6.0.0), which registers a document-level `Gesture` singleton via `MouseService` → `Gesture.addTarget(.xterm-screen)` and calls `preventDefault()` on any `touchstart`/`touchend` starting inside the terminal. Per the Touch Events spec that cancels the browser's synthesized `click` — codeflare's ONLY mobile-keyboard-open trigger (`Terminal.tsx` `on:click`) — so upgrading past 6.0.0 silently broke tap-to-open-keyboard on mobile (the keyboard never appeared; scrolling still worked).

Fix: a bubble-phase `stopPropagation` "Gesture shield" for `touchstart`/`touchmove`/`touchend` on the terminal container in `attachSwipeGestures()` (`web-ui/src/lib/touch-gestures.ts`) — codeflare's own capture-phase handlers still run first, the shield itself does not call `preventDefault()`, and xterm's document-level Gesture singleton never sees a terminal-container touch. Classic therefore retains browser click synthesis. Removed on terminal cleanup. Covered by `touch-gestures.test.ts` (shield blocks container-origin touches from reaching document-level listeners; outside-container touches unaffected; cleanup removes the shield). Kept on top of the beta pin rather than reverting it — pinning an intermediate build is impossible (both breaking commits are ancestors of #5770's branch, the Pi-flicker mitigation this repo needs; see [Pi Terminal Flicker](troubleshooting.md#pi-terminal-flicker-or-scrollback-snaps-to-an-edge)). ([REQ-MOB-002](../../sdd/spec/mobile.md#req-mob-002-virtual-keyboard-opens-reliably-on-tap) AC6)

Herdr instead prevents the `touchend` default, then activates and focuses through its trusted `onHerdrTap` path. During the bounded post-touch window, it suppresses `mousedown`, `mouseup`, and `click` events identified by touch capability. When that capability is absent, events near the touch start or end are treated as compatibility events; explicitly identified hardware mouse events pass through. ([REQ-MOB-020](../../sdd/spec/mobile.md#req-mob-020-terminal-touch-activation) AC1-AC2)

Append `?debug=1` to a terminal URL to show a bounded, content-free input trace above existing keyboard and viewport diagnostics. The trace records event ordering, final cancellation state, touch-origin capability, target, focus, touch-move count, and keyboard geometry without recording terminal text. ([REQ-MOB-023](../../sdd/spec/mobile.md#req-mob-023-opt-in-mobile-input-diagnostics) AC1-AC4) <!-- @impl: web-ui/src/lib/touch-event-debug.ts::attachTouchEventDebug --> <!-- @test: web-ui/src/__tests__/lib/touch-event-debug.test.ts (touch event debug trace) -->

**Fullscreen alternate-buffer scroll routing (git: Fix 22).** Claude Code `/tui fullscreen` renders conversation history inside the alternate screen and captures wheel reports, so `terminal.scrollLines()` cannot move that application-owned history. Desktop wheel events already reach Claude; mobile swipes did not because the Gesture shield deliberately keeps xterm's document-level touch handler out. `attachSwipeGestures()` now detects an alternate buffer with wheel-capable mouse tracking and emits one line-mode `WheelEvent` per accumulated touch line on `terminal.element`. xterm retains ownership of mouse-protocol encoding and the shield continues preserving tap-to-open-keyboard.

The route applies only while the keyboard is closed: with the keyboard open, vertical swipes always send arrow keys (the typing-mode scroll-lock — Fix 22's original keyboard-open wheel routing regressed it and was reverted). Normal-buffer swipes scroll the buffer service directly via `scrollBufferLines()` (see [Viewport DOM Desync](#viewport-dom-desync-instant-yank-to-top)). ([REQ-MOB-017](../../sdd/spec/mobile.md#req-mob-017-fullscreen-application-touch-scrolling) AC1, [REQ-MOB-005](../../sdd/spec/mobile.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll) AC7)

#### Input Architecture

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

   With the keyboard closed and normal scrollback active, vertical swipes in `touch-gestures.ts` scroll xterm's buffer service directly through `scrollBufferLines()` (`xterm-internals.ts`) — never the public viewport-relative `terminal.scrollLines()`, whose DOM scroll state can desync and yank the viewport (see [Viewport DOM Desync](#viewport-dom-desync-instant-yank-to-top)). The gesture handler accumulates pixel deltas and converts them to lines using the terminal font metrics; the pinned xterm `6.1.0-beta.292` scroll layer is JS-based (`SmoothScrollableElement`), not native overflow.

   An alternate-screen application with wheel-capable mouse tracking owns its own history. `attachSwipeGestures()`'s `scrollTouchLines()` helper (`web-ui/src/lib/touch-gestures.ts`) turns the same accumulated lines into DOM wheel events on xterm's terminal element, allowing xterm to encode application mouse reports instead of attempting to move nonexistent terminal scrollback.
7. **Floating page navigation**

   The page-up and down-arrow controls query the focused terminal's live buffer type on each click. Normal-buffer controls scroll the buffer service via `scrollBufferLines()` with buffer-derived page/bottom deltas (the public `scrollPages`/`scrollToBottom` resolve against desync-prone DOM scroll state). Alternate-screen controls send the PageUp/PageDown input sequences so fullscreen applications such as Claude Code move their application-owned history instead of nonexistent terminal scrollback. The same target resolver preserves focused MultiView pane routing. ([REQ-MOB-001](../../sdd/spec/mobile.md#req-mob-001-terminal-fully-usable-on-mobile-devices) AC7)

<a id="xterm-61-color-scheme-report-suppression-git-fix-21"></a>
## Terminal Compatibility

Not touch-related — filed here as a sibling xterm-6.1 regression (backed by `REQ-TERM-019` AC2, fixed in `useTerminal.ts`, not `touch-gestures.ts`).

xterm 6.1's default-on color-scheme reporting (upstream PR #5628) answers `CSI ?996n` and pushes `CSI ?997;1n` on every theme change once a TUI enables DECSET 2031. `applyCursorVisibility()` reassigns `options.theme` on every DECTCEM (cursor show/hide) toggle, so a 2031-enabled TUI (Claude Code, which toggles the cursor constantly and has a known echo gap — anthropics/claude-code#41570) gets flooded with `?997` reports it echoes at the prompt (visible as a literal `^[[?997;1n` and a corrupted status line).

Fix: `vtExtensions: { colorSchemeQuery: false }` passed to the `Terminal` constructor in `useTerminal.ts` — a public typed xterm option that gates both the `996` reply and the `2031` push, restoring exact 6.0.0 byte behavior. Covered by `useTerminal.test.ts` (constructor contract: `vtExtensions.colorSchemeQuery === false`). ([REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards) AC2)

## Scroll Stability

### Root Cause

`@xterm/xterm` is pinned to `6.1.0-beta.292`. Its deferred viewport-DOM synchronization fixes Pi's synchronized-output flicker, and its full-buffer trimming owns the surviving-content anchor for a user reading scrollback. The Codeflare regression was not an xterm defect: write-side distance restoration and scroll-event reset correction both tried to override xterm, then reacted to the programmatic scroll events they generated.

xterm 6.0.0 replaced `.xterm-viewport` (native `overflow-y: scroll` with a scroll-area div) with VS Code's `SmoothScrollableElement` (JS-based scrolling via transforms). Despite this, the terminal would jump to the top of scrollback during burst output (git: Fix 8). Root cause was a vicious cycle between two performance hacks:

**`_syncTextArea` freeze + scroll guard vicious cycle:**

1. `_syncTextArea` was frozen (replaced with a no-op) to avoid ~30 style recalcs/sec on xterm's hidden textarea during burst output. This left the textarea stuck at `(0,0)` instead of following the cursor.

2. With the textarea at `(0,0)`, the browser's focus validation engine would force-scroll containers to reveal the focused element, causing a visual snap to the top.

3. A capture-phase "scroll guard" was added to counteract this -- intercepting native scroll events on `.xterm-viewport`, `.xterm-screen`, `.xterm-scrollable-element`, and `.xterm`, forcing `scrollTop/scrollLeft` back to `0`.

4. **The scroll guard was the actual bug.**

     xterm 6.0.0's `SmoothScrollableElement` still uses `.xterm-viewport`'s native `scrollTop` as the synchronization mechanism between the scrollbar and `viewportY`. Forcing `scrollTop = 0` on viewport scroll events told xterm the user scrolled to the absolute top of the buffer, setting `viewportY = 0`.

**Solution:** Remove both hacks. `_syncTextArea` stays active so the textarea follows the cursor -- the browser's focus-scroll then targets the cursor position (bottom of terminal), not `(0,0)`. The scroll guard is no longer needed because the focus-scroll no longer causes a snap to top. The ~30 style recalcs/sec on a single hidden element is negligible compared to the scroll corruption it was preventing.

**Current ownership model:**

1. **FOLLOW_OUTPUT** -- the synchronous `useScrollCorrection()` guard owns bottom following. It re-anchors before paint only when the terminal was already following output and no correlated user scroll intent transferred ownership.

2. **READ_SCROLLBACK** -- wheel, pointer, navigation-key, touch-drag, and registered external intent transfer ownership to the user until the viewport returns to the live bottom.

While ownership is active, `flushWriteBuffer()` defers streamed output (bounded by a 2M-character cap) so trimming cannot move the owned viewport; returning to bottom releases whole held units toward a 65,536-character per-tick target. Overflow beyond the 2M-character cap drops the oldest whole held units rather than writing through beneath the reader; xterm applies any later trimming, and no restoration is ever injected.

3. **MOBILE_INPUT_LOCKED** -- opening the touch keyboard keeps the established fit-and-bottom transition in `useTerminal()`.

Generic correction stays inactive while the keyboard is open, and vertical swipes always remain terminal input gestures -- fullscreen wheel routing applies only while the keyboard is closed.

**Verification (git: Fix 10):** Deep analysis of xterm 6.0.0 source confirmed that `.xterm-viewport` is genuinely empty (`CoreBrowserTerminal.ts` creates a bare `<div>` with no children), no xterm code reads/writes `_viewportElement.scrollTop`, mouse wheel is handled by `SmoothScrollableElement` JS (`scrollableElement.ts`), and the visible scrollbar is the overlay widget (`.xterm-scrollable-element > .scrollbar`). `overflow: hidden` on an empty element has zero functional impact on xterm.

**Additional hardening:**
- Every fit path prevents `fit()` while the container height is zero, avoiding zero-row dimension calculations during CSS visibility transitions (inactive terminals have `height: 0`). <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
- All `scrollToBottom()` call sites check `viewportY >= baseY` before scrolling to preserve manual scrollback position.
- In Classic mode, `flushWriteBuffer()` either defers the batch (owned viewport) or passes it to xterm unchanged; it never inspects or alters viewport position after a write.
- `refitAllTerminals()` skips the resize WS message if dimensions didn't change.

### Persistent Manual Ownership

The earlier distance-from-bottom detector remained incorrect at the full-buffer boundary. xterm can legitimately move a manually selected viewport from a deep offset all the way to zero when one dense batch ages out every viewed line; the detector treated that native transition as a focus reset and injected `scrollLines()`. The write callback could then restore distance again, producing more `onScroll` events and visible top/bottom snapping.

The short intent window now serves only to correlate a wheel, pointer, navigation-key, touch, or registered external action with its first scroll event. Touch drags refresh the window on every `touchmove`: a drag's first `scrollLines` call can land hundreds of milliseconds after the initial `pointerdown`, and without the refresh that scroll event was misread as a browser displacement and snapped back to the bottom mid-gesture. Once correlated, manual ownership persists without a timer and is released only when the viewport reaches the live bottom. No generic zero-clamp or distance-restoration heuristic remains.

### xterm 6.1 Native Full-Buffer Anchoring

When the scrollback (capped at 5,000 lines) is full, xterm 6.1 decrements `viewportY` as old lines trim so the same surviving content remains under a scrolled-up user. That anchor is only content-stable until it reaches zero: under sustained agent output the reader's `viewportY` slides to the top within seconds and the viewed lines are then destroyed beneath them — the "terminal snaps to the top while the agent is outputting" failure. No viewport correction can fix this, because the content itself is being trimmed away.

Codeflare therefore stops trimming under a reader entirely: while manual ownership is active in the normal buffer, `flushWriteBuffer()` defers streamed output (data keeps accumulating in the per-terminal write buffer, re-checked every 33ms tick) instead of writing it. The frozen buffer means no trims, no `onScroll` churn, and a perfectly stable reading position. Returning the viewport to the live bottom — swipe down, floating page-down button, or the keyboard-open bottom anchor — uses a 65,536-character release target per tick while preserving whole held units; one unit may exceed the target. It rechecks ownership before each later slice.

A 2,000,000-character cap bounds held memory. Overflow drops the oldest whole held units with ring-buffer semantics; it never writes through beneath the reader. In Classic mode, alternate-buffer output is never deferred because the fullscreen application owns its history. `useScrollCorrection()` retains manual ownership throughout so a post-cap zero offset cannot be reclassified as bottom-following or pulled toward the live prompt.

### Herdr Viewport Ownership

Fresh Herdr Pi starts with `--tui-mode fullscreen`, so Pi owns transcript history and preserves its internal viewport while output continues. Codeflare queues complete Herdr differential frames on the standard 33 ms output schedule and presents them in order without a viewport-specific gate. Classic keeps its existing terminal-owned scrollback hold. This path implements [REQ-TERM-040](../../sdd/spec/terminal.md#req-term-040-stable-herdr-pane-scrollback). <!-- @impl: image/herdr/codeflare-herdr-terminal::bootstrap --> <!-- @impl: web-ui/src/stores/terminal-output.ts::scheduleWrite -->

### Viewport DOM Desync (instant yank to top)

Distinct from trim-drag: a reader parked mid-scrollback (even with *slow* output) could be yanked to the very top in a single event. xterm 6.1 routes every public `scrollLines()`/`scrollPages()`/`scrollToBottom()` through the viewport's DOM scroll state and applies deltas **relative to its current `scrollTop`** (`CoreBrowserTerminal`: "All scrollLines methods need to go via the viewport in order to support smooth scroll"). That DOM state can silently desync from the buffer: `Viewport._sync()` wraps `setScrollDimensions()` in a suppressed scroll handler, so a refit passing through zero height (keyboard animation, MultiView pane switch, URL-bar churn) clamps `scrollTop` to 0 without xterm noticing, and no repair runs while `buffer.ydisp` still equals the viewport's cached `_latestYDisp`.

The next relative tick — one swipe line — then computes from the clamped position, and xterm's `_handleScroll` resolves the full divergence as a single `scrollLines(-<depth>)`: instant top. Intent-window heuristics (the old Strategy 2) are structurally blind to this because the yank rides on the user's own gesture event.

**Solution: buffer-authoritative scrolling.** `scrollBufferLines()` (`xterm-internals.ts`) scrolls the internal `BufferService` directly with buffer-derived deltas; touch scroll (`scrollTouchLines`) and the floating page controls use it. Every buffer scroll event makes `Viewport._sync()` re-command the DOM scroll state **absolutely** (`setScrollPosition(ydisp * cellHeight)`), so a desynced DOM can move the viewport by at most one gesture delta before being snapped back to buffer truth.

The helper falls back to the public API when internals are absent; the mobile debug overlay already reads `_core._bufferService`, so the pinned build's property shape is proven in production.

#### Keyboard-Open Suppression

With the keyboard open, normal terminal scrollback is bottom-anchored: output auto-follows and vertical swipes send arrow keys — including under fullscreen applications with mouse tracking, where the arrow keys drive the application's own input handling. (An earlier revision routed keyboard-open swipes to the fullscreen wheel pipeline; that broke the typing-mode scroll-lock and was reverted — wheel routing now applies only while the keyboard is closed.) Multiple independent xterm scroll mechanisms previously fought during keyboard-open output (git: Fix 16):

1. Keyboard height change effect called `scrollToBottom()` (leading + trailing edge)
2. ResizeObserver called `scrollToBottom()` ~18 times during 300ms keyboard animation
3. Generic scroll correction could react to side effects of the above

**Solution:**
1. **Disable generic correction during touch-keyboard mode** -- keyboard lifecycle owns fit and bottom anchoring.
2. **Keep ResizeObserver from adding keyboard-open bottom snaps** -- the keyboard height effect already owns fit + bottom during animation, so concurrent observer snaps remain redundant.

The keyboard height effect remains the source of truth for keyboard-transition refits; the pre-paint scroll-event handler preserves bottom-following output.

### Bottom-Following Re-Anchor

Users following the prompt saw flashing when generic post-write correction competed with xterm's render and viewport synchronization (git: Fix 19). Bottom ownership therefore remains in xterm's synchronous `onScroll` path, where the terminal can distinguish a follower from a user reading scrollback before the next paint.

**Solution:**

1. **Bottom-following correction stays in `onScroll`** (`useScrollCorrection.ts`) -- when `wasFollowingOutput` is true and `ydisp < ybase`, call `scrollToBottom()` immediately. The `isCorrectingScroll` flag prevents recursion, and recent wheel/pointer/navigation intent prevents trapping a user at the bottom.

2. **Writes never correct scrolling** (`terminal.ts`) -- `flushWriteBuffer()` defers the batch while the user owns the viewport and otherwise delegates it to xterm whole.

No callback-owned distance restoration, line scrolling, or bottom snap exists in the write path. Integrated tests compose `write()` with native-like `onScroll` events to prove that streamed output can neither move an owned viewport nor create a correction loop ([REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming) AC2/AC3).

### Scroll Stability Overhaul Context

Earlier iterations introduced overlapping correction mechanisms that fought each other. The current design keeps only:
- A synchronous bottom-follower guard with a re-entrancy flag
- Persistent manual ownership established by correlated intent
- External intent registration for floating-button page navigation
- Explicit touch-keyboard lifecycle ownership
- A 5,000-line scrollback cap with agent-side virtual scrolling disabled

<a id="websocket-recovery"></a>
## Transport Recovery

### Retryable Close Codes

The WebSocket reconnection logic retries on a set of close codes (`WS_RETRYABLE_CLOSE_CODES`) rather than only on `1006` (Abnormal Closure). This covers server shutdown (1001), unexpected conditions (1011), service restart (1012), and try-again-later (1013). Normal closure (1000) does NOT trigger retry. Custom close code **4503** (`WS_CONTAINER_STOPPED_CODE`) is sent by the Container DO and terminal route when the container is not running -- the client treats this as authoritative and stops retrying immediately. Network errors (1006) retry indefinitely; KV polling handles session status (git: Fix 5).

---

<a id="scroll-stability-integration-test-plan"></a>
## Behavioral Test Matrix

[REQ-MOB-004](../../sdd/spec/mobile.md#req-mob-004-scroll-drop-detection-during-burst-output), [REQ-MOB-012](../../sdd/spec/mobile.md#req-mob-012-scroll-anchoring-during-keyboard-transitions), and [REQ-MOB-019](../../sdd/spec/mobile.md#req-mob-019-keyboard-mode-swipe-semantics) define one scroll owner per terminal mode across `terminal.ts`, `useScrollCorrection.ts`, `useTerminal.ts`, and `touch-gestures.ts`. Behavioral unit tests compose batched writes with native-like `onScroll` feedback and verify keyboard lifecycle/gesture routing. The deployed-browser checklist below covers visual stability and device event ordering that have no genuine unit-test seam.

### REQ-MOB-004 test scenarios

1. **Burst output retains bottom anchor.** Start a session, open a terminal tab, stream more than the 5,000-line cap, and confirm a bottom follower remains at the live prompt.
2. **Manual ownership freezes streamed output.** Scroll into history and continue output beyond the intent-correlation window.

The reading position must stay perfectly still (output is deferred — no trims, no drift toward the top), and scrolling back to the prompt must release held output in bounded chunks while ownership remains at the bottom.
3. **Returning to bottom restores following.** Scroll back to the live prompt, continue output, and confirm bottom following resumes.
4. **Viewport overflow style.** Confirm `.xterm .xterm-viewport` retains `overflow: hidden`; xterm's scroll layer remains the sole scroller.

### REQ-MOB-012 test scenarios

1. **Tap opens and anchors.** Tap the terminal, confirm the virtual keyboard opens, and confirm the lifecycle fit performs one intentional bottom anchor.
2. **Keyboard-open viewport is locked.** During keyboard-open output, confirm generic correction does not move the viewport.
3. **Keyboard close restores scrollback ownership.** Close the keyboard and confirm manual ownership persists until the viewport returns to bottom.

### REQ-MOB-019 test scenarios

1. **Keyboard-open swipes send arrows.** With the keyboard open, confirm every vertical swipe sends terminal arrow input, including inside fullscreen applications with mouse tracking.
2. **Fullscreen wheel routing stays keyboard-closed.** With the keyboard closed, confirm fullscreen vertical swipes route through xterm's wheel pipeline.
3. **Keyboard close restores swipe scrolling.** Close the keyboard and confirm vertical swipes return to terminal scrollback.

The Verification fields in [`sdd/spec/mobile.md`](../../sdd/spec/mobile.md) point at the committed behavioral tests; this checklist supplies deployed-browser confirmation of rendering and native event ordering.

---

<a id="specification-coverage"></a>
## Requirement and Source Map

| Mobile concern | Requirements | Source owner | Evidence |
|---|---|---|---|
| Focus/keyboard/viewport | REQ-MOB-001/002/003/009/010/011/013/014/015/016 | terminal store, mobile-input, viewport utilities | Unit/integration checks plus deployed-device matrix |
| Touch and fullscreen input | REQ-MOB-005/006/007/017/019 | gesture/input components and xterm integration | Gesture-mode behavioral tests |
| Cursor/render compatibility | REQ-MOB-008 and terminal rendering contract | terminal setup/CSS/xterm version | Agent/device verification |
| Scroll ownership and anchoring | REQ-MOB-004/012 | scroll controller, terminal store, trim/resize handlers | Burst, resize, keyboard-transition scenarios |
| Retired decorative surface | REQ-MOB-018 | landing/web UI source | Absence checks and current composition docs |

---

## Related Documentation
- [Architecture](architecture.md#frontend-solidjs--xtermjs) - Frontend architecture
- [Architecture](architecture.md#terminal-server-node-pty) - Terminal server
- [Container](container.md#container-startup) - Container startup
- [Troubleshooting](troubleshooting.md) - Common failure modes
