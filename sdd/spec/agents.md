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

1. Pro mode delivers a strict superset of Standard mode's content — memory persistence, language rules, agent definitions, slash commands, skills, the spec/docs/tests discipline triad, and commit-attribution/PR-boundary review hooks. The per-content-category matrix lives in [documentation/preseed.md](../../documentation/lanes/preseed.md#session-modes). <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode) -->
2. Pro mode enables persistent memory by including the user's Vault directory tree in the R2 sync filters so it syncs to their bucket; Standard mode excludes the Vault tree, so memory does not persist across container restarts. The legacy `.memory/` directory is no longer written. <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 AC2: getConfigsForMode("advanced") returns docs for both default and advanced modes) -->
3. Pro-mode hooks fire uniformly regardless of tool surface — Custom tier routes commands through context-mode, other tiers run them directly — so commit attribution, the PR-boundary SDD review trigger, the unreviewed-PR turn-block, and prompt-cadence memory capture all fire identically on both paths. <!-- @impl: entrypoint.sh::CONTEXT_MODE_MANIFEST --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode) -->
4. Pi agents remain fully functional whether or not context-mode is active: native Bash/Read/Grep/Find/Edit/Write plus graphify tools suffice alone. Agent definitions declare context-mode helpers under Pi-native names in frontmatter. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::commandText --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005: Pi agents keep context-mode tool declarations (inert when off); enforcement extension is removed) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Cleanup on mode switch is scoped strictly to preseed-managed content; user-created files are never deleted.

**Priority:** P1

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-006: Preseed Configs Generated from Single Source of Truth

**Intent:** Shared agent configuration is generated once, while harness-specific runtime assets retain one canonical owner and are never overwritten by transformed copies from another harness.

**Applies To:** User

**Acceptance Criteria:**

1. Every manifest-declared Pi target key has exactly one generated owner per applicable mode, and its emitted bytes equal that owner source. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (emits every manifest-declared Pi asset exactly once per mode with canonical bytes) -->
2. A declarative manifest maps each preseed file to its applicable session modes (default, advanced, or both). <!-- @impl: scripts/generate-agent-seed.mjs::validateModes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
3. A build-time seed generator reads the manifest and source files, producing the runtime payload the Worker ships to the container. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
4. The generator ignores files absent from the manifest. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
5. The generator produces output for all supported agents (Claude Code plus generated lanes for Codex, Copilot, OpenCode, Antigravity, and Pi). <!-- @impl: scripts/generate-agent-seed.mjs::AGENT_CONFIGS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. Shared operational gate sections are present in every generated non-Claude instruction surface. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (preseeds work continuity, review push, and result handoff gates into every generated instruction surface) -->

**Constraints:**

- The generated output must stay in sync with the manifest and sources; the build pipeline enforces this.
- The generated output is never hand-edited; updates go through the source tree and the generator.

**Priority:** P1

**Dependencies:** None.

**Verification:** [Seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [Pi-native review ownership tests](../../host/__tests__/pi-native-review-assets.test.js)

**Status:** Implemented

---

### REQ-AGENT-007: Multi-Agent Adaptation Pipeline

**Intent:** Each supported agent receives shared adapted configuration plus any manifest-declared native assets required by its runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Every supported non-Claude agent receives an instruction document in both default and advanced modes. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (instructions files appear twice (one per mode, different content)) -->
2. Tool names are remapped per agent (e.g., `Read` -> `read` for Codex and Pi). <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_SKILLS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Instructions are concatenated into a single file for agents that use monolithic config (Codex: `AGENTS.md`, Copilot: `copilot-instructions.md`, OpenCode: `AGENTS.md`, Antigravity: `.gemini/GEMINI.md`, Pi: `AGENTS.md`). <!-- @impl: scripts/generate-agent-seed.mjs::AGENT_CONFIGS --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Every Pi manifest entry is emitted once in each declared mode with bytes equal to its canonical Pi source. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (emits every manifest-declared Pi asset exactly once per mode with canonical bytes) -->

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

1. `/review` launches the six existing specialist roles (security, architecture, code quality, dead code, test gaps, documentation) in one parallel wave.
2. The complete specialist reports are cross-referenced and deduplicated.
3. Canonical findings are filtered against accepted architecture decisions.
4. A sequential Reality Filter evaluates every still-active finding.
5. Optional external verification covers HIGH and CRITICAL findings.

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- On Claude this workflow ships as the `commands/review.md` slash command; on Pi (where Claude slash commands do not deploy) the same workflow is delivered through the dedicated Pi-native `review` skill injected by the `/review` command handler, per [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill).
- Report persistence, interactive triage, and mutation ownership live in [REQ-AGENT-088](#req-agent-088-user-invoked-review-ownership-and-triage).

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
3. Large discovery commands use Pi-native discovery tools when context-mode is absent. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_COMPATIBILITY_NOTE -->
4. Pi-transformed SDD skills use Pi-native graphify tools and `Agent`/`Plan` terminology. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_COMPATIBILITY_NOTE -->
5. The native `/sdd` command enforces command-file hard gates before workflow dispatch. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::sddRepoState --> <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddCommandDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (native /sdd hard gates / REQ-AGENT-021 AC5 (the native /sdd command enforces command-file hard gates before workflow dispatch)) -->
6. `/sdd init` and `/sdd clean` are root-session mutation workflows and do not dispatch PR-boundary reviewer agents. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddWorkflowExecutionText --> <!-- @impl: preseed/agents/claude/commands/sdd.md::Execution ownership (binding) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session) -->
7. `/sdd init` and `/sdd clean` run required specification and documentation enforcement inline in that order. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::rootSddExecution --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session) -->

**Notes:** AC3 and AC4 are manually verified through the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

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

1. LLM provider keys are injected into the container ONLY under a `CODEFLARE_`-namespaced name; the bare `OPENAI_API_KEY` / `GEMINI_API_KEY` names NEVER appear in the container's global environment. Keys are read fresh from KV on each container start and are not persisted in DO storage. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
2. The entrypoint maps the namespaced keys back to the standard `OPENAI_API_KEY` / `GEMINI_API_KEY` names ONLY inside the `consult-llm-mcp` MCP server's scoped `env` block (in `~/.claude.json` and `~/.pi/agent/mcp.json`), never as a global export. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
3. Per provider the entrypoint prefers the subscription over the API key: OpenAI uses the Codex CLI backend when the user is logged into Codex, passing the API key only as a fallback; otherwise it uses the API key. Gemini always uses the API key. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
4. The `consult-llm` tooling is scoped to Claude Code and Pi only; no other agent receives the skill or MCP server. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
5. Claude and Pi consult-llm skills implement the invocation and model-selection behavior in [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior). <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
6. In enterprise mode the entire LLM-keys-and-consult-llm surface is unavailable: the keys are not injected (AC1 suppressed), the `/api/llm-keys` routes return 403 on every method, the Settings "LLM API Keys" section is hidden. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The container reads keys at start and on restart; mid-session key changes take effect only after the next session start.
- AC5 is skill-directed agent behaviour; the consult-llm SKILL.md files (Claude + Pi) are the implementation surface and are verified through [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior).
- The consult-llm MCP config is wrapped in a shell function invoked with `|| echo WARNING`; a jq/IO failure cannot abort the entrypoint before the init-complete flag.

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
2. The cross-link sub-pass adds every REQ that references another REQ concept by name to the parent's `Dependencies:` as a linked `REQ-X-NNN` heading anchor.
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

