# Mobile Terminal

Touch input, virtual keyboard, scroll stability, and terminal rendering on mobile browsers (phones and tablets).

**Domain owner:** Frontend (SolidJS + xterm.js), mobile.ts, touch-gestures.ts, terminal-mobile-input.ts

### Key Concepts

- **VirtualKeyboard API** -- The browser API (`navigator.virtualKeyboard`) used to detect keyboard geometry changes and control `overlaysContent` behavior.
- **Touch Gesture** -- Swipe-based input on touchscreens, translated to arrow keys (horizontal) or terminal scroll (vertical).
- **Scroll Stability** -- The set of mechanisms (viewport overflow hidden, scroll-drop detection, programmatic suppression) that prevent the terminal from jumping during output bursts or keyboard transitions.

### Out of Scope

- Native mobile app (Codeflare runs entirely in the mobile browser)
- Offline mobile support (requires active WebSocket connection to container)

### Domain Dependencies

- **Terminal** (xterm.js integration) -- Mobile features extend the terminal rendering and input layer.
- **Session Lifecycle** (container connection) -- Mobile terminals require a running container, same as desktop.

---

## REQ-MOB-001: Terminal fully usable on mobile devices

**Applies To:** User

**Intent:** The terminal must be fully functional on phones and tablets, providing a usable coding experience without requiring a desktop browser.

**Acceptance Criteria:**
1. The terminal renders correctly on mobile viewports (phones and tablets) using xterm.js with SolidJS.
2. Text input, command execution, and output display work identically to desktop except where touch interaction necessarily differs.
3. E2E UI mobile tests (`e2e-ui-mobile` job with `E2E_MOBILE=1`) pass against the deployed worker.
4. The terminal adjusts layout when the virtual keyboard opens or closes without visual corruption.
5. FitAddon recalculates terminal dimensions on viewport changes (keyboard open/close, orientation change, resize).
6. All `fit()` call sites guard against zero-height containers (`containerEl.clientHeight === 0`) to prevent row calculation corruption on inactive terminals.

**Constraints:**
- Mobile-specific code paths are gated behind touch detection (`pointer: coarse` media query or VirtualKeyboard API availability).
- No polling or timers for state verification; all fixes are event-driven on top of the stable `df1dcfc` baseline.

**Priority:** P0
**Dependencies:** REQ-TERM-002
**Verification:** Automated test
**Status:** Implemented

---

## REQ-MOB-002: Virtual keyboard opens reliably on tap

**Applies To:** User

**Intent:** Tapping the terminal must reliably open the device's virtual keyboard, and the terminal must resize correctly to accommodate it.

**Acceptance Criteria:**
1. The VirtualKeyboard API `overlaysContent` flag is enabled BEFORE focus to beat the keyboard/layout race condition.
2. `overlaysContent` is disabled on terminal exit (`disableVirtualKeyboardOverlay`) so other inputs receive normal browser resizing.
3. The `geometrychange` event from the VirtualKeyboard API is used to detect keyboard height changes.
4. Terminal height is reduced by the keyboard height so content is not obscured.
5. An iframe compositor jail provides a separate compositor context for Android IME caret containment.
6. A `createElement` monkey-patch (scoped to `terminal.open()`) uses `input[type=password]` instead of textarea to suppress autocorrect at the OS level.
7. The `isFocused` getter uses a live reference via `iframe.contentDocument?.hasFocus()` to avoid stale focus state.

**Constraints:**
- `overlaysContent` must be toggled only on actual state changes (false-to-true or true-to-false); redundant no-op calls must NOT restamp the ignore window timestamp.
- The 50ms stale-event ignore window must apply only to genuine toggles.

**Priority:** P0
**Dependencies:** REQ-MOB-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-MOB-003: Samsung Internet keyboard quirks handled

**Applies To:** User

**Intent:** Samsung Internet's non-standard VirtualKeyboard API behavior must be compensated for so the terminal functions correctly on Samsung devices.

