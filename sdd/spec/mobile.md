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

**Intent:** The terminal must be fully functional on phones and tablets, providing a usable coding experience without requiring a desktop browser.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal renders correctly on mobile viewports (phones and tablets). <!-- @impl: web-ui/src/lib/mobile.ts::isMobile --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (isMobile reflects mobile media query) --> <!-- @test: e2e/ui/mobile-specific.test.ts (session switcher renders + responds on mobile viewport) -->
2. Text input, command execution, and output display work identically to desktop except where touch interaction necessarily differs. <!-- coverage-gap: cross-cutting desktop-parity, no single source symbol --> <!-- coverage-gap: identical-to-desktop behavior is covered only by e2e/manual, no unit test -->
3. The mobile E2E test suite passes against the deployed worker. <!-- @impl: .github/workflows/e2e.yml --> <!-- @test: .github/workflows/e2e.yml (e2e-ui-mobile job runs the mobile E2E suite with E2E_MOBILE=1) -->
4. The terminal adjusts layout when the virtual keyboard opens or closes without visual corruption. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (keyboard-open layout adjust via the VirtualKeyboard geometry signal) -->
5. Terminal dimensions are recalculated on viewport changes (keyboard open/close, orientation change, resize). <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (viewport-change height recalculation) -->
6. The terminal layout recalculation is skipped when the terminal container has no visible height, preventing row calculation corruption on inactive terminals. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (no-visible-height skip: no fit/scroll/resize when clientHeight is 0) -->

**Constraints:**

- Mobile-specific code paths activate only on touch devices.
- Mobile keyboard and layout state is driven by browser events, not polling or timers.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented

---

### REQ-MOB-002: Virtual keyboard opens reliably on tap

**Intent:** Tapping the terminal must reliably open the device's virtual keyboard, and the terminal must resize correctly to accommodate it.

**Applies To:** User

**Acceptance Criteria:**

1. The virtual keyboard overlay is activated before terminal focus to prevent keyboard/layout race conditions. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (enableVirtualKeyboardOverlay sets overlaysContent before focus) --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (stale geometrychange ignored within 50ms of overlay enable) -->
2. The overlay mode is disabled on terminal exit so other inputs receive normal browser resizing. <!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (disableVirtualKeyboardOverlay restores normal resizing on exit) -->
3. Keyboard height changes are detected via the browser's VirtualKeyboard geometry change event. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (visualViewport fallback detects keyboard height) -->
4. Terminal height is reduced by the keyboard height so content is not obscured. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (baselineInnerHeight stays stable so keyboard height stays consistent) -->
5. An isolated compositor context prevents the Android IME native caret from appearing outside the terminal bounds. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: compositor-isolation iframe is a device/visual concern, no genuine unit test -->
6. Autocorrect is suppressed at the OS level on mobile. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: OS-level autocorrect suppression is a device/IME concern, no genuine unit test -->
7. Focus state detection uses a live browser query rather than a cached value. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (isFocusOnTerminalInput is a live focus query, not a cached value) -->

**Constraints:**

- The overlay mode is only re-stamped on genuine state changes; redundant no-op toggles must not restart the stale-event ignore window.
- The stale-event ignore window applies only to genuine toggles.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** [Integration test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented

---

### REQ-MOB-003: Samsung Internet keyboard viewport state

**Intent:** Samsung Internet's `geometrychange` event is unreliable (stale-event cache, viewport inflation from bottom nav bar). Viewport state must be filtered and compensated so the terminal lays out correctly under Samsung devices.

**Applies To:** User

**Acceptance Criteria:**

1. Stale keyboard-geometry events (cached from previous toggles) are ignored within a 50ms window after the overlay state actually changes. <!-- @impl: web-ui/src/lib/mobile.ts::resetKeyboardStateIfStale --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (ignores geometrychange within 50ms of overlay toggle) -->
2. The stale-event ignore window is only restamped on genuine overlay state changes; no-op calls do not restart it. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (no-op overlay toggle does not restamp the ignore window) -->
3. Samsung's bottom-navigation-bar viewport inflation is compensated so keyboard height is calculated correctly. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (Samsung bottom-bar inflation compensated in getKeyboardHeight) -->
4. The pre-keyboard viewport height reference is immutable after initialization, except on Galaxy Fold screen-switch events (large delta with keyboard closed). <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (consistent keyboard height across close/reopen cycles) -->
5. The pre-keyboard viewport height reference is never updated during keyboard close or any keyboard-state-reset path. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (baseline not updated during keyboard close) -->

**Constraints:**

- Samsung Internet Browser requires a separate detection path.
- State recovery + UI configuration concerns live in [REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery).

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx)

