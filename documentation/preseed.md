# Agent Preseed System

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

| Content | Default | Advanced | Advanced on Custom tier |
|---------|---------|----------|-------------------------|
| Memory plugin & rule | No | Yes | Yes |
| Core environment rules (cloudflare-environment, no-local-builds, git-workflow) | Yes | Yes | Yes |
| Cloudflare-stack, github-cloudflare-ship (+ refs), ci-monitoring, pr-workflow, deploy-credentials skills | Yes | Yes | Yes |
| `consult-llm` skill (CC only) | No | Yes | Yes |
| CC hooks: `block-attributed-commits`, `git-push-review-reminder`, `enforce-review-spawn` | No | Yes | Yes |
| Language rules (18 files: common, TS, Python, Go, Swift) | No | Yes | Yes |
| Agent definitions (9: architect, code-reviewer, deep-reviewer, spec-reviewer, etc.) | No | Yes | Yes |
| Commands (5: /brainstorm, /debug, /deploy, /review, /sdd) | No | Yes | Yes |
| Cherry-picked skills (8: api-design, backend-patterns, etc.) | No | Yes | Yes |
| `spec-discipline` rule + spec-enforce skill family (3 skills: spine, AC, truth) | No | Yes | Yes |
| `documentation-discipline` rule + doc-enforce skill family (4 skills: spine, lanes, shape, truth) | No | Yes | Yes |
| `tdd-discipline` rule + tdd-enforce skill | No | Yes | Yes |
| git-review-pipeline skill (SDD PR-boundary review pipeline) | No | Yes | Yes |
| SDD template scaffolding (12 files for `/sdd init`) | No | Yes | Yes |
| Known marketplaces plugin config | Yes | Yes | Yes |
| context-mode MCP server (`ctx_*` helper tools, always-on) | Yes | Yes | Yes |
| context-mode plugin folder (auto-routing hooks for context-window reduction) | No | No | Yes |

