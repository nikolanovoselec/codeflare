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

## REQ-AGENT-001: Support Multiple AI Coding Agents

**Intent:** The platform must support multiple AI coding agents so users can choose the tool that fits their workflow.

**Acceptance Criteria:**
1. Six agent types are defined: `claude-code`, `codex`, `copilot`, `gemini`, `opencode`, `bash`.
2. The `AgentType` type is enforced via Zod schema (`AgentTypeSchema`).
3. Each agent's CLI is pre-installed in the container image as a global npm package (or native binary for Go-based agents).
4. Node.js-based agent CLIs (Codex, Gemini, Copilot) run `--version` at Docker build time to trigger V8 compile cache warm-up via `NODE_COMPILE_CACHE`. Claude Code is a native binary and needs no warm-up. Go-based agents (OpenCode) are natively compiled.

**Constraints:**
- Agent CLI versions are installed via `@latest` at build time; versions may drift between deploys.
- Major version jumps between deploys have caused regressions; monitoring is required after deploys.

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-002: Agent Selection at Session Creation

**Intent:** Users must be able to choose which AI agent to use when creating a session.

**Acceptance Criteria:**
1. `POST /api/sessions` accepts an optional `agentType` field in the request body.
2. `agentType` is validated against `AgentTypeSchema`.
3. The selected agent type is persisted in the session record.
4. `lastAgentType` is stored in `UserPreferences` so the UI can default to the user's last selection.
5. When `agentType` is not specified, it defaults to `claude-code`.

**Constraints:**
- Agent type is immutable after session creation (a new session is required to switch agents).
- The `bash` agent type provides a plain terminal without an AI agent.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-AGENT-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-003: Agent CLI Auto-Started in Tab 1

**Intent:** When a session starts, the selected agent's CLI must be running and ready in the first terminal tab without manual user intervention.

**Acceptance Criteria:**
1. `configure_tab_autostart()` in `entrypoint.sh` writes the agent's launch command into `.bashrc` for tab 1.
2. The agent starts with `--dangerously-skip-permissions` flag (for Claude Code via `claude`). The container sets `IS_SANDBOX=1` to allow this flag when running as root.
3. Auto-start only runs for tab 1; user-created tabs (where `MANUAL_TAB=1`) skip autostart.
4. The `.bashrc` autostart block sets `PATH="/usr/local/bin:/usr/bin:/bin:$PATH"` so PTY sessions find globally installed CLI tools.
5. Pre-warm readiness is detected by first PTY output (any terminal output means the agent is ready).
6. A 20-second hard timeout exists as a safety net if the PTY produces no output.

**Constraints:**
- Auto-updates are disabled by default via `FAST_CLI_START=true` to avoid 5-30s startup delay.
- Each agent has a different auto-update disable mechanism (env var or config file).
- The autostart command must complete after the initial R2 sync but before bisync baseline to avoid hash mismatches.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-AGENT-001, REQ-AGENT-002, REQ-STOR-004
**Verification:** Integration test

**Status:** Implemented

---

## REQ-AGENT-004: Two Session Modes -- Standard and Pro

**Intent:** Users must be able to choose between a Standard mode (essential configs) and a Pro (Advanced) mode (full agent enhancement suite).

**Acceptance Criteria:**
1. Session mode is stored as `sessionMode?: 'default' | 'advanced'` in `UserPreferences` (KV).
2. `resolveSessionMode(prefs)` is the single source of truth for the `?? 'default'` fallback.
3. Mode selection is available in Settings > Session Defaults.
4. Mode takes effect on any of: explicit "Recreate AI agent skills & rules" click, new bucket creation, Stripe mode change (upgrade or downgrade via webhook), subscription termination, or Settings toggle of `sessionMode`.
5. On Stripe-driven or Settings-driven reconciliation, preseed files are overwritten to match the new mode; user-created files are never deleted (see REQ-AGENT-005 Constraints).
6. Reconciliation triggered by webhooks or Settings is non-fatal: failure does not block the webhook response or the preference write.

