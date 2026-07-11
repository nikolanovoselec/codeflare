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

### REQ-AGENT-001: Support Multiple AI Coding Agents

**Intent:** The platform must support multiple AI coding agents so users can choose the tool that fits their workflow.

**Applies To:** User

**Acceptance Criteria:**

1. Seven agent types are defined: `claude-code`, `codex`, `copilot`, `antigravity`, `opencode`, `pi`, `bash`. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/lib/agent-config.test.ts (AGENT_COMMANDS exhaustiveness / REQ-AGENT-001 AC1/AC2 (seven agent types: claude-code, codex, copilot, antigravity, opencode, pi, bash; enforced via AgentTypeSchema)) -->
2. The `AgentType` type is enforced via Zod schema (`AgentTypeSchema`). <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/lib/agent-config.test.ts (AGENT_COMMANDS exhaustiveness / REQ-AGENT-001 AC1/AC2 (seven agent types: claude-code, codex, copilot, antigravity, opencode, pi, bash; enforced via AgentTypeSchema)) -->
3. Each agent's CLI is pre-installed in the container image as a global npm package or native binary. <!-- @impl: Dockerfile::npm -->
4. Of the Node.js-based agent CLIs, only Pi is pre-warmed at image build time; Codex and Copilot pay the compile cost on first launch. <!-- @impl: Dockerfile::NODE_COMPILE_CACHE -->
5. Pi extension npm dependencies are available from the image cache without overwriting restored user package metadata. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-001: Pi npm warm cache seeds dependencies without overwriting user package metadata) -->
6. The image build fails if the pre-warmed Pi SDK cannot be pinned to the resolved runtime-agent version. <!-- @impl: Dockerfile::INSTALLED_PI_VER -->
7. The image build verifies that Claude Code can start. <!-- @impl: Dockerfile::claude -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Agent CLI versions are installed via `@latest` at build time; versions may drift between deploys.
- Major version jumps between deploys have caused regressions; monitoring is required after deploys.

**Priority:** P0

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-002: Agent Selection at Session Creation

**Intent:** Users must be able to choose which AI agent to use when creating a session.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/sessions` accepts an optional `agentType` field in the request body. <!-- @impl: src/routes/session/crud.ts::UpdateSessionBody --> <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 AC2: POST /api/sessions accepts all seven valid agent types) -->
2. Invalid agent types are rejected at session creation. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 AC2: POST /api/sessions accepts all seven valid agent types) -->
3. The selected agent type is persisted in the session record. <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002: Agent Selection at Session Creation) -->
4. The UI defaults to the agent type used in the user's most recent session. <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002: Agent Selection at Session Creation) -->
5. When `agentType` is not specified, it defaults to `claude-code`. <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002: Agent Selection at Session Creation) -->
6. The session-creation UI renders a `beta` badge on agents in preview status: `antigravity` and `opencode` carry the badge; all other agents (Claude Code, Codex, Copilot, Pi, Bash) render without one. <!-- @impl: web-ui/src/components/CreateSessionDialog.tsx::CreateSessionDialog --> <!-- @test: web-ui/src/__tests__/components/CreateSessionDialog.test.tsx (Agent type selection) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Agent type is immutable after session creation (a new session is required to switch agents).
- The `bash` agent type provides a plain terminal without an AI agent.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-003: Agent CLI Auto-Started in Tab 1

**Intent:** When a session starts, the selected agent's CLI must be running and ready in the first terminal tab without manual user intervention.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint configures the selected agent's launch command to run automatically when tab 1's shell starts. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC1 dynamic: an agy (Antigravity) tab emits its launch command into .bashrc) -->
2. Claude Code starts in permissions-bypass mode appropriate for an isolated sandbox container. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC1+AC2+AC4: default layout writes the claude --dangerously-skip-permissions launch line + hardened PATH into .bashrc) -->
3. User-opened tabs beyond tab 1 do not auto-start an agent. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC3: generated .bashrc guards autostart with the MANUAL_TAB skip branch) -->
4. The agent CLI is findable on the system PATH in all terminal sessions. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/prewarm-readiness.test.js (when tab 1 has a command / REQ-AGENT-003 (agent CLI auto-started in tab 1) / REQ-TERM-005 (pre-warm pty)) -->
5. Pre-warm readiness is detected by first PTY output (any terminal output means the agent is ready). <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig --> <!-- @test: host/__tests__/prewarm-readiness.test.js (when tab 1 has a command / REQ-AGENT-003 (agent CLI auto-started in tab 1) / REQ-TERM-005 (pre-warm pty)) -->
6. A 20-second hard timeout exists as a safety net if the PTY produces no output. <!-- @impl: host/src/prewarm-config.ts::getPrewarmConfig -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Auto-update checks for agent CLIs are suppressed at session start to keep startup latency low.
- Each agent has its own mechanism for suppressing auto-updates.
- The autostart command must complete after the initial R2 sync but before bisync baseline to avoid hash mismatches.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](#req-agent-002-agent-selection-at-session-creation), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-004: Two Session Modes: Standard and Pro

**Intent:** Users must be able to choose between a Standard mode (essential configs) and a Pro (Advanced) mode (full agent enhancement suite).

**Applies To:** User

**Acceptance Criteria:**

1. Session mode (Standard or Pro) is stored durably in the user's preferences record; the value is absent for users who have never expressed a preference. <!-- @test: src/__tests__/lib/session-mode.test.ts (clampSessionModeToTier / REQ-SEC-015 (AC2 clamp at container start + AC3 canceled-user stale advanced => default)) -->
2. A single resolver provides the default-to-Standard fallback when no preference is recorded; all callers read through the resolver rather than checking the raw field directly. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)) -->
3. Mode selection is available in Settings under the session-defaults area. <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (REQ-AGENT-004 AC3: mode selection in Settings session-defaults) -->
4. Mode takes effect on any of: explicit "Recreate AI agent skills & rules" action, new bucket creation, payment-provider mode change (upgrade or downgrade via webhook), subscription termination, or Settings toggle of the session-mode preference. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC4: overwrite:true writes all docs regardless of existing state (recreate button)) -->
5. On webhook-driven or Settings-driven reconciliation, preseed files are overwritten to match the new mode; user-created files are never deleted (see [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) Constraints). <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC5: cleanup:true deletes advanced-only keys when switching to default mode) -->
6. Reconciliation triggered by webhooks or Settings is non-fatal: failure does not block the webhook response or the preference write. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC6: reconcileAgentConfigs is non-fatal when DELETE calls fail) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Only tiers whose allowed-session-modes list includes Pro can use Pro mode (see [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)).
- When a user is promoted to a Pro-eligible tier, Pro mode becomes their persisted default if they had not already selected a mode.

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-005: Pro Mode Includes Additional Skills, Rules, Agents, and MCP Servers

**Intent:** Pro mode must provide a significantly enhanced agent experience over Standard - more rules, skills, agent definitions, commands, hooks, and persistent memory. Pi sessions remain fully functional whether or not context-mode is active. Pi's own default runtime behavior — context-mode enablement and tool-extension defaults — is specified separately in [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode delivers a strict superset of Standard mode's content — memory persistence, language rules, agent definitions, slash commands, skills, the spec/docs/tests discipline triad, and commit-attribution/PR-boundary review hooks. The per-content-category matrix lives in [documentation/preseed.md](../../documentation/lanes/architecture.md#preseed-session-modes). <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode) -->
2. Pro mode enables persistent memory by including the user's Vault directory tree in the R2 sync filters so it syncs to their bucket; Standard mode excludes the Vault tree, so memory does not persist across container restarts. The legacy `.memory/` directory is no longer written. <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 AC2: getConfigsForMode("advanced") returns docs for both default and advanced modes) -->
3. Pro-mode hooks fire uniformly regardless of tool surface — Custom tier routes commands through context-mode, other tiers run them directly — so commit attribution, the PR-boundary SDD review trigger, the unreviewed-PR turn-block, and prompt-cadence memory capture all fire identically on both paths. <!-- @impl: entrypoint.sh::CONTEXT_MODE_MANIFEST --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode) -->
4. Pi agents remain fully functional whether or not context-mode is active: native Bash/Read/Grep/Find/Edit/Write plus graphify tools suffice alone. Agent definitions declare context-mode helpers under Pi-native names (`ctx_execute`, `ctx_batch_execute`, `ctx_execute_file`, `ctx_search`, `ctx_fetch_and_index`) in frontmatter. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::commandText --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005: Pi agents keep context-mode tool declarations (inert when off); enforcement extension is removed) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Cleanup on mode switch is scoped strictly to preseed-managed content; user-created files are never deleted.

**Priority:** P1

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-006: Preseed Configs Generated from Single Source of Truth

**Intent:** All agent configurations must be derived from the Claude Code preseed to prevent divergence and eliminate duplicate maintenance.

**Applies To:** User

**Acceptance Criteria:**

1. All preseed source files live in a single source tree organized by type (rules, agents, commands, skills, plugins). <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. A declarative manifest maps each preseed file to its applicable session modes (default, advanced, or both). <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
3. A build-time seed generator reads the manifest and source files, producing the runtime payload the Worker ships to the container. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
4. The generator is manifest-driven; files not in the manifest are ignored. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
5. No duplicate preseed source files exist on disk. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
6. The generator produces output for all supported agents (Claude Code as the source-of-truth lane plus adapted lanes for Codex, Copilot, OpenCode, Antigravity, and Pi). <!-- @impl: scripts/generate-agent-seed.mjs::AGENT_CONFIGS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. Shared operational rules, including git review-push gating and engineering work-continuity, are present in their Claude source rules and every adapted agent instruction file. <!-- @impl: scripts/generate-agent-seed.mjs::renderInstructionsFile --> <!-- @impl: src/lib/agent-seed.generated.ts::AGENTS_SEEDED_CONFIGS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The generated output must stay in sync with the manifest and sources; the build pipeline enforces this.
- The generated output is never hand-edited; updates go through the source tree and the generator.

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-007: Multi-Agent Adaptation Pipeline

**Intent:** Each supported agent must receive properly adapted configurations matching its specific config format, tool names, and file conventions.

**Applies To:** User

**Acceptance Criteria:**

1. Adapted configs are generated for all supported non-Claude agents from the Claude Code source. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. Tool names are remapped per agent (e.g., `Read` -> `read` for Codex and Pi). <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_SKILLS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Instructions are concatenated into a single file for agents that use monolithic config (Codex: `AGENTS.md`, Copilot: `copilot-instructions.md`, OpenCode: `AGENTS.md`, Antigravity: `.gemini/GEMINI.md`, Pi: `AGENTS.md`). <!-- @impl: scripts/generate-agent-seed.mjs::AGENT_CONFIGS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Claude Code keeps individual rule files in `~/.claude/rules/`, and Pi receives native runtime-adapter assets for Pi extension/package/MCP/subagent surfaces. <!-- @impl: scripts/generate-agent-seed.mjs::CLAUDE_ONLY_SKILLS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Hooks, commands, and plugins are excluded from generic transformed agents.
- `rules/memory.md` and `consult-llm` skill are excluded from non-CC agents (they depend on CC-specific MCP).
- Generic non-CC agents get a strictly-smaller config than Claude Code, since CC is the source-of-truth lane and those agents drop CC-specific content.
- Antigravity (`agy`) receives an adapted lane written to its global config directory `~/.gemini/`: rules concatenate into `~/.gemini/GEMINI.md`, skills into `~/.gemini/skills/`.
- The per-agent format transforms (frontmatter shape, removed fields, path rewrites, file extensions) live in [REQ-AGENT-030](#req-agent-030-multi-agent-format-transforms).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-008: Preseed Deployed to Container on Start

**Intent:** Preseed files must be available in the container's filesystem when the agent launches so that rules, skills, and agent definitions are active from the first prompt.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, mode-appropriate preseed files are written to the user's R2 bucket without overwriting any existing objects and without removing anything. <!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC4: overwrite:false skips existing R2 objects (new-bucket path)) -->
2. During container startup, the initial R2-to-local sync restores preseed files into each supported agent's per-user config directory before the agent launches. <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
3. The container entrypoint merges agent settings using a hooks-aware merge: non-hook fields use recursive merge; hook arrays are rebuilt per event type by preserving user-added hooks and replacing managed (codeflare-owned) hooks with the current platform version. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
4. In Pro mode, the settings merge includes the codeflare-owned hook registrations across the PreToolUse, PostToolUse, and UserPromptSubmit event families; Standard mode omits them. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
5. The container entrypoint enables the codeflare-managed plugins in the agent's plugin configuration permanently (not mode-gated). Missing plugin files are silently skipped so a plugin removal does not break agent startup. <!-- @impl: entrypoint.sh::ensure_graphify_cli_path --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->
6. Settings merge handles three cases: file doesn't exist (create), file exists (recursive merge), file malformed (skip with warning). <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- All file modifications must complete after initial sync but before bisync baseline so the baseline observes a stable snapshot.
- Plugin enablement is permanent.
- The managed-hook detector uses a codeflare-owned namespace prefix so unrelated workspace tools with identical script basenames cannot be falsely flagged as managed.
- The managed-hook surface set is the spec-side single source of truth; adding a new codeflare hook requires extending the detector or prior copies accumulate on every container boot instead of being replaced.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-009: LLM API Key Storage (Encrypted in KV)

**Intent:** Users must be able to store LLM provider API keys so that cross-model consultation features work without re-entering keys each session.

**Applies To:** User

**Acceptance Criteria:**

1. Users can store one or both supported LLM provider keys (OpenAI and Gemini) through a single management endpoint. <!-- @impl: src/routes/llm-keys.ts::validateOpenAIKey --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
2. The update interface supports three semantics per key: a new value replaces, an explicit null deletes, an absent field leaves the existing value unchanged. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
3. Keys are persisted in durable storage scoped to the user's bucket so two users cannot read each other's keys. <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
4. When platform-level credential encryption is configured, values are encrypted before persistence. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
5. Read responses return masked values (only the trailing characters are visible); the full key is never returned to the client. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Encryption follows the cryptographic contract in [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract).
- The ciphertext carries a version prefix so future schemes can be added without breaking reads.
- Plaintext values are transparently upgraded to encrypted on read when encryption is configured.
- Propagation to the container env + MCP wiring live in [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity).
- Unavailable in enterprise mode: every method on `/api/llm-keys` returns 403.

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)

**Intent:** Users must be able to store GitHub and Cloudflare credentials so that git push, repository management, and Cloudflare deployments work without re-authenticating each session.

**Applies To:** User

**Acceptance Criteria:**

1. Tokens are validated against the provider's own API before being stored, so an invalid or expired token is rejected up front rather than discovered at use time. <!-- @impl: src/routes/deploy-keys.ts::app --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
2. Read responses return masked tokens; the full value is never returned to the client. <!-- @impl: src/routes/deploy-keys.ts::app --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
3. Users can clear all stored deploy credentials in a single action. <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
4. Deploy credentials are persisted in durable storage scoped to the user's bucket and are encrypted at rest when platform-level credential encryption is configured. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Tokens are validated against the provider's API before being persisted; an unreachable provider is surfaced as an upstream error and the credential is not stored, so the store never contains a token of unknown validity.

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-011: Agent Skills & Rules Manually Recreatable from Settings

**Intent:** Users must be able to reset their agent skills and rules to the platform defaults at any time, recovering from accidental deletion or corruption.

**Applies To:** User

**Acceptance Criteria:**

1. A "Recreate AI agent skills & rules" action in the settings UI triggers a reseed of preseed-managed agent configuration. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->
2. The reseed performs a full overwrite-and-cleanup of all preseed-managed files for the user's current session mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
3. Overwrite replaces every preseed-managed file with the current default content. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->
4. Cleanup removes preseed-managed files that are not part of the user's current session mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
5. User-created files (files not generated by the preseed pipeline) are never overwritten or deleted. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
6. The endpoint is rate-limited (3/min). <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->
7. After seeding, the storage stats KV cache is invalidated. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Cleanup uses explicit key lists, not bucket listing or prefix scans.
- Partial delete failures produce warnings but do not fail the overall operation.
- Container must perform a bisync cycle to pull the updated R2 files into the local filesystem.
- Starter-documentation recreation lives in [REQ-AGENT-032](#req-agent-032-starter-documentation-manually-recreatable-from-settings).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-010](storage.md#req-stor-010-agent-configs-auto-seeded-based-on-session-mode)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-012: Fast CLI Start (Configurable)

**Intent:** Agent CLIs must start quickly by default, with an option for users who want automatic updates.

**Applies To:** User

**Acceptance Criteria:**

1. A fast-start preference (default: enabled) controls whether agent CLIs skip auto-update checks at launch, and the user's choice is propagated into the container's runtime environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) -->
2. When enabled, Codeflare applies the supported environment-based update suppressors before agent startup. <!-- @impl: entrypoint.sh::configure_fast_start_environment --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: Fast Start controls Pi update suppression and the disabled update path) -->
3. Codeflare removes only its own settings-file suppressor and preserves an operator-owned Codex version preference. <!-- @impl: entrypoint.sh::configure_fast_start_tool_settings --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: disabled Fast Start removes only Codeflare-managed settings suppressors) -->
4. When disabled, environment suppressors are cleared, Codeflare's Codex suppressor is removed, and Pi's normal update path runs before session startup. <!-- @impl: entrypoint.sh::configure_fast_start_environment --> <!-- @impl: entrypoint.sh::configure_fast_start_tool_settings --> <!-- @impl: entrypoint.sh::update_pi_when_fast_start_disabled --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: Fast Start controls Pi update suppression and the disabled update path) --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: disabled Fast Start removes only Codeflare-managed settings suppressors) -->
5. Users can toggle the preference from the session defaults area of the application settings. <!-- @test: src/__tests__/routes/preferences.test.ts (Preferences Routes) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Codex `~/.codex/` directory is excluded from sync, so `version.json` is safe to recreate on every start.
- Restored user-added Pi packages outside the Codeflare image cache may require Fast Start OFF once so Pi can reconcile package state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-013: Browser Shim for OAuth Flows

**Intent:** Agent CLIs that attempt to open a browser for OAuth must degrade gracefully to printing clickable URLs in the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. A browser-shim is installed in the container that intercepts browser-launch attempts and exits with a non-zero code, causing the calling CLI to fall back to plain-text URL output. <!-- @test: host/__tests__/dockerfile-browser-shim-behavior.test.js (Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)) -->
2. The XDG browser-launch entry-point is similarly shimmed so any tool that bypasses the BROWSER convention also degrades to text output. <!-- @test: host/__tests__/dockerfile-browser-shim-behavior.test.js (Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)) -->
3. CLIs fall back to printing auth URLs as plain text in the PTY when the browser fails to open. <!-- @test: host/__tests__/dockerfile-browser-shim-behavior.test.js (Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)) -->
4. The xterm.js link provider detects URLs in terminal output and makes them clickable, joining continuation rows for URLs that span multiple terminal rows so long OAuth URLs on narrow or mobile-keyboard-shrunk viewports are assembled and offered in full, never truncated mid-URL. <!-- @impl: web-ui/src/lib/terminal-link-provider.ts::registerMultiLineLinkProvider --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::getLastUrlFromBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal-url-detection.test.ts (joins a long OAuth URL whose tail wraps past the viewport edge (no truncation)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The shim must not block or hang; it must exit immediately with a non-zero code.
- All CLI tools that attempt browser-based OAuth (Claude Code, OpenCode, Antigravity) must be covered.
- The number of continuation rows joined per logical line is bounded by a fixed cap so the periodic buffer scan cannot walk an unbounded scrollback.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-014: Manifest-Driven Preseed Pipeline

**Intent:** The preseed system must use a declarative manifest to control which files are included, their mode assignments, and their target agents, ensuring auditable and reproducible builds.

**Applies To:** User

**Acceptance Criteria:**

1. A single declarative manifest is the source of truth for all preseed files and their session-mode assignments. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
2. The manifest organizes entries by type: rules (including the discipline triad: spec-discipline, documentation-discipline, tdd-discipline), agents, commands, skills (including SDD scaffolding templates), and plugins (memory and hook plugins). <!-- @impl: scripts/generate-agent-seed.mjs::CLAUDE_ONLY_SKILLS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Each entry declares the session modes (default, advanced, or both) it applies to. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
4. The seed generator is manifest-driven and ignores files not in the manifest. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. The generator produces a runtime payload the Worker consumes at session start. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. Within a single mode, no two preseed entries may share the same storage key. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
7. Variant-per-mode keys (same storage key, different content per mode) are excluded from cleanup when the mode changes. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-014 AC7: variant-per-mode keys excluded from cleanup (key exists in target mode)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- All preseed file additions, removals, and re-categorizations flow through the manifest.
- The generated output is a build artifact and is never hand-edited.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-015: /review command for multi-perspective codebase review

**Intent:** Comprehensive code review using specialized AI agents catches issues a single reviewer would miss.

**Applies To:** User

**Acceptance Criteria:**

1. `/review` launches 6 parallel specialist agents (security, architecture, code quality, dead code, test gaps, documentation), followed by a sequential Reality Filter pass that re-evaluates findings against repeat-offender, memory, cluster-aggregation, user-impact, and spec-vs-shipped questions.
2. Results cross-referenced and deduplicated.
3. Findings filtered against architecture decisions.
4. Optional LLM verification of HIGH/CRITICAL findings.
5. Interactive triage with fix/AD/defer/ignore options. Defer/Ignore/Tech-Debt decisions persist to `sdd/.review-decisions.md` so subsequent runs do not re-surface the same noise.
6. When `doc-updater` is invoked on a project with no `sdd/` or no `documentation/` surface (vibe-coding mode), it writes a one-line no-op header to its output file. <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
7. Findings reported in interactive triage are never auto-applied by `/review`; the user explicitly confirms each fix. The `auto` and `unleashed` modes that auto-apply spec/doc fixes are scoped to the PR-boundary review pipeline and `/sdd clean`, not to interactive `/review` invocations.

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- On Claude this workflow ships as the `commands/review.md` slash command; on Pi (where Claude slash commands do not deploy) the same workflow is delivered through the dedicated Pi-native `review` skill injected by the `/review` command handler, per [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill).

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-017: Bubblewrap sandbox for Codex

**Intent:** Codex agent runs in a bubblewrap sandbox for additional isolation within the container.

**Applies To:** User

**Acceptance Criteria:**

1. bubblewrap (bwrap) is installed in the container image. <!-- @impl: Dockerfile::bubblewrap -->
2. bubblewrap is available on the system PATH for Codex's built-in sandbox; the sandbox invocation is owned by the upstream Codex CLI, not by codeflare source. <!-- @impl: Dockerfile::bubblewrap -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-018: Push & Deploy credential management UI

**Intent:** Users connect their GitHub and Cloudflare accounts through a visual interface — OAuth, with no CLI commands and no manual token paste.

**Applies To:** User

**Acceptance Criteria:**

1. The Settings "Push & Deploy" accordion presents one shared OAuth connect card per provider (GitHub, Cloudflare) — the same composable card reused by the dashboard panel and Guided Setup ([REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise), [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)). <!-- @impl: web-ui/src/components/settings/DeployKeysSection.tsx::DeployKeysSection --> <!-- @test: web-ui/src/__tests__/components/settings/DeployKeysSection.test.tsx (DeployKeysSection (OAuth connect surface)) -->
2. Connecting runs the provider OAuth flow (no manual token entry); the per-user token is stored encrypted server-side and never reaches the browser, and disconnect revokes + clears it. <!-- @impl: src/routes/github.ts::REPOS_PER_PAGE --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
3. A connected card shows the account identity and (Cloudflare) an account picker; a scope tier can be selected before connecting. <!-- @impl: web-ui/src/components/connect/OAuthConnectCard.tsx::OAuthAccountOption --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (OAuthConnectCard) -->
4. Deploy credentials are propagated into the container environment so the agent CLIs can authenticate to GitHub and Cloudflare without additional configuration. <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Must comply with [CON-SEC-003](constraints.md#con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured)

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-019: Branded settings UI

**Intent:** Professional, intuitive settings panel for managing all user preferences and credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel uses accordion groups (appearance, session, deploy, LLM, admin). <!-- @impl: web-ui/src/components/SettingsPanel.tsx::ACCORDION_SUBTITLES --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (SettingsPanel Component / REQ-AGENT-019 (branded settings UI)) -->
2. Provider rows with SVG brand icons and inline expansion. <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (renders OpenAI and Gemini provider rows) -->
3. Appearance section with accent color picker. <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (SettingsPanel Component / REQ-AGENT-019 (branded settings UI)) -->
4. Session section with a session-mode toggle and a sleep-timeout select; agent type is chosen at session creation, not here. <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (SettingsPanel Component / REQ-AGENT-019 (branded settings UI)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-020: LLM API key management UI

**Intent:** Users can store their OpenAI and Gemini API keys through a visual interface.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel has LLM Keys section with masked password inputs for OpenAI and Gemini. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
2. Keys validated before saving. <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
3. Delete button clears all keys. <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
4. Keys displayed as masked (never shown in full after save). <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Must comply with [CON-SEC-003](constraints.md#con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured)
- Hidden in enterprise mode: the Settings "LLM API Keys" section is not rendered, matching the 403 backend gate (see [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity) AC6).

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-021: Pro-Mode SDD Workflow Preseed and Tool-Surface Portability

**Intent:** Pro users need the spec-driven-development workflow available out of the box, with every sub-command working through the native shell/file tools available in the active runtime so the workflow still works when context-mode is absent.

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode preseeds the `spec-driven-development` skill, the `sdd-init` and `sdd-clean` sub-command skills, the `vault-operations` skill, the `ci-monitoring` skill, the `/sdd` command, the `spec-discipline`, `documentation-discipline`, and `tdd-discipline` rules (loaded into every agent's instructions), and the `spec-reviewer` + `doc-updater` agents. <!-- @test: src/__tests__/lib/agent-seed-ecc-rules.test.ts (ECC rules in agent-seed) -->
2. Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works in Pi without context-mode by using native Bash/Read/Grep/Find/Write/Edit tools; context-management helper tools, when present in another runtime, are optional rather than required. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Large discovery commands use Pi-native discovery tools when context-mode is absent. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_COMPATIBILITY_NOTE --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-021: Pi has skills, native runtime extensions, and subagent definitions) -->
4. Pi-transformed SDD skills use Pi-native graphify tools and `Agent`/`Plan` terminology. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_COMPATIBILITY_NOTE --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-021: Pi has skills, native runtime extensions, and subagent definitions) -->
5. The native `/sdd` command enforces command-file hard gates before workflow dispatch. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::sddRepoState --> <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddCommandDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (native /sdd hard gates / REQ-AGENT-021 AC5 (the native /sdd command enforces command-file hard gates before workflow dispatch)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- CI-monitoring launch, reporting, and non-blocking wait policy lives in [REQ-AGENT-068](#req-agent-068-ci-monitoring-background-agent-policy).
- `/sdd init` scaffolding lives in [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render); enrichment lives in [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify).
- Phase 7a / 7b verifier gates live in [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) and [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate).
- PR-boundary review lives in [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions); `/sdd clean` rescue lives in [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes).

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-022: Legacy-codebase Import Mode Discovery

**Intent:** Enterprises migrating a legacy codebase from manual development to autonomous agentic development need a transition path that converts un-extracted intent into a real spec. `/sdd init` Import Mode runs discovery against the full project history and produces two outputs from the same pass: official REQs for behavior clear from that surface, and a triage queue for everything unclear. The triage entry shape, transition gate, and Status semantics live in [REQ-AGENT-045](#req-agent-045-import-mode-triage-queue-and-transition-state).

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` Import Mode emits two outputs simultaneously: spec REQs in `sdd/{domain}.md` for anything clearly determinable from the full discovery surface, and triage entries in `sdd/.init-triage.md` for anything unclear. <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh - SDD transition gate (REQ-AGENT-022)) -->
2. The discovery surface during Import Mode is the full project history, not just source code. <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh - SDD transition gate (REQ-AGENT-022)) -->
3. The agent pulls evidence from the working tree (README, configs, source, tests, inline comments, ADR-shaped files) and git history (commit messages on entry-point files, tag annotations).
4. When a GitHub remote is detected, the agent additionally pulls pull requests with their review comments and inline threads, issues open and closed with their comments, release notes, and the wiki via the GitHub API.
5. When one artifact references another ("Closes #142"), the agent follows the chain backward through every linked artifact rather than stopping at the first hit.
6. When the GitHub corpus is unreachable, the agent skips GitHub sources and proceeds with working-tree + git-log evidence only; a one-line notice naming the reason is printed before scaffolding and appended to the `sdd/changes.md` import entry. <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- GitHub-corpus evidence collection uses `gh pr list --state all`, `gh pr view {n} --comments`, `gh issue list --state all`, `gh issue view {n} --comments`, `gh release list`, and `gh release view {tag}`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-023: Knowledge-Graph Capability (Graphify)

