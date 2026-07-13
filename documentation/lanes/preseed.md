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
| Cloudflare-stack, ship (+ refs), ci-monitoring, pr-workflow, deploy-credentials skills | Yes | Yes | Yes |
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

The Custom-tier column reflects the extra Claude Code delivery surface for users on the `unlimited` subscription tier in Advanced mode. Pi starts with context-mode **enabled** by default (its `ctx_*` tools and the bash-curl-redirect hook are active without `/ctx on`); the Codeflare Pi extension provides `/ctx status`, `/ctx on`, and `/ctx off` for per-session control. The next Codeflare container start resets Pi back to enabled. Neither `entrypoint.sh` nor the Pi-native `context-mode-runtime.ts` extension force-sets `CONTEXT_MODE_BRIDGE_IDLE_MS=0` at session start; context-mode's own foreground/subagent split (upstream `#868`) keeps the interactive bridge quiet on its own, while non-foreground/subagent bridge helpers keep the default idle reaper and self-release instead of accumulating ([REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC6).

The five Pi tool extensions are installed in the settings `required` set, so they load in every Pi session independently of the context-mode toggle. Every Pi skill treats `ctx_*` tools as optional: `/ctx off` switches review, SDD, web retrieval, and other workflows to their documented native `read`/`grep`/`bash`, `fetch_content`, or equivalent fallback without narrowing work. `@juicesharp/rpiv-advisor` adds the user-invoked `advisor` tool and user-only `/advisor` configuration command; Codeflare overrides the package's prompt guidance at startup so assistants must not call `advisor`, run `/advisor`, or suggest `/advisor` unless the user's current message explicitly asks for advisor. `pi-web-access` adds `web_search`/`fetch_content`; both authenticate through Pi's own model registry / zero-config Exa MCP, so neither needs a per-user API key.

`@juicesharp/rpiv-todo` remains pinned at 1.20.0 but receives Codeflare's temporary [AD100](../decisions/README.md#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) source override after npm install. The override mirrors the unreleased upstream session-isolation correction: task state is keyed by Pi session ID and context-free rendering stays bound to the foreground slot. The installer refuses any other package version. Its payload is present both in the image prewarm directory and in `.pi/agent/npm/rpiv-todo-session-isolation/`, so rebuilt containers and generated user seed converge on the same bytes ([REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation)).

`web_search` defaults to the `auto-summary` workflow via a preseeded, create-if-missing `~/.pi/web-search.json` (`{"workflow": "auto-summary"}`). A user who edits that file to opt back into the interactive `summary-review` workflow has their choice respected on later boots.

This is a deliberate workaround for an upstream `pi-web-access` bug: `openCuratorBrowser` references `sendCuratorFallbackUpdate` outside its declaring scope and crashes the whole `pi` process whenever the interactive browser-curator fallback tries to open a browser. The container is headless, so `auto-summary` is the only workflow that never reaches that path.

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC3/AC5; source: `entrypoint.sh::warm_pi_npm_dependencies` (tool extensions, AC3), `entrypoint.sh` main-execution web-search default block (AC5), `preseed/agents/pi/skills/advisor/SKILL.md`, and `preseed/agents/pi/package.json`.

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

**Skills** (each preseeded as `<name>/SKILL.md`): `cloudflare-stack`, `ship`
(+ reference files), `consult-llm`, `api-design`, `backend-patterns`,
`content-hash-cache-pattern`, `database-migrations`, `deployment-patterns`,
`frontend-patterns`, `iterative-retrieval`, `search-first`,
`spec-driven-development` (+ reference templates for `/sdd init` scaffolding),
`sdd-init`, `sdd-clean`, `vault-operations`, `vault-note-capture`, and `graphify`.
The SDD skill set covers the Import/Resume legacy-codebase transition below.

The SDD enforcement family is advanced-only: `spec-enforce` +
`spec-enforce-ac` + `spec-enforce-truth`, `doc-enforce` +
`doc-enforce-lanes` + `doc-enforce-shape` + `doc-enforce-truth`, and
`tdd-enforce`. The git-workflow family is `ci-monitoring`,
`git-review-pipeline` (advanced-only), `pr-workflow`, and `deploy-credentials`.

The design family (UI/frontend work) is `emil-design-eng` and
`design-taste-frontend` (prose-only, adapted to every agent), plus `impeccable`.
`impeccable` keeps its multi-command design skill and bundled offline/live detector
scripts. It is scoped to Claude + Pi only: Claude gets the vendored tree in
`~/.claude/skills/impeccable/`; Pi gets a dedicated copy under
`~/.pi/agent/skills/impeccable/` with paths re-pointed and `.mjs` scripts emitted
verbatim, so detector scripts are never mangled by Claude-to-Pi text adaptation.
The vendored Impeccable bundle is shadow-pinned by `bump-shadow-pins.yml`, which
checks `impeccable.style`, refreshes both agent copies, updates both manifests,
and regenerates the seed.