**Constraints:**
- Only tiers with `'advanced'` in their `sessionModes` array can use Pro mode (see REQ-SUB-014).
- When a user is promoted to `advanced` tier, `sessionMode: 'advanced'` is written to preferences if not already set.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-014
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-005: Pro Mode Includes Additional Skills, Rules, Agents, and MCP Servers

<!-- sdd-allow-large: the 13-row Standard/Pro/Custom-tier content matrix
     IS the contract of this REQ. The matrix and the seven numbered AC
     bullets below are the minimum surface needed to specify what
     Pro mode means. Splitting would fragment a single decision. -->

**Intent:** Pro mode must provide a significantly enhanced agent experience with more rules, skills, agent definitions, commands, hooks, and memory persistence. The context-mode MCP server (`ctx_*` helper tools) is registered for all users so the helpers are universally available on demand; the auto-routing hooks that change agent behavior are reserved for the Custom (unlimited) subscription tier.

**Acceptance Criteria:**

| Content Category | Standard (default) | Pro (advanced) | Pro on Custom tier |
|-----------------|-------------------|----------------|--------------------|
| Memory plugin and rule | No | Yes | Yes |
| Core environment rules | Yes | Yes | Yes |
| Universal coding skills (Cloudflare stack, ship references) | Yes | Yes | Yes |
| consult-llm skill (Claude Code only) | No | Yes | Yes |
| Pro-mode hooks (commit attribution + PR-boundary review pipeline) | No | Yes | Yes |
| Language rules (TypeScript, Python, Go, Swift, common) | No | Yes | Yes |
| Code-review and SDD agent definitions | No | Yes | Yes |
| Slash commands (Claude Code only) | No | Yes | Yes |
| Cherry-picked skills (API/backend/frontend patterns, SDD scaffolding) | No | Yes | Yes |
| Discipline triad rules (spec, docs, tests) | No | Yes | Yes |
| Known marketplaces plugin config | Yes | Yes | Yes |
| context-mode MCP server (`ctx_*` helper tools, always-on) | Yes | Yes | Yes |
| context-mode plugin folder (auto-routing hooks for context-window reduction) | No | No | Yes |

1. Standard mode seeds the rows above marked Yes in the Standard column to R2.
2. Pro mode seeds the rows above marked Yes in the Pro column to R2 (a strict superset of Standard).
3. Pro mode enables memory persistence (`.memory/` directory synced via rclone); Standard mode excludes the entire `.memory/**` directory from sync.
4. Pro mode registers hooks in `settings.json` with command-pattern gates so they only fire on relevant Bash calls: PreToolUse entries for commit attribution blocking (gated on git/gh commands), a PostToolUse entry for the PR-boundary trigger classifier (fires on `gh pr create` or push-to-PR-tracked-branch), a Stop entry for the PR HEAD SHA checkpoint (blocks turn-end until the review pipeline observes the new PR head), and a UserPromptSubmit entry for memory capture; Standard mode merges only `skipDangerousModePermissionPrompt`.
5. The context-mode integration ships in two layers with separate gating: (a) the **MCP server** (exposing `ctx_*` helper tools) is available to **all users on every session** so the agent always has the helper tools on demand; (b) the **plugin folder** containing hooks (auto-routing tool calls) and any plugin-bound rules is delivered to the user's R2 bucket **only when** the user's effective subscription tier is `unlimited` (displayed as `Custom` in the admin UI) **AND** their session mode is `advanced` (Pro). Any other tier/mode combination strips the plugin subtree from the seed list before bisync touches the bucket.
6. When the plugin folder is present (Pro on Custom tier), it registers five hooks for context-window reduction: four invoke the upstream context-mode CLI (PreToolUse routing, PostToolUse indexing, PreCompact, SessionStart), plus a PreToolUse denial hook on `Bash|WebFetch|Grep` that blocks calls outside the routing whitelist and redirects to the equivalent `ctx_*` tool. Per-call bypass via `/tmp/ctx-bypass` (user-only). When the plugin folder is absent, the MCP server is still active so users can call `ctx_*` tools manually, but no automatic routing or enforcement fires.
7. MCP server availability is universal regardless of tier or mode, but is wired through one of two mutually-exclusive paths to avoid duplicate registration: when the preseed plugin manifest is present (Custom tier in Pro mode), the plugin loader registers the MCP server via the manifest's declarative configuration and the plugin is enabled; when the manifest is absent (any other tier/mode), the container's entrypoint registers the MCP server directly so `ctx_*` tools remain available. Manifest presence is the single gate that determines which path applies, and the version pin used by both paths is identical.