**Intent:** Every container ships the graphify code-knowledge-graph capability as ambient infrastructure, so any session (default or advanced session mode) can query an existing graph or build a new one without per-tier provisioning.

**Applies To:** Agent

**Acceptance Criteria:**

1. `graphifyy` installs in every container image with MCP, SQL, and PDF extras, pinned to one tracked version; the entrypoint restores its command path when missing without replacing an existing destination. <!-- @impl: Dockerfile::graphifyy --> <!-- @impl: entrypoint.sh::ensure_graphify_cli_path --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-023: restores a missing Graphify CLI path without replacing an existing destination) -->
2. Claude receives the Graphify MCP server, while Pi receives native `graphify_query`/`graphify_path`/`graphify_explain` tools; both use the upstream engine. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::LazyGraph --> <!-- @impl: preseed/agents/pi/extensions/graphify-native.ts::graphify_query --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-023: Pi native runtime assets expose first-party graphify-native tools (no MCP, no third-party wrapper)) -->
3. AC1 and AC2 hold across all paid tiers for ambient query/build capability; advanced-mode agent orchestration keeps `/graphify` extraction context bounded via subagent chunking. <!-- @impl: Dockerfile::graphifyy --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::subagent --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Startup with no graph is tolerated: Claude starts empty and rebinds later; advanced-mode Pi clone triage asks before graph work. Query tools use the active repo graph after it exists. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::graphifyCloneAction --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::fallbackGraphifyToolResult --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. Advanced mode tracks the active repository; resolution walks up to the nearest Git repo or graph artefact and understands command-local `cd ... &&` plus `git -C ...` forms. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::effectivePathForCommand --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::updateActiveRepoFromPath --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) -->
6. When the active-repo signal is absent or stale, Pi graphify query tools fall back from the session cwd repo graph to the same-repo sentinel graph and then to the merged global graph. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::pickGraphSource --> <!-- @test: host/__tests__/graphify-mcp-lazy.test.js (graphify-mcp-lazy.py static contract) -->

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

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-024: Advanced-Session-Mode Graph-First Discipline

