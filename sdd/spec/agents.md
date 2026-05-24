# Agents Domain Specification

Multi-agent support, preseed system, and session modes.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Agent | One of six supported AI coding tools (`claude-code`, `codex`, `copilot`, `gemini`, `opencode`, `bash`) that runs inside the container and is auto-started in terminal tab 1 |
| Preseed | A set of configuration files (rules, skills, agents, commands, plugins) generated from a single Claude Code source of truth and deployed to each user's R2 bucket |
| Session Mode | Either Standard (`default`) or Pro (`advanced`) controlling the scope of agent enhancements seeded to a user's storage |
| Manifest | The declarative `manifest.json` file that maps each preseed source file to its applicable modes and drives the code generation pipeline |

### Out of Scope

- **Custom agent creation by users** -- Users cannot define their own agent types or register third-party CLI tools as agents. The six supported agents are hardcoded.
- **Agent marketplace** -- No mechanism for browsing, installing, or sharing community-contributed agent configurations or plugins.
- **Runtime agent switching** -- Agent type is immutable after session creation. Switching requires creating a new session.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Session Lifecycle | Container start triggers agent CLI auto-start in tab 1; session creation accepts `agentType` selection |
| Storage | R2 bucket stores preseed files; initial sync restores agent configs to the container filesystem |
| Subscription | Session mode gating (`REQ-SUB-014`) controls whether a user can select Pro mode |

---

<!-- @test: host/__audits__/dockerfile-agents.audit.js (Dockerfile agent CLI pre-install describe -> @anthropic-ai/claude-code + @openai/codex + @google/gemini-cli + @github/copilot + opencode-ai npm installs + NODE_COMPILE_CACHE + V8 warmup --version runs + Go native exclusion -> AC3,4) -->
### REQ-AGENT-001: Support Multiple AI Coding Agents

<!-- @impl: Dockerfile -->
<!-- @impl: src/lib/schemas.ts -->
<!-- @test: src/__tests__/lib/agent-config.test.ts (AGENT_COMMANDS exhaustiveness describe → AC1/AC2) -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (npm install + V8 warm-up → AC3/AC4) -->

**Intent:** The platform must support multiple AI coding agents so users can choose the tool that fits their workflow.

**Applies To:** User

**Acceptance Criteria:**

1. Six agent types are defined: `claude-code`, `codex`, `copilot`, `gemini`, `opencode`, `bash`.
2. The `AgentType` type is enforced via Zod schema (`AgentTypeSchema`).
3. Each agent's CLI is pre-installed in the container image as a global npm package (or native binary for Go-based agents).
4. Node.js-based agent CLIs (Codex, Gemini, Copilot) are pre-warmed at image build time so V8's compile cache is populated before the user's first interactive launch. Claude Code ships as a native binary and needs no warm-up; Go-based agents (OpenCode) are natively compiled.

**Constraints:**

- Agent CLI versions are installed via `@latest` at build time; versions may drift between deploys.
- Major version jumps between deploys have caused regressions; monitoring is required after deploys.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 describe -> POST /api/sessions accepts/persists agentType + Zod rejects invalid + all 6 valid types + lastAgentType via PATCH /preferences + default claude-code -> AC1..AC5) -->
### REQ-AGENT-002: Agent Selection at Session Creation

<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/lib/schemas.ts -->
<!-- @test: src/__tests__/lib/agent-config.test.ts (getDefaultTabConfig describe → AC1/AC2/AC5) -->

