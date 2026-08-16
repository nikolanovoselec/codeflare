# Browser IDE agents

**Audience:** Browser IDE contributors

**Owns:** agent inventory selection, owned extension composition, package-local process adapters, UI-state projection code, package compatibility, and package verification.

**Does not own:** public routes, container lifecycle, system-wide security rationale, deployment configuration, or durable persistence policy. Those remain in the canonical documentation lanes.

The directory name is a retained private migration identifier. The selected IDE agent is always a separate process and conversation from terminal tab 1.

## Selection and UI

| Tab 1 | Immutable inventory | IDE experience |
|---|---|---|
| Exact `pi` | `/opt/codeflare/openvscode/extensions/pi` | **Codeflare** is the default panel participant and produces host-owned native Inline Chat edits; panel Pi remains unrestricted |
| Exact supported Claude command | `/opt/codeflare/openvscode/extensions/claude` | Anthropic's official Claude Code panel in the right sidebar |
| Unsupported or invalid configuration | `/opt/codeflare/openvscode/extensions/none` | No agent extension |

An absent `TAB_CONFIG` keeps the legacy Claude default. Malformed JSON, duplicate tab IDs, missing tab 1, command suffixes, and unsupported agents select the empty inventory. Classification never executes or rewrites the terminal command.

Every inventory manages `workbench.startupEditor` to `none`, suppressing code-server's default Welcome editor, then opens only the owned Codeflare welcome editor with self-contained nonce-bound HTML. It establishes full VS Code and the shared live workspace as universal, then identifies native Pi, the official Claude Code panel, or editor-only mode. Its action opens Codeflare Chat, Claude Code, or Explorer respectively; the welcome package contributes no agent/model surface or external content.

## Package map

| Area | Location | Responsibility |
|---|---|---|
| Inventory and activation | `agent-sidebar/src/extension.ts` | Participant/model registration, inventory context, welcome integration |
| Native Pi adapter | `agent-sidebar/src/pi/` | RPC lifecycle, prompts, approvals/dialogs, native Chat surfaces |
| Inline proposal gate | `../preseed/agents/pi/extensions/inline-edit.ts` | Per-turn proposal-only tools and exact panel-tool restoration |
| Packaging | `agent-sidebar/src/package-extension.ts`, `agent-sidebar/esbuild.mjs` | Deterministic extension output and package identity |
| Welcome extension | `agent-sidebar/src/welcome*.ts`, `agent-sidebar/welcome-package.json` | Shared editor content and inventory-specific actions |
| Claude projection | `claude/` | Allowlisted config projection and managed settings around the unmodified package |
| Package tests | `agent-sidebar/test/`, `claude/test/` | Behavioral package and projection verification |

## Native Pi Chat

The owned extension registers stable participant ID `codeflare.pi`, visibly named **Codeflare**, in panel Chat and the pinned editor Inline Chat surface. Its hidden fallback and visible account-free model exist only to satisfy the pinned host's eligibility and model lookup; neither performs inference or requests authorization.

The pinned private request contract distinguishes editor submissions and supplies the invoking document, selection, and whole range. Codeflare uses that host-owned location as the sole editor source and emits one empty `textEdit` start marker, one validated edit batch, then one completion marker for the same URI. The managed Pi profile disables the configuration-gated chat-edited-file opener; the host's separate different-URI side-group path remains identity-driven. The pinned Inline controller owns native Keep/Close, session settlement, disposal, and navigation; Codeflare emits no review confirmation, notification action, Chat Editing command, or document reopen. Pi RPC remains the inference path and does not use VS Code Authentication or Copilot.

Pi disables the host's unrelated built-in AI setup through managed settings and reasserts that setup hidden before refreshing its account-free models, so the bottom-right status does not compete with Codeflare; the registered participant remains available, while provider generation and VS Code Authentication stay outside Pi inference.

