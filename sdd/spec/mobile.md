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

1. The terminal renders correctly on mobile viewports (phones and tablets). <!-- @impl: web-ui/src/lib/mobile.ts::isMobile --> <!-- @manual: Open the deployed terminal at phone and tablet viewport widths and confirm xterm renders without clipping or overflow. -->
2. Text input, command execution, and output display work identically to desktop except where touch interaction necessarily differs. <!-- @manual -->
3. On the deployed worker, a user can open a terminal, enter and execute a command, observe its output, and navigate scrollback at supported phone and tablet viewport widths. <!-- @manual: On the deployed worker at supported phone and tablet viewport widths, open a terminal, execute a command that emits multiple screens of output, confirm the output renders, and navigate its scrollback. -->
4. Terminal dimensions are recalculated on every viewport change (virtual keyboard open/close, orientation change, resize), keeping the layout free of visual corruption. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-001 AC4: visualViewport resize event triggers keyboard state update (fallback path)) -->
5. The terminal layout recalculation is skipped when the terminal container has no visible height, preventing row calculation corruption on inactive terminals. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-001 AC5: skips the keyboard refit (no fit, no PTY resize) when the container has zero visible height) --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-001 AC5: skips the deferred font-ready refit when the container has zero visible height) -->
6. Floating page controls navigate normal terminal scrollback through xterm's buffer scroll pipeline with buffer-derived deltas. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-MOB-001 AC6: navigates normal-buffer pages through the buffer scroll pipeline) -->
7. Floating page controls send PageUp/PageDown input to navigate alternate-screen application history. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-MOB-001 AC7: sends PageUp and PageDown to an alternate-screen application) -->

**Constraints:**

- Mobile-specific code paths activate only on touch devices.
- Mobile keyboard and layout state is driven by browser events, not polling or timers.

**Priority:** P0

**Dependencies:** [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([Mobile behavior](../../web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts), [terminal lifecycle](../../web-ui/src/__tests__/hooks/useTerminal.test.ts), [page controls](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx)); deployed phone and tablet interaction verified manually

**Status:** Implemented

---

### REQ-MOB-002: Virtual keyboard opens reliably on tap

**Intent:** Tapping the terminal must reliably open the device's virtual keyboard, and the terminal must resize correctly to accommodate it.

**Applies To:** User

**Acceptance Criteria:**

1. The virtual keyboard overlay is activated before terminal focus to prevent keyboard/layout race conditions. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
2. The overlay mode is disabled on terminal exit so other inputs receive normal browser resizing. <!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
3. Keyboard height changes are detected via the browser's VirtualKeyboard geometry change event. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
4. Terminal height is reduced by the keyboard height so content is not obscured. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
5. Focus state detection uses a live browser query rather than a cached value. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
6. Terminal touch events cannot reach document listeners; outside touches remain unchanged, and cleanup removes the propagation shield. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->

**Constraints:**

- The overlay mode is only re-stamped on genuine state changes; redundant no-op toggles must not restart the stale-event ignore window.
- The stale-event ignore window applies only to genuine toggles.
- The touch-propagation shield must run in bubble phase so the capture-phase swipe/scroll handlers ([REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll)) always execute first; `stopPropagation` (never `preventDefault`) is required so the browser's tap→click synthesis keeps working.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** Automated test ([Integration test](../../web-ui/src/__tests__/lib/mobile.test.ts))

**Status:** Implemented

---

### REQ-MOB-016: Mobile Terminal Input Compositor and Autocorrect Controls

**Intent:** Mobile terminal input must suppress native browser/IME behaviours that interfere with terminal typing while preserving the terminal's own gesture handling.

**Applies To:** User

**Acceptance Criteria:**

1. An isolated compositor context prevents the Android IME native caret from appearing outside the terminal bounds. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->
2. Autocorrect is suppressed at the OS level on mobile. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-016 AC2: swaps a textarea created during terminal.open() for a password input and restores createElement afterward) -->

**Constraints:**

- The compositor isolation and autocorrect suppression are device/IME behaviours; visual/device verification is valid when no genuine unit-test seam exists.

