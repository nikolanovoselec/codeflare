# Browser IDE agents

**Audience:** Browser IDE contributors

**Owns:** agent inventory selection, owned extension composition, package-local process adapters, UI-state projection code, package compatibility, and package verification.

**Does not own:** public routes, container lifecycle, system-wide security rationale, deployment configuration, or durable persistence policy. Those remain in the canonical documentation lanes.

The directory name is a retained private migration identifier. The selected IDE agent is always a separate process and conversation from terminal tab 1.

## Selection and UI

| Tab 1 | Immutable inventory | IDE experience |
|---|---|---|
| Exact `pi` | `/opt/codeflare/openvscode/extensions/pi` | **Codeflare** is the default participant in panel Chat and editor Inline Chat |
| Exact supported Claude command | `/opt/codeflare/openvscode/extensions/claude` | Anthropic's official Claude Code panel in the right sidebar |
| Unsupported or invalid configuration | `/opt/codeflare/openvscode/extensions/none` | No agent extension |

An absent `TAB_CONFIG` keeps the legacy Claude default. Malformed JSON, duplicate tab IDs, missing tab 1, command suffixes, and unsupported agents select the empty inventory. Classification never executes or rewrites the terminal command.

Every inventory opens the separate owned Codeflare welcome editor. Its action opens Codeflare Chat for Pi, the official Claude panel for Claude, and Explorer when no IDE agent is supported; the welcome package contributes no agent/model surface.

## Package map

| Area | Location | Responsibility |
|---|---|---|
| Inventory and activation | `agent-sidebar/src/extension.ts` | Participant/model registration, inventory context, welcome integration |
| Native Pi adapter | `agent-sidebar/src/pi/` | RPC lifecycle, prompts, approvals/dialogs, native Chat surfaces |
| Packaging | `agent-sidebar/src/package-extension.ts`, `agent-sidebar/esbuild.mjs` | Deterministic extension output and package identity |
| Welcome extension | `agent-sidebar/src/welcome*.ts`, `agent-sidebar/welcome-package.json` | Shared editor content and inventory-specific actions |
| Claude projection | `claude/` | Allowlisted config projection and managed settings around the unmodified package |
| Package tests | `agent-sidebar/test/`, `claude/test/` | Behavioral package and projection verification |

## Native Pi Chat

The owned extension registers stable participant ID `codeflare.pi`, visibly named **Codeflare**, in panel Chat and the pinned editor Inline Chat surface. Its hidden fallback and visible account-free model exist only to satisfy the pinned host's eligibility and model lookup; neither performs inference or requests authorization. Pi RPC remains the inference path and does not use VS Code Authentication or Copilot.

The first request lazily starts one IDE-owned `/usr/local/bin/pi --mode rpc --no-session --no-themes` process. Panel and editor share its FIFO in-memory conversation, separate from terminal Pi. Accepted turns retain it; active cancellation, failure, exit, or deactivation boundedly reap it before replacement. The package captures bounded canonical-workspace editor context and rejects external paths, symbolic aliases, and malformed references.

Native `select` and `input` requests use bounded VS Code dialogs. Unknown or malformed blocking requests fail closed. Pi retains direct tools and can change files or run commands beyond an editor selection; those effects are not transactional host edits and Inline Chat Keep/Undo is not a rollback guarantee.

Detailed lifecycle, trust, and state contracts belong to [Container](../documentation/lanes/container.md#code-server-browser-ide) and [Security](../documentation/lanes/security.md#browser-ide-native-agents).

## Official Claude Code

The image uses Anthropic's exact checksum-pinned package without patching or redistributing its source; the [pin manifest](agent-sidebar/official-claude.json) and [checksum-validating build stage](../Dockerfile) are the direct evidence. Codeflare prepares an allowlisted temporary configuration projection and managed settings outside the package. The official extension owns its loopback-authenticated IDE MCP transport, panel, context, native diffs, and lifecycle; Codeflare adds no public relay or tool-approval layer.

Claude package-selection, pinning, and complete-image behavior belong to [Container](../documentation/lanes/container.md#code-server-browser-ide). Projection-file mechanics belong to [Claude IDE configuration](claude/README.md).

## Workspace selection and safe continuity

The public Browser IDE location stays clean and rejects browser-supplied workspace selectors at Worker and host boundaries. Only the private loopback root hop receives the canonical workspace. This limits public navigation; terminals, trusted extensions, and agents retain container filesystem access.

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
