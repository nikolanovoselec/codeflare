# Browser IDE agent sidebar

Codeflare packages one workspace extension for OpenVSCode Server. It provides an Activity Bar view for the agent selected in terminal tab 1. The sidebar starts a new conversation and never attaches to the terminal process.

## Selection

`entrypoint.sh` classifies tab 1 without executing or rewriting its command:

| Tab 1 | Extension inventory | Sidebar backend |
|---|---|---|
| Exact `pi` | `/opt/codeflare/openvscode/extensions/pi` | `/usr/local/bin/pi --mode rpc --no-session --no-themes` |
| Exact supported Claude command | `/opt/codeflare/openvscode/extensions/claude` | `/usr/local/bin/claude` in `node-pty` |
| Unsupported or invalid configuration | `/opt/codeflare/openvscode/extensions/none` | None |

An absent `TAB_CONFIG` keeps the existing Claude default. Malformed JSON, duplicate tab IDs, a missing tab 1, command suffixes, and other agents select the empty inventory.

The Pi and Claude inventories contain hard-linked copies of the same Codeflare-owned package. The image contains no Anthropic VSIX and does not use a marketplace, ACP, a relay, or another container.

## Runtime

The extension activates when its view is requested, but activation itself starts no child. The first visible resolution creates one selected backend and reuses it until a new conversation or teardown.

Pi uses strict LF-delimited JSONL with bounded records and correlated request IDs. It has no session file. The sidebar guard replaces edit, write, and Bash with approval-aware tools, keeps same-file approval windows serialized, atomically replaces a revalidated target from a synced sibling file, and sends an opaque manifest ID with its SHA-256 digest through Pi's extension UI request. The OpenVSCode extension host verifies the mode-0600 manifest against that digest, displays the preview, and owns the confirmation.

Claude runs as the existing pinned CLI in a real PTY rendered by locally bundled xterm.js. It receives raw terminal input, output, resize events, and Ctrl+C. It does not receive `--dangerously-skip-permissions`. Its fixed settings keep Manual mode, explicit ask rules, and the native permission dialog. Each launch recreates `/tmp/codeflare-sidebar/claude/config` as a mode-0700 allowlisted projection. Terminal history, resumable projects, caches, logs, and runtime state are excluded.

Both backends use `/home/user/workspace` and inherit the container's approved credentials and routing environment. The webview cannot choose an executable, working directory, environment, settings path, raw RPC command, or approval response.

## Lifecycle

Each OpenVSCode launch has a fresh generation token plus recorded PID, process group, and start time. Every Pi or Claude conversation also gets its own descendant token. New conversation, restart, and shutdown send TERM, wait for the bounded grace period, then send KILL to every process that still carries the token before starting a replacement. Token scans remain safe when the recorded leader exits, becomes a zombie, changes groups, or has its PID reused.

## Build and verification

`openvscode/agent-sidebar/package-lock.json` pins `node-pty`, xterm.js, and build dependencies. Docker compiles `node-pty` in a digest-pinned Node 22.21.1 stage for OpenVSCode's addon ABI 127. The runtime image stages fixed immutable inventories and a root-owned Claude settings overlay.

The required `browser-ide` CI lane performs a clean install, dependency and license checks, typecheck, deterministic build, coverage, behavioral tests, and report reconciliation. `browser-ide-image` builds the complete image without pushing it, loads the native addon with OpenVSCode's Node binary, validates the host-compatible Activity Bar contribution, resolves the packaged provider against OpenVSCode's actual CSP-source contract, checks the inventories and Claude projection, and records image size plus idle process and RSS evidence.

This repository's constrained development container does not run these builds or tests locally. Use the GitHub Actions results or an integration deployment.

See [REQ-IDE-005](../sdd/spec/browser-ide.md#req-ide-005-selected-agent-sidebar), [REQ-IDE-006](../sdd/spec/browser-ide.md#req-ide-006-sidebar-conversation-and-credential-isolation), [REQ-IDE-007](../sdd/spec/browser-ide.md#req-ide-007-sidebar-guarded-approval), [REQ-IDE-008](../sdd/spec/browser-ide.md#req-ide-008-sidebar-process-lifecycle), [AD113](../documentation/decisions/README.md#ad113-one-owned-browser-ide-extension-uses-pi-rpc-and-a-claude-pty), [Container](../documentation/lanes/container.md#openvscode-server-browser-ide), and [Security](../documentation/lanes/security.md#browser-ide-agent-sidebar).