**Priority:** P0

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-003: Samsung Internet keyboard viewport state

**Intent:** Samsung Internet's `geometrychange` event is unreliable (stale-event cache, viewport inflation from bottom nav bar). Viewport state must be filtered and compensated so the terminal lays out correctly under Samsung devices.

**Applies To:** User

**Acceptance Criteria:**

1. Stale keyboard-geometry events (cached from previous toggles) are ignored within a 50ms window after the overlay state actually changes. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
2. The stale-event ignore window is only restamped on genuine overlay state changes; no-op calls do not restart it. <!-- @impl: web-ui/src/lib/mobile.ts::enableVirtualKeyboardOverlay --> <!-- @impl: web-ui/src/lib/mobile.ts::disableVirtualKeyboardOverlay --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
3. Samsung's bottom-navigation-bar viewport inflation is compensated so keyboard height is calculated correctly. <!-- @impl: web-ui/src/lib/mobile.ts::getKeyboardHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (getKeyboardHeight - Samsung compensation / REQ-MOB-003 (Samsung keyboard viewport state)) -->
4. The pre-keyboard viewport height reference is immutable after initialization, except on Galaxy Fold screen-switch events (large delta with keyboard closed). <!-- @impl: web-ui/src/lib/mobile.ts::baselineInnerHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->
5. The pre-keyboard viewport height reference is never updated during keyboard close or any keyboard-state-reset path. <!-- @impl: web-ui/src/lib/mobile.ts::baselineInnerHeight --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (mobile.ts / REQ-MOB-002 (virtual keyboard opens reliably on tap) / REQ-MOB-001 (mobile detection + visualViewport handling) / REQ-MOB-010 (visualViewport resize triggers terminal refit cadence)) -->

**Constraints:**

- Samsung Internet Browser requires a separate detection path.
- State recovery + UI configuration concerns live in [REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery).

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([SettingsPanel](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx))

**Status:** Implemented

---

### REQ-MOB-004: Scroll-drop detection during burst output

**Intent:** Burst output must preserve explicit terminal viewport ownership without treating xterm's normal full-buffer trimming as a browser reset.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal viewport disables native scrolling on all devices so xterm's own scroll layer is the sole scroller. <!-- @impl: web-ui/src/styles/terminal.css::.xterm .xterm-viewport --> <!-- @test: web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts (REQ-MOB-004 AC1: the terminal stylesheet disables native scrolling on the xterm viewport) --> <!-- @manual -->
2. Manual scroll intent transfers viewport ownership to the user, and that ownership persists until the viewport reaches the live bottom rather than expiring on a timer. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014 AC2: manual scroll ownership persists when output trimming reaches zero) -->
3. A bottom-following scroll-event guard re-applies bottom alignment before paint and yields when the user owns the viewport. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-TERM-014: re-anchors a bottom-following terminal when scrollback trimming displaces it) -->
4. Streamed output is deferred while the user owns the viewport, so trimming never moves the owned viewport and no synthetic restoration or bottom snap is injected. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: defers streamed output while the user owns the viewport and flushes on bottom return) -->
5. Ordinary trim shifts, including shallow movement to the oldest available line, are not corrected while the user owns the viewport. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-004 AC4/AC5: keeps a shallow manually owned viewport at top when viewed lines age out) -->

**Constraints:**

