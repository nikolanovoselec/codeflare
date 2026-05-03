# Agent Preseed System

<!-- doc-allow-large: dense reference document — manifest structure,
     per-agent document counts, hook script roles, deployment paths
     and troubleshooting recipes are all load-bearing reference
     material that needs to live in one navigable file. Splitting
     would force readers between sibling pages mid-lookup. -->

**Audience:** Developers

How AI agent rules, agents, commands, skills, and plugins are deployed
to per-user containers. This file owns the "what gets seeded" and "how
it gets there" content. Memory-system specifics live in
[memory.md](memory.md); container runtime details live in
[container.md](container.md).

## Session Modes

Users choose between **Default** and **Advanced** session modes via
Settings > Session Defaults. The mode controls which preseed files are
deployed on Recreate or new bucket creation.

| Content | Default | Advanced |
|---------|---------|----------|
| Memory plugin & rule | No | Yes |
| CI monitoring, environment, no-local-builds, deploy-credentials rules | Yes | Yes |
| Cloudflare stack, ship, ship references skills | Yes | Yes |
| `consult-llm` skill (CC only) | No | Yes |
| CC hooks: `block-attributed-commits`, `git-push-review-reminder`, `enforce-review-spawn` | No | Yes |
| Language rules (23 files: common, TS, Python, Go, Swift) | No | Yes |
| Agent definitions (8: architect, code-reviewer, spec-reviewer, etc.) | No | Yes |
| Commands (5: /brainstorm, /debug, /deploy, /review, /sdd) | No | Yes |
| Cherry-picked skills (8: api-design, backend-patterns, etc.) | No | Yes |
| `spec-discipline` rule (universal SDD enforcement, all 5 agents) | No | Yes |
| `documentation-discipline` rule (per-file/per-cell budgets, lane separation) | No | Yes |
| `tdd-discipline` rule (test-quality patterns, third sibling of the discipline triad) | No | Yes |
| SDD template scaffolding (13 files for `/sdd init`) | No | Yes |
| Known marketplaces plugin config | Yes | Yes |

**Storage**: `sessionMode?: 'default' | 'advanced'` in
`UserPreferences` (KV). Undefined = `'default'`.

**Resolver**: `resolveSessionMode(prefs)` in
`src/lib/session-mode.ts` -- single source of truth for the
`?? 'default'` fallback.