**Acceptance Criteria:**
1. Stale `geometrychange` events (cached from previous toggle) are ignored within a 50ms window after `overlaysContent` changes value.
2. The stale-event ignore window timestamp (`overlaysContentChangedAt`) is stamped ONLY when `overlaysContent` actually changes value; no-op calls do not restamp.
3. Samsung's bottom navigation bar viewport inflation is compensated: `baselineInnerHeight` captures pre-keyboard `window.innerHeight`, and `viewportGrowth` is subtracted from `boundingRect.height` in `getKeyboardHeight()`.
4. `baselineInnerHeight` is immutable after module initialization, except for Galaxy Fold screen-switch events (delta > 200px with keyboard closed).
5. `baselineInnerHeight` is never updated during keyboard close, `forceResetKeyboardState()`, or `resetKeyboardStateIfStale()`.
6. Samsung's `focusout` event (back button keyboard dismiss) triggers `forceResetKeyboardState()` to zero all keyboard state signals.
7. Samsung browser resume uses an automatic "dashboard bounce" (deactivate then reactivate session after 50ms) to reset the unreliable VirtualKeyboard compositor state.
8. Samsung-specific address bar position is configured via a user settings toggle (`samsungAddressBarTop`) since no API exists to detect it.

**Constraints:**
- Samsung detection uses `isSamsungBrowser` flag.
- The 50ms dashboard bounce delay gives SolidJS time to process null state and run cleanup effects before re-initialization.
- Samsung-specific input resume does NOT auto-focus (prevents stale `geometrychange` events); keyboard stays closed for user tap.

**Priority:** P1
**Dependencies:** REQ-MOB-002
**Verification:** Manual check
**Status:** Implemented

---

## REQ-MOB-004: Scroll position stable during output and keyboard transitions

**Applies To:** User

**Intent:** The terminal viewport must not jump or flicker during burst output, keyboard open/close transitions, or browser background/foreground cycling.

**Acceptance Criteria:**
1. `.xterm .xterm-viewport` has `overflow: hidden !important` on all devices, preventing native scroll interference with xterm 6.0.0's `SmoothScrollableElement`.
2. `_syncTextArea` remains active (not frozen) so the browser's focus-scroll targets the cursor position at the bottom, not `(0,0)`.
3. A synchronous post-write scroll guard in `flushWriteBuffer()` checks `viewportY < baseY` both synchronously and in `requestAnimationFrame`.
4. A scroll-drop detector in `useTerminal` monitors for sudden `ydisp` drops to 0 when `ybase` is high, correcting via `queueMicrotask(() => scrollToBottom())`.
5. Distance-based detection (not absolute `ydisp === 0`) distinguishes browser focus resets from normal scrollback trimming. Detection requires: `previousYdisp > 20`, `ybase > 20`, and `distanceDrift > 20`.
6. Programmatic scroll corrections are wrapped in a suppression counter (`beginProgrammaticScroll`/`endProgrammaticScroll`) to prevent the scroll-reset detector from misidentifying them.
7. When the keyboard is open, the scroll-reset detector is skipped (browser focus resets cannot happen in keyboard-open mode).
8. Bottom-following users see zero flicker: correction is applied in the `onScroll` handler (before the canvas paints) rather than in the async write callback.
9. Scrolled-up users have their relative position preserved across scrollback trimming via distance-based restoration (`targetY = currentBaseY - savedDistanceFromBottom`).

**Constraints:**
- The `isCorrectingScroll` flag prevents recursion when `scrollToBottom()` inside corrections triggers synchronous `onScroll` events.
- Recent user intent (wheel/pointerdown/keydown) is checked before forcing bottom-following users to the bottom.
- Scrollback is limited to 1000 lines (frontend and headless). Virtual scroll is disabled (`CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1`).

**Priority:** P0
**Dependencies:** REQ-TERM-008
**Verification:** Automated test
**Status:** Implemented

---

## REQ-MOB-005: Swipe gestures send arrow keys or scroll

**Applies To:** User

**Intent:** Horizontal swipe gestures simulate arrow key presses for command-line navigation, while vertical swipes scroll the terminal buffer when the keyboard is closed.