- Post-write handling cannot override xterm's native anchor, including when it reaches zero.
- Frontend xterm scrollback is limited to 5000 lines, and agent-side virtual scrolling is disabled. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (scrollback: 5000) -->
- The host headless renderer retains 1000 lines. <!-- @impl: host/src/session.ts::Session -->
- Output deferral and its held-output cap are specified in [REQ-TERM-014](terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming) AC3.
- The keyboard-transition correction + user-anchoring behavior live in [REQ-MOB-012](#req-mob-012-scroll-anchoring-during-keyboard-transitions).

**Priority:** P0

**Dependencies:** [REQ-TERM-008](terminal.md#req-term-008-write-batching-at-30fps), [REQ-TERM-014](terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)

**Verification:** Automated test ([Scroll-ownership tests](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts), [full-buffer deferral tests](../../web-ui/src/__tests__/stores/terminal.test.ts), [stylesheet contract test](../../web-ui/src/__tests__/lib/mobile-ac-coverage.test.ts))

**Status:** Implemented

---

### REQ-MOB-005: Swipe gestures send arrow keys or scroll

**Intent:** Horizontal swipes provide command-line navigation, while vertical swipes scroll either terminal scrollback or the active fullscreen application.

**Applies To:** User

**Acceptance Criteria:**

1. Horizontal swipe gestures (left/right) send arrow-key escape sequences to the terminal. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
2. While the finger is held, arrow-key sends auto-repeat at roughly twelve times per second. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
3. Touch event handlers are registered in capture phase to ensure cleanup runs before xterm's internal gesture handling. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
4. The repeat is always cleared when the finger lifts or the touch is cancelled. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (touch-gestures / REQ-MOB-005 (swipe gestures arrow keys/scroll)) -->
5. When the keyboard is closed and terminal scrollback is active, vertical swipes scroll that buffer directly. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (scrolls the buffer on vertical swipe when keyboard is closed) -->
6. Scroll sensitivity scales with the terminal's font metrics so a swipe travels the same number of lines on different font sizes. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (should scroll proportionally to finger movement including threshold distance) -->
7. When the keyboard is open, vertical swipes send arrow keys while horizontal swipes remain available, regardless of any fullscreen application wheel capture. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-005 AC7: keyboard-open vertical swipes send arrow keys even under fullscreen wheel tracking) -->

**Constraints:**

- Normal scrollback uses xterm's buffer service directly ([REQ-TERM-014](terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)).
- Classic alternate-screen scrolling uses xterm's public DOM wheel pipeline with inertia; Herdr uses proportional wheel steps without inertia.

**Priority:** P1

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([touch-gestures](../../web-ui/src/__tests__/lib/touch-gestures.test.ts))

**Status:** Implemented

---

### REQ-MOB-017: Fullscreen application touch scrolling

**Intent:** Keyboard-closed vertical swipes navigate application-owned history when a fullscreen terminal program uses the alternate buffer, preserving mobile access to conversations that do not use terminal scrollback.

**Applies To:** User

**Acceptance Criteria:**

1. With the keyboard closed, vertical swipes navigate a fullscreen application's alternate-buffer history. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC1-AC2: routes proportional Herdr wheel steps without inertia) --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC3: preserves classic fullscreen wheel forwarding) -->
2. A keyboard-closed Herdr swipe emits proportional wheel steps from accumulated finger distance and stops when the finger lifts. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC1-AC2: routes proportional Herdr wheel steps without inertia) -->
3. Classic preserves its existing fullscreen wheel forwarding. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-017 AC3: preserves classic fullscreen wheel forwarding) -->

**Constraints:**

- Normal scrollback remains owned by [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll).
- While the keyboard is open, vertical swipes remain terminal input ([REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll) AC7); wheel routing never applies.

**Priority:** P1

**Dependencies:** [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated gesture routing tests.

**Status:** Implemented

---

### REQ-MOB-020: Terminal touch activation

**Intent:** A mobile tap activates one terminal control without duplicate activation or changes to Classic tap behavior.

**Applies To:** User

**Acceptance Criteria:**

1. A stationary single-finger Herdr tap activates the control at the touched location exactly once. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::sendHerdrTap --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC1: forwards one deterministic tap and suppresses compatibility mouse events) --> <!-- @test: web-ui/src/__tests__/lib/herdr-mouse.test.ts (sends a touch tap as one press/release pair at one computed cell) -->
2. A touch that becomes a movement gesture does not activate a control. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC2: does not activate a tap after movement) -->
3. A cancelled touch does not activate a control. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC3: does not activate a tap after cancellation) -->
4. Classic stationary tap behavior remains unchanged. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC4: preserves the Classic stationary tap path without a synthetic mouse sequence) -->
5. A stationary Herdr tap opens mobile input when the keyboard is closed. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::focusMobileTerminal --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (wires a trusted touch tap to same-cell SGR input before mobile focus) --> <!-- @manual: On Samsung Internet with the keyboard closed, tap Pi input and confirm the keyboard opens. -->
6. A stationary Herdr tap remains usable while the keyboard is open. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (REQ-MOB-020 AC6: forwards a keyboard-open tap through sub-threshold jitter) --> <!-- @manual: On Samsung Internet with the keyboard open, tap Pi input and Herdr controls and confirm each activates once without selection. -->