**When mode takes effect**: On any of: explicit "Recreate AI agent
skills & rules" click, new bucket creation, Stripe mode change
(upgrade or downgrade via webhook), subscription termination
(`customer.subscription.deleted`), or Settings toggle of
`sessionMode`. The Settings toggle immediately triggers server-side
reconciliation as part of the `PATCH /api/preferences` call -- no
separate Recreate click is required; the UI shows a confirmation
("Agent skills updated for X mode. Takes effect in new sessions.")
when the toggle completes. On Stripe-driven or Settings-driven
reconciliation, preseed files are overwritten to match the new mode;
user-created files are never deleted. Implements
[REQ-AGENT-004](../sdd/agents.md#req-agent-004) AC4–AC5 and
[REQ-AGENT-005](../sdd/agents.md#req-agent-005).

**Cleanup on Recreate**: `reconcileAgentConfigs()` seeds
mode-appropriate files then deletes preseed-managed files not in
the current mode. Strictly scoped to keys from
`AGENTS_SEEDED_CONFIGS` -- no bucket listing, no prefix scans,
never touches user-created files. `getPreseedKeysNotInMode()`
excludes variant-per-mode keys (instruction files that exist in
both modes with different content) to avoid deleting a file that
was just seeded. Partial delete failures return `warnings` without
failing the overall operation. `getConfigsForMode()` validates no
duplicate keys within a single mode.

**No migration**: Existing users are unaffected. Changes only happen
on explicit action.

## Preseed Components

ECC-derived rules, agents, commands, and skills are preseeded directly
to the agent config filesystem. No external plugins are installed.

**Agents (8)**: `architect`, `build-error-resolver`, `code-reviewer`,
`doc-updater`, `refactor-cleaner`, `security-reviewer`,
`spec-reviewer`, `tdd-guide`. Preseeded to `~/.claude/agents/*.md`
(and adapted equivalents for other agents) via the manifest pipeline
with `"modes": ["advanced"]`. Each agent definition has YAML
frontmatter with `name`, `description`, `tools` (emitted as a record
`{read: true, write: true}` for OpenCode, instead of array format),
and `model` (CC only).

**Commands (5)**: `brainstorm`, `debug`, `deploy`, `review`, `sdd`.
Preseeded to `~/.claude/commands/*.md` (CC only -- other agents don't
support slash commands). Planning transitions are handled via Plan
Mode (a built-in Claude Code primitive), not a slash command.

**Skills (27 entries)**: `cloudflare-stack`, `ship` (+ 2 reference
files), `consult-llm`, `api-design`, `backend-patterns`,
`content-hash-cache-pattern`, `database-migrations`,
`deployment-patterns`, `frontend-patterns`, `iterative-retrieval`,
`search-first`, `spec-driven-development` (+ 13 reference templates
for `/sdd init` scaffolding). Preseeded to
`~/.claude/skills/<name>/SKILL.md` (and adapted equivalents for
agents that support skills). `consult-llm` is CC-only (depends on
MCP tool).

**Rules (27 files, 4 in both modes + 23 advanced-only)**: Core
environment rules (`ci-monitoring`, `cloudflare-environment`,
`no-local-builds`, `deploy-credentials`) in both modes. The
discipline triad — `spec-discipline`, `documentation-discipline`,
`tdd-discipline` — is advanced-only (Pro-mode SDD workflow opt-in:
spec-discipline is the universal enforcement layer inlined into all
5 agents' instructions; documentation-discipline defines per-file
line budgets, per-cell word budgets, and lane separation for
`documentation/`; tdd-discipline defines what counts as a real
test, no text-matching theater or tautology). `memory` rule is
advanced-only (depends on MCP memory server). ECC-derived language
rules in `{common,typescript,python,golang,swift}/` subdirs (3 + 5*4
= 23 files, advanced only). Common rules cover security, coding
style, and git workflow. Language-specific rules provide conventions
for TypeScript, Python, Go, and Swift.

**Known marketplaces**: `plugins/known_marketplaces.json` preseeds
the official Anthropic plugin marketplace URL for user discovery.

**Updates**: Preseed files update when the pipeline is redeployed
and users click "Recreate AI agent skills & rules".

## Preseed Deployment

All preseed content is deployed via the manifest pipeline:

1. Source files in `preseed/agents/claude/` organized by type:
   `rules/`, `agents/`, `commands/`, `skills/`, `plugins/`
2. `preseed/agents/claude/manifest.json` maps each file to modes
   (`default`, `advanced`, or both)
3. `scripts/generate-agent-seed.mjs` reads manifest + files
   (manifest-driven, ignores non-manifest files like
   `plugins/cache/`), generates `src/lib/agent-seed.generated.ts`
   with `AGENTS_SEEDED_CONFIGS` array (187 documents across all
   agents)
4. On first bucket creation:
   `reconcileAgentConfigs(mode, { overwrite: false, cleanup: false })`
   writes mode-appropriate files to R2
5. On "Recreate skills & rules" button:
   `reconcileAgentConfigs(mode, { overwrite: true, cleanup: true })`
   overwrites in R2 and deletes files not in current mode
6. Bisync pulls from R2 to container config directories
   (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.copilot/`,
   `~/.config/opencode/`)

**Manifest structure (77 total entries)**:
- `rules/` (27): core (4 default+advanced: ci-monitoring,
  cloudflare-environment, no-local-builds, deploy-credentials; +
  4 advanced-only: memory, spec-discipline,
  documentation-discipline, tdd-discipline), common (3),
  typescript (4), python (4), golang (4), swift (4)
- `agents/` (8): architect, build-error-resolver, code-reviewer,
  doc-updater, refactor-cleaner, security-reviewer, spec-reviewer,
  tdd-guide (advanced only)
- `commands/` (5): brainstorm, debug, deploy, review, sdd
  (advanced only)
- `skills/` (27): cloudflare-stack, ship (+2 refs), consult-llm,
  api-design, backend-patterns, content-hash-cache-pattern,
  database-migrations, deployment-patterns, frontend-patterns,
  iterative-retrieval, search-first, spec-driven-development (+13
  reference templates for /sdd init scaffolding)
- `plugins/` (10): known_marketplaces.json (default+advanced),
  codeflare-memory plugin (4 files, advanced only: plugin.json,
  memory-capture.sh, memory-agent-prompt.md,
  memory-compact-prompt.md), codeflare-hooks plugin (5 files,
  advanced only: plugin.json, block-attributed-commits.sh,
  git-push-review-reminder.sh, enforce-review-spawn.sh,
  lib/gh-pr-state.sh — shared helper sourced by both PR-aware hooks)

## Multi-Agent Preseed

The generator produces adapted config files for all supported agents
from CC's preseed as single source of truth. No duplicate preseed
files exist on disk.

**Supported agents and their config locations:**

| Agent | Global Instructions | Skills | Custom Agents |
|-------|-------------------|--------|---------------|
| CC | `~/.claude/rules/*.md` (individual) | `~/.claude/skills/<name>/SKILL.md` | `~/.claude/agents/*.md` |
| Codex | `~/.codex/AGENTS.md` (single file) | `~/.codex/skills/<name>/SKILL.md` | N/A |
| Gemini | `~/.gemini/GEMINI.md` (single file) | `~/.gemini/skills/<name>/SKILL.md` | `~/.gemini/agents/*.md` |
| Copilot | `~/.copilot/copilot-instructions.md` (single file) | N/A | `~/.copilot/agents/<name>.agent.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` (single file) | `~/.config/opencode/skills/<name>/SKILL.md` | `~/.config/opencode/agents/*.md` |

**Tool name mapping** (adapted in agent definition frontmatter):

| CC | Codex | Gemini | Copilot | OpenCode |
|--------|-------|--------|---------|----------|
| Read | read | read_file | read | read |
| Write | write | write_file | editFiles | write |
| Edit | edit | replace | editFiles | edit |
| Bash | shell | run_shell_command | execute | bash |
| Grep | grep | search_file_content | search | search |
| Glob | glob | glob | search | glob |

**What each agent gets:**

| Agent | Total Documents |
|-------|-----------------|
| CC | 77 |
| Codex | 28 |
| Gemini | 36 |
| Copilot | 10 |
| OpenCode | 36 |
| **Total** | **187** |

**Excluded from non-CC agents**: hooks (CC hook system), commands (CC
slash commands), plugins (CC plugin system, including
codeflare-memory), `rules/memory.md` (depends on MCP memory server),
`consult-llm` skill (depends on CC-specific MCP tool).

**Adaptation pipeline**: For each non-CC agent, the generator: (1)
concatenates applicable rules into a single instructions file, (2)
remaps tool names in agent definition frontmatter, (3) removes
`model` field from frontmatter, (4) replaces `~/.claude/` path
references with agent-specific config paths, (5) uses correct file
extensions (e.g., `.agent.md` for Copilot agents).

**Per-mode counts**: Default mode seeds 25 files, advanced mode
seeds 184 files. Total array size is 187 (includes variant-per-mode
duplicates for instructions files).

**Variant-per-mode keys**: Instructions files appear twice in the
generated array -- once for default mode (3 rules) and once for
advanced mode (all rules including memory, ECC), with the same R2
key but different content. `getPreseedKeysNotInMode()` handles this
correctly by excluding keys that have a variant in the target mode.

## Settings.json Merge

Implements [REQ-AGENT-008](../sdd/agents.md#req-agent-008) AC3–AC5.

`entrypoint.sh` merges settings into `~/.claude/settings.json`
using a two-phase strategy. Non-hooks settings (statusLine,
effortLevel, permissions, etc.) are merged with `jq '. * $cfg'`.
Hooks are rebuilt separately: for each hook type and matcher,
user-added hooks (commands not matching
`codeflare-(hooks|memory)/scripts/`) are preserved, while managed
hooks are replaced with the entrypoint's definitions. This prevents
stale managed hooks from persisting while keeping user
customizations. Handles three cases:

- **File doesn't exist**: Creates with settings config
- **File exists**: Merges non-hooks settings, rebuilds hooks
  preserving user additions; empty-hooks matchers and empty
  hook-type top-level keys are filtered out to keep
  `settings.json` clean (guards against `null` hooks arrays from
  pre-existing settings)
- **File malformed**: Skips with warning (includes the jq error
  text), does not overwrite

## Plugin Enablement

`entrypoint.sh` merges `enabledPlugins` into `~/.claude/.claude.json`
to enable both the `codeflare-memory` and `codeflare-hooks` plugins.
This is permanent (not mode-gated) because missing plugins are
silently skipped by Claude Code -- when the plugin files are absent
in default mode, the plugins simply don't load. Plugins are used for
file organization and delivery via R2 sync only -- hook registration
is done via `settings.json` (see above).

- **codeflare-memory**: Scripts for memory capture (hook registered
  in settings.json, scripts delivered via plugin)
- **codeflare-hooks**: Scripts for commit attribution blocking,
  git-push review reminders, and SDD review-agent sequential
  enforcement — `spec-reviewer` runs first, then `doc-updater`
  sequentially; on non-SDD projects (no `sdd/`) no agents fire and
  the push is friction-free (vibe-coding mode). Implements
  [REQ-AGENT-021](../sdd/agents.md#req-agent-021) AC4. Hooks
  registered in settings.json, scripts delivered via plugin.

## Troubleshooting

- **Attribution blocking not working**: Check
  `~/.claude/settings.json` has a `PreToolUse` hook entry pointing
  to `block-attributed-commits.sh`. Verify the script exists at
  `~/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh`.
- **Review-spawn enforcement not firing on push**: see
  [Resetting the review-spawn checkpoint](#resetting-the-review-spawn-checkpoint)
  below.
- **Default mode has hooks**: If `settings.json` has hook entries in
  default mode, the entrypoint SESSION_MODE gating may have failed.
  Remove them:
  `jq 'del(.hooks)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json`.

### Resetting the review-spawn checkpoint

The `Stop` hook (`enforce-review-spawn.sh`) only fires in advanced mode
when `sdd/` and `sdd/README.md` are present. It triggers at PR-boundary
events: `gh pr create` runs in the session, OR a push lands on a
branch that already has an open PR (the hook calls `gh pr view` to
check). A plain push to a branch with no open PR intentionally does
NOT trigger enforcement — reviews are deferred until the PR opens.
Direct pushes to `main` are expected to be blocked by GitHub branch
protection; if branch protection is off and a direct push lands,
spawn the review agents manually after the push.

The hook tracks the most recently acknowledged PR HEAD SHA in
`.git/sdd-last-ack-pr-head`. Acknowledgment advances only when the
full pipeline (code-reviewer + spec-reviewer + doc-updater) is
observed for the current PR HEAD.

Three USER-ONLY bypass methods exist (the agent must never invoke
these autonomously): the user deletes `sdd/.skip-next-review`
(sentinel was consumed), the user says "skip review" in a message,
or the user waits for the 3-strike circuit breaker to clear after
3 blocks on the same un-acknowledged PR HEAD.

If enforcement fires spuriously after a legitimate pipeline
completed, reset both checkpoints:

```bash
rm .git/sdd-last-ack-pr-head .git/sdd-review-block-count
```

The legacy v4 timestamp file `.git/sdd-last-ack-push` (if present
from a prior install) is auto-deleted on the first v5 invocation,
so no manual cleanup is needed for the v4 → v5 migration path.

---

## Related Documentation

- [Memory](memory.md) — MCP memory server, capture/compact, R2 sync
  of memory files
- [Container](container.md#claude-code-integration) — Claude Code
  configuration
- [Storage & Sync](storage-and-sync.md) — R2 sync internals
- [Decisions](decisions/README.md) — Architecture decisions