**Intent:** In advanced session mode, the agent is taught to prefer the knowledge graph over Grep-style text search for structural questions, so token cost on architecture, dependency, and call-flow questions is bounded. This REQ covers the SessionStart context injection, the preseeded rule and SKILL surface, and the soft-nudge PreToolUse hook. Graph-first discipline is advisory only: there is no hard-block enforcement. The `/graphify` build dispatch lives in [REQ-AGENT-043](#req-agent-043-graphify-build-mode-dispatch).

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a SessionStart hook queries the knowledge graph for the highest-connectivity nodes and injects a compressed structural summary as additionalContext. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh::emit_reminder --> <!-- @test: host/__tests__/graphify-session-start.test.js (graphify-session-start.sh (REQ-AGENT-024 AC1)) -->
2. In advanced session mode only, a short authoritative graph-first rule is preseeded, stating MUST / MUST NOT bullets for graph vs grep and routing to the graphify skill for mechanics rather than restating them. <!-- @test: host/__tests__/preseed-graphify-discipline.test.js (graphify preseed - advanced-mode discipline (REQ-AGENT-024)) -->
3. In advanced session mode only, the graphify skill is preseeded for Claude Code, with per-agent adapted variants emitted for Codex, Copilot, OpenCode, and Antigravity by the seed generator. <!-- @test: host/__tests__/preseed-graphify-discipline.test.js (graphify preseed - advanced-mode discipline (REQ-AGENT-024)) -->
4. The skill documents the safe build path for large repos (more than 2000 files). <!-- @test: host/__tests__/skill-graphify-content.test.js (graphify SKILL.md content (REQ-AGENT-024 AC4-AC6, REQ-AGENT-026) / REQ-AGENT-043 (build mode dispatch)) -->
5. The skill instructs the agent on first build to add canonical ignore and attribute rules so regenerable graph build outputs and working-tree intermediates are not committed while the queryable graph remains under git merge control. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-024 AC5-AC6 / REQ-AGENT-043: Pi graphify skill preserves durable graph artifacts and stays model-agnostic) -->
6. The committed knowledge-graph surface includes the queryable graph artefact, a human-readable report, a visual exploration page, the generated `callflow.html`, `.graphify_labels.json`, and an optional wiki tree. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-024 AC5-AC6 / REQ-AGENT-043: Pi graphify skill preserves durable graph artifacts and stays model-agnostic) -->
7. In advanced session mode only, a soft-nudge hook fires on grep-class tool calls and emits a reminder to prefer the graph MCP tools when a graph exists for the cwd; the hook never blocks. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh::TOOL --> <!-- @test: host/__tests__/entrypoint-graphify-hooks.test.js (manifest present + advanced mode: PreToolUse graph-first nudge wired for Grep|Glob and the ctx grep-equivalents (REQ-AGENT-024 AC7)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The SessionStart hook never auto-builds a graph; It only injects context when one exists or a build suggestion when source files are present without one.
- The soft nudge never blocks; graph-first discipline stays advisory through the preseeded rule and per-call nudge.
- The soft-nudge matcher set covers both the non-ctx tool surface (`Grep`/`Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`/`mcp__context-mode__ctx_batch_execute`).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-025: Post-Clone Graph Triage

**Intent:** After the agent clones a repo, it must triage whether to build (or refresh) a knowledge graph for it before doing other work, so users on unfamiliar repos do not start cold.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a PostToolUse hook on `Bash` and `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute` matchers detects real `git clone` and `gh repo clone` invocations using anchored token parsing that rejects quoted or echoed false positives. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh::COMMAND --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::isGitClone --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::shellCommandText --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::ENV_PREFIX --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::cloneTargetPath --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
2. Pi implements clone triage with native tool lifecycle events and Pi follow-up messages. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::graphifyClonePromptDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Clone destination resolution prefers the tool result's `Cloning into '...'` line before falling back to command parsing, so shell variables such as `$repo` never surface as literal user-facing paths. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::cloneTargetPath --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
4. When `<cloned-dir>/graphify-out/graph.json` is absent, the directive asks which graph action the user wants before any graph work, offering Full repo AST-only, Full repo semantic intent, or no graph action. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::renderGraphifyCloneDirective --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
5. When `<cloned-dir>/graphify-out/graph.json` exists, fresh graphs are used as-is; a stale graph opens the directive with an explicit STALE warning before the choices, while an unknown-freshness graph asks without the stale flag. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::existingGraphCloneNotice --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::renderGraphifyCloneDirective --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::graphifyClonePromptDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. The bounded upstream-update wrapper runs only after the user chooses AST-only, and Full semantic build/refresh must pass through graphify skill detection plus post-detection count confirmation before semantic subagents dispatch. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. The hook is idempotent per cloned directory per session via a marker key that includes both the session identifier and cloned repository path; Pi clone triage suppresses follow-up prompts for failed clone commands, skipped/already-cloned targets, and durable PR-boundary review lanes. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::shouldHandleClonePrompt --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The hook never invokes Graphify or authorizes updates; it directs the agent to ask before building or refreshing.
- A same-turn clone-time AST-only or no-graph choice remains valid after detection; Full semantic intent still requires post-detection count confirmation.

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-026: Knowledge-Graph Persistence via Git

**Intent:** Graphify artifacts persist with the repository, not with the user, so contributors on a clone inherit the graph for free and Codeflare's R2 bisync does not carry per-repo graph data.

**Applies To:** Agent

**Acceptance Criteria:**

1. Knowledge-graph artefacts are excluded from R2 sync, so they never round-trip through user-bucket storage. <!-- @impl: entrypoint.sh::init_recovery_filters --> <!-- @test: host/__tests__/entrypoint-graphify-bisync.test.js (entrypoint.sh rclone bisync filter for graphify (REQ-AGENT-026)) -->
2. The container image registers the graphify semantic merge driver globally, independent of session mode. <!-- @impl: Dockerfile::merge.graphify.driver -->
3. Repo owners with push permission commit the knowledge-graph artefacts to git so contributors inherit the graph and the visualization on clone; concurrent edits to the graph artefact are auto-resolved by the registered merge driver without manual JSON conflict resolution. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. For repos without push permission, the graph lives in the working tree only and is ephemeral. <!-- @test: host/__tests__/skill-graphify-content.test.js (graphify SKILL.md content (REQ-AGENT-024 AC4-AC6, REQ-AGENT-026) / REQ-AGENT-043 (build mode dispatch)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Per-repo ignore and merge-attribute wiring is the responsibility of the graphify skill ([REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline) AC5); this REQ covers only the platform-level pieces (sync exclusion, global merge-driver registration).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-027: Context-Mode Interoperability

**Intent:** When the context-mode plugin is preseeded, the graphify CLI must coexist with context-mode and the graph-first soft-nudge must reach the agent through context-mode's redirected tool-call path.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the context-mode plugin is preseeded, `graphify update .` and `graphify query ...` run unimpeded: context-mode is wired as a tool only, with no Bash deny-gate, so no command-routing whitelist is needed. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline) AC7 PreToolUse soft-nudge hook registers both the non-ctx matchers (`Grep`, `Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`, `mcp__context-mode__ctx_batch_execute`) so the nudge fires in both tier paths. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh::INPUT --> <!-- @test: host/__tests__/graph-first-nudge.test.js (graph-first-nudge.sh) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Graphify must not depend on context-mode at runtime; `/graphify` extraction uses upstream graphify's subagent-chunking model; context-mode, when present, provides bonus per-subagent token routing via its existing `Read|Grep|Glob|Agent` PreToolUse matchers, but is not a precondition.

**Priority:** P2

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-028: Deploy Credential Token-Creation UX

**Intent:** Connecting GitHub and Cloudflare must guide users through scope selection so they grant the smallest scope set that unlocks the features they need, without copy-pasting raw scope strings — the chosen tier flows into the OAuth `scope` parameter.

**Applies To:** User

**Acceptance Criteria:**

1. The GitHub connect card offers three scope tiers (Minimal, Recommended, Advanced) with Recommended pre-selected; the selection is sent to the server as the connect URL's `tier` query param. <!-- @impl: web-ui/src/lib/token-scopes.ts::GITHUB_TIERS --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (offers the scope tiers as a segmented control + subtitle, encodes the selected tier into the connect URL, and routes changes) -->
2. The Cloudflare connect card offers the same three-tier selector with Recommended pre-selected, sent the same way. <!-- @impl: web-ui/src/lib/token-scopes.ts::CLOUDFLARE_TIERS --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (offers the scope tiers as a segmented control + subtitle, encodes the selected tier into the connect URL, and routes changes) -->
3. The server maps the requested tier to the OAuth `scope` parameter from a backend scope catalog (the catalog never leaves the server); higher tiers are supersets of lower tiers, and the Cloudflare scope always includes `offline_access`. <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier --> <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->

**Constraints:**

- The client sends only the tier name (untrusted, normalized server-side to a known tier; default `recommended`); the concrete scope strings are defined once, server-side ([REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise) AC6, [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)).
- A GitHub App's permissions are fixed at registration, so the tier affects only the OAuth-App path.

**Priority:** P1

**Dependencies:** [REQ-AGENT-018](#req-agent-018-push--deploy-credential-management-ui), [REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise), [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** [Tier catalog test](../../web-ui/src/__tests__/lib/token-scopes.test.ts) + [Connect card test](../../web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx) + [Scope mapping test](../../src/__tests__/lib/oauth-scopes.test.ts)

**Status:** Implemented

---

### REQ-AGENT-029: Deploy Credential Propagation to Container

**Intent:** Stored deploy credentials must reach the container as environment variables and be consumed by git, wrangler, and the Cloudflare API auto-fetch step, so the in-container agent can push code and deploy without re-authentication.

**Applies To:** User

**Acceptance Criteria:**

1. Stored GitHub and Cloudflare deploy credentials are injected into the container as environment variables on session start. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
2. Credentials are sent as explicit `null` when absent (not omitted) so revocation propagates on session restart. <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-env.test.ts (applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-SESSION-016 AC3 wiring regression) / REQ-AGENT-029 (container env vars contract)) -->
3. When a GitHub credential is present, the container configures git for authenticated HTTPS access. <!-- @test: host/__tests__/entrypoint-credentials.test.js (does NOT configure git credential.helper when GH_TOKEN is unset (REQ-AGENT-029 AC3: guard)) -->
4. The Cloudflare account ID is resolved automatically from the API token when one is stored, so users need not supply it separately. <!-- @impl: src/routes/setup/account.ts::handleGetAccount -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Misconfigured Copilot scope can cause silent agent auth failure; full Copilot support requires the Advanced tier (see [REQ-AGENT-028](#req-agent-028-deploy-credential-token-creation-ux)).

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-030: Multi-Agent Format Transforms

**Intent:** Each non-Claude agent has its own config-file conventions (frontmatter shape, model-field presence, path layout, file extensions). The generator must apply the right per-agent transform so the adapted config is valid for the consumer.

**Applies To:** User

**Acceptance Criteria:**

1. Agent definitions use correct frontmatter format per agent (e.g., `tools` as record `{read: true}` for OpenCode, as array or comma-separated names according to the target schema). <!-- @impl: scripts/generate-agent-seed.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. `model` field is removed from frontmatter for non-CC agents where the target runtime resolves model selection independently. <!-- @impl: scripts/generate-agent-seed.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Path references (e.g., `~/.claude/`) are replaced with agent-specific config paths, including Pi's `.pi/agent/agents/` subagent path. <!-- @impl: scripts/generate-agent-seed.mjs::adaptPaths --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. File extensions match agent conventions (e.g., `.agent.md` for Copilot agents and `.md` for Pi subagents). <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. Pi subagent transforms emit Pi-compatible frontmatter for tools, prompt mode, extension/skill inheritance, context inheritance, and background defaults. <!-- @impl: scripts/generate-agent-seed.mjs::adaptPiSkillContent --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Format transforms are derived from each agent's documented config schema; missing schema means the agent is unsupported, not silently passed through.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-031: consult-llm Key Isolation, Subscription Backend, and Multi-Agent Parity

**Intent:** Stored LLM API keys must reach the `consult-llm-mcp` MCP server WITHOUT leaking into the coding agents' general environment (where the latest Pi/opencode/antigravity auto-detect them as their own provider credentials and silently drain the user's API account), must prefer the user's subscription over per-call API billing, and must be available identically to Claude Code and Pi — while being entirely absent in enterprise mode, where models route through the managed AI Gateway BYOK.

**Applies To:** User

**Acceptance Criteria:**

1. LLM provider keys are injected into the container ONLY under a `CODEFLARE_`-namespaced name (`CODEFLARE_OPENAI_API_KEY` / `CODEFLARE_GEMINI_API_KEY`); the bare `OPENAI_API_KEY` / `GEMINI_API_KEY` names NEVER appear in the container's global environment. Keys are read fresh from KV on each container start and are not persisted in DO storage. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
2. The entrypoint maps the namespaced keys back to the standard `OPENAI_API_KEY` / `GEMINI_API_KEY` names ONLY inside the `consult-llm-mcp` MCP server's scoped `env` block (in `~/.claude.json` and `~/.pi/agent/mcp.json`), never as a global export. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
3. Per provider the entrypoint prefers the subscription over the API key: OpenAI uses the Codex CLI backend when the user is logged into Codex, passing the API key only as a fallback; otherwise it uses the API key. Gemini always uses the API key. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
4. The `consult-llm` tooling is scoped to Claude Code and Pi only; no other agent receives the skill or MCP server. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
5. Claude and Pi consult-llm skills implement the invocation and model-selection behavior in [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior). <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
6. In enterprise mode the entire LLM-keys-and-consult-llm surface is unavailable: the keys are not injected (AC1 suppressed), the `/api/llm-keys` routes return 403 on every method, the Settings "LLM API Keys" section is hidden. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The container reads keys at start and on restart; mid-session key changes take effect only after the next session start.
- AC5 is skill-directed agent behaviour; the consult-llm SKILL.md files (Claude + Pi) are the implementation surface and are verified through [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior).
- The consult-llm MCP config is wrapped in a shell function invoked with `|| echo WARNING` so a jq/IO failure can never abort the entrypoint before the init-complete flag (a crash-loop class bug).

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-032: Starter Documentation Manually Recreatable from Settings

**Intent:** Users must be able to reset the starter "getting-started" docs to the platform defaults at any time, in case they deleted them while exploring or want to see updates that shipped after their original session.

**Applies To:** User

**Acceptance Criteria:**

1. "Recreate starter documentation" button triggers `POST /api/storage/seed/getting-started`. <!-- @impl: src/routes/storage/seed.ts::app --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (Storage Seed Routes / REQ-AGENT-032 (starter docs manually recreatable)) -->
2. The endpoint is rate-limited (3/min). <!-- @impl: src/routes/storage/seed.ts::storageSeedRateLimiter --> <!-- @test: src/__tests__/routes/storage-seed-rate-limit.test.ts (REQ-AGENT-032 AC2: storage-seed rate limiter (3/min)) -->
3. After seeding, the storage stats KV cache is invalidated. <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful getting-started seed) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The starter docs are the welcome / getting-started pages; user-authored documentation under other paths is never touched.

**Priority:** P1

**Dependencies:** [REQ-STOR-009](storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-033: `/sdd init` Scaffolding and Canonical Render

**Intent:** `/sdd init` must bootstrap a working spec in a single coherent flow whether the project is greenfield or import-mode, with every drafted REQ rendered in the canonical shape and the supporting scaffold (lockfile, review queue file) created in the same pass.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` scaffolds a new `sdd/` from templates for greenfield projects. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->
2. In import mode, `/sdd init` derives a spec from existing source code rather than scaffolding from templates. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->
3. When `/sdd init` generates a package manifest, top-level dependency versions are resolved at scaffold time via the ecosystem's registry (npm, Cargo, pip, Go) rather than emitted from memory. The Cloudflare Workers stack pins `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`, and `vitest` as a single co-resolved cohort. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->
4. Lockfile generation during `/sdd init` is a scoped carveout to the no-local-builds rule (resolution only, with `--ignore-scripts` on npm; no installs, tests, or builds). <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->
5. `/sdd init` runs as a lean two-confirm flow: the agent asks one vision question, drafts the entire spec in memory, presents the full draft as one review surface, and applies user edits in place until the user accepts. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->
6. Every REQ written by `/sdd init` renders in the canonical shape defined by the `spec-driven-development` skill: ACs numbered (`1.`, `2.`, `3.`), each labeled field on its own line with blank-line separators between trailing fields, and `**Constraints:**` + `**Dependencies:**` always present. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->
7. `/sdd init` pre-creates the verification-queue file `sdd/spec/.review-queue.md` at scaffold time with the placeholder `_Awaiting first finding._` so the file ships discoverable; after scaffold the layout-resolved review queue accumulates findings appended by spec-reviewer, `/sdd clean`, or `/sdd init` Import-Mode triage. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-033: /sdd init scaffolding and canonical render) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-034: `/sdd init` Enrichment Pass with Graphify

**Intent:** After `/sdd init` accepts the user's draft, an enrichment pass tightens the spec by walking the project's knowledge graph: cross-link dependencies, seed ADRs from architecturally-central nodes, seed glossary terms from concept nodes.

**Applies To:** User

**Acceptance Criteria:**

1. After the full draft is accepted, an enrichment pass runs before files are written, executing three sub-passes (cross-link, ADR-seed, glossary-seed) in one in-memory cycle with no additional user prompts. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034: /sdd init enrichment pass with graphify) -->
2. The cross-link sub-pass adds every REQ that references another REQ concept by name to the parent's `Dependencies:` as an anchor link `[REQ-X-NNN](#req-x-nnn-title-slug)`.
3. The ADR-seed sub-pass drafts 3-8 founding ADRs covering non-obvious technology choices (tech stack, framework, deployment target, auth pattern, data store, key middleware) and writes them to `documentation/decisions/README.md` with an index table at the top and per-ADR sections below. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034: /sdd init enrichment pass with graphify) -->
4. The glossary-seed sub-pass extracts every product noun, vendor name, and protocol mentioned in any REQ Intent or AC body and gives each a one-line definition in `sdd/glossary.md`. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034: /sdd init enrichment pass with graphify) -->
5. The enrichment pass queries the project's `graphify-out/graph.json` via the `mcp__graphify__*` MCP tool family: `get_neighbors` drives the cross-link pass, `god_nodes` surfaces ADR-seed candidates, `query_graph` extracts glossary concept-tagged nodes, and `shortest_path` validates non-obvious dependency edges. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034: /sdd init enrichment pass with graphify) -->
6. When the graph is missing at enrichment time, `/sdd init` prompts the user once with a `/graphify cluster-only` (AST-only, free) build offer; on decline, enrichment falls back to an in-memory heuristic and appends a one-line notice to `sdd/changes.md` recording reduced cross-link density. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034: /sdd init enrichment pass with graphify) -->
7. Graphify MCP tools are tool-agnostic across Bash and context-mode surfaces; the enrichment-pass contract is identical regardless of which tool surface is active. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-034: /sdd init enrichment pass with graphify) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Backlink density drops materially when the graph is absent; the changes.md notice exists so future readers can correlate spec quality with the build state at init time.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-035: `/sdd init` Phase 7a Source-Anchor Verifier Gate

**Intent:** `/sdd init` must not declare success on a spec that contains unanchored claims. A programmatic source-anchor verifier runs before iterate-to-clean so every `<!-- @impl -->` claim is proven against the source tree, closing the "agent wrote what isn't there" half of the Validation-Equals-Generation gap. Phase 7b (enumeration coverage) is split into [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate).

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` runs Phase 7a as a CRITICAL non-skippable gate BEFORE invoking `spec-enforce` and `doc-enforce`. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) -->
2. The verifier resolves every spec and documentation source anchor on disk, checks symbols and local literal values, and counts malformed anchors and unreadable files. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-source-anchors.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) -->
3. The verifier emits a machine-readable JSON report containing counts of parsed, resolved, orphaned, drifted, malformed, and unreadable anchors, plus per-entry failure details and an exit-code field, written to a Phase-7a evidence file the commit body can reference. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-source-anchors.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (emits all 9 contract fields: parsed/resolved/orphaned/drifted/malformed/unreadable/failures/malformed_entries/unreadable_entries/exit_code) -->
4. The `[sdd-init]` commit body MUST include the verbatim summary line `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) -->
5. A non-zero `exit_code` blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (AC5: non-zero exit_code blocks until every failure is fixed) -->
6. Substituting a structural sanity check or agent self-attestation, partial coverage, running the verifier AFTER the enforcement skills, bypassing on a missing-tool error, or committing without the summary line each carry a CRITICAL severity (`phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`).
7. After `/sdd init`, steady-state CQ-SOURCE (`spec-enforce-truth`) and Pass 15 (`doc-enforce-truth`) consume Phase 7a's JSON when available rather than re-deriving. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The verifier is a programmatic Python script shipping with the `sdd-init` skill; agent self-attestation MUST NOT be substituted for the verifier output.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-036: PR-Boundary Review Trigger Conditions