**Status:** Implemented

---

### REQ-MOB-004: Scroll-drop detection during burst output

**Intent:** The terminal viewport must not lose its scroll position when burst output trims the scrollback buffer or when the browser silently resets `ydisp` to 0 on focus changes.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal viewport disables native scrolling on all devices so xterm's own scroll layer is the sole scroller. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- coverage-gap: native-scroll-disabled is a CSS/xterm-layer concern, no genuine unit test -->
2. The browser's focus-scroll targets the cursor position at the bottom of the terminal, not the top-left origin. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- coverage-gap: focus-scroll-to-cursor is a browser-behavior concern, no genuine unit test -->
3. A post-write scroll guard re-applies bottom alignment when the buffer's display offset drops below the base after a write. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (re-anchors a bottom-following terminal when scrollback trimming displaces it — drives the real onScroll handler and asserts the restored relative position) -->
4. A scroll-drop detector watches for sudden display-offset drops to zero while the base is high and corrects them. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (scroll-drop-to-zero focus-reset detection restores relative position) -->
5. Distance-based detection (rather than equality against zero) distinguishes browser focus resets from normal scrollback trimming; small drifts are ignored. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (small distance drift ignored — normal trimming, not a reset) -->

**Constraints:**

- Programmatic scroll corrections cannot recursively trigger the scroll-reset detector.
- Scrollback is limited to 1000 lines on both frontend and headless renderers; agent-side virtual scrolling is disabled.
- The keyboard-transition correction + user-anchoring behavior live in [REQ-MOB-012](#req-mob-012-scroll-anchoring-during-keyboard-transitions).

**Priority:** P0

**Dependencies:** [REQ-TERM-008](terminal.md#req-term-008-write-batching-at-30fps)

**Verification:** [Integration test](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts)

**Status:** Implemented

---

### REQ-MOB-005: Swipe gestures send arrow keys or scroll

**Intent:** Horizontal swipe gestures simulate arrow key presses for command-line navigation, while vertical swipes scroll the terminal buffer when the keyboard is closed.

**Applies To:** User

**Acceptance Criteria:**

1. Horizontal swipe gestures (left/right) send arrow-key escape sequences to the terminal. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (left/right swipe above threshold sends arrow escape sequences) -->
2. While the finger is held, arrow-key sends auto-repeat at roughly twelve times per second. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (held swipe auto-repeats arrow key on a timer) -->
3. Touch event handlers are registered in capture phase to ensure cleanup runs before xterm's internal gesture handling. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (attachSwipeGestures returns a cleanup function when touch supported) -->
4. The repeat is always cleared when the finger lifts or the touch is cancelled. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (repeat timer cleared on touchend / long-press cancel) -->
5. When the keyboard is closed, vertical swipes scroll the terminal buffer directly. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (vertical swipe scrolls buffer when keyboard closed) -->
6. Scroll sensitivity scales with the terminal's font metrics so a swipe travels the same number of lines on different font sizes. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (scroll distance scales proportionally to finger movement) -->
7. When the keyboard is open, vertical swipes do not scroll; horizontal swipes still send arrow keys. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (keyboard open: vertical swipe sends arrows instead of scrolling) -->

**Constraints:**

- Touch scroll must use xterm's buffer-scroll API directly because the viewport does not support native scroll under the current xterm scroll layer.

**Priority:** P1

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/touch-gestures.test.ts)

**Status:** Implemented

---

### REQ-MOB-006: Sticky Ctrl button for mobile

**Intent:** Mobile users can send Ctrl-modified key sequences (Ctrl+C, Ctrl+D, etc.) without a physical keyboard by using a persistent on-screen Ctrl button.

**Applies To:** User

**Acceptance Criteria:**

1. A floating Ctrl button is visible on mobile when the terminal is active. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (Ctrl button rendered only on mobile when terminal active) -->
2. Tapping the Ctrl button enters a "sticky" state where the next key press is sent as a Ctrl-modified sequence. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::activateStickyCtrl --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (activateStickyCtrl enters sticky state) -->
3. Common sequences (Ctrl+C for interrupt, Ctrl+D for EOF) work correctly via the sticky Ctrl mechanism. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::resolveKeyAction --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (Ctrl+C/D/L/A/Z resolve to SIGINT/EOT/FF/SOH/SUB bytes) -->
4. The Ctrl button state resets after one modified key press (single-use sticky behavior). <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::deactivateStickyCtrl --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (deactivateStickyCtrl single-use reset of the sticky callback) -->
5. The Ctrl button does not interfere with normal text input when not activated. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::resolveKeyAction --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (regular keys return none without Ctrl) -->

**Constraints:**

- The button must be positioned to avoid overlapping with the virtual keyboard or terminal content.
- The button is part of the floating button UI layer alongside other mobile controls.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx)

