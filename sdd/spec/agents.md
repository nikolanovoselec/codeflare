# Agents Domain Specification

Multi-agent support, preseed system, and session modes.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Agent | One of seven supported AI coding tools (`claude-code`, `codex`, `copilot`, `antigravity`, `opencode`, `pi`, `bash`) that runs inside the container and is auto-started in terminal tab 1 |
| Preseed | A set of configuration files (rules, skills, agents, commands, plugins) generated from a single Claude Code source of truth and deployed to each user's R2 bucket |
| Session Mode | Either Standard (`default`) or Pro (`advanced`) controlling the scope of agent enhancements seeded to a user's storage |
| Manifest | The declarative `manifest.json` file that maps each preseed source file to its applicable modes and drives the code generation pipeline |

### Out of Scope

- **Custom agent creation by users** -- Users cannot define their own agent types or register third-party CLI tools as agents. The seven supported agents are hardcoded.
- **Agent marketplace** -- No mechanism for browsing, installing, or sharing community-contributed agent configurations or plugins.
- **Runtime agent switching** -- Agent type is immutable after session creation. Switching requires creating a new session.
- **Explicit consult-llm preference toggle** -- There is no separate Settings switch for the multi-model consultation feature. It is active implicitly whenever the user has at least one LLM provider key configured; removing the key is the off-switch.
- **Graphify hard-block enforcement** -- The count-based PreToolUse hard-block for structural-search tools was removed; graph-first discipline is advisory only (the preseeded rule plus a per-call soft nudge, [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)). The hard-block misfired on legitimate single-file searches the graph-first rule itself excludes.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Session Lifecycle | Container start triggers agent CLI auto-start in tab 1; session creation accepts `agentType` selection |
| Storage | R2 bucket stores preseed files; initial sync restores agent configs to the container filesystem |
| Subscription | Session mode gating (`REQ-SUB-014`) controls whether a user can select Pro mode |

---

<!-- @test: host/__audits__/dockerfile-agents.audit.js (Dockerfile agent CLI pre-install describe -> @anthropic-ai/claude-code + @openai/codex + @github/copilot + opencode-ai npm installs + antigravity curl install (Go-native, excluded from npm + V8 warmup like opencode) + NODE_COMPILE_CACHE + V8 warmup --version runs + Go native exclusion -> AC3,4) -->
### REQ-AGENT-001: Support Multiple AI Coding Agents

<!-- @impl: Dockerfile -->
<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/lib/agent-config.test.ts (AGENT_COMMANDS exhaustiveness describe → AC1/AC2) -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (npm install + V8 warm-up + Pi npm warm-cache behavior → AC3/AC4/AC5) -->

**Intent:** The platform must support multiple AI coding agents so users can choose the tool that fits their workflow.

**Applies To:** User

**Acceptance Criteria:**

1. Seven agent types are defined: `claude-code`, `codex`, `copilot`, `antigravity`, `opencode`, `pi`, `bash`. <!-- @impl: src/types.ts::AgentTypeSchema -->
2. The `AgentType` type is enforced via Zod schema (`AgentTypeSchema`). <!-- @impl: src/types.ts::AgentTypeSchema -->
3. Each agent's CLI is pre-installed in the container image as a global npm package (or native binary for Go-based agents).
4. Node.js-based agent CLIs (Codex, Copilot, Pi) are pre-warmed at image build time so V8's compile cache is populated before the user's first interactive launch. Claude Code is installed as a global npm package and is warmed by the version smoke-test run at install time, so it is excluded from the dedicated warm-up block; Go-based agents (OpenCode, Antigravity) are natively compiled.
5. Pi extension npm dependencies are installed into an image-local cache at build time; the entrypoint symlinks `node_modules` to the cache (zero-copy, instant) so Pi starts without a first-launch package install.

**Constraints:**

- Agent CLI versions are installed via `@latest` at build time; versions may drift between deploys.
- Major version jumps between deploys have caused regressions; monitoring is required after deploys.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/agent-config.test.ts), [Dockerfile test](../../host/__tests__/dockerfile-graphify.test.js)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 describe -> POST /api/sessions accepts/persists agentType + Zod rejects invalid + all 7 valid types + lastAgentType via PATCH /preferences + default claude-code -> AC1..AC5) + web-ui/src/__tests__/components/CreateSessionDialog.test.tsx (agent type rendering describe -> AC6 beta badge: antigravity + opencode badged, claude-code/codex/copilot/pi/bash unbadged) -->
### REQ-AGENT-002: Agent Selection at Session Creation

<!-- @impl: src/routes/session/crud.ts -->
<!-- @test: src/__tests__/lib/agent-config.test.ts (getDefaultTabConfig describe → AC1/AC2/AC5) -->