**Intent:** Review agents must fire only on PR-boundary events that actually target shipping code. Trigger evaluation gates parsed boundary commands against real PR state, ignores integration-branch and no-PR work, and leaves direct `main` protection to upstream branch rules. Command parsing lives in [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing), command targeting/recovery lives in [REQ-AGENT-066](#req-agent-066-pr-boundary-command-targeting-and-failure-recovery), lane classification + agent dispatch live in [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), and bypass surfaces live in [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces).

**Applies To:** User

**Acceptance Criteria:**

1. PR-boundary review fires only for an open, non-draft PR targeting `main` or `master`; on the actual-command path, an open PR with a missing base fails open to review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isEnforcedPr --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isEnforcedPrForPush --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prEnforcedForPush --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (prEnforcedForPush (push-path fail-open enforcement gate)) -->
2. Only command classes parsed by [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing) can enter trigger evaluation; `gh pr merge` is merge-gate input, not a fresh review trigger. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isPrBoundaryTrigger --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGhPrMergeCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (isPrBoundaryTrigger) -->
3. Metadata-only PR commands do not trigger review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isPrBoundaryCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (isPrBoundaryTrigger) -->
4. PRs into integration branches (`develop`, `staging`, etc.) are deferred until that branch has its own PR to `main` or `master`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isEnforcedPr --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh — PR-SYNC trigger (base-gated)) -->
5. During a non-draft, non-dry-run `gh pr create` metadata-visibility race, Pi may infer `main`/`master` from CLI/default base data and synthesize an open PR from local HEAD; non-protected bases remain ignored. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prCreateBoundaryBase --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prCreateCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::prForBoundaryCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (prEnforcedForPush (push-path fail-open enforcement gate)) -->
6. Non-triggering states never create a review window: vibe-coding projects run no agents, and passive lifecycle events never act on branch existence alone. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isSddProject --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reconcileOpenPrReview --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. A successful PR-boundary command still enters review evaluation when its tool-end event loses command text. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::rememberBoundaryStartCommand --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::startedBoundaryCommandForToolEnd --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::handlePrBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::prStateFreshResult --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (recovers same-tool PR-boundary commands whose end event lost command text) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing)

**Verification:** [Automated test](../../host/__tests__/git-push-review-reminder.test.js), [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [`gh pr edit` retarget trigger tests](../../src/__tests__/lib/review-trigger.test.ts)

**Status:** Implemented

---

### REQ-AGENT-037: `/sdd clean` Rescue and Autonomy Modes

**Intent:** Three autonomy modes (interactive, auto, unleashed) give the user a knob between hand-holding and walk-away autopilot, and the `/sdd clean` rescue pass restores rotted specs to canonical shape without overwriting intent. Review-agent discipline enforcement (the content-quality passes each review agent applies) lives in [REQ-AGENT-044](#req-agent-044-review-agent-discipline-enforcement).

**Applies To:** User

**Acceptance Criteria:**

1. Three autonomy modes (`interactive`, `auto`, `unleashed`) are selectable via the layout-resolved config file (`sdd/spec/config.yml` on the nested layout, `sdd/config.yml` on the flat-legacy layout). <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) -->
2. `interactive` and `auto` modes apply fixes on the current branch (auto silently, interactive after confirmation). <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) -->
3. `unleashed` mode applies SAFE + RISKY + JUDGMENT fixes on the current branch via per-category `[sdd-clean]` commits and uses conservative JUDGMENT auto-resolution that never overwrites intent. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) -->
4. `unleashed` refuses when `enforce_tdd: false`; users must enable TDD or use `auto`. It creates no branch or PR, and per-category commits remain independently revertible. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) -->
5. `/sdd clean` rescues rotted specs with conservative JUDGMENT auto-resolution that never overwrites spec intent (mark Partial + Notes, move to Out of Scope, shrink in place). <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) -->
6. Each review agent self-limits to 2 fix rounds per commit cycle scoped to its own lane (spec-reviewer counts only commits touching `sdd/**`; doc-updater counts only commits touching `documentation/**`) to prevent micro-fix spirals without cross-contaminating lanes. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::all_required_lanes_completed_for_current_head --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — fail-safe behavior) -->
7. In `auto` and `unleashed` modes, spec-reviewer and doc-updater push to whatever branch is currently checked out; the user is responsible for checking out the right branch before invoking. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Status semantics, `Deprecated` requirements, the spec-discipline enforcement layer, and the `enforce_tdd` test-coverage rule follow `rules/spec-discipline.md`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-038: Resume Mode Drain Workflow

**Intent:** Re-invoking `/sdd init` on a transitioning project enters Resume Mode, which surfaces open triage items one at a time, refreshes their Context, accepts one of five decisions, and commits each decision so the user can drain the queue at their own pace. When the last item closes, the project exits SDD transition.

**Applies To:** User

**Acceptance Criteria:**