**Intent:** Pi review must react only to supported root-session PR-boundary commands for an SDD project with an open PR targeting `main` or `master`. Draft PRs remain eligible, matching Claude; integration, closed, no-PR, transition, failed-command, and child-session states remain inert.

**Applies To:** User

**Acceptance Criteria:**

1. A supported root boundary requests reviewers only for an SDD repository with a fresh open protected-base PR. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::queryPr --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (Pi review reminder and settled enforcement) -->
2. Ineligible PR state or an unsuccessful command requests no reviewer. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (Pi review reminder and settled enforcement) -->
3. Root and nested SDD layouts suppress review only while transition is true and the active triage queue contains an open item. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isReviewTransitionSuspended --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-045/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition) -->
4. Passive lifecycle and child sessions cannot start or complete review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
5. Successful protected-base PR creation creates a settled review window whose successful reviewer completion can acknowledge the head. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-055: PR creation completion acknowledges its review window) -->
6. Boundary repository context resolves through shell `cd`, explicit tool cwd, or Git `-C`. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::rememberActiveRepoFromToolResult --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (Pi review reminder and settled enforcement) -->
7. An eligible launch plan is a root follow-up that triggers the next model turn. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan) -->

**Constraints:**

- Command parsing is defined by [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing).
- Pi adds no pre-command merge gate.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-063](#req-agent-063-pr-boundary-command-parsing)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

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
6. A successful `auto` or `unleashed` cleanup leaves its resulting commits on the checked-out remote branch. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::rootSddExecution --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) -->
7. Specification repair completes before documentation repair. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::rootSddExecution --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Status semantics, `Deprecated` requirements, the spec-discipline enforcement layer, and the `enforce_tdd` test-coverage rule follow `rules/spec-discipline.md`.
- Inline repair invokes `spec-enforce` before `doc-enforce`; report-only reviewers never own mutations or Git operations.

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

**Intent:** One pure classifier must select the smallest safe reviewer set from the acknowledged-to-current diff so reminders and settled enforcement cannot disagree.

**Applies To:** User

**Acceptance Criteria:**

1. Generated-only changes require no lane, documentation-only changes require `doc-updater`, SDD-only or SDD-plus-documentation changes require `spec-reviewer` and `doc-updater`, and source, test, configuration, workflow, preseed, mixed, or unknown changes require all three lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies generated, docs, spec, source, and mixed commit ranges into reviewer lanes) -->
2. Unusual filenames and source-to-documentation renames cannot reduce the required reviewer set or bypass code review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies tricky filenames and source-to-doc renames without bypassing code review) -->
3. An invalid or empty review range falls back to all three lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: falls back to all lanes for malformed and non-ancestor acknowledgements) -->
4. An acknowledged current head requires no reviewer lane. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current head emits a CI-only plan) -->

**Constraints:**

- Pi lane classification consumes NUL-delimited paths with Git rename detection disabled.
- Claude's lane classifier remains unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Claude lane classifier tests](../../host/__tests__/lane-classifier.test.js)

**Status:** Implemented

---

### REQ-AGENT-041: PR-Boundary Review Bypass Surfaces

**Intent:** Review enforcement needs only Claude's explicit user-controlled bypasses and bounded fail-open behavior. Bypasses skip the current boundary without falsely acknowledging its head.

**Applies To:** User

**Acceptance Criteria:**

1. A user-created one-shot sentinel bypasses one otherwise eligible root review boundary without writing acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: consumes a one-shot bypass on reminder-only PR creation) -->
2. A non-SDD project does not consume the one-shot sentinel. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (H1: vibe-coding project does NOT consume the /tmp/review-bypass sentinel) -->
3. Only a finalized user message after the latest boundary containing `skip review` or `skip verification` is recognized as a transcript bypass. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-041: recognizes an explicit user bypass only when it follows the latest boundary) -->
4. A recognized post-boundary user bypass emits no reminder and writes no acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: honors an explicit post-boundary user bypass without fabricating acknowledgement) -->
5. Child sessions never consume the sentinel, write acknowledgement, or mutate the block counter. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
6. One unreviewed head emits at most five settled follow-ups before latching `GIVEUP`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::blockDecision --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: blocks five times then latches GIVEUP for the same head without acknowledging it) -->
7. A different head starts a fresh follow-up count. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::blockDecision --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: blocks five times then latches GIVEUP for the same head without acknowledging it) -->

**Constraints:**

- Agent-authored instructions must never create the sentinel or present the bypass phrase as an action to take.
- The sentinel path remains overridable for hermetic tests.
- Claude bypass behavior is unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Claude Stop-hook tests](../../host/__tests__/enforce-review-spawn.test.js)

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

1. Every Import-Mode triage entry carries concrete Context, Recommendation, and Rationale fields. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model --> <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045: Import-Mode triage queue and transition state) -->
2. The enforce pass rejects placeholder or nonspecific triage guidance. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Phase 7a + Iterate-to-clean against enforcement skills (binding) --> <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045: Import-Mode triage queue and transition state) -->
3. A lost triage entry carries a one-line Reason. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045: Import-Mode triage queue and transition state) -->
4. Open transition triage suppresses Pi review lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isReviewTransitionSuspended --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-045/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition) -->
5. Import Mode with `enforce_tdd: false` marks source-implemented CLEAR requirements Implemented. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model -->
6. Import Mode with `enforce_tdd: true` marks requirements without REQ-referencing tests Partial. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model -->
7. Open transition triage suppresses the Claude PR-review hooks. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::requires_lane --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) -->

**Notes:** AC5-AC6 are manually verified through the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Triage state lives only in `sdd/.init-triage.md` and Git history.
- Triage resolution is interactive only.
- `/sdd init` owns the triage file.
- spec-reviewer may read the triage file.
- Each code-only domain carries one verification footnote when `enforce_tdd: false`.
- Unleashed mode is unavailable while transition triage remains open.
- Resume Mode drain behavior is owned by [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow).

