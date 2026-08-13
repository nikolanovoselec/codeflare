# Browser IDE agents

Codeflare gives the agent selected in terminal tab 1 an editor-native code-server integration. The directory name is a retained private migration identifier. The IDE agent remains a separate process and conversation from terminal tab 1.

## Selection and UI

| Tab 1 | Immutable inventory | IDE experience |
|---|---|---|
| Exact `pi` | `/opt/codeflare/openvscode/extensions/pi` | **Codeflare** is the default participant in panel Chat and editor Inline Chat |
| Exact supported Claude command | `/opt/codeflare/openvscode/extensions/claude` | Anthropic's official Claude Code panel in the right sidebar |
| Unsupported or invalid configuration | `/opt/codeflare/openvscode/extensions/none` | No agent extension |

An absent `TAB_CONFIG` keeps the existing Claude default. Malformed JSON, duplicate tab IDs, a missing tab 1, command suffixes, and other agents select the empty inventory. Classification never executes or rewrites the terminal command.

## Native Pi Chat

The Codeflare-owned workspace extension registers the stable private ID `codeflare.pi` as the pinned host's default participant in panel Chat and the existing editor Inline Chat **Refactor...** area, visibly named **Codeflare**. A hidden, non-selectable panel fallback under the reserved `copilot` vendor preserves the pinned extension host's absent-request-model lookup. A second selectable, account-free model under Codeflare's distinct `codeflare` vendor makes Codeflare eligible and default in both host locations without entering Code OSS's Copilot entitlement or sign-in flow; only this visible model advertises tool calling because the pinned Inline Chat filter requires it. Neither model can generate responses. The image removes code-server's bundled GitHub Copilot extension entirely.

Pi never reads `request.model` or sends inference through either provider: it calls `/usr/local/bin/pi --mode rpc --no-session --no-themes` directly and never uses VS Code Authentication or Copilot, so no Microsoft, GitHub, Copilot, or Anthropic login is needed.

The Pi inventory activates its owned provider immediately so every model picker starts with Codeflare, and marks generic Chat setup complete on startup, suppressing Code OSS's account-backed **Code Review** action without disabling native Chat. Every inventory also seeds Code OSS's supported web-profile visibility value for only `chat.statusBarEntry` and disables the separate left-side Accounts control through `workbench.activity.showAccounts`, removing both login affordances without disabling authentication APIs or independent agent credentials.

It also disables Code OSS discovery of `~/.claude/agents` while retaining the equivalent `~/.copilot/agents` definitions, so each seeded Codeflare custom agent appears once in the Agent selector; native Pi continues to discover `~/.pi/agent/agents` independently. Right-click a workspace file in Explorer or inside its active editor and select **Review with Codeflare** to attach that file and submit a review directly to Codeflare. Files outside the workspace and symbolic-link aliases are rejected before Chat opens.

Every request receives bounded native Chat history plus the active workspace document, selected text, open workspace documents, diagnostics, and explicit references. Canonical path checks exclude files outside `/home/user/workspace`, symbolic-link aliases, and malformed native references. Editor data is marked untrusted and the complete RPC prompt is capped at 512 KiB.

Each panel or editor request owns a fresh process generation. Pi streams assistant text and tool progress into native Chat, completes only at `agent_settled`, and is then reaped. Cancellation during startup prevents the prompt; after acceptance it sends Pi's correlated abort before cleanup. Sidebar Pi keeps its unrestricted built-in tools, and any extension confirmation auto-approves without opening an editor document or modal. Documented Pi `select` and `input` requests use bounded native VS Code dialogs, honor bounded RPC timeouts, and return correlated values or cancellation; malformed and unknown blocking UI requests remain fail-closed. Pi writes files and runs commands directly, including beyond the selected range; those effects are not transactional host edits and Codeflare does not promise that Inline Chat Keep/Undo reverses them.

The Pi inventory enables pinned Code OSS's own OS notifications for received responses and native confirmations when the editor is unfocused. Code OSS owns browser permission, focus policy, lifetime, and click behavior; Codeflare does not duplicate native Chat events through the terminal OSC bridge.

## Official Claude Code

The image build fetches Anthropic's exact unmodified `linux-x64` VSIX from Open VSX, verifies its pinned SHA-256 and package identity, extracts the official files into the Claude-only inventory, deletes the archive, and makes the installed tree root-owned and immutable. Codeflare applies settings externally and does not patch or serve Anthropic's package. The owner accepts its all-rights-reserved license ambiguity for server-image inclusion.