1. Re-invoking `/sdd init` on a project where `sdd/` already exists and `sdd/.init-triage.md` has at least one open item enters Resume Mode. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-038: Resume Mode drain workflow) -->
2. The user chooses one of five decisions per item (`accept`, `correct`, `lost`, `skip`, `quit`); per-decision semantics are enumerated in Constraints.
3. Only `accept` and `correct` promote anything into the official spec; `skip` and `lost` write nothing to `sdd/{domain}.md`.
4. Each decision is its own commit (`[sdd-init] resolve TRIAGE-{NNN}` or `mark lost`).
5. Resume Mode entry refuses to start when the working tree has uncommitted changes and is always interactive regardless of `sdd/config.yml`'s `mode`. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-038: Resume Mode drain workflow) -->
6. Queue-drain closure mechanics are specified in [REQ-AGENT-047](#req-agent-047-resume-mode-closure-and-review-pipeline-gate).

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

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

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-039: `/sdd init` Phase 7b Enumeration-Coverage Verifier Gate

**Intent:** Phase 7a verifies that every claim the agent wrote is anchored; Phase 7b closes the second half of the Validation-Equals-Generation gap by verifying the agent did not silently drop entire source files from the enumeration. The verifier runs after Phase 7a and before iterate-to-clean so unenumerated load-bearing source surfaces as a CRITICAL gate failure rather than a silent omission.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` runs Phase 7b as a second CRITICAL non-skippable gate AFTER Phase 7a and BEFORE iterate-to-clean. <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->
2. The verifier walks the working tree, identifies load-bearing source files, and checks each file's repo-relative path against source-anchor paths in `sdd/**/*.md` and `documentation/**/*.md` plus literal mentions in layout-appropriate triage files. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->
3. The verifier emits a JSON report `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}`. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py::CoverageReport --> <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (emits enumerated/accounted/unaccounted/coverage_pct/accounted_via/unaccounted_entries/exit_code) -->
4. The `[sdd-init]` step-10 commit body MUST include the verbatim summary line `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1` alongside the Phase 7a line. <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->
5. An empty triage queue on Import Mode with `unaccounted > 0` is CRITICAL `import-mode-narrowed-scope`. <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->
6. Agent self-attestation, sampling, running `spec-enforce` first without Phase 7b, or committing without the summary line each carry a CRITICAL severity (`phase-7b-self-attestation`, `phase-7b-incomplete-coverage`, `phase-7b-pipeline-inversion`, `phase-7b-evidence-missing`).
7. A per-project waiver file `sdd/spec/.phase-7b-waiver.txt` excludes framework-boilerplate files from coverage; greenfield runs that produce `enumerated=0` and `coverage_pct=100.0` are advisory but still emit the commit body line so the audit-trail format stays uniform across modes. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The verifier is a programmatic Python script shipping with the `sdd-init` skill; agent self-attestation MUST NOT be substituted for the verifier output.

**Priority:** P1

**Dependencies:** [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-040: PR-Boundary Lane Classification and Agent Dispatch

**Intent:** Once a PR-boundary trigger fires ([REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)), a shared lane classifier picks the minimal correct set of review agents from the diff so the in-turn nudge and turn-end gate agree, and a fix-push cascade can advance the ack pointer without losing review coverage.

**Applies To:** User

**Acceptance Criteria:**

1. Layer 1 lane classification uses one internally shared classifier per runtime surface so the in-turn nudge and the turn-end gate agree on which review agents the diff requires. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewFiles --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — PR state gating) -->
2. Lane mapping sends generated-only diffs to no lanes, docs-only to `doc-updater`, spec-only to both documentation lanes, and source changes to all three agents. Non-generated files always determine the effective lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewFiles --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGeneratedArtifactPath --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (classifyReviewFiles generated-artifact handling) -->
3. Conservative branches (empty diff, missing prior ack, divergent merge-base) and a missing or unsourceable helper both fall back to all-three-lanes (`code-reviewer spec-reviewer doc-updater`), so a partially-deployed install never disables enforcement. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @test: host/__tests__/lane-classifier.test.js (last_ack on a divergent branch falls back to all three lanes) -->

**Constraints:**

- The agent must not push to the PR branch or start a second review wave while any required review lane is in flight.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Lane classifier tests](../../host/__tests__/lane-classifier.test.js), [Stop-hook behavioral tests](../../host/__tests__/enforce-review-spawn.test.js), [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-041: PR-Boundary Review Bypass Surfaces

**Intent:** The user needs a small set of explicit, user-only escape hatches when a PR-boundary review gate would otherwise block legitimate work (hermetic tests, deliberate skip, repeated false-block). The assistant MUST NEVER trip these surfaces in its own output.

**Applies To:** User

**Acceptance Criteria:**

1. A user-creatable one-shot sentinel file bypasses the current PR-boundary gate exactly once and is auto-deleted on use. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::consumeBypass --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (H1: vibe-coding project does NOT consume the /tmp/review-bypass sentinel) -->
2. In Pi, review-start no-op decisions leave the bypass sentinel and boundary-start eligibility untouched, while live review-start or merge-gate decisions are the only decisions that may consume a pending sentinel. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewWindowStartDecision --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewBoundaryStartDecision --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeBoundaryBypassForHead --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::onAgentStart --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::mergeGateDecision --> <!-- @test: src/__tests__/lib/review-state.test.ts (reviewWindowStartDecision (REQ-AGENT-041: bypass is consumed only by live review starts)) -->
3. Claude Stop-hook enforcement treats the sentinel as a one-turn bypass without advancing the acknowledgement checkpoint; Pi native enforcement acknowledges only the current live protected PR HEAD after successful sentinel consumption. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeBypass --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::bypassAckHeadForStatus --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Pi task/subagent sessions must leave the sentinel untouched and must not acknowledge a bypass if sentinel consumption fails. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::consumeBypass --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::canMainSessionConsumeReviewBypass --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewBypassConsumeDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-041 / REQ-AGENT-055: Pi bypass consumption stays main-session-only and active head selection rejects stale states) -->
5. A user-authored `skip review` or `skip verification` phrase after the candidate push line bypasses that push. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — bypass 2: magic phrase) -->
6. A 5-strike circuit breaker exits silently for the same unacked PR HEAD until the SHA changes. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::openBreaker --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::isBreakerOpen --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — 5-strike circuit breaker / REQ-AGENT-044 (review-agent discipline enforcement)) -->
7. The assistant MUST NEVER create the sentinel file or write the magic phrase in its own output. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeBypass -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- These bypass surfaces apply only to PR-boundary review gates; the in-turn nudge and trigger detection in [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions) are unaffected.
- Passive status refresh, monitor delivery, lane completion, idle reaping, already-acked heads, breaker-open heads, and existing review windows are review-start no-op decisions.
- The bypass sentinel location is overridable for hermetic test environments.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-043: Graphify Build Mode Dispatch

**Intent:** Before a `/graphify` build dispatches extraction work, the user must explicitly choose whether to build a graph and which scope to build. Claude keeps the upstream AST-only vs Full semantic choice. Pi offers Architecture graph, Full repo AST-only, Full repo semantic, or no graph update. In Pi, uncached semantic extraction must use running-session Pi `Agent` subagents that inherit the current main-session model; community labels are written by the active Pi main session to `.graphify_labels.json`; official Graphify CLI/module flows own AST extraction, cache merge, graph build, clustering, report generation, and visualization, while label application regenerates report/html from existing graph community assignments.

**Applies To:** Agent

**Acceptance Criteria:**

1. Before dispatching semantic-extraction subagents in a Claude `/graphify` build, the agent presents an `AskUserQuestion` with exactly two modes: AST-only and Full. The Full option includes the actual subagent count and a wall-time estimate. <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::AskUserQuestion --> <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::uncached_doc_paper_files --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-025 / REQ-AGENT-043: Pi graphify clone triage resolves clone destinations and branches on graph state) -->
2. In Pi, after detection, the graph refresh choice offers Architecture graph, Full repo AST-only, Full repo semantic, and an explicit no-graph option that stops without modifying `graphify-out`. <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::Architecture --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::graphify-out --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
3. Clone-time AST-only and no-graph choices suppress the duplicate post-detection mode question; clone-time Full semantic is intent only, and the agent must show the actual uncached file/subagent counts after detection and get confirmation before dispatching semantic subagents. <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::uncached --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::uncached --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
4. The semantic option is hidden when the corpus contains zero docs/papers/images; code-only repos still offer the Pi Architecture graph, Full repo AST-only, and no-graph options. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-025 / REQ-AGENT-043: Pi graphify clone triage resolves clone destinations and branches on graph state) -->
5. In advanced session mode only, Claude Code Part B semantic subagents use the Claude graphify skill's configured reliable extraction model, while Pi Part B semantic subagents omit `model` overrides so they inherit the current main-session model. <!-- @test: host/__tests__/skill-graphify-content.test.js (graphify SKILL.md content (REQ-AGENT-024 AC4-AC6, REQ-AGENT-026) / REQ-AGENT-043 (build mode dispatch)) -->
6. The Part C merge step preserves all data structures produced by Part B subagents - including hyperedges - by saving subagent chunks into Graphify's semantic cache before official Graphify extraction/build consumes the cache. <!-- @test: host/__tests__/skill-graphify-content.test.js (graphify SKILL.md content (REQ-AGENT-024 AC4-AC6, REQ-AGENT-026) / REQ-AGENT-043 (build mode dispatch)) -->
7. Pi's native graphify skill does not instruct the agent to run headless semantic extraction or Graphify provider labeling. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Claude Code's graphify skill owns Claude-specific extraction model selection; Pi's graphify skill must remain provider/model agnostic unless the user explicitly requests a model override.

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-044: Review-Agent Discipline Enforcement

**Intent:** The three review agents (doc-updater, spec-reviewer, code-reviewer) enforce content-quality beyond structural compliance. Each owns a distinct set of substantive passes (truth-check against source, content-preservation on trims, test-name-vs-assertion match) so a structurally-clean change cannot ship with semantically-wrong content.

**Applies To:** User

**Acceptance Criteria:**

1. All three review agents (doc, spec, tdd) enforce both structural compliance and content-quality on every applicable lane. <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - lane-aware emission (compute_required_lanes integration)) -->
2. doc-updater runs structural passes (shape, budgets, lane) and content-quality passes (verification truth-check, Implements-vs-AC cross-walk, stale code-block detection against source, content-preservation on trims, stranger cold-read usability).
3. spec-reviewer runs the spec analogs (REQ-test truth-check beyond literal ID match, vendor/protocol drift detection, content-preservation on shrink).
4. code-reviewer flags tests whose name claims behavior the assertions don't actually verify (the test-name-lies antipattern from `tdd-discipline`).
5. Auto-fixes derive concrete content from source or REQ when possible; load-bearing clauses that would be lost to a word-cap trim are promoted to surrounding prose, or the trim is reverted with a finding.

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The structural-vs-content-quality split, per-pass severity, and auto-fix behavior follow `rules/documentation-discipline.md`; the cold-read task registry is owned by the same file.
- spec-reviewer's content-quality passes are defined by `rules/spec-discipline.md`; code-reviewer's test-name-lies detection follows `rules/tdd-discipline.md`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes), [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-045: Import-Mode Triage Queue and Transition State

**Intent:** Every unclear item from Import Mode lands in a typed triage entry with concrete Context evidence so the human resolver can decide without re-investigating, and the transition state suspends the entire review pipeline so legacy code does not trigger reviewers until the spec is real. Status defaults respect the project's TDD opt-out so imported codebases do not get falsely flagged as incomplete.

**Applies To:** User

**Acceptance Criteria:**

1. Every entry in `sdd/.init-triage.md` carries `**Context:**` and `**Recommendation:**` with `**Rationale:**`. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045: Import-Mode triage queue and transition state) -->
2. The `/sdd init` skill instructs the agent to populate `**Context:**`, `**Recommendation:**`, and `**Rationale:**` for every entry; well-formedness (concrete Context refs, a specific Recommendation, no placeholders like `TBD`/`(inferred)`) is verified at the enforce pass, not by a programmatic parser gate.
3. Triage entries use `**Status:** open | resolved | lost`; `lost` requires a one-line `**Reason:**` field explaining why the information is genuinely unrecoverable. <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045: Import-Mode triage queue and transition state) -->
4. Open init-triage items set `transition: true`, suspend all three PR review lanes, and reject unleashed mode with a message naming the transition and open items. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) -->
5. When `enforce_tdd: false` (the Import Mode default), CLEAR REQs whose source code implements the AC default to `Status: Implemented` unconditionally so the project's opt-out from test-based verification is honored.
6. When `enforce_tdd: true`, Status defaults `Implemented` only if a test file references the REQ ID, `Partial` otherwise.

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Triage items live only in `sdd/.init-triage.md`; No separate state file, no JSON mirror, no machine-readable index; Git history is the audit trail for who resolved which item with what decision.
- Triage workflow is interactive only; `auto` and `unleashed` modes do not auto-resolve triage items.
- `sdd/.init-triage.md` is owned by `/sdd init`. spec-reviewer reads it to determine transition state and to verify resolved items' REQs received the fold-in; doc-updater does not touch it.
- When `enforce_tdd: false`, each domain `sdd/{domain}.md` file receives one footnote `_Verification: code-only (no automated coverage)._` appended at the bottom; This is the only signal location; per-REQ `Notes:` fields are not used for this signal.
- The Resume Mode drain workflow that resolves the open items lives in [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow).

**Priority:** P1

**Dependencies:** [REQ-AGENT-022](#req-agent-022-legacy-codebase-import-mode-discovery)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-047: Resume Mode closure and review-pipeline gate

**Intent:** When the Resume Mode triage queue drains, the project must cleanly exit SDD transition: clear the `transition: true` flag, record totals, and re-arm the gates that were suspended during drain. The PR-boundary review pipeline must stay silent while triage items remain open so legacy code does not trigger review agents before the spec is real.

**Applies To:** User

**Acceptance Criteria:**

1. When the last `Status: open` item is resolved or marked `lost`, the resolving commit clears `transition: true` from `sdd/config.yml`, appends a closure entry to `sdd/changes.md` recording totals.
2. `enforce_tdd` is NOT auto-flipped on closure; the user changes it manually when ready for TDD enforcement, typically after adding REQ-ID references to test names in the imported source.
3. `sdd/.init-triage.md` is preserved on closure as the audit record.
4. The PR-boundary review pipeline (PostToolUse `git-push-review-reminder` + Stop `enforce-review-spawn` hooks) short-circuits to no-op while `sdd/.init-triage.md` has open items, so legacy code does not trigger code-reviewer / spec-reviewer / doc-updater until the spec is real. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::requires_lane --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - lane-aware emission (compute_required_lanes integration)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-048: Audit accumulator surfaces

**Intent:** SDD ships two adjacent audit-trail surfaces beyond the spec review queue: a doc-lane coverage accumulator owned by doc-updater, and a `/sdd clean` execution audit. The locations and lifecycle of these surfaces are specified here so neither tool re-derives them.

**Applies To:** Agent

**Acceptance Criteria:**

1. The doc-lane audit accumulator `documentation/.doc-coverage.md` is lazy-created by doc-updater on first substantive finding (no scaffold-time placeholder). <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-048: Audit accumulator surfaces (sdd-init half)) -->
2. The `/sdd clean` execution audit lives in per-category commit bodies (recoverable via `git log --grep='\[sdd-clean\]'`), not in a dotfile. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-048: Audit accumulator surfaces (sdd-clean half)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-049: Auto-upgrade preseed on release

**Intent:** When a new codeflare release ships changed preseed content (agent skills, rules, plugins), the user's R2 bucket should be reconciled automatically on first dashboard load - no manual "Recreate Agent Skills & Rules" click required. Session creation and stopped-session access are prevented in the UI during the brief upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The preseed generation script computes a deterministic SHA-256 content hash over all preseed documents (sorted by key) and emits it as a build-time constant accessible to the runtime. <!-- @impl: src/lib/agent-seed.generated.ts::PRESEED_CONTENT_HASH --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. After a successful reconcile (manual or auto), the applied hash is persisted in the user's preferences store. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->
3. On initial dashboard load, the backend compares the stored hash against the build-time constant and returns whether an upgrade is needed. This check is omitted from periodic polling to avoid overhead. <!-- @test: src/__tests__/routes/session-batch-status.test.ts (returns preseedNeedsUpgrade true when hash missing from preferences) -->
4. On initial dashboard load, if an upgrade is needed, the frontend triggers the reconcile in the background. <!-- @impl: web-ui/src/stores/session.ts::applyMetricsUpdate --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) -->
5. While the upgrade is in progress, the "+ New Session" button is disabled and displays "Upgrading..." (both Dashboard and SessionDropdown), and stopped session cards are visually dimmed (reduced opacity) and click-disabled. <!-- @impl: web-ui/src/stores/session.ts::applyMetricsUpdate --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (REQ-AGENT-049 AC6: stopped card dimmed during preseed upgrade) -->
6. If the auto-upgrade fails, the error is logged but the dashboard remains fully usable. A page refresh retries the check. <!-- @impl: web-ui/src/stores/session.ts::applyMetricsUpdate --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-AGENT-049 AC7: should clear preseedUpgrading on failure so dashboard remains usable) -->
7. The reconcile respects the user's current session mode and tier (standard/pro/unlimited) - identical behavior to the manual "Recreate" button. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-011](#req-agent-011-agent-skills--rules-manually-recreatable-from-settings), [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-050: Pi-Native `/review` Workflow Skill

**Intent:** Pi users running `/review` must get the same multi-perspective review workflow that Claude users get from `commands/review.md`. Because Claude slash commands do not deploy to Pi, the `/review` command must inject a dedicated Pi-native review skill rather than the PR-boundary enforcement pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi `/review` command injects a dedicated Pi-native `review` skill that mirrors the Claude `commands/review.md` workflow, instead of injecting the `git-review-pipeline` enforcement skill. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The Pi `review` skill is the user-invoked review workflow (multi-perspective specialist subagents, cross-reference, architecture-decision filter, optional external verification, interactive triage), explicitly distinct from PR-boundary enforcement; it does not run the `git-review-pipeline`.
3. The skill scopes review by `--all` or `--diff` parsed from the appended command line, prints help and runs no phases when neither flag is present, and supports the `--deep` and `--verify-high` flags. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview -->
4. The skill is static-analysis only: it never runs builds, tests, or linters (the container is resource-constrained).
5. The skill maps Claude primitives to Pi-native ones: subagents spawn via Pi's `Agent` tool with `subagent_type`, graph queries use Pi-native `graphify_query`/`graphify_path`/`graphify_explain` (with a `--graph <repo>/graphify-out/graph.json` CLI fallback), and plan entry uses the `Plan` agent or an explicit written-and-approved plan.
6. The skill is delivered advanced-only via the Pi manifest (`skills/review/SKILL.md`) through the standard seed pipeline. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The skill mirrors the Claude `/review` interactive-triage contract from [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review): findings are never auto-applied; the user confirms each fix.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-051: Pi `/debug`, `/deploy`, and `/brainstorm` Commands

**Intent:** Workflows that Claude ships as slash commands (`/debug`, `/deploy`, `/brainstorm`) are unavailable in Pi because Claude commands do not deploy to Pi. Pi must reimplement them as native command handlers so Pi users get the same systematic debugging, deploy-and-verify, and structured-brainstorming workflows.

**Applies To:** User

**Acceptance Criteria:**

1. A Pi extension registers three native commands via `pi.registerCommand`: `debug`, `deploy`, and `brainstorm`. <!-- @impl: preseed/agents/pi/extensions/codeflare-commands.ts::dispatchDebug --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
2. Each command injects its adapted workflow text plus the user's input, rather than loading a SKILL.md, because these workflows have no Pi skill file. <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::commandInstructions --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
3. `/debug` runs a systematic root-cause debugging workflow (no fixes before root cause is established; the 3-Fix Rule). <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::DEBUG_WORKFLOW --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
4. `/deploy` runs the push, stale-CI cancellation, CI monitoring, deploy, and live-URL verification workflow. <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::DEPLOY_WORKFLOW --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
5. `/brainstorm` runs a structured option-generation workflow that produces trade-offs and a recommendation. <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::BRAINSTORM_WORKFLOW --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
6. The extension is delivered advanced-only via the Pi manifest (`extensions/codeflare-commands.ts`) through the standard seed pipeline. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (AC6: codeflare-commands.ts is delivered advanced-only through the seed pipeline (manifest mode-gate)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- These commands adapt the Claude command workflows to Pi-native tool surfaces; they are not generic transforms of the Claude command files (Claude commands are not deployed to Pi).

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-052: Pi Commit-Attribution and Local-Build Hook Hardening

**Intent:** Pi's PreToolUse guards that block AI attribution and local builds must cover the same surfaces and detection set as the canonical Claude hooks, so an attributed commit, PR, issue, release, or tag cannot slip through a previously-unguarded subcommand and a local build is not silently allowed.

**Applies To:** Agent

**Acceptance Criteria:**

1. The attribution guard fires not only on `git commit` and `gh pr create` but across `git merge`, `git tag`, `git notes`, and the `gh pr`, `gh issue`, and `gh release` subcommand families. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
2. The attribution detection set matches genuine attribution signatures only - the canonical `block-attributed-commits.sh` set plus the brain emoji and `ChatGPT` as a deliberate Pi-guard superset since a Pi session may run a non-Claude model. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
3. The attribution guard does not match a bare `Claude`, so `git`/`gh` commands that name `preseed/agents/claude/` paths are not false-positives. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
4. The local-build guard covers the package-manager build/test/lint/typecheck/dev verbs plus `pytest`, `vitest`, `go test`, `swift test`, `cargo test`, `tsc`, `eslint`, `oxlint`, `prettier`, and `wrangler dev`. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::isLocalBuildCommand --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
5. The local-build guard honors a user-only consume-on-use sentinel at `/tmp/local-build-bypass`: when present, the guard deletes it and allows the one command through; the block message names the override path. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::localBuildBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->

**Constraints:**

- The attribution and local-build detection sets are kept aligned with the canonical Claude hook scripts (`block-attributed-commits.sh`, the no-local-builds rule); divergence is a regression, except the documented Pi superset (brain emoji + `ChatGPT`) in AC2.
- The bypass sentinel is user-only and consume-on-use, mirroring the user-only `/tmp/review-bypass` sentinel discipline in [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces) AC1.

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-053: Pi Durable Review Status and Result Formatting

**Intent:** Pi operators need consistent PR-boundary review output and a compact indication that internal durable lanes are active.

**Applies To:** User

**Acceptance Criteria:**

1. Durable PR-boundary result files use a shared `## Findings` plus severity-count Review Summary table format. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatDurableReviewResult --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. Pi shows compact durable-lane footer progress from persisted pending-review state while PR-boundary lanes are in flight, listing required lanes with `M:SS` elapsed time and completed-lane token counts when available. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::compactDurableReviewStatus --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatReviewElapsed --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatReviewTokens --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::laneTokensFromTranscript --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::updateReviewStatus --> <!-- @test: src/__tests__/lib/review-state.test.ts (compactDurableReviewStatus timer + token badge (footer enhancement)) -->
3. Pi suppresses duplicate PR-boundary lane-result notices for the same repo, head, lane, and result path, and still drops deprecated summary custom message types. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::claimLaneResultNotice --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::installReviewMessageDedupe --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. After all required lanes complete, Pi writes a merged `summary.md` and uses the review-monitor overview instead of separate per-lane chat result blocks. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::writeReviewSummaryFromDisk --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. The merged chat summary reports aggregate severity counts across code, spec, and documentation lanes and renders findings sorted by criticality, without requiring per-lane result-file links in chat. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::mergedReviewSummaryModel --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatMergedReviewSummary --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. The finding extractor and the severity counter apply one byte-identical decoration rule a severity word is a finding only when decorated as `[SEVERITY]`, `**SEVERITY**`, or `SEVERITY:` at the leading position of a header line. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::findingHeaderMatches --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::extractReviewFindings --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::countReviewSeverities --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1/AC3-AC6); [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (AC2 — elapsed/token badge formatting + compact status rendering/omission)

**Status:** Implemented

---

### REQ-AGENT-054: Pi Durable Review Lane Failure Handling

**Intent:** Pi operators need durable PR-boundary review failures to fail closed without falsely acknowledging a PR head.

**Applies To:** User

**Acceptance Criteria:**

1. When a durable Pi review lane exceeds its wall-clock budget, its child process dies before producing a result, or it finishes without usable output, the reaper persists the lane as failed instead of completed; an over-budget lane's process group is also killed. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reapLaneDecision --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. Failed or timed-out durable lanes do not satisfy the required result-file gate. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::completedDurableReviewLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-054: durable lane recovery reflects disk status (result wins; running is preserved for the reaper; completed-without-result reopens; failed stays unacked)) -->
3. A PR head remains unacked until a later review run writes every required lane result file. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::markCompleted --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-054: durable lane recovery reflects disk status (result wins; running is preserved for the reaper; completed-without-result reopens; failed stays unacked)) -->
4. Lane liveness is the live child pid, identity-checked against its recorded `/proc` start-time so a recycled pid is never trusted alive nor signalled. A `running` lane is re-spawn-suppressed only while alive; a dead child with no result file is reaped to failed and re-spawn-eligible. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::runningDurableReviewLanes --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::isProcessAlive --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::startDurableReviewLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. If completion callbacks are missed or Pi reloads while a pending review window still exists, persisted exact-head result files are enough to recover and write `summary.md`; acknowledgement waits until the background review-monitor has written `monitor.completed`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::refreshReviewStatusFromDurable --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. The reaper writes a lane result file and marks it completed when its transcript reaches a terminal `agent_end` (one with no pending retry), or when its child exits after flushing a usable final assistant message even without a terminal `agent_end` line. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reapLaneDecision --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::summarizeLaneTranscript --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. Lane-transcript distillation is retry-aware: an `agent_end` carrying `willRetry: true` does not settle the lane, and that failed attempt's `errored`/`stopReason`/final-text verdict is discarded so an early transient error cannot poison the retry that later succeeds. The terminal end is any `agent_end` without `willRetry: true`. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::summarizeLaneTranscript --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reapLaneDecision --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::reapDurableReviewLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-054: durable lane orchestration is retry-aware (transient error + retry completes; a willRetry attempt-end never settles a lane; a failed lane self-heals)) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-055: Pi PR-Boundary Review Window Advancement

**Intent:** Pi review enforcement must keep the merge gate attached to the first unreviewed PR window across reloads, retries, and fix-push cascades without losing findings from an earlier incomplete review.

**Applies To:** User

**Acceptance Criteria:**

1. A pending review window is discarded when the readable PR has definitively closed, retargeted, or moved to an unrelated head. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewHead --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-055 AC1-AC3: review head classification separates stale, unreadable, and advanced PR heads) -->
2. If the PR state cannot be read, the pending review window is left intact for retry. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewHead --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. If the readable PR head advances to a descendant while review is still in flight, Pi rolls the review window forward instead of discarding it. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewHead --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::rollForwardAdvancedReview --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::abandonDurableReviewLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. A fix-push cascade preserves the first unreviewed review base for cumulative review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::selectReviewBase --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-055 AC4-AC5: Pi review enforcement selects the unreviewed incremental review base) -->
5. Pi does not use a remote-tracking previous head as a review base unless an explicit ack or completed previous review proves the earlier PR contents were already covered. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::selectReviewBase --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. The merge gate requires reviewer execution for the targeted PR head, fails closed on malformed or unreadable pending heads, blocks unacked auto-merge, and audits wrapper or server-side merges completed without review; findings severity does not control acknowledgment. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::mergeGateDecision --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::mergeCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::onAgentStart --> <!-- @test: src/__tests__/lib/review-state.test.ts (mergeGateDecision (the gh-pr-merge last-line-of-defense)) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-054](#req-agent-054-pi-durable-review-lane-failure-handling)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts); the merge-gate decision and merge-command-target parsing are unit-tested in [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (`mergeGateDecision`) and [review-trigger.test.ts](../../src/__tests__/lib/review-trigger.test.ts) (`mergeCommandTarget`). The roll-forward lane abandonment (AC3), the retroactive `merge_completed_unreviewed` audit, and the `onAgentStart` gate wiring that consumes the pure decision are verified by inspection plus a bundled-jiti load-check (the repo's runtime-coverage convention for the seeded extensions).

**Status:** Implemented

---

### REQ-AGENT-056: Pi Local Statusline Footer

**Intent:** Pi users need a compact footer in every session mode that shows session context without hiding extension-owned status rows such as PR-boundary review progress.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi local statusline extension is preseeded in both Standard and Pro modes. <!-- @impl: preseed/agents/pi/manifest.json::local-statusline.ts --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The first footer line renders context usage, active model with thinking effort, and the active repository label when resolved. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::renderLine --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::contextPercent --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. If cwd metadata is outside git, the footer falls back to in-session active-repo memory and then review-repo memory. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberActiveRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberReviewRepo --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::updateActiveRepoFromPath --> <!-- @test: src/__tests__/lib/review-state.test.ts (rememberActiveRepo / recallActiveRepo (shared in-session active-repo memory)) -->
4. The graphify active-cwd sentinel is display-only and accepted only for git repos inside a session root. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::sentinelRepoForDisplay --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::activeRepoSentinelForDisplay --> <!-- @test: src/__tests__/lib/review-state.test.ts (activeRepoSentinelForDisplay (guarded on-disk sentinel fallback)) -->
5. Footer status routing prefers current durable review state over stale `codeflare-review` fallback rows. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::installFooter --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::liveReviewRow --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. Footer lines are truncated by visible width, preserving ANSI color sequences and appending a reset before the ellipsis so colored review statuses do not consume visible width or bleed styling past truncation. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::truncateToWidth --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-056: Pi local statusline renders model effort and preserves extension statuses) -->
7. The statusline refreshes on session start, resource discovery, turn boundaries, model changes, thinking-effort changes, and cache-TTL repaint intervals. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::refreshFooter --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::CACHE_TTL_MS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-056: Pi local statusline renders model effort and preserves extension statuses) -->