**Priority:** P1

**Dependencies:** [REQ-AGENT-022](#req-agent-022-legacy-codebase-import-mode-discovery)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-047: Resume Mode closure and review-pipeline gate

**Intent:** When the Resume Mode triage queue drains, the project must cleanly exit SDD transition: clear the `transition: true` flag, record totals, and re-arm the gates that were suspended during drain. The PR-boundary review pipeline must stay silent while triage items remain open so legacy code does not trigger review agents before the spec is real.

**Applies To:** User

**Acceptance Criteria:**

1. Resolving the final open triage item clears transition. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off -->
2. Transition closure records resolved and lost entry totals. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off -->
3. Transition closure leaves `enforce_tdd` unchanged. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off -->
4. Transition closure preserves the triage file as its audit record. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off -->
5. Open transition triage suppresses the Claude PR-review hooks. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::SDD transition gate (REQ-AGENT-022) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) -->
6. Open transition triage suppresses Pi PR review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isReviewTransitionSuspended --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-045/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition) -->

**Notes:** AC1, AC2, AC3, and AC4 are manually verified through the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

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

1. The Pi `/review` command injects a dedicated Pi-native `review` skill that mirrors the Claude `commands/review.md` workflow, instead of injecting the `git-review-pipeline` enforcement skill. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-050 AC1/REQ-AGENT-088 AC1: dispatches the dedicated /review workflow contract) -->
2. The Pi `review` skill is the user-invoked review workflow (multi-perspective specialist subagents, cross-reference, architecture-decision filter, optional external verification, interactive triage), explicitly distinct from PR-boundary enforcement; it does not run the `git-review-pipeline`.
3. The skill scopes review by `--all` or `--diff` parsed from the appended command line, prints help and runs no phases when neither flag is present, and supports the `--deep` and `--verify-high` flags. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview -->
4. The skill is static-analysis only: it never runs builds, tests, or linters (the container is resource-constrained).
5. The skill maps Claude primitives to Pi-native ones: subagents spawn via Pi's `Agent` tool with `subagent_type`, graph queries use Pi-native `graphify_query`/`graphify_path`/`graphify_explain`, and plan entry uses the `Plan` agent or an explicit written-and-approved plan.
6. The skill is delivered advanced-only via the Pi manifest (`skills/review/SKILL.md`) through the standard seed pipeline. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. When either `sdd/` or `documentation/` is absent, the documentation lane returns a stable no-op report instead of leaving a missing artifact. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewDocumentationSurfaceDecision --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-050 AC7: resolves the documentation lane to a stable no-surface report) -->

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
6. The extension is delivered advanced-only via the Pi manifest through the standard seed pipeline. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (AC6: codeflare-commands.ts is delivered advanced-only through the seed pipeline (manifest mode-gate)) -->

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
2. The attribution detection set matches genuine attribution signatures only - the canonical commit-attribution-block set plus the brain emoji and `ChatGPT` as a deliberate Pi-guard superset since a Pi session may run a non-Claude model. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
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

### REQ-AGENT-053: Pi Native Review Result Correlation

**Intent:** Pi review completion must be proven only by visible public reviewer calls and their correlated native terminal notifications in the root transcript.

**Applies To:** User

**Acceptance Criteria:**

1. Only eligible public reviewer calls after the latest successful boundary can satisfy its review window. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: uses only public subagent calls after the latest successful settled boundary) -->
2. A successful native notification satisfies only the reviewer call carrying its XML tool-use ID. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-053/REQ-AGENT-059: correlates successful native notifications by XML tool-use-id) -->
3. A failed native reviewer notification leaves its lane unacknowledged and eligible for relaunch. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: failed reviewer notification remains unacknowledged and recoverable) -->
4. An unmatched reviewer call remains in flight without an age timeout. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071/REQ-AGENT-074: keeps unmatched reviewer calls in flight until native terminal notification) -->
5. Acknowledgement changes only after every required reviewer reports successful completion. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only the reminder head after all lanes terminate) -->
6. Completion for an earlier reminder never acknowledges a replacement PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
7. Delayed successful completion acknowledges its reviewed head only while that head remains authoritative. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: delayed completion acknowledges the reviewed PR head after reload and new local work) -->

**Constraints:**

- Native Pi task transcripts remain ordinary Pi history, not Codeflare review state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

**Status:** Implemented

---

### REQ-AGENT-055: Pi Session-Scoped Review Window

**Intent:** Pi review completion must use the latest root-transcript boundary and native reviewer notifications as its complete session-scoped window, without pending JSON, roll-forward state, or a merge interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. Only reviewer calls after the latest successful boundary belong to its active window. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: uses only public subagent calls after the latest successful settled boundary) -->
2. Partial or failed reviewer completion leaves acknowledgement unchanged. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: failed reviewer notification remains unacknowledged and recoverable) -->
3. Completion for an earlier reminder never acknowledges a replacement PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
4. Child sessions and shutdown cannot acknowledge active review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
5. Delayed successful completion may acknowledge an unchanged authoritative PR head after reload. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: delayed completion acknowledges the reviewed PR head after reload and new local work) -->
6. An acknowledged current head requests no reviewer. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current head emits a CI-only plan) -->
7. An acknowledged current head may still request its independent CI wave. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current head emits a CI-only plan) -->

**Constraints:**

- Pi has no hard pre-command merge gate; `gh pr merge` is only a settled transcript boundary.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-082](#req-agent-082-pi-review-range-selection)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

**Status:** Implemented

---

### REQ-AGENT-056: Pi Local Statusline Footer

**Intent:** Pi users need a compact footer in every session mode that shows session context without hiding extension-owned status rows.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi local statusline extension is preseeded in both Standard and Pro modes. <!-- @impl: preseed/agents/pi/manifest.json::local-statusline.ts --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-056 AC1: seeds the Pi local statusline in default and advanced modes) -->
2. The first footer line renders context usage, active model with thinking effort, and the active repository label when resolved. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::renderLine --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::contextPercent --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation) -->
3. If cwd metadata is outside git, the footer falls back to active repository memory shared by the main Pi extension. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::rememberActiveRepo --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::recallActiveRepo --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: resolves the active repository remembered by the main Pi extension) -->
4. The graphify active-cwd sentinel is display-only and accepted only for git repositories inside a session root. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::sentinelRepoForDisplay --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: uses the display sentinel only when its repository is inside the session root) -->
5. Non-empty extension statuses render on a separate footer line without replacing session context. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::installFooter --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation) -->
6. Footer lines are truncated by visible width, preserving ANSI color sequences and appending a reset before the ellipsis so colored statuses do not consume visible width or bleed styling past truncation. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::truncateToWidth --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation) -->
7. The statusline refreshes on session start, resource discovery, turn boundaries, model changes, thinking-effort changes, and cache-TTL repaint intervals. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::refreshFooter --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: refreshes the footer on session, resource, turn, model, and effort changes) -->