**Status:** Implemented

---

### REQ-MOB-007: Voice input via Web Speech API

**Intent:** Users can dictate text into the terminal using the device microphone, providing an alternative input method on mobile (and desktop).

**Applies To:** User

**Acceptance Criteria:**

1. Voice input uses the browser's Web Speech API where available. <!-- @impl: web-ui/src/lib/speech-input.ts::isSpeechSupported --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (isSpeechSupported reflects SpeechRecognition availability) -->
2. Voice input is completely decoupled from the keyboard/iframe input system. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (startListening calls recognition.start decoupled from keyboard) -->
3. On mobile, a floating microphone button starts recognition. On desktop, a small mic icon and a `Ctrl+Space` keyboard shortcut toggle voice input. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (mobile mic button + desktop mic button gated on touch/speech support) -->
4. Each activation captures one utterance; recognition auto-deactivates after the user pauses. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (onend resets listening state after one utterance) -->
5. Final transcribed text is sent to the terminal as keyboard input. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (onresult sends final text to callback; ignores interim/empty) -->
6. The mic button is hidden on browsers that do not support the Web Speech API. <!-- @impl: web-ui/src/lib/speech-input.ts::isSpeechSupported --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (mic button hidden when speech unsupported) -->

**Constraints:**

- Reliability over features: one utterance per activation, no interim results.
- The first-use permission-prompt pattern and IME composition compatibility live in [REQ-MOB-013](#req-mob-013-mobile-input-system-platform-compatibility).

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/speech-input.test.ts)

**Status:** Implemented

---

### REQ-MOB-008: Cursor visible for all supported agents

**Intent:** The terminal cursor must be visible and correctly rendered for all supported CLI agents (Claude Code, Copilot, etc.) without duplication or visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal cursor is enabled and displays as a blinking bar. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (initializeTerminal sets cursorBlink:true + cursorStyle:bar) -->
2. Cursor colors match the Codeflare theme palette. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- coverage-gap: cursor-color palette match is a visual concern, no genuine unit test -->
3. No CSS rules hide the terminal cursor elements. <!-- @impl: web-ui/src/styles/terminal.css --> <!-- coverage-gap: no-CSS-hides-cursor is a CSS assertion, no genuine unit test -->
4. The cursor is not hidden in alternate buffer mode; only explicit DECTCEM hide sequences from the connected agent suppress it. <!-- @impl: web-ui/src/hooks/useTerminal.ts::DECTCEM_CURSOR_PARAM --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (DECTCEM_CURSOR_PARAM=25: only param-25 hide honored, not alternate buffer) -->
5. No double-cursor duplication occurs between the terminal's native cursor and the agent's ANSI cursor on supported agent versions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- coverage-gap: double-cursor duplication is a visual concern, no genuine unit test -->
6. The isolated compositor context for the Android IME caret remains in place as a precaution, separate from the terminal cursor layer. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: compositor-isolation precaution is a device/visual concern, no genuine unit test -->