**Constraints:**

- The statusline is cosmetic and must not block agent execution if repository or context metadata cannot be read.
- Idle sessions render no empty extra footer lines; active review progress remains visually below non-review extension status.

**Priority:** P2

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Pi local statusline render test](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1-AC2, AC5-AC7); [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts) (AC3-AC4 — repo-label resolution via rememberReviewRepo/recallReviewRepo, rememberActiveRepo/recallActiveRepo, and the guarded activeRepoSentinelForDisplay fallback)

**Status:** Implemented

---

### REQ-AGENT-057: Pi Review-Status Command

**Intent:** A Pi user needs a read-only way to see PR-boundary review enforcement state for the current repo — whether a review is running, why a merge is blocked, and what recently happened — without inspecting `.git/` by hand.

**Applies To:** User

**Acceptance Criteria:**

1. A `/review-status` command renders the canonical review state for the current repo's enforced head: PR / local / last-acked heads, per-lane status, overall verdict, summary readiness, monitor completion, breaker state, and the merge-gate verdict. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::formatReviewStatus --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::computeReviewState --> <!-- @test: src/__tests__/lib/review-command.test.ts (renderReviewStatus (REQ-AGENT-057 AC1): renders all canonical review-state fields) -->
2. The command is read-only: it never spawns a review, advances the ack, or mutates any enforcement state. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::review-status --> <!-- @test: src/__tests__/lib/review-command.test.ts (renderReviewStatus (REQ-AGENT-057 AC2): command is read-only and never mutates state) -->
3. The command appends a short tail of the decision audit log (`.git/codeflare-review-events.jsonl`) so recent enforcement decisions are visible inline. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::recentReviewEvents --> <!-- @test: src/__tests__/lib/review-command.test.ts (recentReviewEvents (REQ-AGENT-057 AC3): returns tail of the .git/codeflare-review-events.jsonl log) -->

**Constraints:**

- The command is diagnostic and must not block or alter agent execution when repository, PR, or review state cannot be read.

**Priority:** P2

**Dependencies:** [REQ-AGENT-055](#req-agent-055-pi-pr-boundary-review-window-advancement)

**Verification:** [Canonical review-state unit tests](../../src/__tests__/lib/review-state.test.ts) (AC1 state computation); [review-status command tests](../../src/__tests__/lib/review-command.test.ts) (AC1 rendering contract via `renderReviewStatus`, AC2 read-only/idempotency, AC3 audit-log tail via `recentReviewEvents`).

**Status:** Implemented

---

### REQ-AGENT-058: PR-Boundary Review Reconciliation and Missed-Event Recovery

**Intent:** Review initiation must not depend solely on capturing a transient tool event. A missed or mis-parsed boundary command must not silently skip review: an open enforced PR whose head was never reviewed is recoverable on a later turn, the start path is shared with the boundary path so the two cannot drift, and every near-miss leaves a durable diagnostic so a skipped review is detectable instead of silent.

**Applies To:** User

**Acceptance Criteria:**

1. Reconciliation reads fresh PR state on lifecycle ticks and after successful `git`/`gh` commands; transcript cursors keep the first complete post-cursor record and ignore incomplete JSONL. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reconcileOpenPrReview --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::completeTranscriptDelta --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::postCommandReconcileDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. An unacknowledged protected PR head advanced during the current session starts a durable review automatically. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::shouldReconcileOpenPr --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewInSessionContinuation --> <!-- @test: src/__tests__/lib/review-state.test.ts (reviewInSessionContinuation (boundaryActed primary, baseline backstop)) -->
3. An inherited protected PR head is offered once and remains merge-blocking until the user starts or skips review. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reconcileBoundaryAction --> <!-- @test: src/__tests__/lib/review-state.test.ts (noops on a re-offer of the same already-offered clone head (offered once, not twice)) -->
4. Boundary-command and reconciliation paths call one shared routine, so windows match in lanes, base, durable job, and audit trail. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ensureReviewWindow --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. Head resolution tolerates GitHub metadata lag only for a pushed local head on the PR branch. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::resolveEnforcedHead --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::enforcedHeadDecision --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (enforcedHeadDecision (REQ-AGENT-058 AC3)) -->
6. Skipped boundary candidates and PR-URL fallback events leave durable audit entries, so missed review starts are diagnosable. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::onToolEnd --> <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::appendReviewEvent --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prUrlFromText --> <!-- @test: src/__tests__/lib/review-state.test.ts (reviewInSessionContinuation (boundaryActed primary, baseline backstop)) -->
7. If an Agent/subagent tool advances the enforced PR head, Pi starts the same PR-boundary review even though the subagent's internal `git push` was not visible as a main-session Bash tool event. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::rememberAgentStartHead --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reconcileAgentHeadAdvance --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::isAgentSpawnerToolEvent --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::agentHeadAdvanceRequiresReview --> <!-- @test: src/__tests__/lib/review-state.test.ts (isAgentSpawnerToolEvent / agentHeadAdvanceRequiresReview (REQ-AGENT-058 AC7)) -->

**Constraints:**

- Reconciliation is gated on a real open enforced PR, never on branch existence; clone-only setup never becomes an autostart signal.
- Integration-branch PRs stay deferred until their own PR-to-`main`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-055](#req-agent-055-pi-pr-boundary-review-window-advancement)

**Verification:** Unit tests: [review-state.test.ts](../../src/__tests__/lib/review-state.test.ts), [review-trigger.test.ts](../../src/__tests__/lib/review-trigger.test.ts), [agent-seed-manifest.test.ts](../../src/__tests__/lib/agent-seed-manifest.test.ts). Runtime wiring is verified by inspection and the bundled-jiti harness.

**Status:** Implemented

---

### REQ-AGENT-059: Pi Durable Review Fix Loop

**Intent:** Pi operators need completed PR-boundary review findings to produce a visible overview and then start a fix pass by default, while still honoring an explicit user instruction to wait for approval.

**Applies To:** User

**Acceptance Criteria:**

1. Pi requests a fix pass only after every required exact-head lane result file exists, `summary.md` exists, no required lane failed, and at least one actionable `MEDIUM`/`HIGH`/`CRITICAL` finding remains. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. After `REVIEW_RESULT`, the main session first prints a detailed overview, then reads `summary.md`, verifies actionable findings, and fixes only legitimate findings by default. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::ENGINEERING_CONSTITUTION --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. If the latest user instruction says not to autofix, wait for approval, or do not push, the monitor result tells the main session to stop for approval instead of starting the fix pass. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Partial lane result sets, missing `summary.md`, or failed required lanes never trigger an autofix request. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. The fix loop is driven by the background review-monitor completion result, not by a hidden `autofix.requested` marker or custom summary announcement channel. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::startReviewMonitor -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-durable-review-status-and-result-formatting), [REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-060: Pi Durable Review Lane Tool Surface

**Intent:** Pi durable review lanes need enough bounded inspection capability to review diffs without loading recursive review enforcement or running local builds.

**Applies To:** User

**Acceptance Criteria:**

1. Durable review lanes run isolated from the parent Pi session so a lane can finish after the spawning session exits. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-060 AC6: durable review lanes load context-mode only when enabled, never subagents; graphify is a first-party local extension, not a package) -->
2. Durable review lanes start without stdin from the parent session. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-060 AC6: durable review lanes load context-mode only when enabled, never subagents; graphify is a first-party local extension, not a package) -->
3. Durable review lanes start without context files and do not recursively load the full Codeflare extension stack. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-060 AC6: durable review lanes load context-mode only when enabled, never subagents; graphify is a first-party local extension, not a package) -->
4. Durable review lanes expose bash for git/gh diff inspection. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-060 AC7: detached review lanes never consume the local-build bypass sentinel) -->
5. Durable review lanes expose graphify inspection tools. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-060 AC6: durable review lanes load context-mode only when enabled, never subagents; graphify is a first-party local extension, not a package) -->
6. Settings-enabled context-mode may add `ctx_search` to durable review lanes. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::laneExtensionSources --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-061: Pi Idle Durable Review Reaper

**Intent:** Pi must advance and finalize durable review jobs even when the user does not submit another prompt.

**Applies To:** User

**Acceptance Criteria:**

1. An idle Pi session with no user turn still reaps finished durable review lanes. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::autonomousReviewReaperTick -->
2. An idle Pi session starts the next eligible durable review lane after prerequisite lanes complete. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::autonomousReviewReaperTick --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. An idle Pi session finalizes completed durable reviews by saving the merged summary while the already-running background review-monitor delivers the result; Pi acknowledges and clears the pending window only after `monitor.completed` exists. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::startReviewMonitor --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-061: idle reaper helpers advance completed lanes to monitor-delivered summary) -->
4. Pi does not resurrect old acked review jobs after pending state is cleared; monitor delivery is tied to the active review window started by a real PR-boundary trigger. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::refreshReviewStatusFromDurable --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ensureReviewWindow -->
5. Ctx-bearing review routing accepts only direct Codeflare workspace children (`/home/user/workspace/<repo>`), preferring boundary/session repo, then current active repo, then remembered review repo; routing never uses the shared graphify active-cwd sentinel or arbitrary git-root walking. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::resolveReviewRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::workspaceRepoFromPath --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewRepoForCtx --> <!-- @test: src/__tests__/lib/review-state.test.ts (resolveReviewRepo (Codeflare workspace-child routing only)) -->
6. The no-ctx idle reaper iterates remembered review repos instead of applying single-repo routing precedence; persisted entries are accepted only while the workspace child still has a local `.git` directory. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::rememberReviewRepo --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::readPersistedReviewRepos --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::localHasGitDir --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::recallReviewRepos --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::autonomousReviewReaperTick --> <!-- @test: src/__tests__/lib/review-state.test.ts (REQ-AGENT-061: persisted recall ignores stale workspace-child paths without a .git directory) -->
7. Read-only `/review-status` may fall back to the guarded display sentinel only after review routing candidates fail. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewStatusRepo --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::liveReviewRow --> <!-- @test: src/__tests__/lib/review-state.test.ts (resolveReviewRepo (Codeflare workspace-child routing only)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-054](#req-agent-054-pi-durable-review-lane-failure-handling), [REQ-AGENT-059](#req-agent-059-pi-durable-review-fix-loop), [REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-062: Pi PR-Boundary Review Result Delivery

**Intent:** A completed PR-boundary review must reliably reach the main Pi session as a background-agent result with a visible overview, not just ack the head and write `summary.md` to disk. `review-monitor` is a background agent/subagent, not an extension. The Pi extension owns durable claim/completion files and asks the main session to spawn visible CI/review monitors for the exact head; the direct subagent service path is fallback-only when that handoff cannot be sent. Review execution and lane finalization live in [REQ-AGENT-054](#req-agent-054-pi-durable-review-lane-failure-handling)/[REQ-AGENT-061](#req-agent-061-pi-idle-durable-review-reaper); summary formatting in [REQ-AGENT-053](#req-agent-053-pi-durable-review-status-and-result-formatting).

**Applies To:** User

**Acceptance Criteria:**

1. Creating an active PR-boundary review window records at most one monitor claim per `(repo, head)` using durable claims and completion markers. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ensureReviewWindow --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::startReviewMonitor --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::claimReviewMonitorStart --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorCompletionReady --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorSpawnDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The monitor waits while any required lane marker is `running` or any required lane result file is missing. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-062: monitor waits for every required lane file and summary.md before reporting ready) -->
3. If every required lane result exists but `summary.md` is missing, the monitor writes the merged summary before reporting. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatMergedReviewSummary --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-062: monitor waits for every required lane file and summary.md before reporting ready) -->
4. After complete lane results and `summary.md` exist, the monitor writes `monitor.completed` JSON containing `repo`, `head`, `summaryPath`, `completedAt`, and result `clean` or `findings`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorCompletionReady --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorCompletionRecordReady --> <!-- @test: src/__tests__/lib/review-monitor-reliability.test.ts (reviewMonitorCompletionRejectReason (R3: diagnostic completion validation)) -->
5. A completion record with mismatched repo/head/summaryPath, invalid `result`, or stale/missing `completedAt` is rejected, deleted for retry, and only a valid record latches. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorCompletionReady --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorCompletionRejectReason --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorCompletionRecordReady --> <!-- @test: src/__tests__/lib/review-monitor-reliability.test.ts (reviewMonitorCompletionRejectReason (R3: diagnostic completion validation)) -->
6. Only an explicit required-lane `failed` marker can produce `REVIEW_RESULT failed` before completion. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- The monitor receives all needed state in its explicit prompt and must not inherit parent context.
- The monitor polls with a low-turn strategy for up to 30 minutes.

**Priority:** P1

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-durable-review-status-and-result-formatting)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts); [review-state tests](../../src/__tests__/lib/review-state.test.ts); [review-monitor reliability tests](../../src/__tests__/lib/review-monitor-reliability.test.ts). The background subagent completion notification and main-session autofix handoff are Pi runtime integration paths verified by load-check plus live smoke/adversarial review.

**Status:** Implemented

---

### REQ-AGENT-077: Pi PR-Boundary Review Fallback and Claim Recovery

**Intent:** Manual result fallback and dead-monitor reclaim must preserve PR-boundary review delivery when the visible monitor path cannot complete.

**Applies To:** User

**Acceptance Criteria:**

1. `/review-results` remains a manual fallback that displays the saved `summary.md` for the current exact head without mutating delivery state, relying on nonce/announcement records, or claiming the head was acknowledged. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewResultsSummaryMessage --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::formatMergedReviewSummary --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-077 AC1: manual review-results display does not claim acknowledgement) -->
2. When a monitor claim's tracked agent is terminal (per the subagents service) with no completion latched, the extension reclaims the claim before its TTL so the next active-run reaper re-spawns a fresh monitor rather than the review staying stuck until the TTL elapses. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reclaimStaleReviewMonitorClaim --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorLiveness --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorClaimReclaimEarly --> <!-- @test: src/__tests__/lib/review-monitor-reliability.test.ts (reviewMonitorClaimReclaimEarly (reclaim before TTL only on provable death with no completion)) -->

**Constraints:**

- The fallback remains read-only and never mutates monitor delivery state.
- A monitor claim is reclaimed early only when the tracked agent is provably terminal and no valid completion has latched.

**Priority:** P1

**Dependencies:** [REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts); [review-monitor reliability tests](../../src/__tests__/lib/review-monitor-reliability.test.ts). Runtime fallback/reclaim wiring is verified by live smoke/adversarial review.

**Status:** Implemented

---

### REQ-AGENT-063: PR-Boundary Command Parsing

**Intent:** PR-boundary trigger code needs a deterministic shell-command parser that recognizes real boundary commands across Pi tool surfaces without treating source-code literals or PR body text as commands.

**Applies To:** User

**Acceptance Criteria:**

1. Command text is extracted only from shell execution surfaces: Bash `.command`, `ctx_execute` shell `.code`, and `ctx_batch_execute` `.commands[].command`. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::commandTextFromEvent --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. Local push parsing recognizes `git push`, `git -C <repo> push`, ssh/https remotes, environment-prefix forms, command wrappers, and local `cd <repo>` prefixes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGitPushOnlyCommand --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::cwdFromBoundaryCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->
3. GitHub CLI parsing recognizes `gh pr create`, `gh pr merge`, `gh pr update-branch`, `gh repo sync`, and protected-base `gh pr edit`, including edit commands with value-bearing flags before the PR selector. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isPrBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prEditBoundaryBase --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prEditCommandTarget --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (isPrBoundaryTrigger) -->
4. Here-doc bodies are stripped before command tokenization so markdown PR bodies cannot hide a following boundary command. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::stripHeredocs --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (isPrBoundaryTrigger) -->
5. Non-advancing push forms (`--dry-run`, `-n`, `--delete`, `-d`, tag-only pushes, and delete-only refspecs) are excluded. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::gitPushCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isGitPushOnlyCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->
6. Quoted text and non-shell tool bodies containing boundary-looking strings are ignored. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::commandTextFromEvent -->
7. Command wrappers are parsed structurally rather than with wrapper-heavy regular expressions. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::unwrapCommandWords --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

None.

**Priority:** P1

**Dependencies:** None

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-064: Connect to Cloudflare via OAuth

**Intent:** In non-enterprise modes a user connects their own Cloudflare account via OAuth — mirroring the GitHub connect — so the per-user deploy token is obtained without pasting a dashboard-created API token. One operator-registered OAuth client serves every user; each user authorizes their own account.

**Applies To:** User

**Acceptance Criteria:**