Skills are preseeded to `~/.claude/skills/<name>/SKILL.md` and adapted equivalents
for agents that support skills. `consult-llm` is scoped to Claude + Pi only. On
container start, `configure_consult_llm` keeps the skill and MCP server only when
at least one provider is usable (Codex login or `CODEFLARE_OPENAI_API_KEY` /
`CODEFLARE_GEMINI_API_KEY`); when no provider is usable, and in Enterprise Mode,
it removes the Claude/Pi skill directories so no agent sees a skill for a missing
MCP server. Its skill hard-gates use to explicit current user requests naming
external LLMs/GPT, ChatGPT, Gemini, or OpenAI; see [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)
and [REQ-AGENT-067](../../sdd/spec/agents.md#req-agent-067-consult-llm-invocation-and-model-selection-behavior).

Claude receives consult-llm through `~/.claude.json`; Pi receives it through
`~/.pi/agent/mcp.json` via the pi-mcp-adapter `mcp` proxy. The Pi entrypoint-owned
`consult-llm` server entry is replaced on each start with `lifecycle: "lazy"`,
removing the old always-on `keep-alive` / `directTools` fields while preserving
unrelated user MCP servers in the same file ([REQ-AGENT-069](../../sdd/spec/agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring)).

**Rules** (core environment rules in both modes; the rest advanced-only) ([REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode),
[REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session)):
core environment rules (`cloudflare-environment`, `no-local-builds`,
`git-workflow`) ship in both modes. Claude keeps the baseline `git-workflow` rule.
Pi gets its own native `preseed/agents/pi/rules/git-workflow.md` from the Pi manifest,
which delegates branched mechanics to `ci-monitoring`, `git-review-pipeline`,
`pr-workflow`, and `deploy-credentials`.

Pi's PR-boundary extension is the sole automatic dispatcher for review and CI ([AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent)). After an eligible Git action it emits one structured plan: wave 1 lists required reviewers, and wave 2 requests independent CI. The root launches wave 1 together, then immediately runs wave 2 exactly once without waiting:

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

No stdout means no action. Otherwise the root submits the resolver's request unchanged once through public `subagent`. The report-only `ci-monitor` remains independent from review acknowledgement and relies on the bounded script rather than an agent turn cap, preserving verbatim native output. Non-SDD repositories and default-mode sessions receive CI-only plans. An aborted task is relaunched only after a later plan or explicit request. Implements [REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring).

Pi review is session-scoped ([AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents)). Successful persisted boundaries produce a triggering root launch plan. With a valid acknowledgement, the plan and every counted reviewer prompt carry the exact acknowledged-to-current range; unmatched calls remain in flight until native terminal notification. A delayed notification can acknowledge its reviewed PR head after reload or newer unpublished local work only while GitHub still reports that same authoritative head.

Generated reviewer system prompts embed their canonical scope and enforcement skills, so reviewers build the lane packet without retrieving policy first. All three reviewers prefer direct context execution when context-mode is active and retain repository-rooted Bash as the non-indexed fallback. Both transports invoke the same packet CLI and consume its JSON in the same processing call; packets are never persisted or handed between calls. Standalone read, grep, Graphify, and indexed batch/global retrieval are unavailable to the lanes. The root waits for every report and alone changes the head.

Cross-lane packet inputs carry exact old/new hunk ranges. Reviewers resolve an anchored implementation symbol or named test block and follow it only when that range intersects a changed hunk; sharing a changed file is not direct invalidation. Reviewers consolidate deterministic checks, emit failures rather than successful manifests, and verify generated seed through canonical preseed plus one identity check. Context-mode and Bash preserve identical scope, evidence, and dispositions.

Claude CI monitoring remains on-demand ([REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy)): routine pushes do not start `ci-monitoring`; Claude invokes it only when the user asks or a deploy/merge gate needs a fresh CI result. When invoked, the Claude skill launches a detached temp-script monitor, prints `CI_MONITOR_STARTED head=<sha> pid=<pid> log=<path>`, requires a non-empty workflow/run fingerprint to stay stable across two polls before success, and writes terminal `CI_RESULT failure` / `CI_RESULT timeout` lines to that durable log on workflow failure or GitHub CLI access failure.

Monitoring and any other long-running wait/poll are background-only: no agent may
keep the main session busy with `tail -f`, `gh run watch`, blocking `ctx_execute`,
Bash loops, deploy-status waits, or foreground polling
([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring)). The discipline triad (`spec-discipline`, `documentation-discipline`,
`tdd-discipline`) is advanced-only and points to the SDD workflow status,
severity, and skill families.

`memory` is advanced-only and carries folded vault trigger/route content. It
references Claude-specific `mcp__graphify__*` tools and the vault hook system.
`vault-note-capture` is advanced-only and routes "take a note" phrases to the
`vault-note-capture` skill.

`graph-first` is advanced-only (graphify discipline,
[REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)).
`karpathy` is advanced-only (LLM coding-mistakes principles). `frontend-components`
is advanced-only and covers composable-UI standards: extract repeated structures,
separate content from components, and write behavioral tests only.

`engineering-constitution` is advanced-only. It carries the four engineering
mandates plus the work-continuity rule, plan gate, and done gate
([REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents)).
Work continuity queues new messages until the active concrete step reaches a safe
stopping point unless the user says to stop, pause, or reprioritize.

The stricter PR-boundary review push gate is present in default+advanced
`git-workflow` and repeated in advanced `engineering-constitution`, so generated
agent instructions receive it through [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) AC6 and advanced sessions also receive the constitution copy through [REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents). Source: `preseed/agents/claude/rules/git-workflow.md::Review push gate` and `preseed/agents/claude/rules/engineering-constitution.md::Review push gate`.
ECC-derived language rules in `{common,typescript,python,golang,swift}/` subdirs
are advanced-only. `common/coding-style.md` covers shared style; per-language
`security.md` files stand alone after `common/security.md` removal.

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
6. On first dashboard load after a release, the frontend compares the baked
   seed hash with the user's stored seed hash.
7. Bisync pulls from R2 to container config directories
   (`~/.claude/`, `~/.codex/`, `~/.gemini/` (Antigravity), `~/.copilot/`,
   `~/.config/opencode/`, `~/.pi/agent/`)

The release auto-upgrade check uses
`GET /api/sessions/batch-status?includePreseedCheck=true` to compare
`PRESEED_CONTENT_HASH` with `lastPreseedHash` in `UserPreferences` KV. If they
differ, the frontend fires `recreateAgentConfigs()` in the background. The "+ New
Session" button and stopped-session cards are disabled during the upgrade. On
completion, `lastPreseedHash` is updated. Failure is non-fatal; a page refresh
retries. Implements
[REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release).

**Manifest structure** (Claude configs plus Pi-native assets; exact counts live in the manifests, not here):
- `rules/`: core, common, and language-specific rule documents.
- `agents/`: advanced-only specialist agent definitions.
- `commands/`: advanced-only slash command definitions.
- `skills/`: default skills, advanced skills, design skills, and enforcement skill families.
- `plugins/`: marketplace, memory, vault, hooks, context-mode, and graphify plugin payloads.
- Pi-native runtime assets include package config and package lock.

The `rules/` tree includes core rules for both modes: cloudflare-environment,
no-local-builds, and git-workflow. Advanced mode adds memory, spec-discipline,
documentation-discipline, tdd-discipline, graph-first, karpathy,
frontend-components, engineering-constitution, and vault-note-capture. It also
includes common coding-style rules plus standalone language security rules for
TypeScript, Python, Go, and Swift.

The `agents/` tree is advanced-only: architect, build-error-resolver,
code-reviewer, deep-reviewer, doc-updater, memory-capture, refactor-cleaner,
security-reviewer, spec-reviewer, tdd-guide, and vault-extract.

The `commands/` tree is advanced-only: brainstorm, debug, deploy, review, and sdd.

The `skills/` tree includes cloudflare-stack, ship (+ refs), ci-monitoring,
pr-workflow, and deploy-credentials as default+advanced skills. Advanced skills
include consult-llm, api-design, backend-patterns, content-hash-cache-pattern,
database-migrations, deployment-patterns, frontend-patterns, iterative-retrieval,
search-first, spec-driven-development (+ reference templates for /sdd init
scaffolding), sdd-init, sdd-clean, vault-operations, vault-note-capture,
spec-enforce, spec-enforce-ac, spec-enforce-truth, doc-enforce,
doc-enforce-lanes, doc-enforce-shape, doc-enforce-truth, tdd-enforce,
git-review-pipeline, graphify, and browser-run + browser-e2e. Pi owns native
reviewer and spec/doc enforcement overrides; Claude retains its original agents
and enforcement skills.

The design skills are emil-design-eng and design-taste-frontend for all agents,
plus impeccable for Claude + Pi only. Impeccable ships the design skill and offline
detector in advanced mode; Pi gets a dedicated verbatim copy, not the
prose-transformed lane.

The `plugins/` tree includes known_marketplaces.json for default+advanced mode.
Advanced-only plugins are codeflare-memory (plugin.json, memory-capture.sh,
memory-capture-block.sh, memory-agent-prompt.md, prefilter-transcript.sh,
assert-iso-ts.sh, memory-context-inject.sh), codeflare-vault (plugin.json,
vault-monitor-hook.sh, vault-extract-prompt.md, merge-vault-graph.py), and
codeflare-hooks (plugin.json, block-attributed-commits.sh, block-local-builds.sh,
git-push-review-reminder.sh, enforce-review-spawn.sh).

The hooks plugin also carries `scripts/lib/gh-pr-state.sh`, the shared gh CLI
helper sourced by both PR-aware hooks, and `scripts/lib/lane-classifier.sh`, the
shared diff-classification helper sourced by both PR-aware hooks so the in-turn
nudge and the turn-end gate agree on which lanes a push requires. The advanced
context-mode plugin keeps only `README.md` for MCP/indexing registration and prunes
stale deny-gates. The graphify plugin includes plugin.json, README, and
graphify-mcp-lazy.py in default+advanced mode; advanced mode adds
graphify-active-repo.sh, graphify-session-start.sh, graphify-clone-prompt.sh,
graph-first-nudge.sh, safe-graphify-update.sh, and local-graphify-labels.sh.

Graphify tools ship as the native extension `extensions/graphify-native.ts` rather
than through the MCP adapter — a Pi-native first-class choice. Pi still consumes
MCP servers through the `pi-mcp-adapter`: it reaches `consult-llm` and
`chrome-devtools` through the `mcp` proxy, wired into `~/.pi/agent/mcp.json` by
`entrypoint.sh`.

Extension files deploy Pi-specific runtime behavior. `codeflare-commands.ts`
provides `/debug`, `/deploy`, and `/brainstorm`; `review-enforcement.ts` and
`review-helpers.ts` implement session-scoped PR-boundary review reminders and
transcript correlation; `startup-header.ts` replaces Pi's startup header; and
`local-statusline.ts` preserves extension status rows in default and advanced modes.

`browser-run.ts` plus pure `browser-run-helpers.ts` (advanced only) register native
`browser_markdown`, `browser_content`, and `browser_scrape` tools that call the
Cloudflare Browser Run REST Quick Actions. That cheap one-shot READ surface is
self-gated on `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Browser Run has two surfaces and both agents have both. The READ surface above is
Pi-native; Claude Code gets a sibling `browser-run` MCP server built from
`preseed/agents/claude/browser-run-mcp/` and registered in `~/.claude.json`. The
INTERACTIVE `chrome-devtools` surface supports navigate / click / screenshot /
viewport; Claude receives it as a registered MCP server, while Pi reaches it through
the `pi-mcp-adapter`. The `browser-run` skill for both agents frames the
cost/context decision: cheap markdown read first, interactive browser only when a
page must be driven.

`browser-e2e` for both agents drives the interactive surface to verify a deployed
app by judgment, including from a mobile viewport. Every file under
`preseed/agents/pi/extensions/` is loaded by the Pi extension scanner and must
export a default factory function. Pure helper modules such as
`browser-run-helpers.ts` and `graphify-helpers.ts` therefore export a no-op default
factory alongside their named exports, or Pi aborts startup with
`Extension does not export a valid factory function`.

Native skill overrides include graphify
([REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch)
AC7), `review`, `review-scope`, and the Pi spec/doc enforcement families.

Capture-contract prompts include `memory-agent-prompt.md` and
`vault-extract-prompt.md`.

Pi graphify scripts include `build-graphify-architecture.sh`,
`build-graphify-ast.sh`, `safe-graphify-update.sh`, and
`local-graphify-labels.sh`.

The generator maps each manifest key by directory prefix: `extensions/` to
`.pi/agent/extensions/`, `skills/` to `.pi/agent/skills/`, `rules/` to
`.pi/agent/rules/`, `scripts/` to `.pi/agent/scripts/`, `prompts/` to
`.pi/agent/prompts/`, and `agents/` to `.pi/agent/agents/`.

The `agents/` prefix maps both to `.pi/agent/agents/` for session-local overrides
for `@gotgenes/pi-subagents` and to `~/.pi/agent/agents/` for persistent user-level
overrides. Native Pi definitions include Explore plus the code, spec, and
documentation reviewers. Package files deploy under `.pi/agent/npm/`.

Pi-native review and CI assets are seeded with explicit ownership:

| Source file | Modes | Deployed path | Owner |
|---|---|---|---|
| `preseed/agents/pi/rules/git-workflow.md` | default, advanced | `~/.pi/agent/rules/git-workflow.md` | Root handling for extension-issued reviewer/CI launch plans |
| `preseed/agents/pi/skills/ci-monitoring/SKILL.md` | default, advanced | `~/.pi/agent/skills/ci-monitoring/SKILL.md` | CI launch contract |
| `preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs` | default, advanced | `~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs` | Request resolver and attached PR-check monitor |
| `preseed/agents/pi/agents/ci-monitor.md` | default, advanced | `~/.pi/agent/agents/ci-monitor.md` | Dedicated report-only CI subagent |
| `preseed/agents/pi/npm/rpiv-todo-session-isolation/*` | default, advanced | `~/.pi/agent/npm/rpiv-todo-session-isolation/` | Version-gated rpiv-todo 1.20.0 session-isolation override |
| `preseed/agents/pi/skills/pr-workflow/SKILL.md` | default, advanced | `~/.pi/agent/skills/pr-workflow/SKILL.md` | PR creation procedure |
| `preseed/agents/pi/skills/git-review-pipeline/SKILL.md` | advanced | `~/.pi/agent/skills/git-review-pipeline/SKILL.md` | Session-scoped review procedure |
| `preseed/agents/pi/rules/engineering-constitution.md` | advanced | `~/.pi/agent/rules/engineering-constitution.md` | Pi planning, TDD/SDD, and review gates |
| `preseed/agents/pi/skills/review-scope/SKILL.md` | advanced | `~/.pi/agent/skills/review-scope/SKILL.md` | Shared `diff`/`all` scope resolver |
| `preseed/agents/pi/skills/review-scope/scripts/build-review-packet.mjs` | advanced | `~/.pi/agent/skills/review-scope/scripts/build-review-packet.mjs` | Ancestry-validated lane file/hunk packet builder |
| `preseed/agents/pi/agents/{code-reviewer,spec-reviewer,doc-updater}.md` | advanced | `~/.pi/agent/agents/` | Native report-only review lanes |
| `preseed/agents/pi/extensions/review-tool-guard.ts` | advanced | `~/.pi/agent/extensions/review-tool-guard.ts` | Reviewer-only direct-execution intent stripping |
| `preseed/agents/pi/skills/{spec-enforce*,doc-enforce*}/SKILL.md` | advanced | `~/.pi/agent/skills/` | Native scoped SDD enforcement |
| `preseed/agents/pi/extensions/active-repo-memory.ts` | default, advanced | `~/.pi/agent/extensions/active-repo-memory.ts` | Shared foreground repository memory without loading advanced commands |
| `preseed/agents/pi/extensions/review-enforcement.ts` | default, advanced | `~/.pi/agent/extensions/review-enforcement.ts` | Ordered boundary launch plan, settled missing-wave follow-up, acknowledgement |
| `preseed/agents/pi/extensions/review-helpers.ts` | default, advanced | `~/.pi/agent/extensions/review-helpers.ts` | Command grammar, lane classification, transcript correlation |
| `preseed/agents/pi/extensions/review-scope.ts` | default, advanced | `~/.pi/agent/extensions/review-scope.ts` | Executable shared scope/work-set contract for commands and boundaries |

The Pi manifest is the exact mode map. `scripts/generate-agent-seed.mjs` materializes
it into the committed generated seed at `src/lib/agent-seed.generated.ts`. When a
native Pi path matches a transformed Claude path, the generator emits only the Pi
bytes for that target key and mode. Reviewer `@include-skill` directives are expanded
from the separately seeded canonical Pi skill documents into the generated reviewer
system prompts; the directives and skill files remain the hand-maintained sources.
The generated file is output, never a second ownership source.

`/review` remains separate from PR-boundary review: the command reviews a user-chosen
scope, while `review-enforcement.ts` handles supported root-session boundaries for
SDD PRs targeting `main`/`master`. Both use `review-scope`: PR-boundary review and
`/review --diff` inspect changed hunks plus direct invalidations; `/review --all`
and `/sdd clean --all` are exhaustive.

`/sdd init` and `/sdd clean` are root-session mutation workflows, not reviewer
invocations. The root keeps file and Git ownership; cleanup resolves the shared
scope, runs `spec-enforce` and then `doc-enforce` inline, and applies or pushes
mode-authorized changes itself. This remains true for `--unleashed`; report-only
PR-boundary reviewers are never spawned to mutate the project. This implements
[REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)
AC6 and [REQ-AGENT-037](../../sdd/spec/agents.md#req-agent-037-sdd-clean-rescue-and-autonomy-modes)
AC6.

At invocation, `/review` prefers the Git repository containing the command cwd,
including a linked worktree, then falls back to remembered active-repository state.
An executable resolver validates the root without changing valid path whitespace or
the process cwd, and the command dispatches nothing when neither source resolves. `/sdd clean` rejects invalid
scope flags and sends the resolved work-set contract. The active-repository extension
resolves shell `cd` and tool-level cwd context before boundary eligibility. It is seeded
in both modes, so default-mode CI plans do not depend on the advanced main extension.

For PR boundaries, required lanes are named only after GitHub's authoritative PR head
matches the pushed checkout; settled recovery retries during propagation. The root
launches reviewers together without inherited context, waits for every native terminal
notification, fixes legitimate findings, and alone commits or pushes. The acknowledged
full SHA is the checkpoint. A delayed terminal notification may acknowledge its reviewed
head after reload or newer unpublished work only while that head remains authoritative.
Unfinished or replaced work is requested again only by a later supported boundary.
This implements
[REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions),
[REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-native-review-result-correlation),
[REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window),
[REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery),
[REQ-AGENT-059](../../sdd/spec/agents.md#req-agent-059-pi-native-review-findings-handoff),
[REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-command-parsing),
[REQ-AGENT-071](../../sdd/spec/agents.md#req-agent-071-pr-boundary-review-agent-dispatch),
[REQ-AGENT-074](../../sdd/spec/agents.md#req-agent-074-pi-settled-review-handoff),
[REQ-AGENT-080](../../sdd/spec/agents.md#req-agent-080-unified-pi-pr-boundary-launch-plan),
[REQ-AGENT-082](../../sdd/spec/agents.md#req-agent-082-pi-review-range-selection),
[REQ-AGENT-083](../../sdd/spec/agents.md#req-agent-083-user-invoked-pi-review-repository-context),
[REQ-AGENT-084](../../sdd/spec/agents.md#req-agent-084-pi-reviewer-policy-preloading), and
[REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport),
following [AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents).

At startup, R2 sync excludes the three retired durable-review extension paths. The
managed-extension relay also removes local copies before Pi loads runtime code while
preserving user-added extensions
([REQ-STOR-017](../../sdd/spec/storage.md#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake)
AC6–AC7).

CI follows a distinct execution path inside the extension-issued launch plan. The
root invokes the plan's request resolver exactly once after reviewer calls and
submits its zero-or-one JSON request unchanged once. The dedicated agent runs one
attached monitor. Review acknowledgement has no CI condition, and interruption is
intentionally not recovered automatically. This implements
[REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring),
[REQ-AGENT-080](../../sdd/spec/agents.md#req-agent-080-unified-pi-pr-boundary-launch-plan), and
[AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent).

  Pi memory capture is driven by two deployed contracts:
  `prompts/memory-agent-prompt.md` (the capture-agent contract) and
  `prompts/vault-extract-prompt.md` (the Vault-graph extraction contract). They
  carry the full [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)-grade
  capture instructions.

  `memory-vault.ts` reads those prompts from `~/.pi/agent/prompts/*.md`, reads
  the conversation from Pi's durable on-disk session transcript for `/resume`,
  counts only Claude-compatible real user prompts, and prefilters to
  user/assistant text before spawning capture at `delta >= 15`
  ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages)).
  Empty resolved transcripts skip capture instead of writing hollow notes.

  The pending `.vars` carrier stays on disk while memory-capture runs, so Pi
  does not spawn duplicates. The subagent writes the prompt counter only after
  the Vault note exists, then clears `.vars`; stale `.vars` markers self-clear
  after the pending TTL so stopped captures retry instead of skipping a window.
  Implements [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC5-AC6; source: `preseed/agents/pi/extensions/memory-vault.ts::memoryVarsPending`, `preseed/agents/pi/extensions/memory-vault.ts::captureVars`, and `preseed/agents/pi/prompts/memory-agent-prompt.md::Advance the counter and clear the pending marker`.

  A missing `/tmp` counter with more than one real user prompt force-fires
  resumed-session capture, matching Claude. Vault indexing uses the shared
  content-hash manifest (`graphify-out/vault-extract-manifest.json`) as its
  high-water mark
  ([REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session), [REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest))
  and excludes `Raw/Sessions/`, `graphify-out/`, `.silverbullet/`, and the four
  preseed root pages, so it only runs after user-curated Vault changes.

  Pi subagents are provided by `@gotgenes/pi-subagents`; the generator adapts
  Claude agent definitions into `.pi/agent/agents/*.md`. The container image
  preinstalls Pi extension npm dependencies into an image-local cache, and
  entrypoint copies that cache into `~/.pi/agent/npm` after R2 restore.

## Multi-Agent Preseed

The generator produces adapted config files for all supported agents
from CC's preseed as the default source of truth. Pi-specific runtime contracts
that must differ from Claude, such as `git-workflow` and `ci-monitoring`, live as
native Pi manifest entries instead of transformed Claude files.

Shared operational rules in `preseed/agents/claude/rules/engineering-constitution.md`
fan out through `scripts/generate-agent-seed.mjs` to every agent instruction surface.
The review push gate is sourced from that constitution: do not push while a PR-boundary review is running, pending, missing, stale, or otherwise incomplete for the current head unless the user explicitly authorizes it. Implements
[REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)
AC7 and [REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents).

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

**What each agent gets:** Claude Code and Pi both receive the full capability set.
Claude Code uses its native rules/agents/commands/skills/hooks/plugins. Pi uses
adapted rules/skills/agents plus native TypeScript extensions that reimplement the
CC-only surfaces: slash commands, hooks, memory capture, and review enforcement.

Codex, Copilot, OpenCode, and Antigravity receive a reduced, runtime-appropriate
subset: adapted rules and, where the runtime supports them, skills and agents. They
receive none of the CC-only surfaces.

Antigravity (`agy`) is seeded into the Gemini CLI global config tree (`~/.gemini/`),
which it reads natively. The `.gemini` -> `.agents` rename in Antigravity applies
only to per-workspace config, not the home directory codeflare seeds. The exact
per-agent document counts are emitted by `scripts/generate-agent-seed.mjs` from
`manifest.json` - read the generated output, not a hardcoded total here.

**Excluded from non-CC transformed assets**: hooks (CC hook system), commands
(CC slash commands), plugins (CC plugin system, including codeflare-memory and
codeflare-vault), and `preseed/agents/claude/rules/memory.md`.

The memory rule references CC-specific `mcp__graphify__*` tools and the vault hook
system. The vault trigger/route content lives in that preseed rule as folded
subsections, not a separate rules/vault.md.

`preseed/agents/claude/rules/git-workflow.md` is excluded for Pi only; Pi gets
`preseed/agents/pi/rules/git-workflow.md` instead. The `consult-llm` skill depends
on the consult-llm MCP tool, so it is excluded from the codex/opencode/antigravity
transform lane. Pi still gets a native `consult-llm` skill + MCP server via
`~/.pi/agent/mcp.json`, see
[REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity).

Pi receives native TypeScript extensions for runtime behaviors that cannot be
represented as transformed prose: `/sdd`, `/graphify`, `/vault`, `/note`, `/debug`,
`/deploy`, `/brainstorm`, graphify active-repo/global-graph maintenance and clone
triage, automatic memory capture, Vault graph extraction/global-graph merge,
local-build blocking, and AI-attribution blocking.

Graphify build/update runbooks for both Claude and Pi pass the scanned repo root to
Graphify's manifest writer, keeping `graphify-out/manifest.json` portable after a
repo move. Pi receives a dedicated native graphify skill that uses local AST
extraction plus Pi `Agent` subagents instead of the Claude/MCP-specific transformed
skill.

The Pi runtime also registers first-party native `graphify_query` /
`graphify_path` / `graphify_explain` tools through `graphify-native.ts`. Each query
shells the upstream Graphify CLI and resolves the cwd repo graph first, then the
active-repo sentinel graph, then the merged global graph. The active repo identity
injected into Pi context includes repository basename, checked-out branch, and HEAD
prefix. Pi receives a separate `review-command.ts` for the user-invoked `/review`
UX and `review-enforcement.ts` for PR-boundary review enforcement.

**Adaptation pipeline**: For each non-CC agent, the generator concatenates
applicable rules into a single instructions file, remaps tool names in agent
definition frontmatter, removes the `model` field for runtimes that do not support
it while preserving Pi subagent model pins, replaces `~/.claude/` path references
with agent-specific config paths, and uses correct file extensions such as
`.agent.md` for Copilot agents.

Pi additionally loads `preseed/agents/pi/manifest.json`, emits native runtime files
to `.pi/agent/extensions/`, `.pi/agent/scripts/`, `.pi/agent/npm/package.json`,
`.pi/agent/npm/package-lock.json`, and manifest-declared `.pi/agent/npm/` patch payloads, emits capture-contract prompts to
`.pi/agent/prompts/`, emits native Pi skill overrides under `~/.pi/agent/skills/`,
and emits native Pi agent overrides under `~/.pi/agent/agents/`.

Pi adapts Claude agent definitions into `.pi/agent/agents/*.md` for
`@gotgenes/pi-subagents`. Pi's generated agent frontmatter and body text use
Pi-native tool names: Graphify MCP references become `graphify_query` /
`graphify_path` / `graphify_explain`, and context-mode MCP references become
`ctx_*` tool names so subagents never try unavailable Claude MCP tools.

Pi PR-boundary reviewers use the public `subagent` tool and the adapted
`.pi/agent/agents/*.md` definitions. The root main session launches every requested
lane together in the background without inherited context; reviewers report only,
and the root session alone applies changes or pushes.

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

`memory-context-inject.sh` fires on the first prompt of each session: extracts
keywords, queries the unified graphify graph, and injects matched nodes as
additionalContext before the agent responds
([REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt)).
`memory-capture.sh` handles the ongoing 15-prompt capture cadence.
- **codeflare-hooks**: Scripts for commit attribution blocking,
  git-push review reminders, and SDD review-agent enforcement.

Claude review dispatch is non-blocking: required code, spec, and documentation
lanes spawn independently. Its Stop hook waits for every required lane's transcript
completion; no lane depends on another lane's transcript. Claude in-flight
suppression remains per lane, so a fresh in-flight lane does not mask missing peers.

Each Claude PR reviewer exposes only `Skill`, Bash, and direct
`mcp__context-mode__ctx_execute`. Indexed/global retrieval, Graphify, external
consultation, and file mutation are unavailable. Reviewers return complete structured
reports; the root persists triage content and applies fixes. `/review` follows the
same ownership boundary: the root writes returned phase reports and owns external
verification, triage history, ADR updates, and issue creation. This implements
[REQ-AGENT-086](../../sdd/spec/agents.md#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff).

The PostToolUse nudge and Stop hook share `scripts/lib/lane-classifier.sh`.
Generated-only `graphify-out/` diffs require no review lanes and are auto-acked
with a durable audit event; generated artifacts never suppress review for mixed
diffs. Doc-only pushes spawn only `doc-updater`; `sdd/`-only pushes spawn
`spec-reviewer` and `doc-updater` in parallel; source pushes spawn all three; non-SDD
projects fire no review agents.

Each tool-gated hook is registered on two matcher entries covering three
tool names: the `Bash` matcher (with `Bash(git *)` and `Bash(gh *)`
predicates) and the pipe-alternated MCP matcher
`mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute`.
This keeps attribution blocking and push detection effective whether
context-mode is active or not. Implements
[REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC3 and
[REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) AC1+AC2+AC4-AC7.
Hooks registered in settings.json, scripts delivered via plugin.

## Third-party plugin: context-mode

[context-mode](https://github.com/mksglu/context-mode) is registered as a Claude Code MCP server (`ctx_*` helper tools) where that runtime enables it. Pi loads context-mode by default in the settings `required` set. `/ctx off` disables the package for the current running Pi session and reloads resources; `/ctx on` re-enables it. The next Codeflare container start resets Pi back to enabled.

The npm package is fetched by the user's own container from the npm registry on first invocation; Codeflare does not redistribute the source. Commercial users receive the MCP registration. Claude's three PR reviewer definitions may call direct `ctx_execute` for compact, non-indexed evidence and retain Bash fallback; other tool selection remains agent-controlled.

Codeflare no longer ships the former Bash/WebFetch/Grep deny-gate
(`enforce-ctx-mode.sh`) in the context-mode plugin. Context-mode is
MCP/indexing only: agents may call the `ctx_*` tools when available, but
every seeded Pi skill names an equivalent non-context fallback and remains
fully operable after `/ctx off`. Native Bash, WebFetch, and grep-class tools
are not blocked by a context-mode routing hook. Entrypoint reconciliation prunes stale copies
of the old deny-gate from managed hook settings so restored containers do
not retain obsolete hard-routing behavior.

context-mode's npm update-check probe (`registry.npmjs.org/context-mode/latest`)
is neutralized at image-build time in both installs it loads from:

- The Claude global install, resolved via `npm root -g`.
- The Pi runtime's prewarmed copy at `/opt/codeflare/pi-agent/npm/node_modules/context-mode`.

Pi loads that prewarm tree as `npm:context-mode@<ver>` through a runtime symlink.
`scripts/patch-context-mode-bundles.mjs` repoints the probe URL to a refused
local address in both bundles. The version resolves to `"unknown"`, no "Update
available ... ctx_upgrade" notice renders, and no outbound npm registry traffic
is generated.

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC4.

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

In advanced session mode, clone triage detects real `git clone` / `gh repo clone` operations and resolves the destination from the tool result (`Cloning into '...'`) before falling back to command parsing.

If no repo graph exists, the agent asks the user which graph action to take before doing graph work: Full repo AST-only, Full repo semantic, or no graph action.

Claude's clone hook injects a directive that tells the agent to compare `graphify-out/graph.json` `built_at_commit` with `git rev-parse HEAD`. Pi performs that freshness comparison natively in its lifecycle extension.

Fresh graphs produce an information message only. A stale graph opens with an explicit STALE warning before presenting choices; an unknown-freshness graph asks without the stale flag. Both offer existing-graph-as-is, Full repo AST-only update, or Full repo semantic refresh.

Freshness plus on-disk existence are resolved at clone-event time via `exists`/`freshness` callbacks. The AST-only update uses the bounded upstream-update wrapper only after the user chooses it.

Full semantic build/refresh records clone-time intent only: after corpus detection, the graphify skill must show actual uncached file/subagent counts and get confirmation before dispatching semantic subagents. Pi mirrors the same behavior through native lifecycle events and suppresses clone triage inside durable PR-boundary review lanes.

Clone detection is scoped to shell-only command text: Bash `.command` fields, `ctx_execute` blocks with `language: "shell"`, and `ctx_batch_execute` `.commands[].command` entries. Non-shell `ctx_execute` bodies are excluded so a source literal containing `git clone` cannot trigger the prompt.

The detection regex also tolerates a leading env-var prefix (`BROWSER="" gh repo clone`, `GIT_TERMINAL_PROMPT=0 git clone`, `env BROWSER="" gh repo clone`).

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

The Claude `/graphify` skill and the dedicated Pi graphify skill both dispatch
semantic-extraction subagents for non-code files when the user chooses Full mode.
That includes docs, papers, and images.

The Pi skill deliberately avoids headless semantic extraction for uncached
docs/images:

- Subagents read chunks and write Graphify-schema JSON.
- Graphify's cache helpers persist those chunks.
- Local Graphify module flows merge, build, cluster, and report output.

Community names are written by the active agent session to `.graphify_labels.json`.
Pi applies them by regenerating the final user-facing report/html from the graph's
existing community assignments, never `graphify label` or provider backends.

Pi's graph refresh menu offers Architecture graph, Full repo AST-only, Full repo
semantic, and an explicit no-graph option.

- Architecture graph uses the local module-graph script to filter tests, docs,
  generated files, and config noise, then projects Graphify's symbol graph into
  file/module dependencies.
- Full AST initial build uses the local first-build script built from Graphify's
  own modules.
- AST-only refresh uses the bounded upstream-update wrapper.
- Full semantic merge starts from a freshly recreated AST-only baseline and adds
  cached/new semantic chunks without passing those source files as `prune_sources`,
  because Graphify prunes after adding.

Pi's local build/merge wrappers pass the scanned repo root into Graphify's manifest
writer, so `graphify-out/manifest.json` stays portable if a repo is moved or
recloned. Final `graphify-out/graph.html` and `graphify-out/callflow.html` are
generated after labels are applied, and durable graph commits include both.

Model selection is runtime-specific. Claude Code's graphify skill pins its own reliable extraction model and never escalates to Opus from this workflow. Pi does not name or pin provider-specific models: Pi `Agent` semantic subagents omit a `model` override and inherit whatever model the main Pi session is using unless the user explicitly asks for a different model.

Subagents are dispatched in bounded waves to avoid flooding agent concurrency. Each wave runs in parallel; waves are sequential. Chunk count scales with the size of the non-code corpus.

### Git persistence ([REQ-AGENT-026](../../sdd/spec/agents.md#req-agent-026-knowledge-graph-persistence-via-git))

Graphify repo outputs persist in git when the user can push to the repository.
The durable committed surface is:

- `graphify-out/graph.json` — queryable graph data, with `.gitattributes` wiring `graphify-out/graph.json merge=graphify`
- `graphify-out/GRAPH_REPORT.md` — human-readable graph report
- `graphify-out/graph.html` — interactive visualization, generated after `.graphify_labels.json` is applied so users see named communities
- optional `graphify-out/wiki/` if the user requests a wiki export

The Pi graphify skill mirrors the Claude skill's persistence rule: never
blanket-ignore `graphify-out/`.

Repo ignore rules must ignore only regenerable build outputs:

- `graphify-out/cache/`
- `graphify-out/.chunks/`
- `graphify-out/manifest.json`
- `graphify-out/.graphify_*`
- root `.graphify_*` intermediates

During `/sdd init`, a graph built for enrichment is still a repo artifact. The
scaffold or same-turn graph commit must include the durable graph files and the
ignore/merge wiring rather than leaving them as local-only files.

## /sdd init Modes

`/sdd init` is the single entry point for bootstrapping SDD on a project. It detects one of three scenarios from project state and dispatches automatically:

- **Greenfield** - empty project. Agent drafts vision / actors / domains / requirements from the user's prose and writes scaffolding.
- **Import** - substantive existing code, no `sdd/` yet; uses a two-output model.
  - Clearly determinable behavior from source, tests, comments, commits, or PRs becomes official REQs in `sdd/{domain}.md`.
  - Unclear behavior becomes triage entries in `sdd/.init-triage.md`.

  Examples include magic numbers, retry policies, ambiguous contracts, and orphan code.
  Each triage entry carries `**Context:**` (file:line, git author, commit refs, related tests/PRs) and a populated `**Recommendation:**`: the best-guess answer with a one-line `**Rationale:**`, up front.
  - Status defaults for CLEAR REQs honour `enforce_tdd`.
  - Import Mode defaults `enforce_tdd: false`; CLEAR REQs whose source implements the AC land as `Status: Implemented` unconditionally.
  - The code-only default avoids demoting everything to `Partial` only because imported code predates REQ-ID test conventions.
  - When `enforce_tdd: false`, each domain file receives a `_Verification: code-only (no automated coverage)._` footnote; per-REQ `Notes:` fields do not carry this signal.
  - Switch to `enforce_tdd: true` manually in `sdd/config.yml` once REQ-ID references have been added to test names.
- **Resume** - `sdd/` exists and `sdd/.init-triage.md` has at least one `**Status:** open` item.
  - The agent surfaces one item at a time with refreshed Context.
  - Five decisions are available: `accept`, `correct`, `lost`, `skip`, and `quit`.
  - `accept` uses the recommendation as-is and folds it into a REQ.
  - `correct` takes free-form prose describing purpose and behavior; the agent folds purpose into Intent and behavior into ACs.
  - `lost` requires a one-line Reason and writes no spec.
  - `skip` leaves the item open and writes no spec.
  - Only `accept` and `correct` promote anything into the official spec.

**Interaction flow.** Both Greenfield and Import Mode run as a lean two-confirm
flow. The agent asks one vision question or accepts inline `$ARGUMENTS`, then
drafts the entire spec in memory.

That draft includes actors, domains, design principles, REQs in canonical shape,
CON-* constraints, founding ADRs, and glossary terms. The agent presents the full
draft as one review surface and applies edits in place until the user accepts.
The 10-15-turn one-domain-at-a-time confirmation chain is not used.

**Enrichment pass.** After the draft is accepted, before any files are written,
three passes run automatically in one in-memory cycle. All three query the
project's `graphify-out/graph.json` for structural inputs.

The post-clone PostToolUse hook ([REQ-AGENT-025](../../sdd/spec/agents.md#req-agent-025-post-clone-graph-triage))
prompts the user to build a graph immediately after `git clone`. The graph is
therefore normally already in place by the time `/sdd init` runs:

- **Cross-link pass** - `mcp__graphify__get_neighbors` returns every node that shares an edge with a referenced REQ, CON, or concept.
  - Every drafted REQ that names another REQ in its body also gains it in `Dependencies:` as a linked `REQ-X-NNN` heading anchor.
- **ADR-seed pass** - `mcp__graphify__god_nodes(top_n=20)` returns the most-connected nodes (architectural pillars).
  - 3-8 surviving candidates become founding ADRs in `documentation/decisions/README.md` with an index table and per-ADR sections.
  - Candidate types include tech stack, framework, deployment target, auth pattern, data store, and key middleware.
  - Candidates that fail the "What is NOT an ADR" test (no real alternative considered) are dropped.
- **Glossary-seed pass** - `mcp__graphify__query_graph` for concept-tagged nodes (graphify emits these with `source_file: null`); each becomes a one-line glossary entry in `sdd/glossary.md`. Synonym clusters land in `documentation/README.md`'s synonym glossary slot.

No additional user prompts during the enrichment cycle. When the graphify graph is missing at enrichment time (rare - the post-clone hook offered to build one), `/sdd init` prompts the user once for `/graphify cluster-only` (AST-only, free); on decline, enrichment falls back to an in-memory heuristic (literal-string matching across the draft) with a one-line notice in `sdd/changes.md` recording reduced cross-link density. The `mcp__graphify__*` MCP tools are tool-agnostic and work identically under both Bash and context-mode (`mcp__context-mode__ctx_*`) environments.

**Phase 7a - source-anchor truth-check (CRITICAL gate).** Before scaffold commit, `/sdd init` runs `verify-source-anchors.py` (`skills/sdd-init/references/verify-source-anchors.py`) against every `<!-- @impl: <path>::<symbol>[ = <value>] -->` anchor in drafted `sdd/**/*.md` and `documentation/**/*.md`.

The verifier resolves each anchor's path on disk, confirms word-bounded symbol presence in source, validates literal value patterns within the symbol's local region, counts malformed `@impl`-shaped comments, and counts unreadable files.

It emits `.verify-anchors.json` with shape `{parsed, resolved, orphaned, drifted, malformed, unreadable, failures, malformed_entries, unreadable_entries, exit_code}`. The three detail arrays carry per-anchor failure context that CQ-SOURCE and Pass 15 consume.

The `[sdd-init]` commit body MUST include this summary line verbatim: `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`.

A non-zero exit blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`. Substituting self-attestation, a sampled audit, or a structural sanity check for verifier output is CRITICAL. Named failure modes: `phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`.

The next PR-boundary review catches those failures. Steady-state CQ-SOURCE and Pass 15 consume the same JSON when present rather than re-deriving.

**Phase 7b - enumeration-coverage verification (CRITICAL gate).** After Phase 7a and before iterate-to-clean, `/sdd init` runs `verify-enumeration-coverage.py` (`skills/sdd-init/references/verify-enumeration-coverage.py`) as the symmetric counterpart.

Where Phase 7a verifies every claim the agent wrote is anchored, Phase 7b verifies the agent did not silently drop entire source files from the enumeration.

The verifier walks the working tree with `os.walk` in-place pruning for `node_modules`, `dist`, `.git`, `sdd/`, `documentation/`, and similar directories. It identifies load-bearing source files by project-shape-agnostic heuristic: files under `services/`, `handlers/`, `controllers/`, `providers/`, `models/`, `domain/`, `core/`, `commands/`, `usecases/`, or `workers/`, plus files with at least 100 source lines.

Each file's repo-relative path is checked against the `<path>` portion of every `@impl` anchor in the drafted spec/docs and against literal mentions in the layout-appropriate triage queue. Nested layout uses `sdd/spec/.init-triage.md` + `sdd/spec/.review-queue.md`; flat-layout legacy uses `sdd/.init-triage.md` + `sdd/.review-needed.md`.

Output goes to `.phase-7b.json` with shape `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}`.

The `[sdd-init]` step-10 commit body MUST include this summary line beside Phase 7a's: `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1`.

The two gates close the Validation-Equals-Generation gap: an Import-Mode agent using anchorability as the generation predicate can produce a clean Phase 7a, an empty triage queue, and a spec that elides every ambiguity. Phase 7b detects this.

Failure modes are CRITICAL: `phase-7b-self-attestation`, `phase-7b-incomplete-coverage`, `phase-7b-pipeline-inversion`, `phase-7b-evidence-missing`, `import-mode-narrowed-scope`, `import-mode-empty-triage-implausible` (Phase 4 enumeration-review companion), and `phase-4-enumeration-skipped`.

Per-project waiver: `sdd/spec/.phase-7b-waiver.txt` excludes specific framework-boilerplate files from the coverage check. Use one repo-relative path per line; `#` comments are allowed and entries require a one-line justification.

Phase 7b is advisory for greenfield. `enumerated=0` and `coverage_pct=100.0` are the expected outcome with no source on disk yet, but the commit body line is still required so the audit-trail format stays uniform. Implements [REQ-AGENT-035](../../sdd/spec/agents.md#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) AC2.

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

- **Attribution blocking not working**:
  - Check `~/.claude/settings.json` has `PreToolUse` hook entries pointing to `block-attributed-commits.sh`.
  - Confirm two matcher entries cover three tool names: a `Bash` matcher and a pipe-alternated MCP matcher.
  - The `Bash` matcher uses `"if": "Bash(git *)"` and `"if": "Bash(gh *)"` predicates.
  - The MCP matcher is `"matcher": "mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute"`.
  - Verify the script exists at `~/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh`.
  - If attribution appears via `gh pr create` in a context-mode session, re-run the entrypoint or check the `SETTINGS_CONFIG` merge in `entrypoint.sh`.

- **Review-spawn enforcement not firing on push**: see [Resetting Review-Spawn Checkpoints](#resetting-review-spawn-checkpoints) below.

- **Default mode has hooks**: If `settings.json` has hook entries in default mode, the entrypoint `SESSION_MODE` gating may have failed. Remove them:
  `jq 'del(.hooks)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json`.

- **`/dev/fd/63: No such file or directory` from a custom hook**:
  - A bash hook using process substitution (`done < <(...)`) is running where `/proc/self/fd` is unavailable.
  - The kernel cannot resolve the `/dev/fd/<N>` symlink the shell created.
  - Most codeflare hooks default to here-strings (`done <<< "$STR"`) because they stage through a real temp file and work in every runner.
  - The documented exception is `enforce-review-spawn.sh`'s `compute_required_lanes`, which uses `done < <(git diff -z ...)`.
  - That exception preserves the NUL delimiter needed by the `-z`/`read -d ''` pair, because bash strips NUL bytes from command substitution captures.
  - If a custom hook hits this error in another runner, switch the read loop to a here-string and accept the NUL-stripping tradeoff if you also need `-z`.

- **Stop hook spawns all three review agents even on a doc-only push (partially-deployed install)**:
  - `enforce-review-spawn.sh` and `git-push-review-reminder.sh` both source `scripts/lib/lane-classifier.sh`.
  - The path is relative to the hooks plugin root.
  - In source it lives at `preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh`.
  - The helper determines which lanes a diff requires.
  - If the helper is missing or fails to source, both hooks fail-closed to the legacy all-three-lanes posture: `code-reviewer spec-reviewer doc-updater`.
  - This keeps a partially-synced plugin set from disabling review.
  - To diagnose, check `ls ~/.claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh`.
  - If absent, re-run `entrypoint.sh` or trigger a full R2 sync to restore the complete plugin payload.

### Resetting Review-Spawn Checkpoints

The Claude `Stop` hook (`enforce-review-spawn.sh`) only fires in advanced mode when `sdd/` and `sdd/README.md` are present. Its transcript-based trigger surface is `git push`, `gh pr merge`, and protected-base `gh pr edit --base main|master`; `git-push-review-reminder.sh` handles the in-turn reminder path for `git push`, `gh pr create`, and protected-base `gh pr edit`.

Pi uses the narrower supported command grammar in
[REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-command-parsing): successful root-session Bash/`ctx_execute`/`ctx_batch_execute` surfaces recognize direct or environment-prefixed `git push`, `gh pr create`, protected-base `gh pr edit`, and `gh pr merge` only in their documented reminder or settled roles. Unsupported convenience commands, failed commands, quoted examples, child sessions, passive startup, and integration-bound PRs are inert.

For Pi, the acknowledged full SHA remains at `.git/sdd-last-ack-pr-head`. A successful persisted boundary lists missing reviewer lanes and, when an acknowledgement exists, the exact acknowledged-to-current range. Every counted public reviewer prompt carries that range. Unmatched calls stay in flight until native notification, and only the reminder head can be acknowledged. A delayed persisted notification can acknowledge that head after reload or newer unpublished local work while the PR still points to it; unfinished or replaced work may repeat at a later boundary ([AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents)).

The USER-ONLY `/tmp/review-bypass` sentinel and explicit user wording remain review bypass surfaces; agents must not invoke them autonomously. Claude keeps its existing Stop-hook checkpoint and bypass semantics. Pi adds no pre-command merge interceptor.

Pi CI is not part of review completion or acknowledgement. After an eligible successful Git action, the extension issues one ordered plan; the root launches required reviewers first, then runs that plan's resolver once with explicit repository cwd and review launch state. CI launches last without waiting for review completion. An empty response means no monitor, and interruption remains aborted until a later plan or explicit request ([AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent)).

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
- [REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions) - PR-Boundary Review Trigger Conditions
- [REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-native-review-result-correlation) - Pi Native Review Result Correlation
- [REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window) - Pi Session-Scoped Review Window
- [REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-local-statusline-footer) - Pi Local Statusline Footer
- [REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery) - Supported Boundary Recovery
- [REQ-AGENT-059](../../sdd/spec/agents.md#req-agent-059-pi-native-review-findings-handoff) - Pi Native Review Findings Handoff
- [REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-command-parsing) - PR-Boundary Command Parsing
- [REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents) - Engineering Constitution Preseeded to All Agents
- [REQ-AGENT-067](../../sdd/spec/agents.md#req-agent-067-consult-llm-invocation-and-model-selection-behavior) - consult-llm Invocation and Model-Selection Behavior
- [REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring) - Independent Pi CI Monitoring
- [REQ-AGENT-069](../../sdd/spec/agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring) - Pi consult-llm MCP lazy wiring
- [REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy) - Claude on-demand CI monitoring policy
- [REQ-AGENT-071](../../sdd/spec/agents.md#req-agent-071-pr-boundary-review-agent-dispatch) - PR-Boundary Review Agent Dispatch
- [REQ-AGENT-074](../../sdd/spec/agents.md#req-agent-074-pi-settled-review-handoff) - Pi Settled Review Handoff
- [REQ-AGENT-080](../../sdd/spec/agents.md#req-agent-080-unified-pi-pr-boundary-launch-plan) - Unified Pi PR-Boundary Launch Plan
- [REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation) - rpiv-todo Session Isolation
- [REQ-AGENT-082](../../sdd/spec/agents.md#req-agent-082-pi-review-range-selection) - Pi Review Range Selection
- [REQ-AGENT-083](../../sdd/spec/agents.md#req-agent-083-user-invoked-pi-review-repository-context) - User-Invoked Pi Review Repository Context
- [REQ-AGENT-084](../../sdd/spec/agents.md#req-agent-084-pi-reviewer-policy-preloading) - Pi Reviewer Policy Preloading
- [REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport) - Pi Reviewer Direct Evidence Transport
- [REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt) - Proactive memory injection on first prompt

---

## Image-baked seed (Governed Mode delta sync)

In addition to seeding the agent config into R2 at session start, the container image **bakes** the same seed as an on-disk file tree so a [Governed Mode](configuration.md#governed-mode-r2-sse-c-disable) container can avoid re-downloading it every boot (REQ-STOR-017, [AD90](../decisions/README.md#ad90-governed-mode-preseed-bake--checksum-delta-initial-sync)).

- **Build (in-image).** The Dockerfile runs `scripts/materialize-agent-seed.mjs` against the committed, freshness-enforced `src/lib/agent-seed.generated.ts`.
  - It writes `getConfigsForMode('default'/'advanced', false)` to `/opt/codeflare/agent-seed-bake/<mode>/<key>`.
  - Because `getConfigsForMode` is a pure filter, the baked tree is **byte-identical** to what is seeded to R2.
  - That byte identity is the precondition for the checksum skip and is guarded by the `agent-seed-bake` byte-identity test.
  - The tier-gated context-mode subtree is excluded because it delta-syncs from R2.
  - Generating in-image needs no host build ordering and cannot drift from the seed.
- **Runtime (Governed Mode only).** Before the initial R2 sync, `entrypoint.sh::lay_down_agent_seed_preseed` copies the mode's baked tree into the user home.
  - The copy mirrors the R2 key layout, so one copy lands every agent home.
  - It also `chmod +x`'s the hooks.
  - The initial sync then compares by `--checksum`, using MD5 ETags available only when SSE-C is off.
  - Unchanged seed files are skipped and only user deltas transfer.
- **Gated.** Both the lay-down and `--checksum` activate only when `R2_SSE_DISABLED=true`.
  - Under SSE-C, the default path remains byte-identical to before: no lay-down and `--size-only`.
  - This avoids relying on `--size-only`, which could not detect a same-size edit to a seed file.
  - It also prevents the bake from overwriting an in-container edit.

## Related Documentation

- [Vault](vault.md#memory-capture-system) - Vault-based cross-session memory and the
  capture hook chain
- [Container](container.md#claude-code-integration) - Claude Code
  configuration
- [Container](container.md#pi-extension-npm-cache) - Pi extension npm
  warm-up
- [Storage & Sync](storage-and-sync.md) - R2 sync internals
- [Decisions](../decisions/README.md) - Architecture decisions