**Intent:** Users must be able to choose which AI agent to use when creating a session.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/sessions` accepts an optional `agentType` field in the request body.
2. Invalid agent types are rejected at session creation. <!-- @impl: src/types.ts::AgentTypeSchema -->
3. The selected agent type is persisted in the session record.
4. The UI defaults to the agent type used in the user's most recent session.
5. When `agentType` is not specified, it defaults to `claude-code`.
6. The session-creation UI renders a `beta` badge on agents in preview status: `antigravity` and `opencode` carry the badge; all other agents (Claude Code, Codex, Copilot, Pi, Bash) render without one.

**Constraints:**

- Agent type is immutable after session creation (a new session is required to switch agents).
- The `bash` agent type provides a plain terminal without an AI agent.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** [Automated test](../../src/__tests__/lib/agent-config.test.ts), [Beta-badge UI test](../../web-ui/src/__tests__/components/CreateSessionDialog.test.tsx)

**Status:** Implemented

---

<!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (configure_tab_autostart / REQ-AGENT-003 describe -> bash harness extracts the real function from entrypoint.sh and reads generated .bashrc; claude --dangerously-skip-permissions emitted + PATH=/usr/local/bin:/usr/bin:/bin set + MANUAL_TAB skip branch present + TAB_CONFIG honored + invalid tab ids rejected + idempotent on re-run -> AC1, AC2, AC3, AC4) -->
### REQ-AGENT-003: Agent CLI Auto-Started in Tab 1

<!-- @impl: entrypoint.sh::configure_tab_autostart -->
<!-- @impl: host/src/prewarm-config.ts -->
**Intent:** When a session starts, the selected agent's CLI must be running and ready in the first terminal tab without manual user intervention.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint configures the selected agent's launch command to run automatically when tab 1's shell starts. <!-- @impl: entrypoint.sh::configure_tab_autostart -->
2. Claude Code starts in permissions-bypass mode appropriate for an isolated sandbox container. <!-- @impl: entrypoint.sh::configure_tab_autostart -->
3. User-opened tabs beyond tab 1 do not auto-start an agent. <!-- @impl: entrypoint.sh::configure_tab_autostart -->
4. The agent CLI is findable on the system PATH in all terminal sessions. <!-- @impl: entrypoint.sh::configure_tab_autostart -->
5. Pre-warm readiness is detected by first PTY output (any terminal output means the agent is ready). <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig -->
6. A 20-second hard timeout exists as a safety net if the PTY produces no output.

**Constraints:**

- Auto-update checks for agent CLIs are suppressed at session start to keep startup latency low.
- Each agent has its own mechanism for suppressing auto-updates.
- The autostart command must complete after the initial R2 sync but before bisync baseline to avoid hash mismatches.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](#req-agent-002-agent-selection-at-session-creation), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** [Integration test](../../host/__tests__/entrypoint-tab-autostart.test.js)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 reconcileAgentConfigs describe -> overwrite:false skips + overwrite:true writes + cleanup:true deletes advanced-only + cleanup:false leaves + DELETE failure non-fatal warnings -> AC4..AC6) -->
### REQ-AGENT-004: Two Session Modes: Standard and Pro

<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
<!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
<!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode describe → AC1/AC2/AC4/AC5/AC6) -->

**Intent:** Users must be able to choose between a Standard mode (essential configs) and a Pro (Advanced) mode (full agent enhancement suite).

**Applies To:** User

**Acceptance Criteria:**

1. Session mode (Standard or Pro) is stored durably in the user's preferences record; the value is absent for users who have never expressed a preference.
2. A single resolver provides the default-to-Standard fallback when no preference is recorded; all callers read through the resolver rather than checking the raw field directly. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
3. Mode selection is available in Settings under the session-defaults area.
4. Mode takes effect on any of: explicit "Recreate AI agent skills & rules" action, new bucket creation, payment-provider mode change (upgrade or downgrade via webhook), subscription termination, or Settings toggle of the session-mode preference. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
5. On webhook-driven or Settings-driven reconciliation, preseed files are overwritten to match the new mode; user-created files are never deleted (see [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) Constraints). <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
6. Reconciliation triggered by webhooks or Settings is non-fatal: failure does not block the webhook response or the preference write. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->

**Constraints:**

- Only tiers whose allowed-session-modes list includes Pro can use Pro mode (see [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)).
- When a user is promoted to a Pro-eligible tier, Pro mode becomes their persisted default if they had not already selected a mode.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/session-mode.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (getConfigsForMode describe -> default filtered + advanced superset + context-mode gate on/off -> AC1,2) -->
### REQ-AGENT-005: Pro Mode Includes Additional Skills, Rules, Agents, and MCP Servers

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: src/lib/agent-seed.generated.ts -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/entrypoint-context-mode.test.js (entrypoint-context-mode describe → mode-gated context-mode preseed + hooks → AC4/AC5/AC6) -->
<!-- @test: host/__tests__/pi-settings-packages.test.js (Pi settings.json packages assembly describe → context-mode enabled by default + 5 tool extensions in required + coexistence/idempotence/dedup → AC5/AC8) -->

**Intent:** Pro mode must provide a significantly enhanced agent experience over Standard - more rules, skills, agent definitions, commands, hooks, and persistent memory. Pi sessions remain fully functional whether or not context-mode is active; context-mode is enabled by default for Pi, and its Custom-tier context-window-reduction behavior in Claude Code remains tier-gated.

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode delivers a strict superset of the content Standard mode delivers, covering memory persistence, language rules, agent definitions, slash commands, cherry-picked skills, the discipline triad (spec, docs, tests), and the commit-attribution and PR-boundary review hooks. The canonical per-content-category matrix lives in [documentation/preseed.md](../../documentation/lanes/preseed.md#session-modes); the spec lane documents the user-observable contract only.
2. Pro mode enables persistent memory by including the user's Vault directory tree in the R2 sync filters so it syncs to their bucket; Standard mode explicitly excludes the Vault tree from those filters so memory does not persist across container restarts. The legacy `.memory/` directory is no longer written.
3. Pro-mode hooks fire uniformly regardless of which tool surface invoked the underlying command, so coverage is identical whether the user is on Custom tier (commands route through context-mode) or any other tier (commands run directly): commit attribution is blocked before the commit lands, the SDD review pipeline is triggered at every PR-to-`main` boundary event, the turn cannot end while a PR HEAD remains unreviewed, and memory capture runs on the user-prompt cadence.
4. Pi agents remain fully functional whether or not context-mode is active: native Bash/Read/Grep/Find/Edit/Write plus graphify tools are sufficient on their own. The shared agent definitions' context-mode helper tools are remapped to their Pi-native names (`ctx_execute`, `ctx_batch_execute`, `ctx_execute_file`, `ctx_search`, `ctx_fetch_and_index`) and kept in the Pi agent frontmatter rather than stripped: with context-mode enabled by default they are present at runtime, and a session that disables it via `/ctx off` simply drops them — with no Pi-specific agent variants.
5. Pi starts with context-mode ENABLED by default — its `ctx_*` tools and the bash-curl-redirect hook are active without an explicit `/ctx on`. The Codeflare Pi extension provides `/ctx status`, `/ctx on`, and `/ctx off`; `/ctx off` disables the context-mode package for the current running session and reloads resources, while the next Codeflare container start resets Pi back to enabled. <!-- @impl: entrypoint.sh --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
6. Custom-tier Claude Code users may receive context-mode's automatic context-window-reduction behavior: large tool output stays out of the conversation window unless the agent explicitly retrieves it, and commands that would flood the window are redirected to the equivalent helper tool.
7. Downgrading away from Custom tier, switching away from Pro mode, or using Pi removes the Custom-tier-only behavior on the next reconcile so automatic context-mode redirection no longer fires.
8. The Pi preseed installs five tool extensions in the settings `required` set — `@juicesharp/rpiv-advisor` (the `advisor` escalate-to-a-stronger-model tool), `@juicesharp/rpiv-ask-user-question` (the `ask_user_question` tool), `@juicesharp/rpiv-todo` (the `todo` tool), `pi-web-access` (`web_search`/`fetch_content`), and `pi-mcp-adapter` (the `mcp` proxy) — so they load in every Pi session independently of the context-mode toggle, each shipped with a skill documenting when to use which tool. The `advisor` and `web_search`/`fetch_content` tools authenticate through Pi's own model registry / zero-config Exa MCP, so they require no per-user API keys. The settings `packages` assembly is idempotent and identity-keyed, so it never duplicates a package and preserves any user-added packages/settings. <!-- @impl: entrypoint.sh --> <!-- @impl: preseed/agents/pi/package.json --> <!-- @impl: preseed/agents/pi/manifest.json -->

**Constraints:**

- Cleanup on mode switch is scoped strictly to preseed-managed content; user-created files are never deleted.
- The Custom-tier context-mode behavior must be delivered through the platform's preseed pipeline, never through a user-driven marketplace install that could mutate settings outside the platform's control.

**Priority:** P1

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Automated test](../../host/__tests__/entrypoint-context-mode.test.js); [Pi settings packages test](../../host/__tests__/pi-settings-packages.test.js) (AC5/AC8)

**Status:** Implemented

---

### REQ-AGENT-006: Preseed Configs Generated from Single Source of Truth

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @impl: src/lib/agent-seed.generated.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json describe → AC1-AC6) -->

**Intent:** All agent configurations must be derived from the Claude Code preseed to prevent divergence and eliminate duplicate maintenance.

**Applies To:** User

**Acceptance Criteria:**

1. All preseed source files live in a single source tree organized by type (rules, agents, commands, skills, plugins).
2. A declarative manifest maps each preseed file to its applicable session modes (default, advanced, or both).
3. A build-time seed generator reads the manifest and source files, producing the runtime payload the Worker ships to the container.
4. The generator is manifest-driven; files not in the manifest are ignored.
5. No duplicate preseed source files exist on disk.
6. The generator produces output for all supported agents (Claude Code as the source-of-truth lane plus adapted lanes for Codex, Copilot, OpenCode, Antigravity, and Pi).

**Constraints:**

- The generated output must stay in sync with the manifest and sources; the build pipeline enforces this.
- The generated output is never hand-edited; updates go through the source tree and the generator.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-007: Multi-Agent Adaptation Pipeline

<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe → AC1-AC4) -->

**Intent:** Each supported agent must receive properly adapted configurations matching its specific config format, tool names, and file conventions.

**Applies To:** User

**Acceptance Criteria:**

1. Adapted configs are generated for all supported non-Claude agents from the Claude Code source.
2. Tool names are remapped per agent (e.g., `Read` -> `read` for Codex and Pi).
3. Instructions are concatenated into a single file for agents that use monolithic config (Codex: `AGENTS.md`, Copilot: `copilot-instructions.md`, OpenCode: `AGENTS.md`, Antigravity: `.gemini/GEMINI.md`, Pi: `AGENTS.md`).
4. Claude Code keeps individual rule files in `~/.claude/rules/`, and Pi receives native runtime-adapter assets for Pi extension/package/MCP/subagent surfaces.

**Constraints:**

- Hooks, commands, and plugins are excluded from generic transformed agents because they are Claude-specific surfaces; Pi is the native-runtime exception and receives Pi-native equivalents (extension/package/MCP/subagent adapters, native command handlers for Claude-only slash commands, and Pi-native skills) instead of copied Claude hooks and commands. Specific Pi command/skill reimplementations live in [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill) and [REQ-AGENT-051](#req-agent-051-pi-debug-deploy-and-brainstorm-commands).
- `rules/memory.md` and `consult-llm` skill are excluded from non-CC agents (they depend on CC-specific MCP).
- Generic non-CC agents get a strictly-smaller config than Claude Code, since CC is the source-of-truth lane and those agents drop CC-specific content. Pi may receive additional Pi-native runtime adapters when equivalent Pi primitives exist.
- Antigravity (`agy`) receives an adapted lane written to its global config directory `~/.gemini/`: rules concatenate into `~/.gemini/GEMINI.md` (auto-loaded across all workspaces), skills into `~/.gemini/skills/`, and subagents into `~/.gemini/agents/`, with Claude tool names remapped to the Gemini CLI vocabulary (`read_file`, `write_file`, `replace`, `run_shell_command`, `search_file_content`, `glob`). agy is Go-native and curl-installed but still reads the Gemini CLI config tree; the `.gemini` -> `.agents` rename applies only to per-workspace config, so the home-directory lane codeflare seeds remains the current convention.
- The per-agent format transforms (frontmatter shape, removed fields, path rewrites, file extensions) live in [REQ-AGENT-030](#req-agent-030-multi-agent-format-transforms).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC4: reconcileAgentConfigs describe -> overwrite:false skips existing R2 objects on new-bucket path + result shape always has written/skipped/deleted/warnings arrays -> AC1 new-bucket overwrite:false + cleanup:false) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior describe -> initial rclone sync restores R2-deployed preseed onto ~/.claude/ etc. before tab autostart -> AC2 entrypoint sync restores preseed) -->
<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration describe -> hooks-aware merge: non-hook fields recursive merge + hook arrays rebuilt per event type preserving user hooks + replacing managed hooks via the codeflare-/graphify/context-mode detector -> AC3 hooks-aware merge) -->
<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (plugin enablement describe -> advanced mode includes PreToolUse/PostToolUse/UserPromptSubmit hook registrations + default mode omits them -> AC4 advanced-mode hook registrations) -->
### REQ-AGENT-008: Preseed Deployed to Container on Start

<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs describe -> AC1/AC2/AC5/AC6 preseed write + sync + plugin enable + malformed-file handling) -->

**Intent:** Preseed files must be available in the container's filesystem when the agent launches so that rules, skills, and agent definitions are active from the first prompt.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, mode-appropriate preseed files are written to the user's R2 bucket without overwriting any existing objects and without removing anything. <!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs -->
2. During container startup, the initial R2-to-local sync restores preseed files into each supported agent's per-user config directory before the agent launches.
3. The container entrypoint merges agent settings using a hooks-aware merge: non-hook fields use recursive merge; hook arrays are rebuilt per event type by preserving user-added hooks and replacing managed (codeflare-owned) hooks with the current platform version. The managed-hook detector identifies a stable, enumerable set of codeflare-owned hook surfaces; per-path inventory lives in [documentation/lanes/preseed.md](../../documentation/lanes/preseed.md).
4. In Pro mode, the settings merge includes the codeflare-owned hook registrations across the PreToolUse, PostToolUse, and UserPromptSubmit event families; Standard mode omits them.
5. The container entrypoint enables the codeflare-managed plugins in the agent's plugin configuration permanently (not mode-gated). Missing plugin files are silently skipped so a plugin removal does not break agent startup.
6. Settings merge handles three cases: file doesn't exist (create), file exists (recursive merge), file malformed (skip with warning).

**Constraints:**

- All file modifications must complete after initial sync but before bisync baseline so the baseline observes a stable snapshot.
- Plugin enablement is permanent because the agent silently skips missing plugins; removing a plugin does not require also rewriting the user's plugin-enablement record.
- The managed-hook detector uses a codeflare-owned namespace prefix so unrelated workspace tools with identical script basenames cannot be falsely flagged as managed.
- The managed-hook surface set is the spec-side single source of truth; adding a new codeflare hook requires extending the detector or prior copies accumulate on every container boot instead of being replaced.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** [Integration test](../../src/__tests__/lib/r2-seed.test.ts)

**Status:** Implemented

---

### REQ-AGENT-009: LLM API Key Storage (Encrypted in KV)

<!-- @impl: src/routes/llm-keys.ts -->
<!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes describe → AC1-AC5) -->

**Intent:** Users must be able to store LLM provider API keys so that cross-model consultation features work without re-entering keys each session.

**Applies To:** User

**Acceptance Criteria:**

1. Users can store one or both supported LLM provider keys (OpenAI and Gemini) through a single management endpoint.
2. The update interface supports three semantics per key: a new value replaces, an explicit null deletes, an absent field leaves the existing value unchanged.
3. Keys are persisted in durable storage scoped to the user's bucket so two users cannot read each other's keys.
4. When platform-level credential encryption is configured, values are encrypted before persistence. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore -->
5. Read responses return masked values (only the trailing characters are visible); the full key is never returned to the client.

**Constraints:**

- Encryption follows the cryptographic contract in [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract).
- The ciphertext carries a version prefix so future schemes can be added without breaking reads.
- Plaintext values are transparently upgraded to encrypted on read when encryption is configured.
- Propagation to the container env + MCP wiring live in [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity).
- Unavailable in enterprise mode: every method on `/api/llm-keys` returns 403 because models route through the managed AI Gateway BYOK, not per-user keys (see [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity) AC6).

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** [Automated test](../../src/__tests__/routes/llm-keys.test.ts)

**Status:** Implemented

---

### REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)

<!-- @impl: src/routes/deploy-keys.ts -->
<!-- @test: src/__tests__/routes/deploy-keys.test.ts (deploy-keys routes describe → AC1-AC4) -->
<!-- @test: web-ui/src/__tests__/lib/token-scopes.test.ts (token-scopes describe → scope tier definitions → AC1 contract) -->

**Intent:** Users must be able to store GitHub and Cloudflare credentials so that git push, repository management, and Cloudflare deployments work without re-authenticating each session.

**Applies To:** User

**Acceptance Criteria:**

1. Tokens are validated against the provider's own API before being stored, so an invalid or expired token is rejected up front rather than discovered at use time.
2. Read responses return masked tokens; the full value is never returned to the client.
3. Users can clear all stored deploy credentials in a single action.
4. Deploy credentials are persisted in durable storage scoped to the user's bucket and are encrypted at rest when platform-level credential encryption is configured. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore -->

**Constraints:**

- Tokens are validated against the provider's API before being persisted; an unreachable provider is surfaced as an upstream error and the credential is not stored, so the store never contains a token of unknown validity.

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** [Automated test](../../src/__tests__/routes/deploy-keys.test.ts)

**Status:** Implemented

---

### REQ-AGENT-011: Agent Skills & Rules Manually Recreatable from Settings

<!-- @impl: src/routes/storage/seed.ts -->
<!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes describe → AC1/AC3/AC6/AC7 recreate endpoint + rate limit + storage-stats KV cache invalidation) + src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-011 reconcileAgentConfigs describe → AC2/AC4/AC5 overwrite-and-cleanup with user-file preservation) -->

**Intent:** Users must be able to reset their agent skills and rules to the platform defaults at any time, recovering from accidental deletion or corruption.

**Applies To:** User

**Acceptance Criteria:**

1. A "Recreate AI agent skills & rules" action in the settings UI triggers a reseed of preseed-managed agent configuration.
2. The reseed performs a full overwrite-and-cleanup of all preseed-managed files for the user's current session mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
3. Overwrite replaces every preseed-managed file with the current default content. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
4. Cleanup removes preseed-managed files that are not part of the user's current session mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
5. User-created files (files not generated by the preseed pipeline) are never overwritten or deleted. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
6. The endpoint is rate-limited (3/min).
7. After seeding, the storage stats KV cache is invalidated.

**Constraints:**

- Cleanup uses explicit key lists, not bucket listing or prefix scans.
- Partial delete failures produce warnings but do not fail the overall operation.
- Container must perform a bisync cycle to pull the updated R2 files into the local filesystem.
- Starter-documentation recreation lives in [REQ-AGENT-032](#req-agent-032-starter-documentation-manually-recreatable-from-settings).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-010](storage.md#req-stor-010-agent-configs-auto-seeded-based-on-session-mode)

**Verification:** [storage-seed.test.ts](../../src/__tests__/routes/storage-seed.test.ts) (AC1/AC3/AC6/AC7), [r2-seed-mode-req-coverage.test.ts](../../src/__tests__/lib/r2-seed-mode-req-coverage.test.ts) (AC2/AC4/AC5)

**Status:** Implemented

---

### REQ-AGENT-012: Fast CLI Start (Configurable)

<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/routes/preferences.test.ts (fastStartEnabled preference describe -> AC1/AC5 settings toggle + KV persistence) + src/__tests__/container/container-env.test.ts (buildEnvVars describe -> AC1 fast-start propagation to container runtime env) + src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008 AC5 describe -> AC4 fast-start applied on restart) + host/__tests__/dockerfile-graphify.test.js (REQ-AGENT-012 Fast Start controls Pi update checks + Fast Start OFF removes settings-file update suppressors -> AC2/AC3/AC4) -->

**Intent:** Agent CLIs must start quickly by default, with an option for users who want automatic updates.

**Applies To:** User

**Acceptance Criteria:**

1. A fast-start preference (default: enabled) controls whether agent CLIs skip auto-update checks at launch, and the user's choice is propagated into the container's runtime environment. <!-- @impl: src/container/container-env.ts::buildEnvVars -->
2. When enabled, auto-update checks are disabled for all supported agent CLIs, eliminating 5-30s startup delay.
3. Every supported agent CLI has a corresponding disable mechanism: each tool's native auto-update path is suppressed by the channel that tool exposes (environment variable for tools that expose one, on-disk settings file for tools that don't). For settings-file tools, user customizations are preserved across container restarts.
4. When the fast-start preference is disabled, the suppression channels are not applied, Codeflare-managed settings-file suppressors are removed, and each CLI runs its normal update or package-reconciliation path before the session starts.
5. Users can toggle the preference from the session defaults area of the application settings.

**Constraints:**

- Codex `~/.codex/` directory is excluded from sync, so `version.json` is safe to recreate on every start.
- Restored user-added Pi packages outside the Codeflare image cache may require Fast Start OFF once so Pi can reconcile package state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** [Automated test](../../src/__tests__/routes/preferences.test.ts), [Fast Start runtime test](../../host/__tests__/dockerfile-graphify.test.js)

**Status:** Implemented

---

### REQ-AGENT-013: Browser Shim for OAuth Flows

<!-- @impl: Dockerfile -->
<!-- @test: web-ui/src/__tests__/stores/terminal-url-detection.test.ts -->

**Intent:** Agent CLIs that attempt to open a browser for OAuth must degrade gracefully to printing clickable URLs in the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. A browser-shim is installed in the container that intercepts browser-launch attempts and exits with a non-zero code, causing the calling CLI to fall back to plain-text URL output.
2. The XDG browser-launch entry-point is similarly shimmed so any tool that bypasses the BROWSER convention also degrades to text output.
3. CLIs fall back to printing auth URLs as plain text in the PTY when the browser fails to open.
4. The xterm.js link provider detects URLs in terminal output and makes them clickable, joining continuation rows for URLs that span multiple terminal rows (soft-wrap or application-inserted newlines) so long OAuth URLs on narrow or mobile-keyboard-shrunk viewports are assembled and offered in full, never truncated mid-URL. <!-- @impl: web-ui/src/lib/terminal-link-provider.ts::registerMultiLineLinkProvider --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::getLastUrlFromBuffer -->

**Constraints:**

- The shim must not block or hang; it must exit immediately with a non-zero code.
- All CLI tools that attempt browser-based OAuth (Claude Code, OpenCode, Antigravity) must be covered.
- The number of continuation rows joined per logical line is bounded by a fixed cap so the periodic buffer scan cannot walk an unbounded scrollback.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** [r2-seed-mode-req-coverage.test.ts](../../src/__tests__/lib/r2-seed-mode-req-coverage.test.ts) (AC1-AC3 shim seeding), [terminal-url-detection.test.ts](../../web-ui/src/__tests__/stores/terminal-url-detection.test.ts) (AC4 multi-row URL assembly)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-014 describe -> getConfigsForMode throws on duplicate within same mode + variant-per-mode allowed + getPreseedKeysNotInMode excludes variant keys + context-mode gating -> AC6,7) -->
### REQ-AGENT-014: Manifest-Driven Preseed Pipeline

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json describe → AC1-AC7) -->

**Intent:** The preseed system must use a declarative manifest to control which files are included, their mode assignments, and their target agents, ensuring auditable and reproducible builds.

**Applies To:** User

**Acceptance Criteria:**

1. A single declarative manifest is the source of truth for all preseed files and their session-mode assignments.
2. The manifest organizes entries by type: rules (including the discipline triad: spec-discipline, documentation-discipline, tdd-discipline), agents, commands, skills (including SDD scaffolding templates), and plugins (memory and hook plugins).
3. Each entry declares the session modes (default, advanced, or both) it applies to.
4. The seed generator is manifest-driven and ignores files not in the manifest.
5. The generator produces a runtime payload the Worker consumes at session start.
6. Within a single mode, no two preseed entries may share the same storage key.
7. Variant-per-mode keys (same storage key, different content per mode) are excluded from cleanup when the mode changes.

**Constraints:**

- All preseed file additions, removals, and re-categorizations flow through the manifest.
- The generated output is a build artifact and is never hand-edited.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-015: /review command for multi-perspective codebase review

<!-- @impl: preseed/agents/claude/commands/review.md -->
<!-- @impl: preseed/agents/pi/skills/review/SKILL.md -->
<!-- @impl: preseed/agents/pi/extensions/review-command.ts -->

**Intent:** Comprehensive code review using specialized AI agents catches issues a single reviewer would miss.

**Applies To:** User

**Acceptance Criteria:**

1. `/review` launches 6 parallel specialist agents (security, architecture, code quality, dead code, test gaps, documentation), followed by a sequential Reality Filter pass that re-evaluates findings against repeat-offender, memory, cluster-aggregation, user-impact, and spec-vs-shipped questions.
2. Results cross-referenced and deduplicated.
3. Findings filtered against architecture decisions.
4. Optional LLM verification of HIGH/CRITICAL findings.
5. Interactive triage with fix/AD/defer/ignore options. Defer/Ignore/Tech-Debt decisions persist to `sdd/.review-decisions.md` so subsequent runs do not re-surface the same noise.
6. When `doc-updater` is invoked on a project with no `sdd/` or no `documentation/` surface (vibe-coding mode), it writes a one-line no-op header to its output file rather than leaving it empty, so the cross-reference phase can distinguish "ran and found nothing" from "did not run". The other five specialist agents always have a code surface to review and produce findings or `Verified Clean` sections normally.
7. Findings reported in interactive triage are never auto-applied by `/review`; the user explicitly confirms each fix. The `auto` and `unleashed` modes that auto-apply spec/doc fixes are scoped to the PR-boundary review pipeline and `/sdd clean` (configured via `sdd/config.yml`), not to interactive `/review` invocations.

**Constraints:**

- On Claude this workflow ships as the `commands/review.md` slash command; on Pi (where Claude slash commands do not deploy) the same workflow is delivered through the dedicated Pi-native `review` skill injected by the `/review` command handler, per [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill).

**Priority:** P1

**Dependencies:** None.

**Verification:** [Automated test](../../host/__tests__/entrypoint-hooks-merge.test.js)

**Status:** Implemented

---

<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration describe -> exercises the entrypoint MCP config merge path that also wires consult-llm when LLM_ENV is non-empty -> AC3 wiring) -->
<!-- @test: host/__audits__/dockerfile-agents.audit.js (Dockerfile bubblewrap install describe -> bubblewrap in apt-get install + Codex sandbox documentation -> AC1,2) -->
### REQ-AGENT-017: Bubblewrap sandbox for Codex

<!-- @impl: Dockerfile -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (Dockerfile graphify install describe → bubblewrap apt-installed → AC1) -->

**Intent:** Codex agent runs in a bubblewrap sandbox for additional isolation within the container.

**Applies To:** User

**Acceptance Criteria:**

1. bubblewrap (bwrap) is installed in the container image.
2. bubblewrap is available on the system PATH for Codex's built-in sandbox; the sandbox invocation is owned by the upstream Codex CLI, not by codeflare source.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** [Automated test](../../host/__tests__/dockerfile-graphify.test.js)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 describe -> POST validates token against provider before save + encrypted-at-rest in KV + GET returns masked tokens -> AC2 validation, AC3 encrypted-at-rest, AC4 env-var injection) -->
<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe -> emits GH_TOKEN/CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID when state has deploy keys -> AC4 env-var injection) -->
### REQ-AGENT-018: Push & Deploy credential management UI

<!-- @impl: web-ui/src/components -->
<!-- @impl: src/routes/deploy-keys.ts -->
<!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes + GET/PUT/DELETE describes -> AC1/AC2/AC3/AC4 settings UI route + provider validation + KV encryption + container env propagation) -->

**Intent:** Users connect GitHub and Cloudflare accounts through a visual interface without CLI commands.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel has Deploy Keys section with provider rows for GitHub and Cloudflare.
2. Tokens validated against provider APIs before saving.
3. Stored encrypted in KV.
4. Deploy credentials are propagated into the container environment so the agent CLIs can authenticate to GitHub and Cloudflare without additional configuration.

**Constraints:**

- Must comply with [CON-SEC-003](constraints.md#con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured)

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** [Integration test](../../src/__tests__/routes/deploy-keys.test.ts)

**Status:** Implemented

---

### REQ-AGENT-019: Branded settings UI

<!-- @impl: web-ui/src/components -->

**Intent:** Professional, intuitive settings panel for managing all user preferences and credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel uses accordion groups (appearance, session, deploy, LLM, admin).
2. Provider rows with SVG brand icons and inline expansion.
3. Appearance section with accent color picker.
4. Session section with a session-mode toggle and a sleep-timeout select; agent type is chosen at session creation, not here.

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 / REQ-AGENT-009 describe -> POST validates key + stores encrypted in KV + DELETE clears all keys + GET returns masked -> AC2 validation, AC3 delete-clears-all, AC4 masked in GET) -->
### REQ-AGENT-020: LLM API key management UI

<!-- @impl: src/routes/llm-keys.ts -->
<!-- @impl: web-ui/src/components -->
<!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes + GET/PUT/DELETE + encryption describes -> AC1/AC2/AC3/AC4 settings UI + validation + delete + masked display) -->

**Intent:** Users can store their OpenAI and Gemini API keys through a visual interface.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel has LLM Keys section with masked password inputs for OpenAI and Gemini.
2. Keys validated before saving.
3. Delete button clears all keys.
4. Keys displayed as masked (never shown in full after save).

**Constraints:**

- Must comply with [CON-SEC-003](constraints.md#con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured)
- Hidden in enterprise mode: the Settings "LLM API Keys" section is not rendered, matching the 403 backend gate (see [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity) AC6).

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** [Integration test](../../src/__tests__/routes/llm-keys.test.ts)

**Status:** Implemented

---

### REQ-AGENT-021: Pro-Mode SDD Workflow Preseed and Tool-Surface Portability

<!-- @impl: preseed/agents/claude/skills/spec-driven-development -->
<!-- @impl: preseed/agents/claude/rules/spec-discipline.md -->
<!-- @impl: preseed/agents/claude/rules/documentation-discipline.md -->
<!-- @impl: preseed/agents/claude/rules/tdd-discipline.md -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @test: src/__tests__/lib/agent-seed-ecc-rules.test.ts (spec-discipline + documentation-discipline + tdd-discipline + graph-first advanced-only describes -> AC1 Pro-mode rule preseed) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi command extensions dispatch through both ctx and pi user-message APIs -> AC2 /sdd command works with and without context-mode) -->

**Intent:** Pro users need the spec-driven-development workflow available out of the box, with every sub-command working through the native shell/file tools available in the active runtime so the workflow still works when context-mode is absent.

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode preseeds the `spec-driven-development` skill, the `sdd-init` and `sdd-clean` sub-command skills, the `vault-operations` skill, the `ci-monitoring` skill, the `/sdd` command, the `spec-discipline`, `documentation-discipline`, and `tdd-discipline` rules (loaded into every agent's instructions), and the `spec-reviewer` + `doc-updater` agents.
2. Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works in Pi without context-mode by using native Bash/Read/Grep/Find/Write/Edit tools; context-management helper tools, when present in another runtime, are optional rather than required.
3. Discovery commands producing more than 20 lines of output (`gh pr list --state all`, `git log --follow`, `npm view <pkg> peerDependencies`, full-tree scans, scaffold-only `npm install --package-lock-only`) run through native discovery tools in Pi without context-mode, with any runtime-specific output-management wrapper treated as an optional optimization.
4. Pi-transformed SDD skills replace Claude MCP tool names and Plan Mode surfaces with Pi-native graphify tools and `Agent`/`Plan` terminology, and the native `/sdd` command enforces the command-file hard gates (help, unknown subcommand, clean working tree, `clean`/`mode` require `sdd/`, existing-spec `init` handling) before dispatching to the workflow skill.
5. When the user explicitly asks to monitor CI or a deploy/merge gate requires a fresh result, the `ci-monitoring` skill uses one background continuous tail-followed monitor for the target HEAD; routine pushes do not auto-start CI monitoring.

**Constraints:**

- The `/sdd init` scaffolding contract lives in [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render); the enrichment pass with graphify queries lives in [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify); the Phase 7a source-anchor verifier gate lives in [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) and the Phase 7b enumeration-coverage verifier gate lives in [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate); the PR-boundary review pipeline lives in [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions); the `/sdd clean` rescue and autonomy modes + discipline enforcement live in [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes).

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** [Automated tests](../../src/__tests__/lib/agent-seed-ecc-rules.test.ts), [Pi command dispatch tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-033: `/sdd init` Scaffolding and Canonical Render

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @impl: preseed/agents/claude/commands/sdd.md -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033 describes -> AC1/AC2 Greenfield + Import Mode procedures + AC3/AC4 dep-version resolution with --ignore-scripts + AC5 lean two-confirm flow + AC6 canonical REQ render + AC7 .review-queue.md placeholder pre-creation) -->

**Intent:** `/sdd init` must bootstrap a working spec in a single coherent flow whether the project is greenfield or import-mode, with every drafted REQ rendered in the canonical shape and the supporting scaffold (lockfile, review queue file) created in the same pass.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` scaffolds a new `sdd/` from templates for greenfield projects.
2. In import mode, `/sdd init` derives a spec from existing source code rather than scaffolding from templates.
3. When `/sdd init` generates a package manifest, top-level dependency versions are resolved at scaffold time via the ecosystem's registry (npm, Cargo, pip, Go) rather than emitted from memory. The Cloudflare Workers stack pins `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`, and `vitest` as a single co-resolved cohort.
4. Lockfile generation during `/sdd init` is a scoped carveout to the no-local-builds rule (resolution only, with `--ignore-scripts` on npm; no installs, tests, or builds).
5. `/sdd init` (both greenfield and Import Mode) runs as a lean two-confirm flow: the agent asks one vision question (or accepts `$ARGUMENTS`), drafts the entire spec in memory (actors, domains, design principles, REQs in canonical shape, CON-* constraints, founding ADRs, glossary terms), presents the full draft as one review surface, and applies user edits in place until the user accepts. The 10-15-turn one-domain-at-a-time confirmation chain is not used.
6. Every REQ written by `/sdd init` renders in the canonical shape defined by the `spec-driven-development` skill: ACs numbered (`1.`, `2.`, `3.`), each labeled field on its own line with blank-line separators between trailing fields (`Constraints`, `Priority`, `Dependencies`, `Verification`, `Status`), and `**Constraints:**` + `**Dependencies:**` always present (rendered as the literal string `None.` when empty). Cross-references render as markdown anchor links, not plain text.
7. `/sdd init` pre-creates the verification-queue file `sdd/spec/.review-queue.md` at scaffold time with the placeholder `_Awaiting first finding._` so the file ships discoverable; after scaffold the layout-resolved review queue (`sdd/spec/.review-queue.md` on the nested layout, `sdd/.review-needed.md` on the flat-legacy layout) accumulates findings appended by spec-reviewer, `/sdd clean`, or `/sdd init` Import-Mode triage. Adjacent audit accumulator surfaces are specified in [REQ-AGENT-048](#req-agent-048-audit-accumulator-surfaces).

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-init-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-048: Audit accumulator surfaces

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @impl: preseed/agents/claude/skills/sdd-clean -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-048 describe -> AC1 sdd-init does not pre-create documentation/.doc-coverage.md) + host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-048 describe -> AC2 [sdd-clean] commit-body audit, no dotfile) -->