1. `CloudflareOAuthProvider` supports authorize, exchange, refresh, and revoke; encrypted OAuth credentials reuse the bucket deploy-key fields without a new key. Exchanges use `client_secret_post` and surface Cloudflare `error_description` on failure. <!-- @impl: src/lib/cloudflare-token.ts::postToken --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (CloudflareOAuthProvider) -->
2. `GET /api/cloudflare/connect`, its callback, and `POST /api/cloudflare/disconnect` are gated by authentication only (any authenticated user) — reachable from Guided Setup and the Settings accordion, never tier-gated — and the token never reaches the browser. <!-- @impl: src/routes/cloudflare.ts::app --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (GET /auth/cloudflare/connect/callback) -->
3. The callback binds an HMAC-signed, single-use state to the initiating user's bucket; a forged, expired, or replayed state is rejected without exchanging the code. On success it stores the token and auto-selects the account when exactly one is accessible, else redirects to an account picker. <!-- @impl: src/lib/cloudflare-token.ts::connectCloudflare --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (GET /auth/cloudflare/connect/callback) -->
4. `getValidCloudflareToken` returns a currently-valid token, refreshing within the skew window and failing closed (never a stale token); the resolved token is injected into the container env via `applyCloudflareOAuthToken` on session start. <!-- @impl: src/lib/cloudflare-token.ts::getValidCloudflareToken --> <!-- @impl: src/lib/cloudflare-token.ts::applyCloudflareOAuthToken --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (getValidCloudflareToken) -->
5. The connect URL carries a scope `tier`; the server maps it to the OAuth `scope`, always including `offline_access` so a refresh token is issued. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (feeds the scope tier into the OAuth authorize scope param (always incl. offline_access)) -->
6. The operator's Cloudflare OAuth client id + secret are configured in the admin-gated Setup wizard (KV; id plain, secret encrypted at rest, fail-closed without `ENCRYPTION_KEY`), mirroring the GitHub provider config ([REQ-GITHUB-008](github.md#req-github-008-enterprise-github-provider-configuration-via-setup)). <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
7. Enterprise is unchanged: `getCloudflareProvider` returns null in enterprise, so every Cloudflare-OAuth route fails closed there; enterprise keeps the admin-global Browser Rendering token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)). <!-- @impl: src/lib/cloudflare-token.ts::getCloudflareProvider --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (applyCloudflareOAuthToken (REQ-AGENT-078: injects the placeholder, real token never in the container)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- One OAuth client per operator account; each user authorizes their own Cloudflare account.
- The operator's OAuth client must be registered with `token_endpoint_auth_method = client_secret_post`.
- Cloudflare's client-secret **rotation is broken** (Cloudflare-side bug): only the secret returned at client *creation* authenticates.
- The exact OAuth scope set must be granted on the operator's client — see the [Configuration](../../documentation/lanes/configuration.md) lane and verify against `GET /client/v4/oauth/scopes`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-029](#req-agent-029-deploy-credential-propagation-to-container)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-078: Cloudflare OAuth token refreshed at the `api.cloudflare.com` boundary

**Intent:** A Cloudflare-dashboard OAuth **access token** is short-lived by design (expires in hours), so baking it into the container as `CLOUDFLARE_API_TOKEN` at start left a running non-enterprise session broken after expiry — `wrangler` and browser-run both got `9109 Invalid access token`, with nothing refreshing the container's env var. Instead of baking the real token, inject a non-secret placeholder and intercept `api.cloudflare.com` at the container-egress boundary, stamping a **freshly refreshed** token per request. This reuses the enterprise Browser Rendering interceptor's transport ([REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)) — one interceptor per host, serving two modes — rather than adding a new class, a container-side refresher, or new storage.

**Applies To:** User

**Acceptance Criteria:**

1. When the session's Cloudflare token source is `'oauth'`, the container receives only a non-secret placeholder (`CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER`) as `CLOUDFLARE_API_TOKEN` — the real access token never enters the container env. A non-oauth source (PAT / enterprise) is passed through untouched. <!-- @impl: src/lib/cloudflare-token.ts::applyCloudflareOAuthToken --> <!-- @impl: src/lib/constants.ts::CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (applyCloudflareOAuthToken (REQ-AGENT-078: injects the placeholder, real token never in the container)) -->
2. In OAuth sessions (non-enterprise, oauth source only) `api.cloudflare.com` is intercepted and every request — on every path — is re-stamped with `getValidCloudflareToken(bucket)`, which refreshes within the skew window, so the forwarded credential is the refreshed token, not the baked placeholder. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @impl: src/container/index.ts::wireCloudflareApiInterception --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (stamps a FRESH refreshed token on ANY api.cloudflare.com path (e.g. wrangler), egress DIRECT) -->
3. Both the REST surface and the CDP WebSocket upgrade (browser-run) are stamped and forwarded via the shared `relay()` / `bridge()` transport, so a session survives past the access-token lifetime for wrangler **and** interactive browser-run. <!-- @impl: src/cloudflare-browser-interceptor.ts::bridge --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (bridges the CDP upgrade with the fresh token, returning a FRESH client socket, direct not Gateway) -->
4. The token is resolved **solely** from the session-bound bucket (`props.bucket`), never from any request-supplied header — no cross-user token spoofing — and the interceptor fails closed with `401` and no upstream call when no valid token can be minted. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-AGENT-078: CloudflareBrowserInterceptor OAuth mode (non-enterprise) — REST) -->
5. AI Gateway data-plane requests (`gateway.ai.cloudflare.com`) are intercepted in OAuth mode and stamped with the refreshed token as `cf-aig-authorization` (the token's `aig.run` scope), leaving the caller's `Authorization` untouched, so a connected user's authenticated AI Gateway survives past the token lifetime. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @impl: src/cloudflare-browser-interceptor.ts::INTERCEPTED_CF_OAUTH_HOSTS --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-AGENT-078: OAuth mode — AI Gateway data-plane (gateway.ai.cloudflare.com)) -->
6. In an OAuth session the container trusts the platform-mounted intercept CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) so the intercepted `api.cloudflare.com` / `gateway.ai.cloudflare.com` TLS validates in agent runtimes instead of failing `SELF_SIGNED_CERT_IN_CHAIN`. <!-- @impl: entrypoint.sh::CF_OAUTH_CA_SRC --> <!-- @test: host/__tests__/entrypoint-oauth-ca-trust.test.js (REQ-AGENT-078 AC6: non-enterprise OAuth intercept-CA trust (entrypoint.sh)) -->

**Constraints:**

- Enterprise is untouched: `wireCloudflareApiInterception` is double-guarded (`!isEnterpriseMode` **and** placeholder-value match), so it can never wire or collide on `api.cloudflare.com` in enterprise; the enterprise branch is unchanged.
- The AI Gateway host lives only in `INTERCEPTED_CF_OAUTH_HOSTS` (never the enterprise browser list), so enterprise never intercepts its own `LlmInterceptor` gateway rewrites.
- `CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER` must stay distinct from `ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER` — the placeholder value is itself the DO's OAuth-mode wiring signal.
- The GitHub interceptor is not touched — non-enterprise git stays direct (GitHub tokens are long-lived); `api.cloudflare.com` and `gateway.ai.cloudflare.com` are the only hosts newly intercepted (OAuth-mode only).
- The AC6 CA-trust is an isolated `entrypoint.sh` sibling of the enterprise CA-trust: distinct `CF_OAUTH_CA_SRC` var + `# cf-ca-trust` sentinel, gated `ENTERPRISE_MODE != active` && CA-present, so enterprise never enters it and a no-interception deploy (no CA file) is byte-identical to before.

**Priority:** P1

**Dependencies:** [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container), [REQ-SEC-002](security.md#req-sec-002-api-tokens-never-enter-containers)

**Verification:** [Interceptor test](../../src/__tests__/cloudflare-browser-interceptor.test.ts) + [Lib test](../../src/__tests__/lib/cloudflare-token.test.ts) + [OAuth CA-trust test](../../host/__tests__/entrypoint-oauth-ca-trust.test.js)

**Status:** Implemented

---

### REQ-AGENT-079: Advanced Cloudflare OAuth Tier Scope Catalog

**Intent:** The advanced Cloudflare OAuth tier requests the operator-finalized full-platform capability set, maintained as a single server-side catalog and pinned by a test so the connect flow, the tier tables, and the operator's registered client cannot silently drift — as they did when the catalog carried only 21 scopes while the docs described the full set and no test tied the two together.

**Applies To:** User

**Acceptance Criteria:**

1. `cloudflareScopeForTier('advanced')` requests exactly the finalized 60 operator-verified Cloudflare scopes — including the full AI family (Workers AI, AI Gateway `aig.*`, Agents Gateway `agw.*`, AI Search, AI Audit, Firewall for AI, Websearch) — plus `user-details.read` and the always-appended `offline_access`. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->
2. The advanced tier is a superset of recommended: it keeps the combined `zone-access.write`/`access-acct.write` and adds the granular Access ids (`access-app`/`access-policy`/`access-org`/`access-idp`/`access-group`), so every recommended (and every minimal) scope is present in advanced. <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-AGENT-079: cloudflareScopeForTier advanced-tier scope catalog) -->
3. `Logs: Edit` resolves to `logs.write` and `Firewall (Magic): Edit` to `magic-firewall.write`; three requested capabilities have no OAuth scope and are intentionally absent. <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->

**Constraints:**

- The operator's OAuth client must be registered with the full advanced superset; a per-connect request can only narrow within the registered scopes.
- The server-side catalog is the single source of truth; the public ([Configuration](../../documentation/lanes/configuration.md)) and private tier tables mirror it.

**Priority:** P2

**Dependencies:** [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** [Automated test](../../src/__tests__/lib/oauth-scopes.test.ts)

**Status:** Implemented

---

### REQ-AGENT-065: Engineering Constitution Preseeded to All Agents

**Intent:** One always-on engineering constitution is hardwired into every preseed-managed agent so its four mandates are applied to all planning and coding without being restated each task: (1) no overengineering, (2) behavioral tests only — no theater or text-matching, (3) reusable/composable components and best practices, (4) SDD + TDD enforced (failing behavioral test first, every change traces to a REQ, specs/anchors/docs move with the code, nothing left `Partial`). It also imposes a **plan gate** (every plan must restate the four mandates as concrete success criteria) and a **done gate** (confirm them before declaring work complete). The preseed is the single source of truth; the per-user `~/.claude` copy is a downstream seed artifact.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode, the constitution is seeded as a Claude rule — the preseed rule file is present and the seed manifest gates it to `advanced` only, matching the other engineering rules ([REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)). <!-- @test: host/__tests__/engineering-constitution.test.js (seeds the Claude constitution rule, gated to advanced mode) -->
2. The constitution is injected into every Pi agent system prompt on `before_agent_start` as an always-on, self-contained `<codeflare_constitution>` block (placed in the base prompt parts, not behind a conditional), so it is present in every Pi session. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::ENGINEERING_CONSTITUTION -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The preseed is the single source of truth; the per-user `~/.claude/rules/engineering-constitution.md` is a downstream seed artifact, not separately authored.
- The Claude rule and the Pi `<codeflare_constitution>` block carry the same four mandates and must be kept in sync.
- Mode parity with the other engineering rules (advanced session mode); content correctness is prose and is intentionally not pinned by tests (mandate #2).

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-066: PR-Boundary Command Targeting and Failure Recovery

**Intent:** Once [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing) identifies a boundary-shaped command, Pi must recover the exact PR/head that command targeted and must ignore failed tool executions. This keeps review windows attached to the PR the user actually advanced instead of the current checkout.

**Applies To:** User

**Acceptance Criteria:**

1. Explicit PR edit, update-branch, create, and push-refspec commands review the selected PR branch/head instead of the current checkout; owner-qualified create heads are not synthesized from local refs. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prEditCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prUpdateBranchCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::prCreateCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::gitPushCommandTarget --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::boundaryFallbackHead --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::handlePrBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::headForCreateBranch --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->
2. Compound shell commands use the same protected-boundary segment for trigger and target. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::boundaryTriggerCommandEntries --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::handlePrBoundaryCommand --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->
3. Batched command extraction prefers the first real PR-boundary trigger over broader non-trigger boundary words, so an earlier non-protected create or merge gate command cannot hide a later protected push/create/edit. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::commandTextFromEvent --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::commandTextsFromEvent --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->
4. Failed tool execution detection treats failed/failure statuses and nonzero exit codes as failed boundaries, so a failed push cannot create review state. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isFailedToolExecution --> <!-- @test: src/__tests__/lib/review-trigger.test.ts (command target parsing for PR-boundary recovery (REQ-AGENT-063 / REQ-AGENT-066)) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing)

**Verification:** [`review-trigger.test.ts`](../../src/__tests__/lib/review-trigger.test.ts)

**Status:** Implemented

---

### REQ-AGENT-067: consult-llm Invocation and Model-Selection Behavior

**Intent:** consult-llm must only run when the user explicitly asks for external LLM input, and model selection must be explicit without leaking provider keys.

**Applies To:** User

**Acceptance Criteria:**

1. The skill is invoked only when the user's current request asks for external LLMs or names GPT, ChatGPT, Gemini, OpenAI, or `consult_llm`. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
2. Without a named model, the agent asks one model-selection question with latest Gemini, latest OpenAI, both, list-all, and the tool-provided write-in option. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
3. The list-all path reads concrete Gemini/OpenAI model IDs from the consult-llm startup log, not from provider selectors. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
4. Latest-model choices use server-side `"openai"` / `"gemini"` selectors and never perform provider model-list HTTP requests with raw keys. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
5. When the user names a specific model, no dialog is shown and that exact ID is passed. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Generic "second opinion" wording is not enough unless the user names external LLMs.
- Exact model discovery may fall back to clearly labelled provider selectors if the startup log is unreadable.

**Priority:** P1

**Dependencies:** [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-068: CI Monitoring Background-Agent Policy

**Intent:** Pi agents must monitor CI whenever a PR to `main`/`master` is open — the CI monitor is spawned together with the `review-monitor` from the PR-boundary handoff (one shared trigger), so no second per-push CI monitor is started and the two can never collide — without blocking the main session or turning the monitor into an implementation worker. A push with no open main-bound PR is not CI-monitored. Claude keeps its baseline (on-demand, per-push) git workflow rule.

**Applies To:** Agent

**Acceptance Criteria:**

1. When a Pi push or PR opens or syncs a PR to `main`/`master`, an exact-head CI monitor is spawned together with the `review-monitor` from the PR-boundary handoff and kept active until `CI_RESULT`, unless skipped or superseded. <!-- @impl: preseed/agents/pi/rules/git-workflow.md::git-workflow-ci-route --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::visibleMonitorHandoffRequest --> <!-- @impl: preseed/agents/pi/skills/ci-monitoring/SKILL.md::ci-monitor-detached-script --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-074: visible monitor handoff requests review and CI monitors for the exact head) -->
2. The CI monitor reports success only after every workflow row for the monitored HEAD is complete and the workflow/run-id fingerprint is stable. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/SKILL.md::ci-monitor-detached-script --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-068 AC2: ci monitor waits for a stable workflow/run set before success) -->
3. If the local branch ref no longer points at the monitored HEAD before any terminal success/failure, the monitor reports `CI_RESULT timeout superseded` instead of success/failure for the stale head. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/SKILL.md::ci-monitor-detached-script --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-068 AC3: ci monitor re-checks superseded status before terminal success) -->
4. CI failures are report-only: the background agent reports the failed workflow/run/log pointer and never fixes, commits, or pushes. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/SKILL.md::ci-monitor-detached-script --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-068 AC4: ci monitor reports failed workflow rows) -->
5. Long-running waits, monitors, or polls never keep the main session busy; agents start backgrounded work, report how to check it, and stop. <!-- @impl: preseed/agents/pi/rules/git-workflow.md::git-workflow-hard-obligations --> <!-- @impl: preseed/agents/pi/skills/ci-monitoring/SKILL.md::ci-monitor-detached-script --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-068 AC1/AC5: ci monitor launcher starts detached work and returns immediately) -->
6. After `CI_RESULT`, the main session prints the CI summary before any other work. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::ENGINEERING_CONSTITUTION --> <!-- @impl: preseed/agents/pi/rules/git-workflow.md::git-workflow-hard-obligations --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. The native Pi CI monitor queries GitHub Actions by exact pushed HEAD and reports a timeout blocker when GitHub CLI access fails or no workflow rows appear for that HEAD within five minutes. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/SKILL.md::ci-monitor-detached-script --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- For Pi, when a main-bound PR is open, an explicit user skip instruction is the only reason to skip CI monitoring; a push with no open main-bound PR is intentionally not monitored.
- Pi CI monitoring shares the PR-boundary trigger with the `review-monitor` ([REQ-AGENT-074](#req-agent-074-pi-visible-review-and-ci-monitor-handoff)): it is spawned together with it from the handoff and not per-push, so there is never a second CI monitor to collide with the handoff's.
- Pi receives native `git-workflow` and `ci-monitoring` files from the Pi manifest in every mode; it does not inherit the Claude git-workflow or Claude-transformed CI skill.
- The main session owns any fix, commit, or push after a reported CI failure.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** [Agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [CI monitoring skill tests](../../host/__tests__/ci-monitoring-skill.test.js)

**Status:** Implemented

---

### REQ-AGENT-069: Pi consult-llm MCP lazy wiring

**Intent:** Pi must reach consult-llm through the MCP adapter without starting `consult-llm-mcp` until the user explicitly asks for external LLM input.

**Applies To:** User

**Acceptance Criteria:**

1. Pi reads `consult-llm` from `~/.pi/agent/mcp.json` through the pi-mcp-adapter `mcp` proxy. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (REQ-AGENT-069: Pi mcp.json mirrors the server through the lazy mcp proxy) -->
2. The Pi `consult-llm` entry uses `lifecycle:"lazy"`, so `consult-llm-mcp` starts on proxy use rather than session start. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (REQ-AGENT-069: Pi mcp.json mirrors the server through the lazy mcp proxy) -->
3. Each container start replaces Codeflare's owned `mcpServers["consult-llm"]` object, removing stale `keep-alive` and `directTools` fields. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (replaces only the owned consult-llm entry and stays idempotent across starts) -->
4. The replacement preserves unrelated user MCP servers in the same file. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->

**Constraints:**

- The Claude server carries no Pi-only `lifecycle` field.
- Pi's native consult skill must call through `mcp`, not through a promoted direct tool.

**Priority:** P1

**Dependencies:** [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity), [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior)

**Verification:** [entrypoint consult-llm host test](../../host/__tests__/entrypoint-consult-llm.test.js)

**Status:** Implemented

---

### REQ-AGENT-070: Claude on-demand CI monitoring policy

**Intent:** Claude and Claude-transformed agents monitor CI only when a user asks or a deploy/merge decision needs a fresh result.

**Applies To:** Agent

**Acceptance Criteria:**

1. Routine pushes do not auto-start Claude `ci-monitoring`. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. Claude invokes `ci-monitoring` only when the user explicitly asks or a deploy/merge gate needs a fresh result. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. The Claude monitor uses a durable temp-script launcher that prints the monitored head, pid, and log path before detaching. <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC3: Claude ci monitor launcher starts detached work and returns a durable log path) -->
4. Claude success requires a non-empty workflow/run fingerprint to stay stable across two polls. <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC4: Claude ci monitor waits for a stable workflow/run set before success) -->
5. Claude writes terminal failure and timeout result lines to the durable log when workflow rows fail or GitHub CLI access is unavailable. <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC5: Claude ci monitor reports failed workflow rows) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- This does not change Pi's PR-boundary CI-monitoring trigger in [REQ-AGENT-068](#req-agent-068-ci-monitoring-background-agent-policy).

