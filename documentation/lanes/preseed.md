# Agent Preseed System

**Audience:** Developers

How AI agent rules, agents, commands, skills, and plugins are deployed
to per-user containers. This file owns the "what gets seeded" and "how
it gets there" content. Memory-system specifics live in
[vault.md](vault.md#memory-capture-system); container runtime details live in
[container.md](container.md).

## Contents

- [Session Modes](#session-modes)
- [Preseed Components](#preseed-components)
- [Preseed Deployment](#preseed-deployment)
- [Multi-Agent Preseed](#multi-agent-preseed)
- [Settings.json Merge](#settingsjson-merge)
- [Plugin Enablement](#plugin-enablement)
- [Third-party plugin: context-mode](#third-party-plugin-context-mode)
- [Graphify](#graphify-req-agent-023)
- [/sdd init Modes](#sdd-init-modes)
- [Troubleshooting](#troubleshooting)
- [Specification Coverage](#specification-coverage)
- [Related Documentation](#related-documentation)

## Session Modes

Users choose between **Default** and **Advanced** session modes via
Settings > Session Defaults. The mode controls which preseed files are
deployed on Recreate or new bucket creation.

| Content | Default | Advanced | Advanced on Custom tier |
|---------|---------|----------|-------------------------|
| Memory plugin & rule | No | Yes | Yes |
| Core environment rules (cloudflare-environment, no-local-builds, git-workflow) | Yes | Yes | Yes |
| Pi startup header and local statusline | Yes | Yes | Yes |
| Cloudflare-stack, github-cloudflare-ship (+ refs), ci-monitoring, pr-workflow, deploy-credentials skills | Yes | Yes | Yes |
| `consult-llm` skill (Claude + Pi) | No | Yes | Yes |
| CC hooks: `block-attributed-commits`, `git-push-review-reminder`, `enforce-review-spawn` | No | Yes | Yes |
| Language rules (common, TS, Python, Go, Swift) | No | Yes | Yes |
| Agent definitions (architect, code-reviewer, deep-reviewer, spec-reviewer, etc.) | No | Yes | Yes |
| Commands (/brainstorm, /debug, /deploy, /review, /sdd) | No | Yes | Yes |
| Cherry-picked skills (api-design, backend-patterns, etc.) | No | Yes | Yes |
| `spec-discipline` rule + spec-enforce skill family (spine, AC, truth) | No | Yes | Yes |
| `documentation-discipline` rule + doc-enforce skill family (spine, lanes, shape, truth) | No | Yes | Yes |
| `tdd-discipline` rule + tdd-enforce skill | No | Yes | Yes |
| git-review-pipeline skill (SDD PR-boundary review pipeline) | No | Yes | Yes |
| SDD template scaffolding for `/sdd init` | No | Yes | Yes |
| Known marketplaces plugin config | Yes | Yes | Yes |
| context-mode helper package (`ctx_*` tools) | Enabled by default in Pi; `/ctx off` to disable for current session | Enabled by default in Pi; `/ctx off` to disable for current session | Enabled by default in Pi; `/ctx off` to disable for current session |
| Pi tool extensions (`@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `pi-web-access`, `pi-mcp-adapter`) | Yes (always-on `required`) | Yes (always-on `required`) | Yes (always-on `required`) |
| context-mode plugin folder (Claude Code auto-routing hooks for context-window reduction) | No | No | Yes |

The Custom-tier column reflects the extra Claude Code delivery surface for users on the `unlimited` subscription tier in Advanced mode. Pi starts with context-mode **enabled** by default (its `ctx_*` tools and the bash-curl-redirect hook are active without `/ctx on`); the Codeflare Pi extension provides `/ctx status`, `/ctx on`, and `/ctx off` for per-session control. The next Codeflare container start resets Pi back to enabled. The five Pi tool extensions are installed in the settings `required` set, so they load in every Pi session independently of the context-mode toggle. `@juicesharp/rpiv-advisor` adds the `advisor` tool (escalate the current conversation to a stronger reviewer model picked via `/advisor`) and `pi-web-access` adds `web_search`/`fetch_content`; both authenticate through Pi's own model registry / zero-config Exa MCP, so neither needs a per-user API key. See [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) AC5 (context-mode enabled by default) and AC8 (the five extensions in the `required` set).

**Storage**: `sessionMode?: 'default' | 'advanced'` in
`UserPreferences` (KV). Undefined = `'default'`.

**Resolver**: `resolveSessionMode(prefs)` in
`src/lib/session-mode.ts` -- single source of truth for the
`?? 'default'` fallback.

**When mode takes effect**: On any of: explicit "Recreate AI agent
skills & rules" click, new bucket creation, Stripe mode change
(upgrade or downgrade via webhook), subscription termination
(`customer.subscription.deleted`), Settings toggle of
`sessionMode`, or automatic upgrade on release (triggered by
`preseedNeedsUpgrade: true` in the initial dashboard batch-status
response; see
[REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release)).

The Settings toggle immediately triggers server-side reconciliation
as part of the `PATCH /api/preferences` call -- no separate Recreate
click is required; the UI shows a confirmation ("Agent skills updated
for X mode. Takes effect in new sessions.") when the toggle
completes. On Stripe-driven or Settings-driven reconciliation,
preseed files are overwritten to match the new mode; user-created
files are never deleted. Implements
[REQ-AGENT-004](../../sdd/spec/agents.md#req-agent-004-two-session-modes-standard-and-pro) AC4 - AC5 and
[REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers).

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

**Agents**: `architect`, `build-error-resolver`, `code-reviewer`,
`deep-reviewer`, `doc-updater`, `refactor-cleaner`, `security-reviewer`,
`spec-reviewer`, `tdd-guide`. Preseeded to `~/.claude/agents/*.md`
(and adapted equivalents for other agents) via the manifest pipeline
with `"modes": ["advanced"]`. `deep-reviewer` is invoked exclusively
by `/review --deep`; it reads SDD REQ + impl + tests and judges
behavioral spec-vs-code match per acceptance criterion. Each agent definition has YAML
frontmatter with `name`, `description`, `tools` (emitted as a record
`{read: true, write: true}` for OpenCode, instead of array format),
and `model` (CC only).

**Commands**: `brainstorm`, `debug`, `deploy`, `review`, `sdd`.
Preseeded to `~/.claude/commands/*.md` (CC only -- other agents don't
support slash commands). Planning transitions are handled via Plan
Mode (a built-in Claude Code primitive), not a slash command. `/review`
takes mandatory scope flags (`--all` or `--diff`) plus optional
`--deep` (Phase 3 behavioral REQ verification via parallel
deep-reviewer agents) and `--verify-high` (Phase 7 external-LLM
second-opinion); invoking it with no arguments prints a CLI help
screen and exits without running.

**Skills** (each preseeded as `<name>/SKILL.md`): `cloudflare-stack`, `github-cloudflare-ship`
(+ reference files), `consult-llm`, `api-design`,
`backend-patterns`, `content-hash-cache-pattern`,
`database-migrations`, `deployment-patterns`, `frontend-patterns`,
`iterative-retrieval`, `search-first`, `spec-driven-development`
(+ reference templates for `/sdd init` scaffolding; covers the
Import/Resume modes for legacy-codebase transition documented
below), `sdd-init`, `sdd-clean` (sub-command skills the `/sdd`
dispatch table routes to for `init` and `clean`), `vault-operations`
(layout, wikilink conventions, NEVER list - surfaced when an agent
touches `~/Vault/`), `vault-note-capture` (writes "take a note"
phrases to `~/Vault/Notes/<Category>/`), `graphify`. SDD
enforcement family (advanced-only):
`spec-enforce` + `spec-enforce-ac` + `spec-enforce-truth`,
`doc-enforce` + `doc-enforce-lanes` + `doc-enforce-shape` +
`doc-enforce-truth`, `tdd-enforce`. Git-workflow family:
`ci-monitoring`, `git-review-pipeline` (advanced-only),
`pr-workflow`, `deploy-credentials`. Design family (UI/frontend
work): `emil-design-eng` and `design-taste-frontend` (prose-only,
adapted to every agent), plus `impeccable` (the 23-sub-command
design skill + its ~57-file offline detector, minus the localhost
`live` browser SERVER scripts that have no browser in codeflare —
`reference/live.md` and the `live` sub-command listing are retained
but `live` is inert without a dev server). impeccable
is scoped to Claude + Pi only — Claude gets the trimmed tree in
`~/.claude/skills/impeccable/`, and Pi gets a DEDICATED copy under
`~/.pi/agent/skills/impeccable/` (paths re-pointed, `.mjs` scripts
emitted verbatim) rather than the prose-transformed lane, so its
detector scripts are never mangled by the Claude->Pi text adaptation.
Preseeded to
`~/.claude/skills/<name>/SKILL.md` (and adapted equivalents for
agents that support skills). `consult-llm` is scoped to Claude + Pi
only (both get the consult-llm MCP server — Claude via `~/.claude.json`,
Pi via `~/.pi/agent/mcp.json` `directTools` — so the skill never
references a tool the agent lacks); see [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity).
That same Pi `~/.pi/agent/mcp.json` entry also sets `lifecycle: "keep-alive"`
so pi-mcp-adapter reconnects it instead of dropping the MCP footer to
`0/1 … cached` after the default idle timeout.

**Rules** (core environment rules in both modes; the rest advanced-only) ([REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode),
[REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session)): Core environment rules (`cloudflare-environment`,
`no-local-builds`, `git-workflow`) in both modes - `git-workflow` is
the umbrella core rule that delegates branched mechanics to the
`ci-monitoring`, `git-review-pipeline`, `pr-workflow`, and
`deploy-credentials` skills. CI monitoring is on-demand: routine pushes do not
start a monitor unless the user asks, or a deploy/merge gate needs a fresh CI
result ([REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC5). The discipline triad -
`spec-discipline`, `documentation-discipline`, `tdd-discipline` - is
advanced-only core-minimum rules (Pro-mode SDD workflow opt-in:
identity, status vocabulary, severity, and skill pointers; detection
algorithms and content-quality checks live in their respective
`*-enforce` skill families). `memory` rule is advanced-only and
carries the folded vault trigger/route content (references CC-specific
`mcp__graphify__*` tools and the vault hook system).
`vault-note-capture` rule is advanced-only and routes "take a note"
phrases to the `vault-note-capture` skill. `graph-first` rule is
advanced-only (graphify discipline, [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)). `karpathy` rule
is advanced-only (LLM coding-mistakes principles). ECC-derived
language rules in `{common,typescript,python,golang,swift}/` subdirs
(advanced only). `common/coding-style.md`
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
   with `AGENTS_SEEDED_CONFIGS` array and `PRESEED_CONTENT_HASH`
   (deterministic SHA-256 over all documents sorted by key,
   truncated to 16 hex chars)
4. On first bucket creation:
   `reconcileAgentConfigs(mode, { overwrite: false, cleanup: false })`
   writes mode-appropriate files to R2
5. On "Recreate skills & rules" button:
   `reconcileAgentConfigs(mode, { overwrite: true, cleanup: true })`
   overwrites in R2 and deletes files not in current mode
6. On first dashboard load after a release:
   `GET /api/sessions/batch-status?includePreseedCheck=true` compares
   `PRESEED_CONTENT_HASH` against `lastPreseedHash` in
   `UserPreferences` KV. If they differ, the frontend fires
   `recreateAgentConfigs()` in the background. The "+ New Session"
   button and stopped-session cards are disabled during the upgrade.
   On completion, `lastPreseedHash` is updated. Failure is
   non-fatal; a page refresh retries. Implements
   [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release)
7. Bisync pulls from R2 to container config directories
   (`~/.claude/`, `~/.codex/`, `~/.gemini/` (Antigravity), `~/.copilot/`,
   `~/.config/opencode/`, `~/.pi/agent/`)

**Manifest structure** (Claude configs plus Pi-native assets; exact counts live in the manifests, not here):
- `rules/`: core (both modes: cloudflare-environment,
  no-local-builds, git-workflow; advanced-only top-level: memory,
  spec-discipline, documentation-discipline, tdd-discipline,
  graph-first, karpathy, vault-note-capture), common (coding-style;
  per-language security rules stand alone), typescript, python,
  golang, swift
- `agents/`: architect, build-error-resolver, code-reviewer,
  deep-reviewer, doc-updater, memory-capture, refactor-cleaner,
  security-reviewer, spec-reviewer, tdd-guide, vault-extract
  (advanced only)
- `commands/`: brainstorm, debug, deploy, review, sdd
  (advanced only)
- `skills/`: cloudflare-stack, github-cloudflare-ship (+
  refs), ci-monitoring, pr-workflow, deploy-credentials (the
  default+advanced skills), consult-llm, api-design,
  backend-patterns, content-hash-cache-pattern, database-migrations,
  deployment-patterns, frontend-patterns, iterative-retrieval,
  search-first, spec-driven-development (+ reference templates
  for /sdd init scaffolding), sdd-init, sdd-clean (sub-command
  skills), vault-operations, vault-note-capture, spec-enforce,
  spec-enforce-ac, spec-enforce-truth, doc-enforce, doc-enforce-lanes,
  doc-enforce-shape, doc-enforce-truth, tdd-enforce,
  git-review-pipeline, graphify, browser-run + browser-e2e (advanced only, both agents),
  emil-design-eng, design-taste-frontend (design prose, all agents),
  impeccable (design skill + offline detector, advanced only, Claude + Pi
  only — Pi gets a dedicated verbatim copy, not the prose-transformed lane)
- `plugins/`: known_marketplaces.json (default+advanced),
  codeflare-memory plugin (advanced only: plugin.json,
  memory-capture.sh, memory-capture-block.sh, memory-agent-prompt.md,
  prefilter-transcript.sh, assert-iso-ts.sh, memory-context-inject.sh),
  codeflare-vault plugin (advanced only: plugin.json,
  vault-monitor-hook.sh, vault-extract-prompt.md, merge-vault-graph.py),
  codeflare-hooks plugin (advanced only: plugin.json,
  block-attributed-commits.sh, block-local-builds.sh,
  git-push-review-reminder.sh, enforce-review-spawn.sh,
  scripts/lib/gh-pr-state.sh - shared gh CLI invocation sourced by
  both PR-aware hooks, scripts/lib/lane-classifier.sh - shared diff-
  classification helper sourced by both PR-aware hooks so the in-turn
  nudge and the turn-end gate agree on which lanes a push requires),
  context-mode plugin (advanced only:
  README.md - MCP/indexing registration only; stale deny-gates are pruned),
  graphify plugin (default+advanced for plugin.json + README
  + graphify-mcp-lazy.py; advanced-only for graphify-active-repo.sh,
  graphify-session-start.sh, graphify-clone-prompt.sh,
  graph-first-nudge.sh, safe-graphify-update.sh,
  local-graphify-labels.sh)
- Pi-native runtime assets include package config and package lock. (Graphify
  tools ship as the native extension `extensions/graphify-native.ts` rather than
  through the MCP adapter — a Pi-native first-class choice. Pi DOES consume MCP
  servers via the `pi-mcp-adapter`: it reaches `consult-llm` and `chrome-devtools`
  through the `mcp` proxy, wired into `~/.pi/agent/mcp.json` by `entrypoint.sh`.)

  Extension files deploy Pi-specific runtime behavior:
  `codeflare-commands.ts` provides `/debug`, `/deploy`, and `/brainstorm`;
  durable review-job helpers enforce PR-boundary review; `startup-header.ts`
  replaces Pi's startup header; `local-statusline.ts` preserves extension
  status rows in default and advanced modes; `browser-run.ts` + its pure
  `browser-run-helpers.ts` (advanced only) register native `browser_markdown`,
  `browser_content`, and `browser_scrape` tools that call the Cloudflare Browser
  Run REST Quick Actions (the cheap one-shot READ surface), self-gated on
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Browser Run has two surfaces
  and both agents have both: the READ surface above (Pi native tools; for Claude
  Code a sibling `browser-run` MCP server built from
  `preseed/agents/claude/browser-run-mcp/`, registered in `~/.claude.json`) and the
  INTERACTIVE `chrome-devtools` surface (navigate / click / screenshot / viewport —
  for Claude a registered MCP server, for Pi bridged in via the `pi-mcp-adapter`).
  The `browser-run` skill (both agents) frames the cost/context decision (cheap
  markdown read first, the interactive browser only when a page must be driven),
  and `browser-e2e` (both agents) drives the interactive surface to verify a
  deployed app by judgment, including from a mobile viewport. Every file under
  `preseed/agents/pi/extensions/` is loaded by the Pi extension scanner and must
  export a default factory function; pure helper modules (e.g.
  `browser-run-helpers.ts`, `graphify-helpers.ts`) therefore export a no-op
  default factory alongside their named exports, or Pi aborts startup with
  `Extension does not export a valid factory function`.

  Native skill overrides include graphify
  ([REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch)
  AC7) and `review`.

  Capture-contract prompts include `memory-agent-prompt.md` and
  `vault-extract-prompt.md`.

  Pi graphify scripts include `build-graphify-architecture.sh`,
  `build-graphify-ast.sh`, `safe-graphify-update.sh`, and
  `local-graphify-labels.sh`.

  The generator maps each manifest key by directory prefix:
  `extensions/` -> `.pi/agent/extensions/`, `skills/` -> `.pi/agent/skills/`,
  `scripts/` -> `.pi/agent/scripts/`, `prompts/` -> `.pi/agent/prompts/`,
  and `agents/` -> `.pi/agent/agents/`.
  The `agents/` prefix maps both to `.pi/agent/agents/` (session-local overrides for `@gotgenes/pi-subagents`) and to `~/.pi/agent/agents/` (persistent user-level overrides). `preseed/agents/pi/agents/Explore.md` is the first native Pi agent override shipped via this path.
  Package files deploy under `.pi/agent/npm/`.

  These assets adapt runtime behavior to Pi primitives while rules and
  skills still come from the Claude source tree. `/review` is deliberately
  separate from PR-boundary enforcement: the command reviews a requested
  scope, while `review-enforcement.ts` reacts to native GitHub workflow
  commands that create, push, sync, update, or merge PR heads, resolves the
  active repo from those commands, and requires durable review-job completion
  for SDD PRs targeting `main`/`master`.

  Cross-extension repo state (the session's active repo and the repo under
  review) is stored on `globalThis` via `Symbol.for("codeflare.activeRepo")`
  and `Symbol.for("codeflare.reviewRepo")`, because Pi 0.79.1's extension
  loader (`createJiti` with `moduleCache:false`) gives each extension its own
  instance of every imported module — a module-level variable written by
  `codeflare-pi.ts` is not visible to `review-enforcement.ts` or
  `local-statusline.ts`. The same pattern backs the `gh pr view` result cache
  (`Symbol.for("codeflare.prCache")`), with an asymmetric TTL (60 s for OPEN
  PRs, 10 s for negative/missing) keyed on repo + branch so a checkout
  invalidates promptly, and two per-session signals that decide whether a missed
  boundary **auto-starts** review or merely **offers** it. The PRIMARY signal is
  `Symbol.for("codeflare.reviewBoundaryActedThisSession")` — the set of
  repo+branch keys for which a real boundary command (push / `gh pr create`) ran
  this session, recorded in `onToolEnd` before any window-creation guard so a
  dropped window still proves this session pushed. The BACKSTOP is the per-session,
  per-branch baseline `Symbol.for("codeflare.reviewSessionBaselineHead")` — the
  head this session first observed on a branch (seeded once, deliberately NOT
  advanced on ack), so a later in-session push to a descendant still reads as an
  advance even if a module reload ate the tool-event. A head matching **either**
  signal auto-starts; a head matching **neither** — inherited by a fresh
  launch/clone or reached by a bare `git checkout` of another branch — is
  **offered once** as a passive `ctx.ui.notify` toast only — never as a
  chat/transcript message (a chat-visible offer is agent-readable, so the agent
  reads "Run /review-run …" as an instruction and spirals into acting on it after
  a clone-only request) — and stays merge-blocking until the user runs
  `/review-run` or `/review-skip`. The offer is deduped per session
  (`Symbol.for("codeflare.reviewOfferSurfacedThisSession")`), so a relaunch on a
  still-unchosen offer re-surfaces it exactly once rather than suppressing it
  forever. When `/review-run` cannot resolve the active repo it reports the Pi
  session cwd and tells the user to run a command inside the target repo first
  (so it becomes the active repo) and retry. On the `git push` / `gh pr create`
  boundary path specifically, enforcement fails open if `gh pr view` returns an
  OPEN PR with an empty `baseRefName` (a transient `gh`/`jq` parsing edge) — the
  PR is treated as targeting `main`/`master` rather than silently skipping
  review, and the review window persists `"main"` as a concrete base-label
  fallback so the pending record stays readable on reload (an empty label makes
  `loadPending` reject the row). That label is coarse — a `master`-based PR still
  records `"main"` — but harmless, because the review's diff scope is anchored by
  the SHA `reviewBase`, never by this branch label. The autonomous
  reconcile tick keeps the stricter non-empty-base check, and the `gh pr merge`
  gate reads PR state cache-bypassed and **fails closed** (blocks the merge) when
  `gh pr view` is unreadable while an unacked review is pending for the local head.

  The merge gate is **report-only and defended in depth** ([AD80](../decisions/README.md#ad80-pi-pr-boundary-merge-gate-is-report-only-and-defended-in-depth)).
  It blocks a merge until the reviewed head is **acked** — i.e. until the required
  reviewers RAN — never on findings severity; the review lanes only report, they
  never veto, so a clean merge is gated on coverage existing, not on a verdict. The
  blocking logic is a pure, unit-tested decision (`mergeGateDecision` in
  `review-job-helpers.ts`: allow / bypass / block) with the `onAgentStart` handler
  reduced to thin wiring. The decision evaluates the PR the merge command **actually
  targets**, not just the cwd branch: `mergeCommandTarget` (`review-helpers.ts`)
  pulls a PR number, a `/pull/N` URL, a branch, or a `--repo`/`-R` slug out of the
  command (the args are tokenized quote-aware, so a quoted multi-word flag value is
  never mistaken for the selector, and value-flag arguments are skipped) so `gh pr
  merge 123` is gated against PR 123, while a `gh pr merge --repo OTHER/REPO` naming a
  foreign repository is skipped by both the gate and the retroactive audit (the gate
  governs only this SDD repo's PRs). It fails CLOSED when that PR is readable-but-malformed (OPEN with an empty
  `baseRefName`/`headRefOid`) or when `gh` is transiently unreadable while any
  unacked merge-blocking head exists (a pending review, a latched circuit breaker,
  or an outstanding offer), and it blocks `--auto` on an enforced unacked PR (which
  would otherwise merge server-side after checks without re-consulting the gate).
  Because the `onAgentStart` pre-block cannot intercept every wrapper form (`bash -c`,
  `xargs`, or a server-side `--auto` that completes later), a **retroactive backstop**
  in `onToolEnd` emits a durable `merge_completed_unreviewed` audit event plus a toast
  whenever a PR is observed MERGED while its head was never acked — so an evasion is
  always recorded even when it could not be stopped. The pre-block is the primary
  defense; the retroactive audit is the truth layer behind it.

  The durable runner in `review-jobs.ts` writes job state under
  `.git/codeflare-review-jobs/<head>/` and public findings under
  `.git/sdd-review-results/<head>/`. Each result file uses a common
  `## Findings` section followed by a severity-count Review Summary table.
  While internal durable lanes run, Pi displays a compact footer status
  (`Review code | spec | docs`, rendering only required lanes and turning a lane
  label green when that lane finishes). Colored review status rows truncate by
  visible width, preserve ANSI color sequences, and reset styling before the
  ellipsis. Operators can diagnose background review progress without visible
  generic Agent tasks. Duplicate lane-result and summary announcements are
  suppressed for the same repo/head/lane result.

  The disk-driven reaper that settles each lane is retry-aware: an attempt that
  ends with `willRetry: true` (pi auto-retrying the same child after a transient
  error such as a WebSocket drop) does not settle the lane, and that attempt's
  error verdict is discarded so it cannot poison the retry — only a terminal
  `agent_end` (any end without `willRetry: true`; a clean finish omits the
  field) settles it. A lane an earlier reaper tick
  already marked failed is self-healed back to completed (audit event
  `lane_recovered`) if its transcript later shows a terminal clean usable
  result, so a review that succeeded on retry is never left discarded.

  After the first acknowledged review, subsequent re-reviews are scoped to the
  incremental window between the last acked clean head and the current head
  (`last-acked-head..current-head`), not the full PR diff, so a re-review
  inspects only the new commits instead of re-flagging the whole PR each round.
  `spawnDurableLane` carries that window into each durable lane subprocess by
  exporting `CODEFLARE_REVIEW_BASE` (last acked head), `CODEFLARE_REVIEW_HEAD`
  (current head), and `CODEFLARE_REVIEW_BASE_REF` (base branch ref) when a prior
  clean head was acked; on a first review none are set and the lane reviews the
  full PR diff. The scope limitation deliberately lives in the dispatch runtime,
  never in the shared reviewer agent definitions or enforce skills (which Claude
  and other CLIs also inherit): those are scope-agnostic, reviewing exactly the
  window the caller provides and defaulting to the full change set only when no
  window is given. The `reviewScopeBlockReason` guard (`review-lane-guards.ts`)
  makes the window binding: when `CODEFLARE_REVIEW_BASE` is set it blocks full-PR
  diff commands (`gh pr diff`; a `git diff` ranging two- or three-dot against the
  base branch — `origin/<ref>`, the base ref itself, or `main`/`master`/`develop`)
  while allowing the window forms (`git diff <base> <head>`, a bare `<base>..<head>`
  SHA range, `--name-only`, `-- <path>`). Implements
  [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)
  AC8 and
  [REQ-AGENT-060](../../sdd/spec/agents.md#req-agent-060-pi-durable-review-lane-tool-surface)
  AC8.

  After the exact-head durable review job completes and every required lane has
  a result file, Pi publishes one merged chat summary with `## Review Summary`,
  `## Findings`, and `## Finding Details` sections. That chat summary aggregates
  severity counts across code/spec/docs, lists all findings sorted by
  criticality, and avoids per-lane result-file links; the per-lane `.md` files
  remain the durable evidence store. Implements
  [REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-durable-review-status-and-result-formatting).

  Delivering that summary back into the live session is a separate, durable phase.
  The review can finalize off-turn (the idle reaper has no live session loop), where
  `pi.sendMessage` silently no-ops — a custom message only persists into the session
  transcript when the live session emits its `message_end` event. So finalizing arms
  a per-`(head, kind)` durable announcement record on disk under
  `.git/codeflare-review-jobs/<head>/announcements/` (`summary.json` and `autofix.json`)
  rather than firing a one-shot
  message: each summary/autofix message embeds a nonce and is marked delivered ONLY
  when that nonce is later found in the session transcript — a `sendMessage` return is
  never assumed delivered. Pending or unverified announcements are retried on every
  live lifecycle tick (bounded by a retry delay and an attempt cap, then marked failed
  with a notice). A completed review whose summary is not yet delivered shows a
  persistent `results ready (not shown) — /review-results` footer status, and the
  `/review-results` command displays the persisted summary on demand — the guaranteed
  fallback if automatic delivery never lands. The summary itself is sent with a plain
  `pi.sendMessage` (no `triggerTurn`/`deliverAs`) — the same synchronous append path
  `/review-results` uses, which persists the nonce-bearing content AND displays it in one
  step — gated on `pi.isIdle()` so it is never taken during a streaming turn: mid-stream the
  plain send would steer the summary into the running turn, where the agent reads it
  mid-reasoning (the agent-readable-message hazard REQ-AGENT-058 AC7 guards against for the
  missed-boundary offer). When the agent is mid-turn `sendAnnouncement` returns
  `{ sent: false }` and the per-tick drain loop re-attempts on the next idle lifecycle event
  (`agent_end` / `turn_end` / `session_start`); a summary still undelivered past 30 minutes
  escalates to the `/review-results` fallback so it can never strand silently. This age backstop
  is **summary-only**: the idle-gated summary can defer indefinitely while the agent streams
  (burning no attempts), so age is its sole escalation path; the autofix announcement is exempt —
  aging it would mark it `failed` at `attempts:0` before the fix turn ever fired, so an undelivered
  autofix instead terminates via head-supersede (a newer push retires the stale head) or the attempt
  cap — never on age alone. That makes the
  nonce-verify/retry phase a backstop rather than the primary delivery path: the earlier
  `triggerTurn`/`followUp` send routed through agent-core queues whose custom-message
  persistence depended on a live loop, so off-turn or post-reload it no-op'd and the summary
  never surfaced. The autofix request still uses `triggerTurn`/`followUp` because it
  intentionally triggers a fix/commit/push turn. Implements
  [REQ-AGENT-062](../../sdd/spec/agents.md#req-agent-062-pi-pr-boundary-review-result-delivery).

  Partial lane results, including any missing, failed, timed-out, or still-running
  lane, cannot trigger autofix. If legitimate MEDIUM/HIGH/CRITICAL findings remain
  after the complete exact-head summary, Pi then requests a fix-and-push pass,
  unless the latest explicit user directive opts out of auto-fixing for the round.
  Implements [REQ-AGENT-059](../../sdd/spec/agents.md#req-agent-059-pi-durable-review-fix-loop).

  Timed-out or failed durable lanes are recorded as failed and do not produce
  the required result file. The PR head remains unacked until a later review run
  succeeds, per
  [REQ-AGENT-054](../../sdd/spec/agents.md#req-agent-054-pi-durable-review-lane-failure-handling).

  Merge enforcement does not depend on third-party subagent task IDs or
  in-memory service records. Because Claude slash commands do not deploy to Pi, the user-invoked `/review` workflow
  ships as the dedicated `skills/review/SKILL.md` native skill (full
  11-phase flow) rather than relying only on the transformed
  `git-review-pipeline` enforcement skill. Pi memory capture is driven by
  two deployed contracts - `prompts/memory-agent-prompt.md` (the
  capture-agent contract) and `prompts/vault-extract-prompt.md` (the
  Vault-graph extraction contract) - which carry the full [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)-grade
  capture instructions; `memory-vault.ts` reads them from
  `~/.pi/agent/prompts/*.md`, reads the conversation from the durable
  on-disk session transcript Pi persists for `/resume`
  (`ctx.sessionManager.getSessionFile()` parsed via `parseSessionMessages`,
  not a volatile in-memory buffer), counts only Claude-compatible real
  user prompts (synthetic `<task-notification>` / command wrappers are
  ignored), and prefilters to user/assistant text (dropping tool and
  thinking blocks) before spawning the capture subagent once the delta
  since the last capture reaches 15 real user prompts (`delta >= 15`,
  [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages)); an
  empty resolved transcript skips capture instead of writing a hollow note.
  A missing `/tmp` counter with more than one real user prompt force-fires
  resumed-session capture, matching Claude. Vault indexing uses the shared
  `vault-extract.last` high-water marker
  ([REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session)) and excludes `Raw/Sessions/`,
  `graphify-out/`, `.silverbullet/`, and the four preseed root pages, so the
  Vault indexing agent only runs after user-curated Vault changes.
  Pi subagents are provided by `@gotgenes/pi-subagents`; the generator
  adapts Claude agent definitions into `.pi/agent/agents/*.md`.
  The container image preinstalls Pi extension npm dependencies into an
  image-local cache, and entrypoint copies that cache into `~/.pi/agent/npm`
  after R2 restore so Pi does not run npm install on first launch.

## Multi-Agent Preseed

The generator produces adapted config files for all supported agents
from CC's preseed as single source of truth. No duplicate preseed
files exist on disk.

**Supported agents and their config locations:**

| Agent | Global Instructions | Skills | Custom Agents |
|-------|-------------------|--------|---------------|
| CC | `~/.claude/rules/*.md` (individual) | `~/.claude/skills/<name>/SKILL.md` | `~/.claude/agents/*.md` |
| Codex | `~/.codex/AGENTS.md` (single file) | `~/.codex/skills/<name>/SKILL.md` | N/A |
| Antigravity (`agy`) | `~/.gemini/GEMINI.md` (single file, auto-loaded) | `~/.gemini/skills/<name>/SKILL.md` | `~/.gemini/agents/*.md` |
| Copilot | `~/.copilot/copilot-instructions.md` (single file) | N/A | `~/.copilot/agents/<name>.agent.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` (single file) | `~/.config/opencode/skills/<name>/SKILL.md` | `~/.config/opencode/agents/*.md` |
| Pi | `~/.pi/agent/AGENTS.md` (single file) | `~/.pi/agent/skills/<name>/SKILL.md` | `~/.pi/agent/agents/*.md` |

**Tool name mapping** (adapted in agent definition frontmatter):

| CC | Codex | Antigravity | Copilot | OpenCode | Pi |
|--------|-------|-------------|---------|----------|----|
| Read | read | read_file | read | read | read |
| Write | write | write_file | editFiles | write | write |
| Edit | edit | replace | editFiles | edit | edit |
| Bash | shell | run_shell_command | execute | bash | bash |
| Grep | grep | search_file_content | search | search | grep |
| Glob | glob | glob | search | glob | find |

**What each agent gets:** Claude Code and Pi both receive the full capability set - Claude Code through its native rules/agents/commands/skills/hooks/plugins, and Pi through adapted rules/skills/agents plus native TypeScript extensions that reimplement the CC-only surfaces (slash commands, hooks, memory capture, review enforcement) on Pi primitives. Codex, Copilot, OpenCode, and Antigravity receive a reduced, runtime-appropriate subset: adapted rules and - where the runtime supports them - skills and agents, but none of the CC-only surfaces. Antigravity (`agy`) is seeded into the Gemini CLI global config tree (`~/.gemini/`), which it reads natively; the `.gemini` -> `.agents` rename in Antigravity applies only to per-workspace config, not the home directory codeflare seeds. The exact per-agent document counts are emitted by `scripts/generate-agent-seed.mjs` from `manifest.json` - read the generated output, not a hardcoded total here.

**Excluded from non-CC transformed assets**: hooks (CC hook system),
commands (CC slash commands), plugins (CC plugin system, including
codeflare-memory and codeflare-vault), `preseed/agents/claude/rules/memory.md` (references
CC-specific `mcp__graphify__*` tools and the vault hook system; the
vault trigger/route content lives in that preseed rule as folded subsections,
not a separate rules/vault.md), `consult-llm` skill (depends on the
consult-llm MCP tool, so it is excluded from the codex/opencode/antigravity
transform lane — but Pi gets a native `consult-llm` skill + MCP server via
`~/.pi/agent/mcp.json`, see [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)).
Pi receives native TypeScript extensions for the
runtime behaviors that cannot be represented as transformed prose:
`/sdd`, `/graphify`, `/vault`, `/note`, `/debug`, `/deploy`, `/brainstorm`, graphify
active-repo/global-graph maintenance and clone triage, automatic memory capture,
Vault graph extraction/global-graph merge, local-build blocking,
and AI-attribution blocking. Pi receives a dedicated native graphify skill
that uses local AST extraction plus Pi `Agent` subagents instead of the
Claude/MCP-specific transformed skill. The Pi runtime also registers first-party native
`graphify_query` / `graphify_path` / `graphify_explain` tools through
`graphify-native.ts`. Each query shells the upstream Graphify CLI and resolves
the cwd repo graph first, then the active-repo sentinel graph, then the merged
global graph. The active repo identity injected into Pi context includes
repository basename, checked-out branch, and HEAD prefix. Pi receives a separate
`review-command.ts` for the user-invoked `/review` UX and
`review-enforcement.ts` for PR-boundary review enforcement.

**Adaptation pipeline**: For each non-CC agent, the generator: (1)
concatenates applicable rules into a single instructions file, (2)
remaps tool names in agent definition frontmatter, (3) removes
`model` field from frontmatter for runtimes that do not support it while preserving Pi subagent model pins, (4) replaces `~/.claude/` path
references with agent-specific config paths, (5) uses correct file
extensions (e.g., `.agent.md` for Copilot agents). Pi additionally
loads `preseed/agents/pi/manifest.json`, emits native runtime files
to `.pi/agent/extensions/`, `.pi/agent/scripts/`,
`.pi/agent/npm/package.json`, `.pi/agent/npm/package-lock.json`,
capture-contract prompts to `.pi/agent/prompts/`, native Pi skill overrides under
`~/.pi/agent/skills/`, and native Pi agent overrides under `~/.pi/agent/agents/`,
and adapts Claude agent definitions into `.pi/agent/agents/*.md` for
`@gotgenes/pi-subagents`. Pi's generated agent frontmatter deliberately drops
context-mode tools so those `@gotgenes/pi-subagents` subagents run against the
native Pi tool surface. This applies to subagent frontmatter only. Durable
PR-boundary review lanes are not `@gotgenes/pi-subagents` and not in-process
`createAgentSession` calls: `spawnDurableLane` launches detached headless `pi`
child processes with a bounded inspection tool allowlist, `--no-extensions`,
and explicit `-e` loading for `graphify-native.ts`, `review-lane-guards.ts`,
plus settings-enabled context-mode. Bash remains available for git/gh diff
inspection; `review-lane-guards.ts` blocks local build, test, lint, and dev-server
commands in the headless lane.

**Per-mode seeding**: Default mode seeds the core rules plus the
universal skills; advanced mode seeds the full set (memory, ECC
language rules, discipline triad, enforcement skill families, agents,
commands, plugins). The generated array carries variant-per-mode
duplicates for instructions files (see below); the exact per-mode
file counts live in the generated `agent-seed.generated.ts`, not here.

**Variant-per-mode keys**: Instructions files appear twice in the
generated array -- once for default mode (core rules only) and once for
advanced mode (all rules including memory, ECC), with the same R2
key but different content. `getPreseedKeysNotInMode()` handles this
correctly by excluding keys that have a variant in the target mode.

## Settings.json Merge

Implements [REQ-AGENT-008](../../sdd/spec/agents.md#req-agent-008-preseed-deployed-to-container-on-start) AC3 - AC5.

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

(Implements [REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session).)

`entrypoint.sh` merges `enabledPlugins` into `~/.claude/.claude.json`
to enable both the `codeflare-memory` and `codeflare-hooks` plugins.
This is permanent (not mode-gated) because missing plugins are
silently skipped by Claude Code -- when the plugin files are absent
in default mode, the plugins simply don't load. Plugins are used for
file organization and delivery via R2 sync only -- hook registration
is done via `settings.json` (see above).

- **codeflare-memory**: Two UserPromptSubmit hooks registered in
  settings.json, scripts delivered via plugin.
  `memory-context-inject.sh` fires on the first prompt of each
  session: extracts keywords, queries the unified graphify graph,
  and injects matched nodes as additionalContext before the agent
  responds ([REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt)).
  `memory-capture.sh` handles the ongoing 15-prompt capture cadence
- **codeflare-hooks**: Scripts for commit attribution blocking,
  git-push review reminders, and SDD review-agent enforcement.

Review dispatch is non-blocking: `code-reviewer` and `spec-reviewer`
spawn in parallel in the background (`run_in_background: true`), then
`doc-updater` follows `spec-reviewer` sequentially, also in the background.

In-flight suppression is per lane. A fresh in-flight lane is skipped
without masking other required lanes, while a stale uncompleted lane past
the transcript recency bound is demanded again.

The PostToolUse nudge and Stop hook share `scripts/lib/lane-classifier.sh`.
Generated-only `graphify-out/` diffs require no review lanes and are auto-acked
with a durable audit event; generated artifacts never suppress review for mixed
diffs. Doc-only pushes spawn only `doc-updater`; `sdd/`-only pushes spawn
`spec-reviewer` then `doc-updater`; source pushes spawn all three; non-SDD
projects fire no review agents.

Each tool-gated hook is registered on two matcher entries covering three
tool names: the `Bash` matcher (with `Bash(git *)` and `Bash(gh *)`
predicates) and the pipe-alternated MCP matcher
`mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute`.
This keeps attribution blocking and push detection effective whether
context-mode is active or not. Implements
[REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC3,
[REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions) AC1+AC2+AC8,
and [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) AC1+AC2+AC4-AC7.
Hooks registered in settings.json, scripts delivered via plugin.

## Third-party plugin: context-mode

[context-mode](https://github.com/mksglu/context-mode) is registered
as a Claude Code MCP server (`ctx_*` helper tools) where that runtime
enables it. Pi loads context-mode by default (in the settings `required` set);
`/ctx off` disables the package for the current running Pi session and reloads
resources, while `/ctx on` re-enables it, and the next Codeflare container start
resets Pi back to enabled. Durable PR-boundary review lanes inherit `/ctx on` only when
`spawnDurableLane` adds the settings-enabled context-mode package as an explicit
`-e` argument. With `/ctx on`, the lane can expose `ctx_search`; with it off,
the lane runs without ctx tools. `graphify-native.ts` and `review-lane-guards.ts`
are loaded separately.
The npm package is fetched by the user's own container from the npm
registry on first invocation; Codeflare does not redistribute the
source. Commercial users receive only the MCP server registration:
no skill, rule, hook, or system-prompt nudge in our preseed
instructs Claude to invoke `ctx_*` tools. The agent's tool-selection
is its own, identical to how it picks any other listed MCP tool.

Codeflare no longer ships the former Bash/WebFetch/Grep deny-gate
(`enforce-ctx-mode.sh`) in the context-mode plugin. Context-mode is
MCP/indexing only: agents may call the `ctx_*` tools when available, but
native Bash, WebFetch, and grep-class tools are not blocked by a
context-mode routing hook. Entrypoint reconciliation prunes stale copies
of the old deny-gate from managed hook settings so restored containers do
not retain obsolete hard-routing behavior.

context-mode is licensed under [Elastic License 2.0](https://github.com/mksglu/context-mode/blob/main/LICENSE).
The integration is sized to stay within ELv2's permitted-use envelope.
See [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) for the full design + license analysis.

## Graphify ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify))

### SessionStart context injection ([REQ-AGENT-024](../../sdd/spec/agents.md#req-agent-024-advanced-session-mode-graph-first-discipline) AC1)

In advanced session mode, `graphify-session-start.sh` injects structural context from the knowledge graph as `additionalContext` on session start. Three-tier fallback:

1. **Tier 1 (god-nodes):** If `graphify-out/graph.json` exists and `python3` is available, computes the 15 highest-degree nodes directly from the graph JSON and injects them with degree counts. The agent sees the architectural spine before its first tool call.
2. **Tier 2 (report preamble):** If the god-nodes query fails (e.g., empty graph), falls back to the first 80 lines of `GRAPH_REPORT.md`.
3. **Tier 3 (build suggestion):** If no graph exists but the cwd contains code files, injects a suggestion to build one via `/graphify`.

All tiers append tool guidance (pointing at `mcp__graphify__query_graph`, `mcp__graphify__get_node`, etc.). The hook never auto-builds a graph.

### Post-clone graph triage ([REQ-AGENT-025](../../sdd/spec/agents.md#req-agent-025-post-clone-graph-triage))

In advanced session mode, clone triage detects real `git clone` / `gh repo clone` operations and resolves the destination from the tool result (`Cloning into '...'`) before falling back to command parsing. If no repo graph exists, the agent asks the user which graph action to take before doing any graph work: Full repo AST-only, Full repo semantic, or no graph action. Claude's clone hook injects a directive that tells the agent to compare `graphify-out/graph.json` `built_at_commit` with `git rev-parse HEAD`; Pi performs that freshness comparison natively in its lifecycle extension. Fresh graphs produce an information message only. A stale graph (built at a commit other than `git HEAD`) makes the directive open with an explicit STALE warning before presenting choices; an unknown-freshness graph asks without the stale flag. Both offer existing-graph-as-is, Full repo AST-only update, or Full repo semantic refresh, and freshness plus on-disk existence are resolved at clone-event time via `exists`/`freshness` callbacks. The AST-only update uses the bounded upstream-update wrapper only after the user chooses it. Full semantic build/refresh records clone-time intent only: after corpus detection, the graphify skill must show actual uncached file/subagent counts and get confirmation before dispatching semantic subagents. Pi mirrors the same behavior through native lifecycle events and suppresses clone triage inside durable PR-boundary review lanes. Clone detection is scoped to shell-only command text — Bash `.command` fields, `ctx_execute` blocks with `language: "shell"`, and `ctx_batch_execute` `.commands[].command` entries; non-shell `ctx_execute` bodies are excluded so a source literal containing `git clone` cannot trigger the prompt. The detection regex also tolerates a leading env-var prefix (`BROWSER="" gh repo clone`, `GIT_TERMINAL_PROMPT=0 git clone`, `env BROWSER="" gh repo clone`).

### Pi native graphify tools ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) AC4-AC5)

Pi has no MCP client, so Codeflare exposes `graphify_query`, `graphify_path`,
and `graphify_explain` through `graphify-native.ts`. The extension shells the
same upstream `graphify` CLI used by Claude's MCP server and passes the resolved
`--graph` path explicitly.

Graph resolution is local-first: the cwd repo's `graphify-out/graph.json` wins,
then the active-repo sentinel's graph, then `~/.graphify/global-graph.json`.
Tool results include the graph path, scope, and repo cwd so the graphify skill
can save the answer back to the same graph. If no graph exists, the tools fail
soft with a build-graph hint. `codeflare-pi.ts` still owns active-repo context
and clone triage; it no longer acts as the primary query retry shim.

### Build model choice ([REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch))

The Claude `/graphify` skill and the dedicated Pi graphify skill both dispatch semantic-extraction subagents for non-code files (docs, papers, images) when the user chooses Full mode. The Pi skill deliberately avoids headless semantic extraction for uncached docs/images: subagents read chunks and write Graphify-schema JSON, Graphify's cache helpers persist those chunks, and local Graphify module flows merge/build/cluster/report output. Community names are written by the active agent session to `.graphify_labels.json`; Pi applies them by regenerating the final user-facing report/html from the graph's existing community assignments, never `graphify label` or provider backends. Pi's graph refresh menu offers Architecture graph, Full repo AST-only, Full repo semantic, and an explicit no-graph option. Architecture graph uses the local module-graph script to filter tests/docs/generated/config noise and project Graphify's symbol graph into file/module dependencies; full AST initial build uses the local first-build script built from Graphify's own modules; AST-only refresh uses the bounded upstream-update wrapper. Full semantic merge starts from a freshly recreated AST-only baseline and adds cached/new semantic chunks without passing those source files as `prune_sources`, because Graphify prunes after adding. Final `graphify-out/graph.html` and `graphify-out/callflow.html` are generated after labels are applied, and durable graph commits include both.

Model selection is runtime-specific. Claude Code's graphify skill pins its own reliable extraction model and never escalates to Opus from this workflow. Pi does not name or pin provider-specific models: Pi `Agent` semantic subagents omit a `model` override and inherit whatever model the main Pi session is using unless the user explicitly asks for a different model.

Subagents are dispatched in bounded waves to avoid flooding agent concurrency. Each wave runs in parallel; waves are sequential. Chunk count scales with the size of the non-code corpus.

### Git persistence ([REQ-AGENT-026](../../sdd/spec/agents.md#req-agent-026-knowledge-graph-persistence-via-git))

Graphify repo outputs persist in git when the user can push to the repository. The durable committed surface is:

- `graphify-out/graph.json` — queryable graph data, with `.gitattributes` wiring `graphify-out/graph.json merge=graphify`
- `graphify-out/GRAPH_REPORT.md` — human-readable graph report
- `graphify-out/graph.html` — interactive visualization, generated after `.graphify_labels.json` is applied so users see named communities
- optional `graphify-out/wiki/` if the user requests a wiki export

The Pi graphify skill mirrors the Claude skill's persistence rule: never blanket-ignore `graphify-out/`. Repo ignore rules must ignore only regenerable build outputs such as `graphify-out/cache/`, `graphify-out/.chunks/`, `graphify-out/manifest.json`, `graphify-out/.graphify_*`, and root `.graphify_*` intermediates. During `/sdd init`, a graph built for enrichment is still a repo artifact; the scaffold or same-turn graph commit must include the durable graph files and the ignore/merge wiring rather than leaving them as local-only files.

## /sdd init Modes

`/sdd init` is the single entry point for bootstrapping SDD on a project. It detects one of three scenarios from project state and dispatches automatically:

- **Greenfield** - empty project. Agent drafts vision / actors / domains / requirements from the user's prose and writes scaffolding.
- **Import** - substantive existing code, no `sdd/` yet. Two-output model: behavior clearly determinable from source / tests / comments / commits / PRs becomes official REQs in `sdd/{domain}.md`; everything unclear (magic numbers, retry policies, ambiguous contracts, orphan code) becomes triage entries in `sdd/.init-triage.md` with the agent's `**Context:**` (file:line, git author, commit refs, related tests/PRs) and `**Recommendation:**` (best-guess answer with one-line `**Rationale:**`) populated up front. Status default for CLEAR REQs honours `enforce_tdd`. Import Mode defaults `enforce_tdd: false` - CLEAR REQs whose source implements the AC land as `Status: Implemented` unconditionally (imported code predates REQ-ID test conventions; demoting everything to `Partial` would falsely brand the spec as incomplete). When `enforce_tdd: false`, each domain file receives a `_Verification: code-only (no automated coverage)._` footnote at the bottom; per-REQ `Notes:` fields are not used for this signal. Switch to `enforce_tdd: true` manually (in `sdd/config.yml`) once REQ-ID references have been added to test names.
- **Resume** - `sdd/` exists and `sdd/.init-triage.md` has at least one `**Status:** open` item. Agent surfaces one item at a time with refreshed Context. Five decisions: `accept` (use the recommendation as-is, fold into REQ), `correct` (free-form prose describing what the thing is for and how it works; agent folds purpose into Intent and behavior into ACs), `lost` (one-line Reason required, no spec write), `skip` (stays open, no spec write), `quit`. Only `accept` and `correct` promote anything into the official spec.

**Interaction flow.** Both Greenfield and Import Mode run as a lean two-confirm flow: the agent asks one vision question (or accepts inline `$ARGUMENTS`), drafts the entire spec in memory (actors, domains, design principles, REQs in canonical shape, CON-* constraints, founding ADRs, glossary terms), presents the full draft as one review surface, and applies edits in place until the user accepts. The 10-15-turn one-domain-at-a-time confirmation chain is not used.

**Enrichment pass.** After the draft is accepted, before any files are written, three passes run automatically in one in-memory cycle. All three query the project's `graphify-out/graph.json` for structural inputs; the post-clone PostToolUse hook ([REQ-AGENT-025](../../sdd/spec/agents.md#req-agent-025-post-clone-graph-triage)) prompts the user to build a graph immediately after `git clone`, so the graph is normally already in place by the time `/sdd init` runs:

- **Cross-link pass** - `mcp__graphify__get_neighbors` returns every node that shares an edge with a referenced REQ / CON / concept; every drafted REQ that names another REQ in its body also gains it in `Dependencies:` as an anchor link `[REQ-X-NNN](#req-x-nnn-title-slug)`.
- **ADR-seed pass** - `mcp__graphify__god_nodes(top_n=20)` returns the most-connected nodes (architectural pillars). 3-8 surviving candidates (tech stack, framework, deployment target, auth pattern, data store, key middleware) become founding ADRs in `documentation/decisions/README.md` with an index table and per-ADR sections. Candidates that fail the "What is NOT an ADR" test (no real alternative considered) are dropped.
- **Glossary-seed pass** - `mcp__graphify__query_graph` for concept-tagged nodes (graphify emits these with `source_file: null`); each becomes a one-line glossary entry in `sdd/glossary.md`. Synonym clusters land in `documentation/README.md`'s synonym glossary slot.

No additional user prompts during the enrichment cycle. When the graphify graph is missing at enrichment time (rare - the post-clone hook offered to build one), `/sdd init` prompts the user once for `/graphify cluster-only` (AST-only, free); on decline, enrichment falls back to an in-memory heuristic (literal-string matching across the draft) with a one-line notice in `sdd/changes.md` recording reduced cross-link density. The `mcp__graphify__*` MCP tools are tool-agnostic and work identically under both Bash and context-mode (`mcp__context-mode__ctx_*`) environments.

**Phase 7a - source-anchor truth-check (CRITICAL gate).** Before scaffold commit, `/sdd init` runs `verify-source-anchors.py` (`skills/sdd-init/references/verify-source-anchors.py`) against every `<!-- @impl: <path>::<symbol>[ = <value>] -->` anchor in the drafted `sdd/**/*.md` and `documentation/**/*.md`. The verifier resolves each anchor's path on disk, confirms word-bounded symbol presence in source, validates literal value patterns within the symbol's local region, counts malformed `@impl`-shaped comments, and counts unreadable files. It emits a JSON report to `.verify-anchors.json` with shape `{parsed, resolved, orphaned, drifted, malformed, unreadable, failures, malformed_entries, unreadable_entries, exit_code}` - the three detail arrays carry per-anchor failure context that CQ-SOURCE and Pass 15 consume. The `[sdd-init]` commit body MUST include the summary line verbatim: `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`. A non-zero exit blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`. Substituting an agent self-attestation, a sampled audit, or a structural sanity check for the verifier output is CRITICAL - five named failure modes: `phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`. All caught by the next PR-boundary review. Steady-state CQ-SOURCE and Pass 15 consume the same JSON when present rather than re-deriving.

**Phase 7b - enumeration-coverage verification (CRITICAL gate).** After Phase 7a and before iterate-to-clean, `/sdd init` runs `verify-enumeration-coverage.py` (`skills/sdd-init/references/verify-enumeration-coverage.py`) as the symmetric counterpart. Where Phase 7a verifies every claim the agent wrote is anchored, Phase 7b verifies the agent did not silently drop entire source files from the enumeration. The verifier walks the working tree (with `os.walk` in-place pruning to skip `node_modules`, `dist`, `.git`, `sdd/`, `documentation/`, etc.), identifies load-bearing source files via project-shape-agnostic heuristic (lives under `services/`, `handlers/`, `controllers/`, `providers/`, `models/`, `domain/`, `core/`, `commands/`, `usecases/`, `workers/` OR has >= 100 source lines), and checks each file's repo-relative path against (a) the `<path>` portion of every `@impl` anchor in the drafted spec + docs, AND (b) literal mentions in the layout-appropriate triage queue (nested: `sdd/spec/.init-triage.md` + `sdd/spec/.review-queue.md`; flat-layout legacy: `sdd/.init-triage.md` + `sdd/.review-needed.md`). Output JSON to `.phase-7b.json` with shape `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}`. The `[sdd-init]` step-10 commit body MUST include the summary line verbatim alongside Phase 7a's: `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1`. The two gates close the Validation-Equals-Generation gap: an Import-Mode agent using anchorability as the generation predicate ends up with a clean Phase 7a + an empty triage queue + a spec that elides every ambiguity. Phase 7b detects this. Failure modes (all CRITICAL): `phase-7b-self-attestation`, `phase-7b-incomplete-coverage`, `phase-7b-pipeline-inversion`, `phase-7b-evidence-missing`, `import-mode-narrowed-scope` (`unaccounted > 0` with an empty triage queue), `import-mode-empty-triage-implausible` (Phase 4 enumeration-review companion), `phase-4-enumeration-skipped`. Per-project waiver: `sdd/spec/.phase-7b-waiver.txt` (one repo-relative path per line, `#` comments allowed) excludes specific framework-boilerplate files from the coverage check; entries require a one-line justification. Phase 7b is advisory for greenfield (`enumerated=0` and `coverage_pct=100.0` are the expected outcome with no source on disk yet; the commit body line is still required so the audit-trail format stays uniform across modes). Implements [REQ-AGENT-035](../../sdd/spec/agents.md#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) AC2.

**Tool surface compatibility.** Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works under both Bash and the context-mode MCP tool family (`mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch_execute`, `mcp__context-mode__ctx_search`). Discovery commands that produce more than 20 lines of output (`gh pr list --state all`, `git log --follow`, `npm view <pkg> peerDependencies`, full-tree scans, scaffold-only `npm install --package-lock-only`) route through `ctx_execute` / `ctx_batch_execute` in context-mode environments and through Bash in plain environments.

While `sdd/.init-triage.md` contains any open items, `sdd/config.yml` carries `transition: true`. The transition gate condition is the conjunction `transition: true` in config AND `**Status:** open` items in the triage file (case-insensitive on `open`); all enforcement layers test both. During transition the entire review pipeline is suspended:

- PR-boundary hooks (`git-push-review-reminder` PostToolUse + `enforce-review-spawn` Stop) short-circuit to no-op so no reviewer spawns on push or PR events
- Manually-invoked review agents (code-reviewer, spec-reviewer, doc-updater) check the same gate and exit no-op with a one-line notice
- `/sdd mode unleashed` is rejected (judgment is required for triage; cannot run blind)

**Resume Mode** is always interactive regardless of `sdd/config.yml`'s `mode` setting. It refuses to start on a dirty working tree (same gate as `/sdd clean`). When `mode: auto` is active, a one-line suspension notice is printed at entry.

**Transition closure.** When the last open item is resolved or marked `lost`, the closure commit:
1. Clears `transition: true` from `sdd/config.yml`
2. Appends a closure entry to `sdd/changes.md` recording totals (accepted / corrected / lost)
3. The agent enters Plan Mode -- the first feature work on the now-real spec is plan-gated

`enforce_tdd` is NOT touched by the closure commit. The user changes it manually when ready for TDD enforcement (typically after adding REQ-ID references to test names in the imported source).

Full SDD discipline applies on the next push; autonomous agentic development is unlocked. `sdd/.init-triage.md` is preserved as the audit record. Implements [REQ-AGENT-033](../../sdd/spec/agents.md#req-agent-033-sdd-init-scaffolding-and-canonical-render) (`/sdd init` two-confirm flow + canonical render + review-queue pre-create), [REQ-AGENT-034](../../sdd/spec/agents.md#req-agent-034-sdd-init-enrichment-pass-with-graphify) (enrichment pass), [REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC2 (tool-surface portability), [REQ-AGENT-022](../../sdd/spec/agents.md#req-agent-022-legacy-codebase-import-mode-discovery) (Import Mode discovery), and [REQ-AGENT-045](../../sdd/spec/agents.md#req-agent-045-import-mode-triage-queue-and-transition-state) (triage + transition + status defaults).

**GitHub corpus degradation.** When Import Mode cannot reach GitHub (non-GitHub remote, `gh auth status` failure, rate-limited, air-gapped), discovery falls back to working-tree + git-log evidence only. A one-line notice naming the reason is appended to the `sdd/changes.md` import entry; triage Context fields reference whatever artifact refs are reachable.

## Troubleshooting

### Common Issues

- **Attribution blocking not working**: Check `~/.claude/settings.json` has `PreToolUse` hook entries pointing to `block-attributed-commits.sh` on two matcher entries covering three tool names: a `Bash` matcher (with `"if": "Bash(git *)"` and `"if": "Bash(gh *)"` predicates) AND a pipe-alternated MCP matcher `"matcher": "mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute"`. Verify the script exists at `~/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh`. If attribution appears via `gh pr create` in a context-mode session, the MCP matcher entry is missing - re-run the entrypoint or check the `SETTINGS_CONFIG` merge in `entrypoint.sh`.

- **Review-spawn enforcement not firing on push**: see [Resetting Review-Spawn Checkpoints](#resetting-review-spawn-checkpoints) below.

- **Default mode has hooks**: If `settings.json` has hook entries in default mode, the entrypoint `SESSION_MODE` gating may have failed. Remove them:
  `jq 'del(.hooks)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json`.

- **`/dev/fd/63: No such file or directory` from a custom hook**: a bash hook using process substitution (`done < <(...)`) is being invoked in a runner where `/proc/self/fd` is not available, so the kernel cannot resolve the `/dev/fd/<N>` symlink the shell created. Most codeflare hooks default to here-strings (`done <<< "$STR"`) for this reason: here-strings stage through a real temp file and work in every runner. The one documented exception is `enforce-review-spawn.sh`'s `compute_required_lanes` which uses process substitution `done < <(git diff -z ...)` because bash strips NUL bytes from command substitution captures and the `-z`/`read -d ''` pair needs the NUL delimiter preserved; this hook is container-runtime-aware. If you author a custom hook that hits the `/dev/fd/63` error in a different runner, switch the read loop's redirection to a here-string (and accept the NUL-stripping tradeoff if you also need `-z`).

- **Stop hook spawns all three review agents even on a doc-only push (partially-deployed install)**: `enforce-review-spawn.sh` and `git-push-review-reminder.sh` both source `scripts/lib/lane-classifier.sh` (path is relative to the hooks plugin root; in source it lives at `preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh`) to determine which lanes a diff requires. If the helper is missing or fails to source, both hooks fail-closed to the legacy all-three-lanes posture (`code-reviewer spec-reviewer doc-updater`) rather than skipping enforcement, so a partially-synced plugin set never disables review. To diagnose, check `ls ~/.claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh`; if absent, re-run `entrypoint.sh` or trigger a full R2 sync to restore the complete plugin payload.

### Resetting Review-Spawn Checkpoints

The Claude `Stop` hook (`enforce-review-spawn.sh`) only fires in advanced mode when `sdd/` and `sdd/README.md` are present. Its transcript-based trigger surface is `git push`, `gh pr merge`, and protected-base `gh pr edit --base main|master`; `git-push-review-reminder.sh` handles the in-turn `git push` / `gh pr create` / protected-base `gh pr edit` reminder path. Pi native enforcement covers the wider local command set (`git push`, `git -C <repo> push`, command-local `cd <repo>` prefixes separated by `&&`, semicolon, or newline, `gh pr create`, protected-base `gh pr edit`, `gh pr merge`, `gh pr update-branch`, and `gh repo sync`) and ignores metadata-only PR commands. Passive lifecycle events such as opening a repo, switching branches, reloading Pi, or ending a normal assistant turn do not create a review window solely because the current branch already has an open protected-base PR. All surfaces enforce only when the open PR targets `main` or `master`. PRs into intermediate branches (`develop`, `staging`) are silently deferred until that branch's own PR-to-`main` opens.

On Pi's boundary fast path, the push command's start-args are captured on BOTH the `tool_call` and `tool_execution_start` events (keyed by the same tool id), so a boundary push is still recovered at `tool_result` when `tool_execution_start` is lost across a Pi reload or turn boundary. This is a Pi-only mechanism; the Claude `Stop` hook is unaffected because it receives the completed command from the shell rather than from Pi's event sequencing. This closes a prior silent miss: when only `tool_execution_start` seeded the cache and that event dropped, the command arrived empty, was not recognised as a boundary, and `onToolEnd` returned without creating a review window or recording anything. If a successful `bash` result still arrives with no recoverable command, Pi now writes a deduped `boundary_tool_end_ignored` row with reason `missing_command_text_after_success` (distinct from the `no_resolvable_head` / `dedupe_skipped` reasons the confirmed-enforced near-miss path stamps under the same event name — see [REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-pr-boundary-review-reconciliation-and-missed-event-recovery) AC4 for those two reasons) to the repo's review-event log (`.git/codeflare-review-events.jsonl`) instead of returning silently, so the reconcile backstop remains the catch-all but the miss is diagnosable rather than invisible. Implements [REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions) AC8.

The Claude hook and Pi native enforcement both track the most recently acknowledged PR HEAD SHA in `.git/sdd-last-ack-pr-head`. Claude advances that checkpoint only after every required lane has a current-head Agent spawn with a `completed</status>` marker. A recent in-flight Claude lane suppresses re-summon noise only; it does not satisfy final acknowledgement.

Pi also persists compatibility pending state in `.git/sdd-review-pending.json` and durable runner state in `.git/codeflare-review-jobs/<head>/`. Without a user bypass, Pi acknowledgement advances only when result files exist for the full required pipeline (code-reviewer + spec-reviewer + doc-updater, or the reduced lane set for doc/spec-only changes) for the current PR HEAD.

When a new push lands while review is still in flight, Pi rolls the pending review window forward if the new PR head descends from the pending head, keeps the first unreviewed base for cumulative review, and does not treat a remote-tracking previous head as reviewed unless an explicit ack or completed prior review proves that coverage. This preserves earlier findings during fix-push cascades while keeping intermediate-branch PRs deferred until their PR-to-`main` review. See [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) for lane dispatch and in-flight gating, and [REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-pr-boundary-review-window-advancement) for review-window roll-forward semantics.

Three USER-ONLY bypass methods exist (the agent must never invoke these autonomously): the user runs `touch /tmp/review-bypass`, the user says "skip review" in a message, or the user waits for the 3-strike circuit breaker to clear after 3 blocks on the same un-acknowledged PR HEAD. The sentinel is one-shot, per-session, not committed, and auto-deleted on use. Runtime semantics differ intentionally: Claude treats the sentinel as a one-turn Stop-hook escape that does not advance `.git/sdd-last-ack-pr-head`, while Pi consumes it as an explicit acknowledgement of the current protected PR HEAD. Before consuming it, Pi checks pending-state freshness: stale pending state is discarded without using the sentinel, and an advanced pending window acknowledges the live PR head rather than the superseded pending head.

If enforcement fires spuriously after a legitimate pipeline completed and local `HEAD` is the current PR head, preserve the acknowledgement and clear only transient runtime state:

```bash
git rev-parse HEAD > .git/sdd-last-ack-pr-head
rm -f .git/sdd-review-block-count .git/sdd-review-pending.json
rm -rf .git/codeflare-review-jobs/$(git rev-parse HEAD)
```

The legacy v4 timestamp file `.git/sdd-last-ack-push` (if present from a prior install) is auto-deleted on the first v5 invocation, so no manual cleanup is needed for the v4 to v5 migration path.

To inspect enforcement state without reading `.git/` by hand, Pi exposes a read-only `/review-status` command ([REQ-AGENT-057](../../sdd/spec/agents.md#req-agent-057-pi-review-status-command), `review-command.ts`). It renders the canonical review state for the current repo's enforced head — PR / local / last-acked HEADs, per-lane status, overall verdict, summary readiness, autofix and circuit-breaker state, and the merge-gate verdict — followed by a short tail of the `.git/codeflare-review-events.jsonl` decision audit (every enforcement decision — boundary detected, review started, merge blocked, breaker opened — is appended there). The command never spawns a review, advances the ack, or mutates any enforcement state; it is purely diagnostic.

---

## Specification Coverage

- [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) - Preseed Configs Generated from Single Source of Truth
- [REQ-AGENT-007](../../sdd/spec/agents.md#req-agent-007-multi-agent-adaptation-pipeline) - Multi-Agent Adaptation Pipeline
- [REQ-AGENT-014](../../sdd/spec/agents.md#req-agent-014-manifest-driven-preseed-pipeline) - Manifest-Driven Preseed Pipeline
- [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release) - Auto-upgrade preseed on release
- [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review) - /review command for multi-perspective codebase review
- [REQ-AGENT-017](../../sdd/spec/agents.md#req-agent-017-bubblewrap-sandbox-for-codex) - Bubblewrap sandbox for Codex
- [REQ-AGENT-019](../../sdd/spec/agents.md#req-agent-019-branded-settings-ui) - Branded settings UI
- [REQ-AGENT-020](../../sdd/spec/agents.md#req-agent-020-llm-api-key-management-ui) - LLM API key management UI
- [REQ-AGENT-024](../../sdd/spec/agents.md#req-agent-024-advanced-session-mode-graph-first-discipline) - Advanced-Session-Mode Graph-First Discipline
- [REQ-AGENT-025](../../sdd/spec/agents.md#req-agent-025-post-clone-graph-triage) - Post-Clone Graph Triage
- [REQ-AGENT-026](../../sdd/spec/agents.md#req-agent-026-knowledge-graph-persistence-via-git) - Knowledge-Graph Persistence via Git
- [REQ-AGENT-027](../../sdd/spec/agents.md#req-agent-027-context-mode-interoperability) - Context-Mode Interoperability
- [REQ-AGENT-028](../../sdd/spec/agents.md#req-agent-028-deploy-credential-token-creation-ux) - Deploy Credential Token-Creation UX
- [REQ-AGENT-029](../../sdd/spec/agents.md#req-agent-029-deploy-credential-propagation-to-container) - Deploy Credential Propagation to Container
- [REQ-AGENT-030](../../sdd/spec/agents.md#req-agent-030-multi-agent-format-transforms) - Multi-Agent Format Transforms
- [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity) - consult-llm Key Isolation, Subscription Backend, and Multi-Agent Parity
- [REQ-AGENT-032](../../sdd/spec/agents.md#req-agent-032-starter-documentation-manually-recreatable-from-settings) - Starter Documentation Manually Recreatable from Settings
- [REQ-AGENT-037](../../sdd/spec/agents.md#req-agent-037-sdd-clean-rescue-and-autonomy-modes) - `/sdd clean` Rescue and Autonomy Modes
- [REQ-AGENT-038](../../sdd/spec/agents.md#req-agent-038-resume-mode-drain-workflow) - Resume Mode Drain Workflow
- [REQ-AGENT-039](../../sdd/spec/agents.md#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate) - `/sdd init` Phase 7b Enumeration-Coverage Verifier Gate
- [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) - PR-Boundary Lane Classification and Agent Dispatch
- [REQ-AGENT-041](../../sdd/spec/agents.md#req-agent-041-pr-boundary-review-bypass-surfaces) - PR-Boundary Review Bypass Surfaces
- [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) - Graphify Build Mode Dispatch
- [REQ-AGENT-044](../../sdd/spec/agents.md#req-agent-044-review-agent-discipline-enforcement) - Review-Agent Discipline Enforcement
- [REQ-AGENT-047](../../sdd/spec/agents.md#req-agent-047-resume-mode-closure-and-review-pipeline-gate) - Resume Mode closure and review-pipeline gate
- [REQ-AGENT-048](../../sdd/spec/agents.md#req-agent-048-audit-accumulator-surfaces) - Audit accumulator surfaces
- [REQ-AGENT-050](../../sdd/spec/agents.md#req-agent-050-pi-native-review-workflow-skill) - Pi-Native `/review` Workflow Skill
- [REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-durable-review-status-and-result-formatting) - Pi Durable Review Status and Result Formatting
- [REQ-AGENT-059](../../sdd/spec/agents.md#req-agent-059-pi-durable-review-fix-loop) - Pi Durable Review Fix Loop
- [REQ-AGENT-060](../../sdd/spec/agents.md#req-agent-060-pi-durable-review-lane-tool-surface) - Pi Durable Review Lane Tool Surface
- [REQ-AGENT-061](../../sdd/spec/agents.md#req-agent-061-pi-idle-durable-review-reaper) - Pi Idle Durable Review Reaper
- [REQ-AGENT-062](../../sdd/spec/agents.md#req-agent-062-pi-pr-boundary-review-result-delivery) - Pi PR-Boundary Review Result Delivery
- [REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-pr-boundary-review-window-advancement) - Pi PR-Boundary Review Window Advancement
- [REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-local-statusline-footer) - Pi Local Statusline Footer
- [REQ-AGENT-057](../../sdd/spec/agents.md#req-agent-057-pi-review-status-command) - Pi Review-Status Command
- [REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt) - Proactive memory injection on first prompt

---

## Related Documentation

- [Vault](vault.md#memory-capture-system) - Vault-based cross-session memory and the
  capture hook chain
- [Container](container.md#claude-code-integration) - Claude Code
  configuration
- [Container](container.md#pi-extension-npm-cache) - Pi extension npm
  warm-up
- [Storage & Sync](storage-and-sync.md) - R2 sync internals
- [Decisions](../decisions/README.md) - Architecture decisions
