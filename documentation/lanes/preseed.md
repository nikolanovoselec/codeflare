# Agent Preseed System

**Audience:** Developers

How AI agent rules, agents, commands, skills, and plugins are deployed
to per-user containers. This file owns the "what gets seeded" and "how
it gets there" content. Memory-system specifics live in
[vault.md](vault.md#memory-capture-system); container runtime details live in
[container.md](container.md).

**Owns:** manifest inputs, session-mode delivery, seed generation/reconciliation, runtime adaptation, seeded reviewer/CI agent policy, settings/plugin assembly, and image-baked delivery. **Does not own:** GitHub workflow topology, Vault extraction state, public endpoint contracts, or container supervision.

## Contents

- [Mode and Manifest Model](#mode-and-manifest-model)
- [Artifact Inventory and Sources](#artifact-inventory-and-sources)
- [Runtime Delivery Pipeline](#runtime-delivery-pipeline)
- [Agent-Specific Projection](#agent-specific-projection)
- [Graphify Toolchain](#graphify-req-agent-023)
- [SDD Bootstrap Contract](#sdd-bootstrap-contract)
- [Failure Diagnosis and Recovery](#failure-diagnosis-and-recovery)
- [Image-Baked Delivery Alias](#image-baked-delivery-alias)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

<a id="session-modes"></a>
## Mode and Manifest Model

Users choose between **Default** and **Advanced** session modes via
Settings > Session Defaults. The mode controls which preseed files are
deployed on Recreate or new bucket creation.

| Content | Default | Advanced | Advanced on Custom tier |
|---------|---------|----------|-------------------------|
| Memory plugin & rule | No | Yes | Yes |
| Core environment rules (cloudflare-environment, no-local-builds, git-workflow) | Yes | Yes | Yes |
| Pi startup header, local statusline, and fixed terminal notifications | Yes | Yes | Yes |
| Cloudflare-stack, ship (+ refs), ci-monitoring, pr-workflow, deploy-credentials skills | Yes | Yes | Yes |
| `consult-llm` skill (Claude + Pi) | No | Yes | Yes |
| CC hooks: `block-attributed-commits`, `git-push-review-reminder`, `enforce-review-spawn`, `run-review-lane` | No | Yes | Yes |
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
| context-mode helper package (`ctx_*` tools) | Installed and enabled by default; `/ctx off` opts out until restart | Installed and enabled by default; `/ctx off` opts out until restart | Installed and enabled by default; `/ctx off` opts out until restart ([REQ-AGENT-076 AC1](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)) |
| Pi extension packages (`@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `@narumitw/pi-goal`, `@narumitw/pi-plan-mode`, `@narumitw/pi-usage`, `pi-web-access`, `pi-mcp-adapter`) | Yes (always-on `required`) | Yes (always-on `required`) | Yes (always-on `required`) |
| context-mode plugin folder (Claude Code auto-routing hooks for context-window reduction) | No | No | Yes |

The Custom-tier column reflects the extra Claude Code delivery surface for users on the `unlimited` subscription tier in Advanced mode. Container startup writes context-mode's enabled Pi package marker, exposing its skills and `ctx_*` tools through the managed single foreground owner while filtering the package's own extension entrypoint. A state-changing `/ctx off` or `/ctx on` command persists the selected shared Pi setting and reloads the active Pi process; the next Codeflare container start restores the enabled default. See [REQ-AGENT-076 AC1-AC2](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

When enabled by startup or explicit `/ctx on`, package settings expose context-mode skills but filter out its extension. The managed `context-mode-runtime.ts` extension claims one process-wide foreground owner and loads the installed context-mode Pi adapter only for that owner; every in-process subagent sees the claim and skips the adapter, so no reviewer/capture/CI child creates a bridge helper. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> The owner is released after context-mode handles `session_shutdown`, allowing `/reload` and `/ctx` toggles to reattach cleanly.

Codeflare does not patch either upstream package's lifecycle or ownership implementation; separate image-build transforms add the ESM compatibility shim and suppress the upstream update probe ([AD101](../decisions/README.md#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports), [AD138](../decisions/README.md#ad138-context-mode-is-on-by-default-in-pi), [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC7, [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership)).

The managed Pi extension packages are installed in the settings `required` set, so they load in every Pi session independently of the context-mode toggle. This includes the exact-pinned native Goal package for session-scoped autonomous completion. Every Pi skill treats `ctx_*` tools as optional; `/ctx off` switches root workflows to documented native fallbacks without narrowing work.

The repository-owned `native-notifications.ts` extension is seeded in both modes. It emits fixed OSC 777 text when `ask_user_question` needs attention — subscribed via the package's stable `rpiv:ask-user:prompt` notifier channel (immutable channel names, append-only payloads), so the signal survives package major upgrades and fires only when a questionnaire actually opens — and emits completion only at `agent_settled`, avoiding premature completion during retry, compaction, or queued continuation. Cancellation and abort suppress stale completion. It registers nothing under `--mode rpc`, whose stdout is strict JSONL; code-server native Chat instead uses Code OSS's browser-notification lifecycle. No reviewed third-party notifier met both Codeflare's transport contract and the required maintenance/adoption threshold.

Claude needs no notification hook: both session-mode settings select Claude's built-in `ghostty` notification channel ([REQ-TERM-026](../../sdd/spec/terminal.md#req-term-026-claude-native-terminal-notification-producer)).

In-process subagents always use native fallbacks. The three PR reviewers expose only `bash` and consume their exact packet through the Bash/Node transport.

`@juicesharp/rpiv-advisor` 2.4 provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. It provides the user-invoked `advisor` tool and user-only `/advisor` command. Codeflare overrides its startup guidance so assistants do not call or suggest advisor unless the user's current message explicitly requests it.

`pi-web-access` 0.18 provides filtered zero-config Exa routing and configurable public tool names without changing Codeflare's default `web_search`, `source_check`, `fetch_content`, or paged `get_search_content` contracts. Search authenticates through Pi's model registry or zero-config Exa MCP, so it needs no per-user API key. Upstream no longer supplies its duplicate `librarian`; Codeflare preserves the workflow as an owned skill in both Pi modes and keeps its generated-seed delivery under [REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility).

`pi-evaluate` is exact-pinned at 0.1.5 from its reviewed [MIT npm tarball](https://registry.npmjs.org/pi-evaluate/-/pi-evaluate-0.1.5.tgz). Its whole extension registers the packaged skill directory on `resources_discover`; the package ships no tool, no command, and nothing that runs unless the user invokes `/skill:evaluate`. The skill is an adversarial post-execution reviewer: it reads the contract (a [reespec](https://github.com/bnenu/reespec) brief and specs when `reespec/requests/` exists, otherwise a contract the user pastes) together with the produced outputs, and returns a per-capability satisfied/partial/unsatisfied/unclear verdict plus triage guidance.

It deliberately does not read implementation intent, and it reports gaps rather than fixing them. Codeflare applies no patch or fork. Image construction explicitly loads the declared `extensions/evaluate.ts` entrypoint and requires its path-correct JITI artifact, so the first invocation does not cold-transpile ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions)). The same lock-backed dependency discovery includes future `pi-evaluate` releases in weekly shadow-pin proposals.

`@narumitw/pi-usage` is exact-pinned at 0.50.0 from its reviewed [MIT npm tarball](https://registry.npmjs.org/@narumitw/pi-usage/-/pi-usage-0.50.0.tgz) and registers `src/index.ts` as `/usage`. Its reviewed source validates official Codex, GitHub Copilot, and OpenRouter origins, bounds and redacts responses, and requires explicit confirmation before consuming a Codex reset. The package and its `@narumitw/pi-tui-kit` dependency are integrity-locked. Image construction explicitly loads the installed entrypoint and requires its path-correct JITI artifact, preventing a silent cold first command ([REQ-AGENT-131](../../sdd/spec/agents.md#req-agent-131-native-usage-workflow-in-pi-sessions)). The same lock-backed dependency discovery includes future `pi-usage` releases in weekly shadow-pin proposals.

`@narumitw/pi-plan-mode` is exact-pinned at 0.52.0 from its reviewed [MIT npm tarball](https://registry.npmjs.org/@narumitw/pi-plan-mode/-/pi-plan-mode-0.52.0.tgz). It registers `dist/index.ts` and provides the `/plan` collaboration workflow, read-only planning tool policy, structured planning questions, explicit plan completion, and implementation handoff. Codeflare adds no fork or source patch. The installed entrypoint is explicitly loaded and fail-closed verified in the image's path-correct JITI cache ([REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions)).

After restore on every container start, `entrypoint.sh` atomically replaces `~/.pi/agent/pi-plan-mode.json`. The managed policy inherits the session thinking level, keeps an approved implementation plan active, and enables built-in read/limited-shell tools plus bounded Browser Run, web retrieval, context-mode indexing/search, and Graphify query tools when those tools are available. It deliberately excludes the general questionnaire, arbitrary context-mode command execution, MCP, delegation, task mutation, and advisor surfaces because Plan Mode owns its own structured question and completion tools. No shortcut or export path is configured. `/plan save` stays session-local. A pathless `/plan export` uses upstream's `PLAN.md` default; users provide an explicit path when exporting elsewhere, such as `/plan export "/home/user/Vault/Implementation Plans/<name>.md"`. Codeflare ships no automatic plan-file writer. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

Plan Mode 0.52.0 and Goal 0.53.0 share upstream's session-scoped `workflow:mutex:v1` protocol, so starting one workflow while the other owns the session is refused and ending it releases ownership ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions)).

`@narumitw/pi-goal` remains the normal upstream package, exact-pinned at 0.53.0 after review of the [published npm tarball](https://registry.npmjs.org/@narumitw/pi-goal/-/pi-goal-0.53.0.tgz). Codeflare does not vendor or fork it. The MIT package declares `src/index.ts` as its sole Pi extension and provides `/goal`, `goal_complete`, and `goal_blocked` without managing subagent files. At startup, Codeflare merges three missing values into `~/.pi/agent/pi-goal.json`: `toolVisibility: "after-first-goal"`, `continuationLimits.automaticTurns: 10`, and `continuationLimits.minIntervalMs: 60000`. Explicit values, including valid null and custom limits, win. Unknown fields, `rpc`, and existing visibility settings survive the merge. <!-- @impl: entrypoint.sh::PI_GOAL_STARTUP_CONFIG -->

A malformed file is left byte-for-byte alone rather than being "repaired" by startup. There is no settings-panel patch for these Codeflare-owned startup values.

On reload, `capability.ts` keeps those tools active when the session's latest canonical Goal state is unfinished or Goal's user-owned `always` policy already activated both tools, allowing the same Goal to restore without independently widening fresh or completed lazy sessions ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions) AC4/AC5).

Startup removes the retired `pi-goal-list-loop-audit` package from persisted settings, preventing its Explore ownership warning from surviving an image upgrade. Its replacement's runtime dependencies remain integrity-locked in the committed preseed lock.

The image warms the declared entrypoint through its real npm path and fails unless the exact jiti artifact exists ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions) AC2/AC3).

Before jiti warm-up, the image build runs the version-aware `scripts/patch-pi-goal-review-control.mjs` transform against the exact locked 0.53.0 source; every other version or source layout fails closed before writes. One part adds the existing session-local control channel and delegates pause and resume to pi-goal's own command controller. Trusted review-owned pause uses the controller's non-aborting option, so it changes Goal state and cancels Goal continuation work without aborting the independently queued review turn; manual pause keeps the controller's default current-turn abort ([REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility) AC1-AC4).

FIX-triggered resume suppresses pi-goal's separate continuation prompt because the existing FIX follow-up owns the next turn. Closure-triggered resume also suppresses that prompt but schedules no continuation turn. Neither path enables Managed Run RPC, populates the user's input field, or turns command text into model input ([REQ-AGENT-114](../../sdd/spec/agents.md#req-agent-114-review-owned-goal-continuation) AC1-AC4).

The same transform adds `continuationLimits.minIntervalMs` to pi-goal's normal settings loader and saver. Upstream's default remains zero, so an ordinary unconfigured installation dispatches immediately. Codeflare's startup merge chooses 60 seconds. A positive interval creates one timer for an eligible continuation; later settled events do not restart it. Existing pause, clear, replacement, prioritization, and shutdown paths cancel it through pi-goal's own continuation cleanup. At expiry, the timer checks the current session generation, exact marker, active Goal identity and workflow ownership, and idle/pending state. If Pi became busy, the intent stays pending and a later settled boundary may schedule it again ([REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy) AC5-AC7; [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing) AC1-AC7).

The transform calculates all five patched files before writing and admits only locked 0.53.0. The host suite verifies and extracts the exact registry archive before patching those upstream files. Anchor or layout drift leaves source untouched. The weekly shadow-pin job runs the same preflight before opening a bump PR; later releases fail until their source, integrity, version contract, and anchors are reviewed ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation)). <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration) -->

For reviewer-bearing PR boundaries, `review-enforcement.ts` emits the review launch plan independently. When an active Goal or matching review-owned pause exists, the boundary agent-end handler records ownership and awaits the trusted bridge pause before returning, so the queued launch-plan turn starts against settled Goal state. The trusted bridge pause does not abort Pi's queued launch-plan turn or its background tasks. If ownership cannot be recorded or Goal control is unavailable, review proceeds without pausing the Goal. An exact persisted pause retains release ownership even when the bridge response is missing or unsuccessful ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-pause-ownership-across-pr-heads) AC1-AC3 and Constraints; [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-non-disruptive-review-owned-goal-control) AC1-AC4 and Constraints; [REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility) AC1).

Review completion requests resume immediately before the matching acknowledged `pr-boundary-fix-follow-up`. If a manual resume wins that request race, authoritative non-paused state clears stale ownership without a false error. PR closure requests resume during closure handling, and a failed replacement-head ownership write may request rollback. CI and individual reviewer notifications never request resume. Missing control, Goal replacement, and independent reactivation remain fail-open ([REQ-AGENT-113](../../sdd/spec/agents.md#req-agent-113-review-owned-goal-release) AC1-AC7; [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-non-disruptive-review-owned-goal-control) AC5-AC6).

Exact-head launch or acknowledgement choices are checkpointed in the existing session transcript before Pi queues their follow-up. Later Git/GitHub commands and normal resume reuse that disposition without another question; startup of an existing session recovers one accepted plan whose queued message is absent. Only ambiguous failed `gh pr create` results reporting HTTP 5xx or an already-existing PR are reconciled, and only through the same exact local/authoritative PR check ([REQ-AGENT-110](../../sdd/spec/agents.md#req-agent-110-pi-pr-boundary-missing-launch-follow-up) AC7; [REQ-AGENT-141](../../sdd/spec/agents.md#req-agent-141-authoritative-head-review-launch-continuity) AC3/AC5-AC6; [REQ-AGENT-145](../../sdd/spec/agents.md#req-agent-145-failed-pr-creation-reconciliation) AC1-AC3).

The latest persisted review window remains distinct from newer unpublished Git candidates, while an acknowledged, transcript-proven review resends one absent FIX handoff after startup or resume. A visible FIX retires that window before later head-drift handling. Runtime-local queued identities close the pre-delivery gap without adding a durable store, dispatcher, or review coordinator ([REQ-AGENT-074](../../sdd/spec/agents.md#req-agent-074-pi-settled-review-handoff) AC7; [REQ-AGENT-110](../../sdd/spec/agents.md#req-agent-110-pi-pr-boundary-missing-launch-follow-up) AC5-AC7; [REQ-AGENT-126](../../sdd/spec/agents.md#req-agent-126-pi-review-checkpoint-persistence-and-head-drift) AC1/AC4; [REQ-AGENT-141](../../sdd/spec/agents.md#req-agent-141-authoritative-head-review-launch-continuity) AC2).

Missing-launch settled recovery emits at most five follow-ups for one unreviewed head, stores its count by PR number in the normal checkout's `.git` directory, and resets only for a different head ([REQ-AGENT-119](../../sdd/spec/agents.md#req-agent-119-settled-review-follow-up-accounting)).

For an open, non-bypassed review, the first settled recovery defers when no reviewer or CI launch is recorded, preventing a recovery message from duplicating the initial plan. Duplicate boundaries do not duplicate the pause, and a replacement PR head transfers ownership of the existing pause instead of stranding it on the superseded head. If that transfer cannot be persisted, the bridge requests rollback; successful rollback clears ownership, while failed rollback retains recoverable ownership for the replacement head's FIX release ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-pause-ownership-across-pr-heads) AC1-AC7).

`@juicesharp/rpiv-todo` is pinned at 2.4.0; its overlay now loads lazily and omitted update fields produce recoverable model guidance, while the session-isolation correction shipped upstream in 2.0.0 remains intact: task state is keyed by Pi session ID and context-free rendering stays bound to the foreground slot. The temporary [AD100](../decisions/README.md#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) source override that mirrored this fix while npm was at 1.20.0 is retired — no postinstall guard or payload remains, and a host test guards that the pin names the reviewed release ([REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation)).

`web_search` defaults to the `auto-summary` workflow via a preseeded, create-if-missing `~/.pi/web-search.json` (`{"workflow": "auto-summary"}`). A user who edits that file to opt back into the interactive `summary-review` workflow has their choice respected on later boots.

[pi-web-access 0.14](https://github.com/nicobailon/pi-web-access/releases/tag/v0.14.0) fixes the former interactive-curator fallback crash. The container remains headless, so `auto-summary` is still the only default workflow that can complete without a browser-approval UI; users who deliberately provide such a UI may retain their own `summary-review` setting.

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC2/AC4/AC6, [REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport) AC1-AC3, and [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership); source: `entrypoint.sh::warm_pi_npm_dependencies` (filtered context-mode package + tool extensions), `preseed/agents/pi/extensions/context-mode-runtime.ts` (foreground ownership), `preseed/agents/pi/extensions/codeflare-pi.ts::handleContextModeCommand` (state-changing `/ctx on|off` persistence + reload), the Pi reviewer agents (Bash-only transport), the main-execution web-search default block, `preseed/agents/pi/skills/advisor/SKILL.md`, and `preseed/agents/pi/package.json`.

**Storage**: `sessionMode?: 'default' | 'advanced'` in
`UserPreferences` (KV). Undefined = `'default'`.

**Resolver**: `resolveSessionMode(prefs, env?)` in
`src/lib/session-mode.ts` -- single source of truth for the
`?? 'default'` fallback. Under `ENTERPRISE_MODE`, it short-circuits to
`'advanced'` before consulting `prefs`, so a JIT-provisioned enterprise
user with no stored preference still resolves to Pro
([REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2).

**When mode takes effect**: On any of: explicit "Recreate AI agent
skills & rules" click, new bucket creation, Stripe mode change
(upgrade or downgrade via webhook), subscription termination
(`customer.subscription.deleted`), Settings toggle of
`sessionMode`, automatic upgrade on release (triggered by
`preseedNeedsUpgrade: true` in the initial dashboard batch-status
response; see
[REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release)),
or the one-time enterprise Pro upgrade — at session start or first
dashboard load (same `preseedNeedsUpgrade` UPDATING affordance as a
release upgrade) — for a pre-existing bucket whose stored preference
is not yet `advanced` (stamped only after a successful reconcile, so
a failure retries;
[REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC6/AC7).

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
the current mode. Strictly scoped -- no bucket listing, no prefix
scans, never touches user-created files. `getPreseedKeysNotInMode()`
excludes variant-per-mode keys (instruction files that exist in
both modes with different content) to avoid deleting a file that
was just seeded. Partial delete failures return `warnings` without
failing the overall operation. `getConfigsForMode()` validates no
duplicate keys within a single mode.

Three sources feed the delete list. `getPreseedKeysNotInMode()` gives keys
in `AGENTS_SEEDED_CONFIGS` that the target mode does not want. The frozen
`RETIRED_PRESEED_KEYS` gives keys shipped before provenance markers
existed, recovered once by walking the seed module's history; a key on it
that the target mode still seeds is never deleted, and the generator
refuses to emit such a list. Last, a stale-marker sweep deletes anything
under the seed's own prefixes carrying a marker other than this build's.

Every seed write stamps `x-amz-meta-codeflare-preseed` with the writing
build's preseed hash. Because a reconcile rewrites every live key before
cleaning, an older marker means the product has dropped that key -- so
retirements need no bookkeeping. An S3 PUT replaces metadata wholesale and
rclone does not send custom metadata, so editing a seeded file through the
browser or inside the container drops the marker and the file becomes the
user's own. Deletion always requires positive evidence: a marker, or
membership of the frozen list. All three behaviours were probed against a
real R2 bucket before the mechanism was built on them; see
[AD118](../decisions/README.md#ad118-seed-provenance-is-carried-in-r2-custom-metadata-verified-before-it-was-relied-on).

Listing is issued per two-segment prefix (`.claude/skills/`, `.pi/agent/`
and twelve others) rather than per runtime root. That keeps the
getting-started documents out of scope even though the same helper stamps
them, and keeps the large runtime trees -- `.claude/projects/` session
transcripts, `.claude/todos/` -- out of the pages entirely, which matters
because the same request has already issued one PUT per live key. The HEAD
fan-out is batched, and a candidate count past the cap skips the sweep with
a warning rather than issuing the requests.

**Upgrade semantics**: currently-seeded keys are build-authoritative. A
release that changes preseed content changes `PRESEED_CONTENT_HASH`, which
triggers the upgrade reconcile (REQ-AGENT-049) on next dashboard load; that
reconcile overwrites live keys and removes retired ones. Files the build
never seeded are never touched. Implements
[REQ-STOR-019](../../sdd/spec/storage.md#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed).

<a id="preseed-components"></a>
## Artifact Inventory and Sources

ECC (Everything Claude Code)-derived rules, agents, commands, and skills are preseeded directly
to the agent config filesystem. No external plugins are installed.

| Artifact class | Canonical inventory / source | Generated or runtime target |
|---|---|---|
| Mode and feature selection | `preseed/agents/claude/manifest.json` | Per-agent projected files |
| Agent definitions | `preseed/agents/claude/agents/` plus manifest membership | Claude/Pi/OpenCode agent directories |
| Rules and commands | Claude seed directories plus manifest membership | Agent-specific rule/command surfaces |
| Skills and plugins | Seed trees, `ORIGIN.md`, plugin manifests, lock/pin inputs | Runtime skill/plugin directories |
| Pi runtime packages | `preseed/agents/pi/package.json` and lock | Image cache then `~/.pi/agent/npm` |
| Generated seed | `scripts/generate-agent-seed.mjs` output | Image-baked `/opt/codeflare/preseed` |
| Runtime projection | `entrypoint.sh` merge/copy functions | User-home agent configuration |

Do not infer inclusion from a file's mere presence: manifest membership, mode gates, generator behavior, and agent-specific adapters are jointly authoritative.

**Agents**: the manifests are authoritative. Representative advanced agents include `architect`, `code-reviewer`, `spec-reviewer`, `doc-updater`, `deep-reviewer`, `memory-capture`, and `vault-extract`. They are preseeded to `~/.claude/agents/*.md`
(and adapted equivalents for other agents) via the manifest pipeline
with `"modes": ["advanced"]`. `deep-reviewer` is invoked exclusively
by `/review --deep`; it reads SDD REQ + impl + tests and judges
behavioral spec-vs-code match per acceptance criterion. Each agent definition has YAML
frontmatter with `name`, `description`, `tools` (emitted as a record
`{read: true, write: true}` for OpenCode, instead of array format),
and `model` (CC only).

**Commands**: the manifest-defined command set includes `brainstorm`, `debug`, `deploy`, `review`, `sdd`, and the Cloudflare build helpers. Commands are preseeded to `~/.claude/commands/*.md` (CC only -- other agents don't
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
`tdd-enforce`. `spec-enforce-truth` requires at least one resolving `@test`
anchor per non-manual AC, parses multiple anchors independently, and validates
every declared block ([AD108](../decisions/README.md#ad108-per-ac-test-evidence-permits-multiple-resolving-anchors)). The git-workflow family is `ci-monitoring`,
`git-review-pipeline` (advanced-only), `pr-workflow`, and `deploy-credentials`.

The design family (UI/frontend work) is `emil-design-eng` and
`design-taste-frontend` (prose-only, adapted to every agent), plus `impeccable`. `impeccable` keeps its multi-command design skill and bundled offline/live detector
scripts. It is scoped to Claude + Pi only: Claude gets the vendored tree in
`~/.claude/skills/impeccable/`; Pi gets a dedicated copy under
`~/.pi/agent/skills/impeccable/` with paths re-pointed and `.mjs` scripts emitted
verbatim, so detector scripts are never mangled by Claude-to-Pi text adaptation. The vendored Impeccable bundle is shadow-pinned by `bump-shadow-pins.yml`, which
checks `impeccable.style`, refreshes both agent copies, updates both manifests,
and regenerates the seed.

[Impeccable 4.1.0](https://github.com/pbakaus/impeccable/releases/tag/skill-v4.1.0)
adds native-platform review inputs, comp-first/code-first workflow defaults,
richer direction decisions, and a bounded degraded-agent path without changing
Codeflare's Claude-and-Pi delivery boundary.

The Apache-2.0 Cloudflare bundle tracks
[`cloudflare/skills@f96bff7`](https://github.com/cloudflare/skills/commit/f96bff754e428838818017f75817f0f9428acd48).
Its former ambiguous `sandbox-sdk` entry is replaced by `sandbox-stable`,
`sandbox-next`, and `sandbox-migrate-to-next`, preventing stable string-command
APIs from being mixed with the 1.0-preview argv/process-handle APIs. The
Turnstile skill is refreshed from
[`30553f8`](https://github.com/cloudflare/skills/commit/30553f89ae1ef1e3c2917cd09d72dac992bb4e9a),
then locally hardens API calls with bounded deadlines and behavioral tests
([REQ-AGENT-138](../../sdd/spec/agents.md#req-agent-138-bundled-turnstile-scripts-fail-closed));
obsolete deployment templates are retired in favor of the current siteverify-first
runbook and scripts. Codeflare keeps the mega-skill reference
tree slimmed and excludes upstream MCP configuration as specified by
[REQ-AGENT-075](../../sdd/spec/agents.md#req-agent-075-cloudflare-platform-skills-bundled-into-the-advanced-seed).

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
`~/.pi/agent/mcp.json` via the pi-mcp-adapter `mcp` proxy.
[Adapter 2.21.0](https://github.com/nicobailon/pi-mcp-adapter/releases/tag/v2.21.0)
retains the 2.20 proxy contract and modular MCP v2 transport while adding opt-in
MCP 2026-07-28 discovery, Agent Plugins MCP loading, safer server-name ownership
resolution, configurable panel saving, and an OAuth issuer-validation escape
hatch. Codeflare leaves the legacy protocol default and plugin paths unchanged,
so no owned MCP skill or configuration migration is required.

The adapter's transport runs on `@modelcontextprotocol/client` and
`@modelcontextprotocol/core` 2.0.0, with `jose`, `pkce-challenge`, `eventsource`,
and `cross-spawn` in the container dependency tree. Because adapter 2.15+
reserves a leading `!` for command-backed secrets, the entrypoint doubles that
prefix only in Pi's generated env value so a provider key beginning with `!`
remains literal; Claude's value is unchanged. The Pi entrypoint-owned
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

Pi's PR-boundary extension is the sole automatic dispatcher for review and CI ([AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent)). Unpublished local commits are not review heads and never authorize pre-push reviewers. A successful `git push` or `gh pr create` launches automatically only after GitHub confirms that the checked-out branch has an exact-head PR to `main`, `master`, or `develop`. Other successful Git or GitHub activity performs the same authoritative check but asks before launching; declining revalidates and acknowledges that exact head, so clone and branch navigation cannot start review without user consent. Pi freezes the triggering tool-use ID as the review-cycle correlation key.

While automatic delivery is reconciling, ordinary boundaries in that repository do not open a competing choice. When reconciliation finishes, they reuse the exact-head plan or automatically resume normal eligibility. A later boundary may start a new cycle only after FIX ([REQ-AGENT-153](../../sdd/spec/agents.md#req-agent-153-in-flight-delivery-reconciliation-continuity)).

On the normal non-bypassed path, an automatic or confirmed boundary makes the extension emit a numbered Markdown runbook with PR/head/scope context and the order `REVIEWERS → CI → TRIAGE + ACK → FIX`. Reviewer calls start together; CI starts immediately afterward without waiting. The explicit user-only bypass exception is described below and specified by [REQ-AGENT-041](../../sdd/spec/agents.md#req-agent-041-pr-boundary-review-bypass-surfaces).

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> pr=<affected-pr-number> head=<boundary-plan-head> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

No stdout means no action. Otherwise the root submits the resolver's request unchanged once through public `subagent`. The resolver requires the live PR head to equal the boundary-plan head, so review and CI cannot silently split across different commits. An authoritative checked-out-branch head change uses `event=push` for CI monitoring. The report-only `ci-monitor` remains independent from review acknowledgement and relies on the bounded script rather than an agent turn cap. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ciBoundaryEvent --> <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::resolveCiMonitorRequest -->

After the final reviewer or CI launch, the root ends that turn immediately instead of foreground-waiting, sleeping, polling, resuming, or retrieving an in-flight agent. Native task notifications drive later turns. Public result retrieval is reserved for a terminal notification whose report is truncated or otherwise unavailable.

When reviewers are required, the final runbook section requires every finding to receive one row in `FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION`. The root then makes no file or Git changes and ends the turn. Agent-end enforcement accepts that tool-free table only after every required reviewer has a correlated successful native notification or public `get_subagent_result`, writes the reviewed-head acknowledgement, and queues one separate FIX follow-up carrying the frozen boundary tool-use ID. The latest same-head review window and its FIX deduplication stay scoped to that cycle, so an older same-head FIX cannot suppress a separately authorized review. The first correlated success fixes each lane's completion point, so a later equivalent notification cannot reopen triage. Settled enforcement is the idempotent fallback. Missing-work follow-ups remain distinct and forbid duplicating unmatched calls; CI and the Git acknowledgement remain exact-SHA scoped.

Malformed or superseded heads fail closed. Check rows are accepted only when every required provider field has the expected type, the result link is HTTP(S), and the bucket is one of GitHub CLI's supported values; malformed stable rows can never become `CI_RESULT success`. [REQ-AGENT-090](../../sdd/spec/agents.md#req-agent-090-ci-monitor-head-correction-is-authoritative-and-fail-closed) permits only the observed 41-character transcription whose first 40 characters exactly equal GitHub's authoritative PR head.

Non-SDD repositories and default-mode sessions receive CI-only plans. The resolver serializes canonical GitHub repository, PR number, head, and local repository path as one JSON identity. A correlated successful public CI-monitor tool result writes the separate per-PR CI-head checkpoint immediately; agent-end and settled transcript correlation remain idempotent fallbacks, and settled recovery checks the durable head before emitting missing work. Failed or mismatched launches remain retryable, later sessions do not repeat CI for that unchanged head, and enabling review still launches its reviewer lanes without fabricating review acknowledgement. An aborted running monitor may be relaunched only by explicit request; a later automatic plan applies to a changed head. Implements [REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring) and [REQ-AGENT-125](../../sdd/spec/agents.md#req-agent-125-pi-ci-result-and-launch-checkpoint).

Pi review is session-scoped ([AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents)). On the normal non-bypassed path, successful persisted boundaries produce a triggering root launch plan. With a valid acknowledgement, the plan and every counted reviewer prompt carry the exact acknowledged-to-current range; unmatched calls remain in flight until a correlated successful native notification or public result retrieval. The first launch plan for an unchanged head owns that review window; later candidates in the same active session neither replace it nor duplicate its launches. After session resume, the first new authoritative candidate may re-emit that plan and restore its deferred Goal pause ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-pause-ownership-across-pr-heads)).

After every required result, a tool-free structural triage table lets `agent_end` record that checkpoint and emit the next-turn FIX handoff; `agent_settled` remains an idempotent fallback. Delayed terminal evidence can acknowledge its reviewed PR head after reload or newer unpublished local work only while GitHub still reports that same authoritative head. If the live PR head has advanced, acknowledgement and FIX stay closed and a visible triggering head-drift handoff identifies both commits and requests one replacement boundary.

Generated reviewer system prompts embed their canonical scope and enforcement skills, so reviewers build the lane packet without retrieving policy first. All three use Pi's provider-neutral `medium` thinking level rather than inheriting the root session's level. The foreground-only context-mode extension is intentionally unavailable inside in-process reviewers. Each reviewer invokes the packet CLI through repository-rooted Bash/Node and consumes its JSON in the same processing call; packets are never persisted or handed between calls. Standalone read, grep, Graphify, and indexed batch/global retrieval are unavailable to the lanes. The root waits for every report and alone changes the head.

Cross-lane packet inputs carry exact old/new hunk ranges. Reviewers resolve an anchored implementation symbol or named test block and follow it only when that range intersects a changed hunk; sharing a changed file is not direct invalidation. Reviewers consolidate deterministic checks, emit failures rather than successful manifests, and verify generated seed through canonical preseed plus one identity check. The direct Bash/Node packet path preserves the declared scope, evidence, and dispositions.

Claude CI monitoring remains bounded to eligible PR-boundary plans, explicit user requests, and fresh deploy/merge gates ([REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy)). Routine non-boundary pushes do not start it; at a PR boundary, CI launches after reviewers and remains independent of review completion or acknowledgement. When invoked, the Claude skill launches a detached temp-script monitor, prints `CI_MONITOR_STARTED head=<sha> pid=<pid> log=<path>`, requires a non-empty workflow/run fingerprint to stay stable across two polls before success, and writes terminal `CI_RESULT failure` / `CI_RESULT timeout` lines to that durable log on workflow failure or GitHub CLI access failure. 

Every terminal line carries `head=<sha>`, because a monitor outlives its head: pushing again leaves the previous one polling until its deadline, and an unstamped result would be indistinguishable from a verdict on the current head. A line naming a head that is no longer current satisfies no gate, and the durable log path is keyed by head as well.

The monitor neither cancels workflow runs nor consults the remote about its own relevance. Superseded runs are cancelled by the workflows, which each declare their own `concurrency` policy; the ones that omit `cancel-in-progress`, `deploy.yml` among them, omit it because a half-finished run is worse than a redundant one. A client reconstructing either decision from a branch name gets both wrong ([AD122](../decisions/README.md#ad122-the-ci-monitor-observes-and-reports-it-does-not-cancel-runs-or-chase-the-remote)).

Monitoring and any other long-running wait/poll are background-only: no agent may
keep the main session busy with `tail -f`, `gh run watch`, blocking `ctx_execute`,
Bash loops, deploy-status waits, or foreground polling
([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring)). The discipline triad (`spec-discipline`, `documentation-discipline`,
`tdd-discipline`) is advanced-only. Claude receives those rules in ambient instructions; Pi receives the same canonical policy through its grouped native skills, without duplicate ambient rule copies.

`memory` is advanced-only and carries folded vault trigger/route content. It
references Claude-specific `mcp__graphify__*` tools and the vault hook system.
`vault-note-capture` is advanced-only and routes "take a note" phrases to the
`vault-note-capture` skill.

The graphify discipline
([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify))
and the LLM coding-mistakes principles were standalone graph-first and
karpathy rules until 2026-07-25; both are now sections of the advanced-only
`engineering-constitution`. `frontend-components`
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
ECC-derived language rules in `{typescript,python,golang,swift}/` subdirs
are advanced-only. Each `coding-style.md` extends the constitution's "Coding
concretes" section directly, the common coding-style rule having been absorbed there
on 2026-07-25; per-language `security.md` files stand alone after
the common security rule's removal.

**Known marketplaces**: `plugins/known_marketplaces.json` preseeds
the official Anthropic plugin marketplace URL for user discovery.

**Updates**: Preseed files update when the pipeline is redeployed
and users click "Recreate AI agent skills & rules".

## Managed curation ownership

**Requirements:** [REQ-AGENT-147](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases), [REQ-AGENT-148](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication), [REQ-AGENT-149](../../sdd/spec/agents.md#req-agent-149-shared-compiler-cli-compatibility)

Codeflare has two deliberately separate content timelines:

- Public `preseed/agents/**` is the image-baked fallback baseline.
- The private [`codeflare-curation`](https://github.com/nikolanovoselec/codeflare-curation) repository is the runtime master for deployment-managed skills, rules, hooks, agents, scripts, plugins, and company extension requirements. Access is required; it is not readable from the public repository.

A curated content change lands in `codeflare-curation` and is published there. Its private Claude and Pi manifests define every included source and its `default`/`advanced` mode membership. Manifest-listed Pi extension TypeScript files load from R2 without an image redeploy. Pi package/lock/install state and tier-gated context-mode remain image-owned, so new npm or native dependencies require a Codeflare runtime change.

Curated content is not copied into this public preseed, and a public baked-preseed edit must not overwrite newer private source. A task for managed content changes the private repository. A task explicitly limited to image fallback changes this repository only.

**Agents working on Codeflare:** when a task asks for a new or changed skill, rule, hook, agent, script, plugin, or required Browser IDE extension, that work does not belong in this repository. Clone the curation repository, branch, commit, and open a PR there:

```bash
git clone https://github.com/nikolanovoselec/codeflare-curation.git
```

Editing `preseed/agents/**` here instead is a silent no-op for deployments with Managed Environment curation active, because those deployments read the signed release rather than the image baseline. Only two cases justify editing this repository: a task explicitly scoped to the image fallback, or a change to the shared compiler, transform, seed ABI, or Pi runtime lock, which are Codeflare-owned and land here first.

Behavior required in both timelines receives two explicit edits, with the private version authoritative; no public-to-private synchronization job is used. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->

The shared compiler and runtime ABI remain Codeflare-owned. Compiler, transform, seed ABI, or Pi runtime-lock changes land in Codeflare first; after that commit exists, update the exact compiler pin in `codeflare-curation` and run its real compiler integration workflow. Never copy dirty or untracked compiler files into the private repository.

After a private content change merges to protected `main`, the operator runs the one-trigger protected release workflow. It derives the next sequence from verified immutable history and publishes fixed signed assets. Codeflare discovers the release through its normal five-minute dashboard refresh. No image rebuild, source synchronization job, webhook, or container clone participates. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

### Spotlight: how `runtimeDependencyHash` binds a release to its image

A managed release may replace agent code without rebuilding the container. That freedom needs a hard compatibility check. A valid signature proves who published the bytes; it does not prove that the installed Pi packages can run them. `runtimeDependencyHash` closes that gap. See [REQ-AGENT-147 AC2-AC3](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases) and [REQ-AGENT-150 AC4](../../sdd/spec/agents.md#req-agent-150-independent-managed-release-activation-validation).

1. `codeflare-curation/config/compiler.json` pins one exact Codeflare commit, which owns the compiler and Pi runtime contract. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->
2. Publication checks out that clean commit and copies its `preseed/agents/pi/package-lock.json` into the staged private source. The private repository supplies the managed content. <!-- @impl: scripts/agent-seed-core.mjs::computeAgentRuntimeHash -->
3. The shared compiler calculates SHA-256 over the complete lockfile bytes. Whitespace and dependency-tree changes count because npm installs from that exact lock. <!-- @impl: scripts/agent-seed-core.mjs::computeAgentRuntimeHash -->
4. Release construction writes the digest to `runtimeDependencyHash` inside `seed-v1.json.gz`. <!-- @impl: scripts/agent-seed-release.mjs::buildAgentSeedRelease -->
5. Publication signs the exact deterministic compressed bundle and publishes it with its raw 64-byte Ed25519 signature. <!-- @impl: scripts/agent-seed-release.mjs::signReleaseBundle -->
6. Every Codeflare image contains `PRESEED_RUNTIME_DEPENDENCY_HASH`, generated from the Pi lockfile used to build that image. <!-- @impl: scripts/agent-seed-core.mjs::toGeneratedModuleSource -->
7. On its periodic release check, the Worker verifies immutable metadata, asset digests, signature, schema, sequence, and runtime hash before activation. <!-- @impl: src/lib/remote-curation.ts::verifyManagedReleaseStream -->
8. Equal hashes permit activation. A mismatch retains the previous verified release, records `Managed release requires a different runtime dependency set`, and retries later. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

The seed never asks running instances to provide a hash. Curation embeds the hash from its pinned Codeflare commit, and each image compares that value with its own generated constant. A content-only release that keeps the same Pi lockfile keeps the same hash and needs no image redeploy. A new npm or native dependency changes the lock, so the matching image must reach an environment before that environment can activate the release.

This is deliberately narrower than a full Codeflare source hash. The exact compiler commit makes compilation reproducible; the Pi lockfile digest answers the runtime question. Treating those as one concept would force image deployments for harmless prose changes, which would defeat managed curation.

<a id="preseed-deployment"></a>
## Runtime Delivery Pipeline

All preseed content is deployed via the manifest pipeline:

1. Source files in `preseed/agents/claude/` organized by type:
   `rules/`, `agents/`, `commands/`, `skills/`, `plugins/`
2. `preseed/agents/claude/manifest.json` maps each file to modes
   (`default`, `advanced`, or both)
3. The side-effect-free `scripts/agent-seed-core.mjs` reads manifest + files
   (manifest-driven, ignores non-manifest files like `plugins/cache/`) and applies
   every agent transform. `scripts/generate-agent-seed.mjs` is the image-build CLI
   wrapper; it generates `src/lib/agent-seed.generated.ts` with the
   `AGENTS_SEEDED_CONFIGS` array and `PRESEED_CONTENT_HASH` (deterministic SHA-256
   over all documents sorted by key, truncated to 16 hex chars). The shared core
   also exposes the full Pi lockfile digest that binds managed releases to the
   runtime dependency ABI. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @test: host/__tests__/agent-seed-core.test.js (shared agent seed compiler) -->
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

Advanced mode also delivers a composable design suite. `design` is its default entry point: it routes product-interface decisions to `ui-ux-pro-max`, static PNG/PDF work to `canvas-design`, distinctive frontend implementation to the Codeflare-owned `frontend-design`, and critique/polish to `impeccable` where that optional full bundle is installed. The canonical files live under `preseed/agents/claude/skills/`; the normal generator adapts them for each skill-capable runtime. UI UX Pro Max is vendored under MIT and Canvas Design under Apache-2.0 with provenance and modification notices. <!-- @impl: preseed/agents/claude/skills/design/SKILL.md::Route the request --> <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->

The release auto-upgrade check uses
`GET /api/sessions/batch-status?includePreseedCheck=true` to compare
`PRESEED_CONTENT_HASH` with `lastPreseedHash` in `UserPreferences` KV. If they
differ, the frontend fires `recreateAgentConfigs()` in the background. The "+ New
Session" button and stopped-session cards are disabled during the upgrade. On
completion, `lastPreseedHash` is updated. Failure is non-fatal; a page refresh
retries. Implements
[REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release).

Managed curation reuses that exact status and reconciliation flow. Status polls compare the verified active digest, sequence, and resolved mode with `managedEnvironmentApplied`; unchanged-release polls do not expand payload bytes, while the existing five-minute resolver still verifies and caches a newly discovered release once. An idle mismatch makes the existing `POST /api/storage/seed/agent-configs` route download the content-addressed `seed-v1.json.gz` once from deployment R2, verify its signature and complete contract as a bounded stream, then stream the same downloaded bytes into the ordinary mode/provenance/cleanup writer with no more than six concurrent R2 operations. The user-bucket keys, contents, content types, ownership markers, cleanup, context-mode pass, applied stamp, and visible `Upgrading` lifecycle remain unchanged. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @impl: src/lib/remote-curation.ts::verifyManagedReleaseStream --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->

**Manifest structure** (Claude configs plus Pi-native assets; exact counts live in the manifests, not here):
- `rules/`: core, common, and language-specific rule documents.
- `agents/`: advanced-only specialist agent definitions.
- `commands/`: advanced-only slash command definitions.
- `skills/`: default skills, advanced skills, design skills, and enforcement skill families.
- `plugins/`: marketplace, memory, vault, hooks, context-mode, and graphify plugin payloads.
- Pi-native runtime assets include package config and package lock.

The `rules/` tree includes core rules for both modes: cloudflare-environment,
no-local-builds, and git-workflow. The local-execution rule stays deliberately short:
it requires agents to lazy-load `safe-local-checks` before any permitted local lint or
syntax check. Advanced mode adds memory, spec-discipline, documentation-discipline,
tdd-discipline, frontend-components, engineering-constitution, and
vault-note-capture. It also includes per-language coding-style rules plus standalone
language security rules for TypeScript, Python, Go, and Swift.

The default+advanced `safe-local-checks` skill supplies the operational policy and one
managed wrapper for every repository. It resolves only already-installed local
Oxlint, ESLint, Biome, or Prettier binaries, permits full-project read-only checks with
no file-count limit, and runs them at low priority for at most three minutes; Node
syntax checks use the same deadline. Mutation, watch,
output-file, cache-writing, and analyzer-concurrency flags fail closed, and shell composition or
redirection cannot turn an allowed wrapper invocation into a write. Builds, tests, type checks,
Knip and other dependency-graph analysis, installs, servers, and authoritative
verification remain CI-only. Both Pi and Claude guards allow only the exact wrapper
path and direct blocked commands point agents to the skill; the user-only one-shot
bypass remains unchanged. <!-- @impl: preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/block-local-builds.sh::PATTERNS --> <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::isManagedSafeLocalCheckCommand --> <!-- @test: host/__tests__/safe-local-check.test.js (REQ-AGENT-052 AC6/AC7: managed safe local checks) -->

The `agents/` tree is advanced-only: architect, build-error-resolver,
code-reviewer, deep-reviewer, doc-updater, memory-capture, refactor-cleaner,
security-reviewer, spec-reviewer, tdd-guide, and vault-extract.

The `commands/` tree is advanced-only: brainstorm, debug, deploy, review, and sdd.

The `skills/` tree includes cloudflare-stack, ship (+ refs), ci-monitoring,
pr-workflow, deploy-credentials, and safe-local-checks as default+advanced skills. Advanced skills
include consult-llm, api-design, backend-patterns, content-hash-cache-pattern,
database-migrations, deployment-patterns, frontend-patterns, iterative-retrieval,
search-first, spec-driven-development (+ reference templates for /sdd init
scaffolding), sdd-init, sdd-clean, vault-operations, vault-note-capture,
spec-enforce, spec-enforce-ac, spec-enforce-truth, doc-enforce,
doc-enforce-lanes, doc-enforce-shape, doc-enforce-truth, tdd-enforce,
git-review-pipeline, graphify, and browser-run + browser-e2e. Pi owns native
reviewer and spec/doc enforcement overrides; Claude retains its original agents
and enforcement skills.

Advanced design uses `design` as the composable entry point. It routes to `ui-ux-pro-max`, `canvas-design`, the independently written `frontend-design`, and the existing `emil-design-eng`, `design-taste-frontend`, `frontend-components`, and `frontend-patterns` specialists when relevant. `impeccable` remains available for Claude + Pi only; it ships its design skill and offline detector in advanced mode, and Pi gets a dedicated verbatim copy rather than the prose-transformed lane. ([REQ-AGENT-134](../../sdd/spec/agents.md#req-agent-134-advanced-design-skill-suite))

The `plugins/` tree includes known_marketplaces.json for default+advanced mode.
Advanced-only plugins are codeflare-memory (plugin.json, memory-capture.sh,
publish-memory-capture.sh, memory-agent-prompt.md,
prefilter-transcript.sh, assert-iso-ts.sh, memory-context-inject.sh,
post-compaction-recall.sh),
codeflare-vault (plugin.json,
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
graphify-active-repo.sh, graphify-clone-prompt.sh, graph-first-nudge.sh,
safe-graphify-update.sh, and local-graphify-labels.sh.

Graphify tools ship as the native extension `extensions/graphify-native.ts` rather
than through the MCP adapter — a Pi-native first-class choice. Pi still consumes
MCP servers through the `pi-mcp-adapter`: it reaches `consult-llm` and
`chrome-devtools` through the `mcp` proxy, wired into `~/.pi/agent/mcp.json` by
`entrypoint.sh`. A default or token-less start removes restored Codeflare-owned
Browser Run registrations from Claude and Pi while preserving unrelated user MCP
servers, so an old bearer-bearing configuration cannot survive a mode or credential
change.

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

`inline-edit.ts` is the managed endpoint for [host-correlated native Pi editor results](../decisions/README.md#ad135-inline-chat-requires-one-host-correlated-result). It removes its result tool at session start, activates only that tool for `/codeflare-inline-edit`, dispatches through Pi's `ExtensionAPI.sendUserMessage`, isolates the current Inline turn suffix, and restores the exact previous tool list at settlement. OpenAI Chat Completions and Responses payloads retain only the exact mandatory result function with parallel calls disabled. Panel turns therefore retain unrestricted tools and stored conversation without loading another Pi process. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::constrainInlineOpenAiPayload --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->

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

R2 seed keys are rooted at the container user's home directory, so the
tilde-less `.pi/agent/agents/` target and `~/.pi/agent/agents/` are the same
on-disk tree: session-local overrides for `@gotgenes/pi-subagents` and
persistent user-level overrides both land there. Native Pi definitions include Explore plus the code, spec, and
documentation reviewers. Package files deploy under `.pi/agent/npm/`.

Pi-native review and CI assets are seeded with explicit ownership:

| Source file | Modes | Deployed path | Owner |
|---|---|---|---|
| `preseed/agents/pi/rules/git-workflow.md` | default, advanced | `~/.pi/agent/rules/git-workflow.md` | Root handling for extension-issued reviewer/CI launch plans |
| `preseed/agents/pi/skills/ci-monitoring/SKILL.md` | default, advanced | `~/.pi/agent/skills/ci-monitoring/SKILL.md` | CI launch contract |
| `preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs` | default, advanced | `~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs` | Request resolver and attached PR-check monitor |
| `preseed/agents/pi/agents/ci-monitor.md` | default, advanced | `~/.pi/agent/agents/ci-monitor.md` | Dedicated report-only CI subagent |
| `preseed/agents/pi/skills/pr-workflow/SKILL.md` | default, advanced | `~/.pi/agent/skills/pr-workflow/SKILL.md` | PR creation procedure |
| `preseed/agents/pi/skills/git-review-pipeline/SKILL.md` | advanced | `~/.pi/agent/skills/git-review-pipeline/SKILL.md` | Session-scoped review procedure |
| `preseed/agents/pi/rules/engineering-constitution.md` | default, advanced | `~/.pi/agent/rules/engineering-constitution.md` | Compact Pi planning, TDD/SDD, capability, and review gates |
| `preseed/agents/pi/extensions/capability.ts` + `capability-helpers.ts` | default, advanced | `~/.pi/agent/extensions/` | Registered-tool search and additive activation through Pi's public API |
| `preseed/agents/pi/skills/review-scope/SKILL.md` | advanced | `~/.pi/agent/skills/review-scope/SKILL.md` | Shared `diff`/`all` scope resolver |
| `preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs` (reaches Pi through the seed transform) | advanced | `~/.pi/agent/skills/review-scope/scripts/build-review-packet.mjs` | Ancestry-validated lane file/hunk packet builder |
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
SDD PRs targeting `main`/`master`/`develop` ([REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions)). Both use `review-scope`: PR-boundary review and
`/review --diff` inspect changed hunks plus direct invalidations; `/review --all`
and `/sdd clean --all` are exhaustive. The shared packet builder records normalized hunk ranges and follows a changed input only when its range intersects the cited symbol or test. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::changedInputIntersects --> <!-- @impl: preseed/agents/pi/skills/review-scope/SKILL.md::`scope=diff` execution -->

`/sdd init` and `/sdd clean` are root-session mutation workflows, not reviewer
invocations. The root keeps file and Git ownership; cleanup resolves the shared
scope, runs `spec-enforce` and then `doc-enforce` inline, and applies or pushes
mode-authorized changes itself. This remains true for `--unleashed`; report-only
PR-boundary reviewers are never spawned to mutate the project. This implements
[REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)
AC6 and [REQ-AGENT-037](../../sdd/spec/agents.md#req-agent-037-sdd-clean-rescue-and-autonomy-modes)
AC6.

At invocation, `/review` prefers the Git repository containing the command cwd,
including a linked worktree, then falls back to remembered active-repository state. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::recallActiveRepo -->
An executable resolver validates the root without changing valid path whitespace or
the process cwd, and the command dispatches nothing when neither source resolves. `/sdd clean` rejects invalid
scope flags and sends the resolved work-set contract. The active-repository extension
resolves shell `cd` and tool-level cwd context before boundary eligibility. It is seeded
in both modes, so default-mode CI plans do not depend on the advanced main extension.

For PR boundaries, required lanes are named only after GitHub's authoritative PR head
matches the pushed checkout; settled recovery retries during propagation. The root
launches reviewers together without inherited context, waits for each correlated successful
native notification or public result retrieval, publishes the fixed triage table in a tool-free
response, and ends that turn without mutation.

Code, specification, and documentation reviewers use the shared provider-neutral medium profile. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::thinking: medium --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::thinking: medium --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::thinking: medium --> Agent-end enforcement reads live session
state, records the full-SHA checkpoint, and emits one FIX follow-up; settled enforcement is
the idempotent fallback, and only that separate turn applies accepted findings. Delayed
terminal evidence may acknowledge its reviewed head after reload or newer unpublished work
only while that head remains authoritative. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

If the live result handler never delivered an accepted exact-head plan, the first settled pass after reload restores it once. Until that plan reaches FIX, later boundaries for the same repository, PR, and authoritative head reuse its launch decision and initiating boundary ID instead of prompting or launching again. After FIX, a newly authorized same-head cycle remains possible. Live-evaluated ineligible boundaries stay inert. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

This implements
[REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions),
[REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-native-review-result-correlation),
[REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window),
[REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery),
[REQ-AGENT-059](../../sdd/spec/agents.md#req-agent-059-pi-native-review-findings-handoff),
[REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-candidate-detection),
[REQ-AGENT-071](../../sdd/spec/agents.md#req-agent-071-pr-boundary-review-agent-dispatch),
[REQ-AGENT-074](../../sdd/spec/agents.md#req-agent-074-pi-settled-review-handoff), and
[REQ-AGENT-080](../../sdd/spec/agents.md#req-agent-080-unified-pi-pr-boundary-launch-plan).

It also implements [REQ-AGENT-110](../../sdd/spec/agents.md#req-agent-110-pi-pr-boundary-missing-launch-follow-up),
[REQ-AGENT-082](../../sdd/spec/agents.md#req-agent-082-pi-review-range-selection),
[REQ-AGENT-083](../../sdd/spec/agents.md#req-agent-083-user-invoked-pi-review-repository-context),
[REQ-AGENT-084](../../sdd/spec/agents.md#req-agent-084-reviewer-policy-contract),
[REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport),
[REQ-AGENT-087](../../sdd/spec/agents.md#req-agent-087-pi-reviewer-execution-profile),
[REQ-AGENT-088](../../sdd/spec/agents.md#req-agent-088-user-invoked-review-ownership-and-triage),
[REQ-AGENT-098](../../sdd/spec/agents.md#req-agent-098-pi-review-triage-acknowledgement-barrier),
[REQ-AGENT-126](../../sdd/spec/agents.md#req-agent-126-pi-review-checkpoint-persistence-and-head-drift), and
[REQ-AGENT-107](../../sdd/spec/agents.md#req-agent-107-deterministic-round-limit-gate),
following [AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents).

At startup, R2 sync excludes the three retired durable-review extension paths. The
managed-extension relay also removes local copies before Pi loads runtime code while
preserving user-added extensions, and backfills managed extensions missing from a
returning user's restored tree out of the mode-filtered bake so a newly shipped
extension arrives at boot instead of racing the Worker-side R2 seed
([REQ-STOR-017](../../sdd/spec/storage.md#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake)
AC4, AC6–AC7).

CI follows a distinct execution path inside the extension-issued launch plan. The
root invokes the plan's request resolver exactly once after reviewer calls and
submits its zero-or-one JSON request unchanged once. The dedicated agent runs one
attached monitor. Review acknowledgement has no CI condition, and interruption is
intentionally not recovered automatically. This implements
[REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring),
[REQ-AGENT-125](../../sdd/spec/agents.md#req-agent-125-pi-ci-result-and-launch-checkpoint),
[REQ-AGENT-080](../../sdd/spec/agents.md#req-agent-080-unified-pi-pr-boundary-launch-plan),
[REQ-AGENT-110](../../sdd/spec/agents.md#req-agent-110-pi-pr-boundary-missing-launch-follow-up), and
[AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent).

Pi extraction is driven by `prompts/memory-agent-prompt.md` and `prompts/vault-extract-prompt.md`. The root reads Pi's durable transcript, filters synthetic prompts, creates request-specific snapshots, and emits visible public background requests instead of using the private subagent service.

Each launch shows a job/delivery summary followed by pretty-printed `<extraction-items-json>` whose request items exactly match durable details metadata. Standard JSON `\n` escapes inside `prompt` decode to line breaks when the public call is submitted; terminal wrapping does not alter the value.

Generated agents and emitted requests use provider-neutral medium reasoning, Bash-only evidence, and four turns ([AD102](../decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional), [AD103](../decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs)).

`memory-vault.ts` owns delivery and high-water state. `/tmp/.memory-counter/<sessionId>.vars` and `vault-extract.pi.vars` are active request-ID pointers for reload discovery.

`memory-inject.ts` is the Pi counterpart of the Claude `memory-context-inject.sh` hook: on the first real prompt of a session it extracts keywords from that prompt, scores the unified graph's nodes against them, and returns the top matches as a turn message from `before_agent_start` — the event that sits where the hook's `additionalContext` sits. Keyword rule, ranking weights, node cap, rendered shape and the atomic one-shot sentinel under `/tmp/.memory-counter/` are identical to the hook's; a query that matches nothing leaves the sentinel unspent so a later prompt can still inject. It skips child sessions and synthetic prompts, which the hook runtime never delivers. <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::registerMemoryInject -->

The unified graph is the only source either runtime queries: at the moment this fires no per-repo graph exists yet, and once one does the merger has already folded it into the unified graph, so a repo graph is never a substitute — only a smaller subset. The graph is parsed whole, so a size ceiling guards memory rather than latency, and it is a lever (`MEMORY_INJECT_MAX_GRAPH_BYTES`) so a graph that outgrows the default cannot silently disable injection. <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::registerMemoryInject -->

`post-compaction-recall.ts` covers the compaction boundary that first-prompt injection cannot reach, the Pi counterpart of the Claude `post-compaction-recall.sh` hook described above. It listens on `session_compact` and sends the digest as a custom message with `display` off, delivered as a follow-up without triggering a turn, so the recall persists in the session rather than surviving a single request. Child sessions are skipped on the same header check `memory-vault.ts` uses: a subagent's narrow context must not receive whole-session history. Selection, bounds and injected wording are held identical to the Claude hook; the two runtimes carry separate implementations only because their injection surfaces differ. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::registerPostCompactionRecall -->

The whole handler is fail-silent — a failure in the child-session check, the digest build or the delivery is swallowed rather than raised, because it runs inside Pi's dispatch at the compaction boundary, where the session is least able to absorb a throw, for a feature that is a convenience. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::registerPostCompactionRecall -->

Public prompts receive immutable home-backed cache snapshots named `memory-capture.<sessionId>.<requestId>.vars` or `vault-extract.pi.<requestId>.vars`. `memory-vault.ts` derives the request-specific home-backed path and can discover an active legacy pointer before retry; the [extraction data flow](architecture.md#pi-memory-and-vault-extraction-data-flow) shows the ownership boundary. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memoryExecutionVarsPath --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::readActiveMemoryRequest -->

Root-session JSONL determines exact public-call attempts, native completion, reminders `0..5`, and GIVEUP. An emitted request with no matching call remains one pending delivery, so repeated settlements and reloads emit neither duplicates nor GIVEUP. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts -->

Each failed exact call advances one reminder. Six failed calls emit a structured GIVEUP summary with unchanged committed state and job-specific re-arm conditions. Background agents never write counters, pointers, or manifests. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue -->

Memory capture triggers at the 15-real-prompt cadence and force-captures a resumed durable transcript when no counter exists. Request snapshots contain text turns inline in `VARS_FILE.transcript`, bounded by a fixed character budget and a per-turn cap; they never reference an `INPUT_FILE` or separate transcript path. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_EVERY_N_PROMPTS --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_CAPTURE_MAX_TOTAL_CHARS --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_CAPTURE_MAX_TURN_CHARS -->

The public request and generated agent repeat that input boundary. Exact success plus the post-commit note and request chunk lets the root advance the frozen counter and remove only matching state.

Vault indexing retains the shared content-hash format and exclusion set. It promotes a request-specific pending manifest only after exact success and hash validation; prelaunch edits coalesce, while during-run edits produce one follow-up ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages), [REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).

Both prompt contracts read immutable inputs once, write a request-specific work chunk, and require one 300-second lock spanning cumulative merge and global publication. Pi session capture derives that chunk with the advanced-only `scripts/build-memory-graph.py` asset rather than model-authored graph JSON, keeping semantic IDs deterministic. <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::flock --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::flock --> <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::main -->

Both runtimes' byte-identical merge script normalizes serialized edge tuples after Graphify conversion and writes the cumulative bytes to `vault-graph.json`, then copies them to the sibling `graph.json` that feeds the local visualization; only `vault-graph.json` is read back on the next merge and published as `user_vault`. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::main --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::main --> Canonical chunks appear only after publication and qualify root finalization; required failure leaves high-water state unchanged. Visualization is best effort with a 15-second ceiling.

Pi subagents are provided by `@gotgenes/pi-subagents`; the generator adapts
  Claude agent definitions into `.pi/agent/agents/*.md`. The container image
  preinstalls Pi extension npm dependencies into an image-local cache, and
  entrypoint copies that cache into `~/.pi/agent/npm` after R2 restore.

<a id="multi-agent-preseed"></a>
## Agent-Specific Projection

The generator produces adapted config files for all supported agents
from CC's preseed as the default source of truth. Pi-specific runtime contracts
that must differ from Claude, such as `git-workflow` and `ci-monitoring`, live as
native Pi manifest entries instead of transformed Claude files.

Shared operational policy remains canonical under `preseed/agents/claude/`.
`scripts/generate-agent-seed.mjs` keeps monolithic transformed instructions for Codex,
Copilot, OpenCode, and Antigravity. Pi instead receives a compact `AGENTS.md`:
path-scoped canonical rules become five grouped native skills, rules already owned by a
canonical skill are not duplicated, and long-form environment/coding/Graphify/build principles
are condensed into the Pi-native constitution.

The Pi-native Git/constitution adaptations retain Pi-only event mechanics. Shared review mechanics live once in the Git workflow while the
constitution retains its push, CI-result, and non-blocking gates. The review push
gate remains in that generated Pi instruction surface: do not push while a PR-boundary review is running, pending, missing, stale, or otherwise
incomplete for the current head unless the user explicitly authorizes it. Implements
[REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)
AC7 and [REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents).

`scripts/measure-seed-tokens.mjs` reports managed seed text; after materialization,
`scripts/measure-pi-runtime-context.mjs` uses Pi's real resource loader and local faux
provider to measure the complete first-turn input, including active schemas and extension context.

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

**Runtime parity:** Claude Code and Pi receive the same supported workflow families, with intentional differences in commands, transport, PDF handling, provider tools, and transformed exclusions.

Claude Code uses its native rules/agents/commands/skills/hooks/plugins. Pi uses a compact
always-on rule kernel, progressively disclosed adapted skills/agents, and native TypeScript
extensions that reimplement the CC-only surfaces: slash commands, hooks, memory capture,
and review enforcement. High-frequency proactive skills stay in Pi's startup catalog;
only command/event/reviewer-owned internal skills carry `disable-model-invocation: true`;
proactive skills remain model-visible with concise trigger-preserving Codeflare descriptions; upstream skill metadata remains unchanged. The native
`capability` tool keeps basic/question/Graphify tools active initially and activates other
registered tools additively. PR-boundary and memory/Vault owners activate `subagent` before
emitting their unchanged public follow-ups.

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

### Settings.json Merge

Implements [REQ-AGENT-099](../../sdd/spec/agents.md#req-agent-099-agent-settings-and-plugins-assembled-at-container-start) AC1, AC2, AC4, AC5.

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

`entrypoint.sh` holds two `SETTINGS_CONFIG` literals, one per session
mode. Only the Pro (advanced) literal carries a `hooks` key, so the
codeflare-owned PreToolUse, PostToolUse, Stop, and UserPromptSubmit
registrations reach Pro sessions only -- default (Standard) mode
merges a literal with no `hooks` key at all.

Both `SETTINGS_CONFIG` literals also set `"disableAgentView": true`
(the rationale below is repeated as a comment above the advanced-mode
literal in `entrypoint.sh`). Claude Code otherwise replaces the
terminal with a full-screen agent view — a dispatch input plus a
left/right session switcher — whenever a background agent starts, and
that switcher is unusable on a mobile terminal (upstream behaviour,
observed under Claude Code 2.1.219 as pinned by `CLAUDE_CODE_VERSION`
in the `Dockerfile`, on 2026-07-25).

Background subagents themselves keep running under that setting, so
the memory and vault capture hooks registered in the `SETTINGS_CONFIG`
literal above are unaffected. Nothing automated covers that: it was
checked by hand under the same pinned Claude Code version on
2026-07-25, by spawning subagents in a session with the setting on.
The capture hooks depend on it and it would fail silently, so re-check
it when `CLAUDE_CODE_VERSION` moves.

### Plugin Enablement

(Implements [REQ-AGENT-099](../../sdd/spec/agents.md#req-agent-099-agent-settings-and-plugins-assembled-at-container-start) AC3, [REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session).)

`entrypoint.sh` merges `enabledPlugins` into `~/.claude/.claude.json`
to enable both the `codeflare-memory` and `codeflare-hooks` plugins.
This is permanent (not mode-gated) because missing plugins are
silently skipped by Claude Code -- when the plugin files are absent
in default mode, the plugins simply don't load. Plugins are used for
file organization and delivery via R2 sync only -- hook registration
is done via `settings.json` (see above).

- **codeflare-memory**: Two UserPromptSubmit hooks and one SessionStart hook
  registered in settings.json, scripts delivered via plugin.

`memory-context-inject.sh` fires on the first prompt of each session: extracts
keywords, queries the unified graphify graph, and injects matched nodes as
additionalContext before the agent responds
([REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt)).
`memory-capture.sh` handles the ongoing 15-prompt capture cadence.

`post-compaction-recall.sh` is registered on SessionStart under matcher
`compact` and injects the Context and Decisions sections of the five most recent
session extracts from `~/Vault/Raw/Sessions/`
([REQ-MEM-019](../../sdd/spec/memory.md#req-mem-019-post-compaction-recall-of-recent-session-extracts)).
It exists because compaction keeps the session id, so the first-prompt sentinel
in `memory-context-inject.sh` is already claimed and that hook cannot fire again
— leaving the agent resuming from a summary with prior decisions and identifiers
gone.

Recency is the instant an extract was captured, parsed out of the ISO-8601
timestamp and UTC offset its filename carries. Claude and Pi both emit
`YYYY-MM-DDTHH-MM-SS±HHMM-<8-character-session-id>.md`, so either runtime's
captures enter the same selection. Modification time is unusable because the
vault round-trips through rclone bisync, which rewrites it, and the name read as
text is unusable because a UTC-offset change puts a later capture behind an
earlier one. `PostCompact` is not used: it carries no decision control and
cannot return `additionalContext` ([REQ-MEM-019](../../sdd/spec/memory.md#req-mem-019-post-compaction-recall-of-recent-session-extracts) AC2).

Three mechanics in the digest builder are load-bearing and identical in both
runtimes. Section headings are recognised only outside fenced blocks, and fences
are matched by backtick run length rather than toggled on any backtick line — an
inner fence would otherwise close its parent, after which every later heading
goes unrecognised and the Decisions section the recall exists to carry is
silently dropped.

The per-extract cap is spent in encoded bytes and cut on a
character boundary, because bytes are what the context actually costs; the
truncation notice is paid out of that same budget and dropped rather than
carried when the remainder cannot hold it, so the cap is never exceeded in order
to announce that it was reached ([REQ-MEM-019](../../sdd/spec/memory.md#req-mem-019-post-compaction-recall-of-recent-session-extracts) AC4–AC5).

Extracts sharing a capture instant are ordered by name descending, so both
runtimes resolve a tie the same way instead of
inheriting whatever order the filesystem offered ([REQ-MEM-019](../../sdd/spec/memory.md#req-mem-019-post-compaction-recall-of-recent-session-extracts)).
- **codeflare-hooks**: Scripts for commit attribution blocking,
  git-push review reminders, and SDD review-agent enforcement.

Claude review dispatch is non-blocking: required code, spec, and documentation
lanes spawn independently. Its Stop hook waits for every required lane's transcript
completion; no lane depends on another lane's transcript. Claude in-flight
suppression remains per lane, so a fresh in-flight lane does not mask missing peers.

Each Claude PR reviewer exposes only Bash. Its canonical review policy is embedded in the agent definition, and it uses bounded Bash/Node packet transport without file mutation or external consultation. Reviewers return complete structured reports; the root persists triage content and applies fixes.

`/review` follows the
same ownership boundary without adding agent types: its existing `refactor-cleaner`,
`tdd-guide`, and `deep-reviewer` definitions treat `review_mode=report-only` as a
binding override of their normal write/output behavior. Claude and Pi review
subagents return every phase report; the root writes those artifacts and owns
external verification, triage history, ADR updates, issue creation, and approved
fixes. Doc-updater remains report-only; the root may retain a substantive coverage record in the applicable commit body or lazily create `documentation/.doc-coverage.md`, but no scaffold placeholder is created. This implements [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review),
[REQ-AGENT-050](../../sdd/spec/agents.md#req-agent-050-pi-native-review-workflow-skill),
and [REQ-AGENT-086](../../sdd/spec/agents.md#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff).

The PostToolUse nudge and Stop hook share `scripts/lib/lane-classifier.sh`. The nudge records the unacknowledged head it emitted so later commands cannot repeat the launch reminder; the Stop hook remains the enforcement fallback and injects FIX only after the root ends its mutation-free triage turn. Generated-only `graphify-out/` diffs require no review lanes and are auto-acked with a durable audit event; generated artifacts never suppress review for mixed diffs. Doc-only pushes spawn only `doc-updater`; `sdd/`-only pushes spawn `spec-reviewer` and `doc-updater` in parallel; source pushes spawn all three.

A source delta the shared `inert-source-delta.mjs` prover proves is comments and whitespace only spawns `code-reviewer` alone, plus any `sdd/` or `documentation/` lane the same diff independently earns. When source cannot be proved inert, the code lane remains required; prover uncertainty does not invent spec or documentation ownership. Non-SDD projects fire no review agents.

Each tool-gated hook is registered on two matcher entries covering three
tool names: the `Bash` matcher (with `Bash(git *)` and `Bash(gh *)`
predicates) and the pipe-alternated MCP matcher
`mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute`.
This keeps attribution blocking and push detection effective whether
context-mode is active or not. Implements
[REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC3 and
[REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) AC1+AC2+AC4-AC7.
Hooks registered in settings.json, scripts delivered via plugin.

### Third-party plugin: context-mode

[context-mode](https://github.com/mksglu/context-mode) is registered as a Claude Code MCP server (`ctx_*` helper tools) where that runtime enables it. Pi installs and enables context-mode by default through the managed foreground owner. `/ctx off` disables the package for the current running container and reloads resources; `/ctx on` enables it again. The next Codeflare container start returns Pi to the enabled default. See [REQ-AGENT-076 AC1-AC2](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults). <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::handleContextModeCommand -->

The npm package is installed and patched at image-build time in both the global Claude MCP tree and Pi's prewarmed package tree, so first invocation performs no package fetch. Entrypoint registers the Claude MCP server for every user. Custom-tier (`unlimited` subscription) delivery adds the plugin hooks, while Pi enables the package through its managed foreground owner by default and retains `/ctx off` as a per-container opt-out. The package source is pulled from npm rather than vendored. <!-- @impl: Dockerfile::CTX_DIR --> <!-- @impl: entrypoint.sh::CONTEXT_MODE_MCP_CONFIG -->

Claude's three PR reviewer definitions are Bash-only report lanes with embedded policies and no write surface. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::tools -->

Reasoning effort is pinned to `medium` for all three Claude reviewer lanes, and the generator strips the Claude-only `effort` key from every transformed runtime ([REQ-AGENT-086](../../sdd/spec/agents.md#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff) AC6). <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter -->

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

- The shared image-tools copy used by Claude.
- The Pi runtime's prewarmed copy at `/opt/codeflare/pi-agent/npm/node_modules/context-mode`.

Pi loads that prewarm tree as `npm:context-mode@<ver>` through a runtime symlink.
`scripts/patch-context-mode-bundles.mjs` first validates both installed versions
against the plugin pin, then repoints the probe URL in both bundles to a refused
local address. The version resolves to `"unknown"`, no "Update available ...
ctx_upgrade" notice renders, and no outbound npm registry traffic is generated.

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC5.

context-mode is licensed under [Elastic License 2.0](https://github.com/mksglu/context-mode/blob/main/LICENSE).
The integration is sized to stay within ELv2's permitted-use envelope.
See [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) for the full design + license analysis.

<a id="graphify-req-agent-023"></a>
## Graphify Toolchain ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify))

Graphify 0.9.34–0.9.35 is a correctness update: shortest paths and callflow now respect stored edge direction, ignored-file pruning and merge shrink protection fail closed, and Java external annotations no longer collapse into local classes. The owned Claude and Pi query references preserve directed traversal as the default and never reinterpret an absent reverse path as permission to walk edges backwards.

### Graph-first soft nudge ([REQ-AGENT-091](../../sdd/spec/agents.md#req-agent-091-advanced-session-graph-first-runtime-reminders) AC1)

In advanced session mode, `graph-first-nudge.sh` gives a non-blocking reminder before grep-class tool calls when a repository graph exists. Matchers cover native `Grep`/`Glob` and the context-mode grep equivalents. Prompt-aware first-turn memory remains owned by [REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt); no prompt-independent graphify startup summary is installed.

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

Graphify deliberately uses first-party native Pi tools rather than routing through Pi's separately installed MCP adapter. Codeflare exposes `graphify_query`, `graphify_path`, and `graphify_explain` through `graphify-native.ts`; the extension shells the same upstream `graphify` CLI used by Claude's MCP server and passes the resolved `--graph` path explicitly.

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
- Graphify's cache helpers persist those chunks, with each write restricted to the current `.graphify_uncached.txt` file set so an out-of-scope model attribution cannot replace another file's cache entry.
- Local Graphify module flows merge, build, cluster, and report output.

Community naming is optional in both Pi and Claude ([REQ-AGENT-127](../../sdd/spec/agents.md#req-agent-127-graph-publication-artifacts-and-optional-labels)). When requested, the active
agent session writes `.graphify_labels.json` and regenerates report/html from the
existing community assignments, never `graphify label` or provider backends. When
skipped, Graphify's official report/html remain publishable and no labels file is
required.

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
recloned. Durable graph commits include `graphify-out/graph.html` and
`graphify-out/callflow.html`; labels are applied first only when community naming
was requested.

Model selection is runtime-specific. Claude Code's graphify skill pins its own reliable extraction model and never escalates to Opus from this workflow. Pi does not name or pin provider-specific models: Pi `Agent` semantic subagents omit a `model` override and inherit whatever model the main Pi session is using unless the user explicitly asks for a different model.

Subagents are dispatched in bounded waves to avoid flooding agent concurrency. Each wave runs in parallel; waves are sequential. Chunk count scales with the size of the non-code corpus.

### Git persistence ([REQ-AGENT-026](../../sdd/spec/agents.md#req-agent-026-knowledge-graph-persistence-via-git))

Graphify repo outputs persist in git when the user can push to the repository.
The durable committed surface is:

- `graphify-out/graph.json` — queryable graph data, with `.gitattributes` wiring `graphify-out/graph.json merge=graphify`
- `graphify-out/GRAPH_REPORT.md` — human-readable graph report
- `graphify-out/graph.html` — interactive visualization, using optional named communities when `.graphify_labels.json` was requested
- `graphify-out/callflow.html` — generated call-flow visualization
- optional `.graphify_labels.json` when the user requests community naming
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

<a id="sdd-init-modes"></a>
## SDD Bootstrap Contract

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

**Documentation emission.** Greenfield and Import Mode use the same bundled lane renderer after source discovery selects the applicable canonical lanes and any source-backed first-level project lanes. Architecture and the ADR ledger remain universal; API, Configuration, Deployment, Security, Observability, and Troubleshooting emit only when evidence supports them. The `/sdd init` caller supplies a fresh sibling staging path outside the live documentation tree; the renderer rejects an existing destination, stages only selected files and matching index rows, and removes partial output after a rendering failure. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Phase 6 — Documentation lane emission and audit (binding) --> <!-- @impl: preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs::renderDocumentationTemplates -->

The agent fills the staged files from verified evidence and promotes them under the existing full-draft acceptance; Import Mode backs up the live tree before the checked replacement and restores it if post-promotion validation fails. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Phase 6 — Documentation lane emission and audit (binding) --> <!-- @impl: preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs::renderDocumentationTemplates -->

The same templates are the normalization target for `/sdd clean`. Cleanup operates on positively recognized collections and defers when a clause, diagram, link, compatibility fragment, requirement, decision, or source anchor cannot be moved losslessly. Project-specific lanes retain their natural subject structure inside the shared audience, ownership, navigation, evidence, and related-document envelope. Implements [REQ-AGENT-139](../../sdd/spec/agents.md#req-agent-139-optimized-documentation-lane-rendering-and-delivery) and [REQ-AGENT-140](../../sdd/spec/agents.md#req-agent-140-lossless-documentation-lane-cleanup-and-enforcement).

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
- **Glossary-seed pass** - `mcp__graphify__query_graph` for concept-tagged nodes (graphify emits these with `source_file: null`); each becomes a one-line glossary entry in `sdd/spec/glossary.md`. Synonym clusters land in `documentation/README.md`'s synonym glossary slot.

No additional user prompts during the enrichment cycle. When the graphify graph is missing at enrichment time (rare - the post-clone hook offered to build one), `/sdd init` prompts the user once for `/graphify cluster-only` (AST-only, free); on decline, enrichment falls back to an in-memory heuristic (literal-string matching across the draft) with a one-line notice in `sdd/spec/changes.md` recording reduced cross-link density. The `mcp__graphify__*` MCP tools are tool-agnostic and work identically under both Bash and context-mode (`mcp__context-mode__ctx_*`) environments.

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
2. Appends a closure entry to `sdd/spec/changes.md` recording totals (accepted / corrected / lost)
3. The agent enters Plan Mode -- the first feature work on the now-real spec is plan-gated

`enforce_tdd` is NOT touched by the closure commit. The user changes it manually when ready for TDD enforcement (typically after adding REQ-ID references to test names in the imported source).

Full SDD discipline applies on the next push; autonomous agentic development is unlocked. `sdd/.init-triage.md` is preserved as the audit record. Implements [REQ-AGENT-033](../../sdd/spec/agents.md#req-agent-033-sdd-init-scaffolding-and-canonical-render) (`/sdd init` two-confirm flow + canonical render + review-queue pre-create), [REQ-AGENT-034](../../sdd/spec/agents.md#req-agent-034-sdd-init-enrichment-pass-with-graphify) (enrichment pass), [REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC2 (tool-surface portability), [REQ-AGENT-022](../../sdd/spec/agents.md#req-agent-022-legacy-codebase-import-mode-discovery) (Import Mode discovery), and [REQ-AGENT-045](../../sdd/spec/agents.md#req-agent-045-import-mode-triage-queue-and-transition-state) (triage), [REQ-AGENT-092](../../sdd/spec/agents.md#req-agent-092-import-transition-review-suppression) (transition review suppression), and [REQ-AGENT-093](../../sdd/spec/agents.md#req-agent-093-import-mode-tdd-status-assignment) (status defaults).

**GitHub corpus degradation.** When Import Mode cannot reach GitHub (non-GitHub remote, `gh auth status` failure, rate-limited, air-gapped), discovery falls back to working-tree + git-log evidence only. A one-line notice naming the reason is appended to the `sdd/spec/changes.md` import entry; triage Context fields reference whatever artifact refs are reachable.

<a id="troubleshooting"></a>
## Failure Diagnosis and Recovery

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

The Claude `Stop` hook (`enforce-review-spawn.sh`) only fires in advanced mode when `sdd/` and `sdd/README.md` are present. Any executable `git` or `gh` command is a cheap candidate in both hooks. The Stop hook additionally marks the delivery ones (`git push`, `gh pr create`, `gh pr merge`) and measures lane coverage from the last of those rather than the last candidate, because an anchor that moves on a read-only call silently uncovers a round whose lanes already returned ([AD121](../decisions/README.md#ad121-a-review-boundary-is-a-delivery-subcommand-not-any-git-invocation)). <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/boundary-classifier.cjs::boundaryEvent --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::COVERAGE_LINE -->

Both emit or enforce review only when the normal checkout's current branch has an open `main`, `master`, or `develop` PR whose authoritative head exactly equals local `HEAD` and differs from that PR's checkpoint.

The Stop hook runs two fail-safes in order, not one compound test, because either input can leave the scan empty for a different reason and a single condition got both wrong. First, an unreadable transcript refuses the turn with `exit 2` and a message naming it, unconditionally: a delivery inside a file nobody could read cannot be ruled out.

Only against a transcript that was actually read does the second fail-safe run, so a missing or unreadable `lib/boundary-classifier.cjs` refuses with `exit 2` and a message naming the file rather than reading an empty scan as "no delivery seen". That second refusal is limited to transcripts mentioning `git` or `gh` at all, because a turn with nothing to classify has no candidate whatever state the classifier is in, and the fail-safe contract in the script's own header forbids locking a session out over a plugin it never reaches for. Both are `Stop`-only; the `PreToolUse` path returns before them. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::TRANSCRIPT_SCAN -->

A synchronized closed or merged head never launches review: the Stop hook stays silent when its checkpoint matches, otherwise it emits one visibility notice without writing acknowledgement or consuming the one-shot bypass. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::CURRENT_PR_HEAD --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::CLOSED_NOTICE_FILE -->

The same script is additionally registered under `PreToolUse` (empty matcher, all tools) as the mid-turn triage gate ([REQ-AGENT-104](../../sdd/spec/agents.md#req-agent-104-review-acknowledgement-requires-a-published-verdict) AC7). Once every review lane spawned in the transcript has a completed notification and no canonical triage table follows the last of them, `Read`, `TaskOutput`, `TaskGet`, `TaskList`, `Grep` and `Glob` pass through unconditionally, and a `Bash` or `ctx_execute`-family call passes through unless it runs `run-review-lane.sh` or carries a `git push`, `git commit`, `gh pr create` or `gh pr merge` in command position; every other tool call is refused with a one-line reminder until the table is published.

The command test is a shell-aware parse, not a pattern match: the gate and the Stop-side transcript scan both call `lib/boundary-classifier.cjs`, which tracks command position through quoting, command substitution, heredocs, herestrings, environment assignments, wrappers and their option values, paths, and shell wrappers, which take their command as a string rather than as words — including a herestring's glued form (`bash <<<"git push"`, since `<` is not a word-break character here) and an fd-prefixed operator (`bash 0<<<"git push"`), matched for any descriptor on fail-closed grounds — and so need that string parsed in turn.

So `git -C /repo push`, `GIT_SSH_COMMAND=x git push`, `sudo -u me /usr/bin/git push`, `if false; then :; else git push; fi` and `bash -c "git push"` are refused, while `grep "; git push" file` and `gh run view` are not.

An unreadable payload or a classifier that will not run is refused rather than assumed harmless, because "no delivery verb seen" and "could not look" are different answers.

`git commit` counts for the gate and not for the Stop path, which asks only about delivery boundaries. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/boundary-classifier.cjs::boundaryOf --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::CLASSIFIER_LIB --> The window denies what would spoil the round, not investigation: judging a finding often turns on something only execution can settle ([AD124](../decisions/README.md#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block)).

A transient `gh` API failure during the PR-state check does not strand a live round: the hook caches the last successful `gh_pr_state` answer per branch and reuses it, but only while that PR's plan file is on disk and only for failures gh does not answer authoritatively. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::PRINFO_CACHE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/gh-pr-state.sh::gh_pr_state -->

Since gh returns exit 1 for both "no PR" and a generic API error, `gh_pr_state` reads gh's stderr and remaps a non-not-found exit 1 to a distinct transient code, so only the authoritative answer keeps the old fail-safe silence — as does an idle branch, and a superseded cache is neutralized by the head-equality gate. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::PRINFO_CACHE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/gh-pr-state.sh::gh_pr_state -->

When `mktemp` itself fails there is no stderr to read, so `gh_pr_state` cannot tell "no PR" from an error and conservatively reports the transient code (3) instead — the same fail-safe default the stderr-read path falls back to whenever it cannot positively match the not-found phrase, consistent with the fail-safe bias. Cleanup of the capture file is normal-path only: a killed hook can strand one tiny file in the container-lifetime `TMPDIR`, accepted because a sourced library must not own process-global signal traps. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/gh-pr-state.sh::gh_pr_state -->

Stop directives are delivered on stderr with exit 2, not as a JSON `{"decision":"block"}`. Either JSON block or a bare exit 2 is recorded as a blocking error, and the client answers a blocking error by pushing an immediate notification reading "Stop hook error occurred", so every directive this gate issued — all of them working as designed — announced itself to the user as a failure. The notification is where that word came from, not the message body, which the Stop formatter already labels "Stop hook feedback".

Exit 2 against a hook entry carrying `asyncRewake` takes the rewake path instead, and the difference is structural rather than cosmetic: the hook is backgrounded and the runner returns before an exit code exists, so no blocking error is recorded and the notification has nothing to fire on. The model is woken with the entry's `rewakeMessage` followed by the hook's stderr, and the entry's `rewakeSummary` names the line the user sees. The registration in `entrypoint.sh` must carry both, since the handler's own defaults are "Stop hook blocking error from command" for the woken text and "Stop hook feedback" for the user's line.

Two constraints follow: the woken text is stderr-or-stdout with stderr first, which is why a stray shell message on that channel would prefix the directive; and the background path never parses stdout, so a `systemMessage` from this hook is dropped and the per-round notices the user sees come from the synchronous hooks instead. The full FIX contract is delivered once per PR and every later round gets a one-line form that keeps the load-bearing clauses. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::FIX_SHOWN_FILE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::emit_block -->

Background work announces itself through `systemMessage`, the one hook field the client renders straight to the terminal without routing it to the model. The PostToolUse push hook names the round it just opened — PR, head, how many lanes, which ones, and the range they were given — all read from the counts the directive was built from, so a doc-only push announces one lane rather than three; the consent path stays silent because it is about to raise an `AskUserQuestion`. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::NOTICE -->

The UserPromptSubmit memory hook names each launch with its live attempt number and says so when a request is abandoned, which is what makes a run of retries visible at all. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::NOTICE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::emit_context -->

The gate applies to the main session only. Claude Code fires `PreToolUse` for a subagent's tool calls exactly as it does for the main agent's, and hands them the parent's `transcript_path`, so an unscoped gate reads the main session's review state and refuses a subagent work it takes no part in. A subagent payload carries `agent_type` and `agent_id` while a main-agent payload carries neither, so the script exits on the presence of `agent_type` before any transcript or sentinel handling; a subagent therefore also cannot consume the one-shot bypass the main session is owed. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::AGENT_TYPE -->

The verdict contract mirrors the Pi runtime's, with a Claude delivery barrier at the asynchronous boundary. A terminal background record can be appended while the root model request is already running, before its native notification reaches that model. The first Stop observation of a newly complete round therefore ends silently; only a later Stop may demand triage. Missing reports remain retrievable with `Read` or `TaskOutput`, and only the final table is published as a tool-free message. The Stop hook then acknowledges the reviewed head and drives the following FIX turn. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::triage_published_after_line --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::write_acknowledgement -->

Recognition stays permissive (a table that persisted beside tool calls still counts, since refusing it could only wedge the session), and both runtimes key on one table shape, so a verdict is portable between them.

The gate caches its allow decision as a completed-notification count, a marker-length-rewound byte offset, and a 4KiB prefix fingerprint, so after a cleared round each tool call costs one size check plus a scan of only the appended transcript bytes — a rewritten or compacted transcript fails the fingerprint and takes the full pass instead of failing open. It never writes acknowledgement or counter state, reads `/tmp/review-bypass` without consuming it, and releases after five refused calls for the same round (an unwritable strike counter fails open rather than wedging).

**Lane transport (headless subprocess).** Each required lane runs as a headless `claude -p` subprocess launched via `bash ~/.claude/plugins/codeflare-hooks/scripts/run-review-lane.sh --lane <name> --boundary-pr <number> [--range <base>..<head> | --base <ref>]`. At a PR boundary, the runner reads that PR's checkpoint and normalizes its effective scope to the acknowledged ancestor through current `HEAD`; an accidental `--base` therefore cannot reopen the full PR, and an already acknowledged head invokes no model. The lane's own agent document (`~/.claude/agents/<name>.md`) is supplied as `--system-prompt`, with `--tools Bash` as the only granted tool ([REQ-AGENT-102](../../sdd/spec/agents.md#req-agent-102-claude-reviewer-headless-lane-transport)).

An in-session subagent cannot be made cheap. Claude Code injects CLAUDE.md, every `~/.claude/rules/*.md`, MEMORY.md and the SessionStart blocks into every subagent with no per-agent exclusion, measured at a 20,513-token floor before the lane does any work. Replacing the system prompt and pruning tool schemas — both CLI-only controls — brings that to roughly 1,533. Because every turn re-sends the whole prompt, that floor is paid per turn, not once.

`--setting-sources ""` also drops hooks, so the container guards (`block-local-builds.sh`, `block-attributed-commits.sh`) are re-injected via `--settings` and invoked as `bash <script>`, because the seeded hook scripts ship non-executable and a bare path fails silently.

A lane that owns no changed file in the range short-circuits before the model is invoked, costing zero tokens; the same ownership question the classifier already answers is simply asked again for free. Any uncertainty — unreadable range, missing classifier — falls through to a full review rather than silently skipping one.

The round is user-visible and blocking. A successful push or PR creation auto-launches it without renewed consent. If that PostToolUse directive is missed, a later candidate command still auto-recovers the loop when the exact synchronized head is a descendant of that PR's PR-specific acknowledgement. The repository-global legacy fallback may still scope a user-confirmed review but never proves same-PR continuation; an unrelated existing head remains confirmation-required, and the agent presents that choice neutrally without treating self-verification as review. The directive requires the root session to print an overview before the lanes run, naming which lanes are about to run, why the others were excluded, and the exact range. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE -->

It then issues the lane calls and **ends its turn**, doing nothing else until every lane has returned. Only then does it publish the fixed triage table with one row per finding across all lanes. A fully clean round publishes the header and divider without synthetic clean-lane rows. That tool-free response ends the turn. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE -->

The Stop hook acknowledges the head and injects the separate FIX directive for the following turn. The FIX directive applies only accepted rows; when they change files it verifies focused static checks, commits, and pushes the checked-out PR branch without asking. Stating that condition in a rule instead was the weaker half of the same idea: a hook directive outranks a standing rule, so with no order in the directive the round stopped after the commit and waited to be prodded.

If this head's terminal CI result has not landed, the FIX turn waits for it, so the in-flight run finishes rather than being discarded. The wait is a gate, not just a delay: a failing result is a finding, fixed in the same commit, and a head whose CI failure is unaddressed is never pushed. An absent result is the other case, and it can only delay the push: no CI monitor for this head, or a log that has not advanced since the last read, means the FIX turn pushes now ([AD123](../decisions/README.md#ad123-the-claude-fix-directive-owns-delivery-pi-leaves-it-to-standing-rules)).

That push is the delivery boundary that launches one incremental reviewer wave and one CI monitor. The FIX turn never merges, and a round with no accepted fix creates no commit and pushes nothing.

A delivery landing while the authoritative head is still synchronizing is not treated as ineligible: `git-push-review-reminder.sh` retries the `gh pr view` query at bounded delays before conceding, so a push observed inside the API's lag window still opens its round once the head catches up, and gives up silently only if it never does. Only a delivery retries; ordinary Git activity pays no wait. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::RETRY_DELAY -->

Retroactive checkpoint recovery never claims the current head, because only the live path attaches the fix handoff to an acknowledgement ([REQ-AGENT-121](../../sdd/spec/agents.md#req-agent-121-checked-out-branch-boundary-synchronization) AC4-AC5; [REQ-AGENT-141](../../sdd/spec/agents.md#req-agent-141-authoritative-head-review-launch-continuity) AC4). <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::RETRY_DELAY --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::RETRO_SHA -->

The directive previously required the opposite: `[silent]`, "Do NOT mention these lanes to the user". That contradicted the constitution's review-result handoff gate, which has always required a user-facing summary, and it made an autofix arrive as an unexplained edit. The end-of-turn is what keeps the round legible — a lane result landing in the middle of unrelated work gets interleaved with it, and the reader loses the thread of what was actually reviewed.

A lane's Phase 0 triage and its review packet are both resolved before the subprocess starts and inlined into its opening prompt ([AD116](../decisions/README.md#ad116-review-lane-phase-0-is-computed-deterministically-and-handed-to-the-lane)). Triage covers SDD bootstrap and layout, the config, transition state, the round counter, and the bulk-op audit — six deterministic questions that were previously six sequential Bash calls and therefore six turns.

A triage-proven no-op (no bootstrap, an active transition, a round limit) returns without invoking a model, on the same zero-token contract as the ownership short-circuit. Lane ownership itself is still computed by the shell classifier and passed in, never reimplemented, so one source of truth for it remains. Triage output is authoritative only after JSON syntax and the lane/decision/layout shape validate; a partial write, crash envelope, wrong lane, or malformed shape is discarded so the reviewer derives triage itself. Triage failure is fail-safe in one direction only: an unreadable config, a git error, or a crash resolves to running the full review, never to skipping one.

The subprocess is bounded at `REVIEW_LANE_TIMEOUT` seconds (default 1800), because a lane that never returns holds the review gate open. The bound is validated rather than merely defaulted: `timeout 0` means "no timeout at all", so a zero, empty, or non-numeric override resolves back to the default instead of removing the bound. If `timeout(1)` itself is unavailable, the runner refuses to launch instead of creating an unbounded lane. Expiry escalates to `SIGKILL` 30 seconds after `SIGTERM`, since a process wedged on an auth prompt or a retry loop can ignore `SIGTERM` and survive the bound it was supposed to enforce.

Guard re-injection fails closed on every input class that would otherwise produce a lane running unguarded under `bypassPermissions`: a missing guard script, an absent `jq`, or an empty settings file all abort before the model starts. The guard paths are passed to `jq` as a quoted array — unquoted, a config directory containing a space word-splits into fragments and `jq` emits perfectly valid JSON whose hook commands point at paths that do not exist, which reads as "nothing blocked" instead of failing loudly.

The Stop hook credits *either* transport, a legacy `Agent` subagent envelope or this `Bash` runner invocation, so migrating a lane never narrows what the gate accepts. `--lane <name>` is the gate's match token: renaming it silently disables review enforcement. The runner must appear in command position, so a quoted mention inside another command credits nothing, and a backgrounded subagent's start receipt is not accepted as completion.

Pi uses the supported command grammar in
[REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-candidate-detection): successful root-session Bash/`ctx_execute`/`ctx_batch_execute` surfaces recognize executable `git` and `gh` commands without interpreting their subcommands, options, selectors, or refspecs. Quoted examples and heredoc payloads remain inert through exact command-position and delimiter handling ([REQ-AGENT-116](../../sdd/spec/agents.md#req-agent-116-heredoc-safe-pr-boundary-classification)).

Pi resolves the command repository from the exact executable shell segment, then reads only that repository's checked-out branch and local `HEAD`. Deterministic parent-shell `cd` changes propagate, pipeline cwd changes do not, and unresolved conditional cwd changes fail closed. Command arguments never provide source, destination, configured push branch, or merge identity. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::resolveShellInvocationRepo --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview -->

A launch follows only when the checked-out branch and local full SHA match the authoritative open PR head targeting `main`, `master`, or `develop` ([REQ-AGENT-121](../../sdd/spec/agents.md#req-agent-121-checked-out-branch-boundary-synchronization)). After a merge, the user switches to and synchronizes the merge-target branch; the next successful `git` or `gh` command observes that branch's changed PR head. Feature and integration PRs retain independent incremental bases through PR-number-specific checkpoints ([REQ-AGENT-122](../../sdd/spec/agents.md#req-agent-122-per-pr-review-checkpoints)). <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::ACK_FILE -->

Failed commands, quoted examples, child sessions, passive startup, detached HEAD, nonstandard worktrees, permanently mismatched remote heads, and PRs targeting any other integration branch are inert. A temporarily unavailable or stale **delivery** boundary retries through root agent-end, settled, or resumed-session recovery; an ordinary Git or GitHub reconciliation lookup is one-shot and cannot attach itself to a PR created later. Command syntax does not grant or deny eligibility ([REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery), [REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-candidate-detection)).
<!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::resolveShellInvocationRepo -->
<!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::queryBranch -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage -->
<!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::resolveCiMonitorRequest -->

For Pi, the acknowledged full SHA is stored at `.git/sdd-review-ack-pr-<number>`. Agent-end acknowledgement reads Pi's live session entries so the final triage does not race the session-file flush; settled recovery remains the fallback for missing work. Both require the extension-emitted review window for the successful persisted boundary. That window binds the originating tool call, repository root, branch, PR number, protected base, and full head SHA; fresh PR state must still report the same identity. Ambient cwd changes, active-repository changes, an unbound boundary, or a replacement PR are inert.

The window lists missing reviewer lanes and, when an acknowledgement exists, the exact acknowledged-to-current range. Every counted public reviewer prompt carries that range. Unmatched calls stay in flight until correlated successful native notification or public result retrieval, and only the reminder head can be acknowledged. Delayed persisted terminal evidence can acknowledge that head after reload or newer unpublished local work while the PR still points to it; unfinished or replaced work may repeat at a later boundary ([AD98](../decisions/README.md#ad98-pi-pr-review-uses-visible-session-scoped-agents)).

The USER-ONLY `/tmp/review-bypass` sentinel and explicit post-boundary user wording remain review bypass surfaces; agents must not invoke them autonomously. After fresh open-PR identity validation, either surface writes the exact boundary head to that PR's `.git/sdd-review-ack-pr-<number>` checkpoint, consumes the sentinel when present, and prevents settled missing-review launches for that head. Non-SDD repositories do not consume or act on the sentinel. Claude keeps its existing Stop-hook checkpoint and bypass semantics. Pi adds no pre-command merge interceptor.

A direct current-session instruction to go **FULLY AUTONOMOUS** supersedes only the five-round commit stop for the active task. The root adds `autonomy_override=fully-autonomous` to reviewer prompts until the user cancels or narrows the task; manifest row 23 resolves that exact marker through the seeded round-limit script, while all other gates remain unchanged. The limit binds the autonomous loop only, so a user-invoked `/sdd clean` passes `purpose=clean` and reports row 23 inert without consulting the script at all ([REQ-AGENT-107](../../sdd/spec/agents.md#req-agent-107-deterministic-round-limit-gate)).

The same script produces the count, not only the verdict. It walks the last six commits first-parent, counts every subject carrying an agent-authored tag that touched the reviewer's lane, treats bulk-operation tags as neither counted nor closing, and closes the window at the most recent user-directed commit in that lane. A reviewer runs it once and reports the printed count beside the printed verdict; deriving either itself is a manifest violation.

Over-cap lane evidence sheds reproducible patches and verbatim indexes in deterministic order, records every omission by name, and retains compact `pending` and configuration resolutions rather than dropping the whole answer set.

Reference resolution ([REQ-AGENT-108](../../sdd/spec/agents.md#req-agent-108-reviewer-evidence-resolution-fidelity)) costs a bounded pass over the tree instead of one search per documented name. One full-tree search per backticked token cost 149 searches on a three-file range and 283 seconds, which is almost the whole resolver: past the bound the packet route applied, inside the bound the lane runner applied, so the documentation lane silently lost its evidence in one runtime and kept it in the other. Both bounds are now the same 300 seconds, and a resolver that breaches one names the reason in `evidenceOmitted` rather than dropping the block.

A documented name resolves when the tree holds it in any form prose can write it: a path tail, a basename, a directory, a name registered as a string such as a command or an event, or a declared dependency. Flags, bare extensions and anchor keywords document an interface rather than naming code and are not candidates. Resolution answers whether the name still names something, never which file, because staleness is the question. The failure list is no longer capped below the block budget, and the [lane evidence tests](../../host/__tests__/lane-evidence.test.js) pin each accepted form against a fixture that omits it.

The resolver is seeded into every repository `/sdd` bootstraps, so it assumes neither the language of that repository nor its package manager. Declarations are recognised across the languages a bootstrapped tree may be written in, and block openers that share the shape of a definition are excluded per language. A stack the index does not recognise is not a degraded check: it indexes nothing, so every symbol the documentation names reads as stale and the lane is handed a page of findings about a tree that is entirely consistent.

Dependencies are read from npm exactly and from every other manifest not at all. `package.json` is JSON, so its dependency fields and its own name are exact answers. Every other manifest used to be parsed by its grammar, and the grammar was wrong seven consecutive times -- an extras bracket closing a list early, a key test that also matched `requires-python`, a per-package sub-table offering `version` as a crate, a heading that merely contained the word `packages`. Every one of them resolved a name that was not a package, which is a false clean, and this module's contract is that it never fails in that direction.

So the grammar was removed rather than corrected an eighth time. Every token in a dependency manifest now resolves, and arrives in `resolvedOnlyByDependencyManifest` rather than as an ordinary pass. That is the weakest evidence the resolver accepts, sitting beside the string-literal class, and it states exactly what a heuristic ever established: the name appears in a file that declares dependencies. It is checked after every stronger form, so a real declaration or an exact npm entry is never demoted into it ([REQ-AGENT-108](../../sdd/spec/agents.md#req-agent-108-reviewer-evidence-resolution-fidelity) AC3 and AC8). 

A dotted or slashed token -- a table header such as `[dependencies.serde]` -- matches as one token, so its last segment is retried alone and `serde` resolves without a per-manifest grammar rule. That retry drops leading table words but not trailing ones, so a name like `dependencies` enters the weak class too. Its one filter is shape rather than vocabulary: a segment holding no letter is a version fragment, so `1.2.34` contributes nothing. The cost is that such a name, and a manifest setting such as `where`, also resolve; the lane is told so, which is what stops it being silence.

A chunked scan that fails reports a partial pass rather than contributing silence, and the resolver reports how many passes over the tree its answers cost, so the cost contract is a count rather than a stopwatch. A name resolved only by a quoted string arrives in `resolvedOnlyByStringLiteral` rather than as an ordinary clean, because that evidence is equally satisfied by a registration, an error message and a dead branch.
<!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::DECL_SHAPES -->
<!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::declaredDependencies -->
<!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::declarationIndex -->
<!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::trackedNames -->
<!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::laneEvidence -->

Merge commits are followed with their diffs, because a merge carrying lane work would otherwise be invisible to both the count and the reset; a merge is therefore judged by its own subject, so an agent landing a round through one tags the merge.

History the script cannot read is never reported as a permissive window: it exits non-zero with a one-line diagnostic and prints no verdict at all.
<!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::Explicit fully-autonomous override -->
<!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::The 5-round commit cycle limit -->
<!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) -->
<!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs::action -->
<!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs::countRounds -->
<!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs::resolveCount -->

After every required reviewer result arrives, the launch handoff requires an automatic triage summary before mutation. The root separately judges finding validity and proposed-fix proportionality, prefers existing machinery, rejects unsupported or overengineered proposals, and applies legitimate minimal fixes unless the user requested approval.
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage -->
<!-- @impl: preseed/agents/pi/skills/git-review-pipeline/SKILL.md::Finding discipline -->

Pi CI is not part of review completion or acknowledgement. After any successful executable `git` or `gh` candidate, the extension issues one ordered plan only when the checked-out branch and local `HEAD` exactly match its authoritative unacknowledged open protected-base PR head; the plan reports `event=push` independently of command syntax. The root launches required reviewers first, then runs that plan's resolver once with explicit repository cwd and review launch state. CI launches last without waiting for review completion. An empty response means no monitor, and interruption remains aborted until a later plan or explicit request ([AD99](../decisions/README.md#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent)).

---

<a id="image-baked-seed-governed-mode-delta-sync"></a>
## Image-Baked Delivery Alias

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

---

<a id="specification-coverage"></a>
## Requirement and Source Map

Exhaustive Agents and Memory status remains in the active SDD; section-local links identify clause details.

| Delivery concern | Requirements | Source owner | Evidence |
|---|---|---|---|
| Manifest and generated seed | REQ-AGENT-006/007/014/030/049 | manifest, seed generator, generated TypeScript | freshness and byte/manifest membership tests |
| Session modes and advanced tools | REQ-AGENT-024/091/127-137 | manifest mode gates, selected skills/plugins | mode-specific projection and validation tests |
| Review/CI/governance runtime | REQ-AGENT-015/036-126 as linked in sections | rules, skills, Pi extension, agent definitions | policy contract and workflow behavioral tests |
| Graphify | REQ-AGENT-023/025/026/043/127/128 | Graphify plugin/scripts and Pi tools | build-mode, publication, and graph-limit checks |
| Provider/tool integration | REQ-AGENT-017/019/020/027-032/067/069/118 | entrypoint, setup, skills, MCP adapters | agent-specific projection and isolation tests |
| Native editor proposal mode | REQ-IDE-025/026 | `inline-edit.ts`, Pi manifest, generated seed | proposal-only mode and exact-restoration tests |
| Memory capture/extraction | REQ-MEM-013/016/017/018 | hooks and capture/extract agent definitions | bounded profile and deterministic identity tests |
| SDD bootstrap and cleanup | REQ-AGENT-037/039 and related SDD controls | SDD skills/templates/scripts | behavioral contract tests; Phase C owns reusable collection schema |

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