**Constraints:**

- The statusline is cosmetic and must not block agent execution if repository or context metadata cannot be read.
- Idle sessions render no empty extra footer lines.

**Priority:** P2

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Pi seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts) (AC1); [Pi local statusline behavioral tests](../../src/__tests__/lib/local-statusline-repo.test.ts) (AC2-AC7)

**Status:** Implemented

---

### REQ-AGENT-058: Supported Boundary Recovery

**Intent:** Pi must recover review demand from the root transcript at settled time instead of depending on durable reconciliation, passive polling, or child-command visibility.

**Applies To:** User

**Acceptance Criteria:**

1. Settled enforcement reconstructs the latest successful supported root boundary and rechecks fresh PR state before deciding lanes or acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan) -->
2. One boundary lifecycle performs bounded fresh-PR retries and emits a plan only after GitHub reports the local full head SHA. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::queryHead --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-058: one boundary lifecycle retries bounded PR-head propagation and emits one plan) -->
3. Without a successful persisted boundary, settled enforcement performs no PR query and emits no follow-up. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036: performs no PR query when the transcript has no settled boundary) -->
4. Failed persisted pushes are not recovered as successful boundaries. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036: ignores a failed persisted push during settled enforcement) -->
5. Only calls after the latest successful boundary can satisfy recovered review demand. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: uses only public subagent calls after the latest successful settled boundary) -->
6. Non-boundary activity never starts or completes recovered review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
7. A merged unacknowledged head emits one visible notice and never writes acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-058: reports a merged unacknowledged head once without acknowledging it) -->

**Constraints:**

- Pushes performed outside the active root Pi session are detected only when a later supported root boundary appears.
- Pi creates no review audit/event ledger.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

**Status:** Implemented

---

### REQ-AGENT-059: Pi Native Review Findings Handoff

**Intent:** Reviewer findings must reach the main session through each native subagent result, without Codeflare-owned result files, summaries, severity parsing, or an automatic fix state machine.

**Applies To:** User

**Acceptance Criteria:**

1. Tool-use-ID correlation leaves each native reviewer result intact for the main session. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-053/REQ-AGENT-059: correlates successful native notifications by XML tool-use-id) -->
2. Successful native reviewer notifications are the completion proof. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only the reminder head after all lanes terminate) -->
3. Every ranged PR-boundary plan carries the executable diff work-set contract. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @impl: preseed/agents/pi/extensions/review-scope.ts::scopeContract --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan) -->
4. `/review` maps diff and all flags to their executable work sets. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewCommandDecision --> <!-- @impl: preseed/agents/pi/extensions/review-scope.ts::scopeContract --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (AC3: resolves /review diff and all into executable work-set contracts) -->
5. `/sdd clean` rejects invalid scope flags before dispatching its resolved work set. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddCommandDecision --> <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddWorkflowScopeText --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (dispatches the resolved /sdd clean work set and rejects ambiguous scope flags) -->
6. The shared packet builder validates diff ancestry and returns only lane-owned changed hunks. <!-- @impl: preseed/agents/pi/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-059 AC6: diff packets contain only lane-owned changed hunks) -->
7. All scope returns the tracked lane tree without a diff patch. <!-- @impl: preseed/agents/pi/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-059 AC7: all scope enumerates the lane tree while diff rejects an invalid range) -->

**Constraints:**
- Main-session rules require waiting for every required reviewer before fixing, committing, or pushing.
- The main session verifies and fixes legitimate findings unless the latest user instruction says to wait or not autofix.
- Report-only reviewer types never own a `/review` mutation phase; triage/history/ADR/issue writes route to a non-review mutation agent.

**Priority:** P1

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Pi scope entry-point tests](../../src/__tests__/lib/pi-review-scope.test.ts), [Pi review work-set tests](../../host/__tests__/pi-review-workset.test.js)

**Status:** Implemented

---

### REQ-AGENT-063: PR-Boundary Command Parsing

**Intent:** Pi must copy Claude's narrow boundary grammar across supported shell tool-result surfaces without treating examples, source literals, or unsupported convenience commands as boundaries.

**Applies To:** User

**Acceptance Criteria:**

1. Only successful supported shell tool results expose commands to boundary classification. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-063: extracts boundaries only from supported shell tool result surfaces) -->
2. Boundary classification recognizes supported push and protected-PR commands, including Git `-C` push. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063: distinguishes supported reminder and settled command surfaces) -->
3. Commands are recognized only at executable shell command boundaries, so quoted marker text never triggers a boundary. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063: distinguishes supported reminder and settled command surfaces) -->
4. Punctuation-bearing heredoc delimiters match exactly. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063: distinguishes supported reminder and settled command surfaces) -->
5. Multiple heredoc bodies are consumed in declaration order before executable commands are classified. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063: distinguishes supported reminder and settled command surfaces) -->
6. Unsupported GitHub convenience commands do not trigger review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063: distinguishes supported reminder and settled command surfaces) -->

**Constraints:**

- Supported shell surfaces are Bash, shell `ctx_execute`, and `ctx_batch_execute`.
- Successful `gh pr create` is both a launch and settled boundary.
- `gh pr merge` is settled-only.
- Claude hook grammar remains unchanged.

**Priority:** P1

**Dependencies:** None

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

**Status:** Implemented

---

### REQ-AGENT-064: Connect to Cloudflare via OAuth

**Intent:** In non-enterprise modes a user connects their own Cloudflare account via OAuth — mirroring the GitHub connect — so the per-user deploy token is obtained without pasting a dashboard-created API token. One operator-registered OAuth client serves every user; each user authorizes their own account.

**Applies To:** User

**Acceptance Criteria:**