**Constraints:** Long press and multi-touch do not activate the addressed control.

**Priority:** P1

**Dependencies:** [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated gesture and duplicate-suppression tests plus manual Samsung Internet tap verification.

**Status:** Implemented

---

### REQ-MOB-006: Sticky Ctrl button for mobile

**Intent:** Mobile users can send Ctrl-modified key sequences (Ctrl+C, Ctrl+D, etc.) without a physical keyboard by using a persistent on-screen Ctrl button.

**Applies To:** User

**Acceptance Criteria:**

1. A floating Ctrl button is visible on mobile when the terminal keyboard is open. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (FloatingTerminalButtons / REQ-MOB-006 (sticky Ctrl button)) -->
2. Tapping the Ctrl button enters a "sticky" state where the next key press is sent as a Ctrl-modified sequence. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::activateStickyCtrl --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)) -->
3. Common sequences (Ctrl+C for interrupt, Ctrl+D for EOF) work correctly via the sticky Ctrl mechanism. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::resolveKeyAction --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (returns SIGINT sequence (Ctrl+C = 0x03) when no selection) -->
4. The Ctrl button state resets after one modified key press (single-use sticky behavior). <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::deactivateStickyCtrl --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)) -->
5. The Ctrl button does not interfere with normal text input when not activated. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::resolveKeyAction --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (sticky Ctrl / REQ-MOB-006 (sticky Ctrl button state machine)) -->

**Constraints:**

- The button must be positioned to avoid overlapping with the virtual keyboard or terminal content.
- The button is part of the floating button UI layer alongside other mobile controls.

**Priority:** P0

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([FloatingTerminalButtons](../../web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx))

**Status:** Implemented

---

### REQ-MOB-007: Voice input via Web Speech API

**Intent:** Users can dictate text into the terminal using the device microphone, providing an alternative input method on mobile (and desktop).

**Applies To:** User

**Acceptance Criteria:**

1. Voice input uses the browser's Web Speech API where available. <!-- @impl: web-ui/src/lib/speech-input.ts::isSpeechSupported --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input / REQ-MOB-007 (voice input via Web Speech API)) -->
2. Voice input is completely decoupled from the keyboard/iframe input system. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input / REQ-MOB-007 (voice input via Web Speech API)) -->
3. On mobile, a floating microphone button starts recognition. On desktop, a small mic icon and a `Ctrl+Space` keyboard shortcut toggle voice input. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (renders desktop mic button when not touch device and speech supported) -->
4. Each activation captures one utterance; recognition auto-deactivates after the user pauses. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (onerror resets listening state and calls onEnd callback) -->
5. Final transcribed text is sent to the terminal as keyboard input. <!-- @impl: web-ui/src/lib/speech-input.ts::startListening --> <!-- @test: web-ui/src/__tests__/lib/speech-input.test.ts (speech-input / REQ-MOB-007 (voice input via Web Speech API)) -->
6. The mic button is hidden on browsers that do not support the Web Speech API. <!-- @impl: web-ui/src/lib/speech-input.ts::isSpeechSupported --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (renders desktop mic button when not touch device and speech supported) -->

**Constraints:**

- Reliability over features: one utterance per activation, no interim results.
- The first-use permission-prompt pattern and IME composition compatibility live in [REQ-MOB-013](#req-mob-013-mobile-input-system-platform-compatibility).

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices)

**Verification:** Automated test ([speech-input](../../web-ui/src/__tests__/lib/speech-input.test.ts))

**Status:** Implemented

---