**Intent:** SDD ships two adjacent audit-trail surfaces beyond the spec review queue: a doc-lane coverage accumulator owned by doc-updater, and a `/sdd clean` execution audit. The locations and lifecycle of these surfaces are specified here so neither tool re-derives them.

**Applies To:** Agent

**Acceptance Criteria:**

1. The doc-lane audit accumulator `documentation/.doc-coverage.md` is lazy-created by doc-updater on first substantive finding (no scaffold-time placeholder).
2. The `/sdd clean` execution audit lives in per-category commit bodies (recoverable via `git log --grep='\[sdd-clean\]'`), not in a dotfile.

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-init-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-049: Auto-upgrade preseed on release

<!-- @impl: scripts/generate-agent-seed.mjs, src/routes/session/lifecycle.ts, src/routes/storage/seed.ts -->
<!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-AGENT-049 describe -> AC3 preseedNeedsUpgrade) + src/__tests__/routes/storage-seed.test.ts (REQ-AGENT-049 -> AC2 lastPreseedHash persistence + AC7 mode/tier propagation) + web-ui/src/__tests__/stores/session.test.ts (REQ-AGENT-049 -> AC4 upgrade trigger + AC5 preseedUpgrading flag lifecycle + AC6 failure path) + web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-AGENT-049 -> AC5 Dashboard button disabled/Upgrading text) + web-ui/src/__tests__/components/SessionDropdown.test.tsx (REQ-AGENT-049 AC5 -> SessionDropdown disabled during upgrade) + web-ui/src/__tests__/components/SessionStatCard.test.tsx (REQ-AGENT-049 AC5 -> stopped card dimmed/click-disabled) + src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-049 AC1 -> PRESEED_CONTENT_HASH determinism) -->

**Intent:** When a new codeflare release ships changed preseed content (agent skills, rules, plugins), the user's R2 bucket should be reconciled automatically on first dashboard load - no manual "Recreate Agent Skills & Rules" click required. Session creation and stopped-session access are prevented in the UI during the brief upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The preseed generation script computes a deterministic SHA-256 content hash over all preseed documents (sorted by key) and emits it as a build-time constant accessible to the runtime. <!-- @impl: src/lib/agent-seed.generated.ts::PRESEED_CONTENT_HASH -->
2. After a successful reconcile (manual or auto), the applied hash is persisted in the user's preferences store.
3. On initial dashboard load, the backend compares the stored hash against the build-time constant and returns whether an upgrade is needed. This check is omitted from periodic polling to avoid overhead.
4. On initial dashboard load, if an upgrade is needed, the frontend triggers the reconcile in the background. <!-- @impl: web-ui/src/stores/session.ts::applyMetricsUpdate -->
5. While the upgrade is in progress, the "+ New Session" button is disabled and displays "Upgrading..." (both Dashboard and SessionDropdown), and stopped session cards are visually dimmed (reduced opacity) and click-disabled.
6. If the auto-upgrade fails, the error is logged but the dashboard remains fully usable. A page refresh retries the check. <!-- @impl: web-ui/src/stores/session.ts::applyMetricsUpdate -->
7. The reconcile respects the user's current session mode and tier (standard/pro/unlimited) - identical behavior to the manual "Recreate" button.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-011](#req-agent-011-agent-skills-rules-manually-recreatable-from-settings), [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** [Backend route tests](../../src/__tests__/routes/session-batch-status.test.ts), [Seed hash persistence + AC8 mode/tier propagation](../../src/__tests__/routes/storage-seed.test.ts), [Store upgrade flow + AC7 failure path](../../web-ui/src/__tests__/stores/session.test.ts), [Dashboard UI AC5](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [SessionDropdown AC5](../../web-ui/src/__tests__/components/SessionDropdown.test.tsx), [SessionStatCard AC6](../../web-ui/src/__tests__/components/SessionStatCard.test.tsx), [AC1 hash determinism](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-050: Pi-Native `/review` Workflow Skill

<!-- @impl: preseed/agents/pi/skills/review/SKILL.md -->
<!-- @impl: preseed/agents/pi/extensions/review-command.ts -->
<!-- @impl: preseed/agents/pi/manifest.json -->

**Intent:** Pi users running `/review` must get the same multi-perspective review workflow that Claude users get from `commands/review.md`. Because Claude slash commands do not deploy to Pi, the `/review` command must inject a dedicated Pi-native review skill rather than the PR-boundary enforcement pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi `/review` command injects a dedicated Pi-native `review` skill that mirrors the Claude `commands/review.md` workflow, instead of injecting the `git-review-pipeline` enforcement skill.
2. The Pi `review` skill is the user-invoked review workflow (multi-perspective specialist subagents, cross-reference, architecture-decision filter, optional external verification, interactive triage), explicitly distinct from PR-boundary enforcement; it does not run the `git-review-pipeline`.
3. The skill scopes review by `--all` or `--diff` parsed from the appended command line, prints help and runs no phases when neither flag is present, and supports the `--deep` and `--verify-high` flags.
4. The skill is static-analysis only: it never runs builds, tests, or linters (the container has 1 vCPU).
5. The skill maps Claude primitives to Pi-native ones: subagents spawn via Pi's `Agent` tool with `subagent_type`, graph queries use Pi-native `graphify_query`/`graphify_path`/`graphify_explain` (with a `--graph <repo>/graphify-out/graph.json` CLI fallback), and plan entry uses the `Plan` agent or an explicit written-and-approved plan.
6. The skill is delivered advanced-only via the Pi manifest (`skills/review/SKILL.md`) through the standard seed pipeline.

**Constraints:**

- The skill mirrors the Claude `/review` interactive-triage contract from [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review): findings are never auto-applied; the user confirms each fix.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> Pi seed manifest includes .pi/agent/skills/review/SKILL.md (+ review-command/review-helpers extensions) as first-class residents -> AC6 manifest presence) -->
<!-- coverage-gap: AC6 (manifest-presence of skills/review/SKILL.md) and command-dispatch API compatibility are covered by agent-seed-manifest.test.ts. AC1-AC5 (flag parsing and the runtime workflow phases) are skill-content behavior injected at command time, with no dedicated automated test. -->

---

### REQ-AGENT-051: Pi `/debug`, `/deploy`, and `/brainstorm` Commands

<!-- @impl: preseed/agents/pi/extensions/codeflare-commands.ts -->
<!-- @impl: preseed/agents/pi/manifest.json -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 describe -> AC1-AC5) -->

**Intent:** Workflows that Claude ships as slash commands (`/debug`, `/deploy`, `/brainstorm`) are unavailable in Pi because Claude commands do not deploy to Pi. Pi must reimplement them as native command handlers so Pi users get the same systematic debugging, deploy-and-verify, and structured-brainstorming workflows.

**Applies To:** User

**Acceptance Criteria:**

1. A Pi extension registers three native commands via `pi.registerCommand`: `debug`, `deploy`, and `brainstorm`.
2. Each command injects its adapted workflow text plus the user's input, rather than loading a SKILL.md, because these workflows have no Pi skill file.
3. `/debug` runs a systematic root-cause debugging workflow (no fixes before root cause is established; the 3-Fix Rule).
4. `/deploy` runs the push, stale-CI cancellation, CI monitoring, deploy, and live-URL verification workflow.
5. `/brainstorm` runs a structured option-generation workflow that produces trade-offs and a recommendation.
6. The extension is delivered advanced-only via the Pi manifest (`extensions/codeflare-commands.ts`) through the standard seed pipeline.

**Constraints:**

- These commands adapt the Claude command workflows to Pi-native tool surfaces; they are not generic transforms of the Claude command files (Claude commands are not deployed to Pi).

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-052: Pi Commit-Attribution and Local-Build Hook Hardening

<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 describe -> AC1-AC5) -->

**Intent:** Pi's PreToolUse guards that block AI attribution and local builds must cover the same surfaces and detection set as the canonical Claude hooks, so an attributed commit, PR, issue, release, or tag cannot slip through a previously-unguarded subcommand and a local build is not silently allowed.

**Applies To:** Agent

**Acceptance Criteria:**

1. The attribution guard fires not only on `git commit` and `gh pr create` but across `git merge`, `git tag`, `git notes`, and the `gh pr`, `gh issue`, and `gh release` subcommand families.
2. The attribution detection set matches genuine attribution signatures only - the canonical `block-attributed-commits.sh` set (`Co-Authored-By`, `noreply@anthropic`, `generated with ... claude`, the robot emoji) plus the brain emoji and `ChatGPT` as a deliberate Pi-guard superset since a Pi session may run a non-Claude model. Bare model and product names (`claude code`, `claude opus`, `claude sonnet`, `claude haiku`) are deliberately not matched, so legitimate prose and `preseed/agents/claude/` paths do not false-positive.
3. The attribution guard does not match a bare `Claude`, so `git`/`gh` commands that name `preseed/agents/claude/` paths are not false-positives.
4. The local-build guard covers the package-manager build/test/lint/typecheck/dev verbs plus `pytest`, `vitest`, `go test`, `swift test`, `cargo test`, `tsc`, `eslint`, `oxlint`, `prettier`, and `wrangler dev`.
5. The local-build guard honors a user-only consume-on-use sentinel at `/tmp/local-build-bypass`: when present, the guard deletes it and allows the one command through; the block message names the override path.

**Constraints:**

- The attribution and local-build detection sets are kept aligned with the canonical Claude hook scripts (`block-attributed-commits.sh`, the no-local-builds rule); divergence is a regression, except the documented Pi superset (brain emoji + `ChatGPT`) in AC2.
- The bypass sentinel is user-only and consume-on-use, mirroring the user-only `/tmp/review-bypass` sentinel discipline in [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces) AC1.

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-034: `/sdd init` Enrichment Pass with Graphify

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034 describes -> AC1 enrichment pass section + AC2/AC3/AC4 three sub-passes (cross-link, ADR-seed, glossary-seed) + AC5 mcp__graphify__ tool calls + AC6 cluster-only fallback + changes.md notice) -->

**Intent:** After `/sdd init` accepts the user's draft, an enrichment pass tightens the spec by walking the project's knowledge graph: cross-link dependencies, seed ADRs from architecturally-central nodes, seed glossary terms from concept nodes.

**Applies To:** User

**Acceptance Criteria:**

1. After the full draft is accepted, an enrichment pass runs before files are written, executing three sub-passes (cross-link, ADR-seed, glossary-seed) in one in-memory cycle with no additional user prompts.
2. The cross-link sub-pass adds every REQ that references another REQ concept by name to the parent's `Dependencies:` as an anchor link `[REQ-X-NNN](#req-x-nnn-title-slug)`.
3. The ADR-seed sub-pass drafts 3-8 founding ADRs covering non-obvious technology choices (tech stack, framework, deployment target, auth pattern, data store, key middleware) and writes them to `documentation/decisions/README.md` with an index table at the top and per-ADR sections below.
4. The glossary-seed sub-pass extracts every product noun, vendor name, and protocol mentioned in any REQ Intent or AC body and gives each a one-line definition in `sdd/glossary.md`.
5. The enrichment pass queries the project's `graphify-out/graph.json` via the `mcp__graphify__*` MCP tool family: `get_neighbors` drives the cross-link pass, `god_nodes` surfaces ADR-seed candidates, `query_graph` extracts glossary concept-tagged nodes, and `shortest_path` validates non-obvious dependency edges.
6. When the graph is missing at enrichment time, `/sdd init` prompts the user once with a `/graphify cluster-only` (AST-only, free) build offer; on decline, enrichment falls back to an in-memory heuristic (literal-string matching across drafted REQs) and appends a one-line notice to `sdd/changes.md` recording reduced cross-link density.
7. Graphify MCP tools are tool-agnostic across Bash and context-mode surfaces; the enrichment-pass contract is identical regardless of which tool surface is active.

**Constraints:**

- Backlink density drops materially when the graph is absent; the changes.md notice exists so future readers can correlate spec quality with the build state at init time.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-init-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-035: `/sdd init` Phase 7a Source-Anchor Verifier Gate

<!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-source-anchors.py -->
<!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035 describes -> AC2 JSON shape + AC2 orphaned/drifted/malformed classification + AC2 backtick-span ignore + AC5 exit_code 0/1 contract) -->