**Constraints:**
- Cleanup on mode switch is scoped strictly to preseed-managed keys; user-created files are never deleted.
- A tier downgrade away from `unlimited`, or a session-mode change away from `advanced`, must remove the entire context-mode preseed subtree from the user's bucket on the next reconcile so the plugin no longer loads.
- The context-mode plugin must never be installed via `claude plugin install` against the upstream marketplace; ship it exclusively as preseed assets so the upstream installer's settings.json mutation cannot reach Codeflare users.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-004, REQ-AGENT-006
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-006: Preseed Configs Generated from Single Source of Truth

**Intent:** All agent configurations must be derived from the Claude Code preseed to prevent divergence and eliminate duplicate maintenance.

**Acceptance Criteria:**
1. Source files live in `preseed/agents/claude/` organized by type: `rules/`, `agents/`, `commands/`, `skills/`, `plugins/`.
2. `preseed/agents/claude/manifest.json` maps each file to its applicable modes (`default`, `advanced`, or both).
3. `scripts/generate-agent-seed.mjs` reads the manifest and source files, generating `src/lib/agent-seed.generated.ts` with an `AGENTS_SEEDED_CONFIGS` array.
4. The generator is manifest-driven; files not in the manifest are ignored.
5. No duplicate preseed source files exist on disk.
6. The generator produces output for all supported agents (Claude Code as the source-of-truth lane plus adapted lanes for Codex, Gemini, Copilot, OpenCode).

**Constraints:**
- The generator must be re-run when preseed source files or the manifest change.
- Generated TypeScript file must not be manually edited.

**Applies To:** User
**Priority:** P1
**Dependencies:** None
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-007: Multi-Agent Adaptation Pipeline

**Intent:** Each supported agent must receive properly adapted configurations matching its specific config format, tool names, and file conventions.

**Acceptance Criteria:**
1. Adapted configs are generated for all 5 supported agents from the Claude Code source.
2. Tool names are remapped per agent (e.g., `Read` -> `read_file` for Gemini, `Read` -> `read` for Codex).
3. Instructions are concatenated into a single file for agents that use monolithic config (Codex: `AGENTS.md`, Gemini: `GEMINI.md`, Copilot: `copilot-instructions.md`, OpenCode: `AGENTS.md`).
4. Claude Code keeps individual rule files in `~/.claude/rules/`.
5. Agent definitions use correct frontmatter format per agent (e.g., `tools` as record `{read: true}` for OpenCode, as array for others).
6. `model` field is removed from frontmatter for non-CC agents.
7. Path references (e.g., `~/.claude/`) are replaced with agent-specific config paths.
8. File extensions match agent conventions (e.g., `.agent.md` for Copilot agents).

**Constraints:**
- Hooks, commands, and plugins are excluded from non-CC agents (they are CC-specific features).
- `rules/memory.md` and `consult-llm` skill are excluded from non-CC agents (they depend on CC-specific MCP).
- Each non-CC agent gets a strictly-smaller config than Claude Code, since CC is the source-of-truth lane and other agents drop CC-specific content (hooks, slash commands, plugins, MCP-dependent rules/skills).

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-006
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-008: Preseed Deployed to Container on Start

**Intent:** Preseed files must be available in the container's filesystem when the agent launches so that rules, skills, and agent definitions are active from the first prompt.