The first request lazily starts one IDE-owned `/usr/local/bin/pi --mode rpc --no-session --no-themes` process. Unrestricted panel turns and proposal-only editor turns share its FIFO in-memory conversation, separate from terminal Pi. The inline command saves the exact panel tool set, dispatches through Pi's `ExtensionAPI.sendUserMessage`, and restores the tools around one terminating proposal call. Accepted turns retain the process; cancellation, malformed proposals, either Pi 0.84.1 inline-dispatch error envelope, failure, exit, or deactivation boundedly reap it before replacement.

The package captures bounded canonical-workspace editor context and rejects external paths, symbolic aliases, and malformed references. During an active editor request, the local **Codeflare Inline Chat** Output channel records bounded revision, setting, request-URI, stream-URI, and tab-identity diagnostics without document content; it does not instrument panel turns. Native `select` and `input` requests use bounded VS Code dialogs. Panel Pi retains direct tools and unrestricted container access. Its provider-emitted reasoning uses the native thinking presentation, while tool calls emit one argument-free status per bounded activity category rather than one row per call. Inline proposals target only the host-captured invoking document, fail on stale or invalid ranges, and use native controller-owned Keep/Close because Pi never applies those edits directly. Schema-invalid raw proposals may be corrected within the same turn under a three-attempt bound; invalid-only settlement reports a bounded correlation, summary, count, or geometry category.

Detailed lifecycle, trust, and state contracts belong to [Container](../documentation/lanes/container.md#code-server-browser-ide) and [Security](../documentation/lanes/security.md#browser-ide-native-agents).

## Official Claude Code

The image uses Anthropic's exact checksum-pinned package without patching or redistributing its source; the [pin manifest](agent-sidebar/official-claude.json) and [checksum-validating build stage](../Dockerfile) are the direct evidence. Codeflare prepares an allowlisted temporary configuration projection and managed settings outside the package. The official extension owns its loopback-authenticated IDE MCP transport, panel, context, native diffs, and lifecycle; Codeflare adds no public relay or tool-approval layer.

Claude package-selection, pinning, and complete-image behavior belong to [Container](../documentation/lanes/container.md#code-server-browser-ide). Projection-file mechanics belong to [Claude IDE configuration](claude/README.md).

## Workspace selection and safe continuity

The public Browser IDE location stays clean and rejects browser-supplied workspace selectors at Worker and host boundaries. Only the private loopback root hop receives the canonical workspace. Its projected `vscode-remote` folder uses the proxy's canonical public browser authority rather than code-server's server-side `remote` placeholder, keeping renderer and extension-host document identities equal. This limits public navigation; terminals, trusted extensions, and agents retain container filesystem access.

Live code-server state remains ephemeral. Package code exports only the approved theme, string keyboard layout, Explorer expansion, and canonical in-workspace open-file state into the bounded snapshot. Credentials, authentication, unapproved settings, extension/global/workspace storage, editor databases, chat history, logs, WAL, and SHM are excluded. The canonical persistence and security consequences belong to [Container](../documentation/lanes/container.md) and [Storage & Sync](../documentation/lanes/storage-and-sync.md).

<a id="build-and-verification"></a>
## Develop and verify

From `openvscode/agent-sidebar/`:

```sh
npm install
npm run check:dependencies
npm run typecheck
npm test
npm run build
```

The suite includes the parent extension, native Pi behavior, packaging, welcome extension, and `../claude/test/*.test.mjs` projection tests through the package Vitest configuration. GitHub Actions remains authoritative for deterministic report reconciliation and complete-image smoke verification.

Volatile Node, code-server/Code OSS, Pi, and Claude pins remain owned by package manifests, Docker inputs, lockfiles, and [Container](../documentation/lanes/container.md); this reference does not duplicate them.

## Canonical references

- [Architecture Internals — Browser IDE internals](../documentation/lanes/architecture-internals.md#browser-ide-internals)
- [Container — code-server Browser IDE](../documentation/lanes/container.md#code-server-browser-ide)
- [Security — Browser IDE native agents](../documentation/lanes/security.md#browser-ide-native-agents)
- [Browser IDE requirements](../sdd/spec/browser-ide.md)
- [Documentation router](../documentation/README.md)