**Intent:** `/sdd init` must not declare success on a spec that contains unanchored claims. A programmatic source-anchor verifier runs before iterate-to-clean so every `<!-- @impl -->` claim is proven against the source tree, closing the "agent wrote what isn't there" half of the Validation-Equals-Generation gap. Phase 7b (enumeration coverage) is split into [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate).

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` runs Phase 7a as a CRITICAL non-skippable gate BEFORE invoking `spec-enforce` and `doc-enforce`.
2. The verifier walks every `<!-- @impl: <path>::<symbol>[ = <value>] -->` anchor across `sdd/**/*.md` and `documentation/**/*.md`, resolves the path on disk, confirms the symbol's word-bounded presence in source, validates any literal value pattern within the symbol's local region, and counts malformed `@impl`-shaped comments and unreadable files.
3. The verifier emits a machine-readable JSON report containing counts of parsed, resolved, orphaned, drifted, malformed, and unreadable anchors, plus per-entry failure details and an exit-code field, written to a Phase-7a evidence file the commit body can reference.
4. The `[sdd-init]` commit body MUST include the verbatim summary line `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`.
5. A non-zero `exit_code` blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`.
6. Substituting a structural sanity check or agent self-attestation, partial coverage, running the verifier AFTER the enforcement skills, bypassing on a missing-tool error, or committing without the summary line each carry a CRITICAL severity (`phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`).
7. After `/sdd init`, steady-state CQ-SOURCE (`spec-enforce-truth`) and Pass 15 (`doc-enforce-truth`) consume Phase 7a's JSON when available rather than re-deriving.

**Constraints:**

- The verifier is a programmatic Python script shipping with the `sdd-init` skill; agent self-attestation MUST NOT be substituted for the verifier output.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify)

**Verification:** [Automated test](../../host/__tests__/sdd-init-phase-7a-verifier.test.js)

**Status:** Implemented

---

### REQ-AGENT-039: `/sdd init` Phase 7b Enumeration-Coverage Verifier Gate

<!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py -->
<!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate describe -> AC2/AC3/AC5/AC7 load-bearing enumeration, anchor + triage accounting, exit code contract, per-project waiver) -->

**Intent:** Phase 7a verifies that every claim the agent wrote is anchored; Phase 7b closes the second half of the Validation-Equals-Generation gap by verifying the agent did not silently drop entire source files from the enumeration. The verifier runs after Phase 7a and before iterate-to-clean so unenumerated load-bearing source surfaces as a CRITICAL gate failure rather than a silent omission.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` runs Phase 7b as a second CRITICAL non-skippable gate AFTER Phase 7a and BEFORE iterate-to-clean.
2. The verifier walks the working tree, identifies load-bearing source files (under `services/`, `handlers/`, `controllers/`, `providers/`, `models/`, `domain/`, `core/`, `commands/`, `usecases/`, `workers/` OR source-line-count >= 100), and checks each file's repo-relative path against (a) the `<path>` portion of every `<!-- @impl: <path>::<symbol> -->` anchor in `sdd/**/*.md` + `documentation/**/*.md`, AND (b) literal mentions in the layout-appropriate triage files (nested: `sdd/spec/.init-triage.md` + `sdd/spec/.review-queue.md`; flat-layout legacy: `sdd/.init-triage.md` + `sdd/.review-needed.md`).
3. The verifier emits a JSON report `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}`.
4. The `[sdd-init]` step-10 commit body MUST include the verbatim summary line `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1` alongside the Phase 7a line.
5. An empty triage queue on Import Mode with `unaccounted > 0` is CRITICAL `import-mode-narrowed-scope`.
6. Agent self-attestation, sampling, running `spec-enforce` first without Phase 7b, or committing without the summary line each carry a CRITICAL severity (`phase-7b-self-attestation`, `phase-7b-incomplete-coverage`, `phase-7b-pipeline-inversion`, `phase-7b-evidence-missing`).
7. A per-project waiver file `sdd/spec/.phase-7b-waiver.txt` (one repo-relative path per line, each with a one-line justification) excludes framework-boilerplate files from coverage; greenfield runs that produce `enumerated=0` and `coverage_pct=100.0` are advisory but still emit the commit body line so the audit-trail format stays uniform across modes.

**Constraints:**

- The verifier is a programmatic Python script shipping with the `sdd-init` skill; agent self-attestation MUST NOT be substituted for the verifier output.

**Priority:** P1

**Dependencies:** [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate)

**Verification:** [Automated test](../../host/__tests__/sdd-init-phase-7b-verifier.test.js)

**Status:** Implemented

---

### REQ-AGENT-036: PR-Boundary Review Trigger Conditions

<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @test: host/__tests__/git-push-review-reminder.test.js (PR-OPEN / PR-SYNC base gating -> AC1/AC4; MCP shell input shapes -> REQ-AGENT-063) + host/__tests__/enforce-review-spawn.test.js (PR state gating -> AC1; vibe-coding gate exits silently -> AC6; MCP shell input shapes -> REQ-AGENT-063) + src/__tests__/lib/agent-seed-manifest.test.ts (metadata-lag base inference -> AC5; bounded open-PR reconciliation, not passive branch existence -> AC6; missed boundary recovery -> AC7) -->

**Intent:** Review agents must fire only on PR-boundary events that actually target shipping code. Trigger evaluation gates parsed boundary commands against real PR state, ignores integration-branch and no-PR work, and leaves direct `main` protection to upstream branch rules. Command parsing lives in [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing); lane classification + agent dispatch live in [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch); bypass surfaces live in [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces).

**Applies To:** User

**Acceptance Criteria:**

1. PR-boundary review fires only for an open, non-draft PR targeting `main` or `master`; on the actual-command path, an open PR with a missing base fails open to review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isEnforcedPr --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isEnforcedPrForPush --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prEnforcedForPush --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (prEnforcedForPush: main/master OPEN enforced, empty-base OPEN fail-open, develop/CLOSED/headless not enforced -> AC1) --> <!-- @test: src/__tests__/lib/review-state.test.ts (shouldReconcileOpenPr does NOT reconcile a draft PR -> AC1) -->
2. Only command classes parsed by [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing) can enter trigger evaluation; `gh pr merge` is merge-gate input, not a fresh review trigger. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isPrBoundaryTrigger --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGhPrMergeCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (isPrBoundaryTrigger: git/gh boundary commands trigger; gh pr merge does not trigger -> AC2) -->
3. Metadata-only PR commands do not trigger review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isPrBoundaryCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (gh pr view and metadata-only gh pr edit are not triggers -> AC3) -->
4. PRs into integration branches (`develop`, `staging`, etc.) are deferred until that branch has its own PR to `main` or `master`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isEnforcedPr -->
5. During a `gh pr create` metadata-visibility race, Pi may infer `main`/`master` from CLI/default base data and synthesize an open PR from local HEAD; non-protected bases remain ignored. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prCreateBoundaryBase --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::prForBoundaryCommand --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (gh pr create metadata-lag base inference -> AC5) -->
6. Non-triggering states never create a review window: vibe-coding projects run no agents, and passive lifecycle events never act on branch existence alone. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isSddProject --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reconcileOpenPrReview -->
7. A PR-boundary command still creates a review window when its start event is lost; Pi also captures start args on `tool_call` and recovers them at `tool_result`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::rememberToolStartArgs --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::prStateFreshResult --> <!-- coverage-gap: in-process Pi lifecycle glue is verified by inspection, the bundled-jiti load-check, and the manual missed-boundary smoke test. -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing)

**Verification:** [Automated test](../../host/__tests__/git-push-review-reminder.test.js), [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [`gh pr edit` retarget trigger tests](../../src/__tests__/lib/review-trigger.test.ts)

**Status:** Implemented

---

### REQ-AGENT-063: PR-Boundary Command Parsing

<!-- @impl: preseed/agents/pi/extensions/review-helpers.ts -->
<!-- @test: src/__tests__/lib/review-trigger.test.ts (isPrBoundaryTrigger/isGitPushOnlyCommand robustness; wrapper forms; heredoc bodies; false-positive guards; dry-run/delete exclusion; --tags boundary -> AC1-AC7) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (commandTextFromEvent shell-only gate; ctx_batch shell commands; non-shell ctx_execute and legacy script excluded -> AC1) -->

**Intent:** PR-boundary trigger code needs a deterministic shell-command parser that recognizes real boundary commands across Pi tool surfaces without treating source-code literals or PR body text as commands.

**Applies To:** User

**Acceptance Criteria:**

1. Command text is extracted only from shell execution surfaces: Bash `.command`, `ctx_execute` shell `.code`, and `ctx_batch_execute` `.commands[].command`. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::commandTextFromEvent --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (shell-only command extraction -> AC1) -->
2. Local push parsing recognizes `git push`, `git -C <repo> push`, ssh/https remotes, environment-prefix forms, command wrappers, and local `cd <repo>` prefixes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGitPushOnlyCommand --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::cwdFromBoundaryCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (push forms and wrapper forms -> AC2) -->
3. GitHub CLI parsing recognizes `gh pr create`, `gh pr merge`, `gh pr update-branch`, `gh repo sync`, and protected-base `gh pr edit`. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isPrBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prEditBoundaryBase --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (GitHub CLI boundary command cases -> AC3) -->
4. Here-doc bodies are stripped before command tokenization so markdown PR bodies cannot hide a following boundary command. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::stripHeredocs --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (heredoc body robustness -> AC4) -->
5. Non-advancing push forms (`--dry-run`, `-n`, `--delete`, `-d`) are excluded; `--tags` remains a boundary. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGitPushOnlyCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (dry-run/delete exclusion and --tags boundary -> AC5) -->
6. Quoted text and non-shell tool bodies containing boundary-looking strings are ignored. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::commandTextFromEvent --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (printf/rg false-positive guards -> AC6) -->
7. Command wrappers are parsed structurally rather than with wrapper-heavy regular expressions. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::unwrapCommandWords --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (wrapper parsing -> AC7) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** None

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [`review-trigger.test.ts`](../../src/__tests__/lib/review-trigger.test.ts)

**Status:** Implemented

---

### REQ-AGENT-040: PR-Boundary Lane Classification and Agent Dispatch

<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-helpers.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts -->
<!-- @test: host/__tests__/lane-classifier.test.js (compute_required_lanes describes -> AC1/AC2/AC3 shared helper + lane mapping + conservative fallback to all-three-lanes) + host/__tests__/enforce-review-spawn.test.js (agent-spawn enforcement describe -> AC4/AC5/AC6/AC7; lane gating describe -> AC1/AC2/AC3) + src/__tests__/lib/agent-seed-manifest.test.ts (Pi review helper behavior tests -> AC4 initial all-lane scheduling + AC5 doc-updater parallel dispatch; seeded reviewer defs scope-agnostic -> AC8) -->

**Intent:** Once a PR-boundary trigger fires ([REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)), a shared lane classifier picks the minimal correct set of review agents from the diff so the in-turn nudge and turn-end gate agree, and a fix-push cascade can advance the ack pointer without losing review coverage.

**Applies To:** User

**Acceptance Criteria:**

1. Layer 1 lane classification uses one internally shared classifier per runtime surface so the in-turn nudge and the turn-end gate agree on which review agents the diff requires.
2. Lane mapping: generated-only `graphify-out/` diffs → no lanes (auto-acked with a durable audit event); docs-only → `doc-updater`; `sdd/` without source → `spec-reviewer` + `doc-updater`; any source touch → all three agents. Generated files never suppress non-generated files; both runtime classifiers apply this identically. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewFiles --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGeneratedArtifactPath --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (classifyReviewFiles generated-artifact handling -> AC2) --> <!-- @test: host/__tests__/lane-classifier.test.js (generated graphify-out artifacts -> AC2 Claude-side parity) -->
3. Conservative branches (empty diff, missing prior ack, divergent merge-base) and a missing or unsourceable helper both fall back to all-three-lanes (`code-reviewer spec-reviewer doc-updater`), so a partially-deployed install never disables enforcement.
4. The initial review wave starts every required lane together (`code-reviewer`, `spec-reviewer`, and `doc-updater`) — all three reviewers are report-only and write to disjoint lane files, so there is no inter-lane ordering. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewInitialLanes -->
5. `doc-updater` dispatches in parallel with `spec-reviewer`, not after it: every required lane is eligible immediately, since the reviewers report findings to a triage file and the main session applies fixes — no shared-write race. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewEligibleLanes -->
6. Review agents are dispatched with `run_in_background: true` so the main session stays interactive; the turn-end gate suppresses re-summoning per lane, so a slow in-flight lane never masks demand for other lanes nor satisfies acknowledgement without current-head completion. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_in_flight --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::all_required_lanes_completed_for_current_head --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (suppresses an in-flight lane without masking missing peer lanes + does not ack while current-head lanes are still in flight) -->
7. In-flight suppression is bounded by transcript recency: an uncompleted spawn that falls behind the transcript tail is treated as orphaned, demanded again, and cannot suppress its lane indefinitely. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_in_flight --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (re-demands an orphaned in-flight lane after the transcript recency bound) -->
8. After the first acknowledged review, a follow-up review is dispatched scoped to the incremental window (last-acked clean head -> current head), so a re-review inspects only the new commits instead of re-reviewing the entire PR each round. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::docUpdaterPrompt --> <!-- @impl: preseed/agents/claude/agents/code-reviewer.md --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md --> <!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md --> <!-- @impl: preseed/agents/claude/skills/doc-enforce/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (seeded reviewer defs are scope-agnostic: honor an explicit window, keep the full-diff default -> AC8) -->

**Constraints:**

- The agent must not push to the PR branch or start a second review wave while any required review lane is in flight. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_in_flight -->

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Lane classifier tests](../../host/__tests__/lane-classifier.test.js), [Stop-hook behavioral tests](../../host/__tests__/enforce-review-spawn.test.js), [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-053: Pi Durable Review Status and Result Formatting

<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (result model + compact status + announcement-key + summary/actionability tests -> AC1/AC3/AC4/AC5) -->
<!-- @test: src/__tests__/lib/review-state.test.ts (AC2 footer badge: see inline annotation below) -->

**Intent:** Pi operators need consistent PR-boundary review output and a compact indication that internal durable lanes are active.

**Applies To:** User

**Acceptance Criteria:**

1. Durable PR-boundary result files use a shared `## Findings` plus severity-count Review Summary table format. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatDurableReviewResult -->
2. Pi exposes compact durable-lane progress in the footer while PR-boundary review runs, rendering only lanes required for the current review job from the persisted pending review state, prefixed with an elapsed-time badge (`M:SS`, measured from the earliest lane start) and annotating each completed lane with its best-effort token count parsed from the lane transcript (the badge and token figures are omitted when their inputs are unavailable). <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::compactDurableReviewStatus --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatReviewElapsed --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatReviewTokens --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::laneTokensFromTranscript --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::updateReviewStatus --> <!-- @test: src/__tests__/lib/review-state.test.ts ("compactDurableReviewStatus timer + token badge (footer enhancement)" + "formatReviewElapsed / formatReviewTokens" describes -> badge rendering + graceful omission -> AC2) -->
3. Pi suppresses duplicate PR-boundary review result and summary announcements for the same repo, head, lane, and result path. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::installReviewMessageDedupe -->
4. After all required lanes complete, Pi publishes a merged chat summary instead of separate per-lane chat result blocks. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewSummaryMarkdown -->
5. The merged chat summary reports aggregate severity counts across code, spec, and documentation lanes and renders findings sorted by criticality, without requiring per-lane result-file links in chat. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::mergedReviewSummaryModel --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatMergedReviewSummary -->
6. The finding extractor (`extractReviewFindings`) and the severity counter (`countReviewSeverities`) apply one byte-identical decoration rule — a severity word is a finding only when decorated as `[SEVERITY]`, `**SEVERITY**`, or `SEVERITY:` at the leading position of a header line — so the rendered finding list and the Review Summary counts never diverge. A bare severity word in prose ("High-level summary…") or one decorated elsewhere on the line is a finding in neither; a tally line (`HIGH: 2 (…)`) is excluded from both; and a decorated label with no inline title (`**CRITICAL**` alone) is counted once and surfaced as a finding with a placeholder `(untitled)` title rather than dropped from the list while still being counted. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::findingHeaderMatches --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::extractReviewFindings --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::countReviewSeverities --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (decoration lockstep: leading bare severity word with a decorated label elsewhere is not a finding and counts 0; bare decorated label with no title is counted once and extracted as untitled -> AC6) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1/AC3-AC6); [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (AC2 — elapsed/token badge formatting + compact status rendering/omission)

**Status:** Implemented

---

### REQ-AGENT-054: Pi Durable Review Lane Failure Handling

<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (durable lane recovery + result-file gating + reapLaneDecision + summarizeLaneTranscript tests -> AC1-AC6) -->
<!-- coverage-gap: the reap DECISION logic (reapLaneDecision) and transcript parsing (summarizeLaneTranscript) are unit-tested; the OS-level pieces they sit on — detached child-process spawn, pid-group liveness (process.kill(pid,0)), and group kill — are runtime behaviours verified by an integration smoke test (spawn a real detached lane → it runs to agent_end → reap writes a result file), with no dedicated test in the Workers vitest pool. -->

**Intent:** Pi operators need durable PR-boundary review failures to fail closed without falsely acknowledging a PR head.

**Applies To:** User

**Acceptance Criteria:**

1. When a durable Pi review lane exceeds its wall-clock budget, its child process dies before producing a result, or it finishes without usable output, the reaper persists the lane as failed instead of completed; an over-budget lane's process group is also killed. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reapLaneDecision --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes -->
2. Failed or timed-out durable lanes do not satisfy the required result-file gate. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::completedDurableReviewLanes -->
3. A PR head remains unacked until a later review run writes every required lane result file. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::markCompleted -->
4. Lane liveness is the live child pid, identity-checked against its recorded `/proc` start-time so a recycled pid is never trusted alive nor signalled. A `running` lane is re-spawn-suppressed only while alive; a dead child with no result file is reaped to failed and re-spawn-eligible. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::runningDurableReviewLanes --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::isProcessAlive --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::startDurableReviewLanes -->
5. If completion callbacks are missed or Pi reloads, persisted exact-head result files are enough to recover, finalize, acknowledge, and publish the review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::refreshReviewStatusFromDurable --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview -->
6. The reaper writes a lane result file and marks it completed when its transcript reaches a terminal `agent_end` (one with no pending retry), or when its child exits after flushing a usable final assistant message even without a terminal `agent_end` line. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reapLaneDecision --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::summarizeLaneTranscript -->
7. Lane-transcript distillation is retry-aware: an `agent_end` carrying `willRetry: true` (an attempt pi will auto-retry in the same child, e.g. after a transient WebSocket drop) does not settle the lane, and that failed attempt's `errored`/`stopReason`/final-text verdict is discarded so an early transient error cannot poison the retry that later succeeds. The terminal end is any `agent_end` without `willRetry: true` (a clean finish omits the field). A lane a prior reaper tick already marked `failed` is self-healed to `completed` when its transcript later shows a terminal `agent_end` AND a usable result — non-empty final text, `stopReason` neither `error` nor `aborted`, and no error payload — and no result file exists yet; a killed, timed-out, or terminally-errored lane whose result fails that usability check stays failed. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::summarizeLaneTranscript --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reapLaneDecision --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-054: durable lane orchestration is retry-aware (transient error + retry completes; a willRetry attempt-end never settles a lane; a failed lane self-heals) -> AC7) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-059: Pi Durable Review Fix Loop

<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (autofix request gating + manual/auto directive tests -> AC1-AC4) -->

**Intent:** Pi operators need actionable PR-boundary review findings to start a fix pass only when the exact-head review is complete.

**Applies To:** User

**Acceptance Criteria:**

1. Pi requests a fix pass only after every required exact-head result file exists and at least one legitimate `MEDIUM`/`HIGH`/`CRITICAL` finding remains. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendAnnouncement --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::requestReviewAutofixForRows -->
2. Partial lane result sets never trigger a fix request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendAnnouncement --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewAckReady -->
3. When a live session transcript is available, a wait/do-not-auto-fix directive makes Pi present findings without requesting a fix pass. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewAutofixModeFromUserMessages -->
4. Idle finalization without live context keeps the default automatic fix behavior. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendAnnouncement -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-durable-review-status-and-result-formatting)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-060: Pi Durable Review Lane Tool Surface

