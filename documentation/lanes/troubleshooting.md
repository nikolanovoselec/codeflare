# Troubleshooting

Diagnostic commands, common failure modes, and resolution steps.

**Audience:** Operators

**Owns:** symptom, diagnosis, likely cause, corrective action, verification, and escalation. **Does not own:** canonical endpoint contracts, configuration definitions, implementation composition, or private runbooks.

## Contents

- [Start Here](#start-here)
- [Troubleshooting Recipes](#troubleshooting-recipes)
  - [Browser IDE](#browser-ide)
  - [Container Image and Startup Compatibility](#container-image-and-startup-compatibility)
  - [Authentication and Setup](#authentication-and-setup)
  - [Terminal and Mobile](#terminal-and-mobile)
  - [Session and Container Lifecycle](#session-and-container-lifecycle)
  - [Storage and Vault](#storage-and-vault)
  - [Agent Runtime, Review, and CI](#agent-runtime-review-and-ci)
- [Failure Index](#failure-index)
- [Detailed Recovery Notes](#detailed-recovery-notes)
- [GitHub Integration](#github-integration)
- [Browser Run](#browser-run)
- [Diagnostic Command Reference](#diagnostic-command-reference)
- [Related Documentation](#related-documentation)
- [Requirement and Source Map](#requirement-and-source-map)

---

## Start Here

1. **Classify the boundary.** If login, setup, or every route fails, start with public `/api/health`, provider discovery, Worker logs, and [Authentication](authentication.md). If only one session fails, continue with its Worker session record and container status.
2. **Classify lifecycle versus transport.** `creating`, `running`, `stopping`, and `stopped` are durable lifecycle signals; terminal or IDE failure while `running` is a transport/readiness problem. Do not rewrite lifecycle state from a single failed probe.
3. **Correlate the shared runtime.** Terminal, Browser IDE, `/activity`, and private host `/health` share the container listener. A multi-surface failure points below the client; a single-surface failure points to that proxy or client path.
4. **Separate persistence from presentation.** Vault or workspace content errors require the R2/bisync evidence in [Storage & Sync](storage-and-sync.md); editor readiness alone does not prove persistence completed.
5. **Verify the correction.** Capture request/session identifiers, the failing step, relevant Worker and container logs, and the observable expected result. Escalate only after the corrective action below fails with that evidence.

Every recipe inherits this record contract unless it overrides a field: **Symptom** is the heading/first paragraph; **Diagnose** uses the named boundary and correlated evidence; **Cause** and **Fix** are explicit; **Verify** repeats the exact failing path and confirms the stated expected result; **Escalate** attaches identifiers/logs when the verified fix fails. State-changing or destructive fixes must state their special rollback before execution.

<a id="common-issues"></a>
## Troubleshooting Recipes

<a id="browser-ide"></a>
**Browser IDE**

### VS Code session stays on Preparing or opens another tab ([REQ-IDE-049](../../sdd/spec/browser-ide.md#req-ide-049-dashboard-vs-code-startup-and-recovery), [REQ-IDE-050](../../sdd/spec/browser-ide.md#req-ide-050-browser-ide-status-and-ownership), [REQ-IDE-054](../../sdd/spec/browser-ide.md#req-ide-054-browser-ide-card-activation))

**Symptom:** A ready VS Code card never opens its editor, a failed card never retries, the session enters a terminal view, or activating the ready card creates another editor tab.

**Cause:** The stored session workspace may not have reached `CODEFLARE_SESSION_WORKSPACE`, host editor readiness may have timed out, or the browser may have blocked the stable named window. Terminal panes or WebSockets for that session indicate stale frontend routing rather than an editor problem.

**Fix:** Keep the session on the dashboard. Activate the failed card to retry, then activate the ready card to open the editor; allow pop-ups for the Codeflare origin if the dashboard reports blocking. Inspect the session record, container environment, private host `/health`, code-server supervisor log, and the `Codeflare Session Agent` integrated terminal. Do not convert the session by changing **Default workspace**, create a fallback host PTY, attach the editor to terminal tab 1, or force-close the retained browser tab. Stop and delete remain available throughout recovery.

### Browser IDE Repeatedly Disconnects with WebSocket Code 1009

**Symptom:** The Browser IDE connects successfully, then the Management and Extension Host connections immediately close with code `1009` and enter a reconnect loop. Repeated reconnects can eventually receive `429` because they consume the shared WebSocket connection budget.

**Cause:** The host bridge reused the terminal protocol's 64 KiB WebSocket message limit. VS Code sends protocol messages around 256 KiB, so the `ws` receiver classified normal IDE traffic as too large and closed the connection ([REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy) AC6).

**Fix:** Deploy a host build where `createVscodeWebSocketServer` gives the IDE its dedicated bounded payload limit. Do not raise `WS_MAX_PAYLOAD`; that 64 KiB limit still protects terminal and Vault traffic.

**Verify:** In the browser console, the IDE's Management and Extension Host sockets remain connected without recurring code-`1009` close events. CI's `openvscode-proxy.test.js` also sends and echoes a 256 KiB binary protocol message through the real `ws` endpoint.

### Browser IDE URL exposes or accepts a workspace selector ([REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-clean-browser-ide-url-and-private-workspace-selection), [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection))

**Symptom:** The browser lands on `?folder=/home/user/workspace`, a public `folder`, `workspace`, or `ew` query changes the opened workspace, or the clean URL opens an empty window whose manual folder selection is rejected.

**Cause:** The deployment predates clean fixed-workspace routing, only one defense-in-depth check was updated, or the pinned Code OSS workbench meta-element drifted. A private upstream query alone is insufficient because Code OSS reads the browser location or server-provided `folderUri`.

**Fix:** Use a fresh session on an image where Worker and host reject decoded selector keys, the private root hop injects the fixed folder, and the host projects its equivalent `folderUri` into the root workbench configuration. The normal public location is `/api/vscode/<sessionId>/`. A projection mismatch returns `VSCODE_WORKBENCH_CONFIGURATION_INVALID`; deployment image smoke must validate the packaged root HTML before deployment. This is not an OS sandbox; terminals, trusted extensions, and agents retain container filesystem access.

### Browser IDE theme, keyboard layout, Explorer state, or open files do not persist ([REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-016](../../sdd/spec/browser-ide.md#req-ide-016-bounded-ide-state-capture-and-restore-ordering))

**Symptom:** A fresh session returns to the default theme or keyboard layout, loses Explorer/open-file state, or unexpected IDE databases appear in persistent storage.

**Cause:** code-server may not have been reaped before final sync, `~/.codeflare/ide-ui-state.json` may be absent or invalid, or the snapshot/filter allowlist may have drifted.

**Fix:** Confirm capture runs after generation cleanup, the snapshot is a mode-0600 JSON file no larger than 1 MiB, and only `ide-ui-state.json` plus `ide-extensions.json` survive the `~/.codeflare/**` R2 filter. Theme values and string-valued `keyboard.layout` are the only allowlisted User settings in the UI snapshot. Never sync `/run/codeflare/openvscode/data`, `workspaceStorage`, `globalStorage`, SecretStorage, authentication, chat history, logs, WAL, or SHM. Allowlisted workspace rows must match their key-specific canonical-resource schemas; unknown fields and opaque strings are invalid. Managed inventory settings must be reapplied after restore. <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: scripts/browser-ide-ui-state.py::restore -->

### User-installed Browser IDE extensions do not return or uninstall ([REQ-IDE-036](../../sdd/spec/browser-ide.md#req-ide-036-persistent-user-managed-extensions), [REQ-IDE-037](../../sdd/spec/browser-ide.md#req-ide-037-lazy-extension-restoration), [REQ-IDE-038](../../sdd/spec/browser-ide.md#req-ide-038-extension-warning-acknowledgement), [REQ-IDE-040](../../sdd/spec/browser-ide.md#req-ide-040-user-extension-allowance-policy))

**Symptom:** An Open VSX extension installed through the native Extensions view disappears in a fresh session, an uninstalled extension returns, restore shows one failure warning, or the arbitrary-code warning repeats.

**Cause:** `~/.codeflare/ide-extensions.json` may be absent, invalid, over 64 KiB, redirected, or excluded by rclone; the selected version may no longer exist in Open VSX; the session registry or `.obsolete` marker may not have reached the debounced/post-reap capture; or the warning acknowledgement may not have completed before the session closed. Gallery and warning failures deliberately preserve intent rather than rewriting the manifest.

**Fix:** Inspect metadata only; never log setting values. The mode-0600 manifest requires version 1, lowercase IDs, at most 50 entries, and 32 KiB of bounded settings. Confirm code-server uses `/run/codeflare/openvscode/data/extensions`, with fixed inventory symlinks and real user directories. Check `extensions.json` and bounded `.obsolete` identities; absence alone preserves intent.

Verify `extensions.allowed` retains `"*": true` plus the Codeflare entry. The welcome builtin must activate on `onStartupFinished`, capture setting-only changes, flush pending capture during deactivation, and signal `/run/codeflare/sync/sync-daemon.pid` after changed atomic writes. Never sync VSIX files, extension directories, `User` data, SecretStorage, or Accounts. Exact-version not-found receives one unpinned fallback; other failures wait for a fresh activation. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> <!-- @impl: entrypoint.sh::_openvscode_capture_extensions -->

### Welcome to Codeflare opens blank or beside code-server Welcome ([REQ-IDE-024](../../sdd/spec/browser-ide.md#req-ide-024-codeflare-browser-ide-welcome))

**Symptom:** **Welcome to Codeflare** is blank, or a completely fresh browser opens both the owned editor and code-server's default Welcome editor.

**Cause:** A blank owned editor means the renderer rejected the host's unused multi-source `webview.cspSource` after creating the panel. Two welcome editors mean the fresh browser retained code-server's default startup editor in addition to the owned extension timer.

**Fix:** Use the owned renderer's self-contained nonce-bound HTML and manage `workbench.startupEditor` to `none` for every inventory before launch. Do not widen CSP, add external resources, or patch code-server. A completely fresh browser remains the single-editor evidence boundary. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/welcome.ts::renderWelcomeHtml --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-009 + REQ-IDE-021 + REQ-IDE-024: base settings suppress the legacy startup editor) -->

### Native Browser IDE agent is missing ([REQ-IDE-005](../../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-011](../../sdd/spec/browser-ide.md#req-ide-011-file-review-with-codeflare), [REQ-IDE-013](../../sdd/spec/browser-ide.md#req-ide-013-account-backed-code-review-suppression), [REQ-IDE-014](../../sdd/spec/browser-ide.md#req-ide-014-active-editor-review-with-codeflare))

**Symptom:** A Pi session shows Copilot setup instead of Codeflare in the main Chat, an editor right-click shows upstream **Code Review** but not **Review with Codeflare**, a Claude session has no Anthropic Spark panel, or an unsupported agent unexpectedly has an agent extension.

**Cause:** The session may be non-advanced, tab 1 may not contain an exact supported command, the wrong immutable inventory may be selected, Pi's extension-qualified proposal may be absent, or the official Claude package may have failed identity/host validation. A container already running during image deployment keeps its old filesystem and menu contributions until that session restarts.

**Fix:** Reproduce in a fresh or restarted session, then inspect tab 1, `CODEFLARE_SIDEBAR_AGENT`, `/opt/codeflare/openvscode/extensions/{pi,claude,none}`, and `/opt/code-server/lib/vscode/extensions/copilot`. Pi must contain only `codeflare-agent-sidebar` and launch with `--enable-proposed-api codeflare.codeflare-agent-sidebar`; the bundled Copilot directory must be absent; Claude must contain only `anthropic.claude-code`; `none` must be empty. Do not sign into Copilot. Deploy only after complete-image evidence reports `host_discovery` for Pi and Claude, an empty inventory, `DEFAULT_NATIVE_PI_OK`, `OFFICIAL_CLAUDE_OK`, cold readiness, process count, and RSS.

### Pi native Chat fails or lacks editor context ([REQ-IDE-006](../../sdd/spec/browser-ide.md#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-007](../../sdd/spec/browser-ide.md#req-ide-007-ide-guarded-approval), [REQ-IDE-019](../../sdd/spec/browser-ide.md#req-ide-019-codeflare-eligibility-in-editor-inline-chat), [REQ-IDE-020](../../sdd/spec/browser-ide.md#req-ide-020-native-pi-editor-proposal-execution), [REQ-IDE-025](../../sdd/spec/browser-ide.md#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-026](../../sdd/spec/browser-ide.md#req-ide-026-native-inline-chat-edit-validation), [REQ-IDE-041](../../sdd/spec/browser-ide.md#req-ide-041-native-chat-coordinate-representation), [REQ-IDE-043](../../sdd/spec/browser-ide.md#req-ide-043-native-pi-provider-history-isolation), [REQ-IDE-030](../../sdd/spec/browser-ide.md#req-ide-030-native-inline-chat-result-envelope), [REQ-IDE-033](../../sdd/spec/browser-ide.md#req-ide-033-controller-owned-inline-review-lifecycle), [REQ-IDE-034](../../sdd/spec/browser-ide.md#req-ide-034-bounded-inline-lifecycle-diagnostics), [REQ-IDE-021](../../sdd/spec/browser-ide.md#req-ide-021-account-free-browser-ide-chrome), [REQ-IDE-022](../../sdd/spec/browser-ide.md#req-ide-022-native-pi-blocking-ui-protocol))

**Symptom:** Codeflare reports `Language model unavailable`, editor Inline Chat shows only a Copilot login, cannot identify the active file/selection, reports `UNSUPPORTED_UI_REQUEST` for a Pi question, never settles, or rejects a guarded operation.

**Cause:** `Language model unavailable` means the pinned Code OSS host rejected the request before entering the participant because the hidden `copilot` fallback was missing from absent-request-model resolution. A Copilot-only Models control means the owned extension did not activate before initial picker resolution, or the visible `codeflare` model was missing, was not panel/editor default, or did not satisfy the editor tool-calling filter. Other failures can mean the active URI is outside the canonical workspace or uses a symbolic-link alias, editor context exceeds its bound, or the fixed RPC child emitted invalid JSONL.

**Silent inline wait:** Integration deployment `31918973796` spun forever while panel Chat worked because its inline slash command was handled without starting an agent turn. In current builds, first confirm either a matching `command:codeflare-inline-edit` error or the nested dispatch's `<runtime>` `send_user_message` error is rejected immediately before investigating proposal validation.

**Fix:** For model-boundary or editor-picker errors, verify the packaged Pi manifest enables `chatParticipantAdditions`, `chatParticipantPrivate`, `chatProvider`, and `defaultChatParticipant`, contributes `codeflare.pi` at panel and editor locations, publishes a hidden panel-default `copilot` fallback, and publishes a selectable panel/editor-default model under the distinct `codeflare` vendor with tool calling and no authorization. Generation through either adapter must still reject while participant requests use local Pi RPC. If custom agents appear twice, verify Pi User settings contain `"chat.agentFilesLocations": { "~/.claude/agents": false }`; retain `~/.copilot/agents` and do not remove Pi's own `~/.pi/agent/agents`. Do not sign into Copilot.

For request failures, confirm the file is under `/home/user/workspace`, the participant is `codeflare.pi`, and Pi uses the fixed RPC/no-session flags. Code OSS 1.132 editor Inline Chat does not render ordinary unrestricted-participant output. [AD127](../decisions/README.md#ad127-native-inline-chat-uses-proposal-only-pi-turns-and-host-owned-text-edits) records host-owned edit execution, [AD128](../decisions/README.md#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller) records controller ownership, and [AD135](../decisions/README.md#ad135-inline-chat-requires-one-host-correlated-result) records the mandatory edit-or-no-change result. A healthy editor request stays in Inline Chat, immediately shows bounded progress and native reasoning, emits start/edit/done parts for the invoking document, and leaves visible Keep/Close actions to the native controller. `noChange` is reserved for an already-satisfied request or one with no valid safe edit; use Panel Chat for informational explanations. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode -->

`Invalid Inline Chat edit range` only when text is selected indicates a coordinate-contract regression: editor selection and whole-range context must remain zero-based UTF-16 positions because Pi's result tool and the host validator use that exact basis. Panel Chat keeps one-based coordinates for human-readable context. Do not weaken document-bound validation to accept shifted ranges; that turns a visible adapter bug into edits against the wrong text. <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::snapshotActiveEditor -->

The managed `accessibility.openChatEditedFiles: false` disables only the configuration-gated opener; a different edit/session URI still activates the controller's unconditional side-group path. It never opens panel Chat, directly writes the file, shows a notification review action, invokes a Chat Editing command, or reopens the document. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode -->

If an edit opens another tab or the Inline widget lacks Keep/Close, open **View: Toggle Output**, select **Codeflare Inline Chat**, reproduce once, and copy the activation, request, stream, `tabsChanged`, and snapshot lines. The revision and settings distinguish stale rollout; request admission distinguishes the wrong surface. Matching sanitized scheme, authority, and basename is not proof of one resource because different directories can contain the same basename. An ordinary duplicate file tab in a new side group still points to hidden renderer/edit URI divergence.

On pinned code-server, verify the root workbench projection gives `folderUri.authority` the canonical public browser host rather than the server's `remote` placeholder. Do not add confirmation UI, reopen the editor, or invoke Chat Editing commands to mask this identity defect. The bounded channel retains scheme, authority without userinfo, basename, and input type; it excludes directory paths, query, fragment, tab labels, and document content. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace -->

If the inline widget remains blank, verify `codeflare-inline-edit` dispatches through `ExtensionAPI.sendUserMessage`, not `ExtensionCommandContext`, then inspect private `location2` admission, the final OpenAI Chat Completions or Responses payload's exact `codeflare_submit_inline_result` choice, active-generation ownership, and document-version/range validation. Focus changes must not alter the captured context or target. A missing, malformed, duplicate, or overlapping result fails closed; a schema-invalid raw result may be corrected within three attempts, and invalid-only settlement reports its category. `edit` must carry one to 64 edits and `noChange` must carry none. After settlement, the prior unrestricted panel tool set must be restored exactly.

A healthy child may remain after completion but never serves terminal Pi. A matching command-attributed or nested runtime dispatch error must retire the backend immediately; unrelated extension errors must not discard a valid result. Inspect RPC events for queue ordering, cancellation or failure retirement, and cold replacement hydration. The required lifecycle outcomes are defined by [REQ-IDE-008](../../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle). <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime -->

A long panel turn should stream provider reasoning through the native thinking presentation and show each argument-free activity category once. OpenAI Responses models such as GPT-5.6 Sol receive `detailed` provider-summary requests because `auto` may remain silent until answer text; Qwen keeps its direct thinking-delta path. If reasoning remains blank or progress accumulates repeated `Running read…` or `Running bash…` rows, verify the packaged Pi extension contains the REQ-IDE-027 provider hook, backend, and participant adapters. Tool arguments, file contents, and hidden raw chain-of-thought must never be projected into the UI. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::requestSidebarReasoningSummary --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-027: sidebar panel requests ask OpenAI Responses models for visible reasoning summaries) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer) -->

### Official Claude panel fails ([REQ-IDE-005](../../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](../../sdd/spec/browser-ide.md#req-ide-006-ide-conversation-context-and-credential-isolation))

**Symptom:** Anthropic's Spark panel is absent, asks for a second login, reports an unsupported platform, cannot connect to editor context, or code-server's unrelated native Chat/Copilot setup appears in a Claude session.

**Cause:** The exact official extension or bundled linux-x64 binary may be missing, the temporary config/settings preparation may have failed, approved credentials/routing may be unavailable, or Anthropic's loopback IDE MCP lock directory may have been rejected. Anthropic's package contributes a separate Claude Code webview rather than a native Chat participant, so a visible native Chat setup means the managed `chat.disableAIFeatures` setting was not restored before launch.

**Fix:** Verify `extensions/claude/anthropic.claude-code/package.json` is the pinned publisher/name/version and its bundled binary is executable. Confirm `/run/codeflare/openvscode/sidebar/claude/config/settings.json` resolves to `/etc/codeflare/claude-sidebar/settings.json`, code-server User settings contain `chat.disableAIFeatures: true`, the isolated `CLAUDE_CONFIG_DIR`, unrestricted `bypassPermissions` mode, dangerous permission skipping, and `disableLoginPrompt`, and `$CLAUDE_CONFIG_DIR/ide` remains private. Use the Claude Code panel with a selection or an `@` reference. The Accounts control is hidden, but authentication APIs remain outside the Claude integration; Codeflare adds no credential bridge. Keep the approved `bypassPermissions` configuration internal to the isolated session, and never expose the MCP port. <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState -->

### Browser IDE agent leaves a duplicate or orphaned process ([REQ-IDE-008](../../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle))

**Symptom:** A Pi request child or official Claude bundled process remains after cancellation, editor restart, or shutdown.

**Cause:** Shared-backend or launch-generation cleanup did not converge before replacement. A single healthy IDE-owned Pi child after normal settlement is expected and is not an orphan.

**Fix:** Do not delete pidfiles first. Cancel the active request or restart the Browser IDE and inspect `/run/codeflare/openvscode/generation.pid`; cleanup sweeps the recorded token even when leader metadata is stale, while processes carrying another token remain untouched. Deactivation blocks queued and new spawns. Use deployment container-image evidence for package identity, process count, and RSS. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration -->

If a normal Pi question fails, inspect the emitted `extension_ui_request`: only bounded `select` and `input` dialogs with bounded optional timeouts are supported in addition to the manifest-backed `confirm` contract; malformed, `editor`, and unknown blocking methods intentionally stop generation. <!-- @impl: openvscode/agent-sidebar/src/pi/approval-bridge.ts::ApprovalBridge --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost -->

The bottom-right provider **Sign In** control is `chat.statusBarEntry`, not the Accounts icon. In Code OSS 1.132 its visibility lives in browser IndexedDB, so writing `workbench.statusbar.hidden` to server-side `User/State/storage.json` is not evidence that it disappeared. Pi sets `chat.disableAIFeatures: true` and reasserts `chatSetupHidden` before refreshing its account-free models; Claude and unsupported inventories retain the same managed disablement. `workbench.activity.showAccounts=false` remains the separate left-side Accounts preference. None of these paths patches code-server or disables authentication. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildUnsupportedOpenVscodeSettings --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState -->

See [`openvscode/README.md`](../../openvscode/README.md), [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-005](../../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](../../sdd/spec/browser-ide.md#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-007](../../sdd/spec/browser-ide.md#req-ide-007-ide-guarded-approval), and [REQ-IDE-008](../../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle).

<a id="container-image-and-startup-compatibility"></a>
**Container Image and Startup Compatibility**

### Enterprise Containers Won't Start / Crash-Loop (Terminal Reconnect Storm)

**Symptom:** In Enterprise Mode, sessions never reach a usable terminal. Worker logs (`codeflare-enterprise-<env>`) show a rapid terminal-WebSocket reconnect storm (~10+ per minute), `Error proxying request to container`, and teardown `Final sync did NOT complete on teardown … The container is not running` — i.e. the container's PID 1 keeps exiting. Plain (non-enterprise) sessions on the same image are unaffected.

**Cause:** A failing command in the `ENTERPRISE_MODE=active` block of `entrypoint.sh`, which runs under `set -euo pipefail`, aborts the script and kills PID 1. The block is full of unguarded `jq` command-substitutions; any one of them failing crashes the container. The first instance of this was a `jq --arg def …`/`$def` — `def` is a reserved jq keyword (function definition), a hard compile error on the bookworm base image's jq 1.6 — which crashed every enterprise container until fixed (see [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC4).

**Diagnose:** Container stdout/stderr is not shipped to Workers logs, so reproduce the enterprise block locally with the same env the Worker fans (`ENTERPRISE_ROUTE_CATALOG`, `ENTERPRISE_DEFAULT_ROUTE`, `ENTERPRISE_DEFAULT_REASONING`) under `set -euo pipefail` and watch for the first non-zero exit. The configured route catalog/default live in the env KV under `setup:dynamic_routes` / `setup:default_route`.

**Fix:** Correct the failing entrypoint command and redeploy the enterprise image. Keep enterprise-block `jq` calls either guarded (`if jq …; then … else warn; fi`) or free of reserved-keyword `--arg` names; `entrypoint-enterprise-pi-models.test.js` now runs the real models.json build and forbids reserved-keyword jq args.

<a id="authentication-and-setup"></a>
**Authentication and Setup**

### New User Has Preseed Configs but No "Docs & Examples"

**Symptom:** A newly provisioned user's R2 bucket contains the agent-config preseed files, but the getting-started Docs & Examples are missing. Clicking **Recreate Docs & Examples** in Settings creates them.

**Cause:** Getting-started docs were seeded only by the one-shot bucket-creation gate, and a freshly created bucket is not always immediately writable on the R2 data plane. That single attempt could fail and be swallowed, and because the create-only gate never re-fired, the docs stayed missing. Agent configs survived because they have other reseed paths (the Recreate button, mode-change reconcile, and the preseed-hash upgrade) that getting-started docs lacked.

**Fix:** Under REQ-STOR-009 AC6, the seed now self-heals on every session start until a `gettingStartedSeeded` user-preference marker is set, so simply starting (or restarting) a session re-seeds the docs without the manual button.

**Verify** in Workers logs by querying the worker for:

- `Seeded getting-started docs` — the self-heal succeeded.
- `Failed to seed getting-started docs; will retry next session` — a transient failure that will retry on the next session start.

### `/api/*` Returns HTML (SPA Swallow)

**Symptom:** An API request returns the SPA's HTML shell instead of JSON.

**Cause:** The request path is missing from the Static Assets `run_worker_first` control-plane list, so the edge serves the SPA fallback before Worker routing.

**Fix:** Ensure `run_worker_first = ["/", "/login", "/login/", "/auth/*", "/api/*", "/public/*", "/landing/*", "/assets/*"]` is present in the `[assets]` section of `wrangler.toml`. A missing `/login` breaks the onboarding rewrite, a missing `/api/*` breaks setup/auth, and a missing `/assets/*` bypasses the immutable Vite-asset policy.

### `/setup` Shows "Access Denied"

**Symptom:** Opening `/setup` displays an Access Denied response instead of the setup flow.

**Cause:** Setup status is not reaching the Worker as JSON, or KV already marks setup complete.

**Fix:** Check that `GET /api/setup/status` returns JSON and verify `setup:complete` in KV is absent or false for first-time setup.

### Auth Error After Successful Access Login

**Symptom:** Cloudflare Access login succeeds, but Codeflare rejects the resulting authenticated request.

**Cause:** `setup:auth_domain` or `setup:access_aud` is stale, causing JWT verification drift, or a stored user key has noncanonical email casing.

**Fix:** Re-run setup configuration and confirm user keys are lowercase.

### HTTP 500 After Login

**Symptom:** The login flow returns HTTP 500 after the identity provider redirects to Codeflare.

**Cause:** The failure may be in request handling, the deployed OAuth callback may not match the provider registration, or session signing may lack `OAUTH_JWT_SECRET`.

**Fix:** Take the `X-Request-ID` value from the 500 response and match it to the `requestId` field on the `Unexpected error` line in `wrangler tail codeflare --status error`. <!-- @impl: src/index.ts::requestId --> Then check the callback the deployment actually redirects to (the `redirect_uri` test under [Onboarding GitHub Sign-in Bounces to the Landing](#onboarding-github-sign-in-bounces-to-the-landing--app-shows-authentication-required)), and confirm `OAUTH_JWT_SECRET` is listed by `wrangler secret list`. These checks separate the three causes without rotating credentials blindly.

### "Unable to find your Access application!"

**Symptom:** Cloudflare reports that it cannot find the Access application for the Codeflare destination.

**Cause:** The browser retained a stale Access session, or the managed application no longer has the correct destination.

**Fix:** Test in an incognito window, clear Cloudflare Access cookies, and confirm exactly one managed application has the correct destinations.

### Onboarding GitHub Sign-in Bounces to the Landing / `/app` Shows "Authentication required"

**Symptom:** In onboarding mode (`ONBOARDING_LANDING_PAGE=active`, `SAAS_MODE=inactive`), clicking "Continue with GitHub" lands the user back on the marketing landing, and visiting `/app` shows "Authentication Error: Authentication required. Please refresh the page." `/auth/github/login` itself 302s to GitHub correctly.

**Cause:** Two independent failure modes apply:

**App-owned session not trusted in onboarding (code).** The onboarding GitHub callback issues a `codeflare_session` cookie. The access layer (`getUserFromRequest` / `validateSessionOidc`), the session-refresh in `src/index.ts`, and the `requireActiveUser` tier gate honour that cookie only in an *app-owned OIDC mode* (`isSessionOidcMode` = `SAAS_MODE` active OR `ONBOARDING_LANDING_PAGE` active; [REQ-AUTH-021](../../sdd/spec/authentication.md#req-auth-021-onboarding-mode-sign-in-choices-and-access-request-flow) AC4).

If a deployment somehow runs the callback without onboarding/SaaS being active at the access layer, `/app` rejects the session and the SPA bounces to the landing. <!-- @impl: src/lib/onboarding.ts::isSessionOidcMode -->

**GitHub OAuth App callback domain mismatch (config).** The OAuth App's authorization callback URL must equal `https://<this-domain>/auth/github/callback`. If it points at a different domain (e.g. a production App's credentials reused on a non-production deployment domain), GitHub bounces sign-in back to the *registered* domain.

A classic OAuth App allows one callback URL, so each deployment domain needs its own App (see `OAUTH_CLIENT_ID` in [configuration.md](./configuration.md)).

**Fix:** (1) is fixed in code (onboarding is included in `isSessionOidcMode`). For (2), point the deployment's `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` at an OAuth App whose callback is this domain. Quick check: `curl -sI https://<domain>/auth/github/login` should 302 to `github.com/login/oauth/authorize` with `redirect_uri=https://<domain>/auth/github/callback`; that `redirect_uri` host must match the OAuth App's registered callback.

### "Connect to Cloudflare" Fails with `401 invalid_client` Even After Re-saving / Rotating the Secret

**Symptom:** In a non-enterprise mode, "Connect to Cloudflare" ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)) never completes. The consent screen works and Cloudflare returns a real authorization code, but the server-side token exchange fails with `401 invalid_client` ("Client authentication failed…"), surfaced in the connect logs via Cloudflare's `error_description` (AC1). Re-entering the secret in the Setup wizard, or rotating it in the Cloudflare dashboard, does not help — it stays unconnected.

**Cause:** Two independent failure modes apply:

**Wrong token-endpoint auth method (config).** codeflare sends the secret in the request body, so the operator's client must be registered with `token_endpoint_auth_method = client_secret_post`. A `none` (public/PKCE) or `client_secret_basic` client is rejected with `401 invalid_client` (REQ-AGENT-064 Constraints). Client *visibility* (private vs public) is orthogonal and does **not** affect secret auth — a public client authenticates with a secret fine.

**Cloudflare's client-secret rotation is broken (Cloudflare-side bug).** Only the secret returned at client **creation** authenticates. Every secret produced by **"Rotate client secret"** (the dashboard button or the API `POST /client/v4/accounts/<acct>/oauth_clients/<id>/rotate_secret`) is rejected by the token endpoint with `invalid_client`.

The dashboard rotate adds a *second* secret without deleting the old one; while a client holds two secrets (`has_rotated_secret: true`) **neither** authenticates, and even after deleting back down to a single secret the rotated one **still** fails. Once a client has been rotated it is permanently bricked, which is why re-saving or re-rotating never recovers it.

**Diagnose:** The token endpoint distinguishes the two modes. Send `client_secret_basic` with a real code: Cloudflare replies with a *method* error naming the supported method ("the OAuth 2.0 Client supports … `client_secret_post`"), which confirms the client id + method are correct and rules out mode 1. Send `client_secret_post` with the configured secret and a real code: a creation secret issues a token (`200`), a rotated secret returns the generic `invalid_client`. Authorize always succeeds (a code with the right scope comes back); only the token exchange fails. Inspect the client via `GET /client/v4/accounts/<acct>/oauth_clients/<id>` — `has_rotated_secret: true` means it is mid-rotation and bricked.

**Fix:**

Use a client whose secret has **never** been rotated. If the configured client has already been rotated (bricked), **create a brand-new OAuth client** and use the `client_secret` from the create response. Never click "Rotate client secret" on it.

Because rotation cannot be used to recover, a leaked secret means standing up a new client and re-pointing the wizard, not rotating.

For public visibility, set `client_uri`, add the `cloudflare_oauth_client_publisher=<code>` TXT record at that domain's apex and wait for verification, set a non-empty `logo_uri` (promotion is rejected without one), then `PATCH { "visibility": "public" }`.

Public visibility is permanent and cannot be reverted to private.

Enter the new client id + creation secret in the admin Setup wizard (REQ-AGENT-064 AC6).

**Verify:** the connect flow completes and the per-user token persists in `deploy-keys:<bucket>` (source `'oauth'`), then `applyCloudflareOAuthToken` injects it into the container on session start (AC4). Confirmed working on both production and integration deployments.

<a id="terminal-and-mobile"></a>
**Terminal and Mobile**

### SPA Shows a Blank/White Page on Return from Background (Mobile App-Switch)

**Symptom:** After backgrounding the browser (mobile app-switch, tab eviction, bfcache) and returning, the loaded app is blank, partly unstyled, or stuck on its redirecting/loading shell. Reloading immediately repairs the styling or opens Cloudflare Access sign-in.

**Cause:** The Access session expired while the browser retained the live document. Workers Static Assets made Vite's fingerprinted CSS/JS revalidate on every use, so Access could answer those subresource requests with login HTML instead of the asset. Samsung can surface a manual Access redirect as a basic status-zero response rather than `opaqueredirect`; that shape bypassed the auth redirect. Separately, mobile GPU eviction can lose the decorative WebGL context and leave its canvas composited as a persistent bright layer over the otherwise healthy dark page. ([REQ-AUTH-022](../../sdd/spec/authentication.md#req-auth-022-session-expiry-on-resume-produces-a-clean-sign-in-redirect-never-a-blank-page), [REQ-MOB-018](../../sdd/spec/mobile.md#req-mob-018-decorative-webgl-canvas-retirement), [REQ-LANDING-009](../../sdd/spec/landing.md#req-landing-009-decorative-flare-failure-fallback))

**Fix:** Explicit 401, Access 3xx, opaque/status-zero redirects, and HTML login responses (including successful `text/html`) all use `location.replace('/')` plus a settling `authRedirect` error; bootstrap handling also starts navigation for an untagged 401. The authenticated app revalidates on hidden-to-visible and persisted bfcache restoration. Fingerprinted Vite `/assets/*` responses are immutable only after a successful non-HTML response. Coarse-pointer backgrounding or WebGL context loss retires the app and public-landing canvases so the stable dark CSS background remains visible. Redeploy the Worker, web UI, and landing build to pick up the fix.

### Terminal Stuck on "Connecting" After a Mobile App-Switch

**Symptom:** After backgrounding the browser on mobile (app-switch) and returning, one or more terminal panes sit on the connecting state indefinitely and never recover on their own.

**Cause:** When the network is still re-establishing right after the foreground return, the new WebSocket can sit in `CONNECTING` without ever emitting a close or error event, so the close-code reconnect path never runs and the pane is stranded mid-handshake. The previous reconnect also used a flat retry delay with no watchdog for a socket that simply hangs while opening.

**Fix:** A connect-timeout watchdog force-closes any socket still in `CONNECTING` after `WS_CONNECT_TIMEOUT_MS` and schedules a reconnect. Reconnect now uses equal-jitter exponential backoff (`reconnectBackoffMs`, base 500ms, capped at 15000ms) that resets to attempt 1 on a successful open, and is paused while the tab is hidden — the visibility-return handler restarts it at attempt 1 so a backgrounded pane burns no battery or connect budget. Redeploy the web-ui build to pick up the fix. ([REQ-TERM-003](../../sdd/spec/terminal.md#req-term-003-automatic-websocket-reconnection-on-transient-failures))

### Pi Terminal Flicker or Scrollback Snaps to an Edge

**Symptom:** Pi output no longer flickers at the 1000-line scrollback cap, but a user reading or navigating older output is pulled either toward the live prompt or abruptly to the top while Pi continues writing.

**Cause:** Three stacked failures. Codeflare's original write-side distance restoration and scroll-event reset correction overrode xterm's native full-buffer anchor, then reacted to the programmatic scroll events they generated, causing repeated edge snaps. Removing those corrections exposed a second problem: at the 1000-line cap, every output line trims the top of the buffer, so xterm's content anchor drags any scrolled-up reader to `viewportY = 0` within seconds and then destroys the content beneath them ([REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming) AC2/AC3).

Third and independent of output rate: xterm 6.1's public scroll APIs apply deltas relative to the viewport's DOM scroll state, which can silently desync from the buffer during refits that pass through zero height — the next swipe tick then resolves the full divergence as one giant scroll straight to the top of scrollback (see [Viewport DOM Desync](mobile.md#viewport-dom-desync-instant-yank-to-top)).

**Fix:** Batched writes are deferred while the user owns the viewport in the normal buffer — the display freezes under the reader, so no trimming can move them. On bottom return the hold releases in bounded whole-chunk slices (65,536 characters per flush tick), re-checking ownership between ticks so scrolling up mid-release re-defers the remainder; past the 2M-character cap the OLDEST held chunks are dropped instead of being written through the reader. Writes never alter viewport position.

Every scroll route is buffer-authoritative — touch gestures, mouse wheel (capture-phase interception), floating page controls, app-initiated bottom anchors (`scrollBufferToBottom()`), and keystroke re-anchoring (`scrollOnUserInput` disabled, `onData`-owned) — so each tick moves by exactly the requested delta and re-commands the DOM scroll state absolutely, repairing any desync instead of amplifying it; refits that do not re-anchor call `resyncViewportScrollState()`. Correlated user intent (refreshed on every `touchmove`/held-button `pointermove` during a drag) establishes manual ownership until bottom return; touch-keyboard mode remains the explicit bottom-anchored exception. ([AD105](../decisions/README.md#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input), [AD110](../decisions/README.md#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops))

**Verify:** Scroll up during dense output: the reading position must not move at all — even minutes past the held-output cap — and scrolling back to the bottom must reveal the retained output. CI's `terminal.test.ts` drives the WebSocket batching path and verifies output defers for an owned normal-buffer viewport (full, partial, and at-top), flushes without correction for a bottom follower or an alternate-buffer application, releases in bounded slices that re-defer mid-release, and drops oldest held chunks past the cap without ever writing through a reader; `terminal-wheel.test.ts` verifies wheel deltas scroll the buffer service with alternate-buffer and zoom passthrough.

### Terminal Flashes Through Entire Scrollback During Pi Output

**Symptom:** While Pi is streaming — even with the viewport parked at the live bottom — the terminal intermittently jumps to older content and visibly scrolls through the transcript back to the prompt within a split second.

**Cause:** Pi authors every redraw as a DEC 2026 synchronized frame, and a full replay (`CSI 2J`/`CSI H`/`CSI 3J` + the whole transcript) spans hundreds of kilobytes across ~100 WebSocket messages. The host forwards raw PTY chunks and the frontend fed them to `terminal.write()` incrementally, so xterm's 1,000 ms synchronized-output safety timeout (armed at the first buffered row) measured network arrival plus batching. When it expired mid-frame, xterm abandoned atomicity and painted the partially rebuilt transcript, then walked through it as later chunks parsed. Independently, the scrollback wipe (`CSI 3J`) leaves xterm's internal user-scroll lock stale (upstream xterm.js#6046), which can pin the regrowing buffer at the top until an anchor clears it.

**Fix:** The write path reassembles synchronized frames at ingest (`web-ui/src/lib/terminal-frames.ts`): everything from `ESC[?2026h` to the first `ESC[?2026l` reaches xterm as exactly one write, which parses in one synchronous task — the timeout can never fire mid-frame. Ordinary output keeps the 33 ms batching; malformed frames fail open within fixed bounds; the read-hold releases whole frames; and the zero-delta bottom anchor clears the stale scroll lock and re-commands the DOM position. ([REQ-TERM-021](../../sdd/spec/terminal.md#req-term-021-synchronized-output-frame-atomicity), [AD111](../decisions/README.md#ad111-synchronized-output-frames-are-delivered-atomically-at-the-write-boundary))

**Verify:** Run a long Pi session past one screen of transcript and trigger full replays (resize the terminal, or let above-viewport widgets update mid-stream): the screen must change old → new in one paint with no intermediate partial transcript. CI's `terminal-frames.test.ts` verifies frame assembly across split chunks, split markers, nesting, and fail-open bounds; `terminal.test.ts` verifies a split frame reaches xterm as exactly one write and that a held frame releases whole; `xterm-internals.test.ts` verifies the zero-delta anchor repairs the stale lock without repainting.

### Claude Fullscreen TUI Does Not Scroll on Mobile

**Symptom:** After `/tui fullscreen`, desktop wheel scrolling works but a vertical swipe on mobile does not move through Claude's conversation history.

**Cause:** Fullscreen renders in xterm's alternate buffer, which has no terminal scrollback; Claude owns the history and consumes mouse-wheel reports. Codeflare's mobile gesture handler intercepted the touch first and called `terminal.scrollLines()` or sent arrow keys, while its tap-to-keyboard shield prevented xterm's native touch handler from forwarding a wheel report ([REQ-MOB-017](../../sdd/spec/mobile.md#req-mob-017-fullscreen-application-touch-scrolling) AC1).

**Fix:** Deploy a web UI where `attachSwipeGestures()` (`web-ui/src/lib/touch-gestures.ts`) detects an alternate buffer with wheel-capable mouse tracking and — while the keyboard is closed — dispatches line-mode `WheelEvent`s through xterm via its `scrollTouchLines()` helper, and where the floating page controls (`FloatingTerminalButtons.tsx`) also detect the alternate buffer and send PageUp/PageDown input instead of calling xterm scrollback APIs. With the keyboard open, vertical swipes deliberately send arrow keys instead of scrolling (the typing-mode scroll-lock, [REQ-MOB-005](../../sdd/spec/mobile.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll) AC7). Keep the Gesture shield enabled so tapping the terminal still opens the mobile keyboard. `/tui default` remains an immediate workaround on older builds. ([REQ-MOB-017](../../sdd/spec/mobile.md#req-mob-017-fullscreen-application-touch-scrolling) AC1, [REQ-MOB-001](../../sdd/spec/mobile.md#req-mob-001-terminal-fully-usable-on-mobile-devices) AC7)

**Verify:** Enter `/tui fullscreen` on mobile and swipe vertically with the keyboard closed, then use both floating arrow controls. Conversation history should move in each direction while horizontal swipes still navigate the prompt; with the keyboard open, vertical swipes send arrow keys rather than scrolling. CI's `touch-gestures.test.ts` verifies keyboard-closed wheel routing and the keyboard-open arrow-key lock, and `FloatingTerminalButtons.test.tsx` verifies PageUp/PageDown input replaces normal-buffer scrolling only in the alternate screen.

### Agent Browser Notifications Never Appear

**Symptom:** Enabling notifications in Settings shows no browser permission prompt (mobile), or Pi/Claude terminal activity produces no notification even after the permission is granted ([REQ-TERM-023](../../sdd/spec/terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-TERM-027](../../sdd/spec/terminal.md#req-term-027-service-worker-notification-display-and-navigation), [REQ-TERM-024](../../sdd/spec/terminal.md#req-term-024-pi-native-terminal-notification-producer), [REQ-TERM-026](../../sdd/spec/terminal.md#req-term-026-claude-native-terminal-notification-producer)).

**Cause:** Split by surface. (1) iOS exposes the Notification API only inside an installed Home Screen web app, never in a Safari tab, so a tab can neither prompt nor display. (2) On builds before the event-time session fix, a terminal that mounted before the sessions store populated never registered its OSC 777 handler, so no notification could fire for that terminal's lifetime. (3) Right after enabling, a still-installing service worker rejects `showNotification`, dropping the first notifications.

(4) A returning user's first session after a deploy could restore an extension tree that predates `native-notifications.ts`, because the relay only overwrote files already present and the Worker-side R2 seed of missing keys races the boot sync. (5) The authenticated notification config route can be unavailable, or the browser can hold no current Push subscription or a subscription that was never re-registered after server cleanup or VAPID rotation. (6) Claude produces only its reviewed permission-needed signal; Pi produces only the reviewed input-needed and provenance-gated settled signals. (7) Push display is best effort: OS focus modes, permission revocation, offline duration, battery policy, or a killed PWA can prevent presentation.

**Fix:** On iOS, add Codeflare to the Home Screen (Share → Add to Home Screen), open it from there, and enable notifications in Settings — the hint marks this state. Confirm the deployment supplied a valid matching VAPID key pair, `/api/notifications/config` returns the public key to the authenticated user, and enabling sends the current subscription to `/api/notifications/subscription`; switch notifications off and on to replace stale local capability state. The web UI registers the OSC 777 handler unconditionally and resolves the session at event time; the enable/display paths wait for the activated worker; the entrypoint relay backfills missing managed extensions from the mode-filtered bake ([REQ-STOR-017](../../sdd/spec/storage.md#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake) AC4). Start a fresh session after deploying so the container runs the current image.

**Verify:** First keep the document visible, window focused, terminal view visible, originating session active, and terminal-one pane focused; the event must be suppressed. Then make at least one of those five predicates false on every connected client and trigger a reviewed Pi or Claude event; exactly one local display or the bounded Push fallback is expected. Confirm permission is granted, a valid local subscription exists, and the authenticated config/subscription requests succeed. `useTerminal.test.ts` covers five-factor disposition and late suppression, `agent-notifications.test.ts` covers activated-worker and subscription repair, and `entrypoint-governed-sync.test.js` covers bake backfill.

<a id="session-and-container-lifecycle"></a>
**Session and Container Lifecycle**

### Container start is rejected or returns to stopped

**Symptom:** Create/start returns a policy error, or start is accepted but `/api/container/startup-status` returns to `stopped` before services become ready.

**Cause:** Creation can reject the enterprise agent allowlist or SaaS storage quota. Start can reject an active bucket migration, an agent absent from the deployed image, the current concurrent-session policy check, or compute quota. The session-count check is not atomic with its later KV `running` write. Concurrent-session admission is explicitly best effort, so simultaneous starts may exceed the nominal per-user limit; deployment-wide `max_instances` is a separate hard platform capacity. After acceptance, `startAndWaitForPorts()` runs asynchronously and rolls KV back to `stopped` if platform/container startup fails.

**Fix:** Read the original response before retrying. Correct the named agent, migration, storage, session-policy, or compute-quota condition. If start was accepted and then returned to `stopped`, use `wrangler tail` to find `Failed to start container`, confirm the deployment's `MAX_INSTANCES` and selected resource profile, and inspect startup/container logs. Retry only after policy or platform capacity is available; `stopped` is the expected durable rollback state, not evidence that startup reached readiness.

### Container Stuck at "Waiting for Services"

**Symptom:** Container startup remains on the Waiting for Services screen and never reports ready.

**Cause:** Initial R2 sync or PTY pre-warm has not completed; missing credentials, an unavailable bucket, or an entrypoint failure can keep the initialization flag absent.

**Fix:** Check `GET /api/container/startup-status?sessionId=xxx`, inspect `details.syncError`, verify the terminal process and R2 credentials, and inspect `/run/codeflare/sync/sync.log` plus container warnings.

The loading screen waits for both R2 sync and PTY pre-warm to complete before signalling ready.

**Port-wait timeout (container killed before reaching the loading screen):** Cloudflare kills a container that does not bind port 8080 within ~10-15s. Since PR #364 the terminal server binds port 8080 at the very start of `entrypoint.sh` - before R2 sync - so this should no longer occur. If it does, check that `node dist/server.js` in `/app/host` exits cleanly: `cat /run/codeflare/services/terminal.pid` then `kill -0 $(cat /run/codeflare/services/terminal.pid)`.

**Loading screen hangs after port binds:** PTY pre-warm is gated on `/run/codeflare/services/init-complete`. If sync never finishes, the flag is never written and pre-warm waits up to 130s (`PREWARM_INIT_WAIT_MS`) before proceeding anyway. Common causes: missing R2 credentials, bucket does not exist, network timeout. Check `/run/codeflare/sync/sync.log` for errors.

### Dashboard metrics look stale or CPU exceeds 100%

**Symptom:** A running session's `metrics.updatedAt` is older than the normal 60-second publication cycle, or dashboard CPU is above 100%.

**Cause:** `updatedAt` advances only while the Container DO metrics alarm completes, so it can freeze during hibernation or a wedged alarm path and is not itself a liveness signal. CPU is normalized one-minute load average (`loadavg[0] / cpu count`), not sampled utilization; queued or uninterruptible work can validly exceed 100%.

**Fix:** Treat KV `status` as persisted authority. If it remains `running` while metrics are stale, query `/api/container/startup-status`, inspect `/activity` and `/health` through correlated Worker logs, and use `wrangler tail` to find timeout or `recoveryAttemptId` evidence. Treat CPU above 100% as pressure only when it remains elevated across samples and coincides with slow terminal/IDE responses, sync contention, or memory pressure; then identify the active build, agent, or sync workload before changing the resource tier.

### New Session Button Stuck on "Migrating" (Governed Mode)

**Symptom:** After toggling Governed Mode, the New Session button is disabled and labelled "Migrating" (now "Migrating N%"). In older builds it stayed that way for minutes even after the re-encryption had finished, clearing only on a manual page reload.

**Cause:** Governed Mode re-encrypts every existing R2 object in place (SSE-C ↔ plain), driven in the background by the dashboard's `batch-status` poll ([REQ-ENTERPRISE-020](../../sdd/spec/enterprise-mode.md#req-enterprise-020-governed-mode-re-encrypt-migration-engine)). The work is **object-count-bound, not size-bound**: each object is a HEAD + CopyObject (migrate) then a HEAD (verify), run at Cloudflare's cap of **6 simultaneous outgoing connections per Worker invocation** (a concurrency limit, not a req/sec rate limit), with the migration lease serialising work to one invocation at a time — so a ~1,000-object (~20 MB) bucket takes ~2 minutes regardless of total bytes.

The button now shows a live `Migrating N%` and clears within one 5s poll of completion (both the full dashboard load and the 5s background poll mirror the flag). The old "stuck until reload" behaviour was a UI gap where only the full load mirrored the flag.

**Diagnose:** Read the regime state in the env KV: key `r2-regime:<bucket>` (bucket = `<worker-name>-<sanitized-email>`). `{"status":"ready", …}` with an advanced `generation` = finished successfully. `status:"migrating"` with a rising `processed`/`total` (or an advancing `updatedAt`) = progressing normally. A non-empty `lastError`, a `stuckCount` at the retry ceiling, or a frozen `updatedAt` with a held `leaseExpiresAt` = a genuinely stalled migration; `halted: true` is the definitive stalled signal — set both at the verify-retry ceiling and when key rotation is detected mid-migration — and it is what suppresses the button's progress %.

**Fix:** For a normally-progressing migration, wait — it advances on each dashboard poll and clears automatically. For a genuinely stalled one, inspect `lastError`: an oversized/un-migratable object is recorded and skipped, and key rotation halts-with-error by design (see [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)).

<a id="storage-and-vault"></a>
**Storage and Vault**

### R2 Sync Issues

See [Storage & Sync - Troubleshooting](storage-and-sync.md#troubleshooting).

### Zombie Container

Zombie alarm loops are now prevented by two mechanisms: (1) `onStop()` calls `deleteSchedules('collectMetrics')` to immediately kill the alarm loop when a container stops, and (2) `onActivityExpired()` calls `this.stop('SIGTERM')` on unreachable activity endpoints instead of renewing the timeout, which triggers `onStop()` and its schedule cleanup. As a defense-in-depth fallback, `collectMetrics` itself still has three self-termination guards: container-not-running check, missing-identifiers guard, and re-arm guard. These cover edge cases where `onStop()` might not fire (e.g., after `destroy()`).

### Secrets Lost After Worker Deletion

**Symptom:** A recreated Worker starts without credentials that were configured before deletion.

**Cause:** `wrangler delete` removes the Worker's secrets with the deployment.

**Fix:** Restore each required secret with `wrangler secret put` before using the recreated Worker.

### R2 Bucket Cleanup on User Deletion

Explicit user removal calls `cleanupUserData()` in `src/lib/user-cleanup.ts`, which destroys all active containers, deletes the user KV entry and bucket-keyed KV entries (`storage-stats:`, `user-prefs:`), reads the scoped R2 token via `getAndDecrypt()` (required because `r2token:{email}` values are encrypted when `ENCRYPTION_KEY` is set; raw `KV.get('json')` throws `SyntaxError` on the `v1:...` ciphertext prefix), and deletes the scoped R2 token. Setup reconfiguration never invokes this destructive workflow.

It then empties the R2 bucket via S3 `ListObjectsV2` + `DeleteObjects` loop (using worker-level R2 credentials via `createR2Client` + `emptyR2Bucket`), and deletes the empty bucket via Cloudflare API with retry logic (up to 3 attempts with exponential backoff for R2 eventual consistency when objects were deleted).

If worker-level R2 credentials are not configured (for example, setup was interrupted), the emptying step is skipped and bucket deletion may fail with `BucketNotEmpty`. This logs `logger.warn` server-side but does not block the overall cleanup. GitHub revocation is also best-effort: failure is logged, local GitHub credentials are cleared, and explicit cleanup continues.

<a id="agent-runtime-review-and-ci"></a>
**Agent Runtime, Review, and CI**

### Chrome in CI (Ubuntu 22.04)

**Symptom:** Chromium installation exits successfully, but CI has no usable browser executable.

**Cause:** On Ubuntu 22.04, `apt install chromium-browser` installs a snap wrapper; GitHub Actions runners do not provide the snapd environment it needs.

**Fix:** Install Chrome through Puppeteer, then install its required shared libraries individually.

```bash
npx puppeteer browsers install chrome
sudo apt-get install -yqq --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
  libxfixes3 libx11-xcb1 libxext6 libxi6 libxtst6 libxcursor1 \
  fonts-liberation
```

**Note:** Package names differ between Ubuntu versions - 22.04 uses `libatk1.0-0`, 24.04 uses `libatk1.0-0t64`.

### Pi Extension Packages Missing After Restart

**Symptom:** A Pi package installed during a session is missing after container restart.

**Cause:** `PI_OFFLINE=1` (set when Fast Start is ON, the default) prevents `pi update` from running, so packages not in the image cache are absent until Fast Start is disabled.

**Fix:** Disable Fast Start in Settings, restart the session so `pi update` runs, then re-enable Fast Start.

### Managed Environment Is Stale, Degraded, or Update Pending

**Requirements:** [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration), [REQ-SETUP-014](../../sdd/spec/setup.md#req-setup-014-managed-repository-credential-boundary), [REQ-STOR-020](../../sdd/spec/storage.md#req-stor-020-managed-environment-reconciliation), [REQ-STOR-022](../../sdd/spec/storage.md#req-stor-022-managed-reconciliation-admission), [REQ-STOR-023](../../sdd/spec/storage.md#req-stor-023-managed-release-status-and-discovery), [REQ-STOR-024](../../sdd/spec/storage.md#req-stor-024-managed-release-application)

**Symptom:** Setup or the dashboard reports stale, degraded, or update-pending managed curation, or a published private change does not appear.

**Cause:** Stale means no GitHub freshness check succeeded inside the five-minute window. Degraded means GitHub, PAT decryption, or the deployment cache was unavailable. Update pending means a session owns the user bucket or a fresh user cannot read a verified release. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease --> <!-- @impl: src/routes/session/lifecycle.ts::default -->

**Fix:** For stale state, leave the dashboard open through its next background refresh. The Worker uses ETag validation and skips only releases whose verified runtime hash differs from the deployed build; any other managed-release validation failure stops discovery. For degraded state, confirm repository access, signer identity, R2 credentials, and the exact two managed assets with GitHub SHA-256 digests. Already-applied buckets continue from their last verified compatible release. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

For update pending, stop every session for that user; reconciliation starts only after the bucket is idle. For a missing private change, confirm an immutable non-draft release matches the deployed runtime hash and Setup repository and signer. No hash match in the bounded scan is a discovery failure. Discovery uses dashboard refresh, not image deployment or container restart. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

If the dashboard continuously returns to `Upgrading` and Workers Observability reports `Worker exceeded memory limit` for `POST /api/storage/seed/agent-configs`, the deployed Worker is expanding a large managed release into one in-memory object before writing it. Deploy a Worker containing the bounded managed-release stream reader; do not remove release files, change modes, rotate the signer, or republish the same release. The corrected route reads the existing cached gzip once and writes the identical user-bucket payload document by document. A successful final applied stamp ends the ordinary `Upgrading` cycle on the next status poll. <!-- @impl: src/lib/remote-curation.ts::verifyManagedReleaseStream --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->

### Pi Todo Tasks Disappear After Subagent Activity

**Symptom:** The foreground `/todos` list resets to `No tasks` after a background reviewer or other child session starts, compacts, changes tree, or shuts down, even though an earlier valid todo snapshot remains in the foreground transcript.

**Cause:** Images built before the `@juicesharp/rpiv-todo` 2.0.0 pin carry 1.20.0, which uses one module-level task cell for every Pi session unless the retired [AD100](../decisions/README.md#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) override patched it. A child lifecycle replay can overwrite the foreground cell with the child's empty list.

**Fix:** Redeploy an image containing [REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation)'s rpiv-todo 2.0.0-or-later pin (currently 2.4.0), which ships session-keyed task state upstream with no source override.

### Pi Web Search Crashed the Session

**Symptom:** Asking Pi to search the web killed the whole session (process exited) on an older image.

**Cause:** Images with `pi-web-access` before 0.14 combined the default interactive `summary-review` workflow with a headless container and an upstream fallback error, so failure to open the curator browser could crash Pi.

**Fix:** Redeploy an image with [pi-web-access 0.14](https://github.com/nicobailon/pi-web-access/releases/tag/v0.14.0) or later, which fixes the fallback error. Codeflare still creates `~/.pi/web-search.json` with `{"workflow": "auto-summary"}` when absent because browser approval cannot function headlessly; an existing user choice remains untouched.

<a id="common-failure-modes"></a>
## Failure Index

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container won't start | Missing R2 credentials | `wrangler secret list` then `wrangler secret put` |
| `403 Forbidden` on R2 | Expired credentials | Regenerate in CF dashboard |
| Container killed before loading screen | Port 8080 did not bind in time | Check `/run/codeflare/services/terminal.pid`; verify `node dist/server.js` started |
| Loading screen hangs indefinitely | `/run/codeflare/services/init-complete` never written (sync stalled or pre-flag entrypoint step crashed) | Check `/run/codeflare/sync/sync.log`; verify R2 credentials; check container logs for `[entrypoint] WARNING:` lines. See [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition). |
| WebSocket fails with close code 4503 (`container-stopped`) | Container hibernated or stopped | Reconnects while container is stopped use close code 4503 and do NOT count against the WS rate-limit budget (see [WebSocket Rate Limit](security.md#websocket-rate-limit-req-sec-007)). Wait for the container to restart; the budget is preserved. |
| WebSocket fails with close code 1013 (`container-warming-up`) | Container started but not yet ready - port 8080 bound before R2 sync and `.bashrc` autostart completed | See [note](#websocket-fails-with-close-code-1013). |
| Session stays `running` but terminal, `/activity`, and `/health` all stop responding, or the SDK monitor reports `Network connection lost` | Both routes share port 8080 and one Node event loop. Failure may be the DO attachment, container network, listener, CPU starvation, host wedge, or a vanished container; `running`, `ptyAlive`, and a WebSocket `101` alone do not prove a functioning workload. | [REQ-SESSION-021](../../sdd/spec/session-lifecycle.md#req-session-021-unreachable-container-transport-initiates-coordinator-reconstruction) and [REQ-SESSION-022](../../sdd/spec/session-lifecycle.md#req-session-022-transport-recovery-is-confirmed-and-bounded) permit at most two coordinator resets. Monitor loss enters recovery immediately; failed probes require three confirmations. Correlate `recoveryAttemptId` across recovery logs. Exhausted not-running recovery returns to exit confirmation; a vanished container cannot be reattached. |
| Session shows `stopped` on the dashboard but container is actually running | `onError` fired on a transient platform event (deploy-roll, monitor blip) and a prior clobber-race guard prevented `collectMetrics` from correcting the status | See [note](#session-shows-stopped-on-the-dashboard-but-container-is-actually-running). |
| Session remains `stopping` after a stop request | Status confirmation timed out or repeatedly failed, so the dashboard deliberately retained terminal state instead of fabricating a stopped result. | Refresh to fetch authoritative status. If it still shows `stopping`, retry Stop; do not assume teardown completed. |
| Zombie restarts | Stale DO state | Self-terminates via missing-identifiers guard |
| Stop/delete loses the session's recent edits — the next session restores stale or empty state (transcripts, credentials, config missing) | See note below. | See [note](#stop-delete-loses-the-session-s-recent-edits-the-next-session-restores). |
| Deleted session reappears | `onStop()` resurrects KV entry | Verify `destroy()` clears `SESSION_ID_KEY` before `super.destroy()` |
| Container dies during active use | Auth issue on internal paths | Verify `/activity` in `AUTH_EXEMPT_PATHS` in `host/src/auth-check.ts` |
| Container sleeps before configured timeout | Stale `idleTimeoutPref` cache in DO | Each 60s tick re-reads `sleepAfter` from DO storage ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) AC2); if storage holds a corrupt value it is ignored and the previous cached value applies. Check DO storage via `wrangler tail` for `collectMetrics: storage holds invalid sleepAfter value`. |
| Container sleeps later than expected (up to 4h) | `parseSleepAfterMs` fail-safe | When the stored `sleepAfter` is missing or unrecognized, the system defaults to 4h max to avoid losing user work ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) AC1). Correct via Settings panel - the new value writes to storage and takes effect on the next 60s tick. |
| Claude Code reports "Settings Error: matcher Expected string, but received null" | `settings.json` hook entry has `matcher: null` (written by Claude Code's own self-install for `context-mode-cache-heal`); old entrypoint versions passed it through unchanged | Fixed automatically by entrypoint.sh since PR #299. Redeploy (re-run `entrypoint.sh`) to pick up the fix. |
| Claude Code reports a "SessionStart hook error" with "Permission denied" in container logs | A hook in `~/.claude/hooks/` is registered by bare path and spawned through its shebang, but R2 carries object content and modification time, not POSIX modes, so the sync that restored or rewrote it dropped the exec bit | Repaired automatically. entrypoint.sh restores the bit at startup and after every successful bisync ([REQ-STOR-002](../../sdd/spec/storage.md#req-stor-002-file-persistence-across-sessions) AC4). A running session recovers within seconds; no redeploy is needed. |
| The hook named in that error is `context-mode-cache-heal.mjs` | An older context-mode self-installed it to repair symlinks under `~/.claude/plugins/cache/`. This product installs context-mode from npm and registers it as an MCP server directly, so that cache is never populated and the hook is inert here | Removed, not repaired: the object is retired from the bucket and the registration is pruned from `settings.json` on the next container start ([REQ-STOR-019](../../sdd/spec/storage.md#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed) AC8, [REQ-AGENT-099](../../sdd/spec/agents.md#req-agent-099-agent-settings-and-plugins-assembled-at-container-start) AC6). |
| A Pi skill requests a missing `ctx_*` tool after `/ctx off` or inside a subagent | Context-mode is optional in the root and intentionally absent from in-process subagents. | Use the documented native fallback. Reviewers consume the same packet through Bash/Node; web retrieval falls back to `fetch_content`/`get_search_content`. The work set must not narrow. |
| Pi memory climbs while many `context-mode/server.bundle.mjs` children remain under one Pi PID | The Pi process predates the foreground-owner guard, or settings still autoload context-mode as a bare package extension so in-process subagents initialize competing bridges. | Deploy the corrected seed, confirm the context-mode package entry is `{ "source": "npm:context-mode@<pinned>", "extensions": [] }`, then fully restart Pi once to reap already-orphaned helpers. `/reload` alone cannot reclaim bridge handles lost before the guard loaded. |
| Container start rejects with 500: sleepAfter required | `buildSetBucketNameBody` missing value | The `/start` route failed to resolve the user's effective `sleepAfter` before calling the internal setup helper. Check that the user's preferences are readable and `effectiveTier` resolves correctly ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) AC3). |
| Phantom container on session switch | Reconnect scope issue | Ensure `activeSessionId` filter passed to `reconnectDisconnectedTerminals()` |
| Character doubling in terminal | Handler not disposed on reconnect | Dispose `inputDisposable` before creating new handler in `connect()` |
| Container returns 503 on all authenticated endpoints | `CONTAINER_AUTH_TOKEN` not set | Security default-deny. Token is set automatically by the DO via `crypto.randomUUID()` on lifecycle start. If missing, verify DO `updateEnvVars()` runs before `startAndWaitForPorts()` |
| `graphify: command not found` in terminal ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | System-PATH symlink absent in the image, or entrypoint self-heal did not run | See [note](#graphify-command-not-found-in-terminal). |
| Enterprise Mode: LLM calls fail with TLS certificate errors | Cloudflare containers CA not found or not trusted | See [note](#enterprise-mode-llm-calls-fail-with-tls-certificate-errors). |
| Enterprise Mode: agent fails with opaque "Connection error" but `curl https://api.openai.com` from the same container succeeds | See note below. | See [note](#enterprise-mode-agent-fails-with-opaque-connection-error-but-curl-http). |
| Enterprise Mode: LLM calls return 503 / 401 / authentication errors | Missing or invalid `AIG_GATEWAY_URL`, or missing/incorrect `AIG_TOKEN` | A missing/malformed URL now returns bounded 503 through the always-wired interceptor; it never falls through direct. (1) Check Setup and deploy secrets for `AIG_GATEWAY_URL` and `AIG_TOKEN`. (2) `wrangler tail` must show the pre-start registration; a registration exception aborts startup. (3) Verify the account/gateway path and required token scopes. |
| Enterprise Mode: agent hits a non-OpenAI provider error (e.g. Pi → AWS Bedrock `UnrecognizedClientException`), uses the wrong model, or **no request reaches the AI Gateway** (empty gateway logs) | Pi auto-bound a built-in provider (amazon-bedrock, falsely "authenticated" by R2 keys exported as `AWS_*`) instead of the gateway, signing a SigV4 call to AWS that never hit `api.openai.com`; or the dynamic-route catalog/default is unconfigured in Setup | See [note](#enterprise-mode-agent-hits-a-non-openai-provider-error-uses-the-wrong). |
| Enterprise Mode: agent retries every streamed reply and token usage multiplies (Pi logs `Stream ended without finish_reason`) | The AI Gateway dynamic route ends streaming responses with `finish_reason: null` then `[DONE]`, omitting the terminal `stop`/`tool_calls` chunk that OpenAI-wire agents require; the agent treats the stream as truncated and retries (≈3×), multiplying token cost | See [note](#enterprise-mode-agent-retries-every-streamed-reply-and-token-usage-mul). |
| Enterprise Mode: the Vault editor never loads / SilverBullet service worker fails to register (browser console shows a redirect on `service_worker.js`, 302 to `*.cloudflareaccess.com`) | The host-wide Cloudflare Access app 302s the credential-less `service_worker.js` registration fetch to the IdP login before the Worker's [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) short-circuit can run | See [note](#enterprise-mode-the-vault-editor-never-loads-silverbullet-service-work). |
| `mcp__graphify__*` tools not visible in Claude Code ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | Plugin manifest absent or `~/.claude.json` malformed | Check plugin delivery and the lazy MCP wrapper path; rerun `entrypoint.sh` if stale. |
| `mcp__graphify__*` tools return empty results on a fresh session ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | No `graphify-out/graph.json` exists in any cloned repo yet - the wrapper started in empty-graph mode | Expected behaviour, not a bug. Run `graphify update .` from the repo root to build the AST graph (free, no LLM cost). The wrapper hot-reloads within `GRAPHIFY_POLL_SECONDS` (default 2s) of the file appearing. |
| `mcp__graphify__*` returns answers from the wrong repo ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | Sentinel file at `~/.cache/codeflare-hooks/graphify-active-cwd` is absent, stale, or points at a repo without a `graphify-out/`; wrapper fell back to the freshest-mtime heuristic and picked the wrong repo | See [note](#mcp-graphify-returns-answers-from-the-wrong-repo). |
| Pi emits no review request after expected PR-boundary work ([REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery), [AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents)) | The command failed or is unsupported, the session is a child, SDD is absent or transitioning, the fresh PR is not open against `main`/`master`/`develop`, or GitHub has not yet reported the exact local head. | An unavailable or stale candidate boundary remains unevaluated and retries at root agent-end, settled, or resumed-session recovery. If no plan appears after GitHub reports the exact head, verify the other eligibility conditions; do not recreate the push. |
| Default-mode Pi emits no CI-only plan after `cd <repo> && git push` from the workspace parent | An older default seed did not remember the repository from the successful shell boundary because the advanced main extension was absent. | Reload the corrected seed. The default active-repository extension now resolves `cd` and tool-level cwd before CI eligibility. |
| A launched Pi reviewer never produces a native completion notification ([REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-native-review-result-correlation)) | The public background subagent is still active, stopped, or was lost on reload; only the notification correlated to its tool-use ID proves completion. | Wait while it is active. A persisted delayed notification can still acknowledge the reviewed head while the PR head is unchanged; otherwise request the missing lane at a later supported boundary. Never treat unrelated tool output as completion. |
| Pi repeats an already completed review range after newer local work was committed but not pushed | The final native reviewer notification arrived after local `HEAD` advanced, and an older runtime required local and PR heads to match before writing acknowledgement. | Reload the corrected runtime. It correlates the persisted terminal notification to the still-authoritative reviewed PR head without acknowledging a replacement PR head. |
| Pi reports that a merged PR head was never acknowledged ([REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery) AC7) | `gh pr merge` completed before the required reviewer notifications and triage could acknowledge that head; Pi has no pre-command merge interceptor. An acknowledged head does not emit this notice. | Check the transcript for a triage verdict for the reported SHA and review the merged head manually when none exists. Pi deliberately does not write a false acknowledgement. |
| Claude reports that a merged PR head was never acknowledged ([REQ-AGENT-120](../../sdd/spec/agents.md#req-agent-120-claude-review-enforcement-lifecycle) AC4) | The PR closed before the Stop hook could advance its exact-head checkpoint. Claude reports each unacknowledged closed head once and preserves the one-shot bypass sentinel. | Check the transcript for a triage verdict for the reported SHA and review the merged head manually when none exists. An acknowledged head stays silent, so repeated or false notices indicate stale seeded hooks. |
| Pi CI resolver returns no request ([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring), [AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent)) | The boundary head, repository cwd, or review launch state was omitted or invalid; the live PR head differs from the boundary head; the Git action was unchanged/unsupported; or no open PR targets `main`/`master`/`develop`. | Run from the affected repository after required reviewer calls with explicit `head`, `cwd`, and `reviewState`. A live-head mismatch supersedes that plan; do not launch its CI request or acknowledge its review. |
| Pi CI monitor times out ([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring) AC2-AC3; [REQ-AGENT-125](../../sdd/spec/agents.md#req-agent-125-pi-ci-result-and-launch-checkpoint) AC3) | Check rows stayed empty or pending beyond the bounded wait, or GitHub responses remained malformed/transient. | Inspect the PR checks in GitHub and fix the provider issue. Do not relaunch automatically; use an explicit user request or a later eligible Git action if monitoring is still needed. |
| Pi CI monitor reports the head as superseded ([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring) AC4) | The PR `headRefOid` changed before terminal reporting, so the old monitor refused to report stale status. | No recovery is needed for the old head. The successful newer push runs the root resolver once for the new head. |
| Pi review or CI work disappears after reload ([AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents), [AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent)) | Both flows use session-scoped native background tasks; reload intentionally aborts active work and fabricates no completion proof. Persisted reviewer notifications remain valid transcript evidence, but CI has no equivalent acknowledgement. | A persisted reviewer notification with an unchanged PR head may be acknowledged by settled correlation; otherwise run a later supported boundary for missing lanes. For CI, wait for a later eligible Git action or request monitoring; neither restarts automatically. |
| Pi memory/Vault extraction repeats reminders, reaches GIVEUP, or reports Done without advancing state | Delivery lacks an exact public call/result, or required post-commit artifacts are absent. | See [note](#pi-memory-vault-extraction-repeats-reminders-reaches-giveup-or-reports-done-without-advancing-state). |
| Graph stale after recent code edits ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | AST portion of the graph was not refreshed since the edits | Run `graphify update .` from the project root. It re-extracts only changed files via tree-sitter (free, no LLM cost). Skip if the change was test-only or doc-only - the graph de-emphasises tests by design. |
| Onboarding mode: the Vault editor never loads / SilverBullet service worker fails to register (browser console shows `script resource is behind a redirect`, 302 to `*.cloudflareaccess.com`) | An onboarding-mode deployment (`ONBOARDING_LANDING_PAGE=active` + `OAUTH_CLIENT_ID`, non-enterprise) ran setup with the old SaaS-only guard, provisioning a stray host-wide CF Access app that 302s the credential-less `service_worker.js` registration before the Worker's [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) short-circuit runs | See [note](#onboarding-mode-the-vault-editor-never-loads-silverbullet-service-work). |
| Vault sync stuck / unhealthy and the browser console spams `t.forEach is not a function` (or `o.map is not a function`) from the SilverBullet service worker | See note below. | See [note](#vault-sync-stuck-unhealthy-and-the-browser-console-spams-t-foreach-is). |
| Vault readiness button never goes ready and the SilverBullet service worker never registers (browser console shows a `SyntaxError` from `service_worker.js`, e.g. `Identifier 'o' has already been declared`) | Duplicate `o=` declarator in the served worker's sync-cycle declaration list, so the browser refuses to register the SW. | See [note](#vault-readiness-button-never-goes-ready-and-the-silverbullet-service-w). |
| Vault re-indexes from scratch on every new session open (SilverBullet shows "Syncing…" for several minutes and re-downloads all notes each session) | The bucket-stable IndexedDB persistence from [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) has broken: SilverBullet is being served under a different `location.href` per session, so its `sb_data_*`/`sb_files_*` IDB names differ and the prior store is unreachable | See [note](#vault-re-indexes-from-scratch-on-every-new-session-open). |
| Vault button repeatedly breathes without reaching green, or an old Vault worker still controls requests after the v3 deployment | A stale `/api/vault/*` registration survived cleanup, or the new canonical worker/sync/index/content proof failed. | See [note](#vault-button-re-indexes-on-every-click-after-the-first-then-returns-gr). |
| Vault first/cold open bounces to `/.auth` and shows "Authentication not enabled" (403); closing and reopening loads cleanly. SW log shows "No more clients, flushing encryption key" then "Recovered encryption key from codeflare" just before the 403 | SilverBullet's native worker wipes the in-memory key 5s after the last client disconnects; the bootstrap-hop's brief 0-client gap during its editor redirect can land in that window, wiping the key before `__cfRecover` re-fetches it ([AD84](../decisions/README.md#ad84-retain-the-vault-sw-encryption-key-in-memory-neuter-the-proactive-flush-and-open-a-green-vault-button-directly), [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC4/AC5) | Fixed: a graft neuters the proactive flush (`ANCHOR_PROACTIVE_FLUSH` in `src/routes/vault/native-sw.ts`, [REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft) AC4), retaining the key for the worker's lifetime. If it recurs after a re-vendor, re-verify the flush anchor and that the served worker parses. |
| Enterprise Mode: Strict Gateway Egress ON and a container network call is denied / times out (some hosts reachable, others not) | Egress now rides the account's existing Cloudflare (Zero Trust) Gateway policies on `cf1:network`; a block / isolate / DLP rule is dropping the destination ([REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress)) | Codeflare never modifies Gateway policies — curate them in the customer's Zero Trust dashboard so required destinations are allowed. Cross-check `wrangler tail` against the Gateway activity log for the matching block rule. This is policy enforcement, not a bug. |
| Enterprise Governed Mode: after flipping the R2 SSE-C toggle, R2 sync fails and the vault never becomes ready (some objects 400 on read) | The bucket is **mixed** — objects exist in both regimes after an opposite-regime write or partial migration. | See [note](#enterprise-governed-mode-after-flipping-the-r2-sse-c-toggle-r2-sync-fa). |
| Enterprise Governed Mode: the New Session button is stuck on "Migrating" / a flip never starts | A flip waits for the bucket's running sessions to stop (D1: no force-kill); `batch-status` reports `bucketMigrationPending` while a container is healthy ([REQ-ENTERPRISE-020](../../sdd/spec/enterprise-mode.md#req-enterprise-020-governed-mode-re-encrypt-migration-engine) AC3, [REQ-ENTERPRISE-021](../../sdd/spec/enterprise-mode.md#req-enterprise-021-governed-mode-migration-safety-and-access-boundary) AC3) | Stop the bucket's sessions in the dashboard; the next `batch-status` poll flips the bucket to `migrating` and advances a chunk per poll. Keep the dashboard open until completion. A stuck `migrating` state self-recovers once the per-chunk lease (`leaseExpiresAt`) elapses. |
| Enterprise Mode: Strict Gateway Egress ON and **direct-internet** container HTTP/HTTPS calls (and GitHub) fail with 503 `EGRESS_UNAVAILABLE`, while R2 sync / LLM / browser-run keep working | See [note](#enterprise-mode-strict-gateway-egress-on-and-direct-internet-container). | Expected when the toggle was turned ON on a deploy that has no `EGRESS` binding. Either flip the toggle OFF (KV, no redeploy) to restore direct egress, or redeploy to an enterprise environment so the binding is injected (see [deployment.md](deployment.md#strict-gateway-egress-enterprise-mode)). |
| Enterprise Mode: container traffic goes out directly (not through the Gateway) when you expected it routed | See note below. | See [note](#enterprise-mode-container-traffic-goes-out-directly-when-you-expected). |
| Enterprise Mode: Strict Gateway Egress ON and the session hangs on "Syncing…" / R2 persistence (vault & workspace bisync) stalls or times out | Older builds routed rclone's per-file R2 traffic through `env.EGRESS`/`cf1:network`; rclone's many short-lived R2 connections caused a TLS-handshake storm on the shared, rate-limited Gateway egress path and hit account-wide connection/rate limits at fleet scale ([AD86](../decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)) | See [note](#enterprise-mode-strict-gateway-egress-on-and-the-session-hangs-on-sync). |
| Sync is slow (bisync takes far longer than expected even with high concurrency) on any deployment mode | rclone was forcing **multipart** uploads for every file via `--s3-upload-cutoff 0`, so each tiny agent file (e.g. sub-KB `telemetry_state.json`) cost 3–4 R2 round-trips (initiate + part + complete) instead of one `PutObject` | Fixed: `--s3-upload-cutoff 0` was removed from both bisync invocations in `entrypoint.sh` (`establish_bisync_baseline` + `bisync_with_r2`); small files use one `PutObject`, rclone's default 200 MiB cutoff keeps multipart for large files, and `--transfers 32 --checkers 32` is unchanged. |
| Enterprise Mode: Strict Gateway Egress ON and interactive browser-run (Chrome DevTools / Pi `chrome-devtools`) fails with `400` "Could not connect to Chrome" / the CDP WebSocket handshake dies (`Network connection lost`), while non-interactive browser REST calls work | The `EgressController`'s generic request path strips the `Upgrade`/`Connection` hop-by-hop headers and rebuilds the response without its `webSocket`, killing the CDP WebSocket upgrade to `…/browser-rendering/devtools/…` | See [note](#enterprise-mode-strict-gateway-egress-on-and-interactive-browser-run-f). |
| Enterprise Mode: Strict Gateway Egress ON and container logs show `[entrypoint] WARNING: R2_ACCESS_KEY_ID contains unexpected characters (expected hex)` (and the same for `R2_SECRET_ACCESS_KEY`) | Expected under strict egress: the container holds only the non-secret placeholder R2 key (`codeflare-enterprise`, not hex), so entrypoint.sh's hex-format heuristic warns ([REQ-ENTERPRISE-023](../../sdd/spec/enterprise-mode.md#req-enterprise-023-strict-gateway-egress-controller-transport) AC4, [AD87](../decisions/README.md#ad87-egresscontroller-re-signs-own-account-r2-container-holds-a-placeholder-key-bridges-websocket-upgrades-and-resolves-strict-via-props)) | Not a bug — rclone signs with the placeholder and the `EgressController` re-signs own-account R2 with the worker-held key at the boundary, discarding the placeholder signature. Only strict egress warns; non-enterprise / strict-off carries the real hex key. |


<a id="notes-on-common-failure-modes"></a>
## Detailed Recovery Notes

These notes hold details moved out of long table cells above; the table keeps the symptom/cause/fix scanable.

<a id="websocket-fails-with-close-code-1013"></a>
#### WebSocket fails with close code 1013 (`container-warming-up`)

**Fix detail:**

Normal during the ~10s cold-start window. The client's retry backoff will reconnect automatically once `terminalServiceReady` flips to `true`. If 1013 persists beyond 30s: (1) check `/run/codeflare/sync/sync.log` for a stalled R2 sync (same causes as "Loading screen hangs indefinitely" above); (2) if sync looks healthy, check whether a pre-flag entrypoint step crashed under `set -euo pipefail` before `/run/codeflare/services/init-complete` was written - look for `[entrypoint] WARNING:` lines in container logs (e.g. `warm_pi_npm_dependencies` or `update_pi_when_fast_start_disabled` failure); PID 1 dying before the flag write causes an identical symptom. Fixed by PR #440 per [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition). These reconnects do NOT count against the WS rate-limit budget.

A container that actively **rejects** the WebSocket forward — rather than hanging — now maps onto this same retryable 1013 instead of falling through to the route's generic 500 ([REQ-TERM-022](../../sdd/spec/terminal.md#req-term-022-an-unreachable-container-ends-the-upgrade-instead-of-escaping-it)). Any handshake answered by something other than a 101 reaches the browser as 1006, which is retryable but never opens a socket, so the client's reconnect backoff stayed pinned at its 500 ms base and retried roughly once a second indefinitely. Returning a real 101 whose socket closes 1013 is what lets that backoff actually advance.

<a id="session-shows-stopped-on-the-dashboard-but-container-is-actually-runni"></a>
#### Session shows `stopped` on the dashboard but container is actually running

**Fix detail:**

Self-heals within one `collectMetrics` tick (~60 s) via AC4: when the `/health` probe confirms the container is running but KV reads `stopped` and the persisted deliberate-stop marker (`shutdownRequested` DO storage key) is absent, `collectMetrics` re-asserts `running`. If the dashboard still shows stopped after ~2 min, check `wrangler tail` for `collectMetrics: container running but KV stopped, re-asserting running`; absence of that log line with presence of `collectMetrics: session stopped with shutdown in flight, leaving stopped` means `destroy()` ran a deliberate stop whose marker survived (expected — not a false-stopped case). Absence of both lines means the container genuinely stopped. See [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit) AC4.

<a id="stop-delete-loses-the-session-s-recent-edits-the-next-session-restores"></a>
#### Stop/delete loses the session's recent edits — the next session restores stale or empty state (transcripts, credentials, config missing)

**Cause detail:**

The DO-side final-sync drain was rejected by the in-container auth gate (HTTP 401) before the bisync ever triggered: the drains' raw `port.fetch` bypasses the DO's auth-injecting public fetch override, and on delete `destroy()` wiped `containerAuthToken` before the drain fired. Every teardown sync 401'd for ≥30 days with zero successes; the storage-panel "Sync R2" button worked the whole time because it routes through the worker's authenticated container fetch.

**Fix detail:**

Fixed 2026-06-10 ([REQ-SEC-022](../../sdd/spec/security.md#req-sec-022-container-proxy-bearer-validation) AC5): both drains send `Authorization: Bearer` with the token captured before the storage clear. If it recurs, query Workers logs for `Final sync did NOT complete on teardown` — `httpStatus:401` means the auth regression is back; `504`/timeout means the budget path; then check the in-container daemon (`/run/codeflare/sync/sync-daemon.pid`, `/run/codeflare/sync/sync.log`). A healthy delete logs `Final sync audit (teardown)` at info with `outcome:completed`.

<a id="graphify-command-not-found-in-terminal"></a>
#### `graphify: command not found` in terminal ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify))

**Fix detail:**

Run `which graphify`; the canonical answer is `/usr/local/bin/graphify` (symlink to `/root/.local/share/uv/tools/graphifyy/bin/graphify`). The Dockerfile creates it; if missing, the image predates `283fc8e` and needs a redeploy. The entrypoint self-heal recreates the symlink on every boot if the source binary exists, so a clean redeploy is sufficient. The system PATH is the canonical resolution path because hook subshells (graphify-active-repo.sh, capture agent, vault-extract agent) cannot see `/root/.local/bin/`.

For Claude MCP visibility, check `~/.claude/plugins/graphify/.claude-plugin/plugin.json` exists. Then run `jq '.mcpServers.graphify' ~/.claude.json`; it should point at `/root/.local/share/uv/tools/graphifyy/bin/python` with args containing `<plugin-dir>/graphify/scripts/graphify-mcp-lazy.py`. If it is null or points at `python3 -m graphify.serve`, rerun `entrypoint.sh`; the older invocation cannot import the uv-isolated graphifyy package.

<a id="enterprise-mode-llm-calls-fail-with-tls-certificate-errors"></a>
#### Enterprise Mode: LLM calls fail with TLS certificate errors

**Fix detail:**

Check container logs for `[entrypoint] WARNING: /etc/cloudflare/certs/cloudflare-containers-ca.crt not found` or `WARNING: could not install Cloudflare containers CA`. The CA is mounted by the platform at container start; its absence indicates a platform configuration issue, not an application bug. Verify that `ENTERPRISE_MODE=active` is set and that the container image is current (predates CA-trust block if missing).

<a id="enterprise-mode-agent-fails-with-opaque-connection-error-but-curl-http"></a>
#### Enterprise Mode: agent fails with opaque "Connection error" but `curl https://api.openai.com` from the same container succeeds

**Cause detail:**

The Node/Python CA-trust exports are missing from the agent's shell: `entrypoint.sh` writes `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` into `.bashrc`, but the block was skipped (CA file absent when the `[ -f "$CF_CA_SRC" ]` guard ran) or never sourced. `curl` keeps working because it reads the system store, which masks the cause; the agent's runtime uses its own bundled CA list and rejects the intercepted cert before the request reaches the interceptor (no `LlmInterceptor.fetch` log line).

**Fix detail:**

In the agent's tab run `grep -A3 'enterprise-ca-trust' ~/.bashrc` — the three `export` lines should be present and `echo $NODE_EXTRA_CA_CERTS` should print the CA path. If absent: confirm `ENTERPRISE_MODE=active`, that the CA file existed at boot (`[entrypoint] Enterprise Mode: ... CA installed` log line, no `$CF_CA_SRC not found` WARNING), and the image is current; then restart the container to regenerate `.bashrc`. If the marker is present but the path is stale, delete the `# enterprise-ca-trust` block and restart.

<a id="enterprise-mode-agent-hits-a-non-openai-provider-error-uses-the-wrong"></a>
#### Enterprise Mode: agent hits a non-OpenAI provider error (e.g. Pi → AWS Bedrock `UnrecognizedClientException`), uses the wrong model, or **no request reaches the AI Gateway** (empty gateway logs)

**Fix detail:**

When `ENTERPRISE_MODE=active`, entrypoint.sh registers each agent against the `codeflare-gateway` provider with the fixed slash-free handle `codeflare` and pins Pi via `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`). If Pi shows the wrong provider: check `~/.pi/agent/models.json` has a `codeflare-gateway` entry **and** `settings.json` has the default pin. Do not configure a slash-bearing model id in the container — Pi parses `a/b` as `provider/model` and misroutes.

The real route is mapped by the `LlmInterceptor` from the agent's slash-free handle to `dynamic/<route>` using the Setup-configured catalog ([REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)) — verify the catalog/default are configured in the setup wizard and that the resolved route is an OpenAI-wire model that supports streaming + tool-calling. (Claude Code is not in the enterprise agent set; only Copilot, Pi, and Bash run under `ENTERPRISE_MODE=active`.)

<a id="enterprise-mode-agent-retries-every-streamed-reply-and-token-usage-mul"></a>
#### Enterprise Mode: agent retries every streamed reply and token usage multiplies (Pi logs `Stream ended without finish_reason`)

**Fix detail:**

Handled in-product by the `LlmInterceptor` streaming-terminator shim ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC3), which synthesizes the missing terminator on streaming `/chat/completions`. If the loop persists: confirm the deploy includes the shim (`[LlmInterceptor]` present in `wrangler tail`); confirm the response is actually `text/event-stream` on `/chat/completions` (the shim is bypassed for non-streaming and `/responses`); and confirm the resolved dynamic route is an OpenAI-wire model — a non-conformant backend can emit a stream the shim cannot repair. Note the gateway's stored response log is normalized and shows `finish_reason: stop` even when the live wire omits it; trust `wrangler tail`, not the stored log.

<a id="enterprise-mode-the-vault-editor-never-loads-silverbullet-service-work"></a>
#### Enterprise Mode: the Vault editor never loads / SilverBullet service worker fails to register (browser console shows a redirect on `service_worker.js`, 302 to `*.cloudflareaccess.com`)

**Fix detail:**

The setup wizard auto-provisions a higher-precedence Access **bypass** app (`decision: bypass`, include everyone) scoped to `/api/vault/*/service_worker.js` ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC6). If the SW still 302s: confirm setup completed under `ENTERPRISE_MODE=active`, check an Access app `codeflare-vault-sw-bypass` exists with a bypass policy at higher precedence than the host-wide app, and re-run setup to re-provision (provisioning is best-effort and emits a `logger.warn` if it failed).

<a id="mcp-graphify-returns-answers-from-the-wrong-repo"></a>
#### `mcp__graphify__*` returns answers from the wrong repo ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify))

**Fix detail:**

`cat ~/.cache/codeflare-hooks/graphify-active-cwd` should contain the current repo root. If missing, the active-repo hook has not fired yet - trigger a Bash `cd` to the repo, or Edit any file in it. Advanced session mode only: confirm `graphify-active-repo.sh` is registered under `~/.claude/settings.json` `hooks.PostToolUse`. Default mode has no sentinel by design (fallback only). This sentinel governs graphify graph resolution only.

<a id="pi-memory-vault-extraction-repeats-reminders-reaches-giveup-or-reports-done-without-advancing-state"></a>
#### Pi memory/Vault extraction repeats reminders, reaches GIVEUP, or reports Done without advancing state

**Symptom:** Extraction emits repeated delivery messages, reaches `background-extraction-giveup`, or finishes without advancing the memory counter or Vault manifest.

**Cause:** Pi treats the root transcript as delivery truth ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).

One emitted request remains pending until an exact public `subagent` call appears. Each failed exact call advances one reminder, only six failed calls reach GIVEUP, and a terminal notification cannot advance state without the required post-commit artifacts. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memorySuccessQualifies --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::vaultSuccessQualifies -->

**Fix:** Correlate the visible “Extraction jobs ready” summary, its pretty-printed `<extraction-items-json>`, the exact public call, and `subagent-notification` by tool-use ID. Memory requires `/home/user/Vault/Raw/Sessions/<captureFilename>` plus its request chunk after graph publication; Vault requires its post-commit chunk and staged manifest hash. Do not delete counters or manifests manually.

Current workers expose only Bash, use medium reasoning, stop after four turns, and cap noncritical visualization at 15 seconds. `VARS_FILE.transcript` is memory capture's complete input; `invalid INPUT_FILE: missing` identifies a stale mirror.

A memory result reporting `VARS_FILE` missing while the root can see the file under `/tmp/.memory-counter` identifies the legacy temp-backed snapshot visibility race. Reload a seed with the [home-backed extraction data flow](architecture.md#pi-memory-and-vault-extraction-data-flow); the root migrates an active legacy snapshot before retry.

Session graph output uses the note H1, `concept_<normalised_label>` IDs, and unique edges. A filename document label, colon-prefixed concepts, duplicate edges, broad worker tools, or review-scale runtime for one file identifies stale seed bytes; remirror and run `/reload` before reprocessing.

**Verification:** Repeated settlements without a public call emit no duplicate or GIVEUP; each failed exact call advances at most one reminder. At six failures, the structured GIVEUP message names the job, unchanged committed state, and its next automatic opportunity. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages -->

<a id="onboarding-mode-the-vault-editor-never-loads-silverbullet-service-work"></a>
#### Onboarding mode: the Vault editor never loads / SilverBullet service worker fails to register (browser console shows `script resource is behind a redirect`, 302 to `*.cloudflareaccess.com`)

**Fix detail:**

Fixed by the `isSessionOidcMode` gate in `src/routes/setup/index.ts` ([REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes)): setup now skips CF Access provisioning in any session-OIDC mode (SaaS OR onboarding) with `OAUTH_CLIENT_ID`. If a stale Access app was created by a manual or pre-fix run, delete it in the CF dashboard and clear the `setup:access_app_id` KV key, then re-run setup.

<a id="vault-sync-stuck-unhealthy-and-the-browser-console-spams-t-foreach-is"></a>
#### Vault sync stuck / unhealthy and the browser console spams `t.forEach is not a function` (or `o.map is not a function`) from the SilverBullet service worker

**Cause detail:**

The remote `fetchFileList()` in the native worker's sync cycle returned a non-array body — a transient proxy 5xx, an auth hiccup, or a stray Cloudflare Access 302 HTML body — so `e.json()` was a non-array and the sync-cycle consumers (`getNonSyncCandidates`'s `forEach`, then the remote `map`) threw; the sync loop never sets `stopping` on this path, so it crash-loops forever

**Fix detail:**

Fixed by a graft-layer `Array.isArray` coercion in `src/routes/vault/native-sw.ts` (`ANCHOR_REMOTE_LIST_COERCE`, [REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft) AC2): a non-array remote response now coerces to `[]` for a safe no-op cycle instead of crashing. Paired with the `isSessionOidcMode` setup fix above, which removes the stray CF Access 302 that was one trigger. If it recurs, check the proxy/`/api/vault/*` path is returning JSON arrays for the file-list endpoint and is not behind an unexpected redirect.

<a id="vault-readiness-button-never-goes-ready-and-the-silverbullet-service-w"></a>
#### Vault readiness button never goes ready and the SilverBullet service worker never registers (browser console shows a `SyntaxError` from `service_worker.js`, e.g. `Identifier 'o' has already been declared`)

**Fix detail:**

The coercion graft was added for the runtime non-array crash described in the row above; this fix keeps that behaviour while making it parseable. Fixed in `src/routes/vault/native-sw.ts`: the coercion now wraps the `o=` initializer with an array-coercing IIFE (`o=(a=>Array.isArray(a)?a:[])(await this.secondary.fetchFileList())`), keeping `o` a single declarator so the served worker stays syntactically valid. `vault-native-sw-direct.test.ts` guards this by constructing a `Function` from the served worker (parse check) and asserting the duplicate-`let` form is rejected. If it recurs after a SilverBullet re-vendor, re-verify the graft anchors and that the served worker parses.

<a id="vault-re-indexes-from-scratch-on-every-new-session-open"></a>
#### Vault re-indexes from scratch on every new session open (SilverBullet shows "Syncing…" for several minutes and re-downloads all notes each session)

**Fix detail:**

(1) DevTools → Application → Cookies: confirm the `cf_vault_sid` HttpOnly cookie is set after visiting `/api/vault/<sid>/`. (2) Confirm the redirect lands on `/api/vault/<token>/` where `<token>` is the same 32-hex value across sessions for the same user (it is `SHA-256(salt+bucketName)` — deterministic per bucket). (3) If `ENCRYPTION_KEY` was rotated, the `getVaultEncryptionKey` HKDF output changes and the persisted local cache can no longer decrypt — a one-time re-index after a rotation is expected. Otherwise redeploy the Worker.

<a id="vault-button-re-indexes-on-every-click-after-the-first-then-returns-gr"></a>
#### Vault button "re-indexes" on every click, returns green, but does not open (historical); v3 preparation does not converge

**Historical cause and fix:** Older builds embedded a session id in SilverBullet's precached shell and used session-keyed localStorage markers as readiness proof. A later session could read proof for another shell generation and re-run preparation despite a healthy store. The direct-green open fix removed that per-click re-verification; v3 removes shell session metadata entirely.

**Current timeout/error case:** A bounded preparation attempt failed; the UI reports only generic timeout or failure and never retries in the background. Open DevTools Network and Console: confirm `/api/vault/<sid>/status` returns `200` with `vaultReady: true`, then inspect the bootstrap navigation, service-worker registration, and `/.fs/` requests. A successful `/.fs/` response must be an array containing `CONFIG.md`, `Index.md`, and `STYLES.md`; HTTP 200 with any required file absent is still incomplete readiness.

If no request fails, start one new attempt and select the hidden Vault iframe's execution context while the button breathes. Confirm `window.sbRuntime?.ready`, `window.client?.systemReady`, `window.client?.pageListLoaded`, and `window.client?.clientSystem?.scriptsLoaded` are true, and confirm `window.client?.objectIndex?.hasFullIndexCompleted` exists and returns true. `window.client?.fullSyncCompleted === true` directly confirms sync; false is inconclusive because the bridge also accepts a closure-local `space-sync-complete` event latch that is not retrospectively observable. For the index queue, when `getQueueStats` is a function, `await window.client.mq.getQueueStats('indexQueue')` must report `queued`, `processing`, and `dlq` all zero; otherwise, when `isQueueEmpty` is a function, `await window.client.mq.isQueueEmpty('indexQueue')` must return true. If neither API is callable, runtime performs no queue-specific check.

Finally, confirm key recoverability without exposing key bytes: request `/api/vault/<sid>/.vault-key` with authenticated credentials and verify only its HTTP status; `200` follows successful key derivation. Do not open the request's Response or Preview, parse its JSON, or print or copy its body. Correct the observed condition, then click Vault once to retry. Verify that the button turns green only after two complete checks and opens on the following click ([REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC3/AC6, [REQ-VAULT-019](../../sdd/spec/vault.md#req-vault-019-vault-key-recoverable-open-gate) AC1-AC3, [REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC4).

**Current stale-worker case:** The first v3 prepare unregisters every stale same-origin `/api/vault/` worker and fails before canonical registration when re-enumeration still finds one ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC3/AC7). In DevTools → Application → Service Workers, confirm whether an old Vault scope remains. Close tabs still using that scope, unregister the stale Vault worker, reload the dashboard, and click Vault once; do not delete IndexedDB. Verify that only the current 32-hex Vault scope remains, unrelated workers are unchanged, preparation reaches green, and the second click opens.

<a id="enterprise-governed-mode-after-flipping-the-r2-sse-c-toggle-r2-sync-fa"></a>
#### Enterprise Governed Mode: after flipping the R2 SSE-C toggle, R2 sync fails and the vault never becomes ready (some objects 400 on read)

**Fix detail:**

Self-healing: a stray read falls back to the opposite regime and schedules a `mixed-recovery` scan. Writes stay 409-gated and containers drain on migration start, so it cannot re-mix mid-scan. Force it via any dashboard read; wait for the button to leave "Migrating"; verify via an R2 HEAD-scan (0 wrong-regime objects).

<a id="enterprise-mode-strict-gateway-egress-on-and-direct-internet-container"></a>
#### Enterprise Mode: Strict Gateway Egress ON and **direct-internet** container HTTP/HTTPS calls (and GitHub) fail with 503 `EGRESS_UNAVAILABLE`, while R2 sync / LLM / browser-run keep working

**Cause detail:**

The `[[vpc_networks]]` `EGRESS` binding is unbound, so `env.EGRESS` is undefined and direct-internet egress fails closed (no fallback) — this account's own-account destinations (R2 + account-scoped CF API / Browser Rendering) and the AI Gateway are exempt and stay reachable ([AD86](../decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)); the binding is enterprise-only and injected at deploy time only when `ENTERPRISE_MODE=active`, so it is absent on non-enterprise deploys ([REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress) Constraints)

<a id="enterprise-mode-container-traffic-goes-out-directly-when-you-expected"></a>
#### Enterprise Mode: container traffic goes out directly (not through the Gateway) when you expected it routed

**Cause detail:**

Either the Strict Gateway Egress toggle is OFF (the default) or the deployment is non-enterprise — so the catch-all is never wired and the GitHub interceptor transport swap is inert — **or** the host is one of this account's own-account destinations (own-account R2 `<accountId>.r2.cloudflarestorage.com`, the account-scoped CF API / Browser Rendering path, or the AI Gateway), which egresses direct **by design** even with the toggle ON ([AD86](../decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network), [REQ-ENTERPRISE-023](../../sdd/spec/enterprise-mode.md#req-enterprise-023-strict-gateway-egress-controller-transport) AC2, [REQ-ENTERPRISE-024](../../sdd/spec/enterprise-mode.md#req-enterprise-024-strict-gateway-egress-host-specific-interceptor-routing) AC2). Note: **another account's** R2/CF host is NOT exempt and rides the Gateway.

**Fix detail:**

If a direct-internet host is going direct: confirm `ENTERPRISE_MODE=active` (the `EGRESS` binding is injected automatically on enterprise deploys) and flip the Strict Gateway Egress toggle ON in the setup wizard (`setup:strict_egress` → `'active'`). If this account's own R2 / AI Gateway / browser-run is going direct with the toggle ON, that is the intended account-scoped exemption, not a misconfiguration.

<a id="enterprise-mode-strict-gateway-egress-on-and-the-session-hangs-on-sync"></a>
#### Enterprise Mode: Strict Gateway Egress ON and the session hangs on "Syncing…" / R2 persistence (vault & workspace bisync) stalls or times out

**Fix detail:**

Fixed: this account's own R2 (`<accountId>.r2.cloudflarestorage.com`) is account-scoped-exempt and egresses **direct** (never `cf1:network`), so bisync no longer depends on the Gateway path. Update the deploy to the build with the `isAccountScopedDestination()` exemption (`src/lib/controller-egress.ts`). The AI Gateway and the account-scoped Browser Rendering path are exempt the same way.

<a id="enterprise-mode-strict-gateway-egress-on-and-interactive-browser-run-f"></a>
#### Enterprise Mode: Strict Gateway Egress ON and interactive browser-run (Chrome DevTools / Pi `chrome-devtools`) fails with `400` "Could not connect to Chrome" / the CDP WebSocket handshake dies (`Network connection lost`), while non-interactive browser REST calls work

**Fix detail:**

Fixed: the `EgressController` detects an `Upgrade: websocket` request and **bridges a fresh `WebSocketPair`** to the upstream socket (accept both ends, forward frames/close/error both ways), returning a `101` carrying the client end. Browser-run's CDP WS is now claimed by the per-host `CloudflareBrowserInterceptor` ([REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)), which bridges the upgrade the same way and injects the real Browser Rendering token worker-side — the container carries only the non-secret placeholder; the generic `EgressController` bridge serves any other catch-all WS.

Returning the upstream `101`+`webSocket` *as-is* (an earlier build) does **not** hand the socket back to the container — it stalls and is `canceled`; the bridge is what makes it work ([REQ-ENTERPRISE-023](../../sdd/spec/enterprise-mode.md#req-enterprise-023-strict-gateway-egress-controller-transport) AC3, [AD87](../decisions/README.md#ad87-egresscontroller-re-signs-own-account-r2-container-holds-a-placeholder-key-bridges-websocket-upgrades-and-resolves-strict-via-props)).

Update the deploy to the build with the WebSocket-**bridge** path (`src/egress-controller.ts`).

**If browser-run still `canceled`s after this deploy** (the open point on whether an *outbound* interceptor propagates a returned `101`): the per-host `CloudflareBrowserInterceptor` already claims `api.cloudflare.com` ahead of the `'*'` catch-all and bridges the CDP WS itself, injecting the real token at that boundary while the container carries only the placeholder ([REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)).

## GitHub Integration

| Symptom | Cause | Fix |
|---------|-------|-----|
| GitHub panel not visible while `GET /api/github/status` returns `{ enabled: true }` | The current Dashboard renders the GitHub face whenever GitHub is enabled, with no session-tier gate ([REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)). A missing face indicates stale frontend assets/state rather than Standard versus Advanced mode. | Reload the current deployment assets and reopen the session/dashboard. Verify the deployed head contains the current GitHub panel and that the backend remains enabled; changing session tier is not a fix. |
| `GET /api/github/connect` returns `503 GITHUB_NOT_CONFIGURED` | No provider is available. Every mode resolves the admin Setup KV provider first, then falls back to environment GitHub App or OAuth credentials when KV is unconfigured. | Configure the GitHub App or OAuth App in the admin Setup wizard. Environment credentials remain a fallback; a configured GitHub App takes precedence over OAuth. |
| `/api/github/repos` returns `401 NOT_CONNECTED`, or the agent's git/`gh` calls fail with auth errors in enterprise | No valid token for the session — never connected, or an expired GitHub App token that could not be refreshed. The system fails closed and never falls back to a stale token. | Click **Connect GitHub** again to re-authorize. |
| Clone fails with "already exists" / `409 CLONE_TARGET_EXISTS` | `$USER_WORKSPACE/<repo-name>` already exists; clone refuses to overwrite it | Remove or rename the existing folder, or clone into a new session. |
| Clone returns `503 NOT_RUNNING` | The target session's container is asleep, so `POST /api/github/clone` (running-session path) cannot reach it | Start/wake the session first, or use the new-session clone (`POST /api/sessions` with a `clone` field), which clones before the agent starts ([REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session)). |
| `429` from connect / repos / clone | Per-user rate limits: connect/disconnect 20/min, repos 60/min, clone 20/min | Wait for the window — the `Retry-After` and `X-RateLimit-*` response headers give the retry delay and the ceiling/remaining count — then retry. |
| In enterprise, the in-session `GH_TOKEN` env shows `codeflare-enterprise` instead of a real token | By design — the container holds only a non-secret placeholder; the real token is injected at the egress boundary ([REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials)) | Not a bug. git/`gh`/API calls to github.com still authenticate because injection happens at egress. If they fail, the token isn't connected — see the `401 NOT_CONNECTED` row above. |

## Browser Run

| Symptom | Cause | Fix |
|---------|-------|-----|
| In an advanced session the browser tools (`browser_markdown` / `chrome-devtools`) are missing and the `browser-run` / `browser-e2e` skills are absent | No Cloudflare Browser Rendering token is configured, so the whole browser-run surface is withheld — the MCP servers and the Pi extension self-gate, and the skills are stripped ([REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)) | Enterprise: an admin sets the Browser Rendering token (+ account id) in the Setup wizard. Other modes: paste a Cloudflare token carrying `Browser Rendering - Edit` in Push & Deploy settings. Takes effect on the next session start. |
| Browser tools missing in a Standard (default) session | Browser Run is advanced-mode only | Switch the session to advanced/Pro mode (enterprise sessions are always advanced). |

<a id="diagnostic-commands"></a>
## Diagnostic Command Reference

**Check container status:**
```bash
curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
  https://codeflare.example.com/api/container/startup-status?sessionId=abc12345
```

**Verify secrets:**
```bash
wrangler secret list
# Expected: CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

**Monitor logs:**
```bash
wrangler tail codeflare
wrangler tail codeflare --status error
```

---

## Related Documentation
- [Architecture](architecture.md#system-components) - System component overview
- [Configuration](configuration.md#secrets) - Secret management
- [Container](container.md#container-startup) - Container startup sequence
- [Storage & Sync](storage-and-sync.md) - Sync mechanics
- [Authentication](security.md#authentication-gate) - Auth flow
- [Security - GitHub Token Handling](security.md#github-token-handling) - Egress-injection model, placeholder token, non-enterprise behaviour
- [Configuration - GitHub Integration](configuration.md#github-integration) - GitHub App vs OAuth provider, env var reference

---

<a id="specification-coverage"></a>
## Requirement and Source Map

Exhaustive requirement status remains in the specialist SDD domains. Recipes carry clause-local links; this map routes diagnosis to the authoritative subsystem.

| Recipe family | Requirements / source owner | Canonical contract |
|---|---|---|
| Browser IDE | Browser IDE SDD; Worker/host/package sources | [Container](container.md), [Architecture Internals](architecture-internals.md) |
| Authentication/setup | Authentication and Setup SDD | [Authentication](authentication.md), [Configuration](configuration.md) |
| Terminal/mobile | Terminal and Mobile SDD | [Mobile](mobile.md), [API Reference](api-reference.md#terminal) |
| Session/container | Session Lifecycle and Operations SDD | [Container](container.md), [Storage & Sync](storage-and-sync.md) |
| Storage/Vault | Storage, Vault, Memory SDD | [Storage & Sync](storage-and-sync.md), [Vault](vault.md) |
| Agents/review/CI | Agents and Operations SDD | [Preseed](preseed.md), [CI/CD](ci-cd.md) |
| Enterprise/provider | Enterprise, GitHub, Browser Run SDD | [Security](security.md), private operations for non-public runbooks |
