<a id="agent-preseed-system"></a>
# Agent Environment / Preseed

**Audience:** Developers

Manifest-selected instructions, skills, specialist agents, commands, plugins, and runtime configuration delivered to per-user containers. This lane owns selection, compilation, projection, local assembly, and loading. [Storage & Sync](storage-and-sync.md#durable-seed-reconciliation) owns durable reconciliation; [Vault & Memory](vault.md#memory-capture-system) owns capture, retrieval, and knowledge lifecycle; [Container](container.md) owns supervision.

**Owns:** manifest inputs, session-mode delivery, shared seed compilation, runtime adaptation, seeded reviewer/CI policy, settings/plugin assembly, and image-baked delivery. **Does not own:** durable R2 reconciliation or applied-state publication, GitHub workflow topology, Vault extraction state, conversation lifecycle, public endpoint contracts, or container supervision.

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
| Compact universal engineering constitution | Yes | Yes | Yes |
| Graphify query capability | Yes | Yes | Yes |
| Graphify conditional routing | No | Yes | Yes |
| Pi startup header, local statusline, and fixed terminal notifications | Yes | Yes | Yes |
| Cloudflare-stack, ship (+ refs), ci-monitoring, pr-workflow, deploy-credentials skills | Yes | Yes | Yes |
| `consult-llm` skill (Claude + Pi) | No | Yes | Yes |
| CC hooks: `block-attributed-commits`, `git-push-review-reminder`, `enforce-review-spawn`, `run-review-lane` | No | Yes | Yes |
| Agent definitions (architect, code-reviewer, deep-reviewer, spec-reviewer, etc.) | No | Yes | Yes |
| Commands (/brainstorm, /debug, /deploy, /review, /sdd) | No | Yes | Yes |
| `spec-discipline` rule + spec-enforce skill family (spine, AC, truth) | No | Yes | Yes |
| `documentation-discipline` rule + doc-enforce skill family (spine, lanes, shape, truth) | No | Yes | Yes |
| `tdd-discipline` rule + tdd-enforce skill | No | Yes | Yes |
| git-review-pipeline skill (SDD PR-boundary review pipeline) | No | Yes | Yes |
| SDD template scaffolding for `/sdd init` | No | Yes | Yes |
| Known marketplaces plugin config | Yes | Yes | Yes |
| context-mode helper package (`ctx_*` tools) | Disabled by default; `/ctx on` persists through reload until next container start | Disabled by default; `/ctx on` persists through reload until next container start | Disabled by default; `/ctx on` persists through reload until next container start ([REQ-AGENT-076 AC1](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)) |
| Pi extension packages (`@juicesharp/rpiv-advisor`, `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo`, `@narumitw/pi-goal`, `@narumitw/pi-plan-mode`, `pi-open-tui`, `pi-web-access`, `pi-mcp-adapter`) | Yes (always-on `required`) | Yes (always-on `required`) | Yes (always-on `required`) |
| context-mode plugin folder (Claude Code auto-routing hooks for context-window reduction) | No | No | Yes |

Default workspace is separate from preseed mode. Advanced entitlement permits VS Code as the future default, but each session keeps the Terminal or VS Code value captured at creation; changing that preference never rewrites the session's seeded agent inventory. Switching to Standard resets only the future workspace default to Terminal ([REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions)). <!-- @impl: src/routes/preferences.ts::app --> <!-- @impl: src/routes/session/crud.ts::app -->

Advanced Pi uses the memory counter and its transcript-prefix rebase handling for one shared memory/Vault/trim cadence; the existing memory trigger arms Vault checks and transcript maintenance above 50 MB. Independent job receipts and retries remain unchanged; old `.vault-count` files are ignored. A manual parent invocation uses `request` only and forwards the controller-issued background job unchanged; scheduled is not launched. The scoped worker calls `trim` once, without reading transcript content into model context ([REQ-MEM-028](../../sdd/spec/memory.md#req-mem-028-pi-active-transcript-size-retention), [REQ-MEM-030](../../sdd/spec/memory.md#req-mem-030-visible-agent-owned-transcript-maintenance)). <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages -->

The local operation preserves the first header line, calculates one oldest-prefix byte cutoff aiming to retain 20,000,000 bytes including admitted append tail, then aligns forward through the next newline. Results must remain within 15,000,000–25,000,000 bytes. Below-minimum results refuse unchanged. Fixed-size buffers copy the retained bytes; no history-record parsing, semantic selection, category refinement or padding occurs. Only bounded first-line session metadata is validated for session identity and parent/version safety. Old prefix messages, state and ancestry are intentionally lost. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::rawCut --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob -->

A verified local trim preserves a surviving successful capture frontier rather than immediately recapturing retained history. Only checkpoint metadata is translated; capture bodies stay unchanged. Later uncaptured prompts still count toward the existing twenty-prompt trigger; unrelated history replacement retains recovery behavior. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault -->

Current session naming metadata is preserved just after the header using the owner's public SDK state, so `/resume` retains the display name without a history scan. Its bytes count toward the target and verified committed prefix ([REQ-MEM-033](../../sdd/spec/memory.md#req-mem-033-preserved-session-display-name)). <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob -->

The live owner alone atomically replaces the same pathname and verifies persisted bytes. Session/path/ownership/prefix checks, cancellation and the six-attempt delivery budget remain. Committed verification-pending receipts use the same bounded asynchronous readback worker, with cancellation and duplicate suppression, never replacement replay. No transcript backup or SDK/cache mutation is performed; a later SDK rewrite can regrow the file ([REQ-MEM-029](../../sdd/spec/memory.md#req-mem-029-active-transcript-replacement-safety)). <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::commitTranscriptTrimCandidate -->

Each CPU worker has a 1 GiB kernel limit without swap and starts only after verified placement. Missing enforcement refuses work. Pi and the terminal host remain outside that budget; their own allocations and ancestor/global OOM survival are not guaranteed. An observed OOM kill is not proof that the local limit caused it ([REQ-MEM-032](../../sdd/spec/memory.md#req-mem-032-bounded-transcript-worker-memory)). <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::runTrimWorker -->

Controlled byte-copy, owner-lifecycle and kernel-boundary fixtures define [retention](../../sdd/spec/memory.md#req-mem-028-pi-active-transcript-size-retention), [activation safety](../../sdd/spec/memory.md#req-mem-029-active-transcript-replacement-safety), [scoped completion](../../sdd/spec/memory.md#req-mem-030-visible-agent-owned-transcript-maintenance) and [worker memory](../../sdd/spec/memory.md#req-mem-032-bounded-transcript-worker-memory) methods, not production-adoption receipts. Only persisted readback reporting `trimmed` establishes completion; a committed verification-pending receipt is not success. CI qualification, local activation and production acceptance remain distinct. Kernel memory-exhaustion stress is CI-only, never an active-session check.

The scoped child retains only its selected tool and existing parent channels through exposure filtering. No absent tool is activated, and root Goal exposure is unchanged. <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::registerInitialToolFilter -->

The Custom-tier column reflects the extra Claude Code delivery surface for users on the `unlimited` subscription tier in Advanced mode. Container startup writes context-mode's disabled Pi package marker, retaining the exact package while suppressing its skills and foreground-owned adapter until explicit `/ctx on`. The dedicated `ctx-command.ts` extension reaches Standard and Advanced without exposing Advanced-only Codeflare commands. A state-changing `/ctx on` or `/ctx off` persists the selected Pi setting and reloads the active process; the next Codeflare container start restores disabled. See [REQ-AGENT-076 AC1-AC2](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

Enabled package settings expose context-mode skills but filter out its extension. The managed `context-mode-runtime.ts` extension claims one process-wide foreground owner and loads the installed context-mode Pi adapter only for that owner; every in-process subagent sees the claim and skips the adapter, so no reviewer/capture/CI child installs context-mode hooks or tools. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> The owner is released after context-mode handles `session_shutdown`, allowing `/reload` and `/ctx` toggles to reattach cleanly.

Codeflare does not patch either upstream package's lifecycle or ownership implementation; separate image-build transforms add the ESM compatibility shim and suppress the upstream update probe ([AD101](../decisions/README.md#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports), [AD140](../decisions/README.md#ad140-pi-starts-context-mode-off-and-exposes-optional-tool-schemas-on-demand), [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC7, [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership)).

Managed MCP portals use unmodified `pi-mcp-adapter` as the sole connection/tool owner. Lazy placeholder registrations expose cached/deferred tools and disconnect after ten idle minutes, while active calls remain protected. `auth: false` leaves portal browser OAuth, encrypted grants and refresh on Cloudflare. No companion, vendor patch or private credential channel is used. Candidate/image qualification covers actual native proxy calls, idle reconnect, stdio/consult and unmanaged local OAuth separately from hosted acceptance. <!-- @impl: scripts/qualify-pi-mcp.mjs::result -->

The auto-discoverable native `mcp-portals` router progressively loads `mcp-portal-connect`, `mcp-portal-discovery` and `mcp-portal-execution`: bootstrap every approved portal before semantic selection; capability activates registered wrappers, not upstream methods; use live JSON schemas, `codemode.tools()` and actual originating-portal execute names. Report partial coverage and read back uncertain writes before retrying. These skills follow the established default+advanced manifest and Curation/seed pipeline. <!-- @impl: preseed/agents/pi/skills/mcp-portals/SKILL.md::MCP portals -->

Root refresh reuses only observed, renewed, still-valid grants in the same connection generation. An unchanged stale readback cannot replace a successful refresh result with the old access token. Observed disconnect/configuration changes still reject access; KV is not an atomic coordinator, and a losing refresh before winner publication remains fail-closed. Actual request failures log the portal ID and allowlisted failure classification, never grants, headers, endpoints or raw OAuth errors. These corrections do not establish the cause of a historical disconnect. <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken --> <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal -->

Source qualification, seed publication, local reload, deployment and real downstream authorization acceptance are distinct. ([REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery), [REQ-AGENT-229](../../sdd/spec/mcp.md#req-agent-229-worker-mediated-mcp-portal-transport)).

The managed Pi extension packages are installed in the settings `required` set, so they load in every Pi session independently of the context-mode toggle. This includes the exact-pinned native Goal package for session-scoped autonomous completion. On resource load, `context-mode-runtime.ts` installs the enabled adapter; at each user prompt the alphabetically final `zz-tool-exposure-finalizer.ts` exposes only `read`, `bash`, `edit`, `write`, and `capability`. Every other eligible registered tool remains searchable and activates additively for the next model step only through explicit exact-tool `name` activation; search itself never activates tools.

Unfinished Goal and active Plan workflows retain their owned controls. Plan receives its frozen read-only policy plus `plan_mode_question` and `plan_mode_complete`; configured `always` Goal visibility also retains Goal's terminal tools. Activating `subagent` exposes its result and steering controls. The schema-free `subagent-resume-guard.ts` blocks resume attempts for queued or running records through pi-subagents' public service without patching the package.

Registered and initially active schema sizes are reported separately, with no fixed tool-token gate ([REQ-AGENT-158](../../sdd/spec/agents.md#req-agent-158-bounded-initial-pi-tool-exposure)). Every Pi skill treats `ctx_*` tools as optional; explicitly disabled and child sessions use documented native fallbacks without narrowing work.

The repository-owned `native-notifications.ts` extension is seeded in both modes. It emits fixed OSC 777 text when `ask_user_question` needs attention through the package's stable `rpiv:ask-user:prompt` notifier channel. Immutable channel names and append-only payloads keep the signal compatible across package major upgrades, and it fires only when a questionnaire opens ([REQ-TERM-024](../../sdd/spec/terminal.md#req-term-024-pi-native-terminal-notification-producer)). <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications -->

Herdr now owns completion timing. The host reads every Pi or Claude pane across tabs and splits, then starts ten minutes only after all tracked panes become `idle` or `done`. Changes among those ready states keep the timer. Any `working` pane cancels it and clears queued completion; any `blocked` or `unknown` pane prevents completion. An initial all-ready snapshot does nothing ([REQ-TERM-029](../../sdd/spec/terminal.md#req-term-029-herdr-status-gated-terminal-completion), [REQ-TERM-038](../../sdd/spec/terminal.md#req-term-038-herdr-semantic-status-owns-completion-readiness)). <!-- @impl: host/src/herdr-agent-status.ts::HerdrCompletionDelay --> <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor -->

The Pi extension now emits only the fixed immediate input-required event. It has no settled-turn timer, failure producer, or subagent bookkeeping. Classic therefore has no completion notification. Eligible Herdr completion still displays `Ready for input` for Pi and `Task completed` for Claude. RPC mode remains untouched because the extension registers nothing there ([REQ-TERM-024](../../sdd/spec/terminal.md#req-term-024-pi-native-terminal-notification-producer), [REQ-TERM-039](../../sdd/spec/terminal.md#req-term-039-herdr-completion-delivery-is-readiness-oriented)). <!-- @impl: preseed/agents/pi/extensions/native-notifications.ts::nativeNotifications --> <!-- @impl: web-ui/src/lib/agent-notifications.ts::showGrantedAgentEvent -->

<a id="pi-notification-acceptance-evidence"></a>
Historical notification receipts remain in [Git history](https://github.com/nikolanovoselec/codeflare/blob/911196bc525c5ad9ab7ecf86480f3113b408a48c/documentation/lanes/preseed.md#pi-notification-acceptance-evidence). They do not qualify the current Herdr completion trigger; input-required and completion behavior are distinct contracts above.

<a id="pi-tool-exposure-acceptance-evidence"></a>
[REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-158](../../sdd/spec/agents.md#req-agent-158-bounded-initial-pi-tool-exposure), and [REQ-AGENT-159](../../sdd/spec/agents.md#req-agent-159-active-subagent-resume-guard) own exposure and resume-guard verification. Historical delivery receipts remain in [Git history](https://github.com/nikolanovoselec/codeflare/blob/911196bc525c5ad9ab7ecf86480f3113b408a48c/documentation/lanes/preseed.md#pi-tool-exposure-acceptance-evidence); measured provider token usage is not a fixed gate.

Claude needs no notification hook: both session-mode settings select Claude's built-in `ghostty` notification channel ([REQ-TERM-026](../../sdd/spec/terminal.md#req-term-026-claude-native-terminal-notification-producer)).

In-process subagents always use native fallbacks. The three PR reviewers expose only `bash` and consume their exact packet through the Bash/Node transport.

[`@juicesharp/rpiv-advisor`](../../preseed/agents/pi/package.json) provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. It provides the user-invoked `advisor` tool and user-only `/advisor` command. Codeflare overrides its startup guidance so assistants do not call or suggest advisor unless the user's current message explicitly requests it ([REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)).

Image-owned startup disables Pi Subagents mid-run messages through `~/.pi/agent/subagents.json` (`midRunUpdates: false`) after home restore and before extension loading. Restored `true` values are reset while unrelated preferences survive; invalid files remain intact with a content-free warning. Completion results and parent questions remain available. Explicit repository-local overrides follow upstream precedence. See [REQ-AGENT-216](../../sdd/spec/agents.md#req-agent-216-quiet-pi-subagent-defaults). <!-- @impl: entrypoint.sh::configure_pi_subagent_defaults -->

Subagents retains the public service accessor used by Codeflare's resume guard. Explicit invocation tool settings take precedence over agent frontmatter, which takes precedence over extension defaults. The owning manifests and locks hold exact package pins; installed entrypoints, complete warm/cache gates, and the RPIV compatibility contract are described in the [Pi package reference](../references/pi-packages.md#loading-and-warm-compatibility) ([REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation)).

`pi-web-access` retains configurable public tool names and Codeflare's default `web_search`, `source_check`, `fetch_content`, and paged `get_search_content` contracts. Search authenticates through Pi's model registry or zero-config Exa MCP, so it needs no per-user API key. Provider errors, structured results, Perplexity snippets, OpenAI model defaults and session isolation follow the [reviewed package behavior](../references/pi-packages.md#context-mode-and-web-access), without changing Codeflare's public-link policy. Paid Ceramic remains explicit-only and excluded from `auto`/`all`. The image warms the native `dist/index.js` extension, not the optional standalone MCP CLI. Upstream no longer supplies its duplicate `librarian`; Codeflare preserves the owned workflow in both Pi modes under [REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility).

Smart Compact is installed in both Pi modes with provider-neutral Auto/EESV defaults and automatic replacement at Pi's native compaction boundary, not an earlier percentage trigger. The preset is seeded only when neither `smartCompact` nor its supported legacy `semanticCompact` alias exists; existing valid preference values, including empty or partial sections, survive reload and R2 restore unchanged. Settings remain byte-unchanged unless a package-registration migration is needed. Its footer, extra memory and agent tools default off; existing capture and post-compaction recall remain active. Package loading, bounds and image/publication prerequisites are in the [Pi package reference](../references/pi-packages.md#smart-compact) ([REQ-AGENT-222](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults), [REQ-AGENT-223](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation)).

Evaluate's user-invoked contract/output reporting and managed Usage retirement live in the [Pi package reference](../references/pi-packages.md#user-workflows-and-retirement) ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions), [REQ-AGENT-209](../../sdd/spec/agents.md#req-agent-209-retired-pi-package-migration)). [Open TUI](../references/pi-packages.md#native-terminal-ui) owns the terminal header, footer and editor in both modes; filtered npm discovery prevents duplicate initialization by the managed adapter. Installation does not authorize unrelated workflows or establish deployed acceptance.

`@narumitw/pi-plan-mode` uses the reviewed exact pin in the canonical [Pi package inventory](../references/pi-packages.md#source-inventory), with registry provenance retained in the committed lockfile. It registers `dist/index.ts` and provides the `/plan` collaboration workflow, read-only planning policy, structured questions, explicit completion, and implementation handoff. Candidate image/startup and deployed acceptance remain pending.

Its helper schemas and active-only policy discovery conflict with Codeflare's five-tool provider boundary. The image therefore applies one exact-version transform: helper availability and configured policy resolve from registered tools, then the finalizer exposes the frozen Plan policy and helpers during Plan turns. Version, source-layout, or partial-patch drift fails before any package write. The installed entrypoint is loaded and fail-closed verified in the image's path-correct JITI cache ([REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions)). <!-- @impl: scripts/patch-pi-plan-mode-tool-policy.mjs::patchPiPlanModeDirectory -->

After restore on every container start, `entrypoint.sh` atomically replaces `~/.pi/agent/pi-plan-mode.json`. The managed policy inherits the session thinking level, keeps an approved implementation plan active, and enables built-in read/limited-shell tools plus bounded Browser Run, web retrieval, context-mode indexing/search, and Graphify query tools when those tools are available. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

It deliberately excludes the general questionnaire, arbitrary context-mode command execution, MCP, delegation, task mutation, and advisor surfaces because Plan Mode owns its own structured question and completion tools. No shortcut or export path is configured. `/plan save` stays session-local. A pathless `/plan export` uses upstream's `PLAN.md` default; users provide an explicit path when exporting elsewhere, such as `/plan export "/home/user/Vault/Implementation Plans/<name>.md"`. Codeflare ships no automatic plan-file writer. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

Herdr retains private XDG state while directing Pi to the canonical `~/.pi/agent` configuration root ([REQ-AGENT-172](../../sdd/spec/agents.md#req-agent-172-herdr-preserves-the-canonical-pi-configuration-root)). <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime -->

Default and advanced Pi projections include an on-demand Herdr control skill. It first checks for a live Herdr pane, then documents the local CLI needed to resolve and focus tabs, create or safely close splits, create helper panes, start and steer named coding agents, wait on bounded lifecycle states, and read their output. Plain Codeflare terminals do not start Herdr. Skill metadata owns this conditional route; `SYSTEM.md` remains runtime bootstrap only ([REQ-AGENT-173](../../sdd/spec/agents.md#req-agent-173-pi-can-orchestrate-coding-agents-through-herdr), [REQ-AGENT-174](../../sdd/spec/agents.md#req-agent-174-pi-safely-controls-herdr-topology)). <!-- @impl: preseed/agents/pi/skills/herdr/SKILL.md::Gate -->

Plan Mode and Goal use the exact pins in the [Pi package inventory](../references/pi-packages.md#source-inventory) and share upstream's session-scoped `workflow:mutex:v1` protocol, so starting one workflow while the other owns the session is refused and ending it releases ownership ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions), [REQ-AGENT-178](../../sdd/spec/agents.md#req-agent-178-goal-and-plan-session-ownership)).

`@narumitw/pi-goal` remains the normal upstream package, with its reviewed exact pin recorded in the [Pi package inventory](../references/pi-packages.md#source-inventory) and registry provenance retained in the committed lockfile. Codeflare does not vendor or fork it. The MIT package publishes both generated `dist` and authored `src`, and registers `/goal`, `goal_complete`, `goal_blocked`, and `goal_wait` without managing subagent files. Codeflare's reviewed transform adds the current-Goal-fenced `goal_progress` evidence report through the same native tool lifecycle.

The finalizer also rejects `goal_wait` at `tool_call`, even if another extension reactivates it, without blocking other tools. The managed exposure filter omits `goal_wait` from its own tool selections, search, and activation paths. Other extensions can re-expose its schema, so the execution guard—not visibility alone—enforces the prohibition. <!-- @impl: preseed/agents/pi/extensions/zz-tool-exposure-finalizer.ts::finalizeToolExposure -->

Codeflare's compact Goal prompts retain the objective and current-Goal guard and require explicit evidenced progress reporting. Startup supplies missing lazy visibility and unlimited productive automatic work, and enforces `noProgressTurns: 5` and `minIntervalMs: 300000`, including disabled legacy safety. Explicit automatic-work preferences, unknown fields, `rpc` and existing visibility remain preserved. Missing advancement reports count as stalled; ordinary tool use, polling, extraction and rephrasing cannot reset the streak. The fifth stalled automatic continuation or the persisted 25-minute stalled deadline blocks and cancels future continuation; expired restoration blocks at the first available execution. Explicit resume starts a fresh round. <!-- @impl: entrypoint.sh::PI_GOAL_STARTUP_CONFIG -->

A malformed file is left byte-for-byte alone rather than being "repaired" by startup. There is no settings-panel patch for these Codeflare-owned startup values.

On reload, `capability-helpers.ts` keeps registered `goal_complete`, `goal_blocked` and `goal_progress` controls active after any valid Goal state when no Plan is active, while always removing `goal_wait`. A fresh lazy session returns to the five bootstrap tools; an active Plan suppresses non-active Goal history unless `pi-goal.json` configures `always`. The final exposure filter applies this policy after Goal's exact-version transform activates its registered terminal tools ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions) AC4/AC6; [REQ-AGENT-191](../../sdd/spec/agents.md#req-agent-191-goal-tool-visibility-across-workflows) AC1-AC6). <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::registerInitialToolFilter --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalToolPolicySource -->

The September Pi upgrade retains the session-shutdown/stale-context guards in the [reviewed Goal release fixture](../../host/__fixtures__/pi-goal-0.54.8.tgz), adapts its two-space source formatting, and preserves the parsed-command safety patch in Plan's new TypeScript chunk. Continuation/review-control and command-safety contracts remain under [REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing), and [REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions). The historical Usage entrypoint update is superseded by managed Usage retirement. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory --> <!-- @impl: scripts/patch-pi-plan-mode-tool-policy.mjs::patchPiPlanModeDirectory -->

Context-mode and Evaluate [remain pinned](../../preseed/agents/pi/package.json). Existing skill tool names remain unchanged; web-access's optional `web_enable` loader follows its configured `toolActivation` policy, and an old resumed session may need a new session to acquire its recorded web-tool selection. See the [upstream Tool activation guidance](https://github.com/nicobailon/pi-web-access/blob/7bd4509ee4e417a9e0141235bbe276ff77aa81e3/README.md#tool-activation).

The [Pi package reference](../references/pi-packages.md#loading-and-warm-compatibility) owns current native-MCP and adapter lifecycle behavior. Managed startup disables `builtin:mcp` with `-builtin:mcp`, preserves unrelated extension selections, and leaves pi-mcp-adapter as the managed MCP lifecycle owner. A historical command-replacement warning is not proof of correct ownership or itself a crash diagnosis.

The image-owned questionnaire transform completes an unanswered Pi `ask_user_question` after five minutes. It keeps completed answers and notes, defaults only unanswered questions to their first authored option, and finishes through the existing TUI/native-dialog lifecycle. Automatic answers remain labelled and are not manual responses. Only verified successful automatic recommended selections count as standing user-delegated authorization without routine re-confirmation; other defaults gain none, and protected server grants, security boundaries and platform constraints remain unchanged ([REQ-AGENT-218](../../sdd/spec/agents.md#req-agent-218-bounded-pi-questionnaire-wait)). Cancellation, abort, errors and independent invocations retain their distinct outcomes ([REQ-AGENT-219](../../sdd/spec/agents.md#req-agent-219-pi-questionnaire-cancellation-and-isolation)); Claude and Plan Mode questions are unchanged.

The exact-version/source guard runs before image JITI warming, after package update/repair and in the shared RPIV shadow-pin verifier ([REQ-AGENT-220](../../sdd/spec/agents.md#req-agent-220-managed-questionnaire-preparation), [REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation)). Source implementation is present; final exact-head CI and deployed acceptance remain separate gates. <!-- @impl: Dockerfile::patch-rpiv-question-timeout --> <!-- @impl: entrypoint.sh::update_pi_and_codex_when_fast_start_disabled --> <!-- @impl: scripts/verify-rpiv-host-peers.mjs::verifyRpivExtensionStartup -->

RPIV declares host `typebox` as a wildcard peer rather than a runtime dependency. The shared image/startup preparation remains idempotent for this metadata and repairs older dependency-shaped installations after restore or npm repair. All three extensions must still load without host-dependency warnings through both installed Pi SDKs under [REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation). The built-in `/mcp` replacement warning is a separate compatibility observation and does not weaken that gate.

Startup removes explicit retired package identities from persisted settings. It drops `pi-goal-list-loop-audit` so its Explore ownership warning cannot survive an image upgrade, and removes the previously image-owned response package so an upgrade cannot reload it. Unrelated user-added packages remain preserved. Goal's runtime dependencies remain integrity-locked in the committed preseed lock ([REQ-AGENT-209](../../sdd/spec/agents.md#req-agent-209-retired-pi-package-migration)). <!-- @impl: entrypoint.sh::removedPackageIds -->

The [Pi package reference](../references/pi-packages.md#goal-and-plan-transforms) owns Goal's exact-version transform, entrypoint normalization, fail-closed warm/preflight gates, trusted controller pause/resume compatibility, and generation-fenced continuation timer. Its contracts remain [REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-114](../../sdd/spec/agents.md#req-agent-114-review-owned-goal-continuation), [REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy), [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing), [REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility), and [REQ-OPS-020](../../sdd/spec/operations.md#req-ops-020-shadow-pin-version-bump-automation). Startup configuration and review-boundary delivery remain here.

For reviewer-bearing PR boundaries, `review-enforcement.ts` emits the review launch plan without pausing Goal or recording Goal-control ownership. Review preserves the current Goal identity and state and works without Goal installed or available. Reviewer, exact-head CI, triage and completion gates remain independent of Goal ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-independent-pr-review) AC1-AC2).

Acknowledged review completion delivers `pr-boundary-fix-follow-up` without resuming or replacing Goal. FIX, abandoned review work and PR closure preserve an explicit user pause ([REQ-AGENT-113](../../sdd/spec/agents.md#req-agent-113-goal-independent-review-completion) AC1-AC2). Session startup ignores legacy review-owned pause records for Goal control; it neither resumes Goal nor rewrites those records ([REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-goal-independent-review-restoration) AC1).

Review ingress now has one durable fact: the current exact PR identity has a user-scoped completion marker, or it does not. Pi resolves only the active checkout at startup, resume, clone, switch, checkout, pull, a successful PR merge that changes the active checkout or full `HEAD`, push, PR creation, and PR reopen. Claude applies the same rule through SessionStart, PreToolUse merge snapshots, and PostToolUse.

Enterprise Review selection resolves a successful clone's produced checkout, not the directory that ran the clone. Failed clones and confirmed non-candidates—no SDD, no PR, closed PR or unprotected base—are inert; authentication, transport, malformed-response and trusted-selection failures remain unavailable rather than falling back to local Review. The selector reuses the canonical clone-target and preexistence guards without changing consent ([REQ-OPERATOR-053 AC3](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff), [REQ-AGENT-169 AC1](../../sdd/spec/agents.md#req-agent-169-clone-consent-lifecycle)). These source corrections do not establish the cause of an earlier deployed warning. <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::selectOperatorReviewApplicability -->

In a repository containing `sdd/README.md`, a push qualifies only when the checked-out branch heads an open PR to `develop`, `main`, or `master`; PR creation and reopen qualify only for those protected bases. Repositories without that SDD file do not enter boundary review, avoiding SDD-specific review machinery where SDD has not been adopted. A qualifying transition with no marker emits the deterministic review-and-CI launch plan, and the root ends that turn immediately. Other marker misses offer `Mark review complete` and `Launch review`. Fetch, inspection, local mutation, merges without an active-checkout or full-`HEAD` transition, detached or path checkout, and unrelated-ref pushes stay inert ([REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions); [REQ-AGENT-171](../../sdd/spec/agents.md#req-agent-171-user-scoped-review-completion-and-common-consent)).

A selected or automatic launch still uses the established lane classifier, deterministic temporary reports, and exact-head CI correlation. Pi keeps one current round in memory. Claude limits transcript inspection to bytes after one `/run/codeflare/review-session` offset. Neither runtime persists partial lane state, a launch decision, retry work, counters, or missing-work demands. If work stops or the process reloads, the next delivery starts a fresh round and the next non-delivery exposure asks again. This is deliberate. Recovering half a review was the mechanism that kept reviving old authority.

After canonical triage, FIX handling revalidates the exact GitHub identity and writes its marker before emitting the existing FIX follow-up. Marker files live under `~/.codeflare/review-state/v1`, retain ten heads per repository and branch, expire after 30 days, and sync through the common home-directory R2 filters. The local write does not wait for or trigger R2; regular cadence or final sync carries the marker, so another device may repeat the prompt before convergence ([REQ-STOR-027](../../sdd/spec/storage.md#req-stor-027-review-completion-marker-sync)).

No executable review source reads or migrates `.git/sdd-review-*` files. Linked worktrees and separate clones therefore observe the same marker when they share the user's R2 bucket. Review coordination does not pause or resume Goal; session restart never reconstructs review ownership from an old transcript.

`@juicesharp/rpiv-todo` is pinned in the owning manifest; its overlay loads lazily, expands complete tool output when requested, restores bounded widget height after collapse, and narrows model guidance to multi-step task lists. The upstream session-isolation correction remains intact: task state is keyed by Pi session ID and context-free rendering stays bound to the foreground slot. The temporary [AD100](../decisions/README.md#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) source override that preceded the upstream fix is retired — no postinstall guard or payload remains, and a host test guards the reviewed version and integrity ([REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation)).

`web_search` defaults to the `auto-summary` workflow via a preseeded, create-if-missing `~/.pi/web-search.json` (`{"workflow": "auto-summary"}`). A user who edits that file to opt back into the interactive `summary-review` workflow has their choice respected on later boots.

The [upstream web-access fix](https://github.com/nicobailon/pi-web-access/releases/tag/v0.14.0) addresses the former interactive-curator fallback crash. The container remains headless, so `auto-summary` is still the only default workflow that can complete without a browser-approval UI; users who deliberately provide such a UI may retain their own `summary-review` setting.

### Pi prompt ownership and budget

Pi uses metadata-backed discovery rather than an eager generated Skills index. `capability` searches relevant tools and eligible skills; optional case-insensitive `tool:` and `skill:` prefixes narrow the kind. `query: "skill:graphify"` returns the exact eligible skill and its actual path. Results contain at most three relevant compact matches, not a catalog. Use ordinary native `read` for a needed skill, read known paths directly, and reuse loaded guidance. Search never reads bodies or references, activates tools, or connects servers; exact tool `name` activation remains separate and takes precedence over `query`.

The compiler emits a per-mode `.pi/agent/capability-skill-policy.json` from original invocation metadata before hiding seeded native catalog entries. It includes false entries and no descriptions. At `before_agent_start`, discovery observes Pi's selected resource winners, paths, and provenance and refreshes a scalar snapshot; `session_start` clears it. Hidden skills need an affirmative validated policy match to their canonical user/top-level seed path. Originally restricted skills, project/package overrides, and symlink escapes acquire no exception; untrusted project skills are excluded. Missing or malformed policy grants no exceptions while ordinarily invocable native skills remain eligible. Discovery neither scans skill directories nor owns subsequent context. <!-- @impl: scripts/agent-seed-core.mjs::finalizePiSkillDiscovery --> <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::eligibleSkillSnapshot -->

Constitution, eager Git/review and startup/resume rules, local-execution gates, Vault guidance, package catalogs, bootstrap/reset behavior, Goal/Plan/Inline ownership, and `/ctx` remain unchanged. ([REQ-AGENT-095](../../sdd/spec/agents.md#req-agent-095-compact-pi-skill-catalog), [REQ-AGENT-096](../../sdd/spec/agents.md#req-agent-096-on-demand-pi-tool-activation))

The measured pre-reduction Pi provider-boundary system prompt is 32,416 characters in an isolated working directory. The migration target is at most 14,000 characters in both modes for the image fallback and signed managed projection. Serialized registered-tool schemas and additive project context are reported separately; project context remains byte-unaltered and cannot make the controlled prompt fail its cap.

Codeflare owns Pi prompt assembly, `SYSTEM.md`, compact shared `AGENTS.md`, executable hard-policy guards, compiler support, and the image fallback. `codeflare-curation` owns its managed source inventory, modes, invocation visibility, managed projection measurement, and signed publication. A shared fallback path cannot complete delivery while its managed bytes remain stale. An explicit checkpoint alignment covers the entire compiler-eligible canonical Claude/Pi inventory, including additions, removals, mode metadata, and historical retirements; it is not limited to paths already shared. Completion requires the recorded source comparison, protected real-runtime curation evidence for both managed modes, and immutable signed publication. Compiler-pin synchronization is a separate six-input comparison under [REQ-AGENT-148 AC5](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication). The lossless migration ledger is `scripts/pi-prompt-rule-ledger.json` ([REQ-AGENT-156](../../sdd/spec/agents.md#req-agent-156-bounded-lossless-pi-prompt)).

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC1/AC2/AC4/AC6, [REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport) AC1-AC3, and [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership); source: `entrypoint.sh::warm_pi_npm_dependencies` (filtered context-mode package + tool extensions), `preseed/agents/pi/extensions/context-mode-runtime.ts` (foreground ownership), `preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand` (state-changing `/ctx on|off` persistence + reload), the Pi reviewer agents (Bash-only transport), the main-execution web-search default block, `preseed/agents/pi/skills/advisor/SKILL.md`, and `preseed/agents/pi/package.json`.

**Storage**: `sessionMode?: 'default' | 'advanced'` in
`UserPreferences` (KV). Undefined = `'default'`.

**Resolver**: `resolveSessionMode(prefs, env?)` in
`src/lib/session-mode.ts` -- single source of truth for the
`?? 'default'` fallback. Under `ENTERPRISE_MODE`, it short-circuits to
`'advanced'` before consulting `prefs`, so a JIT-provisioned enterprise
user with no stored preference still resolves to Pro
([REQ-ENTERPRISE-001](../../sdd/spec/subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2). Consumers resolving the current mode use this resolver (with billing entitlement clamping where required). Preference writes still validate the requested mode and compare raw persisted values for change detection and reconciliation publication fencing; those comparisons do not resolve the current mode ([REQ-AGENT-004](../../sdd/spec/agents.md#req-agent-004-two-session-modes-standard-and-pro) AC2). <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)) -->

**When mode takes effect**: On any of: explicit "Recreate AI agent
skills & rules" click, new bucket creation, Stripe mode change
(upgrade or downgrade via webhook), subscription termination
(`customer.subscription.deleted`), Settings toggle of
`sessionMode`, automatic upgrade on release (triggered by
`preseedNeedsUpgrade: true` in the initial dashboard ancillary-status
response; see
[REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release)),
or the one-time enterprise Pro upgrade — at session start or first
dashboard load (same `preseedNeedsUpgrade` UPDATING affordance as a
release upgrade) — for a pre-existing bucket whose stored preference
is not yet `advanced` (stamped only after a successful reconcile, so
a failure retries;
[REQ-ENTERPRISE-001](../../sdd/spec/subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC6/AC7).

The Settings toggle immediately triggers server-side reconciliation
as part of the `PATCH /api/preferences` call -- no separate Recreate
click is required; the UI shows a confirmation ("Agent skills updated
for X mode. Takes effect in new sessions.") when the toggle
completes. On Stripe-driven or Settings-driven reconciliation,
preseed files are overwritten to match the new mode. Ordinary personal
files outside the authorized cleanup scope are preserved; verified
inactive-agent paths and Exclusive governed roots follow the deletion
rules below. Implements
[REQ-AGENT-004](../../sdd/spec/agents.md#req-agent-004-two-session-modes-standard-and-pro) AC4 - AC5 and
[REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers).

**Recreate and mode projection:** `getConfigsForMode()` validates unique target keys within each mode, and `getPreseedKeysNotInMode()` excludes variant-per-mode keys still live in the target mode. Storage owns exact deletion authorization, verified inventories, provenance, preflight bounds, conditional mutation, readback, and success-only publication. See [Durable seed reconciliation](storage-and-sync.md#durable-seed-reconciliation) and [Managed-resource persistence modes](storage-and-sync.md#managed-resource-persistence-modes).

Recreate is an explicit user-triggered rescue for a broken agent environment, not an automatic action. It deliberately replaces user-edited managed skills, rules and related agent files with the selected curated or baked versions. User-created Vault files and unrelated user files remain untouched. Automatic upgrades and mode-change reconciliation are separate workflows ([REQ-AGENT-011](../../sdd/spec/agents.md#req-agent-011-agent-skills--rules-manually-recreatable-from-settings)).

Direct automatic Mutable deltas preserve unchanged markerless user edits; manual Recreate and mode changes overwrite desired paths. Provenance governs active-agent retirement, while verified inactive ownership authorizes exact deletions. Exclusive reconciliation is destructive inside governed roots only after admission and preflight gates. Do not generalize this into “no listings” or “user files are never touched”.

Durable seed ownership and cleanup are documented in [Storage & Sync](storage-and-sync.md#durable-seed-reconciliation). Provenance retirement, verified inactive-path deletion, historical signed retirements, interrupted-target recovery, and direct applied-to-target deltas have distinct authorization rules. Observational progress and successful POST responses are not applied-state proof.

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
| Generated seed | `scripts/generate-agent-seed.mjs` output | Image-baked `/opt/codeflare/agent-seed-bake/<mode>/<key>` |
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

**Skills** (each preseeded as `<name>/SKILL.md`) retain focused product and workflow
ownership. Core entries include `cloudflare-stack`, `ship` (+ reference files),
`consult-llm`, `humanize` (+ measurement reference), `spec-driven-development`
(+ reference templates for `/sdd init` scaffolding), `sdd-init`, `sdd-clean`,
`vault-operations`, `vault-note-capture`, and `graphify`. Platform and design specialists
remain under their routed owners. Generic language, architecture, framework, migration,
deployment-pattern, retrieval, search-first, and debugging advice packs are absent;
repository evidence and current authoritative platform sources govern those decisions
([REQ-AGENT-196](../../sdd/spec/agents.md#req-agent-196-repository-led-technology-guidance)).

Standard and Advanced managed sessions include `codeflare-capabilities`. A broad capability or onboarding question loads only its router and teaches the complete catalog in direct first-person active voice with exact Cloudflare product names. It connects end-to-end engineering ownership, proof, browser workspaces, specialist coordination, continuity, durable knowledge, design, persistence boundaries, and configured controls through concrete outcomes and honest limits, then gives the user a bounded-task launchpad and a stable numbered menu. Seeded onboarding, documentation, toolchain, and example tutorials use the same agent-owned voice while factual platform controls retain their real owners. ([REQ-AGENT-189](../../sdd/spec/agents.md#req-agent-189-layered-codeflare-capability-discovery), [REQ-AGENT-190](../../sdd/spec/agents.md#req-agent-190-portable-capability-discovery-delivery))

The tutorials present Codeflare's memory subsystem as durable Vault knowledge with automatic future retrieval, state that every Enterprise session receives advanced capability scope with Pi as the primary agent, and keep deployment credentials and supported intercepted credentials outside Enterprise containers. Questions scoped to a repository, file, component, failure, or task use that context instead of the generic tour. ([REQ-AGENT-207](../../sdd/spec/agents.md#req-agent-207-user-focused-capability-deep-dives), [REQ-AGENT-190](../../sdd/spec/agents.md#req-agent-190-portable-capability-discovery-delivery))

The seven image-baked Storage tutorials remain user material rather than Codeflare implementation documentation. Getting Started opens with a session and the broad capability question, the Documentation overview gives a workspace summary and next-step links, Toolchain walks one user-owned Workers deployment, and Examples supplies three bounded project specifications plus their execution guide. Actual Codeflare architecture and operator detail remains in this documentation collection. ([REQ-AGENT-207](../../sdd/spec/agents.md#req-agent-207-user-focused-capability-deep-dives))

Replies `1` through `14`, comma-separated selections, and named follow-ups load only the selected references: SDD, boundary reviews, curation, durable data and ephemeral compute, terminals, Browser IDE, Zero Trust, interceptors, Cloudflare Gateway, MCP portals, Cloudflare AI Gateway, Browser Run, agentic primitives, and design systems. Each deep dive teaches one practical path, qualifies configuration dependencies, and includes something the user or operator can try. Tutorials use Codeflare to advance the user's work; internal source paths, requirement IDs, implementation anchors, and maintainer navigation remain internal evidence rather than user-facing content. The interception deep dive explains supported connections without asking ordinary users to inspect tokens or administrator telemetry. ([REQ-AGENT-207](../../sdd/spec/agents.md#req-agent-207-user-focused-capability-deep-dives))

Selected pages are complete first-person answers; examples remain unexecuted until separately requested. Literal model reproduction is best-effort, not a byte-exact guarantee. ([REQ-AGENT-207](../../sdd/spec/agents.md#req-agent-207-user-focused-capability-deep-dives))

Pi's compact routing rule covers broad capability and onboarding questions (including “What can you do?”), tour requests, and numbered tutorial replies. It directs Pi to read the router's installed `SKILL.md` path before answering and explicitly excludes `capability` for these broad tutorial requests. General task discovery can search tools and skills, but skill names are never tool activation requests. No platform inventory enters the always-loaded prompt. The curation tree owns managed tutorial content and compiler fan-out. The separately versioned image fallback is not a second tutorial editing target. ([REQ-AGENT-096](../../sdd/spec/agents.md#req-agent-096-on-demand-pi-tool-activation), [REQ-AGENT-190](../../sdd/spec/agents.md#req-agent-190-portable-capability-discovery-delivery))

The SDD enforcement family is advanced-only: `spec-enforce` +
`spec-enforce-ac` + `spec-enforce-truth`, `doc-enforce` +
`doc-enforce-lanes` + `doc-enforce-shape` + `doc-enforce-truth`, and
`tdd-enforce`. `spec-enforce-truth` requires at least one resolving `@test`
anchor per non-manual AC, parses multiple anchors independently, and validates
every declared block ([AD108](../decisions/README.md#ad108-per-ac-test-evidence-permits-multiple-resolving-anchors)). The git-workflow family is `ci-monitoring`,
`git-review-pipeline` (advanced-only), `pr-workflow`, and `deploy-credentials`.

Every PR creation or material title/body rewrite reads one canonical authoring reference regardless of either branch. The body uses a stable sequence for summary, shipped behavior, explanatory issue/PR/requirement/decision links, exact evidence, boundaries, completion state, and final review history. Detail scales to the change; raw requirement and commit catalogs do not count as traceability. The reference combines GitHub's linking behavior with the recurring evidence patterns in the latest 50 Codeflare `develop`-to-`main` promotions ([REQ-AGENT-212](../../sdd/spec/agents.md#req-agent-212-canonical-pull-request-history-record)).

Managed curation source and the aligned baked fallback provide the advanced design family: `design` routes by work mode, purpose, platform, and available direction to one web, mobile, desktop, static, or incumbent authority, while components, performance, motion, and available finishing tools remain subordinate. Shared operational and component references preserve that platform owner. The inventory includes `desktop-native-design` and `motion-design` and excludes UI UX Pro Max and `emil-design-eng`. ([REQ-AGENT-179](../../sdd/spec/agents.md#req-agent-179-portable-visual-design-routing), [REQ-AGENT-180](../../sdd/spec/agents.md#req-agent-180-portable-frontend-design-authority), [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility), [REQ-AGENT-182](../../sdd/spec/agents.md#req-agent-182-purpose-and-platform-design-routing), [REQ-AGENT-183](../../sdd/spec/agents.md#req-agent-183-native-mobile-design-authority))

Operational dashboards establish operator decisions, density, data quality, workflow, and responsive scope before selecting components. Component registries provide implementation material only after information architecture and visual direction exist. Framework performance follows repository evidence and measured browser results rather than a generic React or Next.js recipe; protected or input-dependent I/O starts after validation and authorization. ([REQ-AGENT-184](../../sdd/spec/agents.md#req-agent-184-operational-information-design), [REQ-AGENT-185](../../sdd/spec/agents.md#req-agent-185-component-system-and-registry-boundaries), [REQ-AGENT-188](../../sdd/spec/agents.md#req-agent-188-external-design-dependency-safety))

External skills, registries, MCP servers, presets, and package commands remain untrusted until reviewed and never execute merely to determine applicability. Simple motion stays in CSS or the incumbent system; specialist choreography activates only for demonstrated complexity. Missing registries, MCP access, or animation tooling do not block the owning workflow. ([REQ-AGENT-186](../../sdd/spec/agents.md#req-agent-186-conditional-complex-motion-delegation), [REQ-AGENT-188](../../sdd/spec/agents.md#req-agent-188-external-design-dependency-safety))

Advanced Pi carries one short always-active rule that loads `design` only for visual work. When installed, `impeccable` keeps its explicit multi-command skill and native offline/live detector, while implicit discovery narrows to critique and finishing. Its aesthetic detections are advisory until the brief, platform, incumbent system, approved evidence, and selected owner establish whether the pattern is justified. ([REQ-AGENT-179](../../sdd/spec/agents.md#req-agent-179-portable-visual-design-routing), [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility))

Routing-guidance evaluation does not establish rendered, device, accessibility or performance acceptance. [REQ-AGENT-137](../../sdd/spec/agents.md#req-agent-137-design-skill-review-boundary) and [REQ-AGENT-187](../../sdd/spec/agents.md#req-agent-187-design-routing-evaluation-matrix) retain the separate routing and evaluation obligations.

Impeccable is scoped to Claude + Pi only: Claude gets the vendored tree in
`~/.claude/skills/impeccable/`; Pi gets a dedicated copy under
`~/.pi/agent/skills/impeccable/` with paths re-pointed. Both launchers use the versioned, image-owned native engine, never a runtime download or self-update; boot and successful sync restore their executable bits. ([REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility))

A fail-closed updater overlay preserves evidence-bound web and native audit scoring, complete rating thresholds, platform-aware target guidance, `PRODUCT.md` context, contextual browser-surface advice, neutral specialist framing, and removal of mutable package permission across upstream refreshes. The image builds the native engine from checksum-pinned source with configured idle-grace and no-symlink raster-scan corrections. Behavioral tests cover executable wait state and updater mutation boundaries without pinning aesthetic prose. The vendored bundle is shadow-pinned by `bump-shadow-pins.yml`, whose reviewed repository update refreshes both copies, updates both manifests, and regenerates the seed. ([REQ-AGENT-137](../../sdd/spec/agents.md#req-agent-137-design-skill-review-boundary), [REQ-AGENT-163](../../sdd/spec/agents.md#req-agent-163-impeccable-browser-question-idle-lifecycle), [REQ-AGENT-164](../../sdd/spec/agents.md#req-agent-164-impeccable-raster-scan-traversal), [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility), [REQ-AGENT-194](../../sdd/spec/agents.md#req-agent-194-evidence-bound-impeccable-policy))

Impeccable launcher/engine pairings and retained compatibility engines are owned by the [image manifests](../../image/impeccable-engine.json) and [`Dockerfile`](../../Dockerfile). Neither launcher downloads a missing engine or silently selects another version. The native-layout refresh excludes the retired JavaScript-server overlay; the Rust toolchain and every upstream source are checksum-pinned. PR Checks compile focused probes from the exact affected upstream Rust logic, reproduce early closure and symlink traversal, and verify the patched wait and scan boundaries in under one minute without building a container. The deployment image build separately compiles and exercises the complete native binary. ([REQ-AGENT-163](../../sdd/spec/agents.md#req-agent-163-impeccable-browser-question-idle-lifecycle), [REQ-AGENT-164](../../sdd/spec/agents.md#req-agent-164-impeccable-raster-scan-traversal), [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility), [REQ-OPS-058](../../sdd/spec/operations.md#req-ops-058-fast-impeccable-native-engine-regression), [REQ-OPS-059](../../sdd/spec/operations.md#req-ops-059-complete-impeccable-native-binary-verification))

A missing image engine fails explicitly instead of downloading one. Managed-source alignment must also carry this native bundle and remove its obsolete JavaScript implementation from source and manifests. Native-engine availability is separate from npm hash equality. Publish the new curation source only after the new image and matching deployed compiler/runtime hash are verified; publication and activation remain separate gates. ([REQ-AGENT-163](../../sdd/spec/agents.md#req-agent-163-impeccable-browser-question-idle-lifecycle), [REQ-AGENT-164](../../sdd/spec/agents.md#req-agent-164-impeccable-raster-scan-traversal), [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility), [REQ-OPS-058](../../sdd/spec/operations.md#req-ops-058-fast-impeccable-native-engine-regression), [REQ-OPS-059](../../sdd/spec/operations.md#req-ops-059-complete-impeccable-native-binary-verification))

The shared compiler emits Impeccable's `scripts/VERSION` and `scripts/impeccable.cmd` as plain text and `scripts/impeccable` as a shell script in both native trees. Unknown file types still fail signed-release validation; do not allow binary documents to work around a missing text/script classification. This compiler change requires advancing curation's pin after successful Codeflare deployment. ([REQ-AGENT-147](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases) AC2/AC4)

The Apache-2.0 Cloudflare bundle tracks
[`cloudflare/skills@f96bff7`](https://github.com/cloudflare/skills/commit/f96bff754e428838818017f75817f0f9428acd48).
Its former ambiguous `sandbox-sdk` entry is replaced by `sandbox-stable`,
`sandbox-next`, and `sandbox-migrate-to-next`, preventing stable string-command
APIs from being mixed with the preview argv/process-handle APIs. The
Turnstile skill is refreshed from
[`30553f8`](https://github.com/cloudflare/skills/commit/30553f89ae1ef1e3c2917cd09d72dac992bb4e9a),
then locally hardens API calls with bounded deadlines and behavioral tests
([REQ-AGENT-138](../../sdd/spec/agents.md#req-agent-138-bundled-turnstile-scripts-fail-closed));
obsolete deployment templates are retired in favor of the current siteverify-first
runbook and scripts. Codeflare retains the mega-skill's decision-tree `SKILL.md`, removes dangling `references:` frontmatter and excludes the `references/` tree. The recorded slimming rationale avoids a 319-file reference snapshot (~2.2 MB per agent); these figures are not a runtime ceiling or new measurement.

The `paths:`-scoped `rules/cloudflare-workers.md` carries retrieval-first WebFetch guidance for `developers.cloudflare.com` only on Workers files, not always-on. Upstream `.mcp.json` is not bundled: its remote-MCP/interactive-OAuth approach is incompatible with enterprise strict egress. These artifact choices implement [REQ-AGENT-075](../../sdd/spec/agents.md#req-agent-075-cloudflare-platform-skills-bundled-into-the-advanced-seed); the manifest pipeline, complete platform scope and Apache attribution remain unchanged.

Skills are preseeded to `~/.claude/skills/<name>/SKILL.md` and adapted equivalents
for agents that support skills. `consult-llm` is scoped to Claude + Pi only. On
container start, `configure_consult_llm` keeps the skill and MCP server only when
at least one provider is usable (Codex login or `CODEFLARE_OPENAI_API_KEY`/
`CODEFLARE_GEMINI_API_KEY`); when no provider is usable, and in Enterprise Mode,
it removes the Claude/Pi skill directories so no agent sees a skill for a missing
MCP server. Its skill hard-gates use to explicit current user requests naming
external LLMs/GPT, ChatGPT, Gemini, or OpenAI; see [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)
and [REQ-AGENT-067](../../sdd/spec/agents.md#req-agent-067-consult-llm-invocation-and-model-selection-behavior).

Consult keys are read fresh from KV on each start. Authoritative absence travels as explicit `null` and clears warm namespaced keys and the emitted environment; omitted partial-update fields preserve existing values. Consult secrets are not persisted in DO storage. Bare provider names remain scoped to MCP children.

Claude receives consult-llm through `~/.claude.json`; Pi receives it through
`~/.pi/agent/mcp-adapter.json` using the native adapter proxy/deferred tools. The [Pi manifest and
lock](../../preseed/agents/pi/package.json) own the exact package and SDK pins.
Builtin MCP remains disabled so there is one managed lifecycle owner.

The active native adapter root is `.pi/agent/mcp-adapter.json` relative to the user's home; preserved originals, recovery copies and nested files retain their existing baseline/bisync eligibility ([REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration)).

Managed startup selects the native adapter and prepares `mcp-adapter.json` after restore. Valid native definitions remain authoritative over proven generated duplicates; missing supported legacy servers are imported. The exact obsolete `mcp.json` is archived before its active filename is retired. Genuine custom conflicts, unsupported expressions and unsafe paths fail closed. Stock-only loading and dual/unknown-selection guards remain unchanged. Native configuration, passive archives and nested files remain sync-eligible. Only successful handoff excludes the obsolete root from subsequent baseline/bisync; initial restore and failed handoff retain its eligibility. No bucket objects or OAuth stores are deleted. [REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration) owns the guards.

The native `mcp` proxy supports status, explicit connection, cached search/describe and schema-valid calls; verified deferred tools can also be activated through `capability`. Missing metadata defers startup unless the user explicitly configured otherwise; initializing the gateway runtime can then briefly start uncached servers for metadata only. This does not authorize consultation or external LLM inference. The next needed call reconnects after idle cleanup. Never replay an uncertain mutation just because transport reconnects. Consult remains gated on an explicit request; startup regenerates only recognizable image-owned entries and preserves custom commands, CA, credentials and unrelated settings.

Managed request timeout is `360000` ms, resetting on progress in this adapter; supported elicitation pauses it and task requests have individual timeouts. It is not a fixed total workflow deadline. Navigation guidance uses `120000` ms where supported. Ten-minute adapter idle cleanup, twenty-minute provider `keep_alive=1200000`, Chrome SDK/CDP operation budgets and owner website authentication are independent. Active calls are not idle-killed; no health-ping workaround is added. [REQ-BROWSER-009](../../sdd/spec/browser-run.md#req-browser-009-mcp-and-chrome-sdk-timeout-profile) owns the profile.

Configuration/startup fixtures and locked-extension synthetic servers qualify their respective boundaries, not deployed authenticated browser behavior. Changed revisions require exact-head CI and separately authorized deployed acceptance; method links and authored fixtures do not supply either.

Native stdio secret literals reserve leading `!`; generated literal values escape it with `!!`. Stock-to-native preparation escapes literals once and rejects unsupported expressions without evaluation. OAuth stores are not imported between clients. New package installation, signed curation delivery and runtime adoption require separate verification; changing source does not update this active Pi process.

**Rules** (core environment rules in both modes; the rest advanced-only) ([REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode),
[REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session)):
core environment rules (`cloudflare-environment`, `no-local-builds`,
`git-workflow`) ship in both modes. Claude keeps the baseline `git-workflow` rule.
Pi gets its own native `preseed/agents/pi/rules/git-workflow.md` from the Pi manifest,
which delegates branched mechanics to `ci-monitoring`, `git-review-pipeline`,
`pr-workflow`, and `deploy-credentials`.

Pi and Claude use marker-aware review ingress under [AD144](../decisions/README.md#ad144-user-scoped-review-completion-uses-marker-or-dialog-ingress). Startup, resume, clone, switch, branch checkout, PR checkout, pull, checked-out-branch push, checked-out-branch PR creation, and checked-out-branch PR reopen resolve the active checkout's exact open protected-base PR. A valid marker is silent. In the local/default path, successful checked-out-branch push, PR creation, and PR reopen automatically emit one review-and-CI plan. Other misses offer `Mark review complete` and `Launch review`; neither runtime chooses for the user.

In Enterprise Pi sessions only, [REQ-OPERATOR-053](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff) adds authenticated protected-Action applicability at that PR boundary. Confirmed applicability currently emits a remote-only monitoring/CI plan without local reviewers or a local completion marker; confirmed absence keeps the local procedure. Unavailable applicability stays non-green without fallback. Manual completion checks applicability without staging a Review activity. Action claim, independently published results, remote completion and FIX correlation remain pending; selection is not review clearance. Local `/review`, Claude, and non-Enterprise behavior retain their separate local paths.

Each Pi automatic attempt completes its own authoritative refresh; pending lookups do not suppress another attempt. After refresh, only an established exact-identity round suppresses duplicates, and obsolete session generations are discarded.

Claude pre-triage and Pi lane suppression call the unchanged canonical round-limit executable. Both lanes count only leading supported agent tags, never embedded tag mentions; unavailable or failed gates preserve review. Only direct current-session root user authority releases the round-limit gate, not config, transcript/tool data or quoted mentions. Pi accepts native interactive/RPC instructions and revokes authority on cancellation/session replacement; reload requires renewed authority. Count and decision remain reviewer evidence, and all other gates remain binding.

A selected local launch starts one fresh current round. The newest retained same-PR ancestor selects an incremental range when it remains an ancestor; otherwise the plan uses the full protected-base diff. Required reviewers start together with deterministic output paths. Push or PR-create context may add exact-head CI immediately afterward through the existing resolver:

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> pr=<affected-pr-number> head=<boundary-plan-head> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

No stdout means no action. Otherwise the root submits the returned request unchanged once. After the final launch, root ends the turn without polling or retrieving in-flight work. Native terminal notifications drive later turns.

Joint triage waits for every required reviewer and terminal exact-head CI evidence. Failure and timeout require the exact `Exact-head CI` row and matching `CI_RESULT` token. For every finding, root verifies evidence and scope, judges the finding separately from its proposed fix, rejects unsupported or overengineered proposals, and prefers the smallest correction reusing existing machinery. Root makes no mutation in triage. See [REQ-AGENT-170](../../sdd/spec/agents.md#req-agent-170-joint-review-and-ci-triage).

If Pi sees a table after failed or timed-out CI but its required CI row is malformed, it emits one correction follow-up instead of silently withholding FIX; the corrected canonical table continues the same round. If a structurally valid table arrives before the final reviewer or CI result, Pi emits the same one-shot correction type after all required evidence becomes terminal and withholds FIX until a later canonical table is republished. This behavior is implemented by [`reviewTranscriptFacts`](../../preseed/agents/pi/extensions/review-helpers.ts#L685) and [`sendEarlyTriageCorrectionFollowUp`](../../preseed/agents/pi/extensions/review-enforcement.ts#L472), and specified by [REQ-AGENT-214](../../sdd/spec/agents.md#req-agent-214-premature-review-triage-correction). Agent-end or Stop handling then revalidates identity, writes the user-scoped completion marker, and emits the separate FIX follow-up. Head drift or marker-write failure keeps both closed.

Pi holds one active round in memory. Claude inspects only transcript bytes after its current SessionStart offset. Stopped or interrupted work stores no progress, no retry plan, no counter, and no missing-work demand. A later exposure asks again and replans. Non-SDD and default-mode sessions receive no automatic review or CI plan; explicit CI and deploy/merge gates remain independent. Managed Git workflow rules do not block deployment solely because required CI is pending, missing, or failed; dedicated deployment workflows may retain their own CI sequencing ([REQ-AGENT-208](../../sdd/spec/agents.md#req-agent-208-managed-git-workflow-deployment-policy)).

Generated reviewer system prompts embed their canonical scope and enforcement skills, so reviewers build the lane packet without retrieving policy first. All three use Pi's provider-neutral `medium` thinking level rather than inheriting the root session's level. The foreground-only context-mode extension is intentionally unavailable inside in-process reviewers. Each reviewer invokes the packet CLI through repository-rooted Bash/Node and consumes its JSON in the same processing call; packets are never persisted or handed between calls. Standalone read, grep, Graphify, and indexed batch/global retrieval are unavailable to the lanes. The root waits for every report and alone changes the head.

Cross-lane packet inputs carry exact old/new hunk ranges. Reviewers resolve an anchored implementation symbol or named test block and follow it only when that range intersects a changed hunk; sharing a changed file is not direct invalidation. Reviewers consolidate deterministic checks, emit failures rather than successful manifests, and verify generated seed through canonical preseed plus one identity check. The direct Bash/Node packet path preserves the declared scope, evidence, and dispositions.

Claude CI monitoring remains bounded to eligible PR-boundary plans, explicit user requests, and fresh deploy/merge gates ([REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy)). Routine non-boundary pushes do not start it; at a PR boundary, CI launches independently after reviewers, while its terminal result joins reviewer evidence before triage acknowledgement. The root launches one attached background `ci-monitor` Agent with the boundary's canonical repository, PR, head, and working directory. The monitor queries by commit SHA, so branch text never enters its shell command. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::CI_PROMPT -->

Its bounded script requires a non-empty workflow/run fingerprint to stay stable across two polls before success and returns one terminal `CI_RESULT success`, `failure`, or `timeout` through native Agent completion. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::CI_PROMPT --> <!-- @impl: preseed/agents/claude/agents/ci-monitor.md::ci-monitoring/scripts/monitor-ci.mjs -->

Every terminal result carries exact repository, PR and head identity. Claude completion requires an assistant `Agent` call for `ci-monitor`, `run_in_background=true`, the exact structured resolver JSON including cwd, a successful correlated launch receipt, and a subsequent native terminal envelope for that tool-use ID with `CI_RESULT` and matching identity. Quoted JSON/identity strings, arbitrary tool data, assistant result prose, failed receipts and unrelated notifications cannot satisfy acknowledgement. Pi retains its structured launch/terminal correlation.

The monitor neither cancels workflow runs nor consults the remote about its own relevance. It filters observed runs by the bound head. Superseded runs are cancelled by workflows, which each declare their own `concurrency` policy; workflows omitting `cancel-in-progress`, including `deploy.yml`, do so because a half-finished run is worse than a redundant one ([AD122](../decisions/README.md#ad122-the-ci-monitor-observes-and-reports-it-does-not-cancel-runs-or-chase-the-remote)).

Monitoring and any other long-running wait/poll are background-only: no agent may
keep the main session busy with `tail -f`, `gh run watch`, blocking `ctx_execute`,
Bash loops, deploy-status waits, or foreground polling
([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring)). The discipline triad (`spec-discipline`, `documentation-discipline`,
`tdd-discipline`) is advanced-only. Claude receives those rules in ambient instructions; Pi receives the same canonical policy through its grouped native skills, without duplicate ambient rule copies.

`memory` is advanced-only and routes explicit memory requests to the merged global graph
and Vault work to its owning skills. Automated capture and extraction remain runtime-owned;
the ambient rule does not dispatch, wait for, poll, or require a graph query before unrelated
work. `vault-note-capture` is a short advanced-only route for durable note requests.

`graphify-routing` reaches advanced sessions. It sends broad architecture,
dependency, ownership, call-flow, and where-implemented searches to an existing graph,
while known-file edits, Git/CI state, and current-task changes skip the graph. Current source
outranks stale graph evidence; builds and refreshes require explicit authorization and the
advanced `graphify` skill
([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify),
[REQ-AGENT-024](../../sdd/spec/agents.md#req-agent-024-advanced-session-mode-graph-first-discipline)).
`frontend-components` is advanced-only and owns detailed composable UI decisions.
Repetition prompts review rather than automatic extraction; ownership, coupling, state,
reuse, testability, and maintenance decide whether structure moves. Stable one-offs may
remain local, and the selected design owner retains visual direction.

`engineering-constitution` reaches default and advanced sessions. Its five short sections
cover repository-led engineering, behavioral proof, composition, SDD traceability,
prompt-injection resistance, secret and tenant boundaries, direct current-session user
authority, latest-stable dependency selection, and current-task continuity
([REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents),
[REQ-AGENT-198](../../sdd/spec/agents.md#req-agent-198-engineering-constitution-security-policy),
[REQ-AGENT-199](../../sdd/spec/agents.md#req-agent-199-engineering-constitution-dependency-policy),
[REQ-AGENT-200](../../sdd/spec/agents.md#req-agent-200-engineering-constitution-work-continuity)).
It acknowledges and retains new input, then finishes and verifies the active task before acting
on unrelated input unless the user stops, pauses, or reprioritizes it. The current user controls
scope, sequencing, implementation choices, and internal Codeflare workflows and processes.
Their latest clear instruction overrides conflicting defaults; `override` for a named action
executes immediately without confirmation or process delay. Security, privacy, authorization,
tenant, least-privilege, secret, system, and platform boundaries remain binding.

Default+advanced `git-workflow` owns PR-boundary mechanics, and focused skills own
platform behavior. Generic coding and language recipes remain absent under
[REQ-AGENT-196](../../sdd/spec/agents.md#req-agent-196-repository-led-technology-guidance).

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

Ordinary curated content does not reverse-sync into public preseed. A task for managed content changes the private repository; a task explicitly limited to image fallback changes this repository only. When the operator explicitly requests alignment to a Codeflare checkpoint, that exact checkpoint defines the complete eligible canonical Claude/Pi source and mode metadata for the operation, including native Impeccable and eligible historical retirements. Do not preserve stale shared content under the label of independent ownership. Compiler-forbidden context-mode and Pi npm paths remain image-owned exclusions.

### Image-owned managed-extension companions

Image-owned companion exceptions are explicit. Their declaration names each exact extension file, and startup restores only those companions. ([REQ-STOR-031 AC7](../../sdd/spec/storage.md#req-stor-031-managed-resource-container-sync)) <!-- @impl: entrypoint.sh::IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->

An image-owned exception requires every step below:

1. Ship the companion in Codeflare's warm image before curated code imports it.
2. Declare its exact filename in `IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS`. <!-- @impl: entrypoint.sh::IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS -->
3. Relay only that file after R2 restore and before PTY release and bisync baseline. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->
4. Test companion restoration and preservation of release-owned bytes.
5. Verify consuming-image availability before publishing the dependent release; advance the compiler pin only when a compiler-sync input changes.

Never replace this declaration with a generic “copy every missing extension” fallback. Exclusive cleanup must not expand image ownership implicitly.

**Agents working on Codeflare:** when a task asks for a new or changed managed skill, rule, hook, agent, script, plugin, or required Browser IDE extension, work in curation and follow its [contribution instructions](https://github.com/nikolanovoselec/codeflare-curation/blob/main/CONTRIBUTING.md) for reviewed `main` changes and protected publication:

```bash
git clone https://github.com/nikolanovoselec/codeflare-curation.git
```

Editing `preseed/agents/**` here instead is a silent no-op for deployments with Managed Environment curation active, because those deployments read the signed release rather than the image baseline. Only two cases justify editing this repository: a task explicitly scoped to the image fallback, or a change to the shared compiler, transform, seed ABI, or Pi runtime lock, which are Codeflare-owned and land here first.

Behavior required in both timelines receives explicit source edits; no automatic public-to-private content synchronization job is used. For full alignment, follow curation's [checkpoint alignment procedure](https://github.com/nikolanovoselec/codeflare-curation/blob/main/docs/operator-runbook.md#align-with-a-codeflare-checkpoint), record the complete eligible manifest/byte/mode/retirement comparison and image exclusions, and verify CI plus the immutable release's source SHA, tag, and fixed assets. Existing provenance handles removal of previously seeded files; do not append obsolete Impeccable JavaScript to the historical by-name backlog. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->

The shared compiler and runtime ABI remain Codeflare-owned. Compiler-pin automation compares three compiler scripts and three managed npm lockfiles from an exact successful `main` or `develop` deployment. It advances only when one of those six inputs differs, then curation CI validates that exact checkout ([REQ-AGENT-148 AC5](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication)). A newer source checkpoint or native-only image change does not by itself move the pin. Never copy dirty or untracked compiler files into the private repository.

After a relevant private content change reaches `main`, the protected release workflow derives the next sequence from verified immutable history and publishes fixed signed assets. Codeflare discovers releases through its normal five-minute dashboard refresh. No image rebuild, webhook, or container clone participates. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

### Managed release evidence inspection

This is a read-only method for [REQ-AGENT-148](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication), not permission to publish or a receipt of protected acceptance. Follow curation's existing [Publish a release](https://github.com/nikolanovoselec/codeflare-curation/blob/main/docs/operator-runbook.md#publish-a-release) and compiler-automation runbook. Inspect an already-completed **Publish managed seed** run at its exact curation SHA, that SHA's `.github/workflows/release.yml`, and the associated existing **Sync Codeflare compiler** evidence. Prerequisites are owner-authorized read access to the protected run/environment identity and non-secret release/comparison records, including the unchanged-input case. Do not obtain signing secrets, dispatch workflows, create a negative release, alter a draft, or retrieve new protected evidence merely to define this method. Missing access or retained records blocks acceptance, not definition of this procedure.

| Scope | Concrete inspection | Pass/fail |
|---|---|---|
| AC2: protected signing | In `release.yml`’s `managed-seed-production` job, follow **Validate identity and sign with the environment key**. Before `sign`, check Ed25519 type and private-key-derived raw public bytes against `MANAGED_SEED_PUBLIC_KEY_HEX`; correlate job/active-public-key identity with its protected green run. Never display or retrieve the private key. | Unequal keys must throw before signing; the accepted run must execute this guard against the configured active key. Missing environment/key-identity correlation or a skipped signing job is unverified, not a pass. Source inspection is not an observed mismatched-key trial. |
| AC3: draft and asset binding | Follow **Create draft and attach both fixed assets by release id**, **Download and revalidate exact draft bytes**, then **Recheck exact draft IDs and publish by release ID**. Correlate run SHA, tag, release/asset IDs, names and digests. Inspect byte comparisons, signature verification and final draft GET/equality before publish PATCH. | Exact draft identity and `seed-v1.json.gz` plus raw 64-byte `seed-v1.sig` must pass the immediate pre-publication digest recheck. Unrelated green runs/current metadata are insufficient. Final PATCH checks immutable status and release ID, not another complete post-publication digest recheck. |
| AC4: immutable sequence | Trace **Derive the next sequence from immutable history** and **Refuse a sequence whose tag already exists** into the signed bundle/tag of the same completed publication. Compare the existing verified-history maximum and derived next sequence with `seed-v<sequence>`, embedded source identity, and resulting nondraft immutable release ID. | A new publication uses the history-derived next sequence and the same release ID, and its publication result asserts `immutable: true`. The already-published-source reuse branch is a no-publication outcome, not fresh signing evidence. Missing history inputs leaves sequence derivation unverified. |
| AC5: deployment and six-input comparison | In `sync-compiler.yml`, follow **Resolve eligible Codeflare candidate** against `config/compiler.json` and `scripts/compiler-config.mjs`. Tie the exact candidate SHA to successful `main`/`develop` deployment. Compare base/candidate blob IDs for the six inputs below. Inspect existing all-equal `changed=false`/skip with no pin advance and changed-input pin advancement through exact-head Managed seed CI. | Advancement requires at least one changed input plus that exact successful deployment; newer checkpoints/native-only changes/failed deployment/unbound SHAs are insufficient. `compiler-comparison-evidence` is failure-only, not promised on green runs. Missing retained successful comparison evidence blocks that observation. |

The six compared inputs are:

- `scripts/agent-seed-core.mjs`
- `scripts/agent-seed-release.mjs`
- `scripts/agent-seed-release-limits.mjs`
- `preseed/npm-tools/package-lock.json`
- `preseed/agents/claude/browser-run-mcp/package-lock.json`
- `preseed/agents/pi/package-lock.json`

Record only non-secret run/source identities, observed outcomes and missing prerequisites in existing release records. This method neither establishes runtime activation nor replaces deterministic-byte tests or protected-environment acceptance. The private signing key remains outside Codeflare and user storage; rollback remains a higher immutable sequence under the existing environment approval policy.

### Spotlight: how `runtimeDependencyHash` binds a release to its image

A managed release may replace agent code without rebuilding the container. That freedom needs a hard compatibility check. A valid signature proves who published the bytes; it does not prove that the image has the npm packages the managed content expects. `runtimeDependencyHash` closes that gap. See [REQ-AGENT-147 AC3 and AC7](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases) and [REQ-AGENT-150 AC4](../../sdd/spec/agents.md#req-agent-150-independent-managed-release-activation-validation).

1. [`codeflare-curation/config/compiler.json`](https://github.com/nikolanovoselec/codeflare-curation/blob/main/config/compiler.json) pins one exact Codeflare commit, which owns the compiler and managed npm runtime contract.
2. The [release workflow](https://github.com/nikolanovoselec/codeflare-curation/blob/main/.github/workflows/release.yml) checks out that commit, and the [compiler wrapper](https://github.com/nikolanovoselec/codeflare-curation/blob/main/scripts/lib/compiler.mjs) copies its shared npm-tools, Claude Browser Run MCP, and Pi lockfiles into the staged source.
3. The shared compiler hashes every byte of each lockfile, then hashes the three fixed-order digests into one runtime identity. <!-- @impl: scripts/agent-seed-core.mjs::computeAgentRuntimeHash -->
4. Release construction writes that identity to `runtimeDependencyHash` inside `seed-v1.json.gz`. <!-- @impl: scripts/agent-seed-release.mjs::buildAgentSeedRelease -->
5. Publication signs the exact deterministic compressed bundle and publishes it with its raw 64-byte Ed25519 signature. <!-- @impl: scripts/agent-seed-release.mjs::signReleaseBundle -->
6. The Codeflare Worker build contains `PRESEED_RUNTIME_DEPENDENCY_HASH`, generated from the same three lockfiles used to build its image. <!-- @impl: scripts/agent-seed-core.mjs::toGeneratedModuleSource -->
7. On its periodic release check, the Worker verifies immutable metadata, asset digests, signature, schema, sequence, and runtime hash before activation. <!-- @impl: src/lib/remote-curation.ts::verifyManagedReleaseStream -->
8. Both foreground Setup validation and background refresh search compatible history on a runtime-hash mismatch, scanning at most ten 100-record pages (1,000 records) and activating the first verified compatible release. `requireFresh` controls cache freshness and error propagation, not history eligibility. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

In both foreground and background resolution, only a runtime-hash mismatch continues discovery. Any other managed-release validation failure stops it; unrelated published releases are ignored. See [REQ-AGENT-154](../../sdd/spec/agents.md#req-agent-154-build-compatible-managed-release-discovery). <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

The seed never asks running instances to provide a hash. Curation embeds the hash from its pinned Codeflare commit, and the Worker compares it with its generated build constant. Unchanged lockfiles keep the same npm hash, but a release needs no image redeploy only when its other runtime prerequisites are already installed.

The hash excludes native-engine revisions. Historical compiler pin `52a2329fbe5a356a1905cf881c227da4102c0b04` packages an older Impeccable engine than source checkpoint `9c1717e8b06b8c6b636fc7929812511a823211a2`; all six compiler-sync inputs match and both npm hashes are `823886357f3fc167d2b3df332901d2e68bd7d1a8a7f577e4e7cc999c375cbce9`. The aligned launcher requires its exact image-owned binary in the consuming image and fails explicitly if it is missing. Hash-based discovery cannot distinguish these engines or choose an older seed for that reason. Native availability therefore needs separate deployed-image evidence, not a compiler-pin change, broader hash claim, or stale managed source.

<a id="preseed-deployment"></a>
## Runtime Delivery Pipeline

All preseed content is deployed via the manifest pipeline:

1. Source files in `preseed/agents/claude/` organized by type:
   `rules/`, `agents/`, `commands/`, `skills/`, `plugins/`
2. `preseed/agents/claude/manifest.json` maps each file to modes
   (`default`, `advanced`, or both)
3. The seed compiler reads manifested files, applies every agent transform, and
   writes the generated runtime module.
4. On first bucket creation, `reconcileAgentConfigs()` writes files for the resolved mode and deployment-selected coding agents to R2.
5. **Recreate skills & rules** runs a full selected-target reconcile and removes exact generated paths owned by inactive agents.
6. The Worker's ancillary status route constructs upgrade identity and compares stored state; the frontend consumes that projection. Active managed releases compare digest, sequence, resolved mode, agent projection and resource policy (including required applied digests/pending targets). Only inactive curation compares baked content hash/projection. An owning session blocks upgrade; discovery errors fail closed without an upgrade offer.
7. Bisync pulls from R2 to container config directories
   (`~/.claude/`, `~/.codex/`, `~/.gemini/` (Antigravity), `~/.copilot/`,
   `~/.config/opencode/`, `~/.pi/agent/`)

The side-effect-free `scripts/agent-seed-core.mjs` ignores non-manifest content
and applies the transforms. The image-build CLI wrapper writes
`src/lib/agent-seed.generated.ts` with `AGENTS_SEEDED_CONFIGS` and a deterministic
16-character `PRESEED_CONTENT_HASH`. The shared core also exposes the combined
managed npm lock identity that binds managed releases to the runtime dependency
ABI. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @test: host/__tests__/agent-seed-core.test.js (shared agent seed compiler) -->

Managed curation and the baked fallback select one web, mobile, desktop, static, or incumbent authority and keep motion, components, performance, and available finishing tools subordinate. The pinned compiler projects agent-neutral content to supported runtimes; Pi receives one compact routing rule, Copilot receives usable fallback boundaries without projected skill directories, and Canvas retains required Apache-2.0 attribution. The inventory includes `design`, `frontend-design`, `native-mobile-design`, `desktop-native-design`, `canvas-design`, and `motion-design`, and excludes UI UX Pro Max and `emil-design-eng`. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->

Release status selects an exact signed target, mode, policy, and deployment agent projection. The dashboard uses the dedicated upgrade path for ordinary deltas and Recreate for full repair. Durable admission, progress, Retry/Recreate coordination, verification, and success-only applied-state publication belong to [Storage & Sync](storage-and-sync.md#reconciliation-status-and-user-recovery). Delivery does not mark state current from POST success.

**Manifest structure** (Claude configs plus Pi-native assets; exact counts live in the manifests, not here):
- `rules/`: compact universal, routing, and path-scoped platform documents.
- `agents/`: advanced-only specialist agent definitions.
- `commands/`: advanced-only slash command definitions.
- `skills/`: default skills, advanced skills, design skills, and enforcement skill families.
- `plugins/`: marketplace, memory, vault, hooks, context-mode, and graphify plugin payloads.
- Pi-native runtime assets include package config and package lock.

The `rules/` tree includes cloudflare-environment, engineering-constitution,
no-local-builds, and git-workflow in both modes. The local-execution rule stays deliberately
short: it requires agents to lazy-load `safe-local-checks` before any permitted local lint
or syntax check. Advanced mode adds Graphify, design, and memory routing,
specification, documentation, and test enforcement routes, frontend-component guidance,
Vault note capture, and path-scoped Cloudflare Workers routing. Generic language rules
remain absent.

The default+advanced `safe-local-checks` skill supplies the operational policy and one
managed wrapper for every repository. The image supplies Oxlint, Biome, Prettier
and both parser dependencies; repository versions take precedence over the fixed image
copies, without downloads or arbitrary `PATH` lookup. ESLint remains a repository-only
mode: it requires an existing local installation and never substitutes another analyzer.

Full-project read-only checks have no file-count limit and run at low priority for
at most three minutes. Node syntax checks and explicitly named Node test files use
the same deadline. This tuned wrapper is the only permitted local-test route;
deployment resource allocation never changes its permissions or bounds. Builds and
ordinary test runners remain CI-only. TypeScript and YAML parsing retain repository-first resolution
and use available approved image copies when project dependencies are absent. This parser
selection follows [REQ-AGENT-192](../../sdd/spec/agents.md#req-agent-192-image-baked-typescript-syntax-parser). <!-- @impl: preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs::syntaxParserRequire -->

Under [REQ-AGENT-157 AC5–AC6](../../sdd/spec/agents.md#req-agent-157-managed-local-check-delivery-policy),
canonical guidance projects to both runtime skill paths. <!-- @impl: scripts/agent-seed-core.mjs::adaptSkillContent -->
Pi preserves the skill's original invocation eligibility in generated policy for metadata-backed discovery and native reads while
suppressing duplicate native catalog injection. <!-- @impl: scripts/agent-seed-core.mjs::finalizePiSkillDiscovery -->

Mutation, watch, output-file, cache-writing, and analyzer-concurrency flags fail
closed. Shell composition beyond one optional leading `cd … &&` prefix, or any
redirection, cannot turn an allowed wrapper invocation into a write. Builds, package
test scripts, broad integration suites, type checks, Knip and other dependency-graph
analysis, installs, servers, and authoritative verification remain CI-only. Both Pi and Claude guards allow only the
exact wrapper path. Outer guards contain analyzer argv using actual tool cwd and canonical Git root before allowing that exception; absolute/parent/symlink/config escapes and unresolved dynamic paths fail closed. Pi applies this before graph-query exemptions. The tuned wrapper remains unchanged, and direct blocked commands point agents to the skill; the
user-only one-shot bypass remains unchanged. Its exact sentinel is `/tmp/local-build-bypass`: only the user may create it, successful consumption deletes it before allowing one guarded command, failed consumption keeps blocking, and the block message names that same path. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/block-local-builds.sh::PATTERNS --> <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::isManagedSafeLocalCheckCommand -->

The `agents/` tree is advanced-only: architect, build-error-resolver,
code-reviewer, deep-reviewer, doc-updater, memory-capture, refactor-cleaner,
security-reviewer, spec-reviewer, tdd-guide, and vault-extract.

The `commands/` tree is advanced-only: brainstorm, debug, deploy, review, and sdd.

The `skills/` tree includes cloudflare-stack, ship (+ refs), ci-monitoring,
pr-workflow, deploy-credentials, and safe-local-checks as default+advanced skills. Advanced skills
include consult-llm, humanize (+ measurement reference), focused Cloudflare and design specialists,
spec-driven-development (+ reference templates for /sdd init scaffolding), sdd-init, sdd-clean,
vault-operations, vault-note-capture, spec-enforce, spec-enforce-ac, spec-enforce-truth,
doc-enforce, doc-enforce-lanes, doc-enforce-shape, doc-enforce-truth, tdd-enforce,
git-review-pipeline, graphify, and browser-run + browser-e2e. Pi owns native reviewer and
spec/doc enforcement overrides; Claude retains its original agents and enforcement skills.
Generic advice packs and generated language groupings remain absent under
[REQ-AGENT-196](../../sdd/spec/agents.md#req-agent-196-repository-led-technology-guidance).

`humanize` is advanced-only and projects from one authorized first-party Claude source to every runtime with a skill directory: Claude Code, Codex, Antigravity, OpenCode, and Pi. Its evidence reference ships with the workflow; `ORIGIN.md` stays repository-only. Runtime use needs no detector, script, network service, or score. Editorial quality and the no-fabrication boundary remain manual review concerns ([REQ-AGENT-195](../../sdd/spec/agents.md#req-agent-195-portable-humanize-writing-guidance)).

Managed curation and the baked fallback use `design` as the lazy router and `frontend-design` as the web art-direction authority, with separate mobile, desktop, and static owners. They keep `motion-design` subordinate and narrow available Impeccable use to explicit commands, audit, and finishing work without runtime package self-update. ([REQ-AGENT-134](../../sdd/spec/agents.md#req-agent-134-managed-design-skill-suite), [REQ-AGENT-179](../../sdd/spec/agents.md#req-agent-179-portable-visual-design-routing), [REQ-AGENT-180](../../sdd/spec/agents.md#req-agent-180-portable-frontend-design-authority), [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility))

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
graphify-mcp-lazy.py in default+advanced mode; advanced mode adds the compact
query-routing rule, graphify-active-repo.sh, graphify-clone-prompt.sh,
graph-first-nudge.sh, safe-graphify-update.sh, local-graphify-labels.sh, and the
build/update skill.

The Claude wrapper resolves global → valid sentinel → freshest
workspace at each context request, returning empty for a graphless selection. It
delegates real files to upstream's bounded complete-context cache, preserving
parallel relations, communities and fresh indexes without a dictionary-swapping
watcher ([AD158](../decisions/README.md#ad158-select-complete-upstream-graphify-contexts-per-request)). Upstream nominal query-header/resource paths are not rebound by this narrow seam; host MCP evidence does not prove image or hosted acceptance.

Graphify tools ship as the native extension `extensions/graphify-native.ts` rather
than through the MCP adapter — a Pi-native first-class choice. Pi still consumes
MCP servers through `pi-mcp-adapter`: it explicitly connects `consult-llm` and
`chrome-devtools`, then searches/describes or activates discovered deferred tools; config is `~/.pi/agent/mcp-adapter.json` in
`entrypoint.sh`. A default or token-less start removes restored Codeflare-owned
Browser Run registrations from Claude and Pi while preserving unrelated user MCP
servers, so an old bearer-bearing configuration cannot survive a mode or credential
change.

Extension files deploy Pi-specific runtime behavior. `codeflare-commands.ts`
provides `/debug`, `/deploy`, and `/brainstorm`; `review-enforcement.ts` and
`review-helpers.ts` implement session-scoped PR-boundary review reminders and
transcript correlation; `startup-header.ts` delegates the installed Open TUI through
terminal-only and width-safe public API boundaries; and `local-statusline.ts`
publishes repository/branch only without replacing the native footer or duplicating native context/model/effort. Entrypoint enforces the [approved Open TUI preferences](../references/pi-packages.md#native-terminal-ui) on every startup after home restore; the adapter only validates configuration before activation.
Both UI sources remain in default and advanced modes. Compatible image/compiler,
signed curation publication and runtime activation are verified separately.

`browser-run.ts` plus pure `browser-run-helpers.ts` (advanced only) register native
`browser_markdown`, `browser_content`, and `browser_scrape` tools that call the
Cloudflare Browser Run REST Quick Actions `/markdown`, `/content` and `/scrape`, respectively. Markdown is the Readability-clean HTML-to-Markdown one-shot surface, not an accessibility snapshot or raw DOM; Claude's sibling MCP server supplies the same read capability for the landing's “open web, distilled to Markdown” scenario. That cheap one-shot READ surface is
self-gated on `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Browser Run has two surfaces and both agents have both. The READ surface above is
Pi-native; Claude Code gets a sibling `browser-run` MCP server built from
`preseed/agents/claude/browser-run-mcp/` and registered in `~/.claude.json`. The
INTERACTIVE `chrome-devtools` surface supports navigate / click / screenshot /
viewport; Claude receives it as a registered MCP server, while Pi reaches it through
`pi-mcp-adapter`. The `browser-run` skill for both agents frames the
cost/context decision: cheap markdown read first, interactive browser only when a
page must be driven.

`browser-e2e` for both agents drives the interactive surface to verify a deployed
app by judgment, including from a mobile viewport. Every file under
`preseed/agents/pi/extensions/` is loaded by the Pi extension scanner and must
export a default factory function. Pure helper modules such as
`browser-run-helpers.ts` and `graphify-helpers.ts` therefore export a no-op default
factory alongside their named exports, or Pi aborts startup with
`Extension does not export a valid factory function`.

### Browser observation acceptance

These are methods, not execution receipts. Require separately authorized existing sessions/startup records at the candidate image/seed revision, configured Browser Rendering access and an approved public deployed own-app target with non-destructive criteria. Missing prerequisites block acceptance. Do not deploy, install, change modes/credentials or manufacture restored configurations. Record revision, runtime, mode, credential-presence/preservation booleans and sanitized outcomes; never retain headers, tokens, cookies, email/OTP/challenge details, environment dumps, credential-bearing arguments or authentication screenshots. Website login requires separate current-user authorization under the delivered skill. Preserve managed placeholders; real Enterprise credentials remain Worker-held. Browser service access grants no arbitrary website interaction authority.

#### Claude Browser Run observation

For [REQ-BROWSER-001](../../sdd/spec/browser-run.md#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), privately compare existing Claude registrations/startup records for advanced complete-pair, Standard and missing-token/account cases. Both owned servers must appear only in the permitted case; restored removal must preserve unrelated servers. Compare configured-account CDP endpoint and credential-source/equality booleans without exposing credentials. Confirm `/opt/codeflare/bin/chrome-devtools-mcp` and startup evidence of no browser-package resolution/download; a configured binary path alone is insufficient. Configuration fixtures establish timeout parameters, not provider expiry or authenticated runtime operation.

Compare the delivered advanced skill and manifest membership with the [canonical decision order](../../preseed/agents/claude/skills/browser-run/SKILL.md#decision-order-cheapest-that-does-the-job): bot protection, login walls, redirect chains and JS-only failures must remain covered. Discover live definitions and perform an approved public `browser_markdown` read, using its documented rendered-content option where needed. Reuse existing `browser-run-core.test.ts` private/credential-bearing initial-target rejection inputs without real credentials; retain only rejection categories. This checks initial targets, not redirect/DNS safety. Follow the skill's interactive discovery/recovery and the semantic procedure below. PASS requires all applicable startup, rendered-read, rejection and authenticated CDP observations; REST success cannot substitute for CDP authentication or website-network coverage.

#### Browser semantic observation

For [REQ-BROWSER-004](../../sdd/spec/browser-run.md#req-browser-004-agent-semantic-e2e-via-browser-run), inspect both advanced manifests and delivered `browser-run`/`browser-e2e` skills. AC4 delivery follows the Claude source-document branch and the Pi native-manifest branch, not agent-frontmatter adaptation. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> Require: own/authorized public deployments only, no localhost/private targets, deterministic invariants remain in CI. Discover both read and interactive surfaces: Claude read MCP differs from Pi native `browser_*`. Follow [Pi discovery](../../preseed/agents/pi/skills/browser-run/SKILL.md#interactive-discovery-and-recovery): activate `mcp`, inspect status, explicitly connect `chrome-devtools`, then search/describe live tools or activate exact discovered deferred names. Never guess names or arguments.

Execute the existing How-to-use sequences for [Claude](../../preseed/agents/claude/skills/browser-e2e/SKILL.md#how-to-use) and [Pi](../../preseed/agents/pi/skills/browser-e2e/SKILL.md#how-to-use-interactive-direct-tools). On each runtime, navigate the approved target, use live-schema mobile viewport controls, take bounded snapshots/DOM measurements and screenshots, perform only approved click/fill actions and reobserve each step. Also exercise each cheap rendered-read surface. Report evidence-backed pass/fail for every supplied application criterion, not selector existence or “looks fine.” One runtime cannot qualify the other. Missing authority, surface, target or evidence is BLOCKED; contradictory behavior is FAIL. Semantic browser acceptance does not establish deterministic CI, lifecycle retention or full website-network enforcement.

#### Pi interactive browser acceptance

Reuse the authorized sessions, candidate revision and target from Browser observation acceptance. Compare advanced complete-pair, Standard and missing-credential registrations without exposing secrets; confirm removal preserves unrelated servers. Follow Pi's delivered connect/discover flow and the browser semantic procedure for permitted interaction. For BROWSER-006 AC7, use the cold-discovery method below rather than infer acquisition from an MCP process or cached catalogue.

#### Cold-discovery acquisition observation

Use the installed Pi SDK and native MCP adapter in an in-memory session with an isolated temporary agent directory and no metadata cache. Supply only the existing configured Chrome server, unchanged, through the adapter's programmatic configuration. Disable model calls and unrelated extensions; leave the live agent's files and sessions untouched. Browser credentials stay in memory and must not appear in output.

1. Read the configured account's existing Browser Rendering session endpoint before startup; retain only session identities/times privately. Require complete pagination and successful authorization.
2. Start the isolated adapter, call MCP status, then search and describe a real Chrome tool. Do not connect explicitly or invoke any browser tool.
3. After each phase, repeat provider readback. Require no newly acquired session while status/discovery succeeds; record cold-cache state, installed versions and observations. Account for concurrent writers instead of attributing their sessions to this test.
4. Shut down only the isolated adapter and remove its temporary files. Never close an unrelated provider session or copy credentials into a fixture.

This observes a bounded installed-runtime execution, not every future adapter version. The provider session endpoint is an observation surface; listing MCP tools alone is not.

#### Browser read registration observation

Reuse [Browser observation acceptance](#browser-observation-acceptance), including its privacy, authorization and existing-state prerequisites. For BROWSER-003 AC2 and BROWSER-007 AC6, inspect delivered Pi extension/skill inventories and native tool discovery in existing advanced complete-pair, Standard, missing-token and missing-account sessions. Compare the advanced-only manifest entries and delivered extension bytes with the candidate seed. Discover native `browser_markdown`, `browser_content` and `browser_scrape` independently of MCP; interactive availability cannot substitute. Denied states must expose none of these native tools. Compare Standard/token-less delivered artifacts and unrelated registrations byte-for-byte with their existing baseline; record equality booleans only. Missing comparable sessions/baselines block execution, not method definition.

For BROWSER-003 AC6, native Pi skill materialization is owned by the Pi manifest loop, which reads native skill bytes and emits each entry with its declared modes; generic adapted-skill delivery is a separate branch that skips native Pi duplicates. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> `adaptAgentFrontmatter` transforms agent definitions, not native skill delivery. Compare the delivered advanced skill with the [Pi decision order](../../preseed/agents/pi/skills/browser-run/SKILL.md#decision-order-cheapest-that-does-the-job): search, optional context/static fetch, raw HTTP, cheap rendered read, then interaction. Public read-only JS/bot-blocked tasks must select the cheap native surface before interactive browsing. Discover its live schemas and call the three read tools on the approved public target; use `wait_until: "networkidle0"` when needed and actual bounded selectors for scrape. PASS requires correct seed/gate comparisons, decision guidance and rendered outcomes; contradictory delivery or exposure is FAIL. Absent approved targets, authority or observations remain BLOCKED. These methods do not claim redirect/DNS protection.

For BROWSER-005 AC2/AC4, reuse [Claude Browser Run observation](#claude-browser-run-observation) for existing gate/startup comparisons, and the [Claude decision order](../../preseed/agents/claude/skills/browser-run/SKILL.md#decision-order-cheapest-that-does-the-job). The supplemental registration owner is the top-level advanced/complete-credential Browser Run block, specifically `BROWSER_RUN_MCP_CLAUDE`, not `configure_consult_llm`. <!-- @impl: entrypoint.sh::BROWSER_RUN_MCP_CLAUDE --> Privately verify `browser-run` uses `node /opt/codeflare/browser-run-mcp/index.mjs` and its scoped environment matches the configured token/account source; record only equality/presence booleans. Correlate image identity and existing image-build import-smoke evidence with delivered files; do not install or launch a replacement server. Discover and exercise all three read MCP tools with the approved public target and bounded selectors, following the canonical skill. PASS requires correct image delivery, gated registration, scoped values and cheap-read-before-interaction guidance. Missing evidence is BLOCKED; mismatches are FAIL. REST observations do not qualify CDP authentication.

For BROWSER-007 AC6, additionally reuse Claude's denied-state registration comparison on the same candidate revision and inspect both runtimes' delivered `browser-run`/`browser-e2e` skill inventories. A missing-token state must have neither owned Claude MCP registration, no Pi interactive registration, no native read tools and neither skill. Preserve unrelated server definitions. PASS requires every absence and preservation comparison; unexpected exposure is FAIL. A tool absent only from an initial abbreviated list is not proof: inspect native discovery and configured MCP catalogues separately. This checks seeding/registration, not resource acquisition, and does not resolve BROWSER-006 AC7.

### Inline editor result delivery

`inline-edit.ts` is the managed endpoint for [host-correlated native Pi editor results](../decisions/README.md#ad135-inline-chat-requires-one-host-correlated-result). It removes its result tool at session start, activates only that tool for `/codeflare-inline-edit`, dispatches through Pi's `ExtensionAPI.sendUserMessage`, isolates the current Inline turn suffix, and restores the exact previous tool list at settlement. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode -->

The final initial-tool exposure filter preserves that exclusive result mode instead of replacing it with the normal panel tools. OpenAI Chat Completions and Responses payloads retain only the exact mandatory result function with parallel calls disabled. Panel turns therefore retain unrestricted tools and stored conversation without loading another Pi process. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::constrainInlineOpenAiPayload --> <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::registerInitialToolFilter --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->

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
| `preseed/agents/pi/skills/pr-workflow/SKILL.md` | default, advanced | `~/.pi/agent/skills/pr-workflow/SKILL.md` | PR creation and material rewrite procedure |
| `preseed/agents/claude/skills/pr-workflow/references/pull-request-authoring.md` (reaches Pi through the seed transform) | default, advanced | `~/.pi/agent/skills/pr-workflow/references/pull-request-authoring.md` | Canonical branch-independent PR body shape and history-linking contract |
| `preseed/agents/pi/skills/git-review-pipeline/SKILL.md` | advanced | `~/.pi/agent/skills/git-review-pipeline/SKILL.md` | Session-scoped review procedure |
| `preseed/agents/claude/rules/engineering-constitution.md` (canonical source assembled by compiler) | default, advanced | `~/.pi/agent/AGENTS.md` | Compact universal engineering, security, user-authority, dependency, and continuity policy |
| `preseed/agents/pi/extensions/capability.ts` + `capability-helpers.ts` + `zz-tool-exposure-finalizer.ts` | default, advanced | `~/.pi/agent/extensions/` | Registered-tool search, additive activation, and post-registration bootstrap filtering through Pi's public API |
| `preseed/agents/pi/skills/review-scope/SKILL.md` | advanced | `~/.pi/agent/skills/review-scope/SKILL.md` | Shared `diff`/`all` scope resolver |
| `preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs` (reaches Pi through the seed transform) | advanced | `~/.pi/agent/skills/review-scope/scripts/build-review-packet.mjs` | Ancestry-validated lane file/hunk packet builder |
| `preseed/agents/pi/agents/{code-reviewer,spec-reviewer,doc-updater}.md` | advanced | `~/.pi/agent/agents/` | Native report-only review lanes |
| `preseed/agents/pi/extensions/review-tool-guard.ts` | advanced | `~/.pi/agent/extensions/review-tool-guard.ts` | Reviewer-only direct-execution intent stripping |
| `preseed/agents/pi/skills/{spec-enforce*,doc-enforce*}/SKILL.md` | advanced | `~/.pi/agent/skills/` | Native scoped SDD enforcement |
| `preseed/agents/pi/extensions/active-repo-memory.ts` | default, advanced | `~/.pi/agent/extensions/active-repo-memory.ts` | Shared foreground repository memory without loading advanced commands |
| `preseed/agents/pi/extensions/review-enforcement.ts` | default, advanced | `~/.pi/agent/extensions/review-enforcement.ts` | Ordered boundary launch plan, settled current-round evidence and triage, exact-identity completion |
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

Cleanup keeps independent investigation, test/documentation drafts and verification preparation in background lanes while useful work remains. The root validates each completed handoff against the actual contract, source and checks before applying it or closing findings, without waiting for other lanes. Native completion notifications drive handoffs; enforcement and repository/Git mutations stay root-owned. <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Parallel execution (binding) -->

At invocation, `/review` prefers the Git repository containing the command cwd,
including a linked worktree, then falls back to remembered active-repository state. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::recallActiveRepo -->
An executable resolver validates the root without changing valid path whitespace or
the process cwd, and the command dispatches nothing when neither source resolves. `/sdd clean` rejects invalid
scope flags and sends the resolved work-set contract. The active-repository extension
resolves shell `cd` and tool-level cwd context before boundary eligibility. It is seeded
in both modes, so default-mode CI plans do not depend on the advanced main extension.

For eligible local review exposures, GitHub's authoritative PR head must match the active checkout. An exact completion marker stays silent; otherwise the user marks completion or starts one fresh round. Root launches selected local reviewers together without inherited context, adds plan-required CI immediately, waits for correlated terminal evidence, publishes the fixed triage table in a tool-free response, and ends that turn without mutation.

Enterprise Pi currently emits a remote-only plan for an applicable Action, with no local reviewer wave. It instructs CI monitoring, but does not yet correlate a published Action result or complete remote triage/FIX. Uncertain selection cannot be marked complete. Independent publication and verified-result monitoring remain pending under [REQ-OPERATOR-053](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff).

Each local Pi reviewer contract emits exact `scope=diff`, expected `review_range` or `review_base`, and lane-specific `output_file` assignments on standalone lines; only exact whole-line assignments count toward completion. Claude counts only successfully received background launches through the canonical `run-review-lane.sh` command when they bind the emitted boundary and exact current head, PR, lane, and range or base.

A successfully returned malformed Pi reviewer or CI launch remains uncredited and receives one visible field-specific rejection; corrected evidence may continue the same round ([REQ-AGENT-176](../../sdd/spec/agents.md#req-agent-176-malformed-review-launches-receive-actionable-feedback)). <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchRejectionFollowUp -->

Code, specification, and documentation reviewers use the shared provider-neutral medium profile. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::thinking: medium --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::thinking: medium --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::thinking: medium --> Agent-end enforcement reads current live session state, revalidates the exact identity, writes user-scoped completion, and emits one FIX follow-up. That follow-up orders the push after accepted corrections are complete; it never authorizes merge, deployment, or a no-op commit. The push starts a fresh exact-head boundary. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendFixFollowUp --> Reload never recovers partial work.

This implements [REQ-AGENT-171](../../sdd/spec/agents.md#req-agent-171-user-scoped-review-completion-and-common-consent), [REQ-AGENT-170](../../sdd/spec/agents.md#req-agent-170-joint-review-and-ci-triage), [REQ-AGENT-177](../../sdd/spec/agents.md#req-agent-177-canonical-reviewer-launch-evidence), [REQ-STOR-027](../../sdd/spec/storage.md#req-stor-027-review-completion-marker-sync), and the retained lane, CI, reviewer, Goal, and user-invoked review requirements. [AD144](../decisions/README.md#ad144-user-scoped-review-completion-uses-marker-or-dialog-ingress) retains automatic delivery while replacing clone-local completion, checkpoints, and recovery.

R2 sync still excludes retired durable-review extension paths. It now includes only the bounded `~/.codeflare/review-state/v1/**` marker tree among review state. The managed-extension relay restores current managed code without touching those user-owned completion files.

CI remains a distinct execution path inside a user-selected plan. Root invokes the resolver once after reviewer calls and submits its zero-or-one request unchanged. Review completion requires correlated terminal CI when the plan includes it. Interruption is intentionally not recovered.

Advanced delivery registers `memory-vault.ts`, `memory-inject.ts`, and `post-compaction-recall.ts` with the capture/extraction prompt contracts. [Vault & Memory](vault.md#public-pi-delivery-and-publication) owns the complete public delivery envelope, frozen snapshots, retry/high-water state, transactional publication, and visualization bounds. Its [retrieval contract](vault.md#first-prompt-and-post-compaction-retrieval) owns graph scope, the first-prompt sentinel, child/synthetic exclusion, digest bounds, persisted recall, and fail-silent behavior.

Pi subagents are provided by `@gotgenes/pi-subagents`; the generator adapts
  Claude agent definitions into `.pi/agent/agents/*.md`. The container image
  preinstalls Pi extension npm dependencies into an image-local cache, and
  entrypoint copies that cache into `~/.pi/agent/npm` after R2 restore.

<a id="multi-agent-preseed"></a>
## Agent-Specific Projection

The generator produces adapted config files for all supported agents from Claude Code's preseed as the default source. Pi-specific runtime contracts that must differ, such as `git-workflow` and `ci-monitoring`, remain native Pi manifest entries.

Curation publishes one universal signed seed. The Worker maps each managed path to exactly one of the six agent homes, rejects an unknown current root, then writes only documents owned by active deployment agents. It stores identities such as `v1:claude-code,pi` beside applied and pending state; changing the selection triggers reconciliation without changing the universal release digest. <!-- @impl: scripts/ci/coding-agent-selection-core.mjs::resolveCodingAgents --> <!-- @impl: scripts/ci/coding-agent-selection-core.mjs::managedPathOwner --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->

Inactive-agent cleanup is narrow and blunt on purpose. Current or already-available verified inventories authorize markerless deletion only for exact paths with an inactive owner. Active and unknown historical paths keep provenance rules. The image still contains the universal bake, but startup lays down selected roots, skips Pi relay when Pi is inactive, and does not configure Claude context-mode when Claude Code is inactive. <!-- @impl: src/lib/r2-seed.ts::deleteExactInactiveConfigs --> <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->

Shared operational policy remains canonical under `preseed/agents/claude/`.
`scripts/generate-agent-seed.mjs` keeps monolithic transformed instructions for Codex,
Copilot, OpenCode, and Antigravity. Pi instead receives a compact `AGENTS.md`:
the Cloudflare Workers path-scoped rule becomes one grouped native skill, while rules
already owned by canonical skills are not duplicated.

The compiler assembles the canonical Claude constitution into Pi `AGENTS.md` in both
modes; native Pi overrides remain authoritative where a matching native rule exists. Git workflow owns boundary event mechanics, launch order, triage, and FIX
sequencing instead of duplicating them in the constitution.
Shared operational gate delivery is [REQ-AGENT-006 AC6](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth). Constitution ownership is [REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents),
[REQ-AGENT-198](../../sdd/spec/agents.md#req-agent-198-engineering-constitution-security-policy),
[REQ-AGENT-199](../../sdd/spec/agents.md#req-agent-199-engineering-constitution-dependency-policy), and
[REQ-AGENT-200](../../sdd/spec/agents.md#req-agent-200-engineering-constitution-work-continuity).

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
and review enforcement. All seeded skills are hidden from Pi's native startup catalog.
The generator first captures their original model-invocation eligibility in the per-mode
capability policy: ordinary skills remain discoverable through `capability`, while explicit
command/event/reviewer-owned resources remain explicit-only.

Ordinary bootstrap tools are `read`, `bash`, `edit`, `write`, and `capability`.
Question, Graphify, subagent, and other registered tools activate on demand, additively.
Registered child sessions also retain `ask_parent` and `notify_parent`; owned Goal,
Plan, and Inline Chat exposure rules are separate exceptions. PR-boundary and
memory/Vault owners activate `subagent` before emitting their unchanged public follow-ups.

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

The compact memory rule remains Claude-only because Pi owns equivalent routing and
automated lifecycle behavior in native extensions. It routes explicit memory, Vault, and
note requests without embedding hook internals or requiring pre-task graph queries.

`preseed/agents/claude/rules/git-workflow.md` is excluded for Pi only; Pi gets
`preseed/agents/pi/rules/git-workflow.md` instead. The `consult-llm` skill depends
on the consult-llm MCP tool, so it is excluded from the codex/opencode/antigravity
transform lane. Pi still gets a native `consult-llm` skill + MCP server via
`~/.pi/agent/mcp-adapter.json`, see
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

The Pi runtime also registers first-party native `graphify_query`/
`graphify_path`/ `graphify_explain` tools through `graphify-native.ts`. Each query
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
Pi-native tool names: Graphify MCP references become `graphify_query`/
`graphify_path`/ `graphify_explain`, and context-mode MCP references become
`ctx_*` tool names so subagents never try unavailable Claude MCP tools.

Pi PR-boundary reviewers use the public `subagent` tool and the adapted
`.pi/agent/agents/*.md` definitions. The root main session launches every requested
lane together in the background without inherited context; reviewers report only,
and the root session alone applies changes or pushes.

**Per-mode seeding**: Manifest entries select the owned rules and resources for
default or advanced mode. Default includes its core rules and universal skills;
advanced additionally includes its declared memory, language, discipline,
enforcement, agent, command, and plugin resources, subject to runtime exclusions.
This is not a promise to seed the upstream generic ECC language-rule inventory.
The generated array carries variant-per-mode instructions files (see below);
exact per-mode file counts come from generator output, not a hardcoded total.

**Variant-per-mode keys**: Instructions files appear twice in the
generated array -- once for default mode (core rules only) and once for
advanced mode (its applicable manifest-selected rules, including Claude memory),
with the same R2 key but different content. `getPreseedKeysNotInMode()` handles this
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
that switcher is unusable on a mobile terminal.

Background subagents keep running under that setting, so the memory
and Vault capture hooks in `SETTINGS_CONFIG` remain independent of the
full-screen view. This native behavior needs a manual check: spawn a
subagent with the setting enabled and verify capture hooks still run.
Recheck when the CLI or official VSIX pin changes; source inspection
alone cannot establish the native behavior.

### Plugin Enablement

(Implements [REQ-AGENT-099](../../sdd/spec/agents.md#req-agent-099-agent-settings-and-plugins-assembled-at-container-start) AC3, [REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-007](../../sdd/spec/vault.md#req-vault-007-vault-rules-and-plugin-are-preseeded-into-every-advanced-session).)

`entrypoint.sh` merges `enabledPlugins` into `~/.claude.json`
to enable both the `codeflare-memory` and `codeflare-hooks` plugins.
This is permanent (not mode-gated) because missing plugins are
silently skipped by Claude Code -- when the plugin files are absent
in default mode, the plugins simply don't load. Plugins are used for
file organization and delivery via R2 sync only -- hook registration
is done via `settings.json` (see above).

- **codeflare-memory**: Two UserPromptSubmit hooks and one SessionStart hook
  registered in settings.json, scripts delivered via plugin.

Advanced registration supplies `memory-context-inject.sh` for first-prompt retrieval, `memory-capture.sh` for prompt-cadenced capture/hash checks, and `post-compaction-recall.sh` on SessionStart with matcher `compact`. [Vault & Memory](vault.md#first-prompt-and-post-compaction-retrieval) owns the complete retrieval lifecycle and digest contract; `PostCompact` is not the delivery surface.
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

The PostToolUse nudge and Stop hook share `scripts/lib/lane-classifier.sh`. The nudge records the unacknowledged head it emitted so later commands cannot repeat the launch reminder; the Stop hook remains the enforcement fallback and injects FIX only after the root ends its mutation-free triage turn. Generated-only `graphify-out/` diffs require no review lanes and are auto-acked with a durable audit event; generated artifacts never suppress review for mixed diffs. Doc-only pushes spawn only `doc-updater`; `sdd/`-only pushes spawn `spec-reviewer` and `doc-updater` in parallel; behavioral source pushes require `code-reviewer`, adding `spec-reviewer` and/or `doc-updater` only for affected spec/doc surfaces or their anchors citing changed source files (a changed spec surface also earns documentation review). Claude and Pi share this lane-classification contract; exact-head boundary rules remain unchanged.

A source delta the shared `inert-source-delta.mjs` prover proves is comments and whitespace only spawns `code-reviewer` alone, plus any `sdd/` or `documentation/` lane the same diff independently earns. When source cannot be proved inert, the code lane remains required; prover uncertainty does not invent spec or documentation ownership. Non-SDD projects fire no review agents.

Each tool-gated hook is registered on two matcher entries covering three
tool names: the `Bash` matcher (with `Bash(git *)` and `Bash(gh *)`
predicates) and the pipe-alternated MCP matcher
`mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch`.
This keeps attribution blocking and push detection effective whether
context-mode is active or not. Implements
[REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) AC3 and
[REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) AC1+AC2+AC4-AC7.
Hooks registered in settings.json, scripts delivered via plugin.

### Third-party plugin: context-mode

[context-mode](https://github.com/mksglu/context-mode) is registered as a Claude Code MCP server (`ctx_*` helper tools) where that runtime enables it. Pi installs the exact package but defaults it off. `/ctx on` enables it through the managed foreground owner and reloads resources; either toggle survives Pi reloads until the next Codeflare container start restores disabled. See [REQ-AGENT-076 AC1-AC2](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults). <!-- @impl: preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand -->

The npm package is installed and patched at image-build time in both the global Claude MCP tree and Pi's prewarmed package tree, so first invocation performs no package fetch. Entrypoint registers the Claude MCP server for every user. Custom-tier (`unlimited` subscription) delivery adds the Claude plugin hooks. Pi's managed foreground owner loads the in-process adapter only when `/ctx on` enables it. The package source is pulled from npm rather than vendored. <!-- @impl: Dockerfile::CTX_DIR --> <!-- @impl: entrypoint.sh::CONTEXT_MODE_MCP_CONFIG -->

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

Both lock-installed context-mode copies are pinned at 2.1.4. The package uses built-in SQLite (Node >=24.15.0), `cli.mjs`/`server.mjs`, and an in-process `pi/index.js`; it no longer uses the v1 Pi bridge. The foreground-owner guard and explicit `/ctx on` remain. Claude's MCP registration invokes `context-mode server --agent claude-code`; a bare invocation now prints help. Legacy hook CLI invocations remain supported.

`scripts/patch-context-mode-bundles.mjs` validates both versions against the plugin pin, retains ESM compatibility and neutralizes any legacy npm latest probe on all runtime entries. The reviewed 2.1.4 archive contains no automatic latest probe. Neither startup nor image qualification runs setup/upgrade. Docker image qualification exercises the real CLI/MCP handshake, shell execution and SQLite index/search through `scripts/qualify-context-mode.mjs`; authored checks are not passing image evidence.

v2 exposes `ctx_batch` (string command arrays), `ctx_index` (including `url`), and `ctx_execute` (including `file`), replacing `ctx_batch_execute`, `ctx_fetch_and_index` and `ctx_execute_file`. Plan Mode keeps indexing/search but does not admit general execution/batch as a replacement for the removed file helper. Skills retain native fallbacks; shared guidance changes require Curation alignment separately.

The published 2.1.4 archive embeds Zod v4.0.0 in its own validators alongside MCP's v4.6.7 copies. Lockfile alert removal alone is not security remediation of those bundles; no outer override changes embedded code. Upstream remediation or a separately reviewed rebuild remains necessary before claiming all Zod validation patched. See the [image-owned plugin notes](../../preseed/agents/claude/plugins/context-mode/README.md).

Implements [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC5.

context-mode is licensed under [Elastic License 2.0](https://github.com/mksglu/context-mode/blob/main/LICENSE).
The integration is sized to stay within ELv2's permitted-use envelope.
See [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) for the full design + license analysis.

<a id="graphify-req-agent-023"></a>
## Graphify Toolchain ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify))

Graphify shortest paths preserve calls/references direction, but structural `contains` edges may be traversed backward, printed honestly as `<--contains--`; callflow remains directional; ignored-file pruning and merge shrink protection fail closed, and Java external annotations do not collapse into local classes. BFS/DFS neighborhoods explore connections in both directions while retaining displayed edge direction. Directed shortest-path and callflow evidence remain separate: neighborhood connectivity never proves a directed path, and an absent reverse call/reference path does not authorize reversing those relations. Backward containment is structural traversal, not a reverse call.

[REQ-AGENT-215](../../sdd/spec/agents.md#req-agent-215-managed-graphify-skill-ownership) owns managed skill preservation: the image defaults upstream auto-refresh off, and bounded Claude/Pi update wrappers enforce that opt-out even when the caller enables refresh. Image-default acceptance is separate from wrapper behavioral proof.

Graphify extraction topology can change without changing the query wire format: authored workspace entry points take precedence, Rust builtins no longer create false hubs, and [Rust tuple/unit-struct constructor edges](https://github.com/Graphify-Labs/graphify/blob/e10df08877f8819a625a1afa38c3297a31fda296/graphify/extract.py#L8587-L8596) become `references` with `context: "constructor"`. Counts and callflow can change on a separately authorized refresh; an upgrade alone does not authorize rebuilding or normalizing stored graphs.

### Graph-first soft nudge ([REQ-AGENT-091](../../sdd/spec/agents.md#req-agent-091-advanced-session-graph-first-runtime-reminders) AC1)

In advanced session mode, `graph-first-nudge.sh` gives a non-blocking reminder before grep-class tool calls when a repository graph exists. Matchers cover native `Grep`/`Glob` and the context-mode grep equivalents. Prompt-aware first-turn memory remains owned by [REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt); no prompt-independent graphify startup summary is installed.

### Post-clone graph triage ([REQ-AGENT-025](../../sdd/spec/agents.md#req-agent-025-post-clone-graph-triage))

In advanced session mode, clone triage detects real `git clone`/ `gh repo clone` operations and resolves the destination from the tool result (`Cloning into '...'`) before falling back to command parsing.

If no repo graph exists, the agent asks the user which graph action to take before doing graph work: Full repo AST-only, Full repo semantic, or no graph action.

Claude's clone hook injects a directive that tells the agent to compare `graphify-out/graph.json` `built_at_commit` with `git rev-parse HEAD`. Pi performs that freshness comparison natively in its lifecycle extension.

Fresh graphs produce an information message only. A stale graph opens with an explicit STALE warning before presenting choices; an unknown-freshness graph asks without the stale flag. Both offer existing-graph-as-is, Full repo AST-only update, or Full repo semantic refresh.

Freshness plus on-disk existence are resolved at clone-event time via `exists`/`freshness` callbacks. The AST-only update uses the bounded upstream-update wrapper only after the user chooses it.

Full semantic build/refresh records clone-time intent only: after corpus detection, the graphify skill must show actual uncached file/subagent counts and get confirmation before dispatching semantic subagents. Pi mirrors the same behavior through native lifecycle events and suppresses clone triage inside durable PR-boundary review lanes.

Clone detection is scoped to shell-only command text: Bash `.command` fields, `ctx_execute` blocks with `language: "shell"`, and `ctx_batch` string command arrays. The shell parsers also accept legacy `ctx_batch_execute` and object entries with `.command` (and string entries) for compatibility; current startup hook matchers register `ctx_batch`, not the legacy name. Non-shell `ctx_execute` bodies are excluded so a source literal containing `git clone` cannot trigger the prompt.

Executable argv parsing tolerates leading environment assignments (`BROWSER="" gh repo clone`, `GIT_TERMINAL_PROMPT=0 git clone`, `env BROWSER="" gh repo clone`) and ignores quoted `;`, `&&` or `|` command-like data. Pi clone eligibility/destination and Claude's boundary classifier consume executable commands, not a separator regex.

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
recloned. Build paths generate `graphify-out/graph.html` and
`graphify-out/callflow.html` locally; labels are applied first only when community
naming was requested. The Codeflare source repository does not persist either HTML
artifact.

Model selection is runtime-specific. Claude Code's graphify skill pins its own reliable extraction model and never escalates to Opus from this workflow. Pi does not name or pin provider-specific models: Pi `Agent` semantic subagents omit a `model` override and inherit whatever model the main Pi session is using unless the user explicitly asks for a different model.

Subagents are dispatched in bounded waves to avoid flooding agent concurrency. Each wave runs in parallel; waves are sequential. Chunk count scales with the size of the non-code corpus.

### Git persistence ([REQ-AGENT-026](../../sdd/spec/agents.md#req-agent-026-knowledge-graph-persistence-via-git))

Graphify repo outputs persist in git when the user can push to the repository.
The Codeflare source repository keeps this durable committed surface:

- `graphify-out/graph.json` — queryable graph data, with `.gitattributes` wiring `graphify-out/graph.json merge=graphify`
- `graphify-out/GRAPH_REPORT.md` — human-readable graph report
- optional `.graphify_labels.json` when the user requests community naming
- optional `graphify-out/wiki/` if the user requests a wiki export

`graphify-out/graph.html` and `graphify-out/callflow.html` remain regenerable local
views and are ignored here.

The Pi graphify skill mirrors the Claude skill's persistence rule: never
blanket-ignore `graphify-out/`.

Repo ignore rules must ignore only regenerable build outputs:

- `graphify-out/cache/`
- `graphify-out/.chunks/`
- `graphify-out/manifest.json`
- `graphify-out/.graphify_*`
- repository-policy local views such as `graphify-out/graph.html` and `graphify-out/callflow.html`
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
  - Switch to `enforce_tdd: true` manually in `sdd/config.yml` once required non-manual coverage carries REQ-ID references. Legitimate manual verification supports Implemented status without automation or a TDD opt-out; manual markers and procedure links are methods, not passing receipts.
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

**Phase 7a - source-anchor truth-check (CRITICAL gate).** Before scaffold commit, `/sdd init` runs `verify-source-anchors.py` (`skills/sdd-init/references/verify-source-anchors.py`) against every <code>&lt;!-- &#64;impl: &lt;path&gt;::&lt;symbol&gt;[ = &lt;value&gt;] --&gt;</code> anchor in drafted `sdd/**/*.md` and `documentation/**/*.md`.

The verifier resolves each anchor's path on disk, confirms word-bounded symbol presence in source, validates literal value patterns within the symbol's local region, counts malformed `@impl`-shaped comments, and counts unreadable files.

It emits `.verify-anchors.json` with shape `{parsed, resolved, orphaned, drifted, malformed, unreadable, failures, malformed_entries, unreadable_entries, exit_code}`. The three detail arrays carry per-anchor failure context that CQ-SOURCE and Pass 15 consume.

The `[sdd-init]` commit body MUST include this summary line verbatim: `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`.

A non-zero exit blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`. Substituting self-attestation, a sampled audit, or a structural sanity check for verifier output is CRITICAL. Named failure modes: `phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`.

The next PR-boundary review catches those failures. During `/sdd init`, downstream CQ-SOURCE and Pass 15 consume the Phase 7a JSON rather than re-deriving anchor resolution. Outside initialization, both perform their source-truth checks inline.

**Phase 7b - enumeration-coverage verification (CRITICAL gate).** After Phase 7a and before iterate-to-clean, `/sdd init` runs `verify-enumeration-coverage.py` (`skills/sdd-init/references/verify-enumeration-coverage.py`) as the symmetric counterpart.

Where Phase 7a verifies every claim the agent wrote is anchored, Phase 7b verifies the agent did not silently drop entire source files from the enumeration.

The verifier walks the working tree with `os.walk` in-place pruning for `node_modules`, `dist`, `.git`, `sdd/`, `documentation/`, and similar directories. It identifies load-bearing source files by project-shape-agnostic heuristic: files under `services/`, `handlers/`, `controllers/`, `providers/`, `models/`, `domain/`, `core/`, `commands/`, `usecases/`, or `workers/`, plus files with at least 100 source lines.

Each file's repo-relative path is checked against the `<path>` portion of every `@impl` anchor in the drafted spec/docs and against literal mentions in the layout-appropriate triage queue. Nested layout uses `sdd/spec/.init-triage.md` + `sdd/spec/.review-queue.md`; flat-layout legacy uses `sdd/.init-triage.md` + `sdd/.review-needed.md`.

Output goes to `.phase-7b.json` with shape `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}`.

The `[sdd-init]` step-10 commit body MUST include this summary line beside Phase 7a's: `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1`.

The two gates close the Validation-Equals-Generation gap: an Import-Mode agent using anchorability as the generation predicate can produce a clean Phase 7a, an empty triage queue, and a spec that elides every ambiguity. Phase 7b detects this.

Failure modes are CRITICAL: `phase-7b-self-attestation`, `phase-7b-incomplete-coverage`, `phase-7b-pipeline-inversion`, `phase-7b-evidence-missing`, `import-mode-narrowed-scope`, `import-mode-empty-triage-implausible` (Phase 4 enumeration-review companion), and `phase-4-enumeration-skipped`.

Per-project waiver: `sdd/spec/.phase-7b-waiver.txt` excludes specific framework-boilerplate files from the coverage check. Use one repo-relative path per line; `#` comments are allowed and entries require a one-line justification.

Phase 7b is advisory for greenfield. `enumerated=0` and `coverage_pct=100.0` are the expected outcome with no source on disk yet, but the commit body line is still required so the audit-trail format stays uniform. Implements [REQ-AGENT-039](../../sdd/spec/agents.md#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate) AC7.

**Tool surface compatibility.** Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works under both Bash and the context-mode MCP tool family (`mcp__context-mode__ctx_execute`, `mcp__context-mode__ctx_batch`, `mcp__context-mode__ctx_search`). Discovery commands that produce more than 20 lines of output (`gh pr list --state all`, `git log --follow`, `npm view <pkg> peerDependencies`, full-tree scans, scaffold-only `npm install --package-lock-only`) route through `ctx_execute`/ `ctx_batch` in context-mode environments and through Bash in plain environments.

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

### SDD bootstrap acceptance

**Scope:** [scaffolding](../../sdd/spec/agents.md#req-agent-033-sdd-init-scaffolding-and-canonical-render) and [Import-mode status assignment](../../sdd/spec/agents.md#req-agent-093-import-mode-tdd-status-assignment). This is an unexecuted qualification procedure, not a passing result.

**Setup:** Use disposable local repositories without remotes, outside the working project. Record the agent, source revision and resulting files. These checks authorize no deployment, push, credential change or application build. Decline graph creation unless separately authorized.

| Case | Action | Required observation |
|---|---|---|
| Greenfield | In an empty repository, request `/sdd init` for a Worker with a public health response. Supply the vision, request one change to the complete draft, then accept it. | One vision exchange and one full-draft review surface; the requested edit remains in that draft. No scaffold files appear before acceptance. Written requirements use the canonical fields, numbered ACs and separators; `sdd/spec/.review-queue.md` starts with `_Awaiting first finding._`. |
| Live review queue | In a disposable scaffold copy, give one requirement Implemented status and an `@impl: missing.ts::missing` target, then run `/sdd clean` there. | The unresolved source target produces a live queue finding; the scaffold queue is not treated as a completed historical report. |
| Package resolution | If that scaffold includes a package manifest, inspect the recorded version queries, peer constraints and lockfile operation. | Top-level versions come from current registry evidence; the Cloudflare cohort is compatible. npm lockfile resolution uses `--package-lock-only --ignore-scripts`; no full install, test runner or build occurs. Absence of a generated package manifest is not package-resolution evidence. |
| Import without TDD | In a separate repository containing only `export const twice = n => n * 2;` as application source and no tests or SDD files, request Import Mode with `enforce_tdd: false`. | The clear implemented doubling behavior is derived from source, not invented scaffolding, and is marked Implemented. Record the selected TDD setting with the output. |
| Import with TDD | Repeat that source-only fixture in a fresh repository with `enforce_tdd: true`. | Without REQ-referencing tests, the source-implemented requirement remains Partial; merely finding its implementation cannot promote it. |

**Verify:** Inspect the actual generated documents and operation transcript for every applicable observation. Missing observations are unverified, not passes. Stop on premature writes, fabricated source behavior, wrong status, unresolved generated anchors or prohibited execution; retain the failing output for correction. Keep final Plan Mode entry separate from permission to implement the proposed application.

#### Workflow artifact identities

Keep exact spellings here while requirements state observable outcomes. Resolve root/nested paths through the existing layout owner; flat compatibility shorthand does not authorize a second output tree.

| Contract | Owned artifact/interface detail |
|---|---|
| [REQ-AGENT-022](../../sdd/spec/agents.md#req-agent-022-legacy-codebase-import-mode-discovery) AC1/AC6 | Domain requirements use `sdd/{domain}.md` in flat layout and its nested equivalent; unresolved import items use `.init-triage.md`. Unavailable-GitHub notices also go in the import `sdd/changes.md` entry or its resolved nested owner. |
| [REQ-AGENT-033](../../sdd/spec/agents.md#req-agent-033-sdd-init-scaffolding-and-canonical-render) AC7 | Nested verification uses `sdd/spec/.review-queue.md` and its `_Awaiting first finding._` scaffold placeholder. This is the verification queue, not a documentation coverage placeholder. |
| [REQ-AGENT-034](../../sdd/spec/agents.md#req-agent-034-sdd-init-enrichment-pass-with-graphify) AC4/AC5 | The nested glossary is `sdd/spec/glossary.md`; graph input is `graphify-out/graph.json`. Claude's `mcp__graphify__*` recipes map `get_neighbors` to cross-links, `god_nodes` to ADR seeds, `query_graph` to glossary concepts and `shortest_path` to dependency validation; Pi uses its native Graphify owner. |
| [REQ-AGENT-035](../../sdd/spec/agents.md#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) AC5 | The verifier JSON `exit_code` gates commit; escalation goes to the resolved verification queue, `sdd/spec/.review-queue.md` in nested layout. |
| [REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions) AC5 | Only open `.init-triage.md` items plus active transition suppress review in root/nested layouts; ordinary review queues are not transition state. |
| [REQ-AGENT-037](../../sdd/spec/agents.md#req-agent-037-sdd-clean-rescue-and-autonomy-modes) AC1 | Autonomy comes from `sdd/spec/config.yml` in nested layout or `sdd/config.yml` in flat legacy layout. |
| [REQ-AGENT-038](../../sdd/spec/agents.md#req-agent-038-resume-mode-drain-workflow) AC1/AC5 | Existing `sdd/` plus open `sdd/.init-triage.md` identifies Resume in flat shorthand; resolve the selected layout. Resume ignores configured `mode` and remains interactive with a clean working tree. |
| [REQ-AGENT-092](../../sdd/spec/agents.md#req-agent-092-import-transition-review-suppression) AC1 | `.init-triage.md` is import transition work; `.review-queue.md` and legacy `.review-needed.md` are ordinary verification work, never suppression authorities. |
| [REQ-AGENT-048](../../sdd/spec/agents.md#req-agent-048-audit-accumulator-surfaces) AC1 | `documentation/.doc-coverage.md` is the optional root-owned substantive coverage artifact; the applicable commit body remains an alternative. Neither is a scaffold-time empty coverage file. |

#### Agent workflow extensions to SDD bootstrap acceptance

Extend the existing SDD bootstrap acceptance cases, using its disposable-repository setup and stop conditions. Use shipped workflow/validator paths already named in the current requirement; do not create another enforcement implementation, test project or harness. The original no-premature-write, no-install/build/test and graph-consent boundaries remain in effect. Any pushing case requires an explicitly approved disposable remote, otherwise only its local observations can be made.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) | Use the existing SDD bootstrap acceptance disposable repositories; inspect advanced delivery of SDD/vault/CI owners, then exercise init, edit, add, clean and mode with context-mode disabled. Include an absent-SDD fixture and hard-gate refusal; inspect native discovery, graph and planning names, root-only mutation and specification-before-documentation order. Decline graph creation unless separately authorized. | Advanced SDD owners are delivered without duplicate Pi ambient rules. All five subcommands work with native tools and optional context-mode; command hard gates precede dispatch. Root performs spec enforcement before doc enforcement without PR reviewer delegation. |
| [REQ-AGENT-022](../../sdd/spec/agents.md#req-agent-022-legacy-codebase-import-mode-discovery) | In an authorized disposable Import repository with known README/config/source/test/ADR and commit/tag evidence, request /sdd init; compare clear requirements and unclear triage entries with those inputs. If an already-authorized GitHub corpus exists, follow one issue/PR/comment/release/wiki backward-reference chain; separately inspect the unavailable-corpus notice and working-tree/history fallback without inventing inaccessible evidence. | Clear history-backed behavior becomes requirements and ambiguity becomes triage in the same import. All named reachable sources and backward links are considered; unavailable GitHub sources produce a reason notice and local/history fallback, not invented evidence. |
| [REQ-AGENT-034](../../sdd/spec/agents.md#req-agent-034-sdd-init-enrichment-pass-with-graphify) | Extend the SDD bootstrap fixture with cross-referenced concepts, founding technology alternatives and glossary nouns. Accept the complete draft once; inspect pre-write enrichment, graph queries/dependencies, 3–8 substantive founding decisions and glossary definitions. Graphless: decline the single graph offer and inspect the reduced-density notice; never infer graph-creation permission. | After complete-draft acceptance and before writes, one enrichment cycle adds linked dependencies, 3–8 substantive founding ADRs and noun/vendor/protocol definitions using the named graph evidence. Missing graph prompts once; declining records heuristic reduced-density limits, identically across tool surfaces. |
| [REQ-AGENT-035](../../sdd/spec/agents.md#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) | Use an approved disposable fixture with valid, orphaned, literal-drifted, malformed and unreadable spec/doc anchors. Run the shipped Phase 7a verifier; inspect complete JSON counts/details, exit code, audit summary, gate ordering, blocked commits and downstream init-time consumption. Do not commit or repair this repository. | Complete Phase7a JSON includes resolution/drift/malformed/unreadable details and exact summary; gate ordering precedes spec/doc enforcement. Nonzero failures block commit absent correction/escalation, and downstream truth passes during `/sdd init` consume the report rather than self-attestation; steady-state checks run inline. |
| [REQ-AGENT-037](../../sdd/spec/agents.md#req-agent-037-sdd-clean-rescue-and-autonomy-modes) | Use disposable branches and, for push behavior, an explicitly authorized disposable remote. Exercise interactive/auto/unleashed shape repair and unleashed with enforce_tdd false. Inspect confirmation/refusal, root-only spec-then-doc order, lossless judgment, recoverable per-category commits and checked-out-branch delivery. Local dry review cannot prove remote push behavior. | Interactive/auto/unleashed preserve current-branch ownership and their confirmation/fix semantics. Unleashed refuses TDD-off; judgment remains lossless and commits per category remain recoverable. Approved successful auto/unleashed delivery reaches the checked-out remote branch without a new branch/PR. |
| [REQ-AGENT-039](../../sdd/spec/agents.md#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate) | Run the shipped Phase 7b verifier on an approved disposable fixture: anchored load-bearing, triage-accounted and unaccounted files, plus justified boilerplate waiver. Inspect zero-source greenfield output, enumeration/accounting/coverage/detail JSON, Phase 7a→7b→iterate order and standard audit line. Unaccounted source plus empty Import triage must fail. | Phase7b follows Phase7a before iteration, accounts every load-bearing file and emits complete JSON plus exact audit line. Empty Import triage with unaccounted source is critical; justified boilerplate waiver and zero-source advisory case remain distinct. |
| [REQ-AGENT-045](../../sdd/spec/agents.md#req-agent-045-import-mode-triage-queue-and-transition-state) | Review Import triage entries with missing, placeholder and specific Context/Recommendation/Rationale through the shipped validator in an approved disposable fixture; inspect rejection versus acceptance output. Resolve a separate entry as lost and inspect its one-line Reason without promoting it into a requirement. | Specific Context/Recommendation/Rationale entries pass; missing/placeholder/generic entries fail before commit. Lost entries retain a one-line Reason and do not become requirements. |
| [REQ-AGENT-047](../../sdd/spec/agents.md#req-agent-047-resume-mode-closure-and-review-pipeline-gate) | In an approved disposable Resume fixture containing accepted/corrected and lost items, resolve the last open item. Compare transition/enforce_tdd before/after, closure totals and retained triage. Inspect authorized Claude boundary observations with open versus closed transition; never push merely to manufacture a review event. | Closing the last open item clears transition, records resolved/lost totals, preserves enforce_tdd and retains triage history. Claude review suppression applies only during the open transition. |
| [REQ-AGENT-094](../../sdd/spec/agents.md#req-agent-094-per-ac-test-evidence-supports-multiple-anchors) | In an approved disposable spec fixture put one resolving and one orphaned test anchor on the same AC, then use the existing specification-enforcement workflow. Inspect valid coverage plus spec-test-anchor-orphaned for the bad anchor; ensure named-block and behavioral-quality checks still apply rather than counting both as coverage. | The resolving block supplies coverage while the second orphan still emits spec-test-anchor-orphaned; multiple anchors are valid but file/block/behavior quality checks remain independent. |
| [REQ-AGENT-139](../../sdd/spec/agents.md#req-agent-139-optimized-documentation-lane-rendering-and-delivery) | Inspect bundled lane templates/manifest delivery; use the existing disposable SDD bootstrap staging workflow for selected/unselected lanes. Exercise existing-path/symlink-stage refusal and an already-approved rendering/promotion failure. Require no partial staging and restored live docs from sibling backup. Never invent production failures or a renderer harness. | Selected templates/lanes/index only are emitted and delivered through canonical manifests. Occupied/symlink staging refuses; render failures remove partial output and failed promotion restores existing live docs from backup. |
| [REQ-AGENT-140](../../sdd/spec/agents.md#req-agent-140-lossless-documentation-lane-cleanup-and-enforcement) | Extend the disposable clean fixture with mixed-shape recognized collections: clause/link/diagram/compatibility fragment/REQ/ADR/source anchor, unrelated headings/tables and legacy Action/Verify aliases. Run existing cleanup only there; compare preserved bytes or unchanged deferral, lane envelope and checker content neutrality. No load-bearing information may disappear to meet shape. | Every protected clause/link/diagram/fragment/REQ/ADR/source anchor survives normalization or the collection defers unchanged. Recognized records/legacy aliases are checked, unrelated tables/headings are not normalized, checker stays product-neutral and project-lane envelope survives. |
| [REQ-AGENT-142](../../sdd/spec/agents.md#req-agent-142-unambiguous-documentation-decision-history) | Use a disposable decision ledger with active, fully superseded, partially superseded and merged/reclassified records; inspect rendered index/section links and run the existing shape workflow there. Compare retained historical body, both struck ID/Decision cells only for fully superseded, explicit partial replacement/successor, and Redirect anchor destination/status for redirects. | ADR index/sections join bidirectionally. Fully superseded bodies remain substantive and both linked ID/Decision cells are struck; partial rows stay unstruck with replaced clause/successor. Merged/reclassified status uses Redirect anchor and links destination. |
| [REQ-AGENT-146](../../sdd/spec/agents.md#req-agent-146-self-contained-adr-decision-index-summaries) | Read the ADR index contract/template and use a disposable ledger with supported and unsupported summaries, historical successors/partial replacements/redirects and mismatched states. Inspect single-line five-cell rows and rendered lengths (Decision <=90, Summary 40–180), named-subject sentence and semantic support of driver/consequence/tradeoff. Review unsupported rationale as adr-index-summary-semantic-gap; keywords alone cannot pass. | Single-line rows contain ID/Decision/Summary/Category/State, lengths follow 90 and 40–180 rendered-character limits and summaries are named-subject supported sentences. Unsupported rationale is reported semantically; historical successor/replacement/redirect and index/section states agree across init/enforcement contracts. |
| [REQ-AGENT-143](../../sdd/spec/agents.md#req-agent-143-resolvable-documentation-evidence-references) | Open each Security verification/source-map ADR/REQ/CON/domain reference in a disposable documentation fixture and inspect exact destination section/file. Use the existing shape workflow to compare linked IDs with bare identifiers or unexplained SDD labels; no source-body or runtime project is needed for link usability review. | ADR/REQ/CON references resolve directly to exact anchors and domain references name exact files, not bare IDs or unexplained SDD labels. |

<a id="troubleshooting"></a>
## Failure Diagnosis and Recovery

### Common Issues

Symptom-led hook diagnosis, corrections and verification belong to [Troubleshooting](troubleshooting.md#preseed-common-issues). Manifest, mode, compiler and delivery ownership remain in this lane.

<a id="resetting-review-spawn-checkpoints"></a>
### Review completion prompt or FIX is missing

See [Troubleshooting: review completion prompt or FIX is missing](troubleshooting.md#review-completion-prompt-or-fix-is-missing). Interrupted/reloaded rounds are not recovered by delayed notifications: use a fresh supported exposure of the current exact identity. Completion requires current-round terminal reviewer/CI evidence and canonical mutation-free triage. Do not recreate legacy checkpoint files.

## Image-Baked Delivery Alias

In addition to seeding the agent config into R2 at session start, the container image **bakes** the same seed as an on-disk file tree so a [Governed Mode](configuration.md#governed-mode-r2-sse-c-disable) container can avoid re-downloading it every boot ([REQ-STOR-256 AC1–2](../../sdd/spec/storage.md#req-stor-256-image-seed-relay-cache-reuse-and-prewarm-priority), [AD90](../decisions/README.md#ad90-governed-mode-preseed-bake--checksum-delta-initial-sync)).

- **Build (in-image).** The Dockerfile runs `scripts/materialize-agent-seed.mjs` against the committed, freshness-enforced `src/lib/agent-seed.generated.ts`.
  - It writes `getConfigsForMode('default'/'advanced', false)` to `/opt/codeflare/agent-seed-bake/<mode>/<key>`.
  - For the same generated payload, mode and selected-agent projection, the baked tree is **byte-identical** to its baked R2 projection. Independently published signed managed content is not required to equal that fallback.
  - That byte identity is the precondition for the checksum skip and is guarded by the `agent-seed-bake` byte-identity test.
  - The tier-gated context-mode subtree is excluded because it delta-syncs from R2.
  - Generating in-image needs no host build ordering and cannot drift from the seed.
- **Runtime (inactive managed curation, Governed Mode only).** Before the initial R2 sync, `entrypoint.sh::lay_down_agent_seed_preseed` copies the mode's baked tree into the user home.
  - The copy mirrors the R2 key layout but lays down only deployment-selected agent roots. Active managed curation skips the bake; post-restore relay restores only declared image-owned companions, preserving release-owned bytes.
  - It also `chmod +x`'s the hooks.
  - The initial sync then compares by `--checksum`, using MD5 ETags available only when SSE-C is off.
  - Unchanged seed files are skipped and only user deltas transfer.
- **Gated.** Lay-down requires inactive managed curation and `R2_SSE_DISABLED=true`; the separate initial-sync `--checksum` gate requires `R2_SSE_DISABLED=true`. Selected-agent roots further bound lay-down.
  - Under SSE-C, no bake is laid down and initial restore uses rclone's size plus modification-time comparison because opaque ETags cannot support `--checksum`.
  - The prior `--size-only` comparison was removed because it retained stale local bytes for same-size release changes.
  - Avoiding the bake under SSE-C also prevents it from overwriting an in-container edit. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @impl: entrypoint.sh::lay_down_agent_seed_preseed -->

---

## Managed-agent qualification

These methods define observations, not execution evidence. Record exact revision/image/seed/mode and redacted outcomes; absent prerequisites remain blocked. Supplemental tests do not replace marked manual criteria. Protected access, state changes, inference, graph work and publication need separate current authorization with existing disposable resources. Never replay uncertain operations or expose secrets. Static guidance review proves neither deterministic obedience nor deployed behavior; CI/image/publication/deployment gates remain separately owned.

### Agent settings and seed acceptance

Manual observation is primary for [REQ-AGENT-008](../../sdd/spec/agents.md#req-agent-008-preseed-deployed-to-container-on-start) AC1/2. The existing missing-only seed fixture supplements AC1: its inspected written/skipped results and HEAD/PUT requests do not establish first-bucket delivery or startup ordering. <!-- @test: src/__tests__/lib/r2-seed.test.ts (seeds only missing agent configs when overwrite=false) --> Source selects current-mode documents and defaults to nonoverwrite; startup awaits restore before post-restore configuration and required managed completion. <!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs --> <!-- @impl: entrypoint.sh::run_initial_r2_restore --> <!-- @impl: entrypoint.sh::run_managed_curation_startup --> Keep the two existing manual cases below; none was executed by authoring these links.

Use separately authorized disposable owners/objects and the existing Settings/session/reseed paths. Record redacted before/after state and preserve unrelated user files. New UI, billing events, credentials, data clearing, cross-owner probes and live protected infrastructure are not authorized by this procedure. A missing approved failure observation is unverified, not permission to inject a production failure.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-002](../../sdd/spec/agents.md#req-agent-002-agent-selection-at-session-creation) | In an authorized disposable account, create consecutive sessions with different available agent types, reopen each record and the next creation dialog, and inspect the stored agent identity and default selection without starting an unavailable agent. | Each reopened session retains its selected agent type; the next creation dialog defaults to the most recently used type. |
| [REQ-AGENT-004](../../sdd/spec/agents.md#req-agent-004-two-session-modes-standard-and-pro) | With an authorized disposable owner, inspect unset/persisted preferences, both Settings modes and delivered paths after Recreate, bucket creation, Settings changes and already-authorized payment upgrade/downgrade/termination. Preserve an unrelated sentinel; inspect existing webhook, unmanaged and managed reconciliation-failure evidence separately. Do not manufacture billing events or failures. | Unset preferences remain absent; Settings selection persists. Each named reconciliation trigger applies the selected mode, preserves unrelated user files, and webhook and unmanaged Settings reconciliation failures remain nonfatal. Managed Settings failures propagate, retain repair targets, restore pre-request preferences on non-conflict failures and preserve newer preferences on conflicts without stale publication. |
| [REQ-AGENT-008 AC1](../../sdd/spec/agents.md#req-agent-008-preseed-deployed-to-container-on-start) | For a separately authorized disposable first-bucket creation, prearrange a harmless existing sentinel object and inspect before/after object inventories: only missing current-mode managed entries may be added; existing bytes and unrelated objects must survive. No bucket creation is authorized by this draft. | First seeding adds only missing current-mode managed objects; preexisting objects retain exact bytes and no object disappears. An empty baseline alone cannot establish the nonoverwrite branch. |
| [REQ-AGENT-008 AC2](../../sdd/spec/agents.md#req-agent-008-preseed-deployed-to-container-on-start) | Inspect existing initial-sync/startup logs and nonsecret managed-file presence for an authorized disposable session. For timeout, require an existing failure receipt; do not force outages or change credentials. | Successful restore precedes agent launch. An observed timeout ends the bounded wait without bypassing required managed startup checks. Missing branch evidence remains unverified, not a passing result. |
| [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv) | Use two separately authorized disposable owner accounts with distinct test credentials; inspect each owner's normal masked credential listing and rejected cross-owner access through the supported boundary. Review durable owner-key mapping and encrypted representation without printing key values. One account's success is not isolation proof. | Each owner sees only its own durable masked credentials, cross-owner access is denied and stored representation is encrypted; no report exposes key material. |
| [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token) | In an authorized disposable account with test deploy credentials, make one authorized `DELETE /api/deploy-keys` request, then read the normal masked `GET /api/deploy-keys` response to confirm both credential slots are absent (`null`); do not clear real credentials. | One authorized DELETE removes both stored deploy credential slots; the subsequent masked GET shows neither remains. The current Settings OAuth cards have per-provider Disconnect, not a single clear-all control. |
| [REQ-AGENT-011](../../sdd/spec/agents.md#req-agent-011-agent-skills--rules-manually-recreatable-from-settings) | For an authorized disposable owner, record managed paths, unrelated user bytes and storage statistics. Invoke Recreate in each mode; check desired-path replacement, inactive-managed-path removal, preserved user bytes and fresh statistics. Probe a fourth request within one minute only with separate approval; never erase production settings. | Recreate rewrites desired managed paths and removes inactive managed paths while unrelated user bytes survive. The fourth request inside one minute is limited, and subsequent statistics reflect invalidated/recomputed cache rather than stale values. |
| [REQ-AGENT-012](../../sdd/spec/agents.md#req-agent-012-fast-cli-start-configurable) | Open Settings session defaults in an authorized account, toggle Fast Start, reload the view and inspect the saved value; restore the baseline only with authorization. Confirm this is the session preference, not a model-tier control. | The Settings session-defaults Fast Start toggle reflects the selected persisted preference after reload. |
| [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push--deploy-credential-management-ui) | With separately authorized OAuth configuration, verify each mode shows only configured Cloudflare; GitHub stays on the dashboard. Authorize the owner, choose an accessible account and start a disposable session. Perform an approved harmless API read, disconnect only that owner, repeat; inspect redacted outcomes, never secrets. | Configuration alone offers Connect, not a connected grant. The authorized owner read succeeds within its permissions; disconnect prevents further managed owner access without affecting another owner or administrator Browser Run. |
| [REQ-AGENT-019](../../sdd/spec/agents.md#req-agent-019-branded-settings-ui) | Open the existing Settings UI, expand each provider row, inspect its SVG brand mark, use the accent picker, and inspect Session controls; verify mode and sleep-timeout controls are there and agent type remains on session creation. This is qualitative UI observation, not a new UI implementation or screenshot harness. | Provider SVG rows expand inline; accent choice is available; Session has mode/sleep controls, while agent selection stays on session creation. |
| [REQ-AGENT-020](../../sdd/spec/agents.md#req-agent-020-llm-api-key-management-ui) | In an authorized disposable Settings profile, attempt malformed test-key input, observe validation without saving a real secret, then use an approved valid test-key save if available. Inspect the rejection/success state and masked value only; no provider request or credential mutation is authorized now. | Malformed key input is rejected before persistence; an approved valid test-key path saves only validated input and exposes only a masked value. |
| [REQ-AGENT-029](../../sdd/spec/agents.md#req-agent-029-deploy-credential-propagation-to-container) | In separately authorized fresh disposable containers with and without a GitHub credential, inspect git credential-helper configuration and an approved read-only HTTPS access result without retrieving the helper's secret. Confirm absence in the credentialless case and do not print helper credential output. | Credentialed startup configures authenticated HTTPS Git; credentialless startup does not install the credential helper. No secret value is printed. |
| [REQ-AGENT-032](../../sdd/spec/agents.md#req-agent-032-starter-documentation-manually-recreatable-from-settings) | For an authorized disposable Getting Started reseed, record storage statistics, perform the existing tutorial recreate action once, and reopen statistics; compare the changed seeded objects with the invalidated/recomputed cache rather than assuming an HTTP success proves invalidation. | After tutorial reseeding, storage statistics are recomputed from current objects rather than returned from the old cache. |
| [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release) | Compare existing sorted compiled payload keys/bytes with their recorded content hash, then inspect an already-authorized successful manual/automatic reconciliation's persisted applied identity and the next dashboard upgrade-decision response. Repeat identity comparisons for missing/outdated stored identity and Enterprise inputs without manufacturing releases. | Content hash is deterministic over sorted managed documents; successful reconcile stores the applied identity. Dashboard upgrade decisions compare stored identity/mode with current desired environment, including missing/stale identity and Enterprise inputs. |

### Managed workflow and policy inspection

Read delivered guidance and its owning source, then manually review the named examples or existing output transcripts. Wording, copy, editorial judgment and policy contracts remain manual; this procedure does not demand a runtime harness for them. Instructions are not guarantees of deterministic agent obedience. Actual guard outcomes need existing boundary receipts or separately approved safe observations.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-212](../../sdd/spec/agents.md#req-agent-212-canonical-pull-request-history-record) | Read the PR authoring reference's Prepare, Canonical shape, Links and traceability, Verification, Completion checklist and Review record sections; compare a draft PR body with those roles and inspect both native Pi and canonical pr-workflow relative references. Compare existing default/advanced compiled inventories for delivery; do not create or edit a PR. | Draft body roles remain ordered; traceability links explain relationships; evidence distinguishes exact heads, modalities and pending limits; review stays last. Both modes deliver the same canonical reference to supported skill runtimes, including native Pi's matching relative path. |
| [REQ-AGENT-024](../../sdd/spec/agents.md#req-agent-024-advanced-session-mode-graph-first-discipline) | Read the advanced graphify-routing projection and compare broad architecture/ownership/call-flow requests with known-file, Git/CI and current-task requests in existing transcripts or separately authorized fresh contexts. Inspect tool order and conflicting source/graph evidence; no graph creation or refresh may be inferred from the route. | Advanced broad searches query an existing graph first; known-file/Git/CI/current-task work skips it. Current source wins stale conflicts and Pi activates hidden native query tools through capability. |
| [REQ-AGENT-048](../../sdd/spec/agents.md#req-agent-048-audit-accumulator-surfaces) | Read doc-enforce's output contract and sdd-clean's audit contract; inspect existing root-persisted coverage output or relevant commit bodies and confirm report-only doc-updater, lazy substantive retention and no scaffold placeholder/audit dotfile. Use Git history receipts rather than adding a new execution-report file. | Only root retains substantive coverage when needed; no scaffold placeholder is created. Clean audits are recoverable from per-category Git commit bodies, not a new audit dotfile. |
| [REQ-AGENT-051](../../sdd/spec/agents.md#req-agent-051-pi-debug-deploy-and-brainstorm-commands) | Inspect the advanced Pi native command registrations and injected debug/deploy/brainstorm workflow bodies, including appended user input; compare default inventory absence. Review debug root-cause/3-Fix ordering, deploy push/CI/live-URL roles and brainstorm options/tradeoffs/recommendation without invoking /deploy or running any service. | Advanced-only native commands inject their own workflow plus user input: debug establishes root cause before fixes/3-Fix escalation; deploy retains push/CI/deployment/live-URL roles; brainstorm yields options/tradeoffs/recommendation. No command depends on a nonexistent skill file. |
| [REQ-AGENT-231](../../sdd/spec/agents.md#req-agent-231-pi-commit-attribution-guard) | Review Pi's attribution guard against the documented Git commit/merge/tag/notes and gh PR/issue/release forms with global options, genuine attribution signatures including brain/ChatGPT, and a bare-Claude source path counterexample. Inspect existing authorized rejection/allowance receipts from the guard boundary; do not execute real GitHub mutations or consume a local-build bypass to create them. | The guard rejects genuine attribution across the expanded Git/gh command families/global options, including its deliberate brain/ChatGPT superset, while bare Claude paths remain allowed. Rejection/allowance must come from the real guard boundary, not a real remote mutation. |
| [REQ-AGENT-193](../../sdd/spec/agents.md#req-agent-193-orthogonal-frontend-specialist-boundaries) | Read frontend-components, engineering-constitution, component-system and operational references and generated Copilot fallback. Review one isolated one-off/shared-state extraction proposal and protected-I/O ordering example; pass only if ownership/coupling/state evidence, incumbent art direction and validation/authorization boundaries survive without generic frontend-patterns guidance or unavailable-skill invocation. | Extraction follows ownership/state/coupling/reuse/maintenance evidence, not repetition count. Direction remains with the selected platform owner; protected I/O waits for validation/authorization. No generic frontend-patterns policy or unavailable Copilot skill invocation appears. |
| [REQ-AGENT-195](../../sdd/spec/agents.md#req-agent-195-portable-humanize-writing-guidance) | Review a consequential proposal rewrite and a source-only debugging request in separate contexts; with no detector/network tool available, revise source material with deliberately missing facts and compare every factual addition with the input. Inspect the broad tour's Humanize guidance for no detector-evasion guarantee; subjective writing quality stays editorial. | Editorial work activates Humanize while unrelated technical work does not. The reviewed rewrite uses no detector/service/script and invents no facts/anecdotes/attributions; the capability tour gives no detector-evasion promise. |
| [REQ-AGENT-201](../../sdd/spec/agents.md#req-agent-201-ambient-cloudflare-environment-routing) | Review the projected cloudflare-environment rule using a preference-free project request and explicit incumbent-platform request; inspect Cloudflare-stack loading before architecture choice, local-GUI refusal versus authorized Browser Run, HTTPS/noreply Git identity, safe secret piping and honest alternatives. Do not launch a GUI, create credentials or run deployment. | Delivered guidance defaults preference-free work to Cloudflare/stack-first, preserves explicit context, GUI restrictions versus authorized Browser Run, HTTPS/noreply Git identity, safe secret piping/noncommitment and honest safe alternatives. |
| [REQ-AGENT-202](../../sdd/spec/agents.md#req-agent-202-ambient-cloudflare-workers-routing) | Review the Cloudflare Workers routing projections alongside a scoped API/config choice example: identify official-document retrieval, repository-pinned tooling/approved path and unchanged compatibility settings unless required and documented. This checks delivered guidance, not a new SDK/tool execution. | Delivered Workers guidance retrieves current official API/config evidence, uses pinned tools through approved paths and changes compatibility settings only for required, documented work. |
| [REQ-AGENT-203](../../sdd/spec/agents.md#req-agent-203-ambient-memory-and-vault-routing) | Read memory rule projections and compare explicit recall, Vault and unrelated task examples: identify their owning routes, absence of ambient capture/extraction dispatch and absence of a compulsory unrelated graph query. Do not trigger capture or graph mutation. | Explicit memory/Vault requests reach their existing owners; unrelated work does not require a graph query and the ambient rule does not duplicate runtime capture/extraction dispatch. |
| [REQ-AGENT-204](../../sdd/spec/agents.md#req-agent-204-ambient-enforcement-routing) | Read spec/documentation/test/note route projections in both relevant modes and trace the referenced enforcing owners. Inspect root clean order and parallel-boundary documentation lane policy without launching reviewers or enforcement; verify detailed mechanics remain with owners rather than duplicated ambiently. | Spec/docs/tests/notes retain enforcing routes, boundary doc review joins the other lanes, and root clean orders spec before doc checks. Ambient rules do not replace the detailed owners. |
| [REQ-AGENT-065](../../sdd/spec/agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents) | Read the engineering constitution in both compiled modes for every supported runtime; review the delivered Engineering section against a source-led narrow-change example, behavioral-proof/SDD tracing, evidence-based extraction, local mutation/immutable preference, untrusted boundaries and background-only waits. This is policy/content review, not a requirement to execute a new project or prove deterministic obedience. | Every runtime/mode receives repository-led narrow-change engineering policy, observable behavioral proof, ownership-based composition, localized mutation and boundary validation, truthful SDD tracing and background-only long waits with approved local checks. |
| [REQ-AGENT-198](../../sdd/spec/agents.md#req-agent-198-engineering-constitution-security-policy) | Read all delivered Security sections and compare an embedded malicious instruction, exposed-tool request, cross-tenant data request and destructive/billing/credential example; the policy must retain nonauthority of data/tools, secret/tenant/privilege fail-closed boundaries and explicit current-user authorization. No protected action is performed. | Delivered policy treats data/tool availability as nonauthority, preserves secret/auth/tenant/privilege fail-closed boundaries and requires current-user authorization for protected actions. |
| [REQ-AGENT-199](../../sdd/spec/agents.md#req-agent-199-engineering-constitution-dependency-policy) | Read delivered Dependencies sections and compare latest-stable authoritative lookup, an explicit repository pin and a narrow unrelated repair; preserve the user/repo version exception and reject unrelated upgrade scope. No install or version change is part of this manual guidance review. | Delivered policy uses authoritative latest-stable evidence unless user/repository pins another version, and a narrow repair does not pull in unrelated upgrades. |
| [REQ-AGENT-200](../../sdd/spec/agents.md#req-agent-200-engineering-constitution-work-continuity) | Read delivered Continuity/User authority sections and compare same-task correction, unrelated request, stop/pause/reprioritization and named override examples. Preserve acknowledgment/retention, finish-and-verify default and latest-user authority while keeping system/platform/security constraints binding; do not invent consent or execute protected examples. | Delivered policy acknowledges/retains corrections and finishes/verifies active work unless stopped/paused/reprioritized; latest explicit user authority controls workflows/overrides without waiving binding system/platform/security limits. |
| [REQ-AGENT-208](../../sdd/spec/agents.md#req-agent-208-managed-git-workflow-deployment-policy) | Read Pi/Claude Git workflow rules side by side: locate the deployment-CI policy and independently trace reviewer-then-exact-head-CI, terminal-evidence-before-triage and manual-merge rules. A lack of CI-only deploy prohibition is not authorization to deploy, bypass review or merge. | Rules do not forbid deployment solely because CI is missing/pending/failed, but independent authorization remains required. Boundary reviewers precede exact-head CI; terminal evidence precedes triage and merging stays manual. |
| [REQ-AGENT-189](../../sdd/spec/agents.md#req-agent-189-layered-codeflare-capability-discovery) | Read the complete capability overview and existing router, then review broad-tour outputs in Standard/Advanced configured/unconfigured/permission-gated contexts, including an initially truncated read. Compare verbatim complete overview and stable 1–14 navigation without tier/mode labeling, added framing or subsystem reads; inspect load transcript separately from output. | Broad replies reproduce the complete overview without extra framing, mode/tier labels or subsystem reads; boundaries remain honest and navigation stays the independent ordered 1–14 mapping, including after a truncated initial read. |
| [REQ-AGENT-207](../../sdd/spec/agents.md#req-agent-207-user-focused-capability-deep-dives) | In existing capability navigation review send 5, then 1, then 5,1 and compare verbatim selected top-level references/order; compare an unrelated task's numeric reply. Read all deep-dive examples for supported/permission/configuration/external/unproven limits and no internal maintainer navigation; follow Getting Started's first-session sequence without running the examples' protected operations. | 5 then 1 yields terminals then SDD, 5,1 keeps that top-level order, and unrelated numeric replies stay task-scoped. Selected deep dives have concrete supported examples and relevant boundaries without internal maintainer navigation; Getting Started leads with the broad tour. |
| [REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility) | Read the owned pi-web-access and librarian skills and existing both-mode inventories. Locate source_check claim verification, bounded offset/limit stored-content retrieval and retained Codeflare-owned librarian after upstream removal; do not require a live search or new retrieval service for this guidance contract. | Owned guidance names source_check and bounded offset/limit retrieval; Codeflare-owned librarian remains delivered in both Pi modes after upstream retirement. |
| [REQ-AGENT-157](../../sdd/spec/agents.md#req-agent-157-managed-local-check-delivery-policy) | Inspect existing safe-check guard receipts for direct managed Pi/Claude wrappers, one leading cd-and wrapper and rejected composition/redirection; compare direct analyzer/syntax blocking and preserved user-only bypass. Read both-mode wrapper/skill inventories and generated Claude (<400 chars) and Pi ambient policies, lazy operational guidance and explicit invocation visibility without running any check now. | Only direct managed wrappers or one leading cd-and are admitted; composition/redirection and direct analyzers remain blocked without consuming the user bypass. Both modes deliver one wrapper/skill and full lazy guidance; Pi explicit invocation has no duplicate catalog injection. |

### Seed projection inspection

Compare already-existing canonical and compiled inventories; do not generate, install, release or reseed merely to review policy. Static byte/mode/include comparisons are legitimate manual delivery-contract checks. Where actual discovery, cleanup or hook behavior is claimed, require the separately authorized runtime observation named in the case.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) | Compare default/advanced compiled inventories and R2 sync filters, including Vault and retired .memory; inspect advanced hooks under direct/context-mode tool names. In separately authorized fresh Pi contexts with /ctx off/on, repeat one small read-only task and retain actual tool/results, not merely delivery inventories. | Advanced content is a strict superset; Vault persistence is advanced-only and legacy .memory is not written. Direct/context hook observations agree. Pi remains functional with context-mode disabled, using native tool names and supported graph tools. |
| [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) | Join compiled default/advanced inventories to canonical manifests and declared includes. Compare each key's sole owner/expanded bytes, supported-agent lanes and shared operational sections. Require an unlisted repository-only file to remain absent. Duplicate keys, unexplained byte drift or missing lanes fail; never regenerate output during preparation. | Each declared Pi key has one generated owner with correct expanded bytes/modes; unlisted files are absent, every supported agent lane exists and non-Claude shared gates survive transformation. |
| [REQ-AGENT-007](../../sdd/spec/agents.md#req-agent-007-multi-agent-adaptation-pipeline) | Compare both mode inventories for Codex, Copilot, OpenCode, Antigravity and Pi with their canonical owner sources; inspect transformed tool names and config paths, monolithic versus Pi grouped output, and occurrence counts for each manifest-declared Pi target after includes and native visibility normalization. | Every non-Claude mode has the correct instruction shape/tool names; Pi is compact plus grouped skills, and every declared Pi key occurs once with owner-equivalent normalized bytes. |
| [REQ-AGENT-014](../../sdd/spec/agents.md#req-agent-014-manifest-driven-preseed-pipeline) | Compare canonical manifest type/mode entries with existing compiled payload keys; check unlisted paths are absent, per-mode storage keys are unique and variant-per-mode keys remain desired across a mode comparison. Read the cleanup exclusion and runtime payload-consumption evidence; a static inventory cannot establish actual user-bucket cleanup. | One typed/mode-bearing manifest governs emitted keys; keys are unique within each mode and variant-per-mode desired keys are excluded from cleanup. Unlisted files are absent; the consumed payload matches the manifest. |
| [REQ-AGENT-100](../../sdd/spec/agents.md#req-agent-100-pi-rule-transform-membership-validation) | Compare canonical Pi transform collections with Claude rules. Read an existing invalid-membership compilation receipt naming the nonexistent rule and containing collection, with no successful seed. Without that negative receipt, retain the executable case as unverified; do not edit manifests or add a test project. | Every Pi transform member resolves to a Claude rule; an unknown member stops generation and names both the missing rule and its collection. |
| [REQ-AGENT-205](../../sdd/spec/agents.md#req-agent-205-graphify-build-skill-delivery) | Inspect advanced generated skill inventories for Claude, Codex, Copilot, OpenCode and Antigravity and open the delivered Graphify first-build recipe for the over-2000-file path. Compare its ignore entries and graph merge attribute instructions with the documented durable graph/report versus regenerable intermediates. This is guidance/delivery review, not a build. | Advanced adapted Graphify skill delivery includes the over-2000-file safe path, regenerable-output ignores and semantic-merge attribute rule without blanket-ignoring durable graph artifacts. |
| [REQ-AGENT-030](../../sdd/spec/agents.md#req-agent-030-multi-agent-format-transforms) | Read existing generated agent definitions for each supported target and mode; validate frontmatter tool shape, independent-model-field omission, agent-specific paths/extensions and Pi prompt/context/skill/extension/background inheritance metadata against the target's documented schema. Compare with canonical source rather than demanding identical cross-runtime bytes. | Each target uses supported frontmatter/tool schema, independent model selection, native paths/extensions and Pi-compatible inheritance/background defaults; unsupported Claude-only metadata does not leak into projections. |
| [REQ-AGENT-196](../../sdd/spec/agents.md#req-agent-196-repository-led-technology-guidance) | Inspect existing source manifests and generated skill catalogs for the nine retired generic skills and generic language rule trees/groupings; compare the remaining focused owner routes. Review a technology recommendation against supplied repository dependencies/configuration/spec/tests/docs/instructions, not model-memory defaults. Do not introduce prose snapshots or new inventory tests. | Retired generic skills/language rule trees and Pi language groups are absent. Repository evidence/instructions govern technology choice while focused product/design/tutorial/Humanize/delivery owners remain available under their activation boundaries. |
| [REQ-AGENT-197](../../sdd/spec/agents.md#req-agent-197-ambient-instruction-ownership-and-economy) | Read both generated Pi SYSTEM.md surfaces and their bootstrap source; map detailed Git/review/CI/Graphify/Todo/check/design/platform/memory/enforcement instructions to their existing lazy owners. Report duplicate ambient mechanics or a removed owner, not a shorter context as automatic success. | Both Pi modes deliver bootstrap-only SYSTEM guidance; detailed mechanics remain with existing lazy owners rather than duplicated ambiently or deleted to save context. |
| [REQ-AGENT-075](../../sdd/spec/agents.md#req-agent-075-cloudflare-platform-skills-bundled-into-the-advanced-seed) | Inspect advanced versus default compiled Cloudflare skill/build-command inventories and sandbox stable/next/migration routes. Open cloudflare mega-skill delivery and retrieval-first rule; verify excluded references tree/remote MCP, no dangling references frontmatter and retained Apache-2.0 license. Inspect manifests, not runtime infrastructure or a new sandbox SDK project. | Only advanced skill-capable projections include the thirteen platform skills/two build commands, distinct Sandbox stable/next/migration routes, slim Cloudflare tree, retrieval-first scoped Workers rule and Apache license. No ambiguous sandbox-sdk or bundled remote MCP/references tree survives. |
| [REQ-AGENT-190](../../sdd/spec/agents.md#req-agent-190-portable-capability-discovery-delivery) | Inspect both-mode supported skill-runtime inventories for capability router/references and compare managed versus baked fallback bytes/membership. Review Pi broad tour/numbered follow-up versus a repository-scoped capability question and its actual reference reads; no tool-discovery failure or generic tour should replace task-scoped work. | Both modes deliver matching managed/fallback capability membership/files to supported skill runtimes; Pi broad/numbered navigation uses that tour while repository-scoped questions stay contextual, not discovery errors or generic overview substitutions. |
| [REQ-AGENT-084](../../sdd/spec/agents.md#req-agent-084-reviewer-policy-contract) | Compare existing generated code/spec/doc reviewer documents with their separately seeded canonical policies after include expansion: almost-always policy must be embedded, genuinely conditional policy must ride an existing evidence wave, and unsupported skill-access frontmatter must be absent. Exact policy equality is the declared delivery contract, not a new prose snapshot test. | Every reviewer has identical separately seeded canonical policy, with almost-always material embedded and conditional policy in an existing wave; unsupported skill-access declarations are absent. |
| [REQ-AGENT-095](../../sdd/spec/agents.md#req-agent-095-compact-pi-skill-catalog) | Inspect both existing Pi projections and supported other-agent outputs: grouped path-scoped rules, proactive discovery paths, at-most-80-character owned descriptions, preserved trigger meaning, hidden command/event/reviewer metadata, unchanged upstream metadata and original eligibility invocation policy. Review representative proactive discovery transcripts where actual activation is claimed. | Pi grouping leaves other outputs unchanged; owned compact descriptions fit 80 characters and retain proactive triggers/real reads. Restricted workflows stay hidden, upstream metadata is unchanged and each mode retains original invocation eligibility. |

### Review packet and ownership acceptance

Implementation ownership for [REQ-AGENT-050](../../sdd/spec/agents.md#req-agent-050-pi-native-review-workflow-skill): Claude's `commands/review.md` supplies the user-invoked workflow; Pi delivers `skills/review/SKILL.md` through its advanced-mode manifest. This dedicated workflow is distinct from `git-review-pipeline` boundary enforcement. Its missing-input check uses the project's `sdd/` and `documentation/` directories; either absent yields the documentation lane's stable no-op report.

The native debug/deploy/brainstorm commands carry adapted workflow text directly rather than loading `SKILL.md`, because no corresponding Pi skill file exists ([REQ-AGENT-051](../../sdd/spec/agents.md#req-agent-051-pi-debug-deploy-and-brainstorm-commands)). Defer/ignore/debt dispositions use the existing `sdd/.review-decisions.md` history, not another tracker ([REQ-AGENT-088](../../sdd/spec/agents.md#req-agent-088-user-invoked-review-ownership-and-triage)).

Read existing completed report/packet/launch evidence first. For an explicitly authorized later workflow observation use an existing disposable repository and supported review entrypoint; do not launch reviewers manually, synthesize a boundary plan, create a PR or push to cause a boundary. Preserve exact-head ancestry, incremental scope, report-only lanes, root-only triage/fixes and explicit approval. Missing historical evidence remains unverified, not a reason to reconstruct it with new infrastructure.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review) | In a separately authorized disposable fixture, use /review --diff --deep. Inspect six-role parallelism, complete reports, deduplication, architecture-decision filtering and sequential Reality Filter. Compare recorded met-/unknown-trigger deferrals; verify unchanged subagent worktrees and root-only artifacts. External HIGH/CRITICAL verification requires explicit request, never this preparation. | One six-specialist parallel wave yields deduplicated, architecture-filtered findings followed by sequential Reality Filter. Met revisit evidence reopens evaluation; unknown evidence is not invented. Children report without writes; external verification is optional and user-gated. |
| [REQ-AGENT-044](../../sdd/spec/agents.md#req-agent-044-review-agent-discipline-enforcement) | Read canonical code/spec/doc reviewer policies and reports for lying test names, contradictory resolved anchors, stale docs and load-bearing trims. Compare cross-runtime semantic findings and preservation/deferral. Require root-only accepted fixes and both structural/quality passes. Keyword overlap or ID presence is not behavioral proof. | Reports distinguish structural and substantive quality failures, including contradictory resolved anchors and lying test names. Load-bearing trim content survives or is deferred; categories share canonical policy across runtimes and reviewers remain report-only. |
| [REQ-AGENT-050](../../sdd/spec/agents.md#req-agent-050-pi-native-review-workflow-skill) | In a separately authorized Pi review fixture from its workspace parent, exercise /review with no flags, --diff and --all, then the existing --deep/--verify-high options only when explicitly requested. Inspect absolute repo scoping, six-role workflow/report-only ownership, help no-op, absent-docs stable no-op and no git-review-pipeline/build/test/lint execution. Compare advanced-only delivery inventory. | Native Pi review is distinct from PR enforcement, obeys --all/--diff and no-flag help/no-op, supports explicitly requested deep/external review, uses native primitives and advanced-only delivery. No build/test/lint runs; absent docs produce the stable no-op report. |
| [REQ-AGENT-232](../../sdd/spec/agents.md#req-agent-232-executable-review-and-sdd-work-sets) | Inspect existing approved packet-builder results for valid diff ancestry, invalid ancestry and all scope; map each returned patch to its lane and changed hunk, and compare all scope with the tracked lane tree with no diff patch. Do not broaden an incremental review or launch a lane to manufacture evidence. | Diff packets validate ancestry and contain only lane-owned changed hunks; all-scope packets enumerate the tracked lane tree without a diff patch. |
| [REQ-AGENT-063](../../sdd/spec/agents.md#req-agent-063-pr-boundary-candidate-detection) | Inspect candidate-classifier evidence for executable Git/GitHub shell segments versus quoted strings and heredoc examples; compare segment/repository pairing and ensure inert text triggers no boundary work. Use existing command-classification fixtures, not live pushes or PR creation. | Executable shell segments are candidates; quoted examples and heredoc bodies remain inert rather than causing review work. |
| [REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy) | Read the existing CI-monitor policy and already-completed native monitor receipts for routine non-boundary push, eligible boundary, user request and fresh deploy/merge gate. Verify one attached background owner, repo/PR/exact-head identity, stable nonempty two-poll fingerprint, all failed/cancelled terminal rows and unavailable-gh timeout, not a foreground watcher or run cancellation. | Routine non-boundary pushes do not start monitoring. Eligible triggers have one background monitor and one exact repo/PR/head terminal result after a stable nonempty two-poll fingerprint; failed/cancelled rows return together and unavailable/nonzero-gh access yields timeout. |
| [REQ-AGENT-083](../../sdd/spec/agents.md#req-agent-083-user-invoked-pi-review-repository-context) | From an approved Pi workspace parent outside Git, select an existing remembered repository whose path contains spaces; request /review --diff and inspect its absolute root and unchanged process cwd. The separately authorized review must remain report-only, not a branch switch or new worktree. | Outside Git, remembered-space-containing repository selection produces the correct absolute /review root without changing process cwd. |
| [REQ-AGENT-109](../../sdd/spec/agents.md#req-agent-109-reviewer-evidence-absence-contract) | Inspect an existing failed-resolver packet for a named reason in the evidence block and read self-packet reviewer instructions for their missing-block response. For any executable failure not already observed, retain the missing receipt as unverified rather than deleting the block, simulating a successful resolver or making a new runner. | Failed resolution leaves a reason-bearing evidence block, not silent omission; every self-packet reviewer has an explicit missing-block response. |
| [REQ-AGENT-107](../../sdd/spec/agents.md#req-agent-107-deterministic-round-limit-gate) | Review the shipped round-limit gate and existing counted-history receipts at five or more commits, with and without the direct-user fully-autonomous marker, plus an unreadable-history failure. Compare total/decision fields with each reviewer's actual report; inspect clean's inert-without-gate route. No gate or reviewer is launched now and no history is fabricated. | At counted total >=5 only the direct-user autonomous marker changes stop to continue; unreadable history exits nonzero with diagnostic and no verdict. Reviewers use/report gate count and decision; user-invoked clean reports inert without invoking the gate. |
| [REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport) | Compare generated Pi reviewer tool manifests for Bash-only direct evidence and no indexed/context tools; inspect existing Bash and foreground packet results for one cross-lane named-block change, old/new hunk ranges and range-intersection-only invalidation. Compare full work sets, not just paths; no reviewer launch is authorized. | Reviewer manifests allow Bash direct evidence and no indexed/context tools. Old/new ranges accompany cross-lane changes; only intersecting symbol/test ranges invalidate anchors. Foreground and Bash packets have equal work sets, not merely equal paths. |
| [REQ-AGENT-086](../../sdd/spec/agents.md#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff) | Inspect Claude reviewer frontmatter/embedded policy and transformed metadata: direct-shell-only/report-only ownership and canonical Claude-only effort-key removal. Review an authorized completed boundary transcript for one packet per lane, no reviewer writes, root-persisted triage and root-accepted fixes. Never set launch models/effort or trigger a boundary here. | Claude lanes expose only direct shell, embedded policy and report-only read-only mode. Boundary reports are structured; root alone persists triage/evaluates/applies fixes. Claude effort contract remains in Claude only; each lane reasons from one supplied/built packet, not global searches. |
| [REQ-AGENT-103](../../sdd/spec/agents.md#req-agent-103-deterministic-lane-triage) | Inspect existing lane runner pre-start packet/triage output against reviewer prose for bulk-operation and round-limit gates; compare a config omitting enforce_tdd with its default-on decision. Observe precomputed handoff before subprocess start from receipts, not merely the presence of a helper function. | Deterministic triage exists before the subprocess, matches bulk/round gates and reaches the reviewer; absent enforce_tdd resolves on rather than opting out. |
| [REQ-AGENT-105](../../sdd/spec/agents.md#req-agent-105-review-lane-turn-economy) | Read one completed reviewer transcript alongside its known outstanding evidence questions; count whether each evidence wave batches all then-known questions and whether a conditional policy read rides that same wave. Compare embedded always-needed policy in generated reviewer documents. Do not impose a new turn cap or launch a reviewer. | Each evidence wave batches all then-known questions, conditional policy retrieval rides an already-needed wave and almost-always policy is embedded. No extra turn cap is inferred. |
| [REQ-AGENT-087](../../sdd/spec/agents.md#req-agent-087-pi-reviewer-execution-profile) | Inspect existing launch metadata/terminal records for each Pi code/spec/doc PR reviewer and its provider-neutral effective thinking contract; selected provider must remain inherited/unpinned. This is evidence review only, not authorization to choose or override any model/reasoning setting. | All three existing Pi reviewer launches show the canonical provider-neutral effective thinking contract without a pinned provider; evidence review does not change launch settings. |
| [REQ-AGENT-088](../../sdd/spec/agents.md#req-agent-088-user-invoked-review-ownership-and-triage) | Review a separately authorized /review --diff --deep receipt with multiple findings: inspect report-only children, root retention, exactly one triage decision per finding, approval-before-fix and defer/ignore/debt persistence. Compare known, applicable-but-unknown and irrelevant debt metadata through history/approved issue bodies without inventing thresholds or a second tracker. | Children are report-only; root retains reports and exactly one disposition per finding, fixes only after approval and persists defer/ignore/debt history. Supplied debt metadata survives; applicable unknowns remain unknown and irrelevant fields disappear without a parallel tracker. |

### Graphify workflow acceptance

Reuse Graphify Toolchain, post-clone triage, Build model choice and Git persistence, plus the existing Claude recipes/Pi choice and validation steps. Review already-existing outputs first. Every clone, build, refresh, semantic dispatch, labeling, merge or push needs separate scope and authorization. Do not rebuild the project graph for this procedure. Inspect output files and actual CLI status, not tool names alone; never infer a directed path from an undirected neighborhood.


Existing executable owners: Claude Graphify [Quick Reference recipes](../../preseed/agents/claude/skills/graphify/SKILL.md#quick-reference), Pi [Mandatory graph refresh choice](../../preseed/agents/pi/skills/graphify/SKILL.md#mandatory-graph-refresh-choice), [Validation checklist](../../preseed/agents/pi/skills/graphify/SKILL.md#validation-checklist) and [Global merge and Git persistence](../../preseed/agents/pi/skills/graphify/SKILL.md#global-merge-and-git-persistence). These do not waive consent.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) | Inspect both-mode Claude MCP/Pi native inventories. In separately authorized graphless/existing-graph contexts, query natively and inspect path attribution/rebinding. For authorized Full extraction, compare dispatched uncached paths with cache writes; preserve an out-of-scope attributed file's complete cache. Inventories alone prove neither runtime rebinding nor extraction safety. | Both modes expose the appropriate Claude/Pi query surface; graphless startup tolerates absence and later binds the active graph. Advanced build context remains bounded through existing orchestration. Semantic cache writes stay inside the actually dispatched uncached file set. |
| [REQ-AGENT-127](../../sdd/spec/agents.md#req-agent-127-graph-publication-artifacts-and-optional-labels) | Inspect an existing authorized Graphify publication inventory with labels requested and one with labels declined; resolve graph, report, HTML/callflow and optional wiki outputs against the repository's persistence policy. Compare git-tracked versus ignored outputs; skipped labels must not be treated as a missing mandatory artifact. | Publication exposes the graph/report and policy-applicable views/wiki; labels appear only when requested and their absence does not block publication. Repository policy may omit regenerable HTML/callflow while retaining graph/report. |
| [REQ-AGENT-128](../../sdd/spec/agents.md#req-agent-128-graph-visualization-node-limits) | Review authorized AST/Architecture/semantic-merge/label-apply publication records with small explicit and absent visualization limits. Count emitted nodes and record effective settings. Inspect each owner's rejection receipts for zero, negative and fractional/noninteger values. Do not build or refresh graphs to supply these records. | Each publication path honors the configured visualization limit; absent setting resolves to 100000, and nonpositive/noninteger input rejects publication rather than silently using another limit. |
| [REQ-AGENT-025](../../sdd/spec/agents.md#req-agent-025-post-clone-graph-triage) | In approved disposable contexts, compare real git/gh clones, leading environment assignments, echoed/quoted examples, failures and already-cloned targets. Inspect Cloning-into shell-variable destination resolution, no-graph/fresh/stale/unknown choices, per-session idempotence and review-lane suppression. Choose no graph to observe nonmutation; semantic work requires post-detection actual-count consent and separate authorization. | Only real successful clone segments prompt, resolved destinations prefer tool output, and freshness controls the stated choices/STALE flag. Prompts are session/directory-idempotent and suppressed in review lanes; semantic dispatch waits for actual-count consent, not clone-time intent alone. |
| [REQ-AGENT-026](../../sdd/spec/agents.md#req-agent-026-knowledge-graph-persistence-via-git) | Inspect candidate-image global merge.graphify.driver configuration and existing authorized two-sided graph-merge evidence. Compare a push-authorized repository's committed graph/report with a no-push repository's working-tree-only outputs and verify the inherited clone graph. Do not push, merge, clone or generate graphs during preparation. | Packaged global semantic merge configuration is present in both modes; push-authorized clones inherit committed graph/report and concurrent changes merge without manual JSON resolution. No-push graph outputs remain local/ephemeral. |
| [REQ-AGENT-027](../../sdd/spec/agents.md#req-agent-027-context-mode-interoperability) | For an already-authorized disposable graph with context-mode enabled, inspect one graphify query and one graphify update receipt through the ordinary Bash surface, including real result/exit status and absence of a context-mode deny gate. Update requires separate graph-mutation consent; a routing-policy read is not an update pass. | The approved query/update CLI operations complete through ordinary Bash while context-mode is only a tool provider; no deny gate or routing whitelist blocks them. |
| [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) | Read Claude's Graphify recipe and Pi's Mandatory graph-refresh choice; inspect authorized code-only/mixed-corpus transcripts. Compare clone-time AST/no-graph suppression, Full-intent post-detection actual-count confirmation before dispatch, model inheritance, cached chunk/hyperedge preservation and absent Pi headless/provider-label instructions. Never launch semantic work or set a model here. | Claude/Pi menus match corpus/mode; clone AST/no-graph suppresses duplicate prompts and semantic intent still requires actual-count confirmation. Chunks/hyperedges survive cache-first merge. Runtime-specific extraction model policy is preserved without setting a model here; Pi instructions contain no headless/provider labeling route. |

### Consultation startup acceptance

Use the existing consult-llm user gate and model-selection procedure; inspect redacted configuration and already-authorized transcripts. Never print provider keys, run key-verification endpoints, export keys globally, run a literal leading bang, or replay an uncertain operation. Enterprise absence and unrelated MCP settings remain separate checks. Actual inference requires explicit current-user request; use managed transport, not raw-key HTTP.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-031](../../sdd/spec/agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity) | Inspect redacted Claude/Pi startup with provider-key, subscription-login, provider-less and Enterprise inputs. Compare scoped MCP environment names, leading-bang serialization, OpenAI subscription preference/API fallback and Gemini API use; preserve unrelated-server sentinel and compare other-agent inventories. Credential/backend operations require separately authorized disposable observations, never credential probes or replay. | Provider keys are scoped to Claude/Pi MCP children, literal bangs remain data, OpenAI prefers subscription with key fallback and Gemini uses its key. Other agents receive neither consultation skill nor server. Provider-less/Enterprise startup removes only owned stale entries and preserves unrelated configuration. |
| [REQ-AGENT-069](../../sdd/spec/agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring) | Compare redacted before/after Claude and Pi MCP startup configs containing an unrelated sentinel server: owned-entry replacement may change only the managed consultation entry and must preserve every unrelated server/setting. Inspect Pi's current mcp-adapter.json ownership path and Claude replacement separately; do not replay or execute consultation. | Pi and Claude owned-entry refresh preserves every unrelated MCP server and setting; Pi uses its native adapter config and Claude's replacement behavior is unchanged. |

### Herdr projection inspection

Inspect existing default/advanced compiled inventories for exactly one native Herdr skill. For actual topology/orchestration use the already-shipped Pi Herdr Gate, Fast UI operations, Agent orchestration and Avoid command discovery loops. This inspection authorizes no pane, process, helper or server operation.


Existing executable procedures: [Gate](../../preseed/agents/pi/skills/herdr/SKILL.md#gate), [Agent orchestration](../../preseed/agents/pi/skills/herdr/SKILL.md#agent-orchestration), [Fast UI operations](../../preseed/agents/pi/skills/herdr/SKILL.md#fast-ui-operations), and [Avoid command discovery loops](../../preseed/agents/pi/skills/herdr/SKILL.md#avoid-command-discovery-loops). Reuse their commands and refusals; do not copy or replace them.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-173](../../sdd/spec/agents.md#req-agent-173-pi-can-orchestrate-coding-agents-through-herdr) | In a separately authorized live pane, follow Herdr's Gate/Agent orchestration: inspect plain-terminal refusal, current-pane liveness, unique helper/new unfocused pane, bounded settled wait, task-specific steering evidence and unchanged reading focus. Compare both-mode single-skill delivery. Never launch a second process on the current Pi session file. | Both modes contain one Herdr skill. Plain-terminal gate fails without starting a server; live liveness precedes orchestration, helpers use unique names/new unfocused panes and bounded settled waits. Steering needs independent task evidence; reading results preserves focus. |

### Design guidance and routing review

Manually review managed guidance/projection and fresh-context instruction responses using the named briefs. Use existing design owners and focused references; no new UI, rendering stack, registry, package command, aesthetic test suite or scored prose snapshot is needed. Fresh-context agent use still requires authorization and the existing context; do not spawn agents or select a model for this review. Policy/proposal review does not prove rendered/device/accessibility/performance behavior. Preserve brief/incumbent/platform truth and report unavailable evidence explicitly.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-194](../../sdd/spec/agents.md#req-agent-194-evidence-bound-impeccable-policy) | Review isolated web and native audit outputs with incomplete and complete evidence; compare N/A dimensions and defined 20-point aggregate thresholds. Compare web WCAG target guidance versus explicitly stronger native/product targets; critique with/without PRODUCT.md and inspect browser-theme affordances and bounded-refinement framing without claiming rendered evidence. | Unavailable audit evidence yields N/A, not invented scores; fully evidenced ratings follow defined 20-point thresholds. Web WCAG and stronger platform targets remain distinguished; personas use product evidence and theming preserves native affordances. Specialist prestige never overrides the brief. |
| [REQ-AGENT-134](../../sdd/spec/agents.md#req-agent-134-managed-design-skill-suite) | Compare authoritative curation default/advanced manifests and existing compiled projections for the six design owners, agent-neutral bodies, canvas license/pinned provenance and absence of unsafe presets. Inspect Copilot's compact fallback and no skill directory. Review fresh-context web/mobile/desktop/static/polish/nonvisual requests for exactly one direction owner and smallest justified specialists; do not generate a UI. | Advanced-only six-owner suite projects neutral canonical guidance, retains canvas license/provenance without repository-only context and excludes unsafe presets. Each visual request selects one direction owner and minimal specialists; Copilot gets usable fallback rather than a skill directory. |
| [REQ-AGENT-135](../../sdd/spec/agents.md#req-agent-135-unsafe-design-preset-exclusion) | Inspect source manifests/router for the removed UI UX Pro Max corpus/generator/persistence paths; review web/mobile/desktop/static direction proposals against supplied brief/incumbent evidence and reject category-preset rationales. No preset execution or mutable package lookup is needed. | No removed preset corpus/generator/persistence route remains; proposed directions cite brief/product/incumbent evidence rather than category defaults. |
| [REQ-AGENT-136](../../sdd/spec/agents.md#req-agent-136-design-truth-precedence) | Review the managed router's conflict-resolution section with a contradictory specialist suggestion and an incumbent product lacking formal design docs. Inspect resulting bounded refinement for brief/platform/accessibility/incumbent precedence; justified fonts, palettes, containment and hierarchy must not be automatic failures. | Brief then behavior/accessibility/platform/incumbent authority outrank owner/evidence/specialist preference. Incumbency survives missing formal contract; sidecars/detectors do not automatically invalidate justified visual choices. |
| [REQ-AGENT-137](../../sdd/spec/agents.md#req-agent-137-design-skill-review-boundary) | Read both existing repository test inventories and relevant managed-content tests, separating generic compiler/ABI/path/signature/runtime boundaries from prohibited prose/aesthetic snapshots. Review isolated web/mobile/desktop/static/refinement/nonvisual prompts for owner, interview, product specificity, capability honesty and specialist boundaries. Do not run tests or create a new aesthetic scorer. | Content-neutral compiler/ABI/signature/path/runtime checks remain; no test pins managed wording/aesthetic quality/inventory prose. Manual prompt review covers owner/interview/specificity/honesty/specialist boundaries; runtime-state tests do not become prose scorers. |
| [REQ-AGENT-179](../../sdd/spec/agents.md#req-agent-179-portable-visual-design-routing) | Compare the minimal Pi design route with backend/data/prose/nonvisual requests and visual greenfield/redesign/polish/audit requests. Inspect loaded skill transcripts and mode/purpose/platform classification; poster/social crop must choose canvas, responsive/product web must choose one frontend owner, and nonvisual work must not load design. | Minimal conditional Pi route loads no methodology for nonvisual work; visual classification distinguishes mode/purpose/platform. Canvas selects canvas, responsive/product web selects one frontend owner and backend/data/prose/nonvisual work selects no design skill. |
| [REQ-AGENT-180](../../sdd/spec/agents.md#req-agent-180-portable-frontend-design-authority) | Use the existing frontend-design workflow on supplied incumbent non-React and greenfield briefs, with selected/delegated/unresolved direction variants and Persuade/Operate/Read/Experience purposes. Inspect evidence-first interview depth, one product-specific thesis, preservation limits, focused-reference triggers and truthful unavailable-rendering report; compare delivered reference inventories without demanding a new frontend project. | Product evidence informs appropriately sized interviews and one specific direction; incremental work respects incumbent limits. Focused references retain independent triggers and project to supported skill runtimes. Missing rendering is disclosed, never passed. |
| [REQ-AGENT-181](../../sdd/spec/agents.md#req-agent-181-design-specialist-compatibility) | Inspect generated skill indexes for sole frontend-design entry and no design-taste-frontend/unsafe-preset owner. Compare bounded finishing, thesis-changing redesign and explicit Impeccable new-work responses; inspect refreshed source projections for preserved explicit command body, evidence boundaries and no self-update grant. Request motion refinement only after a direction exists. | Only frontend-design owns frontend direction; removed aliases/presets stay absent. Implicit Impeccable use is bounded finishing, explicit new-work retains selected platform ownership; refreshed content preserves evidence/command/self-update limits. Motion follows selected direction. |
| [REQ-AGENT-182](../../sdd/spec/agents.md#req-agent-182-purpose-and-platform-design-routing) | Review one prompt for each purpose and delivery platform using the existing design classification; compare the same operational purpose on web, iOS, Android and cross-platform native. Inspect one owner, orthogonal specialists and delivered native/desktop references; hierarchy follows purpose while behavior/accessibility/lifecycle follows platform. | Purpose controls hierarchy/success criteria and platform controls behavior/accessibility/lifecycle. Native requests choose native-mobile, every request has at most one direction owner, specialists are orthogonal and native/desktop references project to supported runtimes. |
| [REQ-AGENT-183](../../sdd/spec/agents.md#req-agent-183-native-mobile-design-authority) | Review incumbent native-product flows for iOS/Android and a shared identity, using SwiftUI/Compose/React Native/Expo/Flutter as conditional choices. Walk navigation, gestures, safe areas, input/scaling/accessibility, adaptation, permissions, offline/deep links, interruptions/lifecycle/transitions/reduced motion in the proposal. Without device rendering, require explicit unverified device evidence rather than a runtime pass. | Native proposals reflect incumbent/product/device/accessibility evidence, specific product identity and iOS/Android divergence across the named lifecycle/input/permission/offline states. Frameworks are conditional, shared identity remains coherent and unavailable device/render evidence is explicit. |
| [REQ-AGENT-184](../../sdd/spec/agents.md#req-agent-184-operational-information-design) | Compare expert security-operations and occasional management briefs; inspect operating job questions before widgets, scan/density/scope/time/filter/drilldown/bulk/saved-view/persistence/audit decisions, and summary/table/chart/timeline/topology/text choices from actual questions. Walk unreliable permission-scoped states and phone prioritization, comparing delivered operational reference inventory. No dashboard build is required to review this guidance. | Operating job precedes widgets; hierarchy/density/scope/actions/time/data limits match expertise/frequency and actual questions. Applicable loading/partial/stale/empty/error/permission/degraded/optimistic/confirmed/destructive/recovery states are explicit; phone scope preserves the primary job. The focused reference is delivered. |
| [REQ-AGENT-185](../../sdd/spec/agents.md#req-agent-185-component-system-and-registry-boundaries) | Compare incumbent and greenfield component proposals for dialog/combobox/table/focus-trap/virtualized list; inspect incumbent-first decision order, proven accessible primitives and registry compatibility across framework/tokens/accessibility/runtime/license/maintenance/repo conventions. Pair shadcn and non-shadcn examples; no registry execution is authorized. | Incumbent behavior/accessibility/information/direction decide components; complex controls prefer proven accessible primitives. Registry admission is conditional on framework/tokens/runtime/license/maintenance/repo compatibility, not automatic shadcn adoption. |
| [REQ-AGENT-186](../../sdd/spec/agents.md#req-agent-186-conditional-complex-motion-delegation) | Review simple hover/disclosure, each qualifying complex-motion case and incumbent-animation examples through the existing complex-motion reference. Compare selected direction before motion refinement, justified GSAP lifecycle/cleanup/transform/responsive/reduced-motion guidance and a no-tool simple/static fallback. Inspect activation evidence, not an invented animation harness. | Simple motion stays CSS/incumbent; only qualifying complexity delegates. Motion preserves chosen direction, GSAP needs justified complexity and lifecycle/cleanup/responsive/reduced-motion guidance, and missing capability preserves usable simple/static behavior. |
| [REQ-AGENT-187](../../sdd/spec/agents.md#req-agent-187-design-routing-evaluation-matrix) | Use isolated matched prompts: expert-security/occasional-management dashboards, iOS/Android/shared-native identity, incumbent shadcn/non-shadcn, no-registry/no-MCP and hover/disclosure/scroll narratives. Compare density/hierarchy, platform behavior, component adoption and motion-specialist activation; inspect every tool transcript for absence of automatic external package commands. This is manual instruction evaluation, not new UI-matrix implementation. | Matched prompts differ materially where audience/platform warrants; cross-platform identity remains coherent, shadcn is not introduced into the incompatible pair, missing registry/MCP does not block completion and only complex motion activates justified choreography. No activation runs external package code automatically. |
| [REQ-AGENT-188](../../sdd/spec/agents.md#req-agent-188-external-design-dependency-safety) | Review an untrusted mutable registry/preset/skill proposal before adoption using external-dependencies; activate design/Impeccable without package execution and review the same component request with registry/MCP absent. Compare external-safety reference projections across supported skill runtimes and reject automatic latest/self-update execution or capability-dependent workflow blockage. | External content is inspected as untrusted before adoption, never executed merely to determine applicability; no latest/self-update permission appears. Missing registry/MCP does not block the owner workflow and safety guidance reaches skill-capable projections. |

### Pi prompt and exposure measurement review

Use the existing measure-pi-runtime-context.mjs, measure-seed-tokens.mjs, verify-pi-prompt.mjs, pi-prompt-contract.mjs and pi-prompt-rule-ledger.json procedures and receipts. These are existing local faux-provider/resource-loading methods, not authorization to materialize or run SDKs now. Separate registered schemas from controlled prompt and initially active tools. Do not alter limits, remove retained policy categories, move text into schemas to hide cost, or add an arbitrary tool-token threshold. Signed managed delivery and live provider acceptance remain separately owned.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-097](../../sdd/spec/agents.md#req-agent-097-bounded-pi-startup-context) | Use the existing materialized advanced release-seed measurement procedure and scripts/measure-pi-runtime-context.mjs for first-turn inputTokens; inspect its faux-provider receipt for below 10,000. Compare scripts/measure-seed-tokens.mjs receipts for both Pi modes below 6,500. Do not install, materialize a seed or measure a new runtime now. | Actual faux-provider first-turn inputTokens is below 10000 after advanced materialization; generated managed seed receipts are below 6500 in both modes. Neither measurement is live-provider inference evidence. |
| [REQ-AGENT-156](../../sdd/spec/agents.md#req-agent-156-bounded-lossless-pi-prompt) | Read prompt baseline/ownership fixtures and existing verify-pi-prompt receipts for isolated fallback/signed default/advanced loading. Compare components/retained destinations, <=14,000 controlled prompt characters, separate schema reporting and sole system/global/invocation ownership. Before publication, compare a separately recorded complete eligible checkpoint: bytes/modes/manifest additions/removals/retirements, image exclusions and protected CI. Do not publish here. | Baseline remains 32416 chars with named components; real fallback/signed both-mode loading is <=14000 controlled chars with schemas separate. Every baseline category has a retained owner/destination; one system/global/invocation owner survives and complete checkpoint bytes/modes/retirements/image exclusions/protected publication alignment are evidenced separately. |
| [REQ-AGENT-158](../../sdd/spec/agents.md#req-agent-158-bounded-initial-pi-tool-exposure) | Inspect existing real-runtime measurement and verify-pi-prompt receipts for registered versus initially active names and separately serialized schemas, including rejected invalid initial active set. Only read/bash/edit/write/capability may be initially active when registered; keep schema sizes diagnostic with no new fixed token threshold. Deployed both-mode behavior remains separate from faux-provider measurements. | Real diagnostics separate registered/initially-active names and schema bytes and reject an invalid initial set; schema size stays diagnostic. Fresh deployed Standard/Advanced observations establish initial bootstrap, additive requested activation and new-prompt reset independently of measurement/source receipts. |

### Memory manifest and prompt delivery acceptance

For [Memory](../../sdd/spec/memory.md), compare existing candidate default/advanced payloads, canonical manifests and installed inventories at the same revision. Missing artifacts make delivery observations unavailable. This is read-only: no rebuild, capture, counter change, credential operation or rescue is authorized. Source/projection review and actual runtime delivery are distinct results.

| Contract | Action and required outcome |
|---|---|
| REQ-MEM-006 AC2–4 | Compare complete mode key sets: advanced is a strict superset carrying memory/Vault machinery. Fresh default settings register none of it. Downgrade leftovers whose absent plugin files are skipped do not count as executing machinery. |
| REQ-MEM-008 pipeline | Join every memory-plugin manifest entry to source, generated Worker payload and installed target. Capture prompt, hook/prefilter scripts and capture subagent follow the same pipeline as architect/code-reviewer, with overridable Sonnet defaults. Unlisted source is not payload. |
| REQ-MEM-008 modes | Check every memory-plugin entry is advanced-only, settings merge owns hook registration, and non-Claude inventories contain no generic adaptation of the Claude memory plugin. |
| REQ-MEM-014 AC1–3 | Compare both full deployed Pi prompts with canonical files and trace actual `memory-vault.ts` loading. Both are advanced-only prompt-directory projections, not generated stubs. Retain fixed budgets, citation rescue, optional model selection, frozen inputs and root-owned public delivery/progress. |

### Turnstile bounded-request source review

For [REQ-AGENT-138](../../sdd/spec/agents.md), enumerate every request in delivered and canonical `turnstile-spin/scripts/{auth-probe,widget-create,validate}.sh`, including cleanup DELETE and siteverify. Each curl path needs `--connect-timeout 10 --max-time 30`. Trace parsed error code 10000 through HTTP 200, 400/422, 401/403 and unexpected-status paths: it must select `missing_scope` before success; unrelated validation errors must not be mislabeled. Record source branches, not tokens. This does not authorize auth probes, widget creation or cleanup; offline regressions remain separate evidence.

### Impeccable next-hand source review

For [REQ-AGENT-165](../../sdd/spec/agents.md), read the exact [pinned source](https://github.com/pbakaus/impeccable/blob/f29cd24fdecfa5612e35e34c1c868d4a3fca930c/crates/context/src/serve_question.rs). The retained image pin for this review is engine `0.1.18` / `f29cd24fdecfa5612e35e34c1c868d4a3fca930c` in [`image/impeccable-engine-4.8.0.json`](../../image/impeccable-engine-4.8.0.json). <!-- @impl: image/impeccable-engine-4.8.0.json::commit = "f29cd24fdecfa5612e35e34c1c868d4a3fca930c" --> Inspect its actual update, wait and page-claim bodies for source correspondence; this method supplies no execution receipt. Compare existing installed engine identities and image/patch records without installing or launching a server. Missing pin bytes or image correspondence is unavailable; source review is not native acceptance.

| Contract | Review action and required outcome |
|---|---|
| AC1/2 | Trace keyed update and pending-round consumption; distinguish source correspondence from native delivery evidence. See [full conditions](#impeccable-update-review-conditions). |
| AC3/4 | Compare wait-side suppression with the separate daemon watchdog; retain their distinct strict timing bounds. See [full conditions](#impeccable-wait-review-conditions). |
| AC5/6 | Trace delivery consumption and claim-state publication without live mutation; distinguish atomic state writes from the whole sequence. See [full conditions](#impeccable-claim-review-conditions). |

<a id="impeccable-update-review-conditions"></a>
**AC1/2 review conditions:** Trace `--update` (`serve_question.rs:1369–1419`): missing/empty options reject before hand/delivery writes; card/comps gates and same-key liveness precede recording a new hand and copying/touching that key’s `.next.json`. GET `/` then consumes the keyed pending round (`:1614–1635`). This is source correspondence, not proof that a delivery copy succeeded or a native session displayed it. Use existing update/wait interfaces as source entry points, not execution instructions.

<a id="impeccable-wait-review-conditions"></a>
**AC3/4 review conditions:** Read `NEXT_CLAIM_GRACE_MS = 10000` (`serve_question.rs:18`) and the wait branch (`:1288–1303`): delivery mtime or nonzero `claimedAt` suppresses page closure only when age is strictly less than 10,000 ms. At equality or outside, stale nonzero `lastBeat` older than 15,000 ms can produce PAGE CLOSED if no answer exists. The daemon watchdog separately exits only beyond its grace bound (`:1577–1592`); do not conflate its strict `>` with wait-side `<`.

<a id="impeccable-claim-review-conditions"></a>
**AC5/6 review conditions:** Follow keyed delivery consumption into page-claim state after the delivery file disappears: GET `/` loads the pending round, removes the file, records `last_claim_at`, then atomically writes `claimedAt` in state (`serve_question.rs:1614–1632`). The whole read/remove/claim sequence is not one atomic filesystem operation. Wait-side suppression uses claim age strictly below 10,000 ms (`:1288–1291`); equality and older claims cannot suppress page closure. No live timestamp or delivery-file mutation is permitted.

### Impeccable native acceptance

Use the installed image-pinned launcher and existing approved disposable assets/session only, following the current visualize/new-work commands. Preserve the requirement-linked [question source](https://github.com/pbakaus/impeccable/blob/f29cd24fdecfa5612e35e34c1c868d4a3fca930c/crates/context/src/serve_question.rs) and [raster source](https://github.com/pbakaus/impeccable/blob/f29cd24fdecfa5612e35e34c1c868d4a3fca930c/crates/context/src/embed_prompt.rs) pins for unchanged engine `0.1.18` as evidence scope, not an execution receipt or permission to update it. Upstream `walk` uses ordinary metadata; the image-owned [`scripts/patch-impeccable-engine.py`](../../scripts/patch-impeccable-engine.py) supplies the retained no-symlink boundary and configured wait idle-grace correction. <!-- @impl: scripts/patch-impeccable-engine.py::patch_engine --> The traversal at pinned `embed_prompt.rs:163–184` supports recursion, nested hidden/`node_modules` exclusions and PNG/JPG/JPEG/WebP selection; upstream metadata alone does not supply symlink refusal. Inspecting upstream recovery/scan bodies can establish citation correspondence only, not installed patched-engine acceptance. Missing exact-pin bodies leave their correspondence unverified; a matching manifest or URL alone is insufficient. Match the actual engine version to its existing image/impeccable-engine*.json pin; source inspection of another version is not installed-runtime proof. No image generation, engine installation, live question service, timestamp editing, no-replay exception or new UI harness is authorized.


Existing commands are `~/.claude/skills/impeccable/scripts/impeccable embed-prompt --scan <asset-dir...>` and `embed-prompt <image> --read` in [Visualize](../../preseed/agents/claude/skills/impeccable/reference/visualize.md), plus same-key `serve-question --update --key <key> --payload <file>` / `--wait --key <key>` in [New work](../../preseed/agents/claude/skills/impeccable/reference/new-work.md). Use only existing approved fixtures; no generation or question server is implied.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-164](../../sdd/spec/agents.md#req-agent-164-impeccable-raster-scan-traversal) | Read the exact linked pinned traversal body and compare its ordinary nested PNG/JPEG/WebP inclusion with hidden/dependency-directory exclusion. For runtime acceptance inspect the existing actual-engine scan fixture receipts, separate from extracted-source probes; use the existing patch/test methods for symlink refusal without creating a new raster test project. | The exact pinned traversal includes nested ordinary PNG/JPEG/WebP and excludes hidden/dependency directories; actual-engine receipts are distinct from source-probe results and do not weaken the no-symlink boundary. |
| [REQ-AGENT-166](../../sdd/spec/agents.md#req-agent-166-impeccable-raster-prompt-recovery) | Use an authorized disposable raster and existing embed-prompt read/scan workflow. Compare PNG/JPEG supported embedded metadata and adjacent full-filename.json prompt sidecars; inspect reported missing paths. Never generate images, install an engine or change pinned source. Missing native engine/fixture is blocked, not recoverable from prose. | Supported embedded PNG/JPEG metadata and valid adjacent full-filename.json prompt sidecars keep the corresponding raster out of missing-path output; actual scan observations are bound to the installed engine. |
| [REQ-AGENT-167](../../sdd/spec/agents.md#req-agent-167-impeccable-raster-scan-result-contract) | Run existing actual-engine scans on approved unannotated rasters and a nonexistent explicit target. Capture each missing path, SCAN totals and process status (3: missing; 1: invalid target). Do not conflate unreadable/non-raster errors or delete flagged assets to make the scan green. | Each unrecoverable raster is listed and any missing yields status3; nonexistent/invalid explicit target fails with status1. Unsupported/unreadable cases are not silently generalized and flagged assets are not deleted to achieve green. |

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



<a id="req-agent-210-preserved-clauses"></a>
The complete RPIV image compatibility and prewarm contract belongs to the [Pi package reference](../references/pi-packages.md#loading-and-warm-compatibility); REQ-AGENT-210 remains in Agents.

### REQ-AGENT-052 preserved clauses

- The local-build guard covers the package-manager build/test/lint/typecheck/dev verbs plus `pytest`, `vitest`, `go test`, `swift test`, `cargo test`, `tsc`, `eslint`, `oxlint`, `biome`, direct Node syntax checks, `prettier`, and `wrangler dev`.
- Staging a file named after a test runner is not execution.
- A chained or nested actual runner still blocks.

### REQ-AGENT-069 preserved clauses

- Pi reads `consult-llm` from `~/.pi/agent/mcp-adapter.json` through pi-mcp-adapter after explicit connection and exact registered-tool activation.

<a id="req-agent-217-preserved-clauses"></a>
The complete lossless MCP migration contract belongs to the [Pi package reference](../references/pi-packages.md#mcp-adapter-and-consult-llm); [REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration) is owned by Model Context Protocol.

## Related Documentation

- [Pi package reference](../references/pi-packages.md) — installed inventory, entrypoints, compatibility transforms and prewarm gates
- [Vault](vault.md#memory-capture-system) - Vault-based cross-session memory and the
  capture hook chain
- [Container](container.md#claude-code-integration) - Claude Code
  configuration
- [Container](container.md#pi-extension-npm-cache) - Pi extension npm
  warm-up
- [Storage & Sync](storage-and-sync.md) - R2 sync internals
- [Decisions](../decisions/README.md) - Architecture decisions
