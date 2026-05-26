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

### REQ-MOB-001: Terminal fully usable on mobile devices

<!-- @impl: web-ui/src/lib/mobile.ts -->
<!-- @impl: web-ui/src/hooks/useTerminal.ts -->
<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts describe) -->
<!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-001 describe -> AC4, AC5, AC6) -->
<!-- @test: e2e/ui/mobile-specific.test.ts (Mobile-specific UI describe -> session-switcher mobile icon + bottom-sheet dropdown + mobile tap behavior, gated on IS_MOBILE viewport so the test confirms terminal renders + responds on the mobile viewport -> AC1) -->
<!-- @test: .github/workflows/e2e.yml (e2e-ui-mobile job runs the mobile-specific E2E suite against the deployed worker with E2E_MOBILE=1 -> AC3) -->

**Intent:** The terminal must be fully functional on phones and tablets, providing a usable coding experience without requiring a desktop browser.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal renders correctly on mobile viewports (phones and tablets).
2. Text input, command execution, and output display work identically to desktop except where touch interaction necessarily differs.
3. The mobile E2E test suite passes against the deployed worker.
4. The terminal adjusts layout when the virtual keyboard opens or closes without visual corruption.
5. Terminal dimensions are recalculated on viewport changes (keyboard open/close, orientation change, resize).
6. The terminal layout recalculation is skipped when the terminal container has no visible height, preventing row calculation corruption on inactive terminals.

**Constraints:**

- Mobile-specific code paths activate only on touch devices.
- Mobile keyboard and layout state is driven by browser events, not polling or timers.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented

---

### REQ-MOB-002: Virtual keyboard opens reliably on tap

<!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay -->
<!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay -->
<!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight -->
<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts describe -> enableVirtualKeyboardOverlay / disableVirtualKeyboardOverlay -> AC1, AC2; stale geometrychange ignore window -> AC1, AC3; baselineInnerHeight stability -> AC4; visualViewport fallback -> AC3) -->
<!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-002 describe -> AC1, AC2, AC3, AC4, AC6) -->

**Intent:** Tapping the terminal must reliably open the device's virtual keyboard, and the terminal must resize correctly to accommodate it.

**Applies To:** User

**Acceptance Criteria:**

1. The virtual keyboard overlay is activated before terminal focus to prevent keyboard/layout race conditions.
2. The overlay mode is disabled on terminal exit so other inputs receive normal browser resizing.
3. Keyboard height changes are detected via the browser's VirtualKeyboard geometry change event.
4. Terminal height is reduced by the keyboard height so content is not obscured.
5. An isolated compositor context prevents the Android IME native caret from appearing outside the terminal bounds.
6. Autocorrect is suppressed at the OS level on mobile.
7. Focus state detection uses a live browser query rather than a cached value.

**Constraints:**