**Acceptance Criteria:**
1. On first bucket creation, `reconcileAgentConfigs(mode, { overwrite: false, cleanup: false })` writes mode-appropriate files to R2.
2. During container startup, initial `rclone sync` from R2 restores preseed files to the container's config directories (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.copilot/`, `~/.config/opencode/`).
3. `entrypoint.sh` merges settings into `~/.claude/settings.json` using a hooks-aware merge: non-hook fields use recursive merge; hook arrays are rebuilt per event type by preserving user-added hooks (any hook whose command does not match codeflare-* managed paths) and replacing managed hooks with the current platform version.
4. In advanced mode, settings merge includes hook registrations (PreToolUse, PostToolUse, UserPromptSubmit).
5. `entrypoint.sh` merges `enabledPlugins` into `~/.claude/.claude.json` to enable codeflare-memory and codeflare-hooks plugins (permanent, not mode-gated; missing plugin files are silently skipped).
6. Settings merge handles three cases: file doesn't exist (create), file exists (recursive merge), file malformed (skip with warning).

**Constraints:**
- All file modifications must complete after initial sync but before bisync baseline to avoid hash mismatches.
- Plugin enablement is permanent because Claude Code silently skips missing plugins.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-AGENT-006, REQ-STOR-004
**Verification:** Integration test

**Status:** Implemented

---

## REQ-AGENT-009: LLM API Key Storage (Encrypted in KV)

**Intent:** Users must be able to store LLM provider API keys so that cross-model consultation features work without re-entering keys each session.

**Acceptance Criteria:**
1. `PUT /api/llm-keys` accepts `{ openaiApiKey?: string | null, geminiApiKey?: string | null }`.
2. String value sets the key; `null` deletes it; omitted/undefined means no change.
3. Keys are stored in KV at `llm-keys:{bucketName}`.
4. When `ENCRYPTION_KEY` is set, values are encrypted with AES-256-GCM before KV storage.
5. `GET /api/llm-keys` returns masked keys (`****` + last 4 chars), never full keys.
6. Keys are injected as container environment variables (`OPENAI_API_KEY`, `GEMINI_API_KEY`) during `setBucketName()`.
7. When keys are present, `entrypoint.sh` configures the `consult-llm-mcp` MCP server in `~/.claude.json`.
8. Keys are NOT persisted in DO storage; they are read fresh from KV on each container start.

**Constraints:**
- Encryption uses Web Crypto API AES-256-GCM with random 12-byte IV and KV key name as AAD.
- The ciphertext format is `v1:` + base64 for forward compatibility.
- Transparent upgrade: plaintext values are auto-encrypted on read when `ENCRYPTION_KEY` is present.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SEC-004
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)

**Intent:** Users must be able to store GitHub and Cloudflare credentials so that git push, repository management, and Cloudflare deployments work without re-authenticating each session.

**Acceptance Criteria:**
1. `PUT /api/deploy-keys` validates tokens against provider APIs before storing.
2. `GET /api/deploy-keys` returns masked tokens, never full values.
3. `DELETE /api/deploy-keys` clears all stored deploy credentials.
4. Keys are stored in KV at `deploy-keys:{bucketName}`, encrypted with AES-256-GCM when `ENCRYPTION_KEY` is set.
5. Deploy keys are injected as container environment variables: `GH_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
6. Keys are sent as explicit `null` when absent (not omitted) to ensure revocation propagates on session restart.
7. When `GH_TOKEN` is present, `entrypoint.sh` configures `git config --global credential.helper` for HTTPS auth.
8. `CLOUDFLARE_ACCOUNT_ID` is auto-fetched from the Cloudflare API when a Cloudflare API token is stored.

9. GitHub token creation offers three scope tiers (Minimal, Recommended, Advanced) via a selector in the connect flow. Recommended is pre-selected. The URL pre-fills the correct scopes per tier.
10. Cloudflare token creation directs users to use the "Edit Cloudflare Workers" template with account and zone selection. No scope pre-fill (Cloudflare template URLs are broken).
11. A documentation page lists all scopes per tier with explanations of why each is needed, linked from the UI via "See all scopes".

**Constraints:**
- GitHub Minimal: 1 scope (contents). Recommended: 6 scopes (contents, PRs, actions, workflows, administration, secrets). Advanced: all 19 scopes including Copilot.
- Cloudflare: "Edit Cloudflare Workers" template covers Workers, KV, R2, Pages, Containers, Routes. Users add extra scopes (D1, DNS, Access, Turnstile) when their agent requests them.
- Copilot CLI checks env vars in order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`; auth fails silently if the token lacks Copilot scope — requires Advanced tier.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SEC-004
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-011: Agent Configs Manually Recreatable from Settings