The Custom-tier column reflects the extra delivery surface for users on the `unlimited` subscription tier in Advanced mode. The context-mode helper tools (`ctx_*`) are universally available so the agent can always invoke them on demand; the plugin folder that adds automatic context-window-reduction routing is delivered only to Advanced + Custom users.

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
[REQ-AGENT-004](../sdd/agents.md#req-agent-004) AC4 - AC5 and
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

**Agents (9)**: `architect`, `build-error-resolver`, `code-reviewer`,
`deep-reviewer`, `doc-updater`, `refactor-cleaner`, `security-reviewer`,
`spec-reviewer`, `tdd-guide`. Preseeded to `~/.claude/agents/*.md`
(and adapted equivalents for other agents) via the manifest pipeline
with `"modes": ["advanced"]`. `deep-reviewer` is invoked exclusively
by `/review --deep`; it reads SDD REQ + impl + tests and judges
behavioral spec-vs-code match per acceptance criterion. Each agent definition has YAML
frontmatter with `name`, `description`, `tools` (emitted as a record
`{read: true, write: true}` for OpenCode, instead of array format),
and `model` (CC only).

**Commands (5)**: `brainstorm`, `debug`, `deploy`, `review`, `sdd`.
Preseeded to `~/.claude/commands/*.md` (CC only -- other agents don't
support slash commands). Planning transitions are handled via Plan
Mode (a built-in Claude Code primitive), not a slash command. `/review`
takes mandatory scope flags (`--all` or `--diff`) plus optional
`--deep` (Phase 3 behavioral REQ verification via parallel
deep-reviewer agents) and `--verify-high` (Phase 7 external-LLM
second-opinion); invoking it with no arguments prints a CLI help
screen and exits without running.

**Skills (29 SKILL.md files, 44 manifest entries including
reference files)**: `cloudflare-stack`, `github-cloudflare-ship`
(+ 2 reference files), `consult-llm`, `api-design`,
`backend-patterns`, `content-hash-cache-pattern`,
`database-migrations`, `deployment-patterns`, `frontend-patterns`,
`iterative-retrieval`, `search-first`, `spec-driven-development`
(+ 12 reference templates for `/sdd init` scaffolding; covers the
three Import/Resume modes for legacy-codebase transition documented
below), `sdd-init`, `sdd-clean` (sub-command skills the `/sdd`
dispatch table routes to for `init` and `clean`), `vault-operations`
(layout, wikilink conventions, NEVER list - surfaced when an agent
touches `~/Vault/`), `vault-note-capture` (writes "take a note"
phrases to `~/Vault/Notes/<Category>/`), `graphify`. SDD
enforcement family (8 skills, advanced-only):
`spec-enforce` + `spec-enforce-ac` + `spec-enforce-truth`,
`doc-enforce` + `doc-enforce-lanes` + `doc-enforce-shape` +
`doc-enforce-truth`, `tdd-enforce`. Git-workflow family (4 skills):
`ci-monitoring`, `git-review-pipeline` (advanced-only),
`pr-workflow`, `deploy-credentials`. Preseeded to
`~/.claude/skills/<name>/SKILL.md` (and adapted equivalents for
agents that support skills). `consult-llm` is CC-only (depends on
MCP tool).

**Rules (27 files, 3 in both modes + 24 advanced-only)** (REQ-MEM-006,
REQ-VAULT-007): Core environment rules (`cloudflare-environment`,
`no-local-builds`, `git-workflow`) in both modes - `git-workflow` is
the umbrella core rule that delegates branched mechanics to the
`ci-monitoring`, `git-review-pipeline`, `pr-workflow`, and
`deploy-credentials` skills. The discipline triad -
`spec-discipline`, `documentation-discipline`, `tdd-discipline` - is
advanced-only core-minimum rules (Pro-mode SDD workflow opt-in:
identity, status vocabulary, severity, and skill pointers; detection
algorithms and content-quality checks live in their respective
`*-enforce` skill families). `memory` rule is advanced-only and
carries the folded vault trigger/route content (references CC-specific
`mcp__graphify__*` tools and the vault hook system).
`vault-note-capture` rule is advanced-only and routes "take a note"
phrases to the `vault-note-capture` skill. `graph-first` rule is
advanced-only (graphify discipline, REQ-AGENT-023). `karpathy` rule
is advanced-only (LLM coding-mistakes principles). ECC-derived
language rules in `{common,typescript,python,golang,swift}/` subdirs
(1 + 4*4 = 17 files, advanced only). `common/coding-style.md`
covers shared style; the per-language `security.md` files stand
alone after the `common/security.md` removal. Language-specific
rules provide conventions for TypeScript, Python, Go, and Swift.

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
   with `AGENTS_SEEDED_CONFIGS` array (240 documents across all
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

**Manifest structure (112 total entries)**:
- `rules/` (27): core (3 default+advanced: cloudflare-environment,
  no-local-builds, git-workflow; + 7 advanced-only top-level: memory,
  spec-discipline, documentation-discipline, tdd-discipline,
  graph-first, karpathy, vault-note-capture), common (1: coding-style;
  per-language security rules stand alone), typescript (4), python (4),
  golang (4), swift (4)
- `agents/` (11): architect, build-error-resolver, code-reviewer,
  deep-reviewer, doc-updater, memory-capture, refactor-cleaner,
  security-reviewer, spec-reviewer, tdd-guide, vault-extract
  (advanced only)
- `commands/` (5): brainstorm, debug, deploy, review, sdd
  (advanced only)
- `skills/` (44): cloudflare-stack, github-cloudflare-ship (+2
  refs), ci-monitoring, pr-workflow, deploy-credentials (the five
  default+advanced skills), consult-llm, api-design,
  backend-patterns, content-hash-cache-pattern, database-migrations,
  deployment-patterns, frontend-patterns, iterative-retrieval,
  search-first, spec-driven-development (+12 reference templates
  for /sdd init scaffolding), sdd-init, sdd-clean (sub-command
  skills), vault-operations, vault-note-capture, spec-enforce,
  spec-enforce-ac, spec-enforce-truth, doc-enforce, doc-enforce-lanes,
  doc-enforce-shape, doc-enforce-truth, tdd-enforce,
  git-review-pipeline, graphify
- `plugins/` (25): known_marketplaces.json (default+advanced),
  codeflare-memory plugin (4 files, advanced only: plugin.json,
  memory-capture.sh, memory-agent-prompt.md, prefilter-transcript.sh),
  codeflare-vault plugin (3 files, advanced only: plugin.json,
  vault-monitor-hook.sh, vault-extract-prompt.md), codeflare-hooks
  plugin (6 files, advanced only: plugin.json,
  block-attributed-commits.sh, block-local-builds.sh,
  git-push-review-reminder.sh, enforce-review-spawn.sh,
  lib/gh-pr-state.sh - shared helper sourced by both PR-aware
  hooks), context-mode plugin (3 files, advanced only: plugin.json,
  README.md, scripts/enforce-ctx-mode.sh - admin-only Custom-tier
  routing enforcement, see Third-party plugin section below),
  graphify plugin (8 files, default+advanced for plugin.json + README
  + graphify-mcp-lazy.py; advanced-only for graphify-active-repo.sh,
  graphify-session-start.sh, graphify-clone-prompt.sh,
  graph-first-nudge.sh, enforce-graphify.sh)

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
| CC | 91 |
| Codex | 40 |
| Gemini | 49 |
| Copilot | 11 |
| OpenCode | 49 |
| **Total** | **240** |

**Excluded from non-CC agents**: hooks (CC hook system), commands (CC
slash commands), plugins (CC plugin system, including
codeflare-memory and codeflare-vault), `rules/memory.md` (references
CC-specific `mcp__graphify__*` tools and the vault hook system; the
vault trigger/route content lives in memory.md as folded subsections,
not a separate rules/vault.md), `consult-llm` skill (depends on
CC-specific MCP tool).

**Adaptation pipeline**: For each non-CC agent, the generator: (1)
concatenates applicable rules into a single instructions file, (2)
remaps tool names in agent definition frontmatter, (3) removes
`model` field from frontmatter, (4) replaces `~/.claude/` path
references with agent-specific config paths, (5) uses correct file
extensions (e.g., `.agent.md` for Copilot agents).

**Per-mode counts**: Default mode seeds 36 files, advanced mode
seeds 236 files. Total array size is 240 (includes variant-per-mode
duplicates for instructions files).

**Variant-per-mode keys**: Instructions files appear twice in the
generated array -- once for default mode (3 rules) and once for
advanced mode (all rules including memory, ECC), with the same R2
key but different content. `getPreseedKeysNotInMode()` handles this
correctly by excluding keys that have a variant in the target mode.

## Settings.json Merge

Implements [REQ-AGENT-008](../sdd/agents.md#req-agent-008) AC3 - AC5.

`entrypoint.sh` merges settings into `~/.claude/settings.json`
using a two-phase strategy. Non-hooks settings (statusLine,
effortLevel, permissions, etc.) are merged with `jq '. * $cfg'`.
Hooks are rebuilt separately: for each hook type and matcher,
user-added hooks (commands not matching the managed-hooks regex)
are preserved, while managed hooks are replaced with the
entrypoint's definitions. The managed-hook detector matches:

- `plugins/(codeflare-(hooks|memory|vault)|graphify)/scripts/`
  (anchored on the literal `plugins/` segment so unrelated
  workspace tools with the same basenames are not falsely scooped
  into the prune)
- `enforce-ctx-mode.sh` (both legacy `~/.claude/hooks/` and
  current `~/.claude/plugins/context-mode/scripts/` paths)
- `context-mode hook claude-code` CLI invocations (bare,
  `bunx context-mode@*`, and `npx -y context-mode@*` forms for
  legacy-compat with stale settings.json from before the
  build-time install landed)

Adding a new hook script to entrypoint requires extending this
regex - otherwise prior copies accumulate on every container boot
instead of being replaced (the bug class that PR #369 fixed for
`codeflare-vault/scripts/` and `graphify/scripts/`).

Handles three cases:

- **File doesn't exist**: Creates with settings config
- **File exists**: Merges non-hooks settings, rebuilds hooks
  preserving user additions; empty-hooks matchers and empty
  hook-type top-level keys are filtered out to keep
  `settings.json` clean (guards against `null` hooks arrays from
  pre-existing settings)
- **File malformed**: Skips with warning (includes the jq error
  text), does not overwrite

## Plugin Enablement

(Implements [REQ-MEM-006](../sdd/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-007](../sdd/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session).)

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
  enforcement - `spec-reviewer` runs first, then `doc-updater`
  sequentially; on non-SDD projects (no `sdd/`) no agents fire and
  the push is friction-free (vibe-coding mode). Each tool-gated hook
  is registered on two matcher entries covering three tool names: the
  `Bash` matcher (with `Bash(git *)` and `Bash(gh *)` predicates) and
  the pipe-alternated MCP matcher
  `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute`.
  This keeps attribution blocking and push detection effective when
  context-mode's `enforce-ctx-mode.sh` restricts Bash to a whitelist
  (`git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip
  install`) - all `gh` calls in Bash are denied and agents route them
  through MCP shell tools instead. Implements
  [REQ-AGENT-021](../sdd/agents.md#req-agent-021) AC4, AC8. Hooks
  registered in settings.json, scripts delivered via plugin.

## Third-party plugin: context-mode

[context-mode](https://github.com/mksglu/context-mode) is registered
as an optional MCP server (`ctx_*` helper tools) for every user.
The npm package is fetched by the user's own container from the npm
registry on first invocation; Codeflare does not redistribute the
source. Commercial users receive only the MCP server registration:
no skill, rule, hook, or system-prompt nudge in our preseed
instructs Claude to invoke `ctx_*` tools. The agent's tool-selection
is its own, identical to how it picks any other listed MCP tool.

The full plugin folder containing the auto-routing hooks (PreToolUse
routing, PostToolUse indexing, PreCompact, SessionStart) plus the
context-mode enforcement hook is reserved for the admin-only Custom
(`unlimited`) tier sandbox. The enforcement hook is a fifth PreToolUse
handler that hard-enforces context-mode routing: Bash calls are
restricted to a whitelist (`git`, `mkdir`, `rm`, `mv`, `cd`, `ls`,
`npm install`, `pip install`); WebFetch and Grep are denied entirely
and redirected to the equivalent `ctx_*` tools. Per-call bypass via
`/tmp/ctx-bypass` (user-only sentinel - see
[Security](security.md#context-mode-enforcement-bypass)).

context-mode is licensed under [Elastic License 2.0](https://github.com/mksglu/context-mode/blob/main/LICENSE).
The integration is sized to stay within ELv2's permitted-use envelope.
See [AD49](decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) for the full design + license analysis.

### Graphify hard-block PreToolUse hook (REQ-AGENT-024)

In advanced session mode, `enforce-graphify.sh` is a second PreToolUse hook on the graphify plugin that complements the existing `graph-first-nudge.sh` soft nudge. The soft nudge fires on every grep-class call with an `additionalContext` reminder; the hard-block fires only after the pattern persists.

Mechanics:

- **Matchers**: `Grep`, `Bash`, `mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, `mcp__context-mode__ctx_execute_file`. Covers both standard tiers (where `Grep`/`Bash` fire natively) and custom tier (where `enforce-ctx-mode.sh` denies `Grep` and forces routing through the `ctx_execute*` family).
- **Gating**: two-step active-repo resolution. The hook first reads `~/.cache/codeflare-hooks/graphify-active-cwd` (the sentinel `graphify-active-repo.sh` maintains on every Bash/Edit/Write/ctx_execute tool call) and checks `<active-repo>/graphify-out/graph.json`. If the sentinel is absent or stale, it falls back to the tool-call envelope `.cwd`. In codeflare the session cwd is always `~/workspace` (parent of all repos, never a sub-repo), so the sentinel is the load-bearing signal; the envelope-cwd fallback exists for vanilla graphify usage outside codeflare. Vault-only-in-global is intentionally NOT enforcement-eligible: a session whose active repo has no graph triggers no hard-block, so the user can grep freely in repos they have not yet graphified.
- **Threshold**: blocks the next structural search after 3 grep-class tool calls in the same turn (counted by walking the transcript backward to the last real user prompt) when no `mcp__graphify__*` call (or `graphify query|path|explain` CLI invocation) has been made.
- **Classification**: SEARCH = first-word `grep|rg|ag|ack`, `git grep`, `find` with `-name|-path|-iname|-ipath|-regex`, or `awk` with `/regex/` body. The shell parser reuses `extract_subs` + `normalize_command` + chain-op splitter from `enforce-ctx-mode.sh`, so command/process substitution, heredocs, quoted regions, and pipeline segments cannot slip past.
- **User-only bypass**: `touch /tmp/graphify-bypass` (one-shot, auto-deleted on use) or include `skip graph` (case-insensitive) in a user message. The agent must never create the sentinel.
- **Fail-safe**: any unexpected error returns exit 0 with no output. Never locks the user out.

The hook surfaces blocks as `hookSpecificOutput.permissionDecision: deny` with a `BLOCKED: <N> structural searches since last user prompt, 0 graphify queries...` reason so the agent's next-turn context carries the directive to consult the graph.

## /sdd init Modes

`/sdd init` is the single entry point for bootstrapping SDD on a project. It detects one of three scenarios from project state and dispatches automatically:

- **Greenfield** - empty project. Agent drafts vision / actors / domains / requirements from the user's prose and writes scaffolding.
- **Import** - substantive existing code, no `sdd/` yet. Two-output model: behavior clearly determinable from source / tests / comments / commits / PRs becomes official REQs in `sdd/{domain}.md`; everything unclear (magic numbers, retry policies, ambiguous contracts, orphan code) becomes triage entries in `sdd/init-triage.md` with the agent's `**Context:**` (file:line, git author, commit refs, related tests/PRs) and `**Recommendation:**` (best-guess answer with one-line `**Rationale:**`) populated up front. Status default for CLEAR REQs honours `enforce_tdd`. Import Mode defaults `enforce_tdd: false` - CLEAR REQs whose source implements the AC land as `Status: Implemented` unconditionally (imported code predates REQ-ID test conventions; demoting everything to `Partial` would falsely brand the spec as incomplete). When `enforce_tdd: false`, each domain file receives a `_Verification: code-only (no automated coverage)._` footnote at the bottom; per-REQ `Notes:` fields are not used for this signal. Switch to `enforce_tdd: true` manually (in `sdd/config.yml`) once REQ-ID references have been added to test names.
- **Resume** - `sdd/` exists and `sdd/init-triage.md` has at least one `**Status:** open` item. Agent surfaces one item at a time with refreshed Context. Five decisions: `accept` (use the recommendation as-is, fold into REQ), `correct` (free-form prose describing what the thing is for and how it works; agent folds purpose into Intent and behavior into ACs), `lost` (one-line Reason required, no spec write), `skip` (stays open, no spec write), `quit`. Only `accept` and `correct` promote anything into the official spec.

**Interaction flow.** Both Greenfield and Import Mode run as a lean two-confirm flow: the agent asks one vision question (or accepts inline `$ARGUMENTS`), drafts the entire spec in memory (actors, domains, design principles, REQs in canonical shape, CON-* constraints, founding ADRs, glossary terms), presents the full draft as one review surface, and applies edits in place until the user accepts. The 10-15-turn one-domain-at-a-time confirmation chain is not used.

**Enrichment pass.** After the draft is accepted, before any files are written, three passes run automatically in one in-memory cycle. All three query the project's `graphify-out/graph.json` for structural inputs; the post-clone PostToolUse hook (REQ-AGENT-025) prompts the user to build a graph immediately after `git clone`, so the graph is normally already in place by the time `/sdd init` runs:

- **Cross-link pass** - `mcp__graphify__get_neighbors` returns every node that shares an edge with a referenced REQ / CON / concept; every drafted REQ that names another REQ in its body also gains it in `Dependencies:` as an anchor link `[REQ-X-NNN](#req-x-nnn-title-slug)`.
- **ADR-seed pass** - `mcp__graphify__god_nodes(top_n=20)` returns the most-connected nodes (architectural pillars). 3-8 surviving candidates (tech stack, framework, deployment target, auth pattern, data store, key middleware) become founding ADRs in `documentation/decisions/README.md` with an index table and per-ADR sections. Candidates that fail the "What is NOT an ADR" test (no real alternative considered) are dropped.
- **Glossary-seed pass** - `mcp__graphify__query_graph` for concept-tagged nodes (graphify emits these with `source_file: null`); each becomes a one-line glossary entry in `sdd/glossary.md`. Synonym clusters land in `documentation/README.md`'s synonym glossary slot.

No additional user prompts during the enrichment cycle. When the graphify graph is missing at enrichment time (rare - the post-clone hook offered to build one), `/sdd init` prompts the user once for `/graphify cluster-only` (AST-only, free); on decline, enrichment falls back to an in-memory heuristic (literal-string matching across the draft) with a one-line notice in `sdd/changes.md` recording reduced cross-link density. The `mcp__graphify__*` MCP tools are tool-agnostic and work identically under both Bash and context-mode (`mcp__context-mode__ctx_*`) environments.

**Scaffold slots.** At scaffold time `/sdd init` also touches `sdd/.review-needed.md`, `sdd/.coverage-report.md`, and `sdd/.last-clean-run.md` with a single `_Awaiting first run._` placeholder so the slot structure is visible from day one.

**Tool surface compatibility.** Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works under both Bash and the context-mode MCP tool family (`mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, `mcp__context-mode__ctx_search`). Discovery commands that produce more than 20 lines of output (`gh pr list --state all`, `git log --follow`, `npm view <pkg> peerDependencies`, full-tree scans, scaffold-only `npm install --package-lock-only`) route through `ctx_execute` / `ctx_batch_execute` in context-mode environments and through Bash in plain environments.

While `sdd/init-triage.md` contains any open items, `sdd/config.yml` carries `transition: true`. The transition gate condition is the conjunction `transition: true` in config AND `**Status:** open` items in the triage file (case-insensitive on `open`); all enforcement layers test both. During transition the entire review pipeline is suspended:

- PR-boundary hooks (`git-push-review-reminder` PostToolUse + `enforce-review-spawn` Stop) short-circuit to no-op so no reviewer spawns on push or PR events
- Manually-invoked review agents (code-reviewer, spec-reviewer, doc-updater) check the same gate and exit no-op with a one-line notice
- `/sdd mode unleashed` is rejected (judgment is required for triage; cannot run blind)

**Resume Mode** is always interactive regardless of `sdd/config.yml`'s `mode` setting. It refuses to start on a dirty working tree (same gate as `/sdd clean`). When `mode: auto` is active, a one-line suspension notice is printed at entry.

**Transition closure.** When the last open item is resolved or marked `lost`, the closure commit:
1. Clears `transition: true` from `sdd/config.yml`
2. Appends a closure entry to `sdd/changes.md` recording totals (accepted / corrected / lost)
3. The agent enters Plan Mode -- the first feature work on the now-real spec is plan-gated

`enforce_tdd` is NOT touched by the closure commit. The user changes it manually when ready for TDD enforcement (typically after adding REQ-ID references to test names in the imported source).

Full SDD discipline applies on the next push; autonomous agentic development is unlocked. `sdd/init-triage.md` is preserved as the audit record. Implements [REQ-AGENT-021](../sdd/agents.md#req-agent-021) AC17-AC21 and [REQ-AGENT-022](../sdd/agents.md#req-agent-022).

**GitHub corpus degradation.** When Import Mode cannot reach GitHub (non-GitHub remote, `gh auth status` failure, rate-limited, air-gapped), discovery falls back to working-tree + git-log evidence only. A one-line notice naming the reason is appended to the `sdd/changes.md` import entry; triage Context fields reference whatever artifact refs are reachable.

## Troubleshooting

See [Preseed Troubleshooting](preseed-troubleshooting.md) for hook debugging, attribution blocking issues, and review-spawn checkpoint reset.

---

## Related Documentation

- [Preseed Troubleshooting](preseed-troubleshooting.md) - Hook debugging and checkpoint reset
- [Memory](memory.md) - Vault-based cross-session memory and the
  capture hook chain
- [Container](container.md#claude-code-integration) - Claude Code
  configuration
- [Storage & Sync](storage-and-sync.md) - R2 sync internals
- [Decisions](decisions/README.md) - Architecture decisions