<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-lane-guards.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (lane extension-source selection -> AC6; lane guard blocking -> AC7; incremental-scope guard (reviewScopeBlockReason) -> AC8) -->
<!-- coverage-gap: AC1-AC5's detached child-process lane execution is a runtime behaviour verified by an integration smoke test, with no dedicated automated test in the Workers vitest pool (which cannot spawn pi). -->

**Intent:** Pi durable review lanes need enough bounded inspection capability to review diffs without loading recursive review enforcement or running local builds.

**Applies To:** User

**Acceptance Criteria:**

1. Durable review lanes run isolated from the parent Pi session so a lane can finish after the spawning session exits. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane -->
2. Durable review lanes start without stdin from the parent session. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane -->
3. Durable review lanes start without context files and do not recursively load the full Codeflare extension stack. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane -->
4. Durable review lanes expose bash for git/gh diff inspection. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane -->
5. Durable review lanes expose graphify inspection tools. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane -->
6. Settings-enabled context-mode may add `ctx_search` to durable review lanes. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::laneExtensionSources -->
7. Durable review lane guards block local build, test, lint, and dev-server commands. <!-- @impl: preseed/agents/pi/extensions/review-lane-guards.ts::reviewLaneBlockReason -->
8. When a prior clean head was acknowledged, durable review lanes are confined to the incremental window: `spawnDurableLane` exports `CODEFLARE_REVIEW_BASE` / `CODEFLARE_REVIEW_HEAD` / `CODEFLARE_REVIEW_BASE_REF`, and the lane guard blocks `gh pr diff` and any `git diff` ranging (two- or three-dot) against the base branch. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @impl: preseed/agents/pi/extensions/review-lane-guards.ts::reviewScopeBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (reviewScopeBlockReason: no base allows all; acked base blocks gh pr diff + two-/three-dot ranges against the base branch; window forms incl. bare SHA range allowed -> AC8) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-061: Pi Idle Durable Review Reaper

<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-061 idle reaper helper test covers AC2 gating; AC1 runtime reaping + AC3/AC4 off-turn finalization have integration smoke coverage) -->
<!-- coverage-gap: AC1's no-turn finished-lane reaping path is driven by a reload-safe `setInterval`; it is runtime-smoke-tested with detached lanes, with no dedicated automated test in the Workers vitest pool. AC4's off-turn summary deferral (no-ctx finalize arms a durable nonce-verified delivery announcement, which the next on-turn tick delivers and verifies — full contract in REQ-AGENT-062) is the same off-turn `setInterval`/`pi.sendMessage` integration glue, verified by inspection and runtime smoke rather than a Workers-pool unit test. -->

**Intent:** Pi must advance and finalize durable review jobs even when the user does not submit another prompt.

**Applies To:** User

**Acceptance Criteria:**

1. An idle Pi session with no user turn still reaps finished durable review lanes. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::autonomousReviewReaperTick -->
2. An idle Pi session starts the next eligible durable review lane after prerequisite lanes complete. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::autonomousReviewReaperTick -->
3. An idle Pi session finalizes completed durable reviews by acknowledging the exact head, saving the merged summary, and starting the autofix request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview -->
4. Off-turn finalization arms a durable, nonce-verified delivery announcement instead of emitting a fire-and-forget message; the next on-turn tick delivers and verifies the merged summary (full delivery contract in [REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery)). <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::drainReviewAnnouncements -->
5. Review-repo resolution for the reaper, the on-turn finalizers, the footer progress row, and the read-only `/review-status` command derives the repo from the boundary-command cwd / Pi session cwd, then an in-session remembered review repo, then the in-memory active repo codeflare-pi tracks on every tool execution (the same signal the statusline uses) — never, for routing, the shared graphify active-cwd sentinel, which multiple agents write and which points at whatever repo acted last. Both the active-repo and review-repo slots live on `globalThis` under `Symbol.for` keys (`codeflare.activeRepo`, `codeflare.reviewRepo`) because Pi 0.79.1's loader (`createJiti(moduleCache:false)`) gives each extension its own module instance, making `globalThis` the only cross-extension channel; a module-local variable written by `codeflare-pi.ts` is invisible to `review-enforcement.ts` and `local-statusline.ts`. The in-memory active-repo fallback is what lets `/review-run`, the no-ctx reaper, and `/review-status` resolve a nested clone when the session cwd is a non-repo parent workspace and no review has run yet; `/review-status` previously resolved from the session cwd alone and so warned "not inside a git repository" in such a session. Because `/review-status` is strictly read-only it additionally falls back — for display only, never for routing — to the guarded on-disk sentinel, the same last resort the statusline footer uses (`activeRepoSentinelForDisplay`, guarded to a git repo inside a session root). <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::resolveReviewRepo --> <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewStatusRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::recallActiveRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberActiveRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberReviewRepo --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewRepoForCtx --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::liveReviewRow --> <!-- @test: src/__tests__/lib/review-state.test.ts (resolveReviewRepo precedence incl. the active-repo fallback + never probes the sentinel path -> AC5) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-054](#req-agent-054-pi-durable-review-lane-failure-handling), [REQ-AGENT-059](#req-agent-059-pi-durable-review-fix-loop)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1/AC2); [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (AC5 — resolveReviewRepo precedence + sentinel-independence)

**Status:** Implemented

---

### REQ-AGENT-062: Pi PR-Boundary Review Result Delivery

<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-062 delivery announcement nonce/retry/reconcile decision helpers -> AC2/AC3) -->
<!-- coverage-gap: the impure layer — the durable announcement-record I/O lifecycle (arming, no-re-arm-when-visible, re-arm-when-failed, superseded-head retirement: AC1/AC5) and the live wiring (sessionContainsNonce's transcript scan, the emit/reconcile drain on each lifecycle tick, the /review-results command, the persistent results-ready status: AC4; the idle-gated plain-append summary delivery in sendAnnouncement: AC6/AC7) — lives in review-jobs.ts/review-enforcement.ts, which top-level-import node:child_process and the Pi SDK and so cannot load in the Workers vitest pool. It is verified by inspection + a bundled-jiti load-check + a post-deploy live smoke test, the repo's runtime-coverage convention. The pure decision helpers (AC2/AC3) are unit-tested. -->

**Intent:** A completed PR-boundary review must reliably DELIVER its merged summary back into the main Pi session, not just ack the head and write `summary.md` to disk. `pi.sendMessage` persists a custom message into the session transcript only when the live agent session emits a `message_end` event, so an off-turn finalize (the idle reaper has no live session loop) or a stale post-reload sender silently no-ops. Delivery is therefore a SECOND, separately-tracked durable phase: a send is never assumed delivered — it is proven against the transcript, retried, observable, and has a manual fallback, so a review's findings are never acked-and-lost. Review execution and lane finalization live in [REQ-AGENT-054](#req-agent-054-pi-durable-review-lane-failure-handling)/[REQ-AGENT-061](#req-agent-061-pi-idle-durable-review-reaper); summary formatting in [REQ-AGENT-053](#req-agent-053-pi-durable-review-status-and-result-formatting).

**Applies To:** User

**Acceptance Criteria:**

1. Review delivery is two-phase: finalizing a completed review (acking the head, saving `summary.md`) arms a durable per-`(head, kind)` delivery announcement in `pending` instead of emitting a fire-and-forget message. The summary announcement is always armed; the autofix announcement only when actionable findings remain. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::armReviewAnnouncements --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::ensureReviewAnnouncementPending -->
2. A delivery announcement is marked `visible` (delivered) ONLY when its unique nonce is found in the session transcript — never on a bare `sendMessage` return. Each summary/autofix message embeds its nonce, which persists into the transcript line iff the message actually reached the live session. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sessionContainsNonce --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::announcementReconcileDecision --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewAnnouncementNonce --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (nonce determinism/uniqueness; reconcile nonce->visible; autofix request carries the nonce -> AC2) -->
3. Pending or unverified announcements are (re)attempted on every live lifecycle tick (`session_start` / `turn_start` / `turn_end` / `resources_discover` / `agent_end`), bounded by a retry delay and an attempt cap. Once the cap is exhausted without the nonce ever appearing, the announcement is marked `failed` and the user is notified to run `/review-results`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::drainReviewAnnouncements --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::shouldAttemptAnnouncement --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::announcementReconcileDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (shouldAttemptAnnouncement retry/cap; reconcile under-cap keep vs cap+window failed -> AC3) -->
4. While a completed review's summary announcement is not yet `visible`, a persistent `results ready (not shown) — /review-results` footer status is shown and cleared only on delivery; the `/review-results` command displays the persisted `summary.md` on demand (the guaranteed fallback when automatic delivery never lands) and marks the announcement delivered. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::refreshDeliveryStatus --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::review-results -->
5. A delivered (`visible`) announcement is never re-emitted (no duplicate summary), and a superseded head's undelivered announcements are retired so the new head never re-emits stale results. The `sendMessage` dedupe patch binds the CURRENT live sender (never a reload-surviving stale sender that returns cleanly but writes nothing), so delivery always targets the active session. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::ensureReviewAnnouncementPending --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::abandonReviewAnnouncements --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::installReviewMessageDedupe -->
6. The display-only summary uses plain `pi.sendMessage` only when a live session context exists and `pi.isIdle()` is true. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendAnnouncement -->
7. A summary that is not live-deliverable stays pending for a later ctx-bearing idle tick and falls back to `/review-results` after the maximum age. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendAnnouncement --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::announcementReconcileDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (announcementReconcileDecision age backstop escalates an idle-deferred summary -> AC7) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-061](#req-agent-061-pi-idle-durable-review-reaper), [REQ-AGENT-059](#req-agent-059-pi-durable-review-fix-loop), [REQ-AGENT-053](#req-agent-053-pi-durable-review-status-and-result-formatting)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC2/AC3 — nonce determinism, retry/reconcile decisions). The impure durable announcement-record I/O lifecycle (AC1/AC5), the live transcript-scan delivery, per-tick emit/reconcile drain, `/review-results` command, and results-ready status (AC4) are verified by inspection plus a bundled-jiti load-check and a post-deploy live smoke test — the repo's runtime-coverage convention, since review-jobs.ts/review-enforcement.ts top-level-import node:child_process and the Pi SDK and cannot load in the Workers vitest pool.

**Status:** Implemented

---

### REQ-AGENT-055: Pi PR-Boundary Review Window Advancement

<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-helpers.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi review helper behavior tests -> AC1/AC2/AC3/AC4/AC5) -->

**Intent:** Pi review enforcement must keep the merge gate attached to the first unreviewed PR window across reloads, retries, and fix-push cascades without losing findings from an earlier incomplete review.

**Applies To:** User

**Acceptance Criteria:**

