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
| context-mode helper package (`ctx_*` tools) | Installed and disabled by default; `/ctx on` opts in until restart | Installed and disabled by default; `/ctx on` opts in until restart | Installed and disabled by default; `/ctx on` opts in until restart ([REQ-AGENT-076 AC1](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)) |
| Pi extension packages (`@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `@narumitw/pi-goal`, `@narumitw/pi-plan-mode`, `@narumitw/pi-usage`, `pi-web-access`, `pi-mcp-adapter`) | Yes (always-on `required`) | Yes (always-on `required`) | Yes (always-on `required`) |
| context-mode plugin folder (Claude Code auto-routing hooks for context-window reduction) | No | No | Yes |

Default workspace is separate from preseed mode. Advanced entitlement permits VS Code as the future default, but each session keeps the Terminal or VS Code value captured at creation; changing that preference never rewrites the session's seeded agent inventory. Switching to Standard resets only the future workspace default to Terminal ([REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions)). <!-- @impl: src/routes/preferences.ts::app --> <!-- @impl: src/routes/session/crud.ts::app -->

The Custom-tier column reflects the extra Claude Code delivery surface for users on the `unlimited` subscription tier in Advanced mode. Container startup writes context-mode's disabled Pi package marker, retaining the exact package while suppressing its skills, bridge, and `ctx_*` tools. The dedicated `ctx-command.ts` extension reaches Standard and Advanced without exposing Advanced-only Codeflare commands. A state-changing `/ctx on` or `/ctx off` persists the selected Pi setting and reloads the active process; the next Codeflare container start restores disabled. See [REQ-AGENT-076 AC1-AC2](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

After explicit `/ctx on`, package settings expose context-mode skills but filter out its extension. The managed `context-mode-runtime.ts` extension claims one process-wide foreground owner and loads the installed context-mode Pi adapter only for that owner; every in-process subagent sees the claim and skips the adapter, so no reviewer/capture/CI child creates a bridge helper. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> The owner is released after context-mode handles `session_shutdown`, allowing `/reload` and `/ctx` toggles to reattach cleanly.

Codeflare does not patch either upstream package's lifecycle or ownership implementation; separate image-build transforms add the ESM compatibility shim and suppress the upstream update probe ([AD101](../decisions/README.md#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports), [AD140](../decisions/README.md#ad140-pi-starts-context-mode-off-and-exposes-optional-tool-schemas-on-demand), [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC7, [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership)).

The managed Pi extension packages are installed in the settings `required` set, so they load in every Pi session independently of the context-mode toggle. This includes the exact-pinned native Goal package for session-scoped autonomous completion. At each user prompt, `context-mode-runtime.ts` completes any enabled bridge's lazy registration before the alphabetically final `zz-tool-exposure-finalizer.ts` exposes only `read`, `bash`, `edit`, `write`, and `capability`; every other registered tool remains searchable and activates additively for the next model step. Activating `subagent` also exposes its result and steering controls. The schema-free `subagent-resume-guard.ts` blocks resume attempts for queued or running records through pi-subagents' public service without patching the package. Registered and initially active schema sizes are reported separately, with no fixed tool-token gate ([REQ-AGENT-158](../../sdd/spec/agents.md#req-agent-158-bounded-initial-pi-tool-exposure)). Every Pi skill treats `ctx_*` tools as optional; the default disabled state uses documented native fallbacks without narrowing work.

The repository-owned `native-notifications.ts` extension is seeded in both modes. It emits fixed OSC 777 text when `ask_user_question` needs attention through the package's stable `rpiv:ask-user:prompt` notifier channel. Immutable channel names and append-only payloads keep the signal compatible across package major upgrades, and it fires only when a questionnaire opens ([REQ-TERM-024](../../sdd/spec/terminal.md#req-term-024-pi-native-terminal-notification-producer)). <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications -->

Completion and failure signals wait for five uninterrupted minutes after `agent_settled`. New input or agent activity restarts that inactivity interval after the continuation settles, preventing a completed subagent from announcing an idle root while Pi is working. Cancelled input requests and runs that settle aborted emit no stale completion. The extension registers nothing under `--mode rpc`, whose stdout is strict JSONL; code-server native Chat uses Code OSS's browser-notification lifecycle instead. No reviewed third-party notifier met both Codeflare's transport contract and the required maintenance/adoption threshold ([REQ-TERM-029](../../sdd/spec/terminal.md#req-term-029-pi-inactivity-gated-terminal-completion)). <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::PI_IDLE_NOTIFICATION_DELAY_MS = 5 * 60_000 --> <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications -->

<a id="pi-notification-acceptance-evidence"></a>
**Pi notification acceptance evidence (2026-08-23).** Exact-head CI [32669136782](https://github.com/nikolanovoselec/codeflare/actions/runs/32669136782) passed before integration [32669483903](https://github.com/nikolanovoselec/codeflare/actions/runs/32669483903) and enterprise-integration [32669485326](https://github.com/nikolanovoselec/codeflare/actions/runs/32669485326) deployed `2a8c62e5558a7e27fbe2e90e615a4d88466bab93`. Curation contract [32670243425](https://github.com/nikolanovoselec/codeflare-curation/actions/runs/32670243425) and publication [32670325887](https://github.com/nikolanovoselec/codeflare-curation/actions/runs/32670325887) produced immutable `seed-v22`, bundle `7c9f3c232f355045191b84cb6b36e72758661e918f4d81e0efca8fa83919eaaf`. Both deployments activated and applied sequence 22 in advanced mode with no resolver error. The user then verified fixed attention frames, the full five-minute inactivity delay, and reset after reactivation in both environments.

<a id="pi-tool-exposure-acceptance-evidence"></a>
**Pi tool-exposure acceptance evidence (2026-08-24).** [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-158](../../sdd/spec/agents.md#req-agent-158-bounded-initial-pi-tool-exposure), and [REQ-AGENT-159](../../sdd/spec/agents.md#req-agent-159-active-subagent-resume-guard) own this evidence. Exact-head CI [32719456272](https://github.com/nikolanovoselec/codeflare/actions/runs/32719456272) passed before integration [32721179051](https://github.com/nikolanovoselec/codeflare/actions/runs/32721179051) and enterprise-integration [32722267206](https://github.com/nikolanovoselec/codeflare/actions/runs/32722267206) deployed `0682b16e027d34006fdc1246e191524584626aec`. Curation contract [32723414746](https://github.com/nikolanovoselec/codeflare-curation/actions/runs/32723414746) and publication [32723414869](https://github.com/nikolanovoselec/codeflare-curation/actions/runs/32723414869) produced immutable `seed-v23`, sequence `23`, bundle `6188969c74a519b3bec0acb0fc8731ee6194a8b6aea8b9bb406dc4cc17f51f37`, and runtime dependency hash `cba014d6587f30ff5b5338db5441c2676ab5e3ca67de2cb285cbfe58364e692b`. Both deployments activated that exact release with no resolver error. Fresh Standard and Advanced sessions retained only `read`, `bash`, `edit`, `write`, and `capability` initially; explicit `/ctx on` remained functional. Observed provider usage was approximately 3,000 tokens initially and 5,000 after enabling context-mode, recorded as release evidence rather than a fixed gate. Managed `seed-v23`, curation source, and the independent embedded fallback matched byte-for-byte for all five shared exposure and resume-guard extensions.

Claude needs no notification hook: both session-mode settings select Claude's built-in `ghostty` notification channel ([REQ-TERM-026](../../sdd/spec/terminal.md#req-term-026-claude-native-terminal-notification-producer)).

In-process subagents always use native fallbacks. The three PR reviewers expose only `bash` and consume their exact packet through the Bash/Node transport.

[`@juicesharp/rpiv-advisor` 2.6.0](https://registry.npmjs.org/@juicesharp/rpiv-advisor/-/rpiv-advisor-2.6.0.tgz) provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. It provides the user-invoked `advisor` tool and user-only `/advisor` command. Codeflare overrides its startup guidance so assistants do not call or suggest advisor unless the user's current message explicitly requests it ([REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)).

`pi-web-access` 0.23.0 provides filtered zero-config Exa routing and configurable public tool names without changing Codeflare's default `web_search`, `source_check`, `fetch_content`, or paged `get_search_content` contracts. Search authenticates through Pi's model registry or zero-config Exa MCP, so it needs no per-user API key. Upstream no longer supplies its duplicate `librarian`; Codeflare preserves the workflow as an owned skill in both Pi modes and keeps its generated-seed delivery under [REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility).

`pi-evaluate` is exact-pinned at 0.1.5 from its reviewed [MIT npm tarball](https://registry.npmjs.org/pi-evaluate/-/pi-evaluate-0.1.5.tgz). Its whole extension registers the packaged skill directory on `resources_discover`; the package ships no tool, no command, and nothing that runs unless the user invokes `/skill:evaluate`. The skill is an adversarial post-execution reviewer: it reads the contract (a [reespec](https://github.com/bnenu/reespec) brief and specs when `reespec/requests/` exists, otherwise a contract the user pastes) together with the produced outputs, and returns a per-capability satisfied/partial/unsatisfied/unclear verdict plus triage guidance.

It deliberately does not read implementation intent, and it reports gaps rather than fixing them. Codeflare applies no patch or fork. Image construction explicitly loads the declared `extensions/evaluate.ts` entrypoint and requires its path-correct JITI artifact, so the first invocation does not cold-transpile ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions)). The same lock-backed dependency discovery includes future `pi-evaluate` releases in weekly shadow-pin proposals.

`@narumitw/pi-usage` is exact-pinned at 0.52.0 from its reviewed [MIT npm tarball](https://registry.npmjs.org/@narumitw/pi-usage/-/pi-usage-0.52.0.tgz) and registers `src/index.ts` as `/usage`. Its reviewed source validates official Codex, GitHub Copilot, and OpenRouter origins, bounds and redacts responses, and requires explicit confirmation before consuming a Codex reset. The package and its `@narumitw/pi-tui-kit` dependency are integrity-locked. Image construction explicitly loads the installed entrypoint and requires its path-correct JITI artifact, preventing a silent cold first command ([REQ-AGENT-131](../../sdd/spec/agents.md#req-agent-131-native-usage-workflow-in-pi-sessions)). The same lock-backed dependency discovery includes future `pi-usage` releases in weekly shadow-pin proposals.

`@narumitw/pi-plan-mode` is exact-pinned at 0.52.0 from its reviewed [MIT npm tarball](https://registry.npmjs.org/@narumitw/pi-plan-mode/-/pi-plan-mode-0.52.0.tgz). It registers `dist/index.ts` and provides the `/plan` collaboration workflow, read-only planning tool policy, structured planning questions, explicit plan completion, and implementation handoff. Codeflare adds no fork or source patch. The installed entrypoint is explicitly loaded and fail-closed verified in the image's path-correct JITI cache ([REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions)).

After restore on every container start, `entrypoint.sh` atomically replaces `~/.pi/agent/pi-plan-mode.json`. The managed policy inherits the session thinking level, keeps an approved implementation plan active, and enables built-in read/limited-shell tools plus bounded Browser Run, web retrieval, context-mode indexing/search, and Graphify query tools when those tools are available. It deliberately excludes the general questionnaire, arbitrary context-mode command execution, MCP, delegation, task mutation, and advisor surfaces because Plan Mode owns its own structured question and completion tools. No shortcut or export path is configured. `/plan save` stays session-local. A pathless `/plan export` uses upstream's `PLAN.md` default; users provide an explicit path when exporting elsewhere, such as `/plan export "/home/user/Vault/Implementation Plans/<name>.md"`. Codeflare ships no automatic plan-file writer. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

Pi also loads the exact-pinned Caveman extension from the image-owned npm cache. Its configuration is excluded from Codeflare's default and advanced agent seeds: the image carries the policy file, and before startup completes the entrypoint atomically restores lite compression mode with the extension's animated status/footer disabled. Herdr keeps its private XDG state while directing Pi to that canonical `~/.pi/agent` configuration root. A missing, invalid, or unwritable image policy blocks startup. The package entrypoint is explicitly JITI-warmed and verified, and normal Pi-extension shadow-pin discovery owns future coherent version updates ([REQ-AGENT-155](../../sdd/spec/agents.md#req-agent-155-image-owned-caveman-response-policy)). <!-- @impl: entrypoint.sh::configure_pi_caveman --> <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime -->

Plan Mode 0.52.0 and Goal 0.53.0 share upstream's session-scoped `workflow:mutex:v1` protocol, so starting one workflow while the other owns the session is refused and ending it releases ownership ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions)).

`@narumitw/pi-goal` remains the normal upstream package, exact-pinned at 0.53.0 after review of the [published npm tarball](https://registry.npmjs.org/@narumitw/pi-goal/-/pi-goal-0.53.0.tgz). Codeflare does not vendor or fork it. The MIT package publishes both generated `dist` and authored `src`, and provides `/goal`, `goal_complete`, and `goal_blocked` without managing subagent files. Codeflare's image transform keeps Goal prompts compact: each trigger retains the objective and exact completion guard without repeating terminal wait or blocked-tool coaching. At startup, Codeflare adds missing `toolVisibility: "after-first-goal"` and `continuationLimits.automaticTurns: 10`, then authoritatively writes `continuationLimits.minIntervalMs: 180000`. This repairs persisted zero-delay configurations while preserving explicit unrelated limits, unknown fields, `rpc`, and existing visibility settings. <!-- @impl: entrypoint.sh::PI_GOAL_STARTUP_CONFIG -->

A malformed file is left byte-for-byte alone rather than being "repaired" by startup. There is no settings-panel patch for these Codeflare-owned startup values.

On reload, `capability.ts` keeps those tools active when the session's latest canonical Goal state is unfinished or Goal's user-owned `always` policy already activated both tools, allowing the same Goal to restore without independently widening fresh or completed lazy sessions ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions) AC4/AC5).

Startup removes the retired `pi-goal-list-loop-audit` package from persisted settings, preventing its Explore ownership warning from surviving an image upgrade. Its replacement's runtime dependencies remain integrity-locked in the committed preseed lock.

The image warms the declared entrypoint through its real npm path and fails unless the exact jiti artifact exists ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions) AC2/AC3).

Before jiti warm-up, the image build runs the version-aware `scripts/patch-pi-goal-review-control.mjs` transform against the exact locked 0.53.0 source. The published package declares generated `dist/index.ts`; the transform accepts that published declaration or the already-transformed `src/index.ts` state on an idempotent rerun, then normalizes the package's sole Pi entrypoint to the patched `src/index.ts` that the image warms. Every other version, declared entrypoint, or source layout fails closed before writes. One part adds the existing session-local control channel and delegates pause and resume to pi-goal's own command controller. Trusted review-owned pause uses the controller's non-aborting option, so it changes Goal state and cancels Goal continuation work without aborting the independently queued review turn; manual pause keeps the controller's default current-turn abort ([REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility) AC1-AC4).

FIX-triggered resume suppresses pi-goal's separate continuation prompt because the existing FIX follow-up owns the next turn. Closure-triggered resume also suppresses that prompt but schedules no continuation turn. Neither path enables Managed Run RPC, populates the user's input field, or turns command text into model input ([REQ-AGENT-114](../../sdd/spec/agents.md#req-agent-114-review-owned-goal-continuation) AC1-AC4).

The same transform adds `continuationLimits.minIntervalMs` to pi-goal's normal settings loader and saver. Upstream's default remains zero, so an ordinary unconfigured installation dispatches immediately. Codeflare's startup policy enforces three minutes on every container start ([REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy) AC1-AC7).

A positive interval creates one timer for an eligible continuation; each later settled boundary clears and re-arms that timer so the full interval follows the latest settled activity rather than an earlier transient idle boundary. Existing pause, clear, replacement, prioritization, and shutdown paths cancel it through pi-goal's own continuation cleanup. At expiry, the timer checks the current session generation, exact marker, active Goal identity and workflow ownership, and idle/pending state. If Pi became busy, the intent stays pending and a later settled boundary schedules a fresh full interval ([REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy) AC5-AC7; [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing) AC1-AC7).

The transform calculates the patched package manifest and all five patched source files before writing, and admits only locked 0.53.0. The host suite verifies and extracts the exact registry archive, then loads the extension through its transformed package-declared entrypoint. Version, entrypoint, anchor, or layout drift leaves every package file untouched. The weekly shadow-pin job runs the same preflight before opening a bump PR; later releases fail until their source, integrity, version contract, and anchors are reviewed ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation)). <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration) -->

For reviewer-bearing PR boundaries, `review-enforcement.ts` emits the review launch plan independently. When an active Goal or matching review-owned pause exists, the boundary agent-end handler records ownership and awaits the trusted bridge pause before returning, so the queued launch-plan turn starts against settled Goal state. The trusted bridge pause does not abort Pi's queued launch-plan turn or its background tasks. If ownership cannot be recorded or Goal control is unavailable, review proceeds without pausing the Goal. An exact persisted pause retains release ownership even when the bridge response is missing or unsuccessful ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-pause-ownership-across-pr-heads) AC1-AC3 and Constraints; [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-non-disruptive-review-owned-goal-control) AC1-AC4 and Constraints; [REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility) AC1).

Review completion requests resume immediately before the matching acknowledged `pr-boundary-fix-follow-up`. If a manual resume wins that request race, authoritative non-paused state clears stale ownership without a false error. PR closure requests resume during closure handling, and a failed replacement-head ownership write may request rollback. CI and individual reviewer notifications never request resume. Missing control, Goal replacement, and independent reactivation remain fail-open ([REQ-AGENT-113](../../sdd/spec/agents.md#req-agent-113-review-owned-goal-release) AC1-AC7; [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-non-disruptive-review-owned-goal-control) AC5-AC6).

Review ingress now has one durable fact: the current exact PR identity has a user-scoped completion marker, or it does not. Pi resolves only the active checkout at startup, resume, clone, switch, checkout, pull, a successful PR merge that changes the active checkout or full `HEAD`, push, PR creation, and PR reopen. Claude applies the same rule through SessionStart, PreToolUse merge snapshots, and PostToolUse. A successful checked-out-branch push, PR creation, or PR reopen with no marker emits the deterministic review-and-CI launch plan automatically. Other marker misses offer `Mark review complete` and `Launch review`. Fetch, inspection, local mutation, merges without an active-checkout or full-`HEAD` transition, detached or path checkout, and unrelated-ref pushes stay inert ([REQ-AGENT-171](../../sdd/spec/agents.md#req-agent-171-user-scoped-review-completion-and-common-consent)).

A selected or automatic launch still uses the established lane classifier, deterministic temporary reports, and exact-head CI correlation. Pi keeps one current round in memory. Claude limits transcript inspection to bytes after one `/run/codeflare/review-session` offset. Neither runtime persists partial lane state, a launch decision, retry work, counters, or missing-work demands. If work stops or the process reloads, the next delivery starts a fresh round and the next non-delivery exposure asks again. This is deliberate. Recovering half a review was the mechanism that kept reviving old authority.

After canonical triage, FIX handling revalidates the exact GitHub identity and writes its marker before emitting the existing FIX follow-up. Marker files live under `~/.codeflare/review-state/v1`, retain ten heads per repository and branch, expire after 30 days, and sync through the common home-directory R2 filters. The local write does not wait for R2; the helper signals the existing daemon with `SIGUSR1` and accepts that failed convergence may repeat a prompt on another device ([REQ-STOR-027](../../sdd/spec/storage.md#req-stor-027-review-completion-marker-sync)).

No executable review source reads or migrates `.git/sdd-review-*` files. Linked worktrees and separate clones therefore observe the same marker when they share the user's R2 bucket. Goal pause remains current-round coordination and releases before FIX; session restart never reconstructs review ownership from an old transcript.

`@juicesharp/rpiv-todo` is pinned at 2.6.0; its overlay now loads lazily and omitted update fields produce recoverable model guidance, while the session-isolation correction shipped upstream in 2.0.0 remains intact: task state is keyed by Pi session ID and context-free rendering stays bound to the foreground slot. The temporary [AD100](../decisions/README.md#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) source override that mirrored this fix while npm was at 1.20.0 is retired — no postinstall guard or payload remains, and a host test guards that the pin names the reviewed release ([REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation)).

`web_search` defaults to the `auto-summary` workflow via a preseeded, create-if-missing `~/.pi/web-search.json` (`{"workflow": "auto-summary"}`). A user who edits that file to opt back into the interactive `summary-review` workflow has their choice respected on later boots.

[pi-web-access 0.14](https://github.com/nicobailon/pi-web-access/releases/tag/v0.14.0) fixes the former interactive-curator fallback crash. The container remains headless, so `auto-summary` is still the only default workflow that can complete without a browser-approval UI; users who deliberately provide such a UI may retain their own `summary-review` setting.

### Pi prompt ownership and budget

The measured pre-reduction Pi provider-boundary system prompt is 32,416 characters in an isolated working directory. The migration target is at most 14,000 characters in both modes for the image fallback and signed managed projection. Serialized registered-tool schemas and additive project context are reported separately; project context remains byte-unaltered and cannot make the controlled prompt fail its cap.

Codeflare owns Pi prompt assembly, `SYSTEM.md`, compact shared `AGENTS.md`, executable hard-policy guards, compiler support, and the image fallback. `codeflare-curation` owns its managed source inventory, modes, invocation visibility, managed projection measurement, and signed publication. A fallback seed path that also exists in curation's managed manifest cannot complete delivery until curation carries matching bytes and its protected contract verification passes; image-owned paths and private curation content remain independent. The public fallback is verified in Codeflare first; completion is established only by an exact deployed compiler pin, declared prompt-policy synchronization, guarded real-runtime curation evidence for both managed modes, and immutable signed publication. The lossless migration ledger is `scripts/pi-prompt-rule-ledger.json` ([REQ-AGENT-156](../../sdd/spec/agents.md#req-agent-156-bounded-lossless-pi-prompt)).

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC2/AC4/AC6, [REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport) AC1-AC3, and [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership); source: `entrypoint.sh::warm_pi_npm_dependencies` (filtered context-mode package + tool extensions), `preseed/agents/pi/extensions/context-mode-runtime.ts` (foreground ownership), `preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand` (state-changing `/ctx on|off` persistence + reload), the Pi reviewer agents (Bash-only transport), the main-execution web-search default block, `preseed/agents/pi/skills/advisor/SKILL.md`, and `preseed/agents/pi/package.json`.

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
[Adapter 2.26.0](https://github.com/nicobailon/pi-mcp-adapter/releases/tag/v2.26.0)
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

Pi and Claude use marker-aware review ingress under [AD144](../decisions/README.md#ad144-user-scoped-review-completion-uses-marker-or-dialog-ingress). Startup, resume, clone, switch, branch checkout, PR checkout, pull, checked-out-branch push, checked-out-branch PR creation, and checked-out-branch PR reopen resolve the active checkout's exact open protected-base PR. A valid marker is silent. Successful checked-out-branch push, PR creation, and PR reopen automatically emit one review-and-CI plan. Other misses offer `Mark review complete` and `Launch review`; neither runtime chooses for the user.

A selected launch starts one fresh current round. The newest retained same-PR ancestor selects an incremental range when it remains an ancestor; otherwise the plan uses the full protected-base diff. Required reviewers start together with deterministic output paths. Push or PR-create context may add exact-head CI immediately afterward through the existing resolver:

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> pr=<affected-pr-number> head=<boundary-plan-head> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

No stdout means no action. Otherwise the root submits the returned request unchanged once. After the final launch, root ends the turn without polling or retrieving in-flight work. Native terminal notifications drive later turns.

Joint triage waits for every required reviewer and terminal exact-head CI evidence. Failure and timeout require the exact `Exact-head CI` row and matching `CI_RESULT` token. For every finding, root verifies evidence and scope, judges the finding separately from its proposed fix, rejects unsupported or overengineered proposals, and prefers the smallest correction reusing existing machinery. Root makes no mutation in triage. If Pi sees a table after failed or timed-out CI but its required CI row is malformed, it emits one correction follow-up instead of silently withholding FIX; the corrected canonical table continues the same round. Agent-end or Stop handling then revalidates identity, writes the user-scoped completion marker, and emits the separate FIX follow-up. Head drift or marker-write failure keeps both closed. See [REQ-AGENT-170](../../sdd/spec/agents.md#req-agent-170-joint-review-and-ci-triage).

Pi holds one active round in memory. Claude inspects only transcript bytes after its current SessionStart offset. Stopped or interrupted work stores no progress, no retry plan, no counter, and no missing-work demand. A later exposure asks again and replans. Non-SDD and default-mode sessions receive no automatic review or CI plan; explicit CI and deploy/merge gates remain independent.

Generated reviewer system prompts embed their canonical scope and enforcement skills, so reviewers build the lane packet without retrieving policy first. All three use Pi's provider-neutral `medium` thinking level rather than inheriting the root session's level. The foreground-only context-mode extension is intentionally unavailable inside in-process reviewers. Each reviewer invokes the packet CLI through repository-rooted Bash/Node and consumes its JSON in the same processing call; packets are never persisted or handed between calls. Standalone read, grep, Graphify, and indexed batch/global retrieval are unavailable to the lanes. The root waits for every report and alone changes the head.

Cross-lane packet inputs carry exact old/new hunk ranges. Reviewers resolve an anchored implementation symbol or named test block and follow it only when that range intersects a changed hunk; sharing a changed file is not direct invalidation. Reviewers consolidate deterministic checks, emit failures rather than successful manifests, and verify generated seed through canonical preseed plus one identity check. The direct Bash/Node packet path preserves the declared scope, evidence, and dispositions.

Claude CI monitoring remains bounded to eligible PR-boundary plans, explicit user requests, and fresh deploy/merge gates ([REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy)). Routine non-boundary pushes do not start it; at a PR boundary, CI launches independently after reviewers, while its terminal result joins reviewer evidence before triage acknowledgement. The root launches one attached background `ci-monitor` Agent with the boundary's canonical repository, PR, head, and working directory. The monitor queries by commit SHA, so branch text never enters its shell command. Its bounded script requires a non-empty workflow/run fingerprint to stay stable across two polls before success and returns one terminal `CI_RESULT success`, `failure`, or `timeout` through native Agent completion. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::CI_PROMPT --> <!-- @impl: preseed/agents/claude/agents/ci-monitor.md::ci-monitoring/scripts/monitor-ci.mjs -->

Every terminal result carries `repo=<owner/repo> pr=<number> head=<sha>`. The Stop gate accepts it only from the exact background Agent tool-use ID launched for those values, so an unrelated notification or a result for another repository cannot satisfy acknowledgement.

The monitor neither cancels workflow runs nor consults the remote about its own relevance. It filters observed runs by the bound head. Superseded runs are cancelled by workflows, which each declare their own `concurrency` policy; workflows omitting `cancel-in-progress`, including `deploy.yml`, do so because a half-finished run is worse than a redundant one ([AD122](../decisions/README.md#ad122-the-ci-monitor-observes-and-reports-it-does-not-cancel-runs-or-chase-the-remote)).

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

After a relevant private content change reaches `main`, the protected release workflow derives the next sequence from verified immutable history and publishes fixed signed assets. Codeflare discovers releases through its normal five-minute dashboard refresh. No image rebuild, webhook, or container clone participates. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

### Spotlight: how `runtimeDependencyHash` binds a release to its image

A managed release may replace agent code without rebuilding the container. That freedom needs a hard compatibility check. A valid signature proves who published the bytes; it does not prove that the image has the npm packages the managed content expects. `runtimeDependencyHash` closes that gap. See [REQ-AGENT-147 AC3 and AC7](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases) and [REQ-AGENT-150 AC4](../../sdd/spec/agents.md#req-agent-150-independent-managed-release-activation-validation).

1. [`codeflare-curation/config/compiler.json`](https://github.com/nikolanovoselec/codeflare-curation/blob/main/config/compiler.json) pins one exact Codeflare commit, which owns the compiler and managed npm runtime contract.
2. The [release workflow](https://github.com/nikolanovoselec/codeflare-curation/blob/main/.github/workflows/release.yml) checks out that commit, and the [compiler wrapper](https://github.com/nikolanovoselec/codeflare-curation/blob/main/scripts/lib/compiler.mjs) copies its shared npm-tools, Claude Browser Run MCP, and Pi lockfiles into the staged source.
3. The shared compiler hashes every byte of each lockfile, then hashes the three fixed-order digests into one runtime identity. <!-- @impl: scripts/agent-seed-core.mjs::computeAgentRuntimeHash -->
4. Release construction writes that identity to `runtimeDependencyHash` inside `seed-v1.json.gz`. <!-- @impl: scripts/agent-seed-release.mjs::buildAgentSeedRelease -->
5. Publication signs the exact deterministic compressed bundle and publishes it with its raw 64-byte Ed25519 signature. <!-- @impl: scripts/agent-seed-release.mjs::signReleaseBundle -->
6. Every Codeflare image contains `PRESEED_RUNTIME_DEPENDENCY_HASH`, generated from the same three lockfiles used to build that image. <!-- @impl: scripts/agent-seed-core.mjs::toGeneratedModuleSource -->
7. On its periodic release check, the Worker verifies immutable metadata, asset digests, signature, schema, sequence, and runtime hash before activation. <!-- @impl: src/lib/remote-curation.ts::verifyManagedReleaseStream -->
8. The Worker scans at most ten 100-record history pages and activates the first release whose verified runtime hash equals the deployment's build hash. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

Only a runtime-hash mismatch continues discovery. Any other managed-release validation failure stops it; unrelated published releases are ignored. See [REQ-AGENT-154](../../sdd/spec/agents.md#req-agent-154-build-compatible-managed-release-discovery). <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

The seed never asks running instances to provide a hash. Curation embeds the hash from its pinned Codeflare commit, and each image compares that value with its own generated constant. A content-only release that keeps all three lockfiles unchanged keeps the same hash and needs no image redeploy. Builds from different branches with byte-identical managed npm locks intentionally share the same newest compatible seed.

This is deliberately narrower than a full Codeflare source or image hash. The exact compiler commit makes compilation reproducible; the three-lock identity answers whether the image has the npm packages managed content may use. New native or other image-owned requirements must ship through Codeflare before managed content relies on them.

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
   also exposes the combined managed npm lock identity that binds managed
   releases to the runtime dependency ABI. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @test: host/__tests__/agent-seed-core.test.js (shared agent seed compiler) -->
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
syntax checks use the same deadline.

Under [REQ-AGENT-157 AC6–AC7](../../sdd/spec/agents.md#req-agent-157-managed-local-check-delivery-policy),
canonical guidance projects to both runtime skill paths. <!-- @impl: scripts/agent-seed-core.mjs::adaptSkillContent --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-157 AC6: canonical safe-check guidance reaches each lazy skill projection) -->
Pi keeps the skill in its compact instruction index for explicit invocation while
suppressing duplicate native catalog injection. <!-- @impl: scripts/agent-seed-core.mjs::finalizePiSkillIndex --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (keeps indexed skills explicitly invocable while omitting duplicate native XML entries) -->

Mutation, watch, output-file, cache-writing, and analyzer-concurrency flags fail
closed. Shell composition beyond one optional leading `cd … &&` prefix, or any
redirection, cannot turn an allowed wrapper invocation into a write. Builds, tests,
type checks, Knip and other dependency-graph analysis, installs, servers, and
authoritative verification remain CI-only. Both Pi and Claude guards allow only the
exact wrapper path, and direct blocked commands point agents to the skill; the
user-only one-shot bypass remains unchanged. <!-- @impl: preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/block-local-builds.sh::PATTERNS --> <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::isManagedSafeLocalCheckCommand --> <!-- @test: host/__tests__/safe-local-check.test.js (REQ-AGENT-052 AC6: managed safe local checks) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-157 AC1: allows only a managed safe-check wrapper invocation with an optional leading cd) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-157 AC2: the managed wrapper bypasses the local-lint block without consuming the user sentinel) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-157 AC3: seeds one managed safe-check skill and wrapper for each runtime and mode) -->

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
| `preseed/agents/pi/extensions/capability.ts` + `capability-helpers.ts` + `zz-tool-exposure-finalizer.ts` | default, advanced | `~/.pi/agent/extensions/` | Registered-tool search, additive activation, and post-registration bootstrap filtering through Pi's public API |
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

For eligible review exposures, GitHub's authoritative PR head must match the active checkout. An exact completion marker stays silent; otherwise the user marks completion or starts one fresh round. Root launches selected reviewers together without inherited context, adds plan-required CI immediately, waits for correlated terminal evidence, publishes the fixed triage table in a tool-free response, and ends that turn without mutation. Each Pi reviewer contract emits exact `scope=diff`, expected `review_range` or `review_base`, and lane-specific `output_file` assignments on standalone lines; only exact whole-line assignments count toward completion. Claude counts only successfully received background launches through the canonical `run-review-lane.sh` command when they bind the emitted boundary and exact current head, PR, lane, and range or base.

Code, specification, and documentation reviewers use the shared provider-neutral medium profile. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::thinking: medium --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::thinking: medium --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::thinking: medium --> Agent-end enforcement reads current live session state, revalidates the exact identity, writes user-scoped completion, and emits one FIX follow-up. Reload never recovers partial work.

This implements [REQ-AGENT-171](../../sdd/spec/agents.md#req-agent-171-user-scoped-review-completion-and-common-consent), [REQ-AGENT-170](../../sdd/spec/agents.md#req-agent-170-joint-review-and-ci-triage), [REQ-STOR-027](../../sdd/spec/storage.md#req-stor-027-review-completion-marker-sync), and the retained lane, CI, reviewer, Goal, and user-invoked review requirements. [AD144](../decisions/README.md#ad144-user-scoped-review-completion-uses-marker-or-dialog-ingress) retains automatic delivery while replacing clone-local completion, checkpoints, and recovery.

R2 sync still excludes retired durable-review extension paths. It now includes only the bounded `~/.codeflare/review-state/v1/**` marker tree among review state. The managed-extension relay restores current managed code without touching those user-owned completion files.

CI remains a distinct execution path inside a user-selected plan. Root invokes the resolver once after reviewer calls and submits its zero-or-one request unchanged. Review completion requires correlated terminal CI when the plan includes it. Interruption is intentionally not recovered.

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

[context-mode](https://github.com/mksglu/context-mode) is registered as a Claude Code MCP server (`ctx_*` helper tools) where that runtime enables it. Pi installs the exact package but starts it disabled. `/ctx on` enables the managed foreground owner and reloads resources; `/ctx off` disables it again. The next Codeflare container start restores the disabled default. See [REQ-AGENT-076 AC1-AC2](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults). <!-- @impl: preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand -->

The npm package is installed and patched at image-build time in both the global Claude MCP tree and Pi's prewarmed package tree, so first invocation performs no package fetch. Entrypoint registers the Claude MCP server for every user. Custom-tier (`unlimited` subscription) delivery adds the Claude plugin hooks, while Pi retains `/ctx on` as an explicit per-container opt-in through its managed foreground owner. The package source is pulled from npm rather than vendored. <!-- @impl: Dockerfile::CTX_DIR --> <!-- @impl: entrypoint.sh::CONTEXT_MODE_MCP_CONFIG -->

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

### Review completion prompt or FIX is missing

Both runtimes require an advanced SDD checkout whose local branch and full `HEAD` exactly match an open PR to `main`, `master`, or `develop`. Check that identity first. GitHub failure, detached state, an unrelated push ref, or a non-protected base fails closed without a prompt.

Completion lives under `~/.codeflare/review-state/v1`, not under `.git`. Do not create or repair legacy acknowledgement, plan, CI, count, bypass, or cache files. A valid exact marker suppresses the dialog. Invalid and expired markers act as absent; the first root startup per container prunes them, keeps ten per repository and branch, and asks again.

Pi registers SessionStart plus supported shell-result exposures. Claude registers `git-push-review-reminder.sh` for SessionStart, PreToolUse, PostToolUse, and PostToolUseFailure. If Claude never asks, verify all four hook entries in `~/.claude/settings.json`, the helper and classifier under the plugin's `scripts/lib/`, and the resolved `${CODEFLARE_REVIEW_SESSION_DIR:-/run/codeflare/review-session}` directory is writable. PreToolUse only snapshots merge state and PostToolUseFailure removes a failed command's snapshot; the retired review-specific mutation gate remains absent while attribution and local-build guards stay on PreToolUse.

A selected Claude round runs headless lanes through `run-review-lane.sh`. Its caller-supplied `--range` or `--base` is authoritative; runner never reads completion state. Stop handling inspects only transcript bytes after the current SessionStart offset. A failed or stopped lane advances that offset and emits nothing. The next supported exposure should ask again.

If terminal evidence exists but FIX does not appear, confirm canonical triage followed every required reviewer and exact-head CI result. CI failure or timeout needs a row with FINDING `Exact-head CI` and PROPOSED FIX `CI_RESULT failure` or `CI_RESULT timeout`; Pi issues one correction follow-up when a table is present but that row is malformed. Head drift and marker-write failure intentionally suppress FIX.

Marker writes acknowledge locally before R2 convergence. The helper reads `CODEFLARE_SYNC_DAEMON_PIDFILE`, defaults to `/run/codeflare/sync/sync-daemon.pid`, and sends `SIGUSR1`. A signal warning does not revoke local completion. Another clone or device may ask again until bisync converges; that duplicate prompt is safer than claiming review completion that never reached storage.

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