Before Claude's code-server inventory starts, Codeflare creates `/tmp/codeflare-sidebar/claude/config` as an allowlisted projection of approved credentials and configuration. Terminal projects, history, runtime state, caches, and logs are excluded. Ephemeral code-server User settings select Anthropic's native UI, unrestricted `bypassPermissions` mode, dangerous permission skipping, no Anthropic login prompt, the right sidebar, and disabled unrelated native Chat/Copilot features. code-server does not launch if preparation fails.

Anthropic's official extension runs its documented IDE MCP server on `127.0.0.1` with a random port and fresh authorization token under the private temporary config. This owner-approved local exception supplies active-file context, selections, native diffs, and diagnostics without adding a Codeflare relay or public listener. No Claude tool call is approval-gated.

The official package contributes its own Claude Code webview, not a code-server `chatParticipant` or language-model provider. Claude settings therefore disable the unrelated native Chat and Copilot setup before launch. Use the Claude Code panel with a selection or `@` reference. Its upstream panel notifications remain in-product; Codeflare does not patch the checksum-pinned extension, scrape code-server UI, or add a private relay to turn them into OS notifications. Claude terminal tab 1 separately uses Claude's native terminal notification channel under REQ-TERM-024. The Accounts control is hidden for every inventory, while authentication APIs remain available and Codeflare adds no credential request, bridge, export, persistence, or sync path.

## Workspace selection and safe continuity

The browser keeps a clean `/api/vscode/<sessionId>/` location. Public `folder`, `workspace`, and `ew` selectors are rejected independently by the Worker and container host for HTTP and WebSocket requests. Only the private loopback root request receives `folder=/home/user/workspace`; redirects remove selectors before they become browser-visible. This confines public workspace selection, not terminal, trusted-extension, or agent filesystem access.

Live code-server state remains under `/tmp/openvscode-data`. After the launch generation is fully reaped, `browser-ide-ui-state.py` exports only theme, Explorer expansion, and canonical in-workspace open-file state into the atomic, maximum-1-MiB `~/.codeflare/ide-ui-state.json` snapshot. A later session reconstructs fresh workspace storage before managed inventory settings are reapplied. Raw databases, `workspaceStorage`, `globalStorage`, SecretStorage, Accounts authentication, chat history, logs, WAL, and SHM are never synced.

## Build and verification

The owned Pi package is built under Node 22.21.1 for code-server's pinned Code OSS 1.132.0 host. It has no native addon or runtime npm dependency. The official Claude package is version- and checksum-pinned independently. Fixed staging validates both package identities, creates the Pi, Claude, and empty inventories atomically, rejects symbolic links and retained VSIX archives, and removes write permission.

The required `browser-ide` lane performs dependency and license checks for owned code, typecheck, deterministic build, behavioral tests, and report reconciliation. `browser-ide-image` builds the complete image, has the pinned host discover both extension IDs, verifies packaged native Pi registration, official Claude identity/binary and production preparation, isolated settings, permissions, inventory immutability, and process laziness, then records image size and idle resources.

This constrained development container does not run builds or tests locally. Use GitHub Actions and an exact reviewed integration deployment.

See [REQ-IDE-002](../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-005](../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](../sdd/spec/browser-ide.md#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-007](../sdd/spec/browser-ide.md#req-ide-007-ide-guarded-approval), [REQ-IDE-008](../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-011](../sdd/spec/browser-ide.md#req-ide-011-file-review-with-codeflare), [REQ-IDE-019](../sdd/spec/browser-ide.md#req-ide-019-codeflare-eligibility-in-editor-inline-chat), [REQ-IDE-020](../sdd/spec/browser-ide.md#req-ide-020-unrestricted-pi-editor-request-execution), [REQ-IDE-021](../sdd/spec/browser-ide.md#req-ide-021-account-free-browser-ide-chrome), [REQ-IDE-022](../sdd/spec/browser-ide.md#req-ide-022-native-pi-blocking-ui-protocol), [REQ-IDE-012](../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [AD114](../documentation/decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration), [Container](../documentation/lanes/container.md#code-server-browser-ide), and [Security](../documentation/lanes/security.md#browser-ide-native-agents).