- The overlay mode is only re-stamped on genuine state changes; redundant no-op toggles must not restart the stale-event ignore window.
- The stale-event ignore window applies only to genuine toggles.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** [Integration test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (stale geometrychange ignore window (Fix 2) describe -> ignores geometrychange within 50ms of enableVirtualKeyboardOverlay + accepts after 50ms grace -> AC1, AC2) -->
<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (getKeyboardHeight - Samsung compensation describe -> raw height when address bar at top + raw on wide screens -> AC3 Samsung bottom-bar viewport-inflation compensation) -->
<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (baselineInnerHeight stability on keyboard close describe -> consistent keyboard height across close/reopen cycles -> AC4 baseline immutable, AC5 not updated on keyboard close) -->
### REQ-MOB-003: Samsung Internet keyboard viewport state

<!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight -->

**Intent:** Samsung Internet's `geometrychange` event is unreliable (stale-event cache, viewport inflation from bottom nav bar). Viewport state must be filtered and compensated so the terminal lays out correctly under Samsung devices.

**Applies To:** User

**Acceptance Criteria:**

1. Stale keyboard-geometry events (cached from previous toggles) are ignored within a 50ms window after the overlay state actually changes.
2. The stale-event ignore window is only restamped on genuine overlay state changes; no-op calls do not restart it.
3. Samsung's bottom-navigation-bar viewport inflation is compensated so keyboard height is calculated correctly.
4. The pre-keyboard viewport height reference is immutable after initialization, except on Galaxy Fold screen-switch events (large delta with keyboard closed).
5. The pre-keyboard viewport height reference is never updated during keyboard close or any keyboard-state-reset path.

**Constraints:**

- Samsung Internet Browser requires a separate detection path.
- State recovery + UI configuration concerns live in [REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery).

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (forceResetKeyboardState describe -> unconditionally zeros keyboardHeight + vkOpen + viewportGrowth (used by Samsung focusout/dashboard-bounce/visibility recovery) -> AC1 Samsung focusout fallback, AC2 dashboard-bounce reset) -->
<!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (settings describe -> samsungAddressBarTop preference toggle wired to mobile.ts samsung-address-bar position -> AC3 user-settings toggle for address bar position) -->
### REQ-MOB-011: Samsung Internet keyboard state recovery

<!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState -->
<!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout keyboard dismiss describe -> AC1 back-button dismiss intercepted + keyboard-state signals reset) -->

**Intent:** Samsung's back-button dismiss and browser-resume paths leave the VirtualKeyboard compositor in stale states. State must be force-reset on those edges, and the user must be able to tell codeflare where Samsung's address bar sits (the API does not expose it).

**Applies To:** User

**Acceptance Criteria:**

1. Samsung's back-button keyboard dismiss is intercepted; all keyboard-state signals are reset on that event.
2. Samsung browser resume uses an automatic dashboard bounce (deactivate then reactivate the session after a brief delay) to reset the unreliable keyboard compositor state.
3. Samsung's address-bar position is configured via a user-settings toggle because no browser API exposes it.

**Constraints:**

- Samsung session re-initialisation requires a brief delay between deactivation and reactivation for cleanup effects to settle.
- Samsung input resume does not auto-focus the terminal; the keyboard stays closed until the user taps, to avoid stale keyboard-geometry events.

**Priority:** P1