### REQ-MOB-008: Cursor visible for all supported agents

**Intent:** The terminal cursor must be visible and correctly rendered for all supported CLI agents (Claude Code, Copilot, etc.) without duplication or visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. The terminal cursor is enabled and displays as a blinking bar. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (initializeTerminal creates Terminal with correct options) -->
2. Cursor colors match the Codeflare theme palette. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual -->
3. No CSS rules hide the terminal cursor elements. <!-- @manual -->
4. The cursor is not hidden in alternate buffer mode; only explicit DECTCEM hide sequences from the connected agent suppress it. <!-- @impl: web-ui/src/hooks/useTerminal.ts::DECTCEM_CURSOR_PARAM --> <!-- @manual: In each supported agent, enter and exit the alternate buffer and confirm the cursor remains visible until an explicit DECTCEM hide sequence. -->
5. No double-cursor duplication occurs between the terminal's native cursor and the agent's ANSI cursor on supported agent versions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @manual -->
6. The isolated compositor context for the Android IME caret remains in place as a precaution, separate from the terminal cursor layer. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->

**Constraints:**

- Cursor visibility depends on the agent version using the terminal's native cursor layer.

**Priority:** P1

**Dependencies:** [REQ-TERM-002](terminal.md#req-term-002-websocket-connection-to-container-pty)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-009: Visibility return recovers keyboard state

**Intent:** When the browser is backgrounded and returned to, keyboard state signals must be reset so the terminal functions correctly without manual intervention.

**Applies To:** User

**Acceptance Criteria:**

1. On visibility return, focus restoration first resets all keyboard-state signals and re-enables the virtual-keyboard overlay before refocusing the input. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->
2. A document-visibility handler in the layout shell triggers the same keyboard-state reset as a fallback when focus-restore does not fire. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)) -->
3. The keyboard-state reset is unconditional because cached browser geometry is stale on resume. <!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (REQ-MOB-001 AC4: should reset signals and re-sync baseline when keyboard is closed (boundingRect.height=0)) -->
4. On Samsung, the dashboard bounce ([REQ-MOB-011](#req-mob-011-samsung-internet-keyboard-state-recovery)) replaces focus-based recovery. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Samsung: bounces through dashboard on visibility return to reset keyboard state) -->
5. On Samsung, the virtual-keyboard overlay re-enable is delayed enough on visibility return that stale browser keyboard-geometry events arrive inside the ignore window. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)) -->
6. Any WebSockets dropped while the page was hidden are re-established on visibility return. <!-- @impl: web-ui/src/stores/terminal.ts::reconnectOnVisibilityReturn --> <!-- @test: web-ui/src/__tests__/stores/terminal-connect-timeout.test.ts (pauses reconnect while hidden and resumes on visibility return) -->

**Constraints:**

- Visibility-return recovery does not rely on cached browser geometry.
- Chrome and Samsung paths are separate; Samsung requires full session deactivation/reactivation.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** Automated test

**Status:** Implemented

---

<a id="req-mob-018-decorative-webgl-retirement-on-mobile-background-and-context-loss"></a>
### REQ-MOB-018: Decorative WebGL canvas retirement

**Intent:** The app's decorative WebGL canvas retires when mobile backgrounding or graphics-context loss makes continued rendering unreliable, preserving a stable dark application surface.

**Applies To:** User

**Acceptance Criteria:**

1. Backgrounding on a coarse-pointer device permanently retires the decorative WebGL canvas. <!-- @impl: web-ui/src/components/SplashCursor.tsx::SplashCursor --> <!-- @test: web-ui/src/__tests__/components/SplashCursor.test.tsx (REQ-MOB-018 AC1: retires a coarse-pointer canvas when the page is backgrounded) -->
2. WebGL context loss retires the canvas on any device and leaves the app root's dark CSS surface visible. <!-- @impl: web-ui/src/components/SplashCursor.tsx::SplashCursor --> <!-- @impl: web-ui/src/index.css::#root --> <!-- @test: web-ui/src/__tests__/components/SplashCursor.test.tsx (REQ-MOB-018 AC2: context loss permanently retires the canvas without requesting restoration) --> <!-- @manual -->