1. `CloudflareOAuthProvider` supports authorize, exchange, refresh, and revoke; encrypted OAuth credentials reuse the bucket deploy-key fields without a new key. Exchanges use `client_secret_post` and surface Cloudflare `error_description` on failure. <!-- @impl: src/lib/cloudflare-token.ts::postToken --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (CloudflareOAuthProvider) -->
2. `GET /api/cloudflare/connect`, its callback, and `POST /api/cloudflare/disconnect` are gated by authentication only (any authenticated user) — reachable from Guided Setup and the Settings accordion, never tier-gated — and the token never reaches the browser. <!-- @impl: src/routes/cloudflare.ts::app --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (GET /auth/cloudflare/connect/callback) -->
3. The callback binds an HMAC-signed, single-use state to the initiating user's bucket; a forged, expired, or replayed state is rejected without exchanging the code. On success it stores the token and auto-selects the account when exactly one is accessible, else redirects to an account picker. <!-- @impl: src/lib/cloudflare-token.ts::connectCloudflare --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (GET /auth/cloudflare/connect/callback) -->
4. A currently-valid token is returned, refreshing within the skew window and failing closed (never a stale token); the resolved token is injected into the container env on session start. <!-- @impl: src/lib/cloudflare-token.ts::getValidCloudflareToken --> <!-- @impl: src/lib/cloudflare-token.ts::applyCloudflareOAuthToken --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (getValidCloudflareToken) -->
5. The connect URL carries a scope `tier`; the server maps it to the OAuth `scope`, always including `offline_access` so a refresh token is issued. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (feeds the scope tier into the OAuth authorize scope param (always incl. offline_access)) -->
6. The operator's Cloudflare OAuth client id + secret are configured in the admin-gated Setup wizard (KV; id plain, secret encrypted at rest, fail-closed without `ENCRYPTION_KEY`), mirroring the GitHub provider config ([REQ-GITHUB-008](github.md#req-github-008-enterprise-github-provider-configuration-via-setup)). <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
7. Enterprise is unchanged: the OAuth provider resolves to none in enterprise, so every Cloudflare-OAuth route fails closed there; enterprise keeps the admin-global Browser Rendering token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)). <!-- @impl: src/lib/cloudflare-token.ts::getCloudflareProvider --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (applyCloudflareOAuthToken (REQ-AGENT-078: injects the placeholder, real token never in the container)) -->

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
2. In OAuth sessions (non-enterprise, oauth source only) `api.cloudflare.com` is intercepted and every request — on every path — is re-stamped with a token refreshed within the skew window, so the forwarded credential is the refreshed token, not the baked placeholder. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @impl: src/container/index.ts::wireCloudflareApiInterception --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (stamps a FRESH refreshed token on ANY api.cloudflare.com path (e.g. wrangler), egress DIRECT) -->
3. Both the REST surface and the CDP WebSocket upgrade (browser-run) are stamped and forwarded via the shared transport, so a session survives past the access-token lifetime for wrangler **and** interactive browser-run. <!-- @impl: src/cloudflare-browser-interceptor.ts::bridge --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (bridges the CDP upgrade with the fresh token, returning a FRESH client socket, direct not Gateway) -->
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

1. The advanced tier's Cloudflare OAuth scope catalog requests exactly the finalized 60 operator-verified Cloudflare scopes — including the full AI family (Workers AI, AI Gateway `aig.*`, Agents Gateway `agw.*`, AI Search, AI Audit, Firewall for AI, Websearch) — plus `user-details.read` and the always-appended `offline_access`. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->
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

### REQ-AGENT-068: Independent Pi CI Monitoring

**Intent:** Pi CI monitoring must have one owner and one result path. The root Git workflow launches one dedicated background agent for an eligible main-bound PR, and that agent runs one attached deterministic monitor whose native task result is independent of PR review.

**Applies To:** Agent

**Acceptance Criteria:**

1. An eligible head-changing boundary resolves to one complete public `ci-monitor` request. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::resolveCiMonitorRequest --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC1: eligible head-changing push returns one complete public ci-monitor request) -->
2. Valid check JSON remains usable when GitHub CLI returns a pending or failure exit status. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC2: valid check JSON is parsed despite gh exit statuses 1 and 8) -->
3. CI success requires the same non-empty all-terminal fingerprint in two polls. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC2: pending checks wait for a stable pass and skipping fingerprint) -->
4. An authoritative head mismatch reports `CI_RESULT timeout superseded`. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC3: a superseded head stops before checks are queried) -->
5. Failed or cancelled checks report `CI_RESULT failure` with provider evidence. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC4: failed and cancelled arbitrary providers report failure with links) -->
6. Monitoring creates no Codeflare state, log, or PID files. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC5: monitoring creates no Codeflare state, log, or PID files) -->
7. Malformed or transient provider responses never become success. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC6: malformed and transient GitHub responses never become success) -->

**Constraints:**

- The root Pi Git workflow rule is the sole automatic trigger.
- Review handoffs and shutdown never restart CI.
- Empty checks time out after five minutes.
- Provider commands are individually bounded.
- Total monitoring is bounded at thirty minutes.
- The dedicated agent and script are seeded in Standard and Pro modes.
- The CI agent is report-only; the main session owns fixes and Git writes.
- Claude CI behavior in [REQ-AGENT-070](#req-agent-070-claude-on-demand-ci-monitoring-policy) is unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** [Pi CI monitor behavioral tests](../../host/__tests__/pi-ci-monitor.test.js)

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

1. Routine pushes do not auto-start Claude `ci-monitoring`. <!-- @impl: preseed/agents/claude/rules/git-workflow.md::Hard obligations -->
2. Claude invokes `ci-monitoring` only for an explicit request or a fresh deploy/merge gate. <!-- @impl: preseed/agents/claude/rules/git-workflow.md::Hard obligations -->
3. The Claude monitor launcher returns the monitored head, detached process identity, and durable log path. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::The monitor launcher --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC3: Claude ci monitor launcher starts detached work and returns a durable log path) -->
4. Claude success requires a non-empty workflow/run fingerprint that remains stable across two polls. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::Reading the result --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC4: Claude ci monitor waits for a stable workflow/run set before success) -->
5. A failed workflow row writes a terminal failure result to the durable log. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::Reading the result --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC5: Claude ci monitor reports failed workflow rows) -->
6. Unavailable GitHub CLI access writes a terminal timeout result to the durable log. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::Reading the result --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC6: Claude ci monitor reports gh access failures in the durable log) -->

**Notes:** AC1 and AC2 are manually verified through the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Claude monitoring remains independent of Pi's automatic policy in [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring).

**Priority:** P1

**Dependencies:** [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-071: PR-Boundary Review Agent Dispatch

**Intent:** The main Pi session must launch the minimal required report-only reviewers together through visible public subagent calls and must not mistake one slow lane for completion of its peers.

**Applies To:** User

**Acceptance Criteria:**

1. Settled enforcement requests every missing required lane in one reviewer wave. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan) -->
2. An unmatched public reviewer call suppresses only its own lane until native terminal notification, while other missing lanes are requested together. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
3. Only public background reviewer calls with inherited context disabled count toward completion. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071: rejects reviewer calls that inherit or omit parent context isolation) -->
4. Completion order does not change a lane's terminal state. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071/REQ-AGENT-074: keeps unmatched reviewer calls in flight until native terminal notification) -->
5. A valid prior acknowledgement scopes lane selection to its acknowledged-to-current range. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies generated, docs, spec, source, and mixed commit ranges into reviewer lanes) -->
6. Each counted reviewer prompt carries the exact valid acknowledged-to-current range. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewRange --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071: counts reviewer calls only when their prompt carries the acknowledged-to-current range) -->
7. Missing, malformed, or non-ancestor acknowledgement requests full-PR review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewRange --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review) -->