**Intent:** Users must be able to choose which AI agent to use when creating a session.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/sessions` accepts an optional `agentType` field in the request body.
2. Invalid agent types are rejected at session creation.
3. The selected agent type is persisted in the session record.
4. The UI defaults to the agent type used in the user's most recent session.
5. When `agentType` is not specified, it defaults to `claude-code`.

**Constraints:**

- Agent type is immutable after session creation (a new session is required to switch agents).
- The `bash` agent type provides a plain terminal without an AI agent.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (configure_tab_autostart / REQ-AGENT-003 describe -> bash harness extracts the real function from entrypoint.sh and reads generated .bashrc; claude --dangerously-skip-permissions emitted + PATH=/usr/local/bin:/usr/bin:/bin set + MANUAL_TAB skip branch present + TAB_CONFIG honored + invalid tab ids rejected + idempotent on re-run -> AC1, AC2, AC3, AC4) -->
### REQ-AGENT-003: Agent CLI Auto-Started in Tab 1

<!-- @impl: entrypoint.sh::configure_tab_autostart -->
<!-- @impl: host/src/prewarm-config.ts -->

**Intent:** When a session starts, the selected agent's CLI must be running and ready in the first terminal tab without manual user intervention.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint configures the selected agent's launch command to run automatically when tab 1's shell starts.
2. Claude Code starts in permissions-bypass mode appropriate for an isolated sandbox container.
3. User-opened tabs beyond tab 1 do not auto-start an agent.
4. The agent CLI is findable on the system PATH in all terminal sessions.
5. Pre-warm readiness is detected by first PTY output (any terminal output means the agent is ready).
6. A 20-second hard timeout exists as a safety net if the PTY produces no output.

**Constraints:**

- Auto-update checks for agent CLIs are suppressed at session start to keep startup latency low.
- Each agent has its own mechanism for suppressing auto-updates.
- The autostart command must complete after the initial R2 sync but before bisync baseline to avoid hash mismatches.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](#req-agent-002-agent-selection-at-session-creation), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Integration test

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
2. A single resolver provides the default-to-Standard fallback when no preference is recorded; all callers read through the resolver rather than checking the raw field directly.
3. Mode selection is available in Settings under the session-defaults area.
4. Mode takes effect on any of: explicit "Recreate AI agent skills & rules" action, new bucket creation, payment-provider mode change (upgrade or downgrade via webhook), subscription termination, or Settings toggle of the session-mode preference.
5. On webhook-driven or Settings-driven reconciliation, preseed files are overwritten to match the new mode; user-created files are never deleted (see REQ-AGENT-005 Constraints).
6. Reconciliation triggered by webhooks or Settings is non-fatal: failure does not block the webhook response or the preference write.

**Constraints:**

- Only tiers whose allowed-session-modes list includes Pro can use Pro mode (see REQ-SUB-014).
- When a user is promoted to a Pro-eligible tier, Pro mode becomes their persisted default if they had not already selected a mode.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (getConfigsForMode describe -> default filtered + advanced superset + context-mode gate on/off -> AC1,2) -->
### REQ-AGENT-005: Pro Mode Includes Additional Skills, Rules, Agents, and MCP Servers

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: src/lib/agent-seed.generated.ts -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/entrypoint-context-mode.test.js (entrypoint-context-mode describe → mode-gated context-mode preseed + hooks → AC4/AC5/AC6) -->

**Intent:** Pro mode must provide a significantly enhanced agent experience over Standard - more rules, skills, agent definitions, commands, hooks, and persistent memory. The context-mode helper tools are universally available to every user on demand, while context-mode's automatic context-window-reduction behavior is reserved for the Custom subscription tier.

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode delivers a strict superset of the content Standard mode delivers, covering memory persistence, language rules, agent definitions, slash commands, cherry-picked skills, the discipline triad (spec, docs, tests), and the commit-attribution and PR-boundary review hooks. The canonical per-content-category matrix lives in [documentation/preseed.md](../../documentation/lanes/preseed.md#session-modes); the spec lane documents the user-observable contract only.
2. Pro mode enables persistent memory (the `.memory/` directory is included in storage sync); Standard mode excludes it so memory does not persist across container restarts.
3. Pro-mode hooks fire uniformly regardless of which tool surface invoked the underlying command, so coverage is identical whether the user is on Custom tier (commands route through context-mode) or any other tier (commands run directly): commit attribution is blocked before the commit lands, the SDD review pipeline is triggered at every PR-to-`main` boundary event, the turn cannot end while a PR HEAD remains unreviewed, and memory capture runs on the user-prompt cadence.
4. The context-mode helper tools are available to every user on every session regardless of subscription tier or session mode, so the agent can always invoke them on demand.
5. Custom-tier Pro users additionally receive context-mode's automatic context-window-reduction behavior: large tool output stays out of the conversation window unless the agent explicitly retrieves it, and commands that would flood the window are redirected to the equivalent helper tool. Any other tier-and-mode combination receives the helper tools without the automatic redirection.
6. Downgrading away from Custom tier, or switching away from Pro mode, removes the Custom-tier-only behavior on the next reconcile so the automatic redirection no longer fires.

**Constraints:**

- Cleanup on mode switch is scoped strictly to preseed-managed content; user-created files are never deleted.
- The Custom-tier context-mode behavior must be delivered through the platform's preseed pipeline, never through a user-driven marketplace install that could mutate settings outside the platform's control.

**Priority:** P1

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test

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
6. The generator produces output for all supported agents (Claude Code as the source-of-truth lane plus adapted lanes for Codex, Gemini, Copilot, OpenCode).

**Constraints:**

- The generated output must stay in sync with the manifest and sources; the build pipeline enforces this.
- The generated output is never hand-edited; updates go through the source tree and the generator.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-007: Multi-Agent Adaptation Pipeline

<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe → AC1-AC4) -->

**Intent:** Each supported agent must receive properly adapted configurations matching its specific config format, tool names, and file conventions.

**Applies To:** User

**Acceptance Criteria:**

1. Adapted configs are generated for all 5 supported agents from the Claude Code source.
2. Tool names are remapped per agent (e.g., `Read` -> `read_file` for Gemini, `Read` -> `read` for Codex).
3. Instructions are concatenated into a single file for agents that use monolithic config (Codex: `AGENTS.md`, Gemini: `GEMINI.md`, Copilot: `copilot-instructions.md`, OpenCode: `AGENTS.md`).
4. Claude Code keeps individual rule files in `~/.claude/rules/`.

**Constraints:**

- Hooks, commands, and plugins are excluded from non-CC agents (they are CC-specific features).
- `rules/memory.md` and `consult-llm` skill are excluded from non-CC agents (they depend on CC-specific MCP).
- Each non-CC agent gets a strictly-smaller config than Claude Code, since CC is the source-of-truth lane and other agents drop CC-specific content (hooks, slash commands, plugins, MCP-dependent rules/skills).
- The per-agent format transforms (frontmatter shape, removed fields, path rewrites, file extensions) live in [REQ-AGENT-030](#req-agent-030-multi-agent-format-transforms).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC4: reconcileAgentConfigs describe -> overwrite:false skips existing R2 objects on new-bucket path + result shape always has written/skipped/deleted/warnings arrays -> AC1 new-bucket overwrite:false + cleanup:false) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (entrypoint.sh bisync daemon behavior describe -> initial rclone sync restores R2-deployed preseed onto ~/.claude/ etc. before tab autostart -> AC2 entrypoint sync restores preseed) -->
<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration describe -> hooks-aware merge: non-hook fields recursive merge + hook arrays rebuilt per event type preserving user hooks + replacing managed hooks via the codeflare-/graphify/context-mode detector -> AC3 hooks-aware merge) -->
<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (plugin enablement describe -> advanced mode includes PreToolUse/PostToolUse/UserPromptSubmit hook registrations + default mode omits them -> AC4 advanced-mode hook registrations) -->
### REQ-AGENT-008: Preseed Deployed to Container on Start

<!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs describe -> AC1/AC2/AC5/AC6 preseed write + sync + plugin enable + malformed-file handling) -->

**Intent:** Preseed files must be available in the container's filesystem when the agent launches so that rules, skills, and agent definitions are active from the first prompt.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, mode-appropriate preseed files are written to the user's R2 bucket without overwriting any existing objects and without removing anything.
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

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AGENT-009: LLM API Key Storage (Encrypted in KV)

<!-- @impl: src/routes/llm-keys.ts -->
<!-- @impl: src/lib/kv-crypto.ts -->
<!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes describe → AC1-AC5) -->

**Intent:** Users must be able to store LLM provider API keys so that cross-model consultation features work without re-entering keys each session.

**Applies To:** User

**Acceptance Criteria:**

1. Users can store one or both supported LLM provider keys (OpenAI and Gemini) through a single management endpoint.
2. The update interface supports three semantics per key: a new value replaces, an explicit null deletes, an absent field leaves the existing value unchanged.
3. Keys are persisted in durable storage scoped to the user's bucket so two users cannot read each other's keys.
4. When platform-level credential encryption is configured, values are encrypted before persistence.
5. Read responses return masked values (only the trailing characters are visible); the full key is never returned to the client.

**Constraints:**

- Encryption follows the cryptographic contract in [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract).
- The ciphertext carries a version prefix so future schemes can be added without breaking reads.
- Plaintext values are transparently upgraded to encrypted on read when encryption is configured.
- Propagation to the container env + MCP wiring live in [REQ-AGENT-031](#req-agent-031-llm-api-key-propagation-to-container).

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)

<!-- @impl: src/routes/deploy-keys.ts -->
<!-- @impl: src/lib/kv-crypto.ts -->
<!-- @test: src/__tests__/routes/deploy-keys.test.ts (deploy-keys routes describe → AC1-AC4) -->
<!-- @test: web-ui/src/__tests__/lib/token-scopes.test.ts (token-scopes describe → scope tier definitions → AC1 contract) -->

**Intent:** Users must be able to store GitHub and Cloudflare credentials so that git push, repository management, and Cloudflare deployments work without re-authenticating each session.

**Applies To:** User

**Acceptance Criteria:**

1. Tokens are validated against the provider's own API before being stored, so an invalid or expired token is rejected up front rather than discovered at use time.
2. Read responses return masked tokens; the full value is never returned to the client.
3. Users can clear all stored deploy credentials in a single action.
4. Deploy credentials are persisted in durable storage scoped to the user's bucket and are encrypted at rest when platform-level credential encryption is configured.

**Constraints:**

- Tokens are validated against the provider's API before being persisted; an unreachable provider is surfaced as an upstream error and the credential is not stored, so the store never contains a token of unknown validity.

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-011: Agent Skills & Rules Manually Recreatable from Settings

<!-- @impl: src/routes/storage/seed.ts -->
<!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
<!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes describe -> AC1/AC3 recreate endpoint + storage-stats KV cache invalidation) + src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 reconcileAgentConfigs describe -> AC2/AC4/AC5 overwrite-and-cleanup with user-file preservation) -->

**Intent:** Users must be able to reset their agent skills and rules to the platform defaults at any time, recovering from accidental deletion or corruption.

**Applies To:** User

**Acceptance Criteria:**

1. A "Recreate AI agent skills & rules" action in the settings UI triggers a reseed of preseed-managed agent configuration.
2. The reseed performs a full overwrite-and-cleanup of all preseed-managed files for the user's current session mode.
3. Overwrite replaces every preseed-managed file with the current default content.
4. Cleanup removes preseed-managed files that are not part of the user's current session mode.
5. User-created files (files not generated by the preseed pipeline) are never overwritten or deleted.
6. The endpoint is rate-limited (3/min).
7. After seeding, the storage stats KV cache is invalidated.

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

<!-- @impl: entrypoint.sh -->
<!-- @impl: src/container/container-env.ts -->
<!-- @test: src/__tests__/routes/preferences.test.ts (fastStartEnabled preference describe -> AC1/AC5 settings toggle + KV persistence) + src/__tests__/container/container-env.test.ts (buildEnvVars describe -> AC1 fast-start propagation to container runtime env) + src/__tests__/routes/container-restart-prefs.test.ts (REQ-SESSION-008 AC5 describe -> AC4 fast-start applied on restart) -->

**Intent:** Agent CLIs must start quickly by default, with an option for users who want automatic updates.

**Applies To:** User

**Acceptance Criteria:**

1. A fast-start preference (default: enabled) controls whether agent CLIs skip auto-update checks at launch, and the user's choice is propagated into the container's runtime environment.
2. When enabled, auto-update checks are disabled for all 5 AI tools, eliminating 5-30s startup delay.
3. Every supported agent CLI has a corresponding disable mechanism: each tool's native auto-update path is suppressed by the channel that tool exposes (environment variable for tools that expose one, on-disk settings file for tools that don't). For settings-file tools, user customizations are preserved across container restarts.
4. When the fast-start preference is disabled, the suppression channels are not applied and each CLI runs its normal update check on launch.
5. Users can toggle the preference from the session defaults area of the application settings.

**Constraints:**

- Gemini settings file is synced via rclone, so jq merge must preserve user customizations.
- Codex `~/.codex/` directory is excluded from sync, so `version.json` is safe to recreate on every start.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-013: Browser Shim for OAuth Flows

<!-- @impl: Dockerfile -->
<!-- @impl: web-ui/src/lib/terminal-link-provider.ts -->

**Intent:** Agent CLIs that attempt to open a browser for OAuth must degrade gracefully to printing clickable URLs in the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. A browser-shim is installed in the container that intercepts browser-launch attempts and exits with a non-zero code, causing the calling CLI to fall back to plain-text URL output.
2. The XDG browser-launch entry-point is similarly shimmed so any tool that bypasses the BROWSER convention also degrades to text output.
3. CLIs fall back to printing auth URLs as plain text in the PTY when the browser fails to open.
4. The xterm.js link provider detects URLs in terminal output and makes them clickable.

**Constraints:**

- The shim must not block or hang; it must exit immediately with a non-zero code.
- All CLI tools that attempt browser-based OAuth (Claude Code, OpenCode, Gemini) must be covered.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Manual check

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

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-015: /review command for multi-perspective codebase review

<!-- @impl: preseed/agents/claude/commands/review.md -->

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

None.

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration describe -> exercises the entrypoint MCP config merge path that also wires consult-llm when LLM_ENV is non-empty -> AC3 wiring) -->
### REQ-AGENT-016: consult-llm preference toggle

<!-- @impl: src/container/container-env.ts -->
<!-- @impl: entrypoint.sh -->

**Intent:** Users control whether their LLM API keys power the multi-model consultation feature.

**Applies To:** User

**Acceptance Criteria:**

1. Toggle in Settings controls whether OpenAI/Gemini keys are passed to the consult-llm MCP server.
2. Default: off.
3. When off, consult-llm is not configured in the agent's MCP settings.

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Integration test

**Status:** Partial

**Notes:** AC1 and AC2 unmet: there is no explicit Settings toggle. The consult-llm MCP surface is currently activated implicitly when at least one LLM provider key is configured; presence-of-key acts as the on/off. Closing the gap requires a frontend preference plus a gating field on the per-user preference record consulted by the container env-var forwarder.

---

<!-- @test: host/__audits__/dockerfile-agents.audit.js (Dockerfile bubblewrap install describe -> bubblewrap in apt-get install + Codex sandbox documentation -> AC1,2) -->
### REQ-AGENT-017: Bubblewrap sandbox for Codex

<!-- @impl: Dockerfile -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (Dockerfile graphify install describe → bubblewrap apt-installed → AC1) -->

**Intent:** Codex agent runs in a bubblewrap sandbox for additional isolation within the container.

**Applies To:** User

**Acceptance Criteria:**

1. bubblewrap (bwrap) is installed in the container image.
2. Codex uses it for sandboxed execution.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Automated test

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

- Must comply with CON-SEC-003

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Integration test

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
4. Session section with agent type, sleep timeout, session mode dropdowns.

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

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

- Must comply with CON-SEC-003

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AGENT-021: Pro-Mode SDD Workflow Preseed and Tool-Surface Portability

<!-- @impl: preseed/agents/claude/skills/spec-driven-development -->
<!-- @impl: preseed/agents/claude/rules/spec-discipline.md -->
<!-- @impl: preseed/agents/claude/rules/documentation-discipline.md -->
<!-- @impl: preseed/agents/claude/rules/tdd-discipline.md -->
<!-- @test: src/__tests__/lib/agent-seed-ecc-rules.test.ts (spec-discipline + documentation-discipline + tdd-discipline + graph-first advanced-only describes -> AC1 Pro-mode rule preseed) -->

**Intent:** Pro users need the spec-driven-development workflow available out of the box, with every sub-command working identically across Bash and context-mode MCP tool surfaces so the workflow does not silently behave differently across container environments.

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode preseeds the `spec-driven-development` skill, the `sdd-init` and `sdd-clean` sub-command skills, the `vault-operations` skill, the `/sdd` command, the `spec-discipline`, `documentation-discipline`, and `tdd-discipline` rules (loaded into every agent's instructions), and the `spec-reviewer` + `doc-updater` agents.
2. Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works under both Bash and the context-mode MCP tool family (`mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, `mcp__context-mode__ctx_search`).
3. Discovery commands producing more than 20 lines of output (`gh pr list --state all`, `git log --follow`, `npm view <pkg> peerDependencies`, full-tree scans, scaffold-only `npm install --package-lock-only`) route through context-mode's ctx_execute family in context-mode environments and through Bash in plain environments, with the agent selecting the right wrapper for its environment.

**Constraints:**

- The `/sdd init` scaffolding contract lives in [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render); the enrichment pass with graphify queries lives in [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify); the Phase 7a source-anchor verifier gate lives in [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) and the Phase 7b enumeration-coverage verifier gate lives in [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate); the PR-boundary review pipeline lives in [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions); the `/sdd clean` rescue and autonomy modes + discipline enforcement live in [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes).

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-033: `/sdd init` Scaffolding and Canonical Render

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @impl: preseed/agents/claude/commands/sdd.md -->
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

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify), [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate), [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate)

**Verification:** Manual check

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

**Verification:** Manual check

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

**Verification:** Manual check

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

**Verification:** Manual check

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

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-036: PR-Boundary Review Trigger Conditions

<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh -->
<!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh — PR-OPEN trigger (base-gated) describe + PR-SYNC trigger (base-gated) describe -> AC1 PR target main/master only + AC3 intermediate branches deferred + git-push-review-reminder.sh — MCP shell tool input shapes (issue #317) describe -> AC2 PUSH_LINE detection across Bash/MCP surfaces) + host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — PR state gating describe -> AC1/AC6 PR-state HEAD check + AC4 no-PR push no-op + enforce-review-spawn.sh — vibe-coding gate describe -> AC7 non-SDD projects exit silently + enforce-review-spawn.sh — MCP shell tool input shapes (issue #319) describe -> AC2 PUSH_LINE detection across Bash/MCP surfaces) -->

**Intent:** Review agents must fire only on PR-boundary events that actually target shipping code. Trigger detection runs across every tool surface that can move HEAD, ignores intermediate-branch and no-PR pushes so vibe-coding mode and integration-branch development stay friction-free, and assumes upstream branch protection guards direct pushes to `main`. Lane classification + agent dispatch live in [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch); bypass surfaces live in [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces).

**Applies To:** User

**Acceptance Criteria:**

1. PR-boundary review fires only for PRs targeting `main` or `master` (a new PR opens with that target via `gh pr create`, or a push lands on a branch with an open PR to that target).
2. PUSH_LINE detection recognises both `git push` and `gh pr merge` across all three tool surfaces (Bash, `mcp__*__ctx_batch_execute`, `mcp__*__ctx_execute` with `language=shell`); the `gh pr merge` surface is required because a server-side merge into `develop` advances the develop->main PR HEAD without producing a local `git push` line.
3. PRs into intermediate integration branches (`develop`, `staging`, etc.) do NOT trigger reviews; the case is deferred until the integration branch's own PR-to-`main` opens or syncs, where the cumulative review covers everything that landed.
4. A plain push to a branch with no open PR does NOT trigger reviews.
5. Direct pushes to `main` are expected to be prevented by GitHub branch protection (require PR before merge); the review pipeline is not engineered to compensate for a bypass that the upstream platform already blocks.
6. Layer 2 false-positive filtering compares the candidate push's HEAD SHA against `gh pr view`'s reported HEAD before any agent is spawned.
7. On non-SDD projects (no `sdd/` folder) no review agents run at all; every hook exits silently and the workflow proceeds friction-free (vibe-coding mode).

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-040: PR-Boundary Lane Classification and Agent Dispatch

<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh -->
<!-- @test: host/__tests__/lane-classifier.test.js (compute_required_lanes describes -> AC1/AC2/AC3 shared helper + lane mapping + conservative fallback to all-three-lanes) + host/__tests__/enforce-review-spawn.test.js (lane gating describe -> AC4 sequential spec-reviewer then doc-updater + AC5 fix-push cascade ack-pointer advancement) -->

**Intent:** Once a PR-boundary trigger fires (REQ-AGENT-036), a shared lane classifier picks the minimal correct set of review agents from the diff so the in-turn nudge and turn-end gate agree, and a fix-push cascade can advance the ack pointer without losing review coverage.

**Applies To:** User

**Acceptance Criteria:**

1. Layer 1 lane classification uses a single shared helper so the in-turn nudge and the turn-end gate agree on which review agents the diff requires.
2. Lane mapping: docs-only (no sdd, no source) → `doc-updater`; `sdd/` touched without source (with or without docs) → `spec-reviewer` then `doc-updater`; any source touch → all three agents.
3. Conservative branches (empty diff, missing prior ack, divergent merge-base) and a missing or unsourceable helper both fall back to all-three-lanes (`code-reviewer spec-reviewer doc-updater`), so a partially-deployed install never disables enforcement.
4. On trigger, `spec-reviewer` runs first then `doc-updater` (sequential, never parallel) on any project containing `sdd/`.
5. In a fix-push cascade (multiple pushes inside one turn), the gate advances the ack pointer through each push whose review window completed all lanes required by that push's diff; bypassed pushes (no spawns in window, per REQ-AGENT-041) are absorbed into the next complete window's cumulative review.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-041: PR-Boundary Review Bypass Surfaces

<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh -->
<!-- @test: host/__tests__/enforce-review-spawn.test.js (bypass 1: sentinel file + bypass 2: magic phrase + 3-strike circuit breaker describes -> AC1/AC2/AC3 user-only escape hatches with sticky-until-SHA-changes circuit) -->

**Intent:** The user needs a small set of explicit, user-only escape hatches when a turn-end review gate would otherwise block legitimate work (hermetic tests, deliberate skip, repeated false-block). The assistant MUST NEVER trip these surfaces in its own output.

**Applies To:** User

**Acceptance Criteria:**

1. A user-creatable one-shot sentinel file bypasses the Stop-hook gate for a single turn; the sentinel is auto-deleted on use, never committed, and never survives container restart. The sentinel location is overridable for hermetic test environments.
2. A magic phrase `skip review` or `skip verification` (case-insensitive, word-bounded) in any user message after the candidate push line in the transcript bypasses the gate for that push.
3. A 3-strike circuit breaker exits silently after blocking the same un-acked PR HEAD SHA three times, sticky until the SHA changes.
4. The assistant MUST NEVER create the sentinel file or write the magic phrase in its own output; both are explicitly user-only escape hatches.

**Constraints:**

- These bypass surfaces apply only to the turn-end gate (Stop hook); the in-turn nudge and trigger detection in REQ-AGENT-036 are unaffected.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-037: `/sdd clean` Rescue and Autonomy Modes

<!-- @impl: preseed/agents/claude/skills/sdd-clean -->
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

**Verification:** Manual check

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

**Verification:** Manual check

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

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-045: Import-Mode Triage Queue and Transition State

<!-- @impl: preseed/agents/claude/skills/sdd-init -->
<!-- @test: host/__tests__/skill-sdd-init-contract.test.js (REQ-AGENT-045 describes -> AC1 .init-triage.md location + AC2/AC3 Status: open|resolved|lost vocabulary and Reason: requirement on lost) + host/__tests__/enforce-review-spawn.test.js + host/__tests__/git-push-review-reminder.test.js (SDD transition gate (REQ-AGENT-022) describes -> AC4 transition: true suspends entire review pipeline) -->

**Intent:** Every unclear item from Import Mode lands in a typed triage entry with concrete Context evidence so the human resolver can decide without re-investigating, and the transition state suspends the entire review pipeline so legacy code does not trigger reviewers until the spec is real. Status defaults respect the project's TDD opt-out so imported codebases do not get falsely flagged as incomplete.

**Applies To:** User

**Acceptance Criteria:**

1. Every entry in `sdd/.init-triage.md` carries `**Context:**` (concrete evidence: file path + line range, git author of last meaningful change, commit SHA + subject, related tests, related PR numbers, related issue numbers, related release tags) and `**Recommendation:**` (the agent's specific best-guess answer) with `**Rationale:**` (one line tying the recommendation to specific Context evidence).
2. Vague Context (no refs, no authors, no artifact numbers) and placeholder Recommendations (`TBD`, `(inferred)`, `unknown`) are rejected as malformed triage entries.
3. Triage entries use `**Status:** open | resolved | lost`; `lost` requires a one-line `**Reason:**` field explaining why the information is genuinely unrecoverable.
4. While `sdd/.init-triage.md` contains any `Status: open` items, `sdd/config.yml` carries `transition: true` and the project is in SDD transition; during transition the entire review pipeline is suspended (code-reviewer, spec-reviewer, and doc-updater do not fire on any push or PR event) and `/sdd mode unleashed` is rejected with a message naming the open-item count.
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

**Verification:** Manual check

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

**Verification:** Manual check

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

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-023: Knowledge-Graph Capability (Graphify)

<!-- @impl: preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh -->
<!-- @impl: Dockerfile -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/entrypoint-graphify-mcp.test.js (MCP server registration in ~/.claude.json → AC2) -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (graphifyy pip install + pinned version → AC1/AC3) -->
<!-- @test: host/__tests__/graphify-active-repo.test.js (active-repo sentinel writer → AC5) -->
<!-- @test: host/__tests__/graphify-mcp-lazy.test.js (LazyGraph rebind on graph.json appearance → AC4/AC6) -->
<!-- @test: host/__tests__/safe-graphify-update.test.js -->
<!-- @test: host/__tests__/entrypoint-devshm-prereq.test.js (REQ-AGENT-023 prereq: /dev/shm tmpfs mount in entrypoint.sh describe -> /dev/shm mountpoint after entrypoint runs + Python multiprocessing.Lock allocates + idempotent on warm boot -> AC1 graphify Python multiprocessing prerequisite) -->
<!-- @test: host/__tests__/context-mode-version-pin.test.js (context-mode plugin.json version pin describe -> at least v1.0.151 -> regression sentinel for issue #671 fix surface; REQ-AGENT-005 AC4/AC5 context-mode version floor) -->

**Intent:** Every container ships the graphify code-knowledge-graph capability as ambient infrastructure, so any session (default or advanced session mode) can query an existing graph or build a new one without per-tier provisioning.

**Applies To:** Agent

**Acceptance Criteria:**

1. The `graphifyy` Python package is installed in every container image at build time with the MCP, SQL, and PDF extras, pinned to a single version Dependabot tracks; version bumps rebuild the image in lockstep.
2. The graphify MCP server is registered as a session-level capability in every session (default and advanced modes) and exposes the standard graphify tool surface for querying nodes, neighbours, communities, paths, and aggregate stats.
3. AC1 and AC2 hold across all paid tiers; the capability functions in sessions without context-mode preseeded because the agent-orchestrated `/graphify` skill keeps the main agent's context bounded via subagent chunking.
4. The MCP server tolerates a missing graph artefact at startup, presents an empty graph initially, and rebinds within a short polling interval after a graph appears or changes on disk; sessions that clone a repo mid-session do not require a restart.
5. In advanced session mode only, the user's current active repository is tracked so the MCP server scopes its bind to that repo; resolution walks up to the nearest ancestor containing a Git repository or a graph artefact.
6. When the active-repo signal is absent or stale, the MCP server falls back to the most recently updated graph artefact in the user's workspace.

**Constraints:**

- The codeflare image uses the upstream graphify package without a fork.
- The ambient MCP capability is available in every session mode; the graph-first agent discipline (REQ-AGENT-024) and active-repo tracking (AC5) are mode-gated to advanced.
- Per-branch graphs are not supported; users refresh the graph after a branch checkout.
- Optional backend-provider and office extras are not installed by default; users who need them install upstream extras manually.
- Preseed surfaces that invoke `graphify update` (prompts, skills, commands, hooks) call the bounded wrapper rather than the bare CLI, so a runaway rebuild cannot OOM-kill the container session.
- The container entrypoint ensures `/dev/shm` is present and tmpfs-mounted at boot. Graphify's AST extractor uses Python's `concurrent.futures.ProcessPoolExecutor`, which allocates a `multiprocessing.Lock` that requires POSIX shared memory at `/dev/shm`; on a cold Firecracker microVM boot the rootfs ships without the mountpoint directory and the executor fails at startup. The same prerequisite covers the memory-capture hook's chunker and the vault-extract subagent's writer.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-008](#req-agent-008-preseed-deployed-to-container-on-start)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-024: Advanced-Session-Mode Graph-First Discipline

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh -->
<!-- @impl: preseed/agents/claude/rules/graph-first.md -->
<!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md -->
<!-- @test: host/__tests__/entrypoint-graphify-hooks.test.js (entrypoint hook installation → AC1/AC7) -->
<!-- @test: host/__tests__/graphify-session-start.test.js (SessionStart graph-context injection → AC1) -->
<!-- @test: host/__tests__/graph-first-nudge.test.js (PreToolUse soft-nudge matcher set → AC7) -->
<!-- @test: host/__tests__/preseed-graphify-discipline.test.js (rule + SKILL preseeded in advanced only → AC2/AC3) -->
<!-- @test: host/__tests__/skill-graphify-content.test.js (SKILL contents → AC4/AC5/AC6) -->

**Intent:** In advanced session mode, the agent is taught to prefer the knowledge graph over Grep-style text search for structural questions, so token cost on architecture, dependency, and call-flow questions is bounded. This REQ covers the SessionStart context injection, the preseeded rule and SKILL surface, and the soft-nudge PreToolUse hook. The hard-block enforcement lives in [REQ-AGENT-042](#req-agent-042-graphify-hard-block-enforcement); the `/graphify` build dispatch lives in [REQ-AGENT-043](#req-agent-043-graphify-build-mode-dispatch).

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a SessionStart hook injects a graph-context reminder when the cwd already has a knowledge graph (pointing the agent at the human-readable report and MCP tools); when the cwd looks like a code repo without a graph, the hook instead injects a build-suggestion reminder.
2. In advanced session mode only, a short authoritative graph-first rule is preseeded, stating MUST / MUST NOT bullets for graph vs grep and routing to the graphify skill for mechanics rather than restating them.
3. In advanced session mode only, the graphify skill is preseeded for Claude Code, with per-agent adapted variants emitted for Codex, Copilot, and OpenCode by the seed generator.
4. The skill documents the safe build path for large repos (more than 2000 files).
5. The skill instructs the agent on first build to add canonical ignore and attribute rules so regenerable graph build outputs and working-tree intermediates are not committed while the queryable graph remains under git merge control.
6. The committed knowledge-graph surface includes the queryable graph artefact, a human-readable report, a visual exploration page, and an optional wiki tree.
7. In advanced session mode only, a soft-nudge hook fires on grep-class tool calls and emits a reminder to prefer the graph MCP tools when a graph exists for the cwd; the hook never blocks.

**Constraints:**

- The SessionStart hook never auto-builds a graph. It only injects context when one exists or a build suggestion when source files are present without one.
- The soft-nudge hook never blocks; semantic judgment of whether a single grep is appropriate cannot be reliably made up-front. The hard-block in [REQ-AGENT-042](#req-agent-042-graphify-hard-block-enforcement) enforces a quantitative threshold (3 grep-class calls without a graph query), so the two layers compose: nudge on every call, block only when the pattern persists.
- The soft-nudge matcher set covers both the non-ctx tool surface (`Grep`/`Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`/`mcp__context-mode__ctx_batch_execute`) because the context-mode enforcement hook denies `Grep`/`Glob`/`Read` in custom-tier sessions.

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-042: Graphify Hard-Block Enforcement

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/enforce-graphify.sh -->
<!-- @test: host/__tests__/enforce-graphify.test.js (3-call threshold + bypass surfaces + sentinel resolution → AC1-AC7) -->

**Intent:** The graph-first soft-nudge in REQ-AGENT-024 informs but never blocks. When an agent ignores it across multiple calls, a hard-block hook denies further structural searches until a graph query is made, with explicit user-only bypass surfaces for legitimate edge cases.

**Applies To:** Agent

**Acceptance Criteria:**

1. The hard-block hook fires on PreToolUse for `Grep`, `Bash`, `mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, and `mcp__context-mode__ctx_execute_file` matchers in advanced session mode only.
2. After 3 SEARCH-classified tool calls in one turn with no intervening `mcp__graphify__*` call (or `graphify query|path|explain` CLI invocation), the next SEARCH call is denied.
3. SEARCH classification matches `grep|rg|ag|ack`, `git grep`, `find` with `-name|-path|-iname|-ipath|-regex`, and `awk` with `/regex/` body.
4. The shell parser reuses the context-mode enforcement hook's `extract_subs` / `normalize_command` / chain-op splitter so substitution, heredocs, quoted regions, and pipeline segments cannot slip past.
5. Active-repo resolution reads the sentinel at `~/.cache/codeflare-hooks/graphify-active-cwd` (REQ-VAULT-004 AC1) and gates on `<active-repo>/graphify-out/graph.json` existing, falling back to the tool-call envelope `.cwd` when the sentinel is absent.
6. The vault entry in `~/.graphify/global-graph.json` is NOT enforcement-eligible: a session whose active repo has no graph does not trigger the hard-block, so the user can grep freely in repos they have not yet graphified.
7. Two user-only bypass surfaces are available: `touch /tmp/graphify-bypass` (one-shot, auto-deleted) and the magic phrase `skip graph` in a user message; any unexpected error inside the hook returns exit 0 so the user is never locked out.

**Constraints:**

- The codeflare session layout (every agent session has `cwd=~/workspace`, never inside a sub-repo) makes the sentinel the load-bearing signal; the envelope-cwd fallback exists for vanilla graphify usage outside codeflare.

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline), [REQ-VAULT-004](vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-043: Graphify Build Mode Dispatch

<!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md -->
<!-- @test: host/__tests__/skill-graphify-content.test.js (AST-only vs Full mode question + Haiku default → AC1-AC5) -->

**Intent:** Before a `/graphify` build dispatches semantic-extraction subagents, the user must explicitly choose between a free AST-only build and a full build that costs LLM tokens. The dispatched subagents run on Haiku by default so build cost matches vault-extract economics.

**Applies To:** Agent

**Acceptance Criteria:**

1. Before dispatching semantic-extraction subagents in a `/graphify` build (Step B2 of the upstream protocol), the agent presents an `AskUserQuestion` with exactly two modes: AST-only (free, structural edges only) and Full (AST plus parallel Haiku subagents extracting concepts from docs/papers/images).
2. The mode question includes both the actual subagent count and a wall-time estimate.
3. The question is skipped only when the corpus contains zero docs/papers/images (code-only repos go straight to Part C with nothing for Part B to do).
4. In advanced session mode only, Part B semantic subagents are dispatched with `model: "haiku"` so per-build cost matches vault-extract economics (~1/8 of opus, ~1/3 of sonnet).
5. Escalation to Sonnet is permitted only when `--mode deep` was explicitly passed on the `/graphify` command; Opus is never used from this skill.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-025: Post-Clone Graph Triage

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh -->
<!-- @test: host/__tests__/graphify-clone-prompt.test.js (clone-detect + graph-present/absent branch + idempotency marker → AC1-AC3) -->

**Intent:** After the agent clones a repo, it must triage whether to build (or refresh) a knowledge graph for it before doing other work, so users on unfamiliar repos do not start cold.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a PostToolUse hook on `Bash` and `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute` matchers detects `git clone` and `gh repo clone` invocations (anchored token regex, not substring; rejects echoed false positives) and injects a directive.
2. The directive branches on whether `<cloned-dir>/graphify-out/graph.json` already exists: if absent, the directive instructs the agent to prompt the user via `AskUserQuestion` and run a full `/graphify` build on confirmation; if present, the directive tells the agent to skip the prompt and run `graphify update .` (AST-only incremental refresh).
3. The hook is idempotent per cloned directory per session via a marker file under `/tmp/codeflare-graphify-prompted-<session_id>/`. The marker dir is session-scoped via `session_id` from the hook envelope (fallback `ppid-$PPID`) so a fresh session re-triages the same clone and stale markers do not persist across container restarts.

**Constraints:**

- The hook never invokes graphify directly. It only injects a directive instructing the agent to prompt the user via AskUserQuestion (or to run `graphify update` for the graph-present branch).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-026: Knowledge-Graph Persistence via Git

<!-- @impl: entrypoint.sh -->
<!-- @impl: Dockerfile -->
<!-- @test: host/__tests__/entrypoint-graphify-bisync.test.js (rclone bisync excludes **/graphify-out/** → AC1) -->
<!-- @test: host/__tests__/dockerfile-graphify.test.js (global merge driver registration → AC2) -->

**Intent:** Graphify artifacts persist with the repository, not with the user, so contributors on a clone inherit the graph for free and Codeflare's R2 bisync does not carry per-repo graph data.

**Applies To:** Agent

**Acceptance Criteria:**

1. Knowledge-graph artefacts are excluded from R2 sync, so they never round-trip through user-bucket storage.
2. The container image registers the graphify semantic merge driver globally, independent of session mode.
3. Repo owners with push permission commit the knowledge-graph artefacts to git so contributors inherit the graph and the visualization on clone; concurrent edits to the graph artefact are auto-resolved by the registered merge driver without manual JSON conflict resolution.
4. For repos without push permission, the graph lives in the working tree only and is ephemeral.

**Constraints:**

- Per-repo ignore and merge-attribute wiring is the responsibility of the graphify skill (REQ-AGENT-024 AC5); this REQ covers only the platform-level pieces (sync exclusion, global merge-driver registration).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-027: Context-Mode Interoperability

<!-- @impl: preseed/agents/claude/plugins/context-mode -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh -->
<!-- @test: host/__tests__/enforce-ctx-mode-graphify.test.js (graphify in context-mode Bash whitelist → AC1) -->
<!-- @test: host/__tests__/graph-first-nudge.test.js (soft-nudge fires on ctx_search/ctx_batch_execute → AC2) -->

**Intent:** When the context-mode plugin is preseeded, the graphify CLI must coexist with the enforce-ctx-mode Bash whitelist and the graph-first soft-nudge must reach the agent through context-mode's redirected tool-call path.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the context-mode plugin is preseeded (effectiveTier `unlimited` plus advanced session mode), `graphify` is in the context-mode Bash whitelist so `graphify update .` and `graphify query ...` are not denied.
2. The REQ-AGENT-024 AC7 PreToolUse soft-nudge hook registers both the non-ctx matchers (`Grep`, `Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`, `mcp__context-mode__ctx_batch_execute`) so the nudge fires in both tier paths.

**Constraints:**

- Graphify must not depend on context-mode at runtime. `/graphify` extraction uses upstream graphify's subagent-chunking model; context-mode, when present, provides bonus per-subagent token routing via its existing `Read|Grep|Glob|Agent` PreToolUse matchers, but is not a precondition.

**Priority:** P2

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test

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

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-031: LLM API Key Propagation to Container

<!-- @impl: src/container/container-env.ts -->
<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe → OPENAI_API_KEY + GEMINI_API_KEY injection → AC1) -->

**Intent:** Stored LLM API keys must reach the container as environment variables and trigger the consult-llm MCP server wiring, so the in-container agent can call OpenAI or Gemini without re-authentication.

**Applies To:** User

**Acceptance Criteria:**

1. Stored LLM API keys are propagated into the container environment at container start so in-container CLIs can call OpenAI or Gemini without re-authentication.
2. When keys are present, the container entrypoint configures the `consult-llm-mcp` MCP server in `~/.claude.json`.
3. Keys are NOT persisted in DO storage; they are read fresh from KV on each container start.

**Constraints:**

- The container reads keys at start and on restart; mid-session key changes take effect only after the next session start.

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-030: Multi-Agent Format Transforms

<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe → per-agent frontmatter + model removal + path rewrites + .agent.md → AC1-AC4) -->

**Intent:** Each non-Claude agent has its own config-file conventions (frontmatter shape, model-field presence, path layout, file extensions). The generator must apply the right per-agent transform so the adapted config is valid for the consumer.

**Applies To:** User

**Acceptance Criteria:**

1. Agent definitions use correct frontmatter format per agent (e.g., `tools` as record `{read: true}` for OpenCode, as array for others).
2. `model` field is removed from frontmatter for non-CC agents.
3. Path references (e.g., `~/.claude/`) are replaced with agent-specific config paths.
4. File extensions match agent conventions (e.g., `.agent.md` for Copilot agents).

**Constraints:**

- Format transforms are derived from each agent's documented config schema; missing schema means the agent is unsupported, not silently passed through.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-029: Deploy Credential Propagation to Container

<!-- @impl: src/container/container-env.ts -->
<!-- @impl: entrypoint.sh -->
<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars describe → GH_TOKEN + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID injection → AC1-AC4) -->

**Intent:** Stored deploy credentials must reach the container as environment variables and be consumed by git, wrangler, and the Cloudflare API auto-fetch step, so the in-container agent can push code and deploy without re-authentication.

**Applies To:** User

**Acceptance Criteria:**

1. Stored GitHub and Cloudflare deploy credentials are injected into the container as environment variables on session start.
2. Credentials are sent as explicit `null` when absent (not omitted) so revocation propagates on session restart.
3. When a GitHub credential is present, the container configures git for authenticated HTTPS access.
4. The Cloudflare account ID is resolved automatically from the API token when one is stored, so users need not supply it separately.

**Constraints:**

- Misconfigured Copilot scope can cause silent agent auth failure; full Copilot support requires the Advanced tier (see [REQ-AGENT-028](#req-agent-028-deploy-credential-token-creation-ux)).

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-028: Deploy Credential Token-Creation UX

<!-- @impl: web-ui/src/lib/token-scopes.ts -->
<!-- @impl: web-ui/src/components/settings/ProviderRow.tsx -->
<!-- @test: web-ui/src/__tests__/lib/token-scopes.test.ts (GITHUB_TIERS + getGithubTokenUrl + CLOUDFLARE_TOKEN_PAGE describes -> AC1 three-tier scope selector with correct scope prefills per tier + AC2 Cloudflare token page targeting) -->

**Intent:** Token creation for GitHub and Cloudflare must guide users through scope selection so they create the smallest token that still unlocks the features they need, without copy-pasting raw scope strings.

**Applies To:** User

**Acceptance Criteria:**

1. GitHub token creation offers three scope tiers (Minimal, Recommended, Advanced) via a selector in the connect flow, with Recommended pre-selected and the URL pre-filling the correct scopes per tier.
2. Cloudflare token creation directs users to use the "Edit Cloudflare Workers" template with account and zone selection. No scope pre-fill (Cloudflare template URLs are broken).
3. A documentation page lists all scopes per tier with explanations of why each is needed, linked from the UI via "See all scopes".

**Constraints:**

- GitHub Minimal: 1 scope (contents). Recommended: 6 scopes (contents, PRs, actions, workflows, administration, secrets). Advanced: all 19 scopes including Copilot.
- Cloudflare: "Edit Cloudflare Workers" template covers Workers, KV, R2, Pages, Containers, Routes. Users add extra scopes (D1, DNS, Access, Turnstile) when their agent requests them.

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-019](#req-agent-019-branded-settings-ui)

**Verification:** Manual check

**Status:** Implemented