**Constraints:**

- Cursor visibility depends on the agent version using the terminal's native cursor layer rather than rendering its own via ANSI sequences.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** [Automated test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Status:** Implemented

---

### REQ-MOB-009: Visibility return recovers keyboard state

**Intent:** When the browser is backgrounded and returned to, keyboard state signals must be reset so the terminal functions correctly without manual intervention.

**Applies To:** User

**Acceptance Criteria:**

1. On visibility return, focus restoration first resets all keyboard-state signals and re-enables the virtual-keyboard overlay before refocusing the input. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: the focus-restore reset+overlay sequence runs inside the restoreFocusIfNeeded closure reachable only after the off-screen iframe srcdoc fires its load event; jsdom does not load iframe srcdoc, so the branch is unreachable in unit tests (Playwright/device territory) -->
2. A document-visibility handler in the layout shell triggers the same keyboard-state reset as a fallback when focus-restore does not fire. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (visibility return in terminal view calls forceResetKeyboardState) -->
3. The keyboard-state reset is unconditional because cached browser geometry is stale on resume. <!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (forceResetKeyboardState unconditionally zeros keyboard signals) -->
4. On Samsung, the dashboard bounce ([REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery)) replaces focus-based recovery. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Samsung bounces through dashboard on visibility return) -->
5. On Samsung, the virtual-keyboard overlay re-enable is delayed enough on visibility return that stale browser keyboard-geometry events arrive inside the ignore window. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: Samsung delayed overlay re-enable timing is a device-timing concern, no genuine unit test -->
6. Any WebSockets dropped while the page was hidden are re-established on visibility return. <!-- @impl: web-ui/src/stores/terminal.ts::reconnectOnVisibilityReturn --> <!-- coverage-gap: WebSocket re-establish on visibility return is covered under REQ-TERM, no MOB test isolates it -->