**Constraints:**

- Reviewer calls use `run_in_background: true` and `inherit_context: false`.
- Reviewers retain their complete lane enforcement policy.
- Each reviewer loads its lane packet once.
- Batching never truncates scoped rows or hunks.
- Review agents never edit or push.
- The root waits for every required result before changing the head.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

**Status:** Implemented

---

### REQ-AGENT-074: Pi Settled Review Handoff

**Intent:** Pi's settled event must hand only missing review lanes back to the main session and acknowledge only transcript-proven completion. It owns no review monitor, CI action, durable claim, or restart path.

**Applies To:** Agent

**Acceptance Criteria:**

1. Settled enforcement emits one follow-up containing every missing lane for the reminder head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan) -->
2. An eligible boundary with invalid acknowledgement emits full-PR scope. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review) -->
3. Unmatched public reviewer calls are not duplicated, while missing peers are requested together. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
4. Only complete successful reviewer completion acknowledges the reminder head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only the reminder head after all lanes terminate) -->
5. Terminal notifications for an earlier reminder never acknowledge a replacement PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
6. Child sessions are inert, and shutdown or reload alone writes no acknowledgement or replacement request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
7. After reload or newer unpublished local work, a persisted delayed terminal notification acknowledges its reminder head only while the authoritative PR head still matches that reviewed head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: delayed completion acknowledges the reviewed PR head after reload and new local work) -->

**Constraints:**

- The handoff requests reviewer lanes directly.
- `ci-monitor` is never a reviewer or acknowledgement condition.
- No hidden fallback spawn or automatic restart exists.

**Priority:** P1

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-082](#req-agent-082-pi-review-range-selection)

**Verification:** [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

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

1. Container startup enables context-mode in Pi's package settings by default. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-076 AC1: container startup enables every required package by default) -->
2. `/ctx off` persists the disabled setting and reloads the active Pi process; `/ctx on` persists the enabled setting and reloads it. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::handleContextModeCommand --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-076 AC2: /ctx off and on persist package markers and reload the active process) -->
3. Custom-tier Claude may receive automatic context-window reduction only while its tier remains eligible. <!-- @impl: src/lib/r2-seed.ts::getConfigsForMode --> <!-- @test: host/__tests__/entrypoint-context-mode.test.js (entrypoint context-mode preseed gate / REQ-AGENT-005 + REQ-AGENT-076 (context-mode MCP registration)) -->
4. The Pi settings required set installs the five always-on tool extensions. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (Pi settings.json packages assembly (entrypoint.sh)) -->
5. Build-time patching neutralizes context-mode's npm update probe in both installed copies. <!-- @impl: scripts/patch-context-mode-bundles.mjs::BUNDLE_NAMES --> <!-- @test: host/__tests__/dockerfile-context-mode-patch.test.js (Dockerfile context-mode patch (createRequire shim + REQ-AGENT-076 AC4 update-check disable)) -->
6. Pi `web_search` defaults to the headless-safe `auto-summary` workflow. <!-- @impl: entrypoint.sh::PI_WEB_SEARCH_JSON --> <!-- @test: host/__tests__/entrypoint-pi-web-search.test.js (entrypoint.sh Pi web-search workflow default) -->
7. An inherited bridge-idle override does not disable context-mode's managed idle policy. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::clearInheritedContextModeBridgeIdleOverride --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-076 AC7: Pi context-mode runtime extension clears an inherited bridge-idle override so context-mode governs per-session) -->

**Notes:** Container startup restores the enabled default; `/ctx` changes persist in shared Pi settings until then. Foreground tool availability is also covered by the [manual verification checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Custom-tier behavior is delivered only through the platform preseed.
- Package assembly preserves user-added entries and deduplicates managed entries.
- Advisor startup overrides guidance only.
- Advisor remains user-invoked only.
- Tool extensions require no per-user API key.
- The update probe patch is build-owned, not a self-upgrade path.
- Every Pi workflow retains an equivalent non-context fallback.
- Foreground ownership and in-process subagent isolation are owned by [REQ-AGENT-089](#req-agent-089-pi-context-mode-foreground-ownership).

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** [Agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-080: Unified Pi PR-Boundary Launch Plan

**Intent:** A successful Pi PR boundary must produce one ordered, visible launch plan so reviewers start together before independent exact-head CI, without duplicate triggers or lifecycle coupling.

**Applies To:** Agent

**Acceptance Criteria:**

1. An eligible SDD push or protected-base PR creation emits one structured plan whose reviewer wave precedes its `ci-monitor` wave. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074: emits one ordered reviewer-then-CI launch plan) -->
2. An eligible non-SDD boundary emits a CI-only plan. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-068: emits a CI-only launch plan outside SDD mode) -->
3. An eligible default-mode boundary emits a CI-only plan from its effective repository context. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::rememberActiveRepoFromToolResult --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewEnabled --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (Pi review reminder and settled enforcement) -->
4. Transcript correlation recognizes a matching exact-head `ci-monitor` call independently from reviewer state. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-068: recognizes one matching CI launch independently of reviewer completion) -->
5. Settled follow-up requests missing reviewer lanes without duplicating unmatched reviewer calls. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
6. Settled follow-up requests a missing CI wave without duplicating in-flight reviewers. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-068/REQ-AGENT-074: requests a missing CI launch without duplicating in-flight reviewers) -->
7. Required successful reviewer completion is the only acknowledgement condition. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only the reminder head after all lanes terminate) -->

**Constraints:**

- Reviewer and CI lifecycles remain independent.
- The root launches every reviewer together before CI.
- The resolver's CI request is submitted unchanged once.
- Git commands create no second CI trigger.
- All launches use isolated public background subagents.
- The dispatcher stores no durable job or result state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring)

**Verification:** [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi CI monitor tests](../../host/__tests__/pi-ci-monitor.test.js)

**Status:** Implemented

---

### REQ-AGENT-082: Pi Review Range Selection

**Intent:** Pi must derive review lanes and scope from an ancestry-validated acknowledged-to-head range, with a safe full-PR fallback when acknowledgement cannot define that range.

**Applies To:** User

**Acceptance Criteria:**