1. A pending review window is discarded when the readable PR has definitively closed, retargeted, or moved to an unrelated head. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewHead -->
2. If the PR state cannot be read, the pending review window is left intact for retry. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewHead -->
3. If the readable PR head advances to a descendant while review is still in flight, Pi rolls the review window forward instead of discarding it, and kills the superseded head's still-running lane children so a fix-push cascade cannot pile up orphaned reviewer processes on the container (completed lanes' results are reused). <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewHead --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::rollForwardAdvancedReview --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::abandonDurableReviewLanes -->
4. A fix-push cascade preserves the first unreviewed review base for cumulative review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::selectReviewBase -->
5. Pi does not use a remote-tracking previous head as a review base unless an explicit ack or completed previous review proves the earlier PR contents were already covered. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::selectReviewBase -->
6. The `gh pr merge` gate blocks the merge until the reviewed head is acked; it gates on whether the required reviewers RAN, not on findings severity (lanes are report-only, [AD80](../../documentation/decisions/README.md#ad80-pi-pr-boundary-merge-gate-is-report-only-and-defended-in-depth)). The decision evaluates the PR the merge command actually TARGETS (a number / `/pull/` URL / branch / `--repo` slug), not just the cwd branch; fails CLOSED when that PR is readable-but-malformed (OPEN with empty `baseRefName`/`headRefOid`) or `gh` is transiently unreadable while any unacked merge-blocking head exists (pending, latched-breaker, or outstanding-offer); blocks `--auto` on an enforced unacked PR (it would merge server-side after checks without re-consulting the gate); and, as a retroactive backstop for wrapper forms the pre-block cannot intercept (`bash -c`, `xargs`, server-side `--auto`), emits a durable `merge_completed_unreviewed` audit + toast when a PR is observed MERGED while its head was never acked. The pure decision is unit-tested; the handler is thin wiring. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::mergeGateDecision --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::mergeCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::onAgentStart --> <!-- @test: src/__tests__/lib/review-state.test.ts (mergeGateDecision: head_not_acked block, acked allow, non-enforced/no-PR allow, transient/malformed fail-closed with pending, breaker/offer candidate, bypass -> AC6) --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (mergeCommandTarget: number/URL/branch/--repo/--auto/value-flag/wrapper -> AC6) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-054](#req-agent-054-pi-durable-review-lane-failure-handling)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts); the merge-gate decision and merge-command-target parsing are unit-tested in [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (`mergeGateDecision`) and [review-trigger.test.ts](../../src/__tests__/lib/review-trigger.test.ts) (`mergeCommandTarget`). The roll-forward lane abandonment (AC3), the retroactive `merge_completed_unreviewed` audit, and the `onAgentStart` gate wiring that consumes the pure decision are verified by inspection plus a bundled-jiti load-check (the repo's runtime-coverage convention for the seeded extensions).

**Status:** Implemented

---

### REQ-AGENT-056: Pi Local Statusline Footer

<!-- @impl: preseed/agents/pi/extensions/local-statusline.ts -->
<!-- @impl: preseed/agents/pi/manifest.json -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-056 local statusline fake-footer render -> AC1/AC2/AC3/AC4/AC5) -->
<!-- @test: src/__tests__/lib/review-state.test.ts (active-repo remember/recall + separate slot from review-repo memory + sentinel guard accept/reject including path-boundary workspace-other case -> AC2) -->

**Intent:** Pi users need a compact footer in every session mode that shows session context without hiding extension-owned status rows such as PR-boundary review progress.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi local statusline extension is preseeded in both Standard and Pro modes. <!-- @impl: preseed/agents/pi/manifest.json::local-statusline.ts -->
2. The footer's first line renders current context usage, active model ID with thinking effort as `model:effort`, and the active repository label when one can be resolved. When neither the session cwd nor the ctx cwd is inside a git repo (e.g. the session cwd is a non-repo parent workspace and work happens in a nested repo via `git -C`), the label falls back — display-only, never for review routing — through: the in-session active repo remembered by codeflare-pi whenever a command resolves a git root, the in-session remembered review repo (nested review clones), and finally the on-disk graphify active-cwd sentinel guarded to a git repo inside a session root so a concurrent agent's unrelated repo cannot hijack the footer. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::renderLine --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::contextPercent --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::sentinelRepoForDisplay --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberActiveRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::activeRepoSentinelForDisplay --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberReviewRepo --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::updateActiveRepoFromPath -->
3. Extension-owned statuses are preserved on an additional footer line only while statuses exist; idle sessions do not render an empty second line. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::installFooter -->
4. Footer lines are truncated by visible width, preserving ANSI color sequences and appending a reset before the ellipsis so colored review statuses do not consume visible width or bleed styling past truncation. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::truncateToWidth -->
5. The statusline refreshes on session start, resource discovery, turn boundaries, model changes, thinking-effort changes, and cache-TTL repaint intervals. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::refreshFooter --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::CACHE_TTL_MS -->

**Constraints:**

- The statusline is cosmetic and must not block agent execution if repository or context metadata cannot be read.

**Priority:** P2

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Pi local statusline render test](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1-AC5); [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (AC2 — repo-label resolution via rememberReviewRepo/recallReviewRepo, rememberActiveRepo/recallActiveRepo, and the guarded activeRepoSentinelForDisplay fallback)

**Status:** Implemented

---

### REQ-AGENT-057: Pi Review-Status Command

<!-- @impl: preseed/agents/pi/extensions/review-command.ts::review-status -->
<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::computeReviewState -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::computeReviewStateFrom -->
<!-- @test: src/__tests__/lib/review-state.test.ts (computeReviewStateFrom lane-status precedence + overall aggregation + acked/breaker semantics -> AC1) -->
<!-- @test: src/__tests__/lib/review-command.test.ts (renderReviewStatus rendering contract: PR/local/acked SHAs, per-lane status, overall verdict, summaryReady path, autofix, breaker, merge-gate -> AC1) -->
<!-- @test: src/__tests__/lib/review-command.test.ts (renderReviewStatus read-only contract: idempotency, string return-type, no input mutation -> AC2) -->
<!-- @test: src/__tests__/lib/review-command.test.ts (recentReviewEvents JSONL tail: last-N ordering, .git path contract, blank-line filtering, empty-file, verbatim preservation -> AC3) -->

**Intent:** A Pi user needs a read-only way to see PR-boundary review enforcement state for the current repo — whether a review is running, why a merge is blocked, and what recently happened — without inspecting `.git/` by hand.

**Applies To:** User

**Acceptance Criteria:**

1. A `/review-status` command renders the canonical review state for the current repo's enforced head: PR / local / last-acked heads, per-lane status, overall verdict, summary readiness, autofix state, breaker state, and the merge-gate verdict. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::formatReviewStatus --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::computeReviewState -->
2. The command is read-only: it never spawns a review, advances the ack, or mutates any enforcement state. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::review-status -->
3. The command appends a short tail of the decision audit log (`.git/codeflare-review-events.jsonl`) so recent enforcement decisions are visible inline. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::recentReviewEvents -->

**Constraints:**

- The command is diagnostic and must not block or alter agent execution when repository, PR, or review state cannot be read.

**Priority:** P2

**Dependencies:** [REQ-AGENT-055](#req-agent-055-pi-pr-boundary-review-window-advancement)

**Verification:** [Canonical review-state unit tests](../../src/__tests__/lib/review-state.test.ts) (AC1 state computation); [review-status command tests](../../src/__tests__/lib/review-command.test.ts) (AC1 rendering contract via `renderReviewStatus`, AC2 read-only/idempotency, AC3 audit-log tail via `recentReviewEvents`).

**Status:** Implemented

---

### REQ-AGENT-058: PR-Boundary Review Reconciliation and Missed-Event Recovery

<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reconcileOpenPrReview -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ensureReviewWindow -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::resolveEnforcedHead -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::shouldReconcileOpenPr -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reconcileBoundaryAction -->
<!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::activeRepoSentinelForReview -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::restoreActiveRepoFromPersistedFiles -->
<!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::appendReviewEvent -->
<!-- @test: src/__tests__/lib/review-state.test.ts (shouldReconcileOpenPr decision gating -> AC1/AC6; reconcileBoundaryAction action gate: autostarts in-session continuation, offers a fresh clone once, no-ops on re-offer of a clone head and on a non-reconcilable head -> AC1; every suppressed gate names a distinct non-empty reason -> AC6) -->
<!-- @test: src/__tests__/lib/review-trigger.test.ts (enforcedHeadDecision pushed-vs-unpushed table -> AC5; prUrlFromText PR-URL boundary detection -> AC6) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (postCommandReconcileDecision fresh PR-state decision -> AC1; seeded review-enforcement wires reconcileOpenPrReview + shouldReconcileOpenPr -> AC1/AC4) -->

**Intent:** Review initiation must not depend solely on capturing a transient tool event. A missed or mis-parsed boundary command must not silently skip review: an open enforced PR whose head was never reviewed is recoverable on a later turn, the start path is shared with the boundary path so the two cannot drift, and every near-miss leaves a durable diagnostic so a skipped review is detectable instead of silent.

**Applies To:** User

**Acceptance Criteria:**

1. Reconciliation reads PR state on lifecycle ticks and after successful shell commands that invoke `git` or `gh`; post-command reads bypass stale PR cache. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reconcileOpenPrReview --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::postCommandReconcileDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (postCommandReconcileDecision forces fresh PR-state reconcile after git/gh shell commands -> AC1) -->
2. An unacknowledged protected PR head advanced during the current session starts a durable review automatically. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::shouldReconcileOpenPr --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewInSessionContinuation --> <!-- @test: src/__tests__/lib/review-state.test.ts (shouldReconcileOpenPr gates enforced open PR heads; reviewInSessionContinuation distinguishes in-session advances from inherited heads -> AC2) -->
3. An inherited protected PR head is offered once and remains merge-blocking until the user starts or skips review. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reconcileBoundaryAction -->
4. Boundary-command and reconciliation paths call one shared routine, so windows match in lanes, base, durable job, and audit trail. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ensureReviewWindow -->
5. Head resolution tolerates GitHub metadata lag only for a pushed local head on the PR branch. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::resolveEnforcedHead --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::enforcedHeadDecision --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (enforcedHeadDecision pushed-vs-unpushed table -> AC5) -->
6. Skipped boundary candidates and PR-URL fallback events leave durable audit entries, so missed review starts are diagnosable. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::onToolEnd --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::appendReviewEvent --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prUrlFromText --> <!-- @test: src/__tests__/lib/review-state.test.ts (suppressed reconcile gates name a distinct non-empty reason -> AC6) -->

**Constraints:**

- Reconciliation is gated on a real open enforced PR, never on branch existence.
- Integration-branch PRs stay deferred until their own PR-to-`main`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-055](#req-agent-055-pi-pr-boundary-review-window-advancement)

**Verification:** Unit tests: [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts), [review-trigger.test.ts](../../src/__tests__/lib/review-trigger.test.ts), [agent-seed-manifest.test.ts](../../src/__tests__/lib/agent-seed-manifest.test.ts). Runtime wiring is verified by inspection and the bundled-jiti harness.

**Status:** Implemented

---

### REQ-AGENT-041: PR-Boundary Review Bypass Surfaces

<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts -->
<!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::bypassAckHeadForStatus -->
<!-- @test: host/__tests__/enforce-review-spawn.test.js (bypass 1: sentinel file + bypass 2: magic phrase + 3-strike circuit breaker describes -> AC1/AC2/AC3 user-only escape hatches with sticky-until-SHA-changes circuit) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-041 / REQ-AGENT-055: Pi review bypass acknowledges only the current live PR head -> AC1 Pi advanced-head acknowledgement) -->

**Intent:** The user needs a small set of explicit, user-only escape hatches when a PR-boundary review gate would otherwise block legitimate work (hermetic tests, deliberate skip, repeated false-block). The assistant MUST NEVER trip these surfaces in its own output.

**Applies To:** User

**Acceptance Criteria:**

1. A user-creatable one-shot sentinel file bypasses the current PR-boundary gate exactly once and is auto-deleted on use, never committed and never surviving a container restart: in Claude Stop-hook enforcement it bypasses without advancing the acknowledgement checkpoint, while in Pi native enforcement it acknowledges the current live protected PR HEAD rather than any stale or superseded pending state. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeBypass --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::bypassAckHeadForStatus -->
2. A magic phrase `skip review` or `skip verification` (case-insensitive, word-bounded) in any user message after the candidate push line in the transcript bypasses the gate for that push.
3. A 3-strike circuit breaker exits silently after blocking the same un-acked PR HEAD SHA three times, sticky until the SHA changes.
4. The assistant MUST NEVER create the sentinel file or write the magic phrase in its own output; both are explicitly user-only escape hatches. The native runtime reinforces this for the sentinel half structurally: the review extension only tests for and deletes the sentinel on use, with no code path that creates it. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeBypass -->

**Constraints:**

- These bypass surfaces apply only to PR-boundary review gates; the in-turn nudge and trigger detection in [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions) are unaffected.
- The bypass sentinel location is overridable for hermetic test environments.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Automated test](../../host/__tests__/enforce-review-spawn.test.js), [Pi bypass-head acknowledgement test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-037: `/sdd clean` Rescue and Autonomy Modes

<!-- @impl: preseed/agents/claude/skills/sdd-clean -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @impl: preseed/agents/claude/rules/spec-discipline.md -->
<!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037 describes -> AC1 three autonomy modes + layout-resolved config.yml + AC2 unleashed JUDGMENT distinction + AC3 safety nets across modes + AC4 layout migration + AC5 per-category mechanics) + host/__tests__/enforce-review-spawn.test.js (3-strike circuit breaker describe -> AC6 2-fix-round limit per agent per commit cycle) -->

**Intent:** Three autonomy modes (interactive, auto, unleashed) give the user a knob between hand-holding and walk-away autopilot, and the `/sdd clean` rescue pass restores rotted specs to canonical shape without overwriting intent. Review-agent discipline enforcement (the content-quality passes each review agent applies) lives in [REQ-AGENT-044](#req-agent-044-review-agent-discipline-enforcement).

**Applies To:** User

**Acceptance Criteria:**

1. Three autonomy modes (`interactive`, `auto`, `unleashed`) are selectable via the layout-resolved config file (`sdd/spec/config.yml` on the nested layout, `sdd/config.yml` on the flat-legacy layout).
2. `interactive` and `auto` modes apply fixes on the current branch (auto silently, interactive after confirmation).
3. `unleashed` mode applies SAFE + RISKY + JUDGMENT fixes on the current branch via per-category `[sdd-clean]` commits and uses conservative JUDGMENT auto-resolution that never overwrites intent.
4. `unleashed` refuses to run when `enforce_tdd: false` so the per-project opt-out is preserved; the user flips the flag manually or invokes `auto` instead, and `unleashed` never creates a new branch or opens a pull request so `git revert <sha>` on a per-category commit is the rollback surface.
5. `/sdd clean` rescues rotted specs with conservative JUDGMENT auto-resolution that never overwrites spec intent (mark Partial + Notes, move to Out of Scope, shrink in place).
6. Each review agent self-limits to 2 fix rounds per commit cycle scoped to its own lane (spec-reviewer counts only commits touching `sdd/**`; doc-updater counts only commits touching `documentation/**`) to prevent micro-fix spirals without cross-contaminating lanes.
7. In `auto` and `unleashed` modes, spec-reviewer and doc-updater push to whatever branch is currently checked out; the user is responsible for checking out the right branch before invoking.

**Constraints:**

- Status semantics, `Deprecated` requirements, the spec-discipline enforcement layer, and the `enforce_tdd` test-coverage rule follow `rules/spec-discipline.md`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-clean-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-044: Review-Agent Discipline Enforcement

<!-- @impl: preseed/agents/claude/rules/spec-discipline.md -->
<!-- @impl: preseed/agents/claude/rules/documentation-discipline.md -->
<!-- @impl: preseed/agents/claude/rules/tdd-discipline.md -->
<!-- @test: host/__tests__/enforce-review-spawn.test.js (3-strike circuit breaker describe + agent-spawn enforcement describe + round-3 ordering and parser fixes describe -> AC1 review-agent gating enforcement + content-quality round limits) + host/__tests__/git-push-review-reminder.test.js (SDD transition gate describe + lane-aware emission describe -> AC1 lane-by-lane enforcement dispatch + content-quality routing) -->

**Intent:** The three review agents (doc-updater, spec-reviewer, code-reviewer) enforce content-quality beyond structural compliance. Each owns a distinct set of substantive passes (truth-check against source, content-preservation on trims, test-name-vs-assertion match) so a structurally-clean change cannot ship with semantically-wrong content.

**Applies To:** User

**Acceptance Criteria:**

1. All three review agents (doc, spec, tdd) enforce both structural compliance and content-quality on every applicable lane.
2. doc-updater runs structural passes (shape, budgets, lane) and content-quality passes (verification truth-check, Implements-vs-AC cross-walk, stale code-block detection against source, content-preservation on trims, stranger cold-read usability).
3. spec-reviewer runs the spec analogs (REQ-test truth-check beyond literal ID match, vendor/protocol drift detection, content-preservation on shrink).
4. code-reviewer flags tests whose name claims behavior the assertions don't actually verify (the test-name-lies antipattern from `tdd-discipline`).
5. Auto-fixes derive concrete content from source or REQ when possible; load-bearing clauses that would be lost to a word-cap trim are promoted to surrounding prose, or the trim is reverted with a finding.

**Constraints:**

- The structural-vs-content-quality split, per-pass severity, and auto-fix behavior follow `rules/documentation-discipline.md`; the cold-read task registry is owned by the same file.
- spec-reviewer's content-quality passes are defined by `rules/spec-discipline.md`; code-reviewer's test-name-lies detection follows `rules/tdd-discipline.md`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes), [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Automated test](../../host/__tests__/enforce-review-spawn.test.js)

**Status:** Implemented

---

### REQ-AGENT-022: Legacy-codebase Import Mode Discovery

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @test: host/__tests__/enforce-review-spawn.test.js + git-push-review-reminder.test.js (SDD transition gate describes -> AC1/AC2 transition-aware enforcement bypass during /sdd init Import Mode) -->

