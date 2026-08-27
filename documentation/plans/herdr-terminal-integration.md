# Herdr terminal integration implementation plan

**Branch:** `feat/herdr-terminal-integration`  
**Decision:** One Codeflare xterm.js surface and one Herdr runtime per backend Terminal session.  
**Status:** Ready for SDD and test-first implementation.

## Product decision

Herdr owns terminal topology inside a Codeflare session. Users create Bash or agent tabs, splits, panes, and workspaces in Herdr. Codeflare removes its own per-session terminal tabs, saved layouts, and within-session tiling.

Codeflare continues to own backend session lifecycle, authentication, WebSocket transport, xterm.js rendering, reconnect, resize authority, idle accounting, storage policy, notifications, and MultiView across backend sessions.

This split removes duplicate controls rather than stacking one multiplexer UI on another. Keeping six outer terminals would waste processes and leave users deciding whether a "tab" belongs to Codeflare or Herdr. That design is not worth preserving.

## Target architecture

```text
Single session view

Browser xterm.js
  -> authenticated Codeflare terminal WebSocket
  -> existing host Session and node-pty
  -> Codeflare Herdr launcher
  -> official Herdr client
  -> named Herdr server: cf-<backend-session-id>
  -> Herdr tabs, panes, shells, and agents
```

```text
MultiView

Codeflare TerminalGrid
  |- session A xterm.js -> Herdr server cf-<session-A>
  |- session B xterm.js -> Herdr server cf-<session-B>
  `- session C xterm.js -> Herdr server cf-<session-C>
```

xterm.js remains the renderer. The official Herdr client emits ANSI through the existing `node-pty` and WebSocket path. Input, mouse sequences, focus, and resize travel back through the same path. No Herdr browser client or public Herdr endpoint is needed.

Terminal ID `1` remains an internal compatibility detail. Keep `/api/terminal/{sessionId}-1/ws`, host `Session`, `SessionManager`, prewarm adoption, the headless xterm restore path, and current raw/control frame protocol. The UI must never expose Codeflare terminal IDs or create IDs 2 through 6.

## Launch scope

Launch includes:

- Herdr `v0.8.2`, commit `9eb521456ac0d19d3ab3d9d7cea3cca10baa8a4c`.
- Linux x86-64 artifact with SHA-256 `976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4`.
- One ephemeral named Herdr runtime per backend Terminal session.
- One xterm.js surface in single-session view and one surface per member session in MultiView.
- Configured session agent bootstrapped once into Herdr's initial pane.
- New Herdr tabs and panes opening plain Bash unless the user explicitly starts another command.
- Existing Codeflare notification semantics, browser clipboard boundary, lifecycle, and Browser IDE behavior.

Launch excludes:

- Herdr topology persistence across container replacement.
- Browser IDE default or automatic Herdr integration.
- A browser implementation of Herdr's private protocol.
- New Worker routes for Herdr sockets or APIs.
- Codeflare controls for Herdr tabs, panes, or layouts.
- Official Herdr agent integrations beyond what launch notifications require.
- Runtime self-update, plugin installation by Codeflare, remote Herdr access, Kitty graphics, and pane-history persistence.
- A fallback setting that keeps old Codeflare tabs and tiling indefinitely.
- Deployment to `enterprise integration`, `enterprise`, or production; this change deploys only to `integration`.

These exclusions are deliberate. Each would create another ownership boundary before the basic terminal path has production evidence.

## Phase 1: Specify the new contract

Change SDD before implementation.

1. Add an architecture decision after the current final AD. It must state:
   - Herdr owns topology within one backend Terminal session.
   - Codeflare owns one outer terminal surface per backend session.
   - MultiView remains Codeflare-owned cross-session topology.
   - Existing terminal route, `node-pty`, reconnect, and security boundaries remain unchanged.
   - Herdr runtime state is container-local for launch.
2. Replace terminal requirements that promise six Codeflare tabs and Codeflare tiling:
   - retire or rewrite `REQ-TERM-001`, `REQ-TERM-006`, `REQ-TERM-007`, `REQ-TERM-009`, and `REQ-TERM-030`;
   - amend `REQ-TERM-002`, `REQ-TERM-005`, `REQ-TERM-011`, `REQ-TERM-012`, `REQ-TERM-016`, `REQ-TERM-017`, `REQ-TERM-023`, `REQ-TERM-024`, `REQ-TERM-026`, and `REQ-TERM-028`;
   - preserve stable anchors where requirements continue to describe the same behavior.
3. Update related wording in `sdd/spec/session-lifecycle.md`, `agents.md`, `mobile.md`, `browser-ide.md`, `security.md`, `storage.md`, and `operations.md`.
4. Record removal of saved per-session tabs/layouts in `sdd/spec/changes.md`.
5. Update `sdd/README.md`, glossary, architecture lanes, container lane, mobile lane, configuration docs, and README claims.

No touched requirement may remain `Partial` because implementation stopped halfway. Existing notification requirements that are already `Partial` remain truthful; the user owns later manual product acceptance.

## Phase 2: Package Herdr immutably

Write image contract tests first, then modify packaging.

1. Add the exact release URL, version, commit, and checksum to `Dockerfile`.
2. Verify SHA-256 before installation. Install `/usr/local/bin/herdr` read-only for normal runtime use.
3. Copy the upstream Apache-2.0 license and a small provenance record into the image attribution inventory.
4. Add managed config under an image-owned path with:
   - onboarding disabled;
   - Bash login shell;
   - update and manifest checks disabled;
   - sound disabled;
   - pane history disabled;
   - Kitty graphics disabled;
   - mouse capture enabled;
   - no window-title ownership.
5. Add complete-image smoke assertions for `herdr --version`, executable mode, license, config, and absence of runtime installer or mutable `master` URLs.
6. Add any new `COPY` source to `.github/workflows/container-image.yml` hash ownership and its guard test. Existing SBOM and Trivy stages remain authoritative.

Do not remove `node-pty`, `@xterm/headless`, or `@xterm/addon-serialize`. They still implement Codeflare's outer transport, reconnect snapshot, and resize behavior.

## Phase 3: Add the fixed launcher

Create one image-owned launcher, for example `image/codeflare-herdr-terminal`, and launch it through existing `TERMINAL_COMMAND` wiring.

Behavioral tests come first. The launcher must:

1. Validate `SESSION_ID` against the same backend-session identity contract already trusted by the host. It must reject missing, malformed, option-leading, or overlong values.
2. Derive exactly one Herdr name: `cf-<SESSION_ID>`. Never accept a browser-provided Herdr name.
3. Use a mode-0700 runtime root under `/run/codeflare/herdr/<SESSION_ID>` for sockets, logs, markers, and ephemeral session state.
4. Export `TERMINAL_APP_STARTED=1` before Herdr starts. This prevents every Herdr-created login shell from repeating Codeflare's `.bashrc` agent autostart.
5. Start or attach the official Herdr client for the named runtime using the pinned v0.8.2 CLI contract.
6. On first runtime creation only, wait for the local Herdr API and bootstrap the configured Codeflare session command into the initial pane:
   - map Codeflare's closed agent enum to fixed Herdr kinds and fixed argv arrays;
   - launch `htop`, `yazi`, and `lazygit` as fixed ordinary pane commands;
   - leave Bash or empty configuration untouched;
   - discover the initial pane from Herdr's API response or snapshot rather than assuming a permanent pane ID.
7. Use an atomic marker under the runtime root so reconnect and outer PTY restart cannot start a second agent.
8. Keep startup errors bounded and omit environment values, socket contents, terminal output, and credentials.
9. If the client detaches while the outer PTY remains alive, show a short reattach prompt or perform a bounded reattach. Do not leave a dead blank terminal.

Keep `TAB_CONFIG` as the existing backend-owned session-agent snapshot for this release. Read only entry `1`; ignore legacy entries 2 through 6. A later cleanup can rename that API after deployed behavior is stable.

## Phase 4: Minimal host and container lifecycle hooks

Adapt existing machinery rather than replacing it.

### Host

- `host/src/server.ts`: set the fixed launcher as the default Terminal workspace command. Keep early port binding, init-flag wait, prewarm `Session`, adoption, first-output settle, hard timeout, and VS Code workspace branch.
- `host/src/session.ts`: keep PTY spawning, headless restore, input filtering, activity classification, client coordination, resize authority, and raw output. Add one cleanup callback that stops the derived Herdr session before killing the outer PTY.
- `host/src/session-manager.ts`: keep prewarm adoption and one internal terminal ID. Existing cap logic can remain because the UI creates only terminal `1`; do not redesign it for launch.
- `host/src/terminal-ws.ts`: reject or ignore client attempts to create non-primary terminal IDs through existing route validation. Preserve all control frames and close-code behavior.
- `host/src/prewarm-config.ts`: continue reading configured command from `TAB_CONFIG[1]`, but readiness must prove the Herdr client is attached and bootstrap reached a terminal state. First ANSI repaint alone is not sufficient.

### Cleanup

Add a small fixed helper that runs `herdr session stop cf-<SESSION_ID>` with a short timeout, then terminates any registered runtime descendants if Herdr does not stop. Invoke it from:

- outer PTY kill;
- unused prewarm expiry;
- host `SIGTERM` and `SIGINT` shutdown;
- entrypoint shutdown before final R2 drain.

Cleanup must be idempotent. Browser WebSocket disconnect must not stop Herdr or its inner processes. Codeflare's DO idle policy remains authoritative and eventually stops the whole container.

### Entrypoint

- Create Herdr runtime directories with mode 0700 near existing `/run/codeflare` setup.
- Collapse standalone terminal `.bashrc` autostart to one configured session command and let the launcher own first-pane bootstrap.
- Preserve `MANUAL_TAB=1` behavior used by Browser IDE's Bash profile.
- Preserve Browser IDE Session Agent profile behavior.
- Do not add Herdr paths to R2 filters.

## Phase 5: Remove Codeflare's duplicate terminal UI

Write frontend behavior tests first.

Delete:

- `web-ui/src/stores/session-tabs.ts`;
- `web-ui/src/stores/tiling.ts`;
- `TerminalTabs.tsx`, `TilingButton.tsx`, `TilingOverlay.tsx`, and `TiledTerminalContainer.tsx`;
- their dedicated styles and tests;
- `@thisbeyond/solid-dnd` if no import remains.

Simplify:

- `web-ui/src/types.ts`: remove `TerminalTab`, `SessionTerminals`, and `TilingState`. Keep `TileLayout` for MultiView's cross-session grid.
- `web-ui/src/stores/session.ts`: remove `terminalsPerSession`, tab persistence, tab actions, tiling registration, and process-label updates.
- `web-ui/src/components/TerminalArea.tsx`: render one `<Terminal terminalId="1">` for single-session view. Keep `TerminalGrid` for MultiView, also fixed to terminal `1` per member.
- `web-ui/src/components/Layout.tsx`: remove tiling overlay state and handlers. Visible terminal keys become the visible session panes only.
- `web-ui/src/stores/terminal-workspace.ts`: make session panes fixed to terminal `1`; retain MultiView membership, capacity, focus, persistence, and layout.
- `web-ui/src/stores/terminal.ts` and `web-ui/src/api/client.ts`: keep the current compound identity and route but remove manual-tab and process-label behavior.
- `FloatingTerminalButtons.tsx`: target terminal `1` directly.

At frontend initialization, remove `codeflare:terminalsPerSession` without parsing or migrating it. Preserve `codeflare:terminalMultiViewWorkspace`. No user depends on old saved layouts, and carrying dead state forward would be pointless migration code.

Existing frontend unit contracts are updated only as needed for the source migration and CI. Do not add UI, browser E2E, or acceptance suites; the user will test the rendered product manually.

## Phase 6: Preserve notifications and browser terminal boundaries

Keep every notification, OSC 52 clipboard, and right-click ownership change in one separate commit. This compatibility layer is intentionally removable without reverting the core Herdr runtime or single-surface migration.

Herdr's inner terminal emulator consumes Codeflare's current OSC 777 frames. Do not pretend those bytes reach the outer host parser.

### Fixed notification transport

1. Add a Codeflare-owned helper callable only inside the container. It accepts one enum: `input-required`, `task-completed`, or `task-failed`.
2. Under `HERDR_ENV=1`, managed Pi and Claude notification producers invoke that helper instead of writing OSC 777. Outside Herdr they retain current exact OSC bytes.
3. The helper sends a bounded request to one loopback-only, Bearer-protected host endpoint.
4. Host validates exact method, content type, body size, enum, primary runtime identity, and no extra fields, then enqueues through the existing `AgentEventQueue`.
5. Existing away/suppress/grant/drain/Push/cancellation behavior remains unchanged. The endpoint must not record input, extend idle, wake a stopped container, or accept display prose.
6. Logs include event kind and outcome only. Never log request authorization or user content.

Tests must prove wrong Bearer, non-primary identity, unknown kind, duplicate keys, extra fields, malformed JSON, and oversized bodies fail before enqueue.

### Clipboard and mouse

- Disable Codeflare's bubbling right-click paste handler for standalone Herdr terminals. Herdr owns right-click menus.
- Add an OSC 52 write handler at the xterm.js boundary. Accept only the standard clipboard selector, bounded base64, valid UTF-8 text, and no read query. Respect existing clipboard permission settings and never log clipboard content.
- If browser user-activation rules reject the write, report a small inert failure state. Do not loosen permission checks or build a second clipboard service for launch.
- Keep Ctrl+V, mobile paste, keyboard handling, touch gestures, URL detection, and resize code unless deployed Herdr evidence requires a focused fix.

## Phase 7: CI coverage and verification

Project policy remains test-first and CI-owned for source behavior. Add or update only focused source, unit, route, launcher, host, and complete-image CI contracts. Do not add UI suites, browser E2E, deployed acceptance automation, or resource acceptance harnesses.

CI coverage includes immutable packaging, launcher validation and one-time bootstrap, raw terminal transport, prewarm readiness, deterministic cleanup, notification ingress boundaries, OSC 52 parsing boundaries, single-surface state removal, MultiView state preservation, and unchanged Browser IDE image smoke. Local verification is limited to repository-approved bounded syntax checks; CI is authoritative.

The user will perform manual product testing after the `integration` deployment.

## Rollout

1. Complete source, unit, route, host, and complete-image CI on the exact PR head.
2. Deploy that reviewed head only to `integration`.
3. Hand manual product testing to the user. Do not deploy another environment or add automated UI, E2E, or acceptance work.
4. Later persistence, managed integrations, Browser IDE profiles, or broader promotion require separate user instructions and SDD decisions.

## Completion criteria

Implementation is complete when:

- each standalone backend Terminal session exposes one xterm.js surface backed by one named Herdr runtime;
- Herdr alone owns inner tabs, Bash tabs, workspaces, splits, panes, and agent status;
- configured session agent starts exactly once in the initial Herdr pane;
- new Herdr tabs and panes start plain Bash;
- Codeflare per-session tabs, tiling controls, saved layout state, process labels, and unused drag dependency are gone;
- MultiView still renders one live Herdr surface per selected backend session;
- browser reconnect preserves inner processes while the container lives;
- explicit stop, delete, prewarm expiry, and shutdown leave no Herdr descendants;
- Worker/DO auth, ownership, Origin, rate-limit, no-wake, close-code, Bearer, and idle boundaries remain unchanged;
- notification, clipboard, and right-click boundaries pass focused source and CI contracts; rendered interaction remains for user manual testing;
- Browser IDE startup and terminal profiles remain unchanged;
- immutable pin, attribution, SBOM, Trivy, resource, and rollback gates pass;
- all touched SDD requirements and docs are truthful;
- exact-head review and CI are green, then the same head is deployed only to `integration`;
- UI, E2E, and manual product acceptance remain explicitly user-owned.

## Advisor review disposition

Advisor agreed with one Herdr runtime and one xterm.js surface per backend session. Most important correction: keep Codeflare's existing `node-pty`, host `Session`, `SessionManager`, compound `-1` route, reconnect serialization, resize authority, and input classification. Replacing those would turn integration into a transport rewrite.

Accepted advisor suggestions are reflected above: fixed launcher, ephemeral runtime, frontend topology deletion, OSC 777 loopback compatibility, OSC 52 handling, right-click handoff, deterministic cleanup, and unchanged Browser IDE behavior. No additional abstraction, route redesign, persistence layer, or browser Herdr protocol was added.