1. Missing, malformed, or non-ancestor acknowledgement falls back to all review lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewRange --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: falls back to all lanes for malformed and non-ancestor acknowledgements) -->
2. Enforcement renders invalid acknowledgement as full protected-base PR scope. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review) -->
3. A valid ancestor acknowledgement classifies every changed path through the fresh PR head. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies tricky filenames and source-to-doc renames without bypassing code review) -->
4. A protected-base retarget invalidates same-head acknowledgement, including inside a compound command or while review is temporarily disabled. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::protectedRetarget --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::clearAck --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-082: protected retarget invalidation survives compound commands and disabled review mode) -->
5. After retarget invalidation, enforcement derives full protected-base PR scope. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-082: protected-base retarget invalidates same-head acknowledgement) -->

**Constraints:**

- The range uses full Git SHAs and is never inferred from reviewer output.
- Lane classification consumes NUL-delimited paths with Git rename detection disabled.
- Invalid acknowledgement never narrows review.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts)

**Status:** Implemented

---

### REQ-AGENT-083: User-Invoked Pi Review Repository Context

**Intent:** `/review` must execute against the active Git repository even when Pi itself started from a workspace parent.

**Applies To:** User

**Acceptance Criteria:**

1. `/review` prefers a Git repository containing the command cwd, including a linked worktree. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewWorkflowDecision --> <!-- @impl: preseed/agents/pi/skills/review/scripts/resolve-project-root.mjs::resolveProjectRoot --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->
2. Outside Git, `/review` resolves the remembered active repository. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewWorkflowDecision --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->
3. The workflow contract carries the validated absolute repository root. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Phase 1: Parse arguments + create run directory (main session) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->
4. `/review` fails before dispatch when neither repository source resolves. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-083: suppresses /review workflow dispatch when no repository resolves) -->
5. Repository-root validation preserves valid whitespace in the resolved path. <!-- @impl: preseed/agents/pi/skills/review/scripts/resolve-project-root.mjs::replace(/\r?\n$/, '') --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->

**Constraints:**

- Repository resolution never changes the Pi process cwd globally.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-059](#req-agent-059-pi-native-review-findings-handoff)

**Verification:** [Pi scope entry-point tests](../../src/__tests__/lib/pi-review-scope.test.ts)

**Status:** Implemented

---

### REQ-AGENT-081: rpiv-todo Session Isolation

**Intent:** Pi task lists must remain session-scoped without allowing child or background session lifecycle events to erase the foreground session's tasks.

**Applies To:** User

**Acceptance Criteria:**

1. Child replay, mutation, and shutdown leave foreground task state unchanged. <!-- @impl: preseed/agents/pi/npm/rpiv-todo-session-isolation/state/lifecycle.ts::registerSessionStateLifecycle --> <!-- @impl: preseed/agents/pi/npm/rpiv-todo-session-isolation/state/store.ts::slotFor --> <!-- @test: src/__tests__/lib/rpiv-todo-session-isolation.test.ts (keeps foreground tasks intact when a child session replays, mutates, and shuts down) -->
2. Context-free todo rendering reads only the foreground session's slot. <!-- @impl: preseed/agents/pi/npm/rpiv-todo-session-isolation/state/store.ts::getRenderState --> <!-- @test: src/__tests__/lib/rpiv-todo-session-isolation.test.ts (keeps foreground tasks intact when a child session replays, mutates, and shuts down) -->
3. The compatibility guard fails closed before changing package files when the installed dependency version is unsupported. <!-- @impl: preseed/agents/pi/npm/rpiv-todo-session-isolation/install.mjs::installRpivTodoSessionIsolation --> <!-- @test: src/__tests__/lib/rpiv-todo-session-isolation.test.ts (installs the supported override and fails closed before writing to an unsupported version) -->
4. Session shutdown clears the active overlay reference even when overlay disposal fails. <!-- @impl: preseed/agents/pi/npm/rpiv-todo-session-isolation/state/lifecycle.ts::disposeSessionOverlay --> <!-- @test: src/__tests__/lib/rpiv-todo-session-isolation.test.ts (clears the active overlay reference even when disposal fails) -->

**Constraints:**

- Task persistence remains transcript/branch-scoped; Codeflare adds no global task database.
- The temporary installer accepts only rpiv-todo 1.20.0.
- The override is removed after a reviewed upstream npm release includes equivalent session isolation.
- User-added Pi packages and unrelated rpiv-todo behavior remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)

**Verification:** [rpiv-todo session-isolation tests](../../src/__tests__/lib/rpiv-todo-session-isolation.test.ts)

**Status:** Implemented

---

### REQ-AGENT-084: Pi Reviewer Policy Preloading

**Intent:** Pi reviewers must begin every run with complete canonical scope and enforcement policy already available, without spending review turns on policy discovery.

**Applies To:** Agent

**Acceptance Criteria:**

1. Code, specification, and documentation reviewers begin with every declared canonical policy available before their first tool call. <!-- @impl: scripts/generate-agent-seed.mjs::expandPiSkillIncludes --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->
2. Reviewer configuration omits unsupported skill-access declarations. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->
3. Policy available to each reviewer is identical to its separately seeded canonical policy. <!-- @impl: scripts/generate-agent-seed.mjs::expandPiSkillIncludes --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->

**Constraints:**

- Canonical skill files remain the only hand-maintained policy source.
- Reviewer launch prompts continue to carry only dynamic repository, scope, and range inputs.
- Preloading changes no review scope, manifest row, or acknowledgement condition.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch)

**Verification:** [Pi-native review asset tests](../../host/__tests__/pi-native-review-assets.test.js)

**Status:** Implemented

---

### REQ-AGENT-085: Pi Reviewer Direct Evidence Transport

**Intent:** Pi reviewers must consume exact scoped evidence without recovering prior output through indexed searches.

**Applies To:** Agent

**Acceptance Criteria:**

1. Indexed retrieval and context-mode tools are unavailable to every reviewer. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::tools --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-085 AC1/AC2: generated reviewers expose only direct Bash evidence execution) -->
2. Every reviewer exposes Bash as its direct evidence execution tool. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::tools --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-085 AC1/AC2: generated reviewers expose only direct Bash evidence execution) -->
3. Reviewer Bash execution is rooted in the caller-supplied repository. <!-- @impl: preseed/agents/pi/extensions/review-tool-guard.ts::registerReviewerToolGuard --> <!-- @test: src/__tests__/lib/review-tool-guard.test.ts (REQ-AGENT-085: roots Bash-first fallback in the reviewer repository) -->
4. Cross-lane changed inputs carry exact old and new hunk ranges. <!-- @impl: preseed/agents/pi/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-085 AC4/AC5: changed inputs expose exact hunk ranges and enforce intersection) -->
5. An anchored symbol or named test is invalidated only when its line range intersects a changed-input hunk; path equality alone is insufficient. <!-- @impl: preseed/agents/pi/skills/review-scope/scripts/build-review-packet.mjs::changedInputIntersects --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-085 AC4/AC5: changed inputs expose exact hunk ranges and enforce intersection) -->
6. Foreground context execution and reviewer Bash execution produce the same packet work set. <!-- @impl: preseed/agents/pi/skills/review-scope/SKILL.md::Build the lane packet once --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-085: CLI and module produce identical worksets without persistence) -->