**Intent:** Enterprises migrating a legacy codebase from manual development to autonomous agentic development need a transition path that converts un-extracted intent into a real spec. `/sdd init` Import Mode runs discovery against the full project history and produces two outputs from the same pass: official REQs for behavior clear from that surface, and a triage queue for everything unclear. The triage entry shape, transition gate, and Status semantics live in [REQ-AGENT-045](#req-agent-045-import-mode-triage-queue-and-transition-state).

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` Import Mode emits two outputs simultaneously: spec REQs in `sdd/{domain}.md` for anything clearly determinable from the full discovery surface, and triage entries in `sdd/.init-triage.md` for anything unclear (magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent, domain-placement guesses).
2. The discovery surface during Import Mode is the full project history, not just source code.
3. The agent pulls evidence from the working tree (README, configs, source, tests, inline comments, ADR-shaped files) and git history (commit messages on entry-point files, tag annotations).
4. When a GitHub remote is detected, the agent additionally pulls pull requests with their review comments and inline threads, issues open and closed with their comments, release notes, and the wiki via the GitHub API.
5. When one artifact references another ("Closes #142"), the agent follows the chain backward through every linked artifact rather than stopping at the first hit.
6. When the GitHub corpus is unreachable (non-GitHub remote, `gh auth status` fails, rate-limited, private repo with insufficient token scope, air-gapped), the agent skips GitHub sources and proceeds with working-tree + git-log evidence only; a one-line notice naming the reason is printed before scaffolding and appended to the `sdd/changes.md` import entry.

**Constraints:**

- GitHub-corpus evidence collection uses `gh pr list --state all`, `gh pr view {n} --comments`, `gh issue list --state all`, `gh issue view {n} --comments`, `gh release list`, and `gh release view {tag}`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** [Automated test](../../host/__tests__/enforce-review-spawn.test.js)

**Status:** Implemented

---

### REQ-AGENT-045: Import-Mode Triage Queue and Transition State

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045 describes -> AC1 .init-triage.md location + AC2/AC3 Status: open|resolved|lost vocabulary and Reason: requirement on lost) + host/__tests__/enforce-review-spawn.test.js + host/__tests__/git-push-review-reminder.test.js (SDD transition gate (REQ-AGENT-022) describes -> AC4 transition: true suspends entire review pipeline) -->

**Intent:** Every unclear item from Import Mode lands in a typed triage entry with concrete Context evidence so the human resolver can decide without re-investigating, and the transition state suspends the entire review pipeline so legacy code does not trigger reviewers until the spec is real. Status defaults respect the project's TDD opt-out so imported codebases do not get falsely flagged as incomplete.

**Applies To:** User

**Acceptance Criteria:**

1. Every entry in `sdd/.init-triage.md` carries `**Context:**` (concrete evidence: file path + line range, git author of last meaningful change, commit SHA + subject, related tests, related PR numbers, related issue numbers, related release tags) and `**Recommendation:**` (the agent's specific best-guess answer) with `**Rationale:**` (one line tying the recommendation to specific Context evidence).
2. The `/sdd init` skill instructs the agent to populate `**Context:**`, `**Recommendation:**`, and `**Rationale:**` for every entry; well-formedness (concrete Context refs, a specific Recommendation, no placeholders like `TBD`/`(inferred)`) is verified at the enforce pass, not by a programmatic parser gate.
3. Triage entries use `**Status:** open | resolved | lost`; `lost` requires a one-line `**Reason:**` field explaining why the information is genuinely unrecoverable.
4. While `sdd/.init-triage.md` contains any `Status: open` items, `sdd/config.yml` carries `transition: true` and the project is in SDD transition; during transition the entire review pipeline is suspended (code-reviewer, spec-reviewer, and doc-updater do not fire on any push or PR event) and `/sdd mode unleashed` is rejected with a message naming the transition and the open triage items.
5. When `enforce_tdd: false` (the Import Mode default), CLEAR REQs whose source code implements the AC default to `Status: Implemented` unconditionally so the project's opt-out from test-based verification is honored.
6. When `enforce_tdd: true`, Status defaults `Implemented` only if a test file references the REQ ID, `Partial` otherwise.

**Constraints:**

- Triage items live only in `sdd/.init-triage.md`. No separate state file, no JSON mirror, no machine-readable index. Git history is the audit trail for who resolved which item with what decision.
- Triage workflow is interactive only. `auto` and `unleashed` modes do not auto-resolve triage items.
- `sdd/.init-triage.md` is owned by `/sdd init`. spec-reviewer reads it to determine transition state and to verify resolved items' REQs received the fold-in; doc-updater does not touch it.
- When `enforce_tdd: false`, each domain `sdd/{domain}.md` file receives one footnote `_Verification: code-only (no automated coverage)._` appended at the bottom. This is the only signal location; per-REQ `Notes:` fields are not used for this signal.
- The Resume Mode drain workflow that resolves the open items lives in [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow).

**Priority:** P1

**Dependencies:** [REQ-AGENT-022](#req-agent-022-legacy-codebase-import-mode-discovery)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-init-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-038: Resume Mode Drain Workflow

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-038 describes -> AC1 Resume Mode section + AC2 in-flight transition state detection via config.yml transition: flag or pickup-where-you-left-off procedure) -->

**Intent:** Re-invoking `/sdd init` on a transitioning project enters Resume Mode, which surfaces open triage items one at a time, refreshes their Context, accepts one of five decisions, and commits each decision so the user can drain the queue at their own pace. When the last item closes, the project exits SDD transition.

**Applies To:** User

**Acceptance Criteria:**

1. Re-invoking `/sdd init` on a project where `sdd/` already exists and `sdd/.init-triage.md` has at least one open item enters Resume Mode rather than aborting. Resume Mode surfaces one open item at a time, refreshing its Context before presenting (re-reads source, re-checks git log, re-fetches related PRs, issues, and releases).
2. The user chooses one of five decisions per item (`accept`, `correct`, `lost`, `skip`, `quit`); per-decision semantics are enumerated in Constraints.
3. Only `accept` and `correct` promote anything into the official spec; `skip` and `lost` write nothing to `sdd/{domain}.md`.
4. Each decision is its own commit (`[sdd-init] resolve TRIAGE-{NNN}` or `mark lost`).
5. Resume Mode entry refuses to start when the working tree has uncommitted changes (same gate as `/sdd clean`) and is always interactive regardless of `sdd/config.yml`'s `mode`. When `mode: auto` is set, Resume Mode prints a one-line notice that auto is suspended for this run and resumes after the queue drains.
6. Queue-drain closure mechanics are specified in [REQ-AGENT-047](#req-agent-047-resume-mode-closure-and-review-pipeline-gate).

**Constraints:**

- Resume Mode is interactive only; `mode: auto` and `mode: unleashed` are suspended for the duration of the drain.
- Per-decision semantics for AC2:
   - `accept`: use the recommendation as-is and fold into the relevant REQ.
   - `correct`: free-form prose describing what the thing is for and how it works; agent folds purpose into REQ Intent and behavior into AC bullets.
   - `lost`: record the gap with a one-line Reason; the related REQ (if any) gets a `Notes: intent lost during SDD transition - see TRIAGE-{NNN}` annotation; nothing is fabricated into the spec.
   - `skip`: leave Status: open, write nothing to the spec, advance to next.
   - `quit`: commit progress and exit.

**Priority:** P1

**Dependencies:** [REQ-AGENT-022](#req-agent-022-legacy-codebase-import-mode-discovery)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-init-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-047: Resume Mode closure and review-pipeline gate

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-047 describe -> AC1 Resume Mode closure runs Phase 7a + Phase 7b before exiting transition) + host/__tests__/enforce-review-spawn.test.js + host/__tests__/git-push-review-reminder.test.js (SDD transition gate (REQ-AGENT-022) describes -> AC4 PR-boundary pipeline short-circuits while .init-triage.md has open items) -->

**Intent:** When the Resume Mode triage queue drains, the project must cleanly exit SDD transition: clear the `transition: true` flag, record totals, and re-arm the gates that were suspended during drain. The PR-boundary review pipeline must stay silent while triage items remain open so legacy code does not trigger review agents before the spec is real.

**Applies To:** User

**Acceptance Criteria:**

1. When the last `Status: open` item is resolved or marked `lost`, the resolving commit clears `transition: true` from `sdd/config.yml`, appends a closure entry to `sdd/changes.md` recording totals (accepted / corrected / lost), and the agent enters Plan Mode (same hard gate as greenfield `/sdd init`) so the first feature work on top of the now-real spec is plan-gated.
2. `enforce_tdd` is NOT auto-flipped on closure; the user changes it manually when ready for TDD enforcement, typically after adding REQ-ID references to test names in the imported source.
3. `sdd/.init-triage.md` is preserved on closure as the audit record.
4. The PR-boundary review pipeline (PostToolUse `git-push-review-reminder` + Stop `enforce-review-spawn` hooks) short-circuits to no-op while `sdd/.init-triage.md` has open items, so legacy code does not trigger code-reviewer / spec-reviewer / doc-updater until the spec is real.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow)

**Verification:** [Automated test](../../host/__tests__/skill-sdd-init-contract.test.js)

**Status:** Implemented

---

### REQ-AGENT-023: Knowledge-Graph Capability (Graphify)

<!-- @impl: preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/local-graphify-labels.sh -->
<!-- @impl: preseed/agents/pi/scripts/build-graphify-ast.sh -->
<!-- @impl: preseed/agents/pi/scripts/build-graphify-architecture.sh -->
<!-- @impl: preseed/agents/pi/scripts/safe-graphify-update.sh -->
<!-- @impl: preseed/agents/pi/scripts/local-graphify-labels.sh -->
<!-- @impl: preseed/agents/pi/extensions/graphify-native.ts -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @impl: Dockerfile -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/entrypoint-graphify-mcp.test.js (MCP server registration in ~/.claude.json → AC2) -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (graphifyy pip install + pinned version → AC1/AC3) -->
<!-- @test: host/__tests__/graphify-active-repo.test.js (active-repo sentinel writer → AC5) -->
<!-- @test: host/__tests__/graphify-mcp-lazy.test.js (LazyGraph rebind on graph.json appearance → AC4/AC6) -->
<!-- @test: host/__tests__/safe-graphify-update.test.js -->
<!-- @test: host/__tests__/entrypoint-devshm-prereq.test.js (REQ-AGENT-023 prereq: /dev/shm tmpfs mount in entrypoint.sh describe -> /dev/shm mountpoint after entrypoint runs + Python multiprocessing.Lock allocates + idempotent on warm boot -> AC1 graphify Python multiprocessing prerequisite) -->
<!-- @test: host/__tests__/context-mode-version-pin.test.js (context-mode plugin.json version pin describe -> at least v1.0.151 -> regression sentinel for issue #671 fix surface; REQ-AGENT-005 AC4/AC5 context-mode version floor) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-023 Pi native runtime assets expose first-party graphify-native tools (no MCP, no third-party wrapper) -> AC2 Pi-equivalent native graphify surface) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-023 AC4: codeflare-pi.ts tolerates missing graph and reports present graph -> AC4 Pi missing-graph tolerance and post-clone prompting) -->

**Intent:** Every container ships the graphify code-knowledge-graph capability as ambient infrastructure, so any session (default or advanced session mode) can query an existing graph or build a new one without per-tier provisioning.

**Applies To:** Agent

**Acceptance Criteria:**

1. `graphifyy` installs in every container image with MCP, SQL, and PDF extras, pinned to one Dependabot-tracked version. Provider extras stay absent; extraction and labeling remain agent-driven. <!-- @impl: Dockerfile::graphifyy -->
2. Claude receives the Graphify MCP server in every session. Pi receives first-party native `graphify_query`/`graphify_path`/`graphify_explain` tools from `graphify-native.ts`, not an MCP server or npm wrapper. Both shell the upstream engine. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::LazyGraph --> <!-- @impl: preseed/agents/pi/extensions/graphify-native.ts::graphify_query -->
3. AC1 and AC2 hold across all paid tiers for ambient query/build capability; advanced-mode agent orchestration keeps `/graphify` extraction context bounded via subagent chunking. <!-- @impl: Dockerfile::graphifyy --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::subagent -->
4. Startup with no graph is tolerated: Claude starts empty and rebinds later; advanced-mode Pi clone triage asks before graph work. Query tools use the active repo graph after it exists. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::graphifyCloneAction --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::fallbackGraphifyToolResult -->
5. Advanced mode tracks the active repository; resolution walks up to the nearest Git repo or graph artefact and understands command-local `cd ... &&` plus `git -C ...` forms. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::effectivePathForCommand --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::updateActiveRepoFromPath -->
6. When the active-repo signal is absent or stale, Pi graphify query tools fall back from the session cwd repo graph to the same-repo sentinel graph and then to the merged global graph. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::pickGraphSource -->

**Constraints:**

- The image uses upstream graphify without a fork; provider/office/video/Neo4j/local-backend extras are not installed.
- Pi query tools resolve the session cwd repo graph, then the same-repo sentinel graph, then the merged global graph; no graph fails soft.
- Ambient MCP/native query capability is all-mode; graph-first discipline, Pi workflow assets, clone triage, active-repo tracking, and graph summaries are advanced-only.
- Per-branch graphs are unsupported; users refresh after checkout.
- Existing graph refreshes use the bounded update wrapper, never bare `graphify update`.
- Pi first-build scripts own AST and architecture graph creation.
- Entrypoint mounts tmpfs `/dev/shm` for Graphify AST multiprocessing, memory capture, and vault extraction.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-008](#req-agent-008-preseed-deployed-to-container-on-start)

**Verification:** [Automated test](../../host/__tests__/entrypoint-graphify-mcp.test.js)

**Status:** Implemented

---

### REQ-AGENT-024: Advanced-Session-Mode Graph-First Discipline

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh -->
<!-- @impl: preseed/agents/claude/rules/graph-first.md -->
<!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md -->
<!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md -->
<!-- @test: host/__tests__/entrypoint-graphify-hooks.test.js (entrypoint hook installation → AC1/AC7) -->
<!-- @test: host/__tests__/graphify-session-start.test.js (SessionStart three-tier fallback: god-nodes, GRAPH_REPORT preamble, build-suggestion → AC1) -->
<!-- @test: host/__tests__/graph-first-nudge.test.js (PreToolUse soft-nudge matcher set → AC7) -->
<!-- @test: host/__tests__/preseed-graphify-discipline.test.js (rule + SKILL preseeded in advanced only → AC2/AC3) -->
<!-- @test: host/__tests__/skill-graphify-content.test.js (SKILL contents → AC4/AC5/AC6) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-024 AC5-AC6: Pi graphify skill preserves durable graph artifacts in git) -->

**Intent:** In advanced session mode, the agent is taught to prefer the knowledge graph over Grep-style text search for structural questions, so token cost on architecture, dependency, and call-flow questions is bounded. This REQ covers the SessionStart context injection, the preseeded rule and SKILL surface, and the soft-nudge PreToolUse hook. Graph-first discipline is advisory only: there is no hard-block enforcement. The `/graphify` build dispatch lives in [REQ-AGENT-043](#req-agent-043-graphify-build-mode-dispatch).

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a SessionStart hook queries the knowledge graph for the highest-connectivity nodes and injects a compressed structural summary as additionalContext. Three fallback tiers: (a) god-nodes query producing node labels with degree counts, (b) GRAPH_REPORT.md preamble when the query fails, (c) build-suggestion reminder when the cwd has source files but no graph.
2. In advanced session mode only, a short authoritative graph-first rule is preseeded, stating MUST / MUST NOT bullets for graph vs grep and routing to the graphify skill for mechanics rather than restating them.
3. In advanced session mode only, the graphify skill is preseeded for Claude Code, with per-agent adapted variants emitted for Codex, Copilot, OpenCode, and Antigravity by the seed generator.
4. The skill documents the safe build path for large repos (more than 2000 files).
5. The skill instructs the agent on first build to add canonical ignore and attribute rules so regenerable graph build outputs and working-tree intermediates are not committed while the queryable graph remains under git merge control.
6. The committed knowledge-graph surface includes the queryable graph artefact, a human-readable report, a visual exploration page, the generated `callflow.html`, `.graphify_labels.json`, and an optional wiki tree.
7. In advanced session mode only, a soft-nudge hook fires on grep-class tool calls and emits a reminder to prefer the graph MCP tools when a graph exists for the cwd; the hook never blocks.

**Constraints:**

- The SessionStart hook never auto-builds a graph. It only injects context when one exists or a build suggestion when source files are present without one.
- The soft-nudge hook never blocks; semantic judgment of whether a single grep is appropriate cannot be reliably made up-front. Graph-first discipline is advisory only (the preseeded rule plus the per-call nudge); a previous count-based hard-block was removed because it misfired on legitimate single-file searches the graph-first rule itself excludes.
- The soft-nudge matcher set covers both the non-ctx tool surface (`Grep`/`Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`/`mcp__context-mode__ctx_batch_execute`) because the context-mode enforcement hook denies `Grep`/`Glob`/`Read` in custom-tier sessions.

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** [Automated test](../../host/__tests__/entrypoint-graphify-hooks.test.js)

**Status:** Implemented

---

### REQ-AGENT-043: Graphify Build Mode Dispatch

<!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md -->
<!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md -->
<!-- @test: host/__tests__/skill-graphify-content.test.js (graphify SKILL.md content (REQ-AGENT-024 AC4-AC6, REQ-AGENT-026) / REQ-AGENT-043 (build mode dispatch) → AC5) + src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-043 Pi graphify skill override avoids headless semantic extraction and routes uncached Full mode files to Pi Agent subagents -> AC7) -->

**Intent:** Before a `/graphify` build dispatches extraction work, the user must explicitly choose whether to build a graph and which scope to build. Claude keeps the upstream AST-only vs Full semantic choice. Pi offers Architecture graph, Full repo AST-only, Full repo semantic, or no graph update. In Pi, uncached semantic extraction must use running-session Pi `Agent` subagents that inherit the current main-session model; community labels are written by the active Pi main session to `.graphify_labels.json`; official Graphify CLI/module flows own AST extraction, cache merge, graph build, clustering, report generation, and visualization, while label application regenerates report/html from existing graph community assignments.

**Applies To:** Agent

**Acceptance Criteria:**

1. Before dispatching semantic-extraction subagents in a Claude `/graphify` build (Step B2 of the upstream protocol), the agent presents an `AskUserQuestion` with exactly two modes: AST-only (free, structural edges only) and Full (AST plus parallel semantic-extraction subagents processing docs/papers/images). The Full option includes the actual subagent count and a wall-time estimate. <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::AskUserQuestion --> <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::uncached_doc_paper_files -->
2. In Pi, after detection, the graph refresh choice offers Architecture graph, Full repo AST-only, Full repo semantic, and an explicit no-graph option that stops without modifying `graphify-out`. <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::Architecture --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::graphify-out -->
3. Clone-time AST-only and no-graph choices suppress the duplicate post-detection mode question; clone-time Full semantic is intent only, and the agent must show the actual uncached file/subagent counts after detection and get confirmation before dispatching semantic subagents. <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::uncached --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::uncached -->
4. The semantic option is hidden when the corpus contains zero docs/papers/images; code-only repos still offer the Pi Architecture graph, Full repo AST-only, and no-graph options.
5. In advanced session mode only, Claude Code Part B semantic subagents use the Claude graphify skill's configured reliable extraction model, while Pi Part B semantic subagents omit `model` overrides so they inherit the current main-session model. Claude's graphify skill never escalates to Opus from this workflow, and Pi's native graphify skill does not name or pin any provider-specific model.
6. The Part C merge step preserves all data structures produced by Part B subagents - including hyperedges - by saving subagent chunks into Graphify's semantic cache before official Graphify extraction/build consumes the cache.
7. Pi's native graphify skill does not instruct the agent to run headless semantic extraction or Graphify provider labeling. Architecture mode uses the Pi-owned module-graph script, AST-only initial build uses the Pi-owned first-build script built from Graphify's own modules, AST-only refresh uses the bounded upstream-update wrapper, Full mode uses Pi `Agent` subagents for uncached semantic chunks, the Pi main session writes community labels into `.graphify_labels.json`, and local Graphify module calls regenerate the final report/html from existing graph community assignments. Full semantic merge starts from a freshly recreated AST-only baseline and must not pass semantic source files as `prune_sources`, because Graphify prunes after adding. The final user-facing `graphify-out/graph.html` and `graphify-out/callflow.html` are generated after labels are applied.

**Constraints:**

- Claude Code's graphify skill owns Claude-specific extraction model selection. Pi's graphify skill must remain provider/model agnostic unless the user explicitly requests a model override.

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** [Automated test](../../host/__tests__/skill-graphify-content.test.js)

**Status:** Implemented

<!-- coverage-gap: AC1-AC4 (interactive build-mode AskUserQuestion dialog and hidden semantic option) and AC6 (Part C merge preserves all Part B fields including hyperedges) are agent-behavioral and verified by manual check, not automatable in the Workers vitest pool. AC5 is verified by the SKILL.md content test; AC7 is covered by the Pi seed/skill invariant test. -->

---

### REQ-AGENT-025: Post-Clone Graph Triage

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh -->
<!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts -->
<!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts -->
<!-- @test: host/__tests__/graphify-clone-prompt.test.js (clone-detect + graph-present/absent branch + idempotency marker → AC1/AC3-AC7) + src/__tests__/lib/agent-seed-manifest.test.ts (Pi graphify clone triage helper + durable review-lane suppression -> AC2/AC4-AC7) -->

**Intent:** After the agent clones a repo, it must triage whether to build (or refresh) a knowledge graph for it before doing other work, so users on unfamiliar repos do not start cold.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a PostToolUse hook on `Bash` and `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute` matchers detects real `git clone` and `gh repo clone` invocations using anchored token parsing that rejects quoted or echoed false positives. For Pi, clone detection extracts command text shell-only (`shellCommandText`: Bash `.command`, `ctx_execute` `.code` only when `language === "shell"`, `ctx_batch_execute` `.commands[].command`), excluding non-shell `ctx_execute` bodies so a source literal cannot false-fire the prompt; the clone regex consumes a shared env-var prefix (`ENV_PREFIX`: zero or more `VAR=value` assignments and an optional `env` wrapper before the verb) so `BROWSER="" gh repo clone`, `GIT_TERMINAL_PROMPT=0 git clone`, and `env BROWSER="" gh repo clone` all trigger. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh::COMMAND --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::isGitClone --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::shellCommandText --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::ENV_PREFIX --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::cloneTargetPath -->
2. Pi implements clone triage with native tool lifecycle events and Pi follow-up messages. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::graphifyClonePromptDecision -->
3. Clone destination resolution prefers the tool result's `Cloning into '...'` line before falling back to command parsing, so shell variables such as `$repo` never surface as literal user-facing paths. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::cloneTargetPath -->
4. When `<cloned-dir>/graphify-out/graph.json` is absent, the directive asks which graph action the user wants before any graph work, offering Full repo AST-only, Full repo semantic intent, or no graph action. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::renderGraphifyCloneDirective -->
5. When `<cloned-dir>/graphify-out/graph.json` exists, fresh graphs are used as-is (information message only); a stale graph (built at a commit other than HEAD) opens the directive with an explicit STALE warning before the choices, while an unknown-freshness graph asks without the stale flag — all offering existing-graph-as-is, Full repo AST-only update, or Full repo semantic refresh intent. Freshness and on-disk existence are resolved at clone-event time via `exists`/`freshness` callbacks. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::existingGraphCloneNotice --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::renderGraphifyCloneDirective --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::graphifyClonePromptDecision -->
6. The bounded upstream-update wrapper runs only after the user chooses AST-only, and Full semantic build/refresh must pass through graphify skill detection plus post-detection count confirmation before semantic subagents dispatch. <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::Clone-time triage --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::Mandatory graph refresh choice -->
7. The hook is idempotent per cloned directory per session via a marker key that includes both the session identifier and cloned repository path; Pi clone triage suppresses follow-up prompts for failed clone commands, skipped/already-cloned targets, and durable PR-boundary review lanes. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::shouldHandleClonePrompt -->

**Constraints:**

- The hook never invokes graphify directly and never authorizes an automatic update. It only injects a directive instructing the agent to ask for the user's graph-action choice before building or refreshing; a same-turn clone-time AST-only/no-graph choice counts as the graphify skill's mode choice after detection, while clone-time Full semantic remains intent until post-detection count confirmation.

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** [Clone prompt hook tests](../../host/__tests__/graphify-clone-prompt.test.js) and [Pi clone triage helper tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-026: Knowledge-Graph Persistence via Git

<!-- @impl: entrypoint.sh -->
<!-- @impl: Dockerfile -->
<!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md -->
<!-- @test: host/__tests__/entrypoint-graphify-bisync.test.js (rclone bisync excludes **/graphify-out/** → AC1) -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (global merge driver registration → AC2) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-024 AC5-AC6: Pi graphify skill preserves durable graph artifacts in git) -->

**Intent:** Graphify artifacts persist with the repository, not with the user, so contributors on a clone inherit the graph for free and Codeflare's R2 bisync does not carry per-repo graph data.

**Applies To:** Agent

**Acceptance Criteria:**

1. Knowledge-graph artefacts are excluded from R2 sync, so they never round-trip through user-bucket storage.
2. The container image registers the graphify semantic merge driver globally, independent of session mode.
3. Repo owners with push permission commit the knowledge-graph artefacts to git so contributors inherit the graph and the visualization on clone; concurrent edits to the graph artefact are auto-resolved by the registered merge driver without manual JSON conflict resolution.
4. For repos without push permission, the graph lives in the working tree only and is ephemeral.

**Constraints:**

- Per-repo ignore and merge-attribute wiring is the responsibility of the graphify skill ([REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline) AC5); this REQ covers only the platform-level pieces (sync exclusion, global merge-driver registration).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** [Automated test](../../host/__tests__/entrypoint-graphify-bisync.test.js)

**Status:** Implemented

---

### REQ-AGENT-027: Context-Mode Interoperability

<!-- @impl: preseed/agents/claude/plugins/context-mode -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh -->
<!-- @test: host/__tests__/graph-first-nudge.test.js (soft-nudge fires on ctx_search/ctx_batch_execute → AC2) + src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-027 AC1 context-mode wired as a tool only describe → no enforce-ctx-mode deny-gate is preseeded in any seeded config) + host/__tests__/entrypoint-enforce-ctx-mode-dedup.test.js (managed-hooks prune regex strips stale deny-gate → AC1 runtime stale-gate pruning) -->

**Intent:** When the context-mode plugin is preseeded, the graphify CLI must coexist with context-mode and the graph-first soft-nudge must reach the agent through context-mode's redirected tool-call path.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the context-mode plugin is preseeded (effectiveTier `unlimited` plus advanced session mode), `graphify update .` and `graphify query ...` run unimpeded: context-mode is wired as a tool only (MCP server plus the indexing PreToolUse/PostToolUse hooks), with no Bash deny-gate, so no command-routing whitelist is needed. Any stale `enforce-ctx-mode.sh` deny-gate left in a pre-existing `settings.json` is stripped on container start by the managed-hooks prune regex.
2. The [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline) AC7 PreToolUse soft-nudge hook registers both the non-ctx matchers (`Grep`, `Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`, `mcp__context-mode__ctx_batch_execute`) so the nudge fires in both tier paths.

**Constraints:**

- Graphify must not depend on context-mode at runtime. `/graphify` extraction uses upstream graphify's subagent-chunking model; context-mode, when present, provides bonus per-subagent token routing via its existing `Read|Grep|Glob|Agent` PreToolUse matchers, but is not a precondition.

**Priority:** P2

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** [Soft-nudge test](../../host/__tests__/graph-first-nudge.test.js) (AC2) and [agent-seed manifest test](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1: no `enforce-ctx-mode` deny-gate is preseeded in any seeded config, so context-mode ships as a tool with no command deny-gate). The stale-gate pruning AC1 relies on at runtime is additionally covered by [the settings.json hook-merge dedup test](../../host/__tests__/entrypoint-enforce-ctx-mode-dedup.test.js).

**Status:** Implemented

---

### REQ-AGENT-032: Starter Documentation Manually Recreatable from Settings

<!-- @impl: src/routes/storage/seed.ts -->
<!-- @test: src/__tests__/routes/storage-seed.test.ts (Storage Seed Routes describe -> AC1 POST /api/storage/seed/getting-started recreate + AC3 storage-stats KV cache invalidation) -->

**Intent:** Users must be able to reset the starter "getting-started" docs to the platform defaults at any time, in case they deleted them while exploring or want to see updates that shipped after their original session.

**Applies To:** User

**Acceptance Criteria:**

1. "Recreate starter documentation" button triggers `POST /api/storage/seed/getting-started`.
2. The endpoint is rate-limited (3/min).
3. After seeding, the storage stats KV cache is invalidated.

**Constraints:**

- The starter docs are the welcome / getting-started pages; user-authored documentation under other paths is never touched.

**Priority:** P1

**Dependencies:** [REQ-STOR-009](storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session)

**Verification:** [Automated test](../../src/__tests__/routes/storage-seed.test.ts)

**Status:** Implemented

---

### REQ-AGENT-031: consult-llm Key Isolation, Subscription Backend, and Multi-Agent Parity

<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe → AC1 CODEFLARE_-namespaced injection + bare-name regression + AC6 enterprise no-inject) -->
<!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration describe → AC2 scoped env mapping + AC3 codex-cli/API backend selection + AC4 Pi directTools + AC6 enterprise gate) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (consult-llm available to Claude and Pi only → AC4; REQ-AGENT-031 consult-llm invocation behaviour describe → AC5 five-choice model dialog + selectors) -->
<!-- @test: src/__tests__/routes/llm-keys.test.ts (enterprise mode describe → AC6 403 on GET/PUT/DELETE) -->

**Intent:** Stored LLM API keys must reach the `consult-llm-mcp` MCP server WITHOUT leaking into the coding agents' general environment (where the latest Pi/opencode/antigravity auto-detect them as their own provider credentials and silently drain the user's API account), must prefer the user's subscription over per-call API billing, and must be available identically to Claude Code and Pi — while being entirely absent in enterprise mode, where models route through the managed AI Gateway BYOK.

**Applies To:** User

**Acceptance Criteria:**

1. LLM provider keys are injected into the container ONLY under a `CODEFLARE_`-namespaced name (`CODEFLARE_OPENAI_API_KEY` / `CODEFLARE_GEMINI_API_KEY`); the bare `OPENAI_API_KEY` / `GEMINI_API_KEY` names NEVER appear in the container's global environment. Keys are read fresh from KV on each container start and are not persisted in DO storage. <!-- @impl: src/container/container-env.ts::buildEnvVars -->
2. The entrypoint maps the namespaced keys back to the standard `OPENAI_API_KEY` / `GEMINI_API_KEY` names ONLY inside the `consult-llm-mcp` MCP server's scoped `env` block (in `~/.claude.json` and `~/.pi/agent/mcp.json`), never as a global export. <!-- @impl: entrypoint.sh -->
3. Per provider the entrypoint prefers the subscription over the API key: OpenAI uses the Codex CLI backend (`CONSULT_LLM_OPENAI_BACKEND=codex-cli`, `CONSULT_LLM_CODEX_REASONING_EFFORT=high`) when the user is logged into Codex (`~/.codex/auth.json` present), passing the API key only as a fallback; otherwise it uses the API key. Gemini always uses the API key. When no provider is usable, no MCP server is written. <!-- @impl: entrypoint.sh -->
4. The `consult-llm` tooling is available to Claude Code AND Pi only: Claude reads it from `~/.claude.json`; Pi reads `~/.pi/agent/mcp.json` with `directTools:["consult_llm"]` promoting it to a first-class tool, and is seeded a native Pi `consult-llm` skill. The Pi server sets `lifecycle:"keep-alive"` so pi-mcp-adapter connects it on startup and auto-reconnects rather than lapsing to a `0/1 servers … cached` footer after the default idle timeout; the Claude server carries no `lifecycle` field (a pi-mcp-adapter-only concept). No other agent (codex/opencode/antigravity) receives the skill or the server. <!-- @impl: entrypoint.sh --> <!-- @impl: preseed/agents/pi/manifest.json -->
5. When the user invokes the consult-llm skill without naming a model, the agent shows a single-select dialog (`AskUserQuestion` on Claude, `ask_user_question` on Pi) of four explicit choices plus the tool's automatic "Other" write-in (five total): latest Google/Gemini, latest OpenAI/GPT, both, and "list all available models". For "list all available models" the skill surfaces **concrete** model IDs, never the bare provider selectors: consult-llm-mcp (v2.13.x) exposes no model-list tool and no schema enum (the concrete IDs were deliberately replaced by selectors), so the skill reads the latest `AVAILABLE MODELS:` block from the server startup log (`~/.local/state/consult-llm-mcp/mcp.log`), keeps only Gemini (`gemini-*`) and OpenAI (`gpt-*`) IDs, and falls back to clearly-labelled selectors only when the log is unreadable. "Latest" is resolved by the server-side `"openai"` / `"gemini"` model selectors — the skill never hardcodes a flagship ID and never performs a live provider model-list fetch with the raw key. When the user names a specific model, no dialog is shown and that exact ID is passed. <!-- @impl: preseed/agents/claude/skills/consult-llm/SKILL.md --> <!-- @impl: preseed/agents/pi/skills/consult-llm/SKILL.md -->
6. In enterprise mode the entire LLM-keys-and-consult-llm surface is unavailable: the keys are not injected (AC1 suppressed), the `/api/llm-keys` routes return 403 on every method, the Settings "LLM API Keys" section is hidden, and the entrypoint writes no consult-llm MCP config and removes any seeded `consult-llm` skill dirs for both Claude and Pi. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/routes/llm-keys.ts --> <!-- @impl: web-ui/src/components/SettingsPanel.tsx --> <!-- @impl: entrypoint.sh -->

**Constraints:**

- The container reads keys at start and on restart; mid-session key changes take effect only after the next session start.
- AC5 is skill-directed agent behaviour; the consult-llm SKILL.md files (Claude + Pi) are the implementation surface and are verified by asserting their bundled-seed content (the five-choice dialog mandate, the `"openai"`/`"gemini"` selectors, the absence of any provider model-list curl, and the "list all" path reading concrete IDs from the server startup log rather than presenting provider selectors as the model list).
- The consult-llm MCP config is wrapped in a shell function invoked with `|| echo WARNING` so a jq/IO failure can never abort the entrypoint before the init-complete flag (a crash-loop class bug).

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** [Container-env test](../../src/__tests__/container/container-env.test.ts) (AC1/AC6), [entrypoint consult-llm host test](../../host/__tests__/entrypoint-consult-llm.test.js) (AC2/AC3/AC4/AC6), [agent-seed manifest test](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC4/AC5), and [LLM keys route test](../../src/__tests__/routes/llm-keys.test.ts) (AC6 enterprise 403).

**Status:** Implemented

---

### REQ-AGENT-030: Multi-Agent Format Transforms

<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe → per-agent frontmatter + model removal + path rewrites + .agent.md → AC1-AC5) -->

**Intent:** Each non-Claude agent has its own config-file conventions (frontmatter shape, model-field presence, path layout, file extensions). The generator must apply the right per-agent transform so the adapted config is valid for the consumer.

**Applies To:** User

**Acceptance Criteria:**

1. Agent definitions use correct frontmatter format per agent (e.g., `tools` as record `{read: true}` for OpenCode, as array or comma-separated names according to the target schema).
2. `model` field is removed from frontmatter for non-CC agents where the target runtime resolves model selection independently.
3. Path references (e.g., `~/.claude/`) are replaced with agent-specific config paths, including Pi's `.pi/agent/agents/` subagent path.
4. File extensions match agent conventions (e.g., `.agent.md` for Copilot agents and `.md` for Pi subagents).
5. Pi subagent transforms emit Pi-compatible frontmatter for tools, prompt mode, extension/skill inheritance, context inheritance, and background defaults.

**Constraints:**

- Format transforms are derived from each agent's documented config schema; missing schema means the agent is unsupported, not silently passed through.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-029: Deploy Credential Propagation to Container

<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe → GH_TOKEN + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID injection → AC1-AC4) -->

**Intent:** Stored deploy credentials must reach the container as environment variables and be consumed by git, wrangler, and the Cloudflare API auto-fetch step, so the in-container agent can push code and deploy without re-authentication.

**Applies To:** User

**Acceptance Criteria:**

1. Stored GitHub and Cloudflare deploy credentials are injected into the container as environment variables on session start. <!-- @impl: src/container/container-env.ts::buildEnvVars -->
2. Credentials are sent as explicit `null` when absent (not omitted) so revocation propagates on session restart. <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart -->
3. When a GitHub credential is present, the container configures git for authenticated HTTPS access.
4. The Cloudflare account ID is resolved automatically from the API token when one is stored, so users need not supply it separately.

**Constraints:**

- Misconfigured Copilot scope can cause silent agent auth failure; full Copilot support requires the Advanced tier (see [REQ-AGENT-028](#req-agent-028-deploy-credential-token-creation-ux)).

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** [Automated test](../../src/__tests__/container/container-env.test.ts)

**Status:** Implemented

---

### REQ-AGENT-028: Deploy Credential Token-Creation UX

<!-- @impl: web-ui/src/components/settings/ProviderRow.tsx -->
<!-- @test: web-ui/src/__tests__/lib/token-scopes.test.ts (GITHUB_TIERS + getGithubTokenUrl describes -> AC1 three-tier GitHub scope selector; CLOUDFLARE_TIERS + getCloudflareTokenUrl describes -> AC2 three-tier Cloudflare scope selector with 7/10/22 scope counts) -->

**Intent:** Token creation for GitHub and Cloudflare must guide users through scope selection so they create the smallest token that still unlocks the features they need, without copy-pasting raw scope strings.

**Applies To:** User

**Acceptance Criteria:**

1. GitHub token creation offers three scope tiers (Minimal, Recommended, Advanced) via a selector in the connect flow, with Recommended pre-selected and the URL pre-filling the correct scopes per tier. <!-- @impl: web-ui/src/lib/token-scopes.ts::GITHUB_TIERS --> <!-- @impl: web-ui/src/lib/token-scopes.ts::getGithubTokenUrl -->
2. Cloudflare token creation offers three scope tiers (Minimal, Recommended, Advanced) via the same selector pattern, with Recommended pre-selected and the URL pre-filling the correct permission group keys per tier. <!-- @impl: web-ui/src/lib/token-scopes.ts::CLOUDFLARE_TIERS --> <!-- @impl: web-ui/src/lib/token-scopes.ts::getCloudflareTokenUrl -->
3. A documentation page lists all scopes per tier with explanations of why each is needed, linked from the UI via "See all scopes". <!-- @impl: web-ui/src/lib/token-scopes.ts::SCOPES_DOCS_URL -->

**Constraints:**

- GitHub Minimal: 1 scope (contents). Recommended: 6 scopes (contents, PRs, actions, workflows, administration, secrets). Advanced: all 19 scopes including Copilot.
- Cloudflare Minimal: 7 scopes (Workers Scripts, KV, R2, D1, Routes, Account Settings read, Zone read). Recommended: 10 scopes (Minimal + DNS, Access Apps+Policies, Access Orgs+IdPs). Advanced: 22 scopes (Recommended + Pages, Containers, API Tokens, Queues, AI read+write, Vectorize, Turnstile, Builds, Observability, R2 Data Catalog, Agents).

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-019](#req-agent-019-branded-settings-ui)

**Verification:** [Token scope tests](../../web-ui/src/__tests__/lib/token-scopes.test.ts)

**Status:** Implemented