**Acceptance Criteria:**
1. Horizontal swipe gestures (left/right) send arrow key escape sequences to the terminal.
2. A `setInterval` repeat timer fires every 80ms while the finger is held, sending repeated arrow keys.
3. `touchstart`, `touchmove`, `touchend`, and `touchcancel` are all registered in capture phase (`{ capture: true }`) to guarantee cleanup before xterm's internal Gesture handler calls `stopPropagation()`.
4. The repeat timer is always cleared on `touchend` or `touchcancel`.
5. When the keyboard is closed, vertical swipes scroll the terminal buffer via `terminal.scrollLines()`.
6. The gesture handler accumulates pixel deltas and converts to line-granularity scroll, with sensitivity derived from terminal font metrics (`fontSize * lineHeight`).
7. When the keyboard is open, vertical swipes do NOT scroll (touch events are blocked); horizontal swipes send arrow keys.

**Constraints:**
- xterm 6.0.0's `SmoothScrollableElement` uses JS-based scrolling that does not support native touch; `.xterm-viewport` no longer has scrollable content.
- Touch scroll must use `terminal.scrollLines()` for direct buffer scrolling.

**Priority:** P1
**Dependencies:** REQ-MOB-001, REQ-TERM-002
**Verification:** Manual check
**Status:** Implemented

---

## REQ-MOB-006: Sticky Ctrl button for mobile

**Applies To:** User

**Intent:** Mobile users can send Ctrl-modified key sequences (Ctrl+C, Ctrl+D, etc.) without a physical keyboard by using a persistent on-screen Ctrl button.

**Acceptance Criteria:**
1. A floating Ctrl button is visible on mobile when the terminal is active.
2. Tapping the Ctrl button enters a "sticky" state where the next key press is sent as a Ctrl-modified sequence.
3. Common sequences (Ctrl+C for interrupt, Ctrl+D for EOF) work correctly via the sticky Ctrl mechanism.
4. The Ctrl button state resets after one modified key press (single-use sticky behavior).
5. The Ctrl button does not interfere with normal text input when not activated.

**Constraints:**
- The button must be positioned to avoid overlapping with the virtual keyboard or terminal content.
- The button is part of the floating button UI layer alongside other mobile controls.

**Priority:** P0
**Dependencies:** REQ-MOB-001, REQ-MOB-002
**Verification:** Manual check
**Status:** Implemented

---

## REQ-MOB-007: Voice input via Web Speech API

**Applies To:** User

**Intent:** Users can dictate text into the terminal using the device microphone, providing an alternative input method on mobile (and desktop).

**Acceptance Criteria:**
1. Voice input uses the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) implemented in `speech-input.ts`.
2. Voice input is completely decoupled from the keyboard/iframe input system.
3. On mobile, a floating microphone button starts recognition. On desktop, a small mic icon in the bottom-right corner and `Ctrl+Space` keyboard shortcut toggle voice input.
4. Each activation captures one utterance: tap/shortcut, speak, pause, text sent, auto-deactivates (`continuous=false`, `interimResults=false`).
5. Final transcribed text is sent directly to `terminal.input()`.
6. The mic button is hidden on browsers that do not support the Web Speech API.
7. On first use, if `navigator.permissions.query({name: 'microphone'})` returns state `'prompt'`, the iframe input is blurred (dismissing the keyboard) before calling `recognition.start()` so the user can see the browser permission prompt.
8. The same blur-before-permission pattern applies to clipboard paste (`clipboard-read` permission).
9. Composition events (`compositionstart`/`compositionend`) buffer swipe typing text until the IME commits.

**Constraints:**
- Reliability over features: one utterance per activation, no interim results.
- Permission prompt handling is critical on mobile where the prompt appears behind the virtual keyboard.

**Priority:** P2
**Dependencies:** REQ-MOB-001
**Verification:** Manual check
**Status:** Implemented

---

## REQ-MOB-008: Cursor visible for all supported agents

**Applies To:** User

**Intent:** The terminal cursor must be visible and correctly rendered for all supported CLI agents (Claude Code, Copilot, etc.) without duplication or visual artifacts.