**Dependencies:** [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** [Automated test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Notes:** Samsung Internet manual verification checklist lives in [documentation/lanes/mobile.md](../../documentation/lanes/mobile.md#samsung-internet-quirks).

**Status:** Implemented

---

### REQ-MOB-004: Scroll-drop detection during burst output

<!-- @impl: web-ui/src/stores/terminal.ts::flushWriteBuffer -->
<!-- @impl: web-ui/src/hooks/useTerminal.ts::isAtBottom -->
<!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-004 describe -> AC3, AC4, AC5) -->

**Intent:** The terminal viewport must not lose its scroll position when burst output trims the scrollback buffer or when the browser silently resets `ydisp` to 0 on focus changes.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal viewport disables native scrolling on all devices so xterm's own scroll layer is the sole scroller.
2. The browser's focus-scroll targets the cursor position at the bottom of the terminal, not the top-left origin.
3. A post-write scroll guard re-applies bottom alignment when the buffer's display offset drops below the base after a write.
4. A scroll-drop detector watches for sudden display-offset drops to zero while the base is high and corrects them.
5. Distance-based detection (rather than equality against zero) distinguishes browser focus resets from normal scrollback trimming; small drifts are ignored.

**Constraints:**

- Programmatic scroll corrections cannot recursively trigger the scroll-reset detector.
- Scrollback is limited to 1000 lines on both frontend and headless renderers; agent-side virtual scrolling is disabled.
- The keyboard-transition correction + user-anchoring behavior live in [REQ-MOB-012](#req-mob-012-scroll-anchoring-during-keyboard-transitions).

**Priority:** P0

**Dependencies:** [REQ-TERM-008](terminal.md#req-term-008-write-batching-at-30fps)

**Verification:** [Integration test](../../web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts)

**Status:** Implemented

---

### REQ-MOB-012: Scroll anchoring during keyboard transitions

<!-- @impl: web-ui/src/stores/terminal.ts::beginProgrammaticScroll -->
<!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-012 describe -> AC1, AC2, AC3, AC4) -->

**Intent:** Programmatic scroll corrections must not be misidentified by the scroll-reset detector, and the visible scroll anchor (bottom for following users, relative position for scrolled-up users) must be preserved across keyboard open/close and scrollback trimming.

**Applies To:** User

**Acceptance Criteria:**

1. Programmatic scroll corrections are bracketed by a suppression marker so the scroll-reset detector does not misidentify them.
2. When the keyboard is open, the scroll-reset detector is skipped (browser focus resets cannot occur while the keyboard is open).
3. Bottom-following users see zero flicker: correction is applied in the scroll-event handler before the canvas paints, not in the asynchronous write callback.
4. Users who have scrolled up have their relative position (distance from bottom) preserved across scrollback trimming.

**Constraints:**

- Recent user intent (wheel/pointerdown/keydown) is checked before forcing bottom-following users to the bottom.

**Priority:** P0

**Dependencies:** [REQ-MOB-004](#req-mob-004-scroll-drop-detection-during-burst-output)

**Verification:** [Integration test](../../web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures describe -> sendTerminalKey sequences via triggerDataEvent + attachSwipeGestures sends left/right arrows above threshold + repeat timer fires every 80ms + cleared on touchend + vertical swipe scrolls when keyboard closed + capture-phase listeners -> AC1, AC2, AC3, AC4, AC5) -->
### REQ-MOB-005: Swipe gestures send arrow keys or scroll

<!-- @impl: web-ui/src/lib/touch-gestures.ts -->

**Intent:** Horizontal swipe gestures simulate arrow key presses for command-line navigation, while vertical swipes scroll the terminal buffer when the keyboard is closed.

**Applies To:** User

**Acceptance Criteria:**

1. Horizontal swipe gestures (left/right) send arrow-key escape sequences to the terminal.
2. While the finger is held, arrow-key sends auto-repeat at roughly twelve times per second.
3. Touch event handlers are registered in capture phase to ensure cleanup runs before xterm's internal gesture handling.
4. The repeat is always cleared when the finger lifts or the touch is cancelled.
5. When the keyboard is closed, vertical swipes scroll the terminal buffer directly.
6. Scroll sensitivity scales with the terminal's font metrics so a swipe travels the same number of lines on different font sizes.
7. When the keyboard is open, vertical swipes do not scroll; horizontal swipes still send arrow keys.

**Constraints:**

- Touch scroll must use xterm's buffer-scroll API directly because the viewport does not support native scroll under the current xterm scroll layer.

**Priority:** P1

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/touch-gestures.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (resolveKeyAction Ctrl+C describe + Ctrl+V + other Ctrl+letter combos describes -> SIGINT (Ctrl+C = 0x03) + Ctrl+D = EOT (0x04) + Ctrl+L = FF (0x0c) + Ctrl+A = SOH (0x01) + Ctrl+Z = SUB (0x1a) -> AC3 common Ctrl sequences work) -->
<!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (resolveKeyAction describe -> returns none for regular character without Ctrl + functional keys resolve regardless of Ctrl state -> AC4 sticky single-use, AC5 no interference with normal input) -->
<!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (FloatingTerminalButtons describe -> Ctrl button rendered + Label Visibility + Conditional Rendering of mobile-only buttons -> AC1, AC2) -->
### REQ-MOB-006: Sticky Ctrl button for mobile

<!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx -->
<!-- @impl: web-ui/src/lib/terminal-mobile-input.ts -->

**Intent:** Mobile users can send Ctrl-modified key sequences (Ctrl+C, Ctrl+D, etc.) without a physical keyboard by using a persistent on-screen Ctrl button.

**Applies To:** User

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

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input describe -> uses Web Speech API (SpeechRecognition / webkitSpeechRecognition) + isSpeechSupported reflects availability + startListening calls recognition.start with continuous=false interimResults=false + onresult sends final text to callback + onresult ignores non-final/empty + onend resets state -> AC1, AC2, AC4, AC5) -->
<!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (Desktop Voice Button describe + Label Content describe -> mobile floating mic button + desktop bottom-right icon + Ctrl+Space title attribute hint -> AC3 mobile mic + desktop shortcut) -->
### REQ-MOB-007: Voice input via Web Speech API

<!-- @impl: web-ui/src/lib/speech-input.ts -->

**Intent:** Users can dictate text into the terminal using the device microphone, providing an alternative input method on mobile (and desktop).

**Applies To:** User

**Acceptance Criteria:**

1. Voice input uses the browser's Web Speech API where available.
2. Voice input is completely decoupled from the keyboard/iframe input system.
3. On mobile, a floating microphone button starts recognition. On desktop, a small mic icon and a `Ctrl+Space` keyboard shortcut toggle voice input.
4. Each activation captures one utterance; recognition auto-deactivates after the user pauses.
5. Final transcribed text is sent to the terminal as keyboard input.
6. The mic button is hidden on browsers that do not support the Web Speech API.

**Constraints:**

- Reliability over features: one utterance per activation, no interim results.
- The first-use permission-prompt pattern and IME composition compatibility live in [REQ-MOB-013](#req-mob-013-mobile-input-system-platform-compatibility).

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/speech-input.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input describe -> getMicPermissionState returns state from navigator.permissions.query for 'prompt'/'granted' + 'unknown' fallback when API throws -> AC1 caller can blur iframe before recognition.start when state is 'prompt') -->
### REQ-MOB-013: Mobile input-system platform compatibility

<!-- @impl: web-ui/src/lib/speech-input.ts -->
<!-- @impl: web-ui/src/lib/terminal-mobile-input.ts -->

**Intent:** Mobile browsers stack the virtual keyboard above the permission prompt and route swipe-typed text as IME composition events. The input system must blur the iframe before triggering permission prompts (so the user sees the prompt) and buffer composition events until commit (so swipe typing arrives as whole words).

**Applies To:** User

**Acceptance Criteria:**

1. On first use, when the microphone permission state requires a prompt, the iframe input is blurred (dismissing the keyboard) before requesting permission so the user can see the browser prompt.
2. The same blur-before-permission pattern applies to clipboard paste.
3. Swipe-typed text is buffered through the browser's IME composition events and sent only when the IME commits, so partial composition does not reach the terminal as individual keystrokes.

**Constraints:**

- Permission prompt handling is critical on mobile where the prompt appears behind the virtual keyboard if the iframe still holds focus.

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-007](#req-mob-007-voice-input-via-web-speech-api)

**Verification:** [Automated test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (extracted functions describe -> initializeTerminal creates Terminal with cursorBlink:true + cursorStyle:'bar' -> AC1 cursor enabled) -->
<!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (named constants describe -> DECTCEM_CURSOR_PARAM equals 25 so applyCursorVisibility only honors DECTCEM hide sequences (parameter 25) from the agent + does not hide in alternate buffer -> AC4 alternate-buffer guard) -->
### REQ-MOB-008: Cursor visible for all supported agents

<!-- @impl: web-ui/src/hooks/useTerminal.ts::applyCursorVisibility -->
<!-- @impl: web-ui/src/lib/terminal-config.ts -->

**Intent:** The terminal cursor must be visible and correctly rendered for all supported CLI agents (Claude Code, Copilot, etc.) without duplication or visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal cursor is enabled and displays as a blinking bar.
2. Cursor colors match the Codeflare theme palette.
3. No CSS rules hide the terminal cursor elements.
4. The cursor is not hidden in alternate buffer mode; only explicit DECTCEM hide sequences from the connected agent suppress it.
5. No double-cursor duplication occurs between the terminal's native cursor and the agent's ANSI cursor on supported agent versions.
6. The isolated compositor context for the Android IME caret remains in place as a precaution, separate from the terminal cursor layer.

**Constraints:**

- Cursor visibility depends on the agent version using the terminal's native cursor layer rather than rendering its own via ANSI sequences.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset describe -> calls forceResetKeyboardState on visibility return in terminal view -> AC2 document-visibility handler fallback) -->
<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (forceResetKeyboardState describe -> unconditionally zeros keyboardHeight + vkOpen + viewportGrowth (boundingRect.height returns stale cached values on browser resume) -> AC3 unconditional reset) -->
### REQ-MOB-009: Visibility return recovers keyboard state

<!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::restoreFocusIfNeeded -->
<!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState -->
<!-- @impl: web-ui/src/stores/terminal.ts::reconnectOnVisibilityReturn -->
<!-- @impl: web-ui/src/components/Layout.tsx -->
<!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset describe -> AC1/AC2/AC3 focus-restore + document-visibility fallback + unconditional reset) -->

**Intent:** When the browser is backgrounded and returned to, keyboard state signals must be reset so the terminal functions correctly without manual intervention.

**Applies To:** User

**Acceptance Criteria:**

1. On visibility return, focus restoration first resets all keyboard-state signals and re-enables the virtual-keyboard overlay before refocusing the input.
2. A document-visibility handler in the layout shell triggers the same keyboard-state reset as a fallback when focus-restore does not fire.
3. The keyboard-state reset is unconditional because cached browser geometry is stale on resume.
4. On Samsung, the dashboard bounce ([REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery)) replaces focus-based recovery.
5. On Samsung, the virtual-keyboard overlay re-enable is delayed enough on visibility return that stale browser keyboard-geometry events arrive inside the ignore window.
6. Any WebSockets dropped while the page was hidden are re-established on visibility return.

**Constraints:**

- Visibility-return recovery does not rely on cached browser geometry because it is stale at that point.
- Chrome and Samsung paths are separate; Samsung requires full session deactivation/reactivation.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Notes:** Visibility-return recovery is validated manually per the checklist in [documentation/lanes/mobile.md](../../documentation/lanes/mobile.md#visibility-return-reset).

**Status:** Implemented

---

### REQ-MOB-010: FitAddon fit calls are coordinated

<!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminals -->
<!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported -->
<!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts describe -> visualViewport resize/keyboard show-hide triggers terminal refit cadence) -->
<!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-010 describe -> AC1, AC2, AC3, AC4, AC5, AC6) -->

**Intent:** Multiple code paths that trigger terminal-fit recalculation must not conflict with each other or cause visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. Three code paths can trigger a terminal-fit recalculation: keyboard refit (debounced ~150ms), active-state effect (immediate next frame), and viewport resize observer (immediate next frame).
2. While a keyboard refit is in flight, the viewport resize observer is suppressed so the two paths do not contend.
3. With the keyboard open on mobile, the buffer scrolls to the bottom after every refit so new output remains visible.
4. Without the keyboard open (desktop or mobile), scroll-to-bottom only runs when the user was already at the bottom; scrollback position is preserved otherwise.
5. While the keyboard is open, the resize observer does not force scroll-to-bottom; the keyboard-height-change handler owns that.
6. A refit that produces unchanged dimensions does not send a resize message to the container.

**Constraints:**

- The keyboard-refit gate is implemented so cleanup cannot leave it stuck on after a cancelled refit.
- The write callback owns bottom-anchoring during keyboard-open output; no other path competes for that decision.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-TERM-008](terminal.md#req-term-008-write-batching-at-30fps)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented
