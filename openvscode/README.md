# Browser IDE agents

Codeflare gives the agent selected in terminal tab 1 an editor-native code-server integration. The directory name is a retained private migration identifier. The IDE agent remains a separate process and conversation from terminal tab 1.

## Selection and UI

| Tab 1 | Immutable inventory | IDE experience |
|---|---|---|
| Exact `pi` | `/opt/codeflare/openvscode/extensions/pi` | Codeflare Pi is the default participant in code-server's main native Chat |
| Exact supported Claude command | `/opt/codeflare/openvscode/extensions/claude` | Anthropic's official Claude Code panel in the right sidebar |
| Unsupported or invalid configuration | `/opt/codeflare/openvscode/extensions/none` | No agent extension |

An absent `TAB_CONFIG` keeps the existing Claude default. Malformed JSON, duplicate tab IDs, a missing tab 1, command suffixes, and other agents select the empty inventory. Classification never executes or rewrites the terminal command.

## Native Pi Chat

The Codeflare-owned workspace extension registers `codeflare.pi` as the pinned host's default native Chat participant. The extension retains one hidden, account-free, panel-only compatibility model for the native participant's model-entry contract; it cannot generate responses, and complete-image plus deployed activation validate it against the pinned Code OSS host. Code OSS 1.130 accepts an implicit participant default only under its reserved `copilot` vendor key, which the shim uses solely as an internal selector without invoking GitHub Copilot or authorization. The image removes code-server's bundled GitHub Copilot extension entirely.

Pi never reads `request.model` or sends inference through that provider: it calls `/usr/local/bin/pi --mode rpc --no-session --no-themes` directly and never uses VS Code Authentication or Copilot, so no Microsoft, GitHub, Copilot, or Anthropic login is needed.

Every request receives bounded native Chat history plus the active workspace document, selected text, open workspace documents, diagnostics, and explicit references. Canonical path checks exclude files outside `/home/user/workspace`, symbolic-link aliases, and malformed native references. Editor data is marked untrusted and the complete RPC prompt is capped at 512 KiB.

Each request owns a fresh process generation. Pi streams assistant text and tool progress into native Chat, completes only at `agent_settled`, and is then reaped. Cancellation during startup prevents the prompt; after acceptance it sends Pi's correlated abort before cleanup. Sidebar Pi keeps its unrestricted built-in tools, and any extension confirmation auto-approves without opening an editor document or modal.

## Official Claude Code

The image build fetches Anthropic's exact unmodified `linux-x64` VSIX from Open VSX, verifies its pinned SHA-256 and package identity, extracts the official files into the Claude-only inventory, deletes the archive, and makes the installed tree root-owned and immutable. Codeflare applies settings externally and does not patch or serve Anthropic's package. The owner accepts its all-rights-reserved license ambiguity for server-image inclusion.

Before Claude's code-server inventory starts, Codeflare creates `/tmp/codeflare-sidebar/claude/config` as an allowlisted projection of approved credentials and configuration. Terminal projects, history, runtime state, caches, and logs are excluded. Ephemeral code-server User settings select Anthropic's native UI, unrestricted `bypassPermissions` mode, dangerous permission skipping, no Anthropic login prompt, the right sidebar, and disabled unrelated native Chat/Copilot features. code-server does not launch if preparation fails.

Anthropic's official extension runs its documented IDE MCP server on `127.0.0.1` with a random port and fresh authorization token under the private temporary config. This owner-approved local exception supplies active-file context, selections, native diffs, and diagnostics without adding a Codeflare relay or public listener. No Claude tool call is approval-gated.

The official package contributes its own Claude Code webview, not a code-server `chatParticipant` or language-model provider. Claude settings therefore disable the unrelated native Chat and Copilot setup before launch. Use the Claude Code panel with a selection or `@` reference. The upstream Accounts control may still offer manual authentication, but it is separate from Claude and Codeflare adds no credential request, bridge, export, persistence, or sync path.

## Build and verification

The owned Pi package is built under Node 22.21.1 for code-server's pinned Code OSS 1.130.0 host. It has no native addon or runtime npm dependency. The official Claude package is version- and checksum-pinned independently. Fixed staging validates both package identities, creates the Pi, Claude, and empty inventories atomically, rejects symbolic links and retained VSIX archives, and removes write permission.

The required `browser-ide` lane performs dependency and license checks for owned code, typecheck, deterministic build, behavioral tests, and report reconciliation. `browser-ide-image` builds the complete image, has the pinned host discover both extension IDs, verifies packaged native Pi registration, official Claude identity/binary and production preparation, isolated settings, permissions, inventory immutability, and process laziness, then records image size and idle resources.

This constrained development container does not run builds or tests locally. Use GitHub Actions and an exact reviewed integration deployment.

See [REQ-IDE-005](../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-006](../sdd/spec/browser-ide.md#req-ide-006-ide-conversation-context-and-credential-isolation), [REQ-IDE-007](../sdd/spec/browser-ide.md#req-ide-007-ide-guarded-approval), [REQ-IDE-008](../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle), [AD114](../documentation/decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration), [Container](../documentation/lanes/container.md#code-server-browser-ide), and [Security](../documentation/lanes/security.md#browser-ide-native-agents).