**Constraints:**

- Review scope, manifest coverage, evidence truth, and severity remain unchanged.
- Evidence already returned is never recovered through global index searches or marker-only commands.
- Reviewers consume packet evidence directly, consolidate independent checks, and continue only for named unresolved candidates.
- Foreground context-mode execution and reviewer Bash invoke the same seeded CLI and apply identical changed-hunk intersection semantics.
- Commands inspect the complete scoped work set internally while emitting compact counts, failures, and candidate snippets; packet files and redirected raw logs are never persisted or reread.
- Generated seed is reviewed through canonical preseed plus deterministic identity verification, not repeated generated-line searches.
- No token, turn, output-size, or concurrency cap substitutes for complete scoped review.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-084](#req-agent-084-pi-reviewer-policy-preloading)

**Verification:** [Agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [reviewer tool-guard tests](../../src/__tests__/lib/review-tool-guard.test.ts), [review work-set tests](../../host/__tests__/pi-review-workset.test.js)

**Status:** Implemented

---

### REQ-AGENT-086: Claude Reviewer Direct Evidence and Root Handoff

**Intent:** Claude PR reviewers must complete exact scoped reviews through direct evidence while leaving every file and Git mutation to the root session.

**Applies To:** Agent

**Acceptance Criteria:**

1. Claude `code-reviewer`, `spec-reviewer`, and `doc-updater` expose only `Skill`, Bash fallback, and direct context execution. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::tools --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086: Claude PR reviewers expose only skills and direct evidence execution) -->
2. Indexed retrieval, Graphify discovery, external-LLM calls, and file mutation tools are unavailable to those reviewers. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::Direct evidence transport (binding) --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::Direct evidence transport (binding) --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::Direct evidence transport (binding) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086: Claude PR reviewers expose only skills and direct evidence execution) -->
3. PR-boundary reviewers return structured findings without writing project or triage files. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE -->
4. The root session alone persists PR-boundary triage content. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE -->
5. The root session evaluates and applies legitimate PR-boundary fixes. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE -->

**Notes:** PR-boundary handoff ownership is manually verified through the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Exact-head checkpoints, ancestry-derived ranges, lane classification, parallel launch, and completion correlation remain unchanged.
- Review scope, enforcement manifests, severity, and evidence truth remain complete.
- Reviewers inspect the complete scoped work set internally and return compact direct results without token, turn, output-size, evidence, or concurrency caps.
- `/review` persists returned Phase 2/4/5/6 reports in the root; external verification, triage history, ADR updates, and issue creation are root-owned.
- Context-mode is optional transport; Bash preserves the same work set and findings.

**Priority:** P1

**Dependencies:** [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review)

**Verification:** [Agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [Claude review reminder tests](../../host/__tests__/git-push-review-reminder.test.js)

**Status:** Implemented

---

### REQ-AGENT-087: Pi Reviewer Execution Profile

**Intent:** Pi review lanes need a bounded provider-neutral reasoning profile so complete enforcement remains responsive without coupling the workflow to one model provider.

**Applies To:** Agent

**Acceptance Criteria:**

1. Code, specification, and documentation reviewers use Pi's provider-neutral `medium` thinking level instead of inheriting the root session's level. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::thinking = medium --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::thinking = medium --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::thinking = medium --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-087: generated reviewers use provider-neutral medium thinking) -->

**Constraints:**

- Pi maps `medium` to each selected model's supported reasoning controls without pinning a provider.
- Reviewer scope, enforcement policy, evidence, and severity remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-084](#req-agent-084-pi-reviewer-policy-preloading)

**Verification:** [Agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-AGENT-088: User-Invoked Review Ownership and Triage

**Intent:** User-invoked review must preserve specialist independence while keeping every persisted artifact and mutation under explicit root and user control.

**Applies To:** User

**Acceptance Criteria:**

1. Pi `/review` dispatches a report-only execution contract whose reports belong to the root. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::REVIEW_EXECUTION --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-050 AC1/REQ-AGENT-088 AC1: dispatches the dedicated /review workflow contract) -->
2. Claude `/review` gives every subagent a binding report-only execution mode. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) -->
3. The root session persists every returned review report. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Review ownership (binding) -->
4. The root applies a review fix only after the user approves it. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Review ownership (binding) -->
5. Interactive triage records exactly one decision for each surfaced finding. <!-- @impl: preseed/agents/claude/commands/review.md::Phase 8: Interactive Triage --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Phase 8: Interactive triage -->
6. Defer, ignore, and technical-debt decisions persist to `sdd/.review-decisions.md`. <!-- @impl: preseed/agents/claude/commands/review.md::Phase 9: Save Triage Results + Append to .review-decisions --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Phase 9: Save triage results + append to .review-decisions -->

**Notes:** Report persistence, approval gating, and triage cardinality are manually verified through the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Existing specialist agent types are reused; this requirement introduces no duplicate review agents.
- Reviewer scope, evidence completeness, and severity remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review), [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-089: Pi Context-Mode Foreground Ownership

**Intent:** Pi must retain context-mode in the interactive session without allowing in-process subagents to create competing context-mode owners.

**Applies To:** Agent

**Acceptance Criteria:**

1. Pi package assembly retains context-mode skills while disabling shared extension autoload. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-089 AC1: package assembly retains context-mode skills without extension autoload) -->
2. Starting an in-process Pi subagent does not initialize a second context-mode owner. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-089 AC2: one process owner rejects child context-mode initialization) -->
3. After the owning session shuts down, a new session can initialize context-mode. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-089 AC3: owner shutdown permits context-mode reattachment) -->

**Notes:** Process-count verification is documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The integration imports the installed context-mode adapter without modifying context-mode or pi-subagents.
- In-process subagents use their documented native transports.
- Foreground `/ctx off` and `/ctx on` behavior remains owned by [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

**Priority:** P1

**Dependencies:** [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)

**Verification:** [Pi package settings tests](../../host/__tests__/pi-settings-packages.test.js), [agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented
