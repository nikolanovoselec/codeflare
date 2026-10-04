# Terminal & IDE

Browser terminal and editor client contracts, mobile compatibility, viewport ownership, and connection recovery.

**Audience:** Developers, Operators

**Owns:** terminal surfaces/protocol/client visibility and focus; mobile keyboard/touch/fit/scroll compatibility; Browser IDE workspace behavior, public proxy contract, editor continuity boundaries and device verification. **Does not own:** D1 lifecycle/process-exit authority, container supervision/idle enforcement, durable file reconciliation, credential containment, Browser Run automation, or IDE package implementation inventory.

## Contents

- [Terminal ownership and transport](#terminal-ownership-and-transport)
- [GitHub and Storage workspace](#github-and-storage-workspace)
- [Backend state and client connectivity](#backend-state-and-client-connectivity)
- [Browser IDE](#browser-ide)
- [Interaction and Focus Model](#interaction-and-focus-model)
- [Terminal Compatibility](#terminal-compatibility)
- [Scroll Stability](#scroll-stability)
- [Transport Recovery](#transport-recovery)
- [Behavioral Test Matrix](#behavioral-test-matrix)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Terminal ownership and transport

The persisted per-session terminal stamp is immutable. Classic owns Codeflare tabs/labels/layouts/tiling and up to six outer node-pty sessions; Herdr owns inner tabs/panes/splits/workspaces/agents behind one xterm surface, outer terminal ID `1`. Historical missing/invalid mode resolves Classic; preferences affect only new sessions. Dashboard and VS Code workspaces mount no host browser-terminal surface. MultiView is browser-local virtual workspace membership, never a backend identity or capacity/storage API argument. [REQ-TERM-001](../../sdd/spec/terminal.md#req-term-001-terminal-surface-count-follows-session-mode), [REQ-TERM-034](../../sdd/spec/terminal.md#req-term-034-terminal-mode-assignment-is-immutable).

`/api/terminal/{sessionId}-{terminalId}/ws` remains the existing authenticated Worker→DO→host transport. PTY output is raw, with typed JSON control frames for resize/process name/restore/kill and notification coordination. No application ping/pong or browser Herdr protocol is added. Authenticated lookup rejects Herdr outer IDs above `1`. Enterprise warm reconnect renews credentials only after same-owner/generation checks, never changes immutable principal or compute; unconfirmed revocation rejects retryably. See [API](api-reference.md), [Security](security.md), [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards).

Only visible workspace panes own sockets. Dashboard has zero, single-session Classic exposes its active tabs/tiles, Herdr one surface, MultiView one outer surface per member. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> Leaving visible set disposes local UI resources without killing PTY. Focus handoff does not remount/reconnect; focused visible pane claims resize authority before publishing fitted dimensions. Stale cleanup cannot close a newer owner; losing focus before open clears pending resize authority. Herdr visibility return forces current-pane repaint with same-size resize even if dimensions did not change. [REQ-TERM-011](../../sdd/spec/terminal.md#req-term-011-visible-terminal-panes-own-websocket-connections), [REQ-TERM-016](../../sdd/spec/terminal.md#req-term-016-terminal-pane-reconnect-and-resize-authority), [REQ-TERM-017](../../sdd/spec/terminal.md#req-term-017-multiview-pane-focus-and-input-routing).

Current endpoint readiness keeps ordinary terminal clients disconnected until `ready`; `mounting` is not public attachment authority. Focus/display await OPEN, which leaves foreign panes unchanged and produces a focused renderable pane even if viewport dimensions are not yet initialized. Genuine PTY reattachment first restores the host serialized screen. Original mounting-stage obligations in [REQ-TERM-043](../../sdd/spec/terminal.md#req-term-043-visible-terminal-readiness-gating) remain intact rather than being silently rewritten by this source description. [REQ-TERM-044](../../sdd/spec/terminal.md#req-term-044-terminal-restore-and-readiness-rendering) owns restore/rendering obligations.

Herdr image settings manage mobile layout, mouse capture, browser-owned clipboard, 10 MB pane scrollback, palette, labels and static status symbols. Updates, remote manifests, sound, pane history persistence, nested launches and Kitty graphics stay disabled. Named runtime lifetime/readiness/recovery belongs to [Sessions & Runtime](container.md#runtime-lifecycle); only official structural `session.json` is durable through normal R2 sync, never prior pane output or arbitrary process survival. Fresh Herdr Pi runs fullscreen and owns its transcript.

### Browser terminal link activation

OAuth shims print URLs rather than opening container browsers. The shared xterm link provider owns detection, reconstruction and browser opening. Classic retains activation; Herdr Ctrl-/Cmd-click and stationary mobile link taps open once without SGR input. Same-cell pointer jitter is allowed; moving cells cancels modified activation. Mobile link taps do not focus input or reset fullscreen history. Modified non-links still reach Herdr. Focused connected pane owns URL detection; cleanup is scoped to that session/terminal, never unscoped on ordinary unmount. <!-- @impl: web-ui/src/lib/terminal-link-provider.ts::registerMultiLineLinkProvider --> [REQ-TERM-015](../../sdd/spec/terminal.md#req-term-015-focused-pane-owns-url-detection), [REQ-TERM-042](../../sdd/spec/terminal.md#req-term-042-browser-terminal-link-activation).

### Herdr clipboard compatibility boundary

Explicit copy uses OSC 52 standard `c` selector, valid base64/UTF-8, at most 64 KiB decoded. Reads/queries/invalid selectors/encoding/oversize are rejected. Herdr copy is independent of Classic right-click paste preference; Classic installs no Herdr write handler. Ctrl-/Cmd-V reads during trusted key gesture and pastes via xterm. Browser permission remains authoritative; content/queries are never logged and no second clipboard service exists. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/osc52.ts::beginClipboardWrite -->

Samsung may reject asynchronous writes. The latest failure remains browser-local for the next trusted floating Paste control, which retries clipboard write and pastes retained text once. Older failure cannot overwrite newer state. Pi/Herdr copy toasts prove emission, not browser acceptance. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::pasteFromClipboard --> [REQ-TERM-032](../../sdd/spec/terminal.md#req-term-032-herdr-clipboard-compatibility-boundary), [REQ-TERM-041](../../sdd/spec/terminal.md#req-term-041-rejected-herdr-clipboard-recovery).

### Herdr attention and completion

Managed Pi/Claude fixed events use bounded authenticated loopback ingress in Herdr when inner OSC bytes are unavailable; no prose/paths/credentials enter it. Classic keeps native producer behavior. Herdr completion uses semantic status for every recognized Pi/Claude pane, private public-API socket subscriptions and one ten-minute all-idle/done timer after observed work. Working cancels timer/queued completion, not input-required events; blocked/unknown or initial-ready/no-agent state cannot trigger completion. No pane identity/socket path reaches browser; timer does not extend user activity/lifetime. Local/Push Pi copy is **Ready for input**, Claude remains **Task completed**. Classic has no completion producer. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> [REQ-TERM-029](../../sdd/spec/terminal.md#req-term-029-herdr-status-gated-terminal-completion), [REQ-TERM-031](../../sdd/spec/terminal.md#req-term-031-herdr-notification-compatibility-boundary), [REQ-TERM-038](../../sdd/spec/terminal.md#req-term-038-herdr-semantic-status-owns-completion-readiness), [REQ-TERM-039](../../sdd/spec/terminal.md#req-term-039-herdr-completion-delivery-is-readiness-oriented).

Notification delivery retains event-specific global suppression, single local grant, no-client fallback, acknowledgement/expiry and idle isolation. Per-device enrollment alone requests permission. Existing Partial deployed notification verification remains Partial; this relocation does not supply acceptance evidence.

## GitHub and Storage workspace

The dashboard right column shares space between GitHub and Storage: when space permits, GitHub anchors at the top and Storage at the bottom, with adaptive scrollable allocation rather than a fixed repository row limit. Narrow or short viewports collapse to one content-sized, viewport-capped face. GitHub is the default when enabled; header controls flip to Storage and back, recomputing height. Disabled GitHub leaves Storage alone. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @impl: web-ui/src/lib/panel-allocation.ts::decidePanelLayoutMode --> [REQ-GITHUB-009](../../sdd/spec/github.md#req-github-009-github-repository-list-viewport-and-empty-states), [REQ-GITHUB-010](../../sdd/spec/github.md#req-github-010-mobile-github-and-storage-face-switching), [REQ-GITHUB-012](../../sdd/spec/github.md#req-github-012-responsive-github-and-storage-panel-allocation).

Repository search is disclosed on demand at every breakpoint. Opening the magnify toggle reveals and synchronously focuses the input; touch also scrolls it above the keyboard. Closing hides the input and clears the filter, so hidden search cannot silently narrow the list. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::toggleSearch --> [REQ-GITHUB-011](../../sdd/spec/github.md#req-github-011-mobile-search-disclosure-with-autofocus). Pixel allocation and protected-deployment viewport checks retain their manual qualifiers; source descriptions do not establish device acceptance.

## Backend state and client connectivity

D1 is shared backend authority: `stopped`, `starting`, `running`, `unreachable`, `stopping`, ordered by generation/revision. The DO controls processes; only matching positive exit evidence releases ownership. [Sessions & Runtime](container.md#lifecycle-authority) owns that contract.

Terminal `running` + this device's connected socket presents green ACTIVE; no socket presents blue IDLE. Neither label is persisted or inferred for another device. Starting/unreachable use yellow recovery presentation, stopped gray. Retry exhaustion/deadline countdown changes messaging only, never invents stopped. Mounted objects/buffers/tabs/tiling/selection/scrollback remain through transport uncertainty; newer authoritative shutdown/deletion evidence owns disposal, not local failures. D1 outage retains last ordered view and distinct status-unavailable notice. <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation --> <!-- @impl: web-ui/src/lib/session-presentation.ts::applyStatusFailure --> [REQ-TERM-045](../../sdd/spec/terminal.md#req-term-045-local-terminal-presence-presents-active-or-idle) retains Planned status despite available helper/source evidence.

Ready running VS Code remains green during connectivity recovery with separate accessible notice, not Terminal ACTIVE/IDLE. D1 outage does not unmount editor. Source `session-presentation.ts` currently keeps `stopping` mounted; spec disposal wording must not be strengthened into a claimed immediate client teardown. <!-- @impl: web-ui/src/lib/session-presentation.ts::vscodePresentation -->

<a id="code-server-browser-ide"></a>
<a id="browser-ide"></a>
<a id="browser-ide-internals"></a>
## Browser IDE workspace behavior

**Canonical behavior anchor: `#browser-ide`.** Browser IDE is the per-session advanced code-server editor, not Cloudflare Browser Run automation. Public routes and client behavior belong here; implementation inventory, adapter composition, private API mechanics and package verification belong exclusively to [`openvscode/README.md`](../../openvscode/README.md). The legacy directory name is intentional, not evidence of an OpenVSCode runtime.

### Workspace launch and availability

The immutable workspace stamp determines dashboard behavior. A VS Code session starts editor after init without host terminal/Herdr prewarm, stays on dashboard, progresses **Preparing**→**Open**, and opens/reuses one editor tab. Changing Default workspace affects future sessions only. Stop/Delete may leave existing editor tab unavailable; dashboard does not close it. Terminal session keeps its terminal and pays no editor process cost until explicit eligible editor request. Header launches the active advanced running session. Non-advanced requests get a clear non-refreshing denial; warming retries are bounded, not an infinite loop. Supervisor lifetime/reaping stays in [Sessions & Runtime](container.md#code-server-browser-ide). [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions).

### Clean session-scoped proxy

Public `/api/vscode/<sessionId>/` stays selector-free. Worker and host independently reject `folder`, `workspace`, `ew`; exact session-prefix ownership prevents another session's path reaching editor. Only private loopback root receives `folder=/home/user/workspace`; redirects strip selectors. Host projects equivalent fixed `vscode-remote` folder URI with canonical public Host authority, not code-server's deliberate `remote` placeholder. Renderer/extension-host document identity therefore agree. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace -->

Root workbench buffering caps 2 MiB and fails closed on missing/duplicate/malformed pinned meta shape or authority, compression or oversize. Assets/protocol stream normally. Native authorized DO `Stub.fetch` transports editor upgrades; HTTP uses existing-port forwarding. Neither starts a replacement runtime. code-server's `--auth none` is confined behind Access/owner chain/container Bearer, on loopback 13337; same-origin framing and proxy authentication remain independent. [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-clean-browser-ide-url-and-private-workspace-selection), [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection).

### Editor activity transport

Pre-open browser frames retain original order/text/binary form under caps of 128 frames/8 MiB. Flush occurs after upstream open; overflow closes 1013 and cleanup releases listeners/frames on either close/error. Every client-to-server frame refreshes shared host `lastInputAt` without protocol parsing. Server output/socket presence do not become activity. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> [REQ-IDE-004](../../sdd/spec/browser-ide.md#req-ide-004-resilient-editor-activity-transport).

### Selected native IDE agent

Exact tab-1 Pi selects native **Codeflare** Chat/Inline Chat; exact supported Claude selects unchanged official Claude panel; invalid/unsupported selects empty base. Absent configuration preserves legacy Claude. Immutable bases compose with writable user installs; unsupported base stays empty even if user extensions exist. Agent processes/conversations are separate from terminal tab 1 and terminal history/runtime is never projected. No unrelated Accounts/Copilot login is required for Pi inference; compatibility model entries reject generation/authorization. Package-level inventory tables, participant identifiers, FIFO RPC adapters, proposal protocols, validation bounds, dialogs, tool restoration and process error handling are not duplicated here: see [Browser IDE agents](../../openvscode/README.md#selection-and-ui), [Native Pi Chat](../../openvscode/README.md#native-pi-chat), [Official Claude](../../openvscode/README.md#official-claude-code).

Pi panel is unrestricted; native Inline Chat returns validated host-owned edit proposals with controller-owned Keep/Close, not direct panel tool writes or synthetic approval transactions. Each invocation uses bounded canonical-workspace context; cold/replacement panel may hydrate visible history, warm panel/Inline omit replay and Inline does not mutate stored panel history. Native Pi RPC is request-lazy and reused after normal settlement, boundedly reaped on failure/cancel/deactivation. Official Claude uses isolated ephemeral config/unrestricted bypassPermissions and its loopback-authenticated IDE MCP. [REQ-IDE-005/006/007/008/019/020/021/022](../../sdd/spec/browser-ide.md).

### Managed workspace settings and branding

Launch disables telemetry/updates/built-in proxying/Getting Started/workspace trust. Ephemeral User settings are prepared beneath the exact `--user-data-dir`, ignore recommendations and permit user extensions with managed `extensions.allowed` for every inventory. Pi/Claude/unsupported owned keys override restored preferences; preparation failure refuses launch. code-server's supported `--app-name Codeflare` sets title/trust branding; native participant/welcome use packaged product icon, no Code OSS patch. <!-- @impl: entrypoint.sh::_openvscode_prepare_agent --> <!-- @impl: entrypoint.sh::_openvscode_launch_once --> [REQ-IDE-009](../../sdd/spec/browser-ide.md#req-ide-009-frictionless-workspace-open-for-every-ide-agent), [REQ-IDE-039](../../sdd/spec/browser-ide.md#req-ide-039-codeflare-browser-ide-branding), [REQ-IDE-040](../../sdd/spec/browser-ide.md#req-ide-040-user-extension-allowance-policy).

Every inventory exposes **Bash** with `/bin/bash -l`, `MANUAL_TAB=1` to skip existing agent autostart, plus **Codeflare Session Agent** without bypass. Only lowercase auto-detected duplicate bash is suppressed; unrelated detected profiles remain. Terminal workspaces default Bash; VS Code workspaces default Codeflare Session Agent and welcome creates/reuses/focuses that integrated terminal once behind its welcome editor. Thus Bash-first package base and VS Code workspace-specific default are not conflicting promises. [REQ-IDE-047](../../sdd/spec/browser-ide.md#req-ide-047-bash-first-browser-ide-terminals), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions). Package settings mechanics stay in [openvscode README](../../openvscode/README.md#selection-and-ui).

### Bounded IDE continuity

Live editor data/packages/databases/SQLite companions remain ephemeral under `/run/codeflare/openvscode/data`; extensions use its `extensions` child. After generation reap, a maximum-1-MiB atomic fail-closed `~/.codeflare/ide-ui-state.json` exports only theme, string `keyboard.layout`, and schema-valid canonical in-workspace Explorer/open-file resources. Restore prepares fresh workspace storage before inventory-managed settings override keys.

A separate mode-0600 maximum-64-KiB `~/.codeflare/ide-extensions.json` carries at most 50 lowercase ordinary identities/versions, durable warning acknowledgement and at most 32 KiB contributed global User settings. Lazy workbench-after-start restore never gates readiness. Registry/settings capture plus reap backstop shares one manifest path; changed atomic writes wake existing sync, not another R2 writer. Invalid intent remains unchanged; fixed IDs excluded; `.obsolete` alone proves uninstall. Exact restore uses two workers and one structured-not-found fallback, no retry loop. See [package continuity implementation](../../openvscode/README.md#user-managed-extension-continuity).

No VSIX/extracted bytes, raw database, global/workspace extension state, SecretStorage, Accounts, enablement, keybinding, snippet, authentication, chat history, logs, WAL/SHM enters sync. Private VSIX stays local and simultaneous manifests converge whole-file newest-wins. Gallery is compiled Open VSX/TLS only; code-server disables signatures/grants proposed APIs broadly. First execute/write requires one root-capable-code warning acknowledgement; package pin risk acceptance remains [AD132](../decisions/README.md#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory). [REQ-IDE-002/016/036/037/038](../../sdd/spec/browser-ide.md); storage policy remains in [Storage & Sync](storage-and-sync.md).

Company extension mutation requires both transported verified digests. Missing/mismatched managed manifest preserves current company state and shows remediation; runtime admission belongs to [Sessions & Runtime](container.md#managed-curation-startup-boundary).

### Integration acceptance

After deployment, create fresh Terminal and VS Code sessions. Confirm Terminal uses existing surface without editor until requested; VS Code remains dashboard-owned Preparing→Open, repeated clicks reuse one editor tab, creates one Codeflare Session Agent terminal and no host terminal connection. Change Default workspace and verify existing stamps unchanged. Stop/Delete leaves editor tab unavailable without dashboard closing it. Verify clean selector-free location, same-origin routing, canonical workspace, agent inventory/account-free behavior and isolated conversations. These are acceptance obligations, not evidence obtained by this documentation move.

<a id="mobile-terminal"></a>
## Interaction and Focus Model

<a id="multiview-availability"></a>
### MultiView Availability

Phone capacity is zero: shared `getTerminalViewportClass` hides MultiView launch and prevents tiled selection. Tablet capacity is two, desktop two–four. Saved browser membership survives being hidden; tablet/desktop can reopen `MultiView #1` if two members remain running/initializing. [REQ-TERM-012](../../sdd/spec/terminal.md#req-term-012-multiview-virtual-session-workspace), [REQ-TERM-013](../../sdd/spec/terminal.md#req-term-013-multiview-selection-flow).

### Cursor Visibility

Native xterm cursor is enabled (`cursorBlink: true`, bar; color `#e4e4f0`, accent `#1a2332`). No CSS cursor hiding/alternate-screen blanket hiding; only explicit DECTCEM suppresses it. Supported newer Claude/Copilot use native cursor instead of old duplicate ANSI cursor. Android IME compositor jail is separate and remains. Old orange-square CSS workarounds are historical, not current repair guidance. [REQ-MOB-008](../../sdd/spec/terminal.md#req-mob-008-cursor-visible-for-all-supported-agents).

### Keyboard Management

#### VirtualKeyboard API

Enable overlaysContent before terminal focus; disable on actual exit so ordinary inputs resize normally, never during terminal-to-terminal handoff. Browser events own geometry, not polling/timer-based verification.

#### Multi-pane focus handoff

`vkOpen`, `keyboardHeight`, overlaysContent are one window resource owned by focused terminal. Live `isFocusOnTerminalInput()` recognizes active terminal-input iframe and gates hook cleanup, per-input blur and one-tick Samsung focusout. Sibling handoff preserves overlay/signals. Exit/unmount is owner-aware: retiring pane clears only if it owns focus or no terminal remains focused; it cannot clear sibling state. This supersedes older unconditional iframe-removal teardown wording. [REQ-MOB-015](../../sdd/spec/terminal.md#req-mob-015-virtual-keyboard-persists-across-terminal-pane-focus-handoff).

Classic retains established mouse/right-click/gesture behavior. Herdr ordinary mouse click/drag/wheel becomes SGR cell input, except browser link activation. Stationary single-finger trusted touchend sends one same-cell press/release, suppresses compatibility mouse, activates MultiView owner then opens mobile input. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::sendHerdrTap --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::focusMobileTerminal --> Movement threshold/long press/multi-touch/cancel never activate. Detected links take precedence without SGR/focus. [REQ-MOB-020](../../sdd/spec/terminal.md#req-mob-020-terminal-touch-activation), [REQ-TERM-036](../../sdd/spec/terminal.md#req-term-036-browser-pointer-interaction-with-herdr), [REQ-TERM-017](../../sdd/spec/terminal.md#req-term-017-multiview-pane-focus-and-input-routing).

#### Background prewarm focus safety

Vault eager hidden same-origin prewarm is not deferred by terminal keyboard. Valid-token prewarm shell receives focus-inert guards before app scripts: focus/select/window.focus no-op, hidden-document focus blurred; parent restores prior terminal/input if iframe steals it. User-opened Vault is unaffected. [REQ-MOB-014](../../sdd/spec/terminal.md#req-mob-014-mobile-background-surface-focus-isolation), [REQ-VAULT-020](../../sdd/spec/vault.md#req-vault-020-vault-prewarm-focus-safety).

#### Samsung Internet Quirks

Bottom navigation inflates viewport and Samsung exposes no reliable address-bar-position API. User `samsungAddressBarTop` setting supplies that distinction; overlaysContent geometry plus narrow-screen compensation handles bottom position. These are event-driven compatibility patches, not polling/delayed state verification.

#### Stale `geometrychange` Ignore Window

Ignore cached geometry within 50 ms of an actual overlaysContent toggle. `overlaysContentChangedAt` must not restamp a no-op enable/disable, or the following real event is swallowed and keyboard height remains zero.

<a id="baselineinnerheight--viewportgrowth-compensation"></a>
#### `baselineInnerHeight` / `viewportGrowth` Compensation

Keyboard hides Samsung bottom bar, growing innerHeight without updating CSS viewport. `viewportGrowth=innerHeight-baselineInnerHeight` is subtracted from VK boundingRect height only on narrow bottom-bar layouts.

<a id="baselineinnerheight-immutability"></a>
#### `baselineInnerHeight` Immutability

Page-load baseline stays immutable through keyboard close/reset/stale checks. Only Fold physical screen switch (delta >200 px, keyboard closed) can update it. Samsung emits height-zero before returning navigation bar, so close-time rebasing captures inflated ~47 px and creates persistent gap.

#### Samsung Focusout Handler

Back dismissal may omit geometrychange. Samsung focusout waits one tick; if focus left all terminal input and keyboard was open, force-reset all signals. Sibling handoff does not reset; listener cleanup follows terminal deactivation.

#### Visibility Return Reset

Chrome focus restore force-resets stale signals and enables overlay before focus. Layout fallback force-resets and delays overlay enable 300 ms so Samsung cached events settle. Do not trust resume boundingRect for conditional resets.

Samsung compositor resume instead uses automatic dashboard bounce: reset, deactivate session/dashboard, reactivate after 50 ms cleanup gap, reconnect only visible sockets. Samsung input restore does not auto-focus; delayed overlay enable leaves keyboard closed until user tap. These are compatibility delays, not permission to infer backend stopped. [REQ-MOB-009](../../sdd/spec/terminal.md#req-mob-009-visibility-return-recovers-keyboard-state), [REQ-MOB-011](../../sdd/spec/terminal.md#req-mob-011-samsung-internet-keyboard-state-recovery).

Decorative WebGL canvases retire permanently on coarse-pointer backgrounding or any context loss, stop simulations, leave compositing and reveal dark CSS surface; no restoration request. Landing implementation remains a distinct owner. [REQ-MOB-018](../../sdd/spec/terminal.md#req-mob-018-decorative-webgl-canvas-retirement), [REQ-LANDING-009](../../sdd/spec/landing.md#req-landing-009-decorative-flare-failure-fallback).

#### FitAddon Management

Keyboard refit (150-ms debounce), active-state RAF, ResizeObserver RAF and Herdr visibility-return RAF coordinate. A timer ID (`kbDebounceTimer`), not boolean, suppresses competing observer fits and clears safely on cancellation. Every fit requires mounted nonzero-height container; visibility return also requires visible document.

Mobile open keyboard intentionally fit/bottom-anchors using buffer-authoritative `scrollBufferToBottom()`. Herdr Pi fullscreen history instead receives trusted End after pane activation and before opening focus; already-open taps preserve viewport. Without keyboard, fit preserves manual reader position and follows bottom only if previously there. Re-command DOM through `resyncViewportScrollState()` on scroll-owning keyboard/activation/observer/init-overlay/lifecycle refits. Herdr visibility return fits, refreshes full xterm and sends same-size resize repaint. Ordinary unchanged-dimension refits skip resize. [REQ-MOB-010](../../sdd/spec/terminal.md#req-mob-010-fitaddon-fit-calls-are-coordinated), [REQ-MOB-021](../../sdd/spec/terminal.md#req-mob-021-terminal-follows-visible-container-changes), [REQ-MOB-022](../../sdd/spec/terminal.md#req-mob-022-herdr-mobile-input-focus-and-viewport).

### Touch Input

#### Swipe Gestures

Horizontal arrows repeat every 80 ms while held. touchstart/move/end/cancel all use capture phase so xterm stopPropagation cannot strand repeat. Cleanup always clears timer. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures -->

xterm 6.1 Gesture document singleton cancels click synthesis; bubble-phase terminal propagation shield (never preventDefault) isolates terminal touches while capture handlers still run and outside touches stay unchanged. Classic retains browser synthesized click to focus. Herdr uses trusted touchend (prevents default) and direct focus path; compatibility mousedown/up/click are suppressed in bounded post-touch window using touch capability or start/end proximity, while identified hardware mouse passes. Confirmed Herdr scroll blurs stale input focus so Samsung cannot reopen keyboard on release. [REQ-MOB-002](../../sdd/spec/terminal.md#req-mob-002-virtual-keyboard-opens-reliably-on-tap) AC6, [REQ-MOB-020](../../sdd/spec/terminal.md#req-mob-020-terminal-touch-activation), [REQ-MOB-022](../../sdd/spec/terminal.md#req-mob-022-herdr-mobile-input-focus-and-viewport).

Keyboard closed: normal-buffer vertical swipes use BufferService deltas; alternate-screen wheel-capable application owns history, so Classic uses xterm DOM wheel encoding/inertia. Herdr sends proportional wheel steps without inertia and stops at release. Keyboard open: vertical swipes always arrows, even fullscreen mouse tracking; horizontal navigation remains. [REQ-MOB-005](../../sdd/spec/terminal.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-MOB-017](../../sdd/spec/terminal.md#req-mob-017-fullscreen-application-touch-scrolling), [REQ-MOB-019](../../sdd/spec/terminal.md#req-mob-019-keyboard-mode-swipe-semantics).

`?debug=1` explicitly enables bounded content-free trace (12 newest records) over keyboard/viewport diagnostics: event order/final cancellation/touch origin/target/focus/moves/geometry, no terminal text/server state. <!-- @impl: web-ui/src/lib/touch-event-debug.ts::attachTouchEventDebug --> <!-- @test: web-ui/src/__tests__/lib/touch-event-debug.test.ts (touch event debug trace) --> [REQ-MOB-023](../../sdd/spec/terminal.md#req-mob-023-opt-in-mobile-input-diagnostics).

#### Input Architecture

- Separate iframe compositor contains Android IME caret. Scoped createElement override during terminal.open uses password input to suppress OS autocorrect, restored afterward. `_syncTextArea` stays active; freezing leaves focus at (0,0) and caused historical top snaps. Live iframe-document focus is not cached.
- Sticky Ctrl is single-use; Ctrl+C/Ctrl+D preserve expected input without intercepting ordinary typing.
- SpeechRecognition is independent of iframe input; supported mobile floating mic or desktop mic/Ctrl+Space captures one utterance (`continuous=false`, `interimResults=false`), then sends final text to terminal.input. Unsupported browser hides controls.
- Before uncertain/prompt microphone or clipboard permission, blur iframe so prompt is not behind keyboard. Composition buffers swipe typing until commit. Enable overlay before input focus.
- Floating normal-buffer page controls use buffer-derived page/bottom deltas; alternate-screen controls send PageUp/PageDown to application history, targeting focused MultiView pane even without a single active session.

[REQ-MOB-001/006/007/013/016](../../sdd/spec/terminal.md) retain automated/manual verification qualifiers; device/IME evidence is not inferred from unit tests.

<a id="xterm-61-color-scheme-report-suppression-git-fix-21"></a>
## Terminal Compatibility

Pinned xterm `6.1.0-beta.304` includes deferred DOM synchronization/full-buffer anchoring, but optional color-scheme reporting is disabled with public typed `vtExtensions: { colorSchemeQuery: false }`. Default-on `CSI ?996n` replies and DECSET 2031 `CSI ?997;1n` theme pushes otherwise flood TUIs that toggle DECTCEM/theme and echo unsupported reports. This restores prior byte behavior; protocol owner is [REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards) **AC4** (original mobile prose's AC2 reference was stale). <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->

Herdr Ctrl+B forwards only canonical prefix and suppresses browser bookmarks; Herdr owns action map (Help prefix+?, Settings prefix+s). Classic/unrelated modified keys stay with xterm, and OS-reserved combinations remain outside browser control. [REQ-TERM-037](../../sdd/spec/terminal.md#req-term-037-browser-keyboard-interaction-with-herdr).

## Scroll Stability

### Root Cause

Historical `_syncTextArea` freeze and capture scroll guard fought browser focus and xterm's JS scroll layer; forcing scrollTop zero could command viewport to absolute top. Both hacks were removed. xterm's deferred sync/native full-buffer anchor remains authoritative; Codeflare never repairs output by distance restoration or generic zero-clamp.

Current ownership:

1. FOLLOW_OUTPUT: synchronous onScroll guard bottom-anchors before paint only while following and no correlated user intent.
2. READ_SCROLLBACK: correlated wheel/pointer/navigation/touch/external intent establishes persistent ownership until live bottom. Output is held, not written beneath reader; oldest whole units drop over cap.
3. MOBILE_INPUT_LOCKED: touch keyboard lifecycle intentionally fits/anchors. Generic correction is inactive, vertical swipes are arrows, fullscreen wheel route only keyboard-closed.

Frontend cap is 5,000 lines; host renderer retains 1,000; agent-side virtual scrolling disabled. Pinned JS scroll layer remains sole scroller (`.xterm-viewport` overflow hidden). No fit runs at zero visible height. Writes never reposition; refit skips unchanged ordinary resize.

### Persistent Manual Ownership

A short window only correlates first scroll with input intent; touchmove refresh handles long drags. Once correlated ownership has no expiry timer, including legitimate native trim shifts to zero. Returning bottom releases it. Old deep-distance restoration reacted recursively to programmatic events and is not current behavior.

### xterm 6.1 Native Full-Buffer Anchoring

Native trim keeps surviving content at decremented viewportY, but cannot preserve destroyed viewed lines. Classic normal-buffer hold therefore defers streamed output on the 33-ms schedule under readers, capped 2,000,000 characters, dropping oldest whole atomic units rather than writing through. Bottom return releases whole units toward 65,536 characters per tick, rechecking ownership; a single unit may exceed target. Classic alternate-buffer output never defers because application owns history. [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming).

Synchronized DEC 2026 frames remain whole byte-identical units across WS chunks, with bounded stall/size fail-open. No async xterm parser handlers undermine one-write atomicity. Partial assembly never crosses socket boundary; host restore supersedes queued complete units on reconnectable close, final close paints completed units once. [REQ-TERM-021](../../sdd/spec/terminal.md#req-term-021-synchronized-output-frame-atomicity).

### Herdr Viewport Ownership

Fresh Pi starts `--tui-mode fullscreen`; Pi owns history. Codeflare queues/presents complete differential frames in order on standard 33-ms cadence without viewport-specific hold. Classic output hold remains separate. <!-- @impl: image/herdr/codeflare-herdr-terminal::bootstrap --> <!-- @impl: web-ui/src/stores/terminal-output.ts::scheduleWrite --> [REQ-TERM-040](../../sdd/spec/terminal.md#req-term-040-stable-herdr-pane-scrollback).

### Viewport DOM Desync (instant yank to top)

Public relative scroll APIs resolve from clamp-prone DOM scrollTop, which can desync during refit/keyboard/pane/address-bar geometry. `scrollBufferLines()` directly commands BufferService with buffer-derived delta and paired repaint; xterm absolute sync then repairs DOM. Normal wheel/touch/page/bottom navigation uses this route; refits retaining readers explicitly resync. Private helper falls back publicly only if internals absent; pin compatibility remains image/test-owned. User input routes reanchor normal-buffer readers, never alternate application history ([AD110](../decisions/README.md#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops)).

#### Keyboard-Open Suppression

Keyboard lifecycle owns transition fit/bottom, ResizeObserver adds no redundant keyboard-open snap, generic correction stays inactive. Output delegates native shifts, never post-write correction. Keyboard close returns bottom-following and later manual ownership persists until bottom. [REQ-MOB-012](../../sdd/spec/terminal.md#req-mob-012-scroll-anchoring-during-keyboard-transitions).

### Bottom-Following Re-Anchor

Synchronous onScroll compares follower/intent before paint, reentrancy-gates bottom anchoring and yields to readers. Writes only defer/drop/write unchanged; no callback distance restoration, line correction or post-write snap. Integrated native-like feedback tests prove no movement/correction loop ([REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming) AC2/AC3).

### Scroll Stability Overhaul Context

Current mechanisms are synchronous follower guard, persistent correlated manual ownership, external floating-button intent, explicit touch-keyboard ownership and fixed scrollback cap. Earlier competing fix iterations are historical, not additional current mechanisms. Original narrative/history remains in [the immutable mobile guide](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/mobile.md#scroll-stability-overhaul-context).

<a id="websocket-recovery"></a>
## Transport Recovery

### Retryable Close Codes

Retry 1001/1006/1011/1012/1013 with equal-jitter exponential backoff indefinitely while retryable. Reset on open/visibility return, pause hidden. Normal 1000/unclassified intentional close stays disconnected pending D1 status. 4503 is definitive only when owner-scoped D1 is stopping/stopped and immediately ends retry; network failure/counter/SDK state cannot synthesize it. Failed existing-runtime health/readiness/forward yields retryable 1013 before rate budget, not a replacement start. The original KV-polling wording is obsolete. [REQ-TERM-003](../../sdd/spec/terminal.md#req-term-003-automatic-websocket-reconnection-on-transient-failures), [REQ-TERM-004](../../sdd/spec/terminal.md#req-term-004-close-code-4503-is-authoritative-no-retry), [REQ-TERM-022](../../sdd/spec/terminal.md#req-term-022-an-unreachable-container-ends-the-upgrade-instead-of-escaping-it).

Input subscription is owned outside reconnect and replaced without duplicates; retries are cancellable. CONNECTING normal teardown lets aborted handlers close on settlement to avoid noisy browser errors; actual stalled handshake times out/force-closes under `WS_CONNECT_TIMEOUT_MS`. Navigation disconnect grace cancels on quick return. Visibility restore reconnects only visible panes. [REQ-TERM-020](../../sdd/spec/terminal.md#req-term-020-terminal-reconnect-teardown-timeout-and-backoff-timing).

Backend recovery/idle/teardown authority is [Sessions & Runtime](container.md#runtime-recovery-and-status), not client retry timing or browser keyboard recovery.

The host transfers resize authority on detach and preserves successor dimensions; the client clears only its own pending authority. Layout's disconnect grace and visible-return refresh cannot let stale cleanup close a newer connection. Original composition traceability follows these owners: <!-- @impl: host/src/session.ts::detach --> <!-- @impl: host/src/session.ts::resize --> <!-- @impl: web-ui/src/stores/terminal.ts::clearPendingResizeAuthority --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/stores/terminal.ts::reconnectDisconnectedTerminals -->

<a id="scroll-stability-integration-test-plan"></a>
## Behavioral Test Matrix

Committed requirement Verification fields in [Terminal](../../sdd/spec/terminal.md) retain original test/manual links. Browser/device checks supply rendering/native event-order evidence where no genuine unit seam exists; this document does not claim those checks were run.

### REQ-MOB-004 test scenarios

1. Stream beyond 5,000 lines: follower remains prompt.
2. Scroll into history, continue output past correlation window: reading position stays still under hold, no trim/drift; bottom return releases bounded units.
3. Return bottom and continue: following resumes.
4. Confirm native viewport overflow remains hidden and sole xterm scroll layer works.

### REQ-MOB-012 test scenarios

1. Tap keyboard-open performs intentional fit/bottom.
2. Keyboard-open output has no generic viewport correction.
3. Close keyboard, then manual reading stays owned until bottom.

### REQ-MOB-019 test scenarios

1. Open-keyboard vertical swipes are arrows, including fullscreen tracking.
2. Closed-keyboard fullscreen swipes use application wheel path.
3. Close keyboard and verify normal scrollback navigation resumes.

### Mobile device acceptance

Phone/tablet command input/output/scrollback; Samsung address-bar top/bottom and back-dismiss; visibility return (Chrome reset/Samsung bounce); Fold screen/orientation changes; sibling MultiView keyboard handoff; first microphone/clipboard permission and IME commit; Herdr single activation/jitter/cancel/scroll/no-keyboard-reopen; open vs closed Pi viewport focus; OSC52 trusted recovery; modified/touch link no terminal side effects; content-free diagnostics; decorative retirement; renderer no zero-height fit.

<a id="specification-coverage"></a>
## Requirement and Source Map

| Concern | Requirements | Source | Evidence |
|---|---|---|---|
| Mode/topology/visibility | REQ-TERM-001/007/011/012/013/016/017/018/030/034 | TerminalArea/workspace/tabs/grid | Mode/focus/visible socket behavior |
| Terminal wire/render | REQ-TERM-002/003/004/008/014/019/020/021/022/043/044 | routes/host/terminal store/hooks | Raw/control/retry/restore/atomic output |
| Herdr browser compatibility | REQ-TERM-032/036/037/040/041/042 | mouse/gesture/OSC52/link/output | Pointer/keyboard/clipboard/fullscreen/device |
| Focus/keyboard/fit | REQ-MOB-001/002/003/009/010/011/013/014/015/016/021/022 | mobile/input/hooks/Layout/Vault | Tests plus deployed-device evidence |
| Touch/voice/diagnostics | REQ-MOB-005/006/007/017/019/020/023 | gestures/floating/speech/debug | Mode input and content-free trace |
| Cursor/scroll/decorative | REQ-MOB-004/008/012/018 | xterm/scroll/CSS/SplashCursor | Burst/fit/device/background |
| IDE workspace/proxy | REQ-IDE-001/002/003/004/012/015/035/047/048 | Worker/host/supervisor/UI | Session path/clean workspace/launch |
| IDE integration/continuity | Browser IDE domain | [Package README](../../openvscode/README.md) | Owned package tests/image/deployed acceptance |
| Local presence | REQ-TERM-045, Session Lifecycle | presentation/session store/hooks | Planned ordered cross-device/outage evidence |

## Related Documentation

- [Sessions & Runtime](container.md#container-startup)
- [Architecture](architecture.md#frontend-solidjs--xtermjs)
- [API Reference](api-reference.md)
- [Browser IDE package](../../openvscode/README.md)
- [Browser IDE requirements](../../sdd/spec/browser-ide.md)
- [Browser Run requirements](../../sdd/spec/browser-run.md) — separate automation domain
- [Storage & Sync](storage-and-sync.md)
- [Security](security.md)
- [Troubleshooting](troubleshooting.md)