**Notes:** Visibility-return recovery is validated manually per the checklist in [documentation/lanes/mobile.md](../../documentation/lanes/mobile.md#visibility-return-reset).

**Constraints:**

- Visibility-return recovery does not rely on cached browser geometry because it is stale at that point.
- Chrome and Samsung paths are separate; Samsung requires full session deactivation/reactivation.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-MOB-010: FitAddon fit calls are coordinated

**Intent:** Multiple code paths that trigger terminal-fit recalculation must not conflict with each other or cause visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. Three code paths can trigger a terminal-fit recalculation: keyboard refit (debounced ~150ms), active-state effect (immediate next frame), and viewport resize observer (immediate next frame). <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (the three fit paths: keyboard-refit, active-state, ResizeObserver) -->
2. While a keyboard refit is in flight, the viewport resize observer is suppressed so the two paths do not contend. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (ResizeObserver skips fit while keyboard refit debounce is pending) -->
3. With the keyboard open on mobile, the buffer scrolls to the bottom after every refit so new output remains visible. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (keyboard open: scrolls to bottom after refit) -->
4. Without the keyboard open (desktop or mobile), scroll-to-bottom only runs when the user was already at the bottom; scrollback position is preserved otherwise. <!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (keyboard close: does not scroll to bottom) -->
5. While the keyboard is open, the resize observer does not force scroll-to-bottom; the keyboard-height-change handler owns that. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (ResizeObserver does not force scroll-to-bottom while keyboard open) -->
6. A refit that produces unchanged dimensions does not send a resize message to the container. <!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported --> <!-- @test: web-ui/src/__tests__/stores/terminal-layout.test.ts (refitAllTerminals sends a resize message only on changed dimensions) -->

**Constraints:**

- The keyboard-refit gate is implemented so cleanup cannot leave it stuck on after a cancelled refit.
- The write callback owns bottom-anchoring during keyboard-open output; no other path competes for that decision.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-TERM-008](terminal.md#req-term-008-write-batching-at-30fps)

**Verification:** [Automated test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Status:** Implemented

---

### REQ-MOB-011: Samsung Internet keyboard state recovery

**Intent:** Samsung's back-button dismiss and browser-resume paths leave the VirtualKeyboard compositor in stale states. State must be force-reset on those edges, and the user must be able to tell codeflare where Samsung's address bar sits (the API does not expose it).

**Applies To:** User

**Acceptance Criteria:**

1. Samsung's back-button keyboard dismiss is intercepted; all keyboard-state signals are reset on that event. <!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout back-button dismiss calls forceResetKeyboardState) -->
2. Samsung browser resume uses an automatic dashboard bounce (deactivate then reactivate the session after a brief delay) to reset the unreliable keyboard compositor state. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- coverage-gap: Samsung dashboard-bounce on resume is validated manually per the lane checklist -->
3. Samsung's address-bar position is configured via a user-settings toggle because no browser API exposes it. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (Samsung address-bar toggle shown + persisted for Samsung browser) -->

**Notes:** Samsung Internet manual verification checklist lives in [documentation/lanes/mobile.md](../../documentation/lanes/mobile.md#samsung-internet-quirks).

**Constraints:**

- Samsung session re-initialisation requires a brief delay between deactivation and reactivation for cleanup effects to settle.
- Samsung input resume does not auto-focus the terminal; the keyboard stays closed until the user taps, to avoid stale keyboard-geometry events.

**Priority:** P1

**Dependencies:** [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** [Automated test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Status:** Implemented

---

### REQ-MOB-012: Scroll anchoring during keyboard transitions

**Intent:** Programmatic scroll corrections must not be misidentified by the scroll-reset detector, and the visible scroll anchor (bottom for following users, relative position for scrolled-up users) must be preserved across keyboard open/close and scrollback trimming.

**Applies To:** User

**Acceptance Criteria:**

1. Programmatic scroll corrections are bracketed by a suppression marker so the scroll-reset detector does not misidentify them. <!-- @impl: web-ui/src/stores/terminal.ts::isProgrammaticScrollSuppressed --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (correction skipped while the programmatic-scroll suppression marker is set) -->
2. When the keyboard is open, the scroll-reset detector is skipped (browser focus resets cannot occur while the keyboard is open). <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (touch+keyboard gate suppresses the Strategy-2 reset-restore) -->
3. Bottom-following users see zero flicker: correction is applied in the scroll-event handler before the canvas paints, not in the asynchronous write callback. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (re-anchors a bottom-following terminal in the scroll-event handler) -->
4. Users who have scrolled up have their relative position (distance from bottom) preserved across scrollback trimming. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (does not override deliberate user scroll gestures, preserving position) -->

**Constraints:**

- Recent user intent (wheel/pointerdown/keydown) is checked before forcing bottom-following users to the bottom.

**Priority:** P0

**Dependencies:** [REQ-MOB-004](#req-mob-004-scroll-drop-detection-during-burst-output)

**Verification:** [Integration test](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts)

**Status:** Implemented

---

### REQ-MOB-013: Mobile input-system platform compatibility

**Intent:** Mobile browsers stack the virtual keyboard above the permission prompt and route swipe-typed text as IME composition events. The input system must blur the iframe before triggering permission prompts (so the user sees the prompt) and buffer composition events until commit (so swipe typing arrives as whole words).

**Applies To:** User

**Acceptance Criteria:**

1. On first use, when the microphone permission state requires a prompt, the iframe input is blurred (dismissing the keyboard) before requesting permission so the user can see the browser prompt. <!-- @impl: web-ui/src/lib/speech-input.ts::getMicPermissionState --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (getMicPermissionState returns Permissions API state so caller can blur before prompt) -->
2. The same blur-before-permission pattern applies to clipboard paste. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: blur-before-clipboard-paste is a mobile-IME concern, no genuine unit test -->
3. Swipe-typed text is buffered through the browser's IME composition events and sent only when the IME commits, so partial composition does not reach the terminal as individual keystrokes. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- coverage-gap: IME composition buffering is a device/IME concern, no genuine unit test -->

**Constraints:**

- Permission prompt handling is critical on mobile where the prompt appears behind the virtual keyboard if the iframe still holds focus.

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-007](#req-mob-007-voice-input-via-web-speech-api)

**Verification:** [Automated test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Status:** Implemented

---

### REQ-MOB-014: Mobile background-surface focus isolation

**Intent:** Hidden same-origin surfaces must not steal focus from an active mobile terminal.

**Applies To:** User

**Acceptance Criteria:**

1. Background same-origin surfaces that run while the keyboard is open do not blur the terminal input or dismiss the keyboard. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (prewarm stays eager while terminal input is focused) -->
2. Vault browser prewarm remains eager but uses a focus-inert hidden document. <!-- @impl: src/routes/vault-html.ts::injectVaultPrewarmFocusGuard --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (vault prewarm shell ships a focus-inert hidden document) -->
3. If a hidden iframe captures focus, the terminal/input focus is restored. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (restores prior focus if hidden iframe captures parent focus) -->

**Constraints:**

- Background prewarm remains eager while the keyboard is open.

**Priority:** P0

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** [Vault prewarm test](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [Vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts)

**Status:** Implemented

---

### REQ-MOB-015: Virtual keyboard persists across terminal pane focus handoff

**Intent:** On touch devices the virtual-keyboard mode (locked/anchored layout, swipe-as-arrows, keyboard-height padding) is driven by a single shared signal. When several terminal panes are visible at once (tiling layouts, tablet MultiView) and focus moves between panes while the keyboard is open, the keyboard must stay open and the newly focused pane must keep keyboard mode without the user dismissing and reopening the keyboard. The shared keyboard state is torn down only when focus leaves the terminal, not on a pane-to-pane handoff.

**Applies To:** User

**Acceptance Criteria:**

1. A live focus query reports whether browser focus currently rests on a terminal input surface; it is the single discriminator used by every per-pane keyboard-teardown site. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (isFocusOnTerminalInput reports live focus on a terminal input surface) -->
2. When a terminal pane loses focus to a sibling terminal pane, the per-pane focus-loss cleanup does not disable the keyboard overlay or zero the keyboard signals, so the newly focused pane stays in keyboard mode. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::releaseKeyboardOnBlur --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (keeps shared keyboard state on pane-to-pane handoff) --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (releaseKeyboardOnBlur keeps overlay when focus moved to sibling pane) -->
3. A Samsung back-button keyboard dismiss still zeroes keyboard state, but a pane-to-pane focus handoff does not. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout does NOT forceReset on sibling-pane handoff) -->
4. When focus leaves all terminal surfaces (a non-terminal element gains focus, or the terminal unmounts) the shared keyboard overlay and signals are released. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (tears down shared keyboard state when focus leaves the terminal entirely) -->

**Constraints:**

- The discriminator reads live focus state, never a cached value.
- The exit/unmount teardown path stays unconditional so overlay mode is never left enabled for subsequent non-terminal inputs.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-009](#req-mob-009-visibility-return-recovers-keyboard-state)

**Verification:** [Mobile keyboard test](../../web-ui/src/__tests__/lib/mobile.test.ts), [useTerminal hook test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts)

**Status:** Implemented