**Acceptance Criteria:**
1. xterm cursor is enabled with `cursorBlink: true` and `cursorStyle: 'bar'`.
2. Cursor colors are set: cursor `#e4e4f0`, cursor accent `#1a2332`.
3. CSS rules that previously hid cursor elements (`.xterm-cursor-block`, `.xterm-cursor-outline`, `.xterm-cursor-bar`, `.xterm-cursor-underline`) are removed.
4. `applyCursorVisibility()` does not hide the cursor in alternate buffer mode; it only honors DECTCEM hide sequences from the agent.
5. No "orange square" duplication where both the DOM cursor and CLI's ANSI cursor are visible (newer CLI versions rely on xterm's native cursor layer).
6. The iframe compositor jail code remains as a precaution for the Android IME native caret problem (separate from xterm's DOM cursor).

**Constraints:**
- Cursor visibility depends on CLI agent version (Copilot 1.0.12+, Claude Code) using xterm's native cursor layer rather than rendering their own via ANSI escape sequences.

**Priority:** P1
**Dependencies:** REQ-TERM-002
**Verification:** Manual check
**Status:** Implemented

---

## REQ-MOB-009: Visibility return recovers keyboard state

**Applies To:** User

**Intent:** When the browser is backgrounded and returned to, keyboard state signals must be reset so the terminal functions correctly without manual intervention.

**Acceptance Criteria:**
1. On visibility return (Chrome), `restoreFocusIfNeeded()` calls `forceResetKeyboardState()` + `enableVirtualKeyboardOverlay()` BEFORE refocusing the input.
2. The `Layout.tsx` visibility handler calls `forceResetKeyboardState()` as a fallback for when focus restore does not fire.
3. `forceResetKeyboardState()` unconditionally zeros all signals (`keyboardHeight`, `vkOpen`, `viewportGrowth`) because `boundingRect.height` returns stale cached values on browser resume.
4. On Samsung, the dashboard bounce (REQ-MOB-003) replaces focus-based recovery.
5. On Samsung, `enableVirtualKeyboardOverlay()` is delayed by 300ms after visibility return so stale `geometrychange` events (arriving up to ~200ms after toggle) are caught by the 50ms ignore window.
6. `reconnectOnVisibilityReturn()` reconnects any dropped WebSockets after visibility return.

**Constraints:**
- `resetKeyboardStateIfStale()` is not used for visibility return because `boundingRect.height` is stale at that point.
- Chrome and Samsung paths are separate; Samsung requires full session deactivation/reactivation.

**Priority:** P1
**Dependencies:** REQ-MOB-002, REQ-MOB-003
**Verification:** Manual check
**Status:** Implemented

---

## REQ-MOB-010: FitAddon fit calls are coordinated

**Applies To:** User

**Intent:** Multiple code paths that trigger `fitAddon.fit()` must not conflict with each other or cause visual artifacts.

**Acceptance Criteria:**
1. Three code paths can trigger `fitAddon.fit()`: keyboard refit (debounced 150ms), active-state effect (immediate `requestAnimationFrame`), and ResizeObserver (immediate `requestAnimationFrame`).
2. A `kbDebounceTimer` variable (timer ID, not boolean) gates the ResizeObserver during keyboard refit. The ResizeObserver skips `fit()` when `kbDebounceTimer !== null`.
3. Mobile with keyboard open: `scrollToBottom()` is called after every `fit()`.
4. Desktop or mobile without keyboard: `isAtBottom()` is checked before `fit()`; scroll position is preserved for users scrolled into scrollback.
5. When keyboard is open, ResizeObserver does not call `scrollToBottom()` (the keyboard height change effect handles it).
6. `refitAllTerminals()` skips the resize WebSocket message if dimensions did not change.

**Constraints:**
- Using the timer ID (not a boolean flag) for `kbDebounceTimer` prevents a race condition where cleanup does not properly clear the gate.
- The write callback's `scrollToBottom()` is the single source of truth for bottom-anchoring during keyboard-open output.

**Priority:** P1
**Dependencies:** REQ-MOB-002, REQ-TERM-008
**Verification:** Automated test
**Status:** Implemented