**Intent:** Users must be able to reset their agent configurations to the platform defaults at any time, recovering from accidental deletion or corruption.

**Acceptance Criteria:**
1. "Recreate AI agent skills & rules" button in Settings triggers `POST /api/storage/seed/agent-configs`.
2. The endpoint calls `reconcileAgentConfigs(mode, { overwrite: true, cleanup: true })`.
3. Overwrite mode replaces all preseed-managed files with current defaults.
4. Cleanup mode deletes preseed-managed files that are not in the user's current session mode.
5. User-created files (not in `AGENTS_SEEDED_CONFIGS`) are never touched.
6. "Recreate starter documentation" button triggers `POST /api/storage/seed/getting-started`.
7. Both seed endpoints are rate-limited (3/min).
8. After seeding, the storage stats KV cache is invalidated.

**Constraints:**
- Cleanup uses explicit key lists, not bucket listing or prefix scans.
- Partial delete failures produce warnings but do not fail the overall operation.
- Container must perform a bisync cycle to pull the updated R2 files into the local filesystem.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-006, REQ-STOR-010
**Verification:** Manual check

**Status:** Implemented

---

## REQ-AGENT-012: Fast CLI Start (Configurable)

**Intent:** Agent CLIs must start quickly by default, with an option for users who want automatic updates.

**Acceptance Criteria:**
1. `fastStartEnabled` preference (default: `true`) maps to `FAST_CLI_START` container env var.
2. When enabled, auto-update checks are disabled for all 5 AI tools, eliminating 5-30s startup delay.
3. Each tool has a specific disable mechanism:
   - Claude Code: `DISABLE_AUTOUPDATER=1` (env var)
   - OpenCode: `OPENCODE_DISABLE_AUTOUPDATE=1` (env var)
   - Copilot: `COPILOT_AUTO_UPDATE=false` (env var)
   - Gemini: `~/.gemini/settings.json` with `enableAutoUpdate: false` (jq merge preserving user customizations)
   - Codex: `~/.codex/version.json` with `dismissed_version: "999.0.0"` (overwrite, excluded from sync)
4. When disabled (`FAST_CLI_START=false`), env vars are unset and config files are not written, allowing normal update checks.
5. Users can toggle this in Settings > Session Defaults.

**Constraints:**
- Gemini settings file is synced via rclone, so jq merge must preserve user customizations.
- Codex `~/.codex/` directory is excluded from sync, so `version.json` is safe to recreate on every start.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-003
**Verification:** Manual check

**Status:** Implemented

---

## REQ-AGENT-013: Browser Shim for OAuth Flows

**Intent:** Agent CLIs that attempt to open a browser for OAuth must degrade gracefully to printing clickable URLs in the terminal.

**Acceptance Criteria:**
1. `BROWSER` env var points to `/usr/local/bin/open-url` shim that exits with code 1.
2. `xdg-open` is replaced with a shim (`xdg-open-shim`) that also exits with code 1.
3. CLIs fall back to printing auth URLs as plain text in the PTY when the browser fails to open.
4. The xterm.js link provider detects URLs in terminal output and makes them clickable.

**Constraints:**
- The shim must not block or hang; it must exit immediately with a non-zero code.
- All CLI tools that attempt browser-based OAuth (Claude Code, OpenCode, Gemini) must be covered.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-001
**Verification:** Manual check