**Constraints:**

- The canvas is decorative and does not request context restoration after retirement.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MOB-010: FitAddon fit calls are coordinated

**Intent:** Multiple code paths that trigger terminal-fit recalculation must not conflict with each other or cause visual artifacts.

**Applies To:** User

**Acceptance Criteria:**

1. After a completed keyboard refit, viewport resizing fits the terminal to its visible container. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-010 AC1/AC2: fits after viewport resizing once keyboard refit finishes) -->
2. While a keyboard refit is in flight, the viewport resize observer is suppressed so the two paths do not contend. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-010 AC2: suppresses competing fits while a keyboard refit is pending) -->
3. With the keyboard open on mobile, the buffer scrolls to the bottom after every refit so new output remains visible. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (keyboard height refit) -->
4. Without the keyboard open (desktop or mobile), scroll-to-bottom only runs when the user was already at the bottom; scrollback position is preserved otherwise. <!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
5. While the keyboard is open, the resize observer does not force scroll-to-bottom; the keyboard-height-change handler owns that. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
6. A refit that produces unchanged dimensions does not send a resize message to the container. <!-- @impl: web-ui/src/stores/terminal-layout.ts::refitAllTerminalsExported --> <!-- @test: web-ui/src/__tests__/stores/terminal-layout.test.ts (REQ-MOB-010 AC6: unchanged-dimensions skip resize message) -->
7. A visible Herdr terminal refits, refreshes, and requests a repaint when the document returns from hidden state. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (forces a repaint and same-size PTY resize when a hidden page becomes visible) -->

**Constraints:**

- The keyboard-refit gate is implemented so cleanup cannot leave it stuck on after a cancelled refit.
- The write callback owns bottom-anchoring during keyboard-open output; no other path competes for that decision.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-TERM-008](terminal.md#req-term-008-write-batching-at-30fps)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-021: Terminal follows visible container changes

**Intent:** Terminal activation and mobile keyboard geometry changes keep the rendered terminal aligned with its visible container.

**Applies To:** User

**Acceptance Criteria:**

1. Activating a terminal fits it to the visible container before publishing its PTY dimensions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-021 AC1: fits the visible container when a terminal becomes active) -->
2. A mobile keyboard geometry change refits the visible terminal before publishing its PTY dimensions. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-021 AC2: fits the visible container after keyboard geometry changes) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-MOB-010](#req-mob-010-fitaddon-fit-calls-are-coordinated)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-011: Samsung Internet keyboard state recovery

**Intent:** Samsung's back-button dismiss and browser-resume paths leave the VirtualKeyboard compositor in stale states. State must be force-reset on those edges, and the user must be able to tell codeflare where Samsung's address bar sits (the API does not expose it).

**Applies To:** User

**Acceptance Criteria:**

1. Samsung's back-button keyboard dismiss is intercepted; all keyboard-state signals are reset on that event. <!-- @impl: web-ui/src/lib/mobile.ts::forceResetKeyboardState --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout keyboard dismiss (Fix 1) / REQ-MOB-011 (Samsung keyboard state recovery)) -->
2. Samsung browser resume uses an automatic dashboard bounce (deactivate then reactivate the session after a brief delay) to reset the unreliable keyboard compositor state. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Visibility Return Keyboard Reset / REQ-MOB-009 (visibility-return keyboard recovery)) -->
3. Samsung's address-bar position is configured via a user-settings toggle because no browser API exposes it. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (should show Samsung section when Samsung browser) -->