**Priority:** P1

**Dependencies:** [REQ-AGENT-068](#req-agent-068-ci-monitoring-background-agent-policy)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-071: PR-Boundary Review Agent Dispatch

**Intent:** Once lane classification ([REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)) determines the required review agents, the initial review wave starts every required report-only lane together and in parallel, suppresses re-summoning per lane while a spawn is in flight (bounded by transcript recency), and scopes each follow-up re-review to the incremental window so a round inspects only new commits.

**Applies To:** User

**Acceptance Criteria:**

1. The initial review wave starts every required lane together (`code-reviewer`, `spec-reviewer`, and `doc-updater`) — all three reviewers are report-only and write to disjoint lane files, so there is no inter-lane ordering. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewInitialLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. `doc-updater` dispatches in parallel with `spec-reviewer`, not after it: every required lane is eligible immediately, since the reviewers report findings to a triage file and the main session applies fixes — no shared-write race. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::durableReviewEligibleLanes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Review agents are dispatched with `run_in_background: true` so the main session stays interactive; the turn-end gate suppresses re-summoning per lane, so a slow in-flight lane never masks demand for other lanes nor satisfies acknowledgement without current-head completion. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_in_flight --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::all_required_lanes_completed_for_current_head --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (suppresses an in-flight lane without masking missing peer lanes) -->
4. In-flight suppression is bounded by transcript recency: an uncompleted spawn that falls behind the transcript tail is treated as orphaned, demanded again, and cannot suppress its lane indefinitely. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_in_flight --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (re-demands an orphaned in-flight lane after the transcript recency bound) -->
5. After the first acknowledged review, a follow-up review is dispatched scoped to the incremental window (last-acked clean head -> current head), so a re-review inspects only the new commits instead of re-reviewing the entire PR each round. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewPrompt --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::docUpdaterPrompt --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- The agent must not push to the PR branch or start a second review wave while any required review lane is in flight.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Lane classifier tests](../../host/__tests__/lane-classifier.test.js), [Stop-hook behavioral tests](../../host/__tests__/enforce-review-spawn.test.js), [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-072: Pi Durable Review Lane Command and Scope Guards

**Intent:** Pi durable review lanes must not run local builds, tests, lint, or dev servers, and — once a prior clean head is acknowledged — must stay confined to the incremental review window so a lane cannot widen its diff back to the full PR. Tool surface and isolation are defined in [REQ-AGENT-060](#req-agent-060-pi-durable-review-lane-tool-surface).

**Applies To:** User

**Acceptance Criteria:**

1. Durable review lane guards block local build, test, lint, and dev-server commands. <!-- @impl: preseed/agents/pi/extensions/review-lane-guards.ts::reviewLaneBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
2. When a prior clean head was acknowledged, durable review lanes are confined to the incremental window: `spawnDurableLane` exports `CODEFLARE_REVIEW_BASE` / `CODEFLARE_REVIEW_HEAD` / `CODEFLARE_REVIEW_BASE_REF`, and the lane guard blocks `gh pr diff` and any `git diff` ranging (two- or three-dot) against the base branch. <!-- @impl: preseed/agents/pi/extensions/review-jobs.ts::spawnDurableLane --> <!-- @impl: preseed/agents/pi/extensions/review-lane-guards.ts::reviewScopeBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-060](#req-agent-060-pi-durable-review-lane-tool-surface)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-073: Pi Review Monitor Delivery Reliability

**Intent:** PR-boundary review result delivery ([REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery)) must survive monitor-startup and spawn-return failure modes: a startup failure hands the main session a one-shot fallback prompt, a reload can acknowledge a completed review even after pending state is gone, spawn returns are normalized across subagent-service versions, and an undelivered review is bounded by a give-up clock so it never blocks merge forever.

**Applies To:** User

**Acceptance Criteria:**

1. Extension-owned monitor startup failure sends the main session a one-shot fallback message containing the exact `review-monitor` prompt. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendReviewMonitorFallbackMessage --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorStartupFailureMessage --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-062: monitor startup failure message gives the main session a fallback monitor prompt) -->
2. Reload/status refresh consumes a valid exact-head `monitor.completed` marker even when `.git/sdd-review-pending.json` is already gone, writing the ack and clearing stale breaker state instead of leaving the footer/merge gate stuck. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReviewWithoutPending --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pendingFromDurableJob --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. The subagents-service spawn return is normalized across versions: a bare string, or an object carrying `agentId`, `id`, or `agent_id`, resolves to the agent id. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::resolveSpawnedAgentId --> <!-- @test: src/__tests__/lib/review-monitor-reliability.test.ts (resolveSpawnedAgentId (R1: untyped subagents-service spawn return)) -->
4. Missing monitor completion cannot wait forever: live claims time out from monitor spawn against the polling TTL; pre-claim waits start after the lane budget. Timeout opens the breaker, exposes `/review-results`, notifies the user, clears pending state, and keeps merge blocked. <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewDeliveryGiveUp --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewCompletionDeliveryStalled --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorStartedAt --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::finalizeCompletedReview --> <!-- @test: src/__tests__/lib/review-monitor-reliability.test.ts (reviewDeliveryGiveUp (give-up clock anchored to monitor spawn, not review-window start)) -->

**Constraints:**

- The monitor receives all needed state in its explicit prompt and must not inherit parent context.
- A monitor startup failure keeps the durable monitor claim unless the fallback message cannot be sent.

**Priority:** P1

**Dependencies:** [REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery)

**Verification:** [Pi review helper behavior tests](../../src/__tests__/lib/agent-seed-manifest.test.ts); [review-state tests](../../src/__tests__/lib/review-state.test.ts). The background subagent completion notification and main-session autofix handoff are Pi runtime integration paths verified by load-check plus live smoke/adversarial review.

**Status:** Implemented

---

### REQ-AGENT-074: Pi Visible Review and CI Monitor Handoff

**Intent:** After a PR-boundary review starts, the main Pi session must own visible background monitor tasks for both review delivery and CI so failures can be seen and restarted. The handoff is the **single** trigger for both monitors, so CI is not also spawned per-push — the previous double-spawn (git-workflow per-push CI plus the handoff's CI) collided as "Agent is already processing a prompt" and killed the first CI monitor.

**Applies To:** Agent

**Acceptance Criteria:**

1. Review startup sends a main-session follow-up containing exact-head `review-monitor` and CI monitor requests; this handoff is the single spawn trigger for both. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendVisibleMonitorHandoff --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::visibleMonitorHandoffRequest --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-074: visible monitor handoff requests review and CI monitors for the exact head) -->
2. If the visible handoff cannot be sent, Pi may start one hidden fallback monitor without creating duplicate durable claims. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::startReviewMonitor --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::BACKGROUND_SUBAGENT_SPAWN --> <!-- @impl: preseed/agents/pi/extensions/review-job-helpers.ts::reviewMonitorSpawnDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-074: visible monitor handoff requests review and CI monitors for the exact head) -->
3. After a main/master SDD PR opens or syncs, the main session obeys the handoff by spawning missing exact-head monitors. <!-- @impl: preseed/agents/pi/rules/git-workflow.md::git-workflow-hard-obligations -->
4. The main session reports visible monitor agent IDs for the exact head after spawning them. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-074: visible monitor handoff requests review and CI monitors for the exact head) -->
5. The main session restarts any CI/review monitor task that stops or completes without `CI_RESULT`/`REVIEW_RESULT`. <!-- @impl: preseed/agents/pi/rules/git-workflow.md::git-workflow-hard-obligations --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-074: visible monitor handoff requests review and CI monitors for the exact head) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Visible monitor handoff is review result delivery, not reviewer lane spawning.
- Durable monitor claims remain the duplicate-suppression source of truth.
- The handoff is the sole trigger for the CI monitor as well as the `review-monitor`; no separate per-push CI monitor is started ([REQ-AGENT-068](#req-agent-068-ci-monitoring-background-agent-policy)), so the two never collide.
- Both review-monitor prompt sources pin polling near 10 seconds, preventing arbitrary multi-minute sleeps and delivering completed lane results within about 10 seconds. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewMonitorPrompt --> <!-- @impl: preseed/agents/pi/agents/review-monitor.md::sleep -->

**Priority:** P1

**Dependencies:** [REQ-AGENT-062](#req-agent-062-pi-pr-boundary-review-result-delivery), [REQ-AGENT-068](#req-agent-068-ci-monitoring-background-agent-policy)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-075: Cloudflare Platform Skills Bundled into the Advanced Seed

**Intent:** Codeflare is a Cloudflare-native build platform AND an enterprise Zero Trust product, so the official Cloudflare skills ([github.com/cloudflare/skills](https://github.com/cloudflare/skills), Apache-2.0) are vendored into the advanced-mode agent seed via the existing manifest pipeline ([REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)) — giving Pro agents authoritative, retrieval-first guidance for Workers/KV/D1/R2, the Agents SDK, Durable Objects, Wrangler, Turnstile, email, web performance, and Cloudflare One (Zero Trust / SASE). The bundle is **slimmed for the Worker bundle budget**: the cloudflare mega-skill's 319-file `references/` tree is dropped (it is retrieval-first — agents fetch live docs), keeping only its decision-tree `SKILL.md`. The bundled remote-MCP config is excluded (strict-egress + interactive OAuth incompatible); retrieval is via WebFetch of `developers.cloudflare.com`.

**Applies To:** Agent

**Acceptance Criteria:**

1. All 11 Cloudflare skills (`cloudflare`, `cloudflare-one`, `cloudflare-one-migrations`, `wrangler`, `workers-best-practices`, `durable-objects`, `agents-sdk`, `sandbox-sdk`, `turnstile-spin`, `cloudflare-email-service`, `web-perf`) plus the `cloudflare-build-agent`/`cloudflare-build-mcp` commands are seeded to advanced-mode agents (Claude + the non-Claude agents via the shared pipeline) and gated `advanced`-only; default mode receives none. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (default mode receives NONE of the Cloudflare skills (advanced/Pro-only)) -->
2. The cloudflare mega-skill is slimmed: its `SKILL.md` decision tree is kept (with the dangling `references:` frontmatter removed) but the `references/` tree is NOT bundled, so the Worker bundle does not carry ~2.2 MB × every agent of retrieval-first reference markdown. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (SLIMS the cloudflare mega-skill: SKILL.md is kept, the references/ tree is NOT bundled) -->
3. Doc retrieval is via WebFetch of `developers.cloudflare.com`: a `paths:`-scoped `rules/cloudflare-workers.md` (loaded only on Workers files, not always-on) carries the retrieval-first guidance, and the upstream remote-MCP config (`.mcp.json`) is NOT bundled. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (the Workers retrieval rule is path-conditional (not always-on) and WebFetch-oriented) -->
4. The upstream Apache-2.0 `LICENSE` is vendored alongside the skills for attribution. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (carries the upstream Apache-2.0 LICENSE alongside the vendored skills (attribution)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Bundled via the manifest pipeline ([REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)); the per-user seed is a downstream artifact, never separately authored; Skill bodies/references load on demand (progressive disclosure), so the always-on token cost is only the trimmed one-line descriptions.
- In enterprise strict-egress ([REQ-ENTERPRISE-016](enterprise-mode.md#req-enterprise-016-strict-gateway-egress)), the operator must allowlist `developers.cloudflare.com` for the skills' retrieval to function (documented in the configuration + security lanes).
- Skill/command/rule prose is upstream-authored and intentionally not pinned by tests (mandate #2); tests assert bundling, mode-gating, slimming, and attribution — the contract — not copy.

**Priority:** P2

**Dependencies:** [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-076: Pi Context-Mode Enablement and Tool-Extension Defaults

**Intent:** Pi's own default runtime behavior — independent of which Pro/Standard content [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) delivers — must stay predictable and crash-free out of the box: context-mode is enabled by default for Pi (with Custom-tier's automatic context-window-reduction in Claude Code remaining tier-gated), the five always-on Pi tool extensions install without duplication, context-mode's own npm update-check probe is neutralized at build time, and `web_search` defaults to a workflow that never reaches an upstream `pi-web-access` crash path.

**Applies To:** User

**Acceptance Criteria:**

1. Pi starts with context-mode ENABLED by default — its `ctx_*` tools and the bash-curl-redirect hook are active without `/ctx on`. The Codeflare Pi extension also provides `/ctx status` and `/ctx off`, disabling it for the session; the next container start resets Pi to enabled. <!-- @impl: entrypoint.sh::CONTEXT_MODE_VERSION --> <!-- @test: host/__tests__/entrypoint-context-mode.test.js (entrypoint context-mode preseed gate / REQ-AGENT-005 + REQ-AGENT-076 (context-mode MCP registration)) -->
2. Custom-tier Claude Code users may receive context-mode's automatic context-window-reduction behavior; downgrades, non-Pro mode, and Pi remove it on the next reconcile. <!-- @impl: src/lib/r2-seed.ts::getConfigsForMode --> <!-- @test: host/__tests__/entrypoint-context-mode.test.js (entrypoint context-mode preseed gate / REQ-AGENT-005 + REQ-AGENT-076 (context-mode MCP registration)) -->
3. The Pi preseed installs five always-on tool extensions in the settings `required` set: `@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `pi-web-access`, and `pi-mcp-adapter`. <!-- @test: host/__tests__/pi-settings-packages.test.js (Pi settings.json packages assembly (entrypoint.sh)) -->
4. context-mode's npm update-check probe is neutralized at build time in both the Claude global install and Pi's prewarmed npm copy of context-mode, so neither surface renders an "Update available" notice; the version resolves "unknown" and no outbound npm traffic occurs (pin-drift protection: [REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation) AC2). <!-- @impl: scripts/patch-context-mode-bundles.mjs::BUNDLE_NAMES --> <!-- @test: host/__tests__/dockerfile-context-mode-patch.test.js (Dockerfile context-mode patch (createRequire shim + REQ-AGENT-076 AC4 update-check disable)) -->
5. Pi's `web_search` workflow defaults to `auto-summary`, so it never invokes the interactive browser-curator fallback (which cannot function in this headless container). <!-- @impl: entrypoint.sh::PI_WEB_SEARCH_JSON --> <!-- @test: host/__tests__/entrypoint-pi-web-search.test.js (entrypoint.sh Pi web-search workflow default) -->
6. Codeflare does not globally disable context-mode's bridge idle-reaper: neither the entrypoint nor the preseeded Pi runtime extension forces `CONTEXT_MODE_BRIDGE_IDLE_MS=0` (the extension clears any inherited value), so context-mode's own foreground/subagent split keeps the interactive bridge quiet while non-foreground bridge helpers self-release and never accumulate. <!-- @impl: entrypoint.sh::SYNC_STATUS --> <!-- @test: host/__tests__/entrypoint-context-mode-runtime.test.js (entrypoint never sets or exports a global CONTEXT_MODE_BRIDGE_IDLE_MS override) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The Custom-tier context-mode behavior must be delivered through the platform's preseed pipeline, never through a user-driven marketplace install that could mutate settings outside the platform's control.
- Pi package assembly is idempotent and identity-keyed, preserving user-added packages while preventing duplicate managed packages.
- The startup advisor-guidance merge preserves the user's selected advisor model and effort, overriding only `guidance`; assistants must not call `advisor`, run `/advisor`, or suggest it unless the current user message asks for advisor.
- `advisor` and `web_search` / `fetch_content` authenticate through Pi's own model registry or zero-config Exa MCP, so they require no per-user API keys.
- context-mode exposes no environment variable or flag to suppress its update-check notice, so the AC4 disable repoints the probe URL to a refused address at build time, via a shared module the Dockerfile and host test both use — not a user self-upgrade surface.

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Manual check

**Status:** Implemented