**Status:** Implemented

---

## REQ-AGENT-014: Manifest-Driven Preseed Pipeline

**Intent:** The preseed system must use a declarative manifest to control which files are included, their mode assignments, and their target agents, ensuring auditable and reproducible builds.

**Acceptance Criteria:**
1. `preseed/agents/claude/manifest.json` is the single declaration of all preseed files and their mode assignments.
2. The manifest organizes entries by type: rules (including the discipline triad: spec-discipline, documentation-discipline, tdd-discipline), agents, commands, skills (including SDD scaffolding templates), and plugins (memory and hook plugins).
3. Each entry specifies `"modes"` as an array of `"default"`, `"advanced"`, or both.
4. The generator script (`scripts/generate-agent-seed.mjs`) is manifest-driven and ignores files not in the manifest.
5. The generated output (`src/lib/agent-seed.generated.ts`) contains the `AGENTS_SEEDED_CONFIGS` array used at runtime.
6. `getConfigsForMode()` validates that no duplicate R2 keys exist within a single mode.
7. Variant-per-mode keys (same R2 key, different content per mode) are handled correctly by `getPreseedKeysNotInMode()`.

**Constraints:**
- The manifest must be updated when adding, removing, or re-categorizing preseed files.
- The generated TypeScript file is a build artifact, not manually maintained.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-006
**Verification:** Automated test

**Status:** Implemented

---

## REQ-AGENT-015: /review command for multi-perspective codebase review

**Intent:** Comprehensive code review using specialized AI agents catches issues a single reviewer would miss.

**Acceptance Criteria:**
1. `/review` launches 6 parallel specialist agents (security, architecture, code quality, dead code, test gaps, documentation), followed by a sequential Reality Filter pass that re-evaluates findings against repeat-offender, memory, cluster-aggregation, user-impact, and spec-vs-shipped questions.
2. Results cross-referenced and deduplicated.
3. Findings filtered against architecture decisions.
4. Optional LLM verification of HIGH/CRITICAL findings.
5. Interactive triage with fix/AD/defer/ignore options. Defer/Ignore/Tech-Debt decisions persist to `sdd/.review-decisions.md` so subsequent runs do not re-surface the same noise.

**Applies To:** User

**Constraints:**
- None

**Priority:** P1
**Dependencies:** None
**Verification:** Manual check
**Status:** Implemented

---

## REQ-AGENT-016: consult-llm preference toggle

**Intent:** Users control whether their LLM API keys power the multi-model consultation feature.

**Applies To:** User

**Acceptance Criteria:**
1. Toggle in Settings controls whether OpenAI/Gemini keys are passed to the consult-llm MCP server.
2. Default: off.
3. When off, consult-llm is not configured in the agent's MCP settings.

**Constraints:**
- None

**Priority:** P2
**Dependencies:** REQ-AGENT-009
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AGENT-017: Bubblewrap sandbox for Codex

**Intent:** Codex agent runs in a bubblewrap sandbox for additional isolation within the container.

**Applies To:** User

**Acceptance Criteria:**
1. bubblewrap (bwrap) is installed in the container image.
2. Codex uses it for sandboxed execution.

**Constraints:**
- None

**Priority:** P1
**Dependencies:** REQ-AGENT-001
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AGENT-018: Push & Deploy credential management UI

**Intent:** Users connect GitHub and Cloudflare accounts through a visual interface without CLI commands.

**Applies To:** User

**Acceptance Criteria:**
1. Settings panel has Deploy Keys section with provider rows for GitHub and Cloudflare.
2. Tokens validated against provider APIs before saving.
3. Stored encrypted in KV.
4. Injected as container env vars (GH_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).

**Constraints:**
- Must comply with CON-SEC-003

**Priority:** P1
**Dependencies:** REQ-AGENT-010
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AGENT-019: Branded settings UI

**Intent:** Professional, intuitive settings panel for managing all user preferences and credentials.