**Notes:** Samsung Internet manual verification checklist lives in [documentation/lanes/mobile.md](../../documentation/lanes/mobile.md#samsung-internet-quirks).

**Constraints:**

- Samsung session re-initialisation requires a brief delay between deactivation and reactivation for cleanup effects to settle.
- Samsung input resume does not auto-focus the terminal; the keyboard stays closed until the user taps, to avoid stale keyboard-geometry events.

**Priority:** P1

**Dependencies:** [REQ-MOB-003](#req-mob-003-samsung-internet-keyboard-viewport-state)

**Verification:** Automated test ([useTerminal](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-012: Scroll anchoring during keyboard transitions

**Intent:** Mobile keyboard mode must explicitly own terminal fit and bottom anchoring while open, without competing with generic scroll correction or changing the established swipe-input contract.

**Applies To:** User

**Acceptance Criteria:**

1. Batched output delegates every output-driven scrollback shift to xterm and performs no write-side correction. <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (REQ-TERM-014 AC3: writes batched output without viewport correction when $name) -->
2. Opening the touch keyboard performs the established fit-and-bottom transition. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (REQ-MOB-021 AC2: fits the visible container after keyboard geometry changes) -->
3. Generic viewport correction remains inactive while the touch keyboard is open. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-012 AC3: freezes correction-owned viewport movement while the touch keyboard is open) -->
4. Closing the touch keyboard hands viewport correction back to bottom-following mode. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-012 AC4: keyboard close hands viewport ownership back to bottom following) -->
5. After keyboard control ends, manual scroll ownership persists until the viewport returns to bottom. <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @test: web-ui/src/__tests__/hooks/useScrollCorrection.test.ts (REQ-MOB-012 AC5: keyboard transition preserves later manual viewport ownership) -->

**Constraints:**

- Keyboard-open bottom anchoring is intentional and has priority over manual scrollback.
- The touch-keyboard exception applies only when both touch capability and virtual-keyboard-open state are present.

**Priority:** P0

**Dependencies:** [REQ-MOB-004](#req-mob-004-scroll-drop-detection-during-burst-output), [REQ-TERM-014](terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming)

**Verification:** Automated test ([Scroll-event tests](../../web-ui/src/__tests__/hooks/useScrollCorrection.test.ts); [full-buffer batched-write test](../../web-ui/src/__tests__/stores/terminal.test.ts))

**Status:** Implemented

---

### REQ-MOB-019: Keyboard-mode swipe semantics

**Intent:** Vertical terminal swipes remain typing input while the touch keyboard is open and return to scrollback navigation once keyboard mode ends.

**Applies To:** User

**Acceptance Criteria:**

1. Vertical swipes remain terminal input while the touch keyboard is open. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (should call preventDefault and send up arrow) -->
2. After the touch keyboard closes, vertical swipes scroll through terminal history. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures --> <!-- @test: web-ui/src/__tests__/lib/touch-gestures.test.ts (scrolls the buffer on vertical swipe when keyboard is closed) -->

**Constraints:**

- The established tap-to-focus keyboard opening remains unchanged.
- Fullscreen wheel routing applies only while the keyboard is closed ([REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling)).

**Priority:** P0

**Dependencies:** [REQ-MOB-012](#req-mob-012-scroll-anchoring-during-keyboard-transitions), [REQ-MOB-005](#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-MOB-017](#req-mob-017-fullscreen-application-touch-scrolling)

**Verification:** Automated test ([Touch gesture tests](../../web-ui/src/__tests__/lib/touch-gestures.test.ts))

**Status:** Implemented

---

### REQ-MOB-013: Mobile input-system platform compatibility

**Intent:** Mobile browsers stack the virtual keyboard above the permission prompt and route swipe-typed text as IME composition events. The input system must blur the iframe before triggering permission prompts (so the user sees the prompt) and buffer composition events until commit (so swipe typing arrives as whole words).

**Applies To:** User

**Acceptance Criteria:**

1. On first use, when the microphone permission state is `prompt` or cannot be determined, the iframe input is blurred (dismissing the keyboard) before requesting permission so the user can see a possible browser prompt. <!-- @impl: web-ui/src/lib/speech-input.ts::getMicPermissionState --> <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @test: web-ui/src/__tests__/components/FloatingTerminalButtons.test.tsx (REQ-MOB-013 AC1: dismisses the mobile keyboard before speech may issue a first prompt when permission state is unknown) -->
2. The same blur-before-permission pattern applies to clipboard paste. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->
3. Swipe-typed text is buffered through the browser's IME composition events and sent only when the IME commits, so partial composition does not reach the terminal as individual keystrokes. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @manual -->

**Constraints:**

- Permission prompt handling is critical on mobile where the prompt appears behind the virtual keyboard if the iframe still holds focus.

**Priority:** P2

**Dependencies:** [REQ-MOB-001](#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-007](#req-mob-007-voice-input-via-web-speech-api)

**Verification:** Automated test ([speech-input](../../web-ui/src/__tests__/lib/speech-input.test.ts))

**Status:** Implemented

---

### REQ-MOB-014: Mobile background-surface focus isolation

**Intent:** Hidden same-origin surfaces must not steal focus from an active mobile terminal.

**Applies To:** User

**Acceptance Criteria:**

1. Background same-origin surfaces that run while the keyboard is open do not blur the terminal input or dismiss the keyboard. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->
2. Vault browser prewarm remains eager but uses a focus-inert hidden document. <!-- @impl: src/lib/vault-view.ts::injectVaultPrewarmFocusGuard --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (CF-045: vault-html direct unit tests) -->
3. If a hidden iframe captures focus, the terminal/input focus is restored. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (restores prior focus if the hidden prewarm iframe captures parent focus) -->

**Constraints:**

- Background prewarm remains eager while the keyboard is open.

**Priority:** P0

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap)

**Verification:** Automated test ([Vault prewarm test](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [Vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts))

**Status:** Implemented

---

### REQ-MOB-015: Virtual keyboard persists across terminal pane focus handoff

**Intent:** On touch devices the virtual-keyboard mode (locked/anchored layout, swipe-as-arrows, keyboard-height padding) is driven by a single shared signal. When several backend-session terminal surfaces are visible in tablet MultiView and focus moves while the keyboard is open, the keyboard must stay open and the newly focused surface must keep keyboard mode without the user dismissing and reopening the keyboard. Classic focus remains among Codeflare outer panes; focus among panes inside a Herdr session belongs to Herdr within one xterm.js surface. Shared keyboard state is torn down only when focus leaves terminal surfaces, not on a MultiView handoff.

**Applies To:** User

**Acceptance Criteria:**

1. A live focus query reports whether browser focus currently rests on a terminal input surface; it is the single discriminator used by every per-pane keyboard-teardown site. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (reports focus resting on a terminal input iframe) -->
2. When a terminal pane loses focus to a sibling terminal pane, the per-pane focus-loss cleanup does not disable the keyboard overlay or zero the keyboard signals, so the newly focused pane stays in keyboard mode. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::releaseKeyboardOnBlur --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (useTerminal hook) -->
3. A Samsung back-button keyboard dismiss still zeroes keyboard state, but a pane-to-pane focus handoff does not. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @test: web-ui/src/__tests__/hooks/useTerminal.test.ts (Samsung focusout keyboard dismiss (Fix 1) / REQ-MOB-011 (Samsung keyboard state recovery)) -->
4. When focus leaves all terminal surfaces, the shared keyboard overlay and signals are released. Unmount releases them only when the retiring pane owns focus or no terminal input owns focus; a sibling-pane focus handoff preserves them. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (REQ-MOB-015 AC4: preserves shared keyboard state when a sibling pane owns focus) --> <!-- @test: web-ui/src/__tests__/lib/terminal-mobile-input.test.ts (REQ-MOB-015 AC4: retires shared keyboard state when no terminal input owns focus) -->

**Constraints:**

- The discriminator reads live focus state, never a cached value.
- Exit/unmount teardown is owner-aware: it cannot clear a sibling terminal's live keyboard state, and it resets state when no terminal input remains focused.

**Priority:** P1

**Dependencies:** [REQ-MOB-002](#req-mob-002-virtual-keyboard-opens-reliably-on-tap), [REQ-MOB-009](#req-mob-009-visibility-return-recovers-keyboard-state)

**Verification:** Automated test ([Mobile keyboard test](../../web-ui/src/__tests__/lib/mobile.test.ts), [useTerminal hook test](../../web-ui/src/__tests__/hooks/useTerminal.test.ts))

**Status:** Implemented

---
