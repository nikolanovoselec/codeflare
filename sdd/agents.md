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

**Intent:** Pro mode must provide a significantly enhanced agent experience over Standard — more rules, skills, agent definitions, commands, hooks, and persistent memory. The context-mode helper tools are universally available to every user on demand, while context-mode's automatic context-window-reduction behavior is reserved for the Custom subscription tier.

**Acceptance Criteria:**
1. Pro mode delivers a strict superset of the content Standard mode delivers, covering memory persistence, language rules, agent definitions, slash commands, cherry-picked skills, the discipline triad (spec, docs, tests), and the commit-attribution and PR-boundary review hooks. The canonical per-content-category matrix lives in [documentation/preseed.md](../documentation/preseed.md#session-modes); the spec lane documents the user-observable contract only.
2. Pro mode enables persistent memory (the `.memory/` directory is included in storage sync); Standard mode excludes it so memory does not persist across container restarts.
3. Pro-mode hooks fire uniformly regardless of which tool surface invoked the underlying command, so coverage is identical whether the user is on Custom tier (commands route through context-mode) or any other tier (commands run directly): commit attribution is blocked before the commit lands, the SDD review pipeline is triggered at every PR-to-`main` boundary event, the turn cannot end while a PR HEAD remains unreviewed, and memory capture runs on the user-prompt cadence.
4. The context-mode helper tools are available to every user on every session regardless of subscription tier or session mode, so the agent can always invoke them on demand.
5. Custom-tier Pro users additionally receive context-mode's automatic context-window-reduction behavior: large tool output stays out of the conversation window unless the agent explicitly retrieves it, and commands that would flood the window are redirected to the equivalent helper tool. Any other tier-and-mode combination receives the helper tools without the automatic redirection.
6. Downgrading away from Custom tier, or switching away from Pro mode, removes the Custom-tier-only behavior on the next reconcile so the automatic redirection no longer fires.

**Constraints:**
- Cleanup on mode switch is scoped strictly to preseed-managed content; user-created files are never deleted.
- The Custom-tier context-mode behavior must be delivered through the platform's preseed pipeline, never through a user-driven marketplace install that could mutate settings outside the platform's control.

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
3. `entrypoint.sh` merges settings into `~/.claude/settings.json` using a hooks-aware merge: non-hook fields use recursive merge; hook arrays are rebuilt per event type by preserving user-added hooks and replacing managed hooks with the current platform version. The managed-hook detector matches `plugins/(codeflare-(hooks|memory|vault)|graphify)/scripts/` (anchored on the literal `plugins/` segment so unrelated workspace tools with the same basenames are not falsely managed), references to `enforce-ctx-mode.sh` (legacy `~/.claude/hooks/` and current `~/.claude/plugins/context-mode/scripts/` paths), and `context-mode hook claude-code` CLI invocations (bare, `bunx`, and `npx -y` forms).
4. In advanced mode, settings merge includes hook registrations (PreToolUse, PostToolUse, UserPromptSubmit).
5. `entrypoint.sh` merges `enabledPlugins` into `~/.claude/.claude.json` to enable codeflare-memory and codeflare-hooks plugins (permanent, not mode-gated; missing plugin files are silently skipped).
6. Settings merge handles three cases: file doesn't exist (create), file exists (recursive merge), file malformed (skip with warning).

**Constraints:**
- All file modifications must complete after initial sync but before bisync baseline to avoid hash mismatches.
- Plugin enablement is permanent because Claude Code silently skips missing plugins.
- Any new managed-hook surface added to `entrypoint.sh:MANAGED_HOOKS_REGEX` must also be reflected in AC3 above; otherwise prior copies accumulate on every container boot instead of being replaced. The regex enumeration in AC3 is the spec-side single source of truth for what counts as managed.

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
6. When `doc-updater` is invoked on a project with no `sdd/` or no `documentation/` surface (vibe-coding mode), it writes a one-line no-op header to its output file rather than leaving it empty, so the cross-reference phase can distinguish "ran and found nothing" from "did not run". The other five specialist agents always have a code surface to review and produce findings or `Verified Clean` sections normally.
7. Findings reported in interactive triage are never auto-applied by `/review`; the user explicitly confirms each fix. The `auto` and `unleashed` modes that auto-apply spec/doc fixes are scoped to the PR-boundary review pipeline and `/sdd clean` (configured via `sdd/config.yml`), not to interactive `/review` invocations.

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
1. Pro mode preseeds the `spec-driven-development` skill, the `sdd-init` and `sdd-clean` sub-command skills, the `vault-operations` skill, the `/sdd` command, the `spec-discipline`, `documentation-discipline`, and `tdd-discipline` rules (loaded into every agent's instructions), and the `spec-reviewer` + `doc-updater` agents.
2. `/sdd init` scaffolds a new `sdd/` from templates for greenfield projects.
3. In import mode, `/sdd init` derives a spec from existing source code rather than scaffolding from templates.
4. When `/sdd init` generates a package manifest, top-level dependency versions are resolved at scaffold time via the ecosystem's registry (npm, Cargo, pip, Go) rather than emitted from memory. The Cloudflare Workers stack pins `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`, and `vitest` as a single co-resolved cohort.
5. Lockfile generation during `/sdd init` is a scoped carveout to the no-local-builds rule (resolution only, with `--ignore-scripts` on npm; no installs, tests, or builds).
6. Three autonomy modes (`interactive`, `auto`, `unleashed`) are selectable via the layout-resolved config file (`sdd/spec/config.yml` on the nested layout, `sdd/config.yml` on the flat-legacy layout). Interactive and auto modes apply fixes on the current branch (auto silently, interactive after confirmation). Unleashed mode is the walk-away autopilot: it applies SAFE + RISKY + JUDGMENT fixes on the current branch via per-category `[sdd-clean]` commits, refuses to run when `enforce_tdd: false` (preserves the per-project opt-out; user flips manually or uses `auto` instead), and uses conservative JUDGMENT auto-resolution that never overwrites intent. Unleashed does not create a new branch and does not open a pull request; `git revert <sha>` on a per-category commit is the rollback surface, and the per-category commit messages carry the full audit log.
7. PR-boundary review fires only for PRs targeting `main` or `master` (a new PR opens with that target via `gh pr create`, or a push lands on a branch with an open PR to that target). PUSH_LINE detection in `enforce-review-spawn.sh` recognises both `git push` and `gh pr merge` across all three tool surfaces (Bash, `mcp__*__ctx_batch_execute`, `mcp__*__ctx_execute` with `language=shell`); the `gh pr merge` surface is required because a server-side merge into `develop` advances the develop->main PR HEAD without producing a local `git push` line. Layer 1 lane classification uses a shared helper (`scripts/lib/lane-classifier.sh`, relative to the hooks plugin `scripts/` directory) sourced by both `enforce-review-spawn.sh` and `git-push-review-reminder.sh` so the in-turn nudge and turn-end gate agree on which agents the diff requires: docs-only (no sdd, no source) -> `doc-updater`; sdd/ touched without source (with or without docs) -> `spec-reviewer` then `doc-updater`; any source touch -> all three. Conservative branches (empty diff, missing prior ack, divergent merge-base) and a missing or unsourceable helper both fall back to all-three-lanes (`code-reviewer spec-reviewer doc-updater`), so a partially-deployed install never disables enforcement. Layer 2 (`gh pr view` HEAD SHA comparison) filters false positives. On trigger, `spec-reviewer` runs first then `doc-updater` (sequential, never parallel) on any project containing `sdd/`. In a fix-push cascade (multiple pushes inside one turn), the gate advances the ack pointer through each push whose review window completed all lanes required by that push's diff; AC16-bypassed pushes (no spawns in window) are absorbed into the next complete window's cumulative review.
8. PRs into intermediate integration branches (`develop`, `staging`, etc.) do NOT trigger reviews. The case is deferred until the integration branch's own PR-to-`main` opens or syncs, where the cumulative review covers everything that landed.
9. A plain push to a branch with no open PR does NOT trigger reviews.
10. Direct pushes to `main` are expected to be prevented by GitHub branch protection (require PR before merge); the review pipeline is not engineered to compensate for a bypass that the upstream platform already blocks.
11. On non-SDD projects (no `sdd/` folder) no review agents run at all. Every hook exits silently and the workflow proceeds friction-free (vibe-coding mode).
12. `/sdd clean` rescues rotted specs with conservative JUDGMENT auto-resolution that never overwrites spec intent (mark Partial + Notes, move to Out of Scope, shrink in place).
13. The workflow is project-agnostic. Each review agent self-limits to 2 fix rounds per commit cycle scoped to its own lane (spec-reviewer counts only commits touching `sdd/**`; doc-updater counts only commits touching `documentation/**`) to prevent micro-fix spirals without cross-contaminating lanes.
14. In `auto` and `unleashed` modes, spec-reviewer and doc-updater push to whatever branch is currently checked out; the user is responsible for checking out the right branch before invoking.
15. The three review-agent disciplines (doc, spec, tdd) each enforce structural compliance plus content-quality. doc-updater runs structural passes (shape, budgets, lane) and content-quality passes (verification truth-check, Implements-vs-AC cross-walk, stale code-block detection against source, content-preservation on trims, stranger cold-read usability). spec-reviewer runs the spec analogs (REQ-test truth-check beyond literal ID match, vendor/protocol drift, content-preservation on shrink). code-reviewer flags tests whose name claims behavior the assertions don't verify (the test-name-lies antipattern in tdd-discipline). Auto-fixes derive concrete content from source/REQ when possible. Load-bearing clauses that would be lost to a word-cap trim are promoted to surrounding prose or the trim is reverted with a finding.
16. The Stop-hook review enforcement (`enforce-review-spawn.sh`) exposes three USER-only bypass surfaces: (a) a one-shot sentinel file at `/tmp/review-bypass` (overridable via `REVIEW_BYPASS_FILE` for hermetic tests) which is auto-deleted on use, never committed, and never survives container restart; (b) a magic phrase `skip review` or `skip verification` (case-insensitive, word-bounded) in any user message after the candidate push line in the transcript; (c) a 3-strike circuit breaker that exits silently after blocking the same un-acked PR HEAD SHA three times, sticky until the SHA changes. The assistant must NEVER create the sentinel or write the magic phrase in its own output; both are explicitly user-only escape hatches.
17. `/sdd init` (both greenfield and Import Mode) runs as a lean two-confirm flow: the agent asks one vision question (or accepts `$ARGUMENTS`), drafts the entire spec in memory (actors, domains, design principles, REQs in canonical shape, CON-* constraints, founding ADRs, glossary terms), presents the full draft as one review surface, and applies user edits in place until the user accepts. The 10-15-turn one-domain-at-a-time confirmation chain is not used.
18. After the full draft is accepted, an enrichment pass runs before files are written: (a) cross-link pass — every REQ that references another REQ concept by name also lists it in `Dependencies:` as an anchor link `[REQ-X-NNN](#req-x-nnn-title-slug)`; (b) ADR-seed pass — 3-8 founding ADRs covering the non-obvious technology choices (tech stack, framework, deployment target, auth pattern, data store, key middleware) are drafted and written to `documentation/decisions/README.md` with an index table at the top and per-ADR sections below; (c) glossary-seed pass — every product noun, vendor name, and protocol mentioned in any REQ Intent or AC body is extracted and given a one-line definition in `sdd/glossary.md`. The three passes run in one in-memory cycle with no additional user prompts.
19. Every REQ written by `/sdd init` renders in the canonical shape defined by the `spec-driven-development` skill: ACs numbered (`1.`, `2.`, `3.`), each labeled field on its own line with blank-line separators between trailing fields (`Constraints`, `Priority`, `Dependencies`, `Verification`, `Status`), and `**Constraints:**` + `**Dependencies:**` always present (rendered as the literal string `None.` when empty). Cross-references render as markdown anchor links, not plain text.
20. `/sdd init` pre-creates the verification-queue file `sdd/spec/.review-queue.md` at scaffold time with the placeholder `_Awaiting first finding._` so the file ships discoverable. After scaffold, the layout-resolved review queue (`sdd/spec/.review-queue.md` on the nested layout, `sdd/.review-needed.md` on the flat-legacy layout) accumulates findings appended by spec-reviewer, `/sdd clean`, or `/sdd init` Import-Mode triage. The doc-lane audit accumulator `documentation/.doc-coverage.md` is lazy-created by doc-updater on first substantive finding. The `/sdd clean` execution audit lives in per-category commit bodies (recoverable via `git log --grep='\[sdd-clean\]'`), not in a dotfile.
21. Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works under both Bash and the context-mode MCP tool family (`mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, `mcp__context-mode__ctx_search`). Discovery commands that produce more than 20 lines of output (`gh pr list --state all`, `git log --follow`, `npm view <pkg> peerDependencies`, full-tree scans, scaffold-only `npm install --package-lock-only`) route through context-mode's ctx_execute family in context-mode environments and through Bash in plain environments. The behavioural contract in this REQ is tool-agnostic; the agent selects the right wrapper for its environment.
22. The enrichment pass (cross-link / ADR-seed / glossary-seed described in AC18) queries the project's `graphify-out/graph.json` via the `mcp__graphify__*` MCP tool family: `get_neighbors` drives the cross-link Dependencies pass, `god_nodes` surfaces ADR-seed candidates, `query_graph` extracts glossary concept-tagged nodes, and `shortest_path` validates non-obvious dependency edges.
23. The graph is expected to exist at `/sdd init` time because the post-clone PostToolUse hook (REQ-AGENT-025) prompts the user to build one immediately after `git clone` or `gh repo clone`. When the graph is missing at enrichment time, `/sdd init` prompts the user once with a `/graphify cluster-only` (AST-only, free) build offer; on decline, enrichment falls back to an in-memory heuristic (literal-string matching across drafted REQs) and appends a one-line notice to `sdd/changes.md` recording reduced cross-link density.
24. Graphify MCP tools are tool-agnostic across Bash and context-mode surfaces; the enrichment-pass contract is identical regardless of which tool surface is active.
25. `/sdd init` runs Phase 7a (programmatic source-anchor verification) as a CRITICAL non-skippable gate BEFORE invoking `spec-enforce` and `doc-enforce`. Phase 7a executes `verify-source-anchors.py` which walks every `<!-- @impl: <path>::<symbol>[ = <value>] -->` anchor across `sdd/**/*.md` and `documentation/**/*.md`, resolves the path on disk, confirms the symbol's word-bounded presence in source, validates any literal value pattern within the symbol's local region, and counts malformed `@impl`-shaped comments and unreadable files. The verifier emits a JSON report `{parsed, resolved, orphaned, drifted, malformed, unreadable, failures, malformed_entries, unreadable_entries, exit_code}` to `.verify-anchors.json` and a verbatim summary line which the `[sdd-init]` commit body MUST include: `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`. A non-zero `exit_code` blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`. Substituting a structural sanity check or agent self-attestation for the verifier output is CRITICAL `phase-7a-self-attestation`; partial coverage is CRITICAL `phase-7a-incomplete-coverage`; running the verifier AFTER the enforcement skills is `phase-7a-pipeline-inversion`; bypassing the verifier on a missing-tool error is `phase-7a-tooling-bypass`; committing without the summary line in the body is `phase-7a-evidence-missing`. After `/sdd init`, steady-state CQ-SOURCE (`spec-enforce-truth`) and Pass 15 (`doc-enforce-truth`) consume Phase 7a's JSON when available rather than re-deriving.
26. `/sdd init` runs Phase 7b (programmatic enumeration-coverage verification) as a second CRITICAL non-skippable gate AFTER Phase 7a and BEFORE iterate-to-clean. Phase 7b executes `verify-enumeration-coverage.py --root . --json-out .phase-7b.json` which walks the working tree, identifies load-bearing source files (under `services/`, `handlers/`, `controllers/`, `providers/`, `models/`, `domain/`, `core/`, `commands/`, `usecases/`, `workers/` OR source-line-count >= 100), and checks each file's repo-relative path against (a) the `<path>` portion of every `<!-- @impl: <path>::<symbol> -->` anchor in `sdd/**/*.md` + `documentation/**/*.md`, AND (b) literal mentions in the layout-appropriate triage files (nested: `sdd/spec/.init-triage.md` + `sdd/spec/.review-queue.md`; flat-layout legacy: `sdd/.init-triage.md` + `sdd/.review-needed.md`). The verifier emits a JSON report `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}` and a verbatim summary line which the `[sdd-init]` step-10 commit body MUST include alongside the Phase 7a line: `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1`. The two gates close the Validation-Equals-Generation gap: Phase 7a verifies every claim the agent wrote is anchored; Phase 7b verifies the agent did not silently drop entire source files from the enumeration. An empty triage queue on Import Mode with `unaccounted > 0` (the agent drafted only around the cleanly-anchorable subset of source) is CRITICAL `import-mode-narrowed-scope`. Agent self-attestation without the verifier output is CRITICAL `phase-7b-self-attestation`; sampling is CRITICAL `phase-7b-incomplete-coverage`; running `spec-enforce` first without Phase 7b is CRITICAL `phase-7b-pipeline-inversion`; committing without the summary line is CRITICAL `phase-7b-evidence-missing`. Per-project waiver: `sdd/spec/.phase-7b-waiver.txt` (one repo-relative path per line) excludes specific framework-boilerplate files from coverage; entries require a one-line justification. Phase 7b is advisory for greenfield (`enumerated=0` and `coverage_pct=100.0` are the expected outcome with no source on disk yet; the commit body line is still required so the audit-trail format stays uniform across modes).

**Constraints:**
- Status semantics, `Deprecated` requirements, the spec-discipline enforcement layer, and the `enforce_tdd` test-coverage rule follow `rules/spec-discipline.md`.
- The structural-vs-content-quality split, per-pass severity and auto-fix behavior, and the cold-read task registry follow `rules/documentation-discipline.md`.

**Priority:** P1
**Dependencies:** REQ-AGENT-005, REQ-AGENT-006, REQ-AGENT-007, REQ-AGENT-023, REQ-AGENT-025
**Verification:** Manual check
**Status:** Implemented

## REQ-AGENT-022: Legacy-codebase transition to SDD via init triage

**Intent:** Enterprises migrating a legacy codebase from manual development to autonomous agentic development need a transition path that converts un-extracted intent into a real spec. `/sdd init` Import Mode runs discovery against the full project history — working tree, git log, pull requests, issues (open and closed), code-review comments, release notes, wiki — and produces two outputs from the same pass: official REQs for behavior clear from that surface, and a triage queue for everything unclear, with the agent's concrete Context and Recommendation populated up front. The user resolves the queue at their own pace; until it drains, the project is in SDD transition. Once the queue is empty, full SDD discipline applies and autonomous agentic coding is unlocked, because the agent has a real contract to reason against.

**Applies To:** User

**Acceptance Criteria:**
1. `/sdd init` Import Mode emits two outputs simultaneously: spec REQs in `sdd/{domain}.md` for anything clearly determinable from the full discovery surface, and triage entries in `sdd/.init-triage.md` for anything unclear (magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent, domain-placement guesses).
2. The discovery surface during Import Mode is the full project history, not just source code. The agent pulls evidence from the working tree (README, configs, source, tests, inline comments, ADR-shaped files), git history (commit messages on entry-point files, tag annotations), and — when a GitHub remote is detected — pull requests with their review comments and inline threads (`gh pr list --state all`, `gh pr view {n} --comments`), issues open and closed with their comments (`gh issue list --state all`, `gh issue view {n} --comments`), release notes (`gh release list`, `gh release view {tag}`), and the wiki via the GitHub API. When one artifact references another ("Closes #142"), the agent follows the chain backward through every linked artifact rather than stopping at the first hit.
3. Every entry in `sdd/.init-triage.md` carries `**Context:**` (concrete evidence — file path + line range, git author of last meaningful change, commit SHA + subject, related tests, related PR numbers, related issue numbers, related release tags) and `**Recommendation:**` (the agent's specific best-guess answer) with `**Rationale:**` (one line tying the recommendation to specific Context evidence). Vague Context (no refs, no authors, no artifact numbers) and placeholder Recommendations (`TBD`, `(inferred)`, `unknown`) are rejected as malformed triage entries.
4. Triage entries use `**Status:** open | resolved | lost`. `lost` requires a one-line `**Reason:**` field explaining why the information is genuinely unrecoverable.
5. While `sdd/.init-triage.md` contains any `Status: open` items, `sdd/config.yml` carries `transition: true` and the project is in SDD transition. During transition the entire review pipeline is suspended: code-reviewer, spec-reviewer, and doc-updater do not fire on any push or PR event (PR-boundary hooks short-circuit to no-op; manually-invoked review agents exit no-op with a one-line notice). `/sdd mode unleashed` is rejected with a message naming the open-item count.
6. Re-invoking `/sdd init` on a project where `sdd/` already exists and `sdd/.init-triage.md` has at least one open item enters Resume Mode rather than aborting. Resume Mode surfaces one open item at a time, refreshing its Context before presenting (re-reads source, re-checks git log, re-fetches related PRs, issues, and releases).
7. The user chooses one of five decisions per item:
   - `accept`: use the recommendation as-is and fold into the relevant REQ.
   - `correct`: free-form prose describing what the thing is for and how it works; agent folds purpose into REQ Intent and behavior into AC bullets.
   - `lost`: record the gap with a one-line Reason; the related REQ (if any) gets a `Notes: intent lost during SDD transition - see TRIAGE-{NNN}` annotation; nothing is fabricated into the spec.
   - `skip`: leave Status: open, write nothing to the spec, advance to next.
   - `quit`: commit progress and exit.
8. Only `accept` and `correct` promote anything into the official spec. `skip` and `lost` write nothing to `sdd/{domain}.md`.
9. Each decision is its own commit (`[sdd-init] resolve TRIAGE-{NNN}` or `mark lost`).
10. Resume Mode entry refuses to start when the working tree has uncommitted changes (same gate as `/sdd clean`) and is always interactive regardless of `sdd/config.yml`'s `mode`. When `mode: auto` is set, Resume Mode prints a one-line notice that auto is suspended for this run and resumes after the queue drains.
11. When the last `Status: open` item is resolved or marked `lost`, the resolving commit clears `transition: true` from `sdd/config.yml`, appends a closure entry to `sdd/changes.md` recording totals (accepted / corrected / lost), and the agent enters Plan Mode (same hard gate as greenfield `/sdd init`) so the first feature work on top of the now-real spec is plan-gated. `enforce_tdd` is NOT auto-flipped - the user changes it manually when ready for TDD enforcement (typically after adding REQ-ID references to test names in the imported source). `sdd/.init-triage.md` is preserved as the audit record.
12. The PR-boundary review pipeline (PostToolUse `git-push-review-reminder` + Stop `enforce-review-spawn` hooks) short-circuits to no-op while `sdd/.init-triage.md` has open items, so legacy code does not trigger code-reviewer / spec-reviewer / doc-updater until the spec is real.
13. When the GitHub corpus is unreachable during Import Mode discovery (non-GitHub remote, `gh auth status` fails, rate-limited, private repo with insufficient token scope, air-gapped), the agent skips GitHub sources and proceeds with working-tree + git-log evidence only. A one-line notice naming the reason is printed before scaffolding and appended to the `sdd/changes.md` import entry.
14. Status default for CLEAR REQs derived during Import Mode depends on `enforce_tdd`. When `enforce_tdd: false` (the Import Mode default), CLEAR REQs whose source code implements the AC default to `Status: Implemented` unconditionally — the project has opted out of test-based verification at import time, and demoting every imported REQ to `Partial` because tests don't reference REQ IDs (the imported code predates the convention) would falsely brand the spec as 65%+ incomplete. When `enforce_tdd: true`, Status defaults `Implemented` only if a test file references the REQ ID, `Partial` otherwise.

**Constraints:**
- Triage items live only in `sdd/.init-triage.md`. No separate state file, no JSON mirror, no machine-readable index. Git history is the audit trail for who resolved which item with what decision.
- Triage workflow is interactive only. `auto` and `unleashed` modes do not auto-resolve triage items - the entire point is that judgment is required, and triage cannot be bypassed without abandoning the transition guarantees.
- `sdd/.init-triage.md` is owned by `/sdd init`. spec-reviewer reads it to determine transition state and to verify resolved items' REQs received the fold-in; doc-updater does not touch it.
- When `enforce_tdd: false`, each domain `sdd/{domain}.md` file receives one footnote `_Verification: code-only (no automated coverage)._` appended at the bottom. This is the only signal location; per-REQ `Notes:` fields are not used for this signal.

**Priority:** P1
**Dependencies:** REQ-AGENT-021
**Verification:** Manual check
**Status:** Implemented

## REQ-AGENT-023: Knowledge-Graph Capability (Graphify)

**Intent:** Every container ships the graphify code-knowledge-graph capability as ambient infrastructure, so any session (default or advanced session mode) can query an existing graph or build a new one without per-tier provisioning.

**Acceptance Criteria:**
1. The `graphifyy` Python package is installed in every container image at build time with `[mcp,sql,pdf]` extras. Version is pinned to `preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json` `.version`. Dependabot bumps to that file rebuild the image with the new version in lockstep.
2. The `graphify` MCP server is registered in `~/.claude.json` `mcpServers` for every session, in both default and advanced session modes. The server exposes the graphify tool set (`query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`).
3. AC 1 and 2 hold across all paid tiers (standard, advanced, max, unlimited). The capability functions in sessions without context-mode being preseeded; the agent-orchestrated `/graphify` skill relies on upstream graphify's subagent chunking model to keep the main agent's context bounded when context-mode is not present.
4. The MCP server tolerates a missing `graphify-out/graph.json` at startup. A wrapper (`graphify-mcp-lazy.py`) presents a `LazyGraph` to `graphify.serve` so the server starts with an empty graph and rebinds within `GRAPHIFY_POLL_SECONDS` (default 2 seconds) of a graph file appearing or changing on disk. Sessions that begin with an empty workspace and clone a repo mid-session do not require a Claude Code restart.
5. In advanced session mode only, a PostToolUse hook (`graphify-active-repo.sh`) writes the current repo root to a sentinel file at `~/.cache/codeflare-hooks/graphify-active-cwd`. The hook fires on the matcher set `Bash | Edit | Write | Read | NotebookEdit | mcp__context-mode__ctx_execute | mcp__context-mode__ctx_execute_file | mcp__context-mode__ctx_batch_execute`. Resolution walks up from the candidate dir to the nearest ancestor containing `.git/` or `graphify-out/`. The MCP wrapper reads this sentinel to rebind its in-memory graph; when the sentinel is absent or stale, the wrapper falls back to the freshest `CODEFLARE_WORKSPACE/*/graphify-out/graph.json` by mtime.

**Constraints:**
- Graphify is the upstream `graphifyy` package on PyPI (Apache-2.0). No Codeflare fork.
- MCP server registration + the `graphify-mcp-lazy.py` wrapper are unconditional on session mode (capability is ambient). The disciplines in REQ-AGENT-024 and the active-repo hook (AC5) are mode-gated to advanced.
- Per-branch graphs are not supported. The wrapper reads `<repo>/.git/HEAD` only for log identification; graphify upstream models snapshots not branches, so users run `graphify update` after a checkout and the wrapper picks up the new mtime.
- `[office]`, `[google]`, `[video]`, `[neo4j]`, and external-provider backend extras (`[ollama]`, `[bedrock]`, `[gemini]`, `[openai]`) are not installed. Users who need them can `uv tool install --upgrade graphifyy[all]` manually.

**Applies To:** Agent
**Priority:** P1
**Dependencies:** REQ-AGENT-001, REQ-AGENT-004, REQ-AGENT-005, REQ-AGENT-008
**Verification:** Automated test (`host/__tests__/entrypoint-graphify-mcp.test.js`, `host/__tests__/dockerfile-graphify.test.js`, `host/__tests__/graphify-active-repo.test.js`, `host/__tests__/graphify-mcp-lazy.test.js`)
**Status:** Implemented

## REQ-AGENT-024: Advanced-Session-Mode Graph-First Discipline

**Intent:** In advanced session mode, the agent is taught to prefer the knowledge graph over Grep-style text search for structural questions, so token cost on architecture, dependency, and call-flow questions is bounded.

**Acceptance Criteria:**
1. In advanced session mode only, a SessionStart hook (matcher: startup) inspects the current working directory and injects an `additionalContext` system reminder when `graphify-out/graph.json` exists, pointing the agent at `GRAPH_REPORT.md` and the MCP tools. When the graph is absent but the cwd looks like a code repo, the hook instead injects a build-suggestion reminder.
2. In advanced session mode only, `~/.claude/rules/graph-first.md` is preseeded. It is authoritative and short (target ~100 tokens), states MUST / MUST NOT bullets for graph vs Grep, and references `~/.claude/skills/graphify/SKILL.md` for mechanics rather than restating them.
3. In advanced session mode only, `~/.claude/skills/graphify/SKILL.md` is preseeded for Claude Code, with per-agent adapted variants emitted for Codex, Copilot, and OpenCode by `scripts/generate-agent-seed.mjs`. The SKILL documents `graphify cluster-only . --no-viz` as the safe path for repos with more than 2000 files and instructs the agent on first build to add the canonical `.gitignore` block defined in SKILL note 3 (covering regenerable build outputs under `graphify-out/`, working-tree intermediates, and per-machine markers) plus `graphify-out/graph.json merge=graphify` to `.gitattributes`. The committed surface is `graph.json`, `GRAPH_REPORT.md`, `graph.html`, and optional `wiki/`.
4. In advanced session mode only, a PreToolUse hook (`graph-first-nudge.sh`) fires on `Grep`, `Glob`, `mcp__context-mode__ctx_search`, and `mcp__context-mode__ctx_batch_execute` tool calls. When a `graphify-out/graph.json` exists in the agent's cwd, the hook emits an `additionalContext` system reminder suggesting the agent prefer `mcp__graphify__*` for structural questions. The hook is non-blocking (exit 0 with `hookSpecificOutput.additionalContext` only). Both matcher sets are required because `enforce-ctx-mode.sh` denies `Grep`/`Glob`/`Read` in custom-tier sessions, redirecting the agent to the ctx grep-equivalents.
5. In advanced session mode only, a PreToolUse hook (`enforce-graphify.sh`) hard-blocks structural searches after 3 grep-class tool calls in the same turn when no `mcp__graphify__*` call (or `graphify query|path|explain` CLI) has been made. Matchers: `Grep`, `Bash`, `mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, `mcp__context-mode__ctx_execute_file`. The shell parser reuses the `extract_subs` / `normalize_command` / chain-op splitter from `enforce-ctx-mode.sh` so substitution, heredocs, quoted regions, and pipeline segments cannot slip past. SEARCH classification: `grep|rg|ag|ack`, `git grep`, `find` with `-name|-path|-iname|-ipath|-regex`, `awk` with `/regex/` body. Active-repo resolution: the hook reads `~/.cache/codeflare-hooks/graphify-active-cwd` (the sentinel `graphify-active-repo.sh` maintains, see REQ-VAULT-004 AC3) and gates on `<active-repo>/graphify-out/graph.json` existing, falling back to the tool-call envelope `.cwd` when the sentinel is absent. The codeflare session layout (every agent session has `cwd=~/workspace`, never inside a sub-repo) makes the sentinel the load-bearing signal; the envelope-cwd fallback exists for vanilla graphify usage outside codeflare. The vault entry in `~/.graphify/global-graph.json` is intentionally NOT enforcement-eligible: a session whose active repo has no graph (vault-only-in-global) does not trigger the hard-block, so the user can grep freely in repos they have not yet graphified. User-only bypass: `touch /tmp/graphify-bypass` (one-shot, auto-deleted) or `skip graph` in user message. Any unexpected error returns exit 0 (never locks the user out).
6. In advanced session mode only, before dispatching semantic-extraction subagents in a `/graphify` build (Step B2 of the upstream protocol), the agent presents an `AskUserQuestion` with exactly two modes - AST-only (free, structural edges only) and Full (AST plus parallel Haiku subagents extracting concepts from docs / papers / images) - and includes both the actual subagent count and a wall-time estimate. The question is skipped only when the corpus contains zero docs/papers/images (code-only repos go straight to Part C with nothing for Part B to do).
7. In advanced session mode only, Part B semantic subagents are dispatched with `model: "haiku"` so per-build cost matches vault-extract economics (~1/8 of opus, ~1/3 of sonnet). Escalation to Sonnet is permitted only when `--mode deep` was explicitly passed on the `/graphify` command; Opus is never used from this skill.

**Constraints:**
- The SessionStart hook never auto-builds a graph. It only injects context when one exists or a build suggestion when source files are present without one.
- The AC4 soft-nudge hook never blocks; semantic judgment of whether a single grep is appropriate cannot be reliably made up-front. The AC5 hard-block enforces a quantitative threshold (3 grep-class calls without a graph query) rather than a per-call semantic judgment, so the two layers compose: nudge on every call, block only when the pattern persists.

**Applies To:** Agent
**Priority:** P1
**Dependencies:** REQ-AGENT-023
**Verification:** Automated test (`host/__tests__/entrypoint-graphify-hooks.test.js`, `host/__tests__/graphify-session-start.test.js`, `host/__tests__/graph-first-nudge.test.js`, `host/__tests__/preseed-graphify-discipline.test.js`, `host/__tests__/skill-graphify-content.test.js`, `host/__tests__/enforce-graphify.test.js`)
**Status:** Implemented

## REQ-AGENT-025: Post-Clone Graph Triage

**Intent:** After the agent clones a repo, it must triage whether to build (or refresh) a knowledge graph for it before doing other work, so users on unfamiliar repos do not start cold.

**Acceptance Criteria:**
1. In advanced session mode only, a PostToolUse hook on `Bash` and `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute` matchers detects `git clone` and `gh repo clone` invocations (anchored token regex, not substring; rejects echoed false positives) and injects a directive.
2. The directive branches on whether `<cloned-dir>/graphify-out/graph.json` already exists: if absent, the directive instructs the agent to prompt the user via `AskUserQuestion` and run a full `/graphify` build on confirmation; if present, the directive tells the agent to skip the prompt and run `graphify update .` (AST-only incremental refresh).
3. The hook is idempotent per cloned directory per session via a marker file under `/tmp/codeflare-graphify-prompted-<session_id>/`. The marker dir is session-scoped via `session_id` from the hook envelope (fallback `ppid-$PPID`) so a fresh session re-triages the same clone and stale markers do not persist across container restarts.

**Constraints:**
- The hook never invokes graphify directly. It only injects a directive instructing the agent to prompt the user via AskUserQuestion (or to run `graphify update` for the graph-present branch).

**Applies To:** Agent
**Priority:** P1
**Dependencies:** REQ-AGENT-023, REQ-AGENT-024
**Verification:** Automated test (`host/__tests__/graphify-clone-prompt.test.js`)
**Status:** Implemented

## REQ-AGENT-026: Knowledge-Graph Persistence via Git

**Intent:** Graphify artifacts persist with the repository, not with the user, so contributors on a clone inherit the graph for free and Codeflare's R2 bisync does not carry per-repo graph data.

**Acceptance Criteria:**
1. The rclone bisync filter in `entrypoint.sh` excludes `**/graphify-out/**` from R2 sync. No graphify artifact ever round-trips through R2.
2. The container image registers the graphify semantic merge driver globally via `git config --global merge.graphify.driver "graphify merge-driver %O %A %B"` and `merge.graphify.name`. The configuration is tier-independent and lands regardless of session mode.
3. Repo owners with push permission commit `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html`, and optionally `wiki/` to git. Contributors get the graph and a browser-openable interactive visualization on clone. Concurrent edits to `graph.json` in repos that wire `graphify-out/graph.json merge=graphify` in `.gitattributes` are auto-resolved on `git merge` / `git pull` without manual JSON intervention.
4. For repos without push permission, the graph lives in the working tree only and is ephemeral.

**Constraints:**
- SKILL guidance (REQ-AGENT-024 AC3) carries the per-repo `.gitignore` / `.gitattributes` instructions; this REQ specifies the platform-level pieces (bisync exclude, global merge-driver registration).

**Applies To:** Agent
**Priority:** P1
**Dependencies:** REQ-AGENT-023
**Verification:** Automated test (`host/__tests__/entrypoint-graphify-bisync.test.js`, `host/__tests__/dockerfile-graphify.test.js`)
**Status:** Implemented

## REQ-AGENT-027: Context-Mode Interoperability

**Intent:** When the context-mode plugin is preseeded, the graphify CLI must coexist with the enforce-ctx-mode Bash whitelist and the graph-first soft-nudge must reach the agent through context-mode's redirected tool-call path.

**Acceptance Criteria:**
1. When the context-mode plugin is preseeded (effectiveTier `unlimited` plus advanced session mode), `graphify` is in the `enforce-ctx-mode.sh` Bash whitelist so `graphify update .` and `graphify query ...` are not denied.
2. The REQ-AGENT-024 AC4 PreToolUse soft-nudge hook registers both the non-ctx matchers (`Grep`, `Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`, `mcp__context-mode__ctx_batch_execute`) so the nudge fires in both tier paths.

**Constraints:**
- Graphify must not depend on context-mode at runtime. `/graphify` extraction uses upstream graphify's subagent-chunking model; context-mode, when present, provides bonus per-subagent token routing via its existing `Read|Grep|Glob|Agent` PreToolUse matchers, but is not a precondition.

**Applies To:** Agent
**Priority:** P2
**Dependencies:** REQ-AGENT-023, REQ-AGENT-024
**Verification:** Automated test (`host/__tests__/enforce-ctx-mode-graphify.test.js`, `host/__tests__/graph-first-nudge.test.js`)
**Status:** Implemented