**Applies To:** User

**Acceptance Criteria:**
1. Settings panel uses accordion groups (appearance, session, deploy, LLM, admin).
2. Provider rows with SVG brand icons and inline expansion.
3. Appearance section with accent color picker.
4. Session section with agent type, sleep timeout, session mode dropdowns.

**Constraints:**
- None

**Priority:** P2
**Dependencies:** None
**Verification:** Manual check
**Status:** Implemented

---

## REQ-AGENT-020: LLM API key management UI

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
**Dependencies:** REQ-AGENT-009
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AGENT-021: Spec-Driven Development Workflow (Pro)

**Intent:** Pro users need a workflow that keeps a product specification in lockstep with their codebase without manual maintenance, so the spec remains a trustworthy single source of truth even when development happens at high velocity.

**Applies To:** User

**Acceptance Criteria:**
1. Pro mode preseeds the `spec-driven-development` skill, the `/sdd` command, the `spec-discipline` rule (loaded into every agent's instructions), and the `spec-reviewer` + `doc-updater` agents.
2. `/sdd init` scaffolds a new `sdd/` from templates for greenfield projects; in import mode it derives a spec from existing source code. When a package manifest is generated, top-level dependency versions are resolved at scaffold time via the ecosystem's registry (npm, Cargo, pip, Go) rather than emitted from memory; the Cloudflare Workers stack pins `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`, and `vitest` as a single co-resolved cohort. Lockfile generation during `/sdd init` is a scoped carveout to the no-local-builds rule (resolution only, with `--ignore-scripts` on npm; no installs, tests, or builds).
3. Three autonomy modes (`interactive`, `auto`, `unleashed`) are selectable via `sdd/config.yml`. Interactive and auto modes apply fixes on the current branch (auto silently, interactive after confirmation). Unleashed mode is the walk-away autopilot: it applies SAFE + RISKY + JUDGMENT fixes on the current branch via per-category `[sdd-clean]` commits, forces `enforce_tdd: true`, and uses conservative JUDGMENT auto-resolution that never overwrites intent. Unleashed does not create a new branch and does not open a pull request; `git revert <sha>` on a per-category commit is the rollback surface, and `sdd/.last-clean-run.md` plus each commit message carry the audit log.
4. PR-boundary review fires only for PRs targeting `main` or `master`: either a new pull request opens with that target via `gh pr create`, or a new push lands on a branch that already has an open PR with that target. On these triggers `spec-reviewer` runs first, then `doc-updater` runs second (sequential, never parallel) on any project containing `sdd/`.
5. PRs into intermediate integration branches (`develop`, `staging`, etc.) do NOT trigger reviews. The case is deferred until the integration branch's own PR-to-`main` opens or syncs, where the cumulative review covers everything that landed.
6. A plain push to a branch with no open PR does NOT trigger reviews.
7. Direct pushes to `main` are expected to be prevented by GitHub branch protection (require PR before merge); the review pipeline is not engineered to compensate for a bypass that the upstream platform already blocks.
8. On non-SDD projects (no `sdd/` folder) no review agents run at all. Every hook exits silently and the workflow proceeds friction-free (vibe-coding mode).
9. `/sdd clean` rescues rotted specs with conservative JUDGMENT auto-resolution that never overwrites spec intent (mark Partial + Notes, move to Out of Scope, shrink in place).
10. The workflow is project-agnostic and self-limits to 2 fix rounds per commit cycle to prevent micro-fix spirals.
11. In `auto` and `unleashed` modes, spec-reviewer and doc-updater refuse to run on `main`/`master` without an explicit `--branch-confirmed` flag.

**Constraints:**
- Status semantics, `Deprecated` requirements, the spec-discipline enforcement layer, and the `enforce_tdd` test-coverage rule follow `rules/spec-discipline.md`.

**Priority:** P1
**Dependencies:** REQ-AGENT-005, REQ-AGENT-006, REQ-AGENT-007
**Verification:** Manual check
**Status:** Implemented
