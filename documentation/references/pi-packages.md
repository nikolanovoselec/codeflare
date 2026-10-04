# Pi package reference

**Audience:** Agent-environment contributors

**Owns:** installed package inventory, entrypoints, image-owned compatibility transforms, prewarm gates, and package-specific startup preparation. [Preseed](../lanes/preseed.md) owns manifests, modes, tool discovery, workflow delivery, and configuration assembly; [Container](../lanes/container.md#pi-extension-npm-cache) owns runtime cache placement and supervision. Package installation is not activation, authorization, or deployed acceptance.

## Source inventory

The authoritative inventory is [`preseed/agents/pi/package.json`](../../preseed/agents/pi/package.json), its committed lockfile, [`preseed/npm-tools/package.json`](../../preseed/npm-tools/package.json), Docker inputs, and startup assembly. The image uses `npm ci` and rejects runtime/prewarm Pi drift. This reference authorizes no dependency update.

| Package | Source pin | Surface |
|---|---|---|
| `@earendil-works/pi-coding-agent` | 0.99.1 | Runtime/prewarm lockstep |
| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` | 0.99.1 | Matching development SDKs |
| `@gotgenes/pi-subagents` | 21.8.1 | Native background delivery and public service accessor |
| `@juicesharp/rpiv-advisor` | 2.11.0 | Explicit-current-user advisor workflow |
| `@juicesharp/rpiv-ask-user-question` | 2.11.0 | Questionnaire and stable notifier channel |
| `@juicesharp/rpiv-todo` | 2.11.0 | Session-scoped task state |
| `@narumitw/pi-goal` | 0.54.8 | Native Goal and exact-version continuation/review transform |
| `@narumitw/pi-plan-mode` | 0.58.3 | Native Plan and registered-tool policy transform |
| `@narumitw/pi-usage` | 0.61.1 | `/usage`, declared `dist/index.ts` |
| `context-mode` | 1.0.169 | Installed, disabled at each container start; explicit foreground opt-in |
| `pi-evaluate` | 0.1.5 | User-invoked reporting skill, no tool or command |
| `pi-mcp-adapter` | 3.3.0 | Lazy managed MCP servers and lossless legacy migration |
| `pi-web-access` | 0.34.0 | Web retrieval and headless-safe default search workflow |

## Loading and warm compatibility

Image construction warms RPIV, Subagents, MCP Adapter, web-access, Evaluate, Usage, Goal/Plan, and every local TypeScript extension through the exact installed path. Required JITI artifacts must exist. A second fresh Pi process must report cache hits without misses, including imported dependencies. JavaScript entrypoints use native import checks rather than nonexistent JITI artifacts. This is a transpilation-cache gate, not V8-cache evidence or a startup-latency guarantee for restored user content. Runtime updates invalidate only runtime-owned caches.

Every file scanned as a Pi extension exports a default factory; pure helpers retain a no-op default beside named exports. Package-presence checks cannot replace actual extension loading.

The complete RPIV preparation contract remains [REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation):

- The image-installed Pi preseed RPIV extensions declare host TypeBox as a wildcard peer, preserving other package metadata.
- Actual image startup must load advisor, questionnaire and todo tools without host-dependency warnings or extension errors.
- Startup updates and npm repair reapply the peer correction to the Pi profile extension tree before PTY release.
- RPIV shadow-pin candidates update matching lock-backed manifests and must pass the patch and actual loading of the preseed extensions through both installed Pi SDKs before any branch push.
- Incompatible candidates fail the job without publication.

Pi 0.99.1's built-in `/mcp` may produce a replacement-command warning when the adapter replaces it. That is not a crash diagnosis, and it is distinct from a host-TypeBox dependency warning; it does not weaken the RPIV gate.

## Context-mode and web access

Context-mode has image-owned ESM compatibility and update-probe suppression in both installed copies. Version mismatch, missing required bundles, or failed post-write shim/probe verification fails the image build. An already-absent update-probe URL is permitted; no self-update path is introduced. <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeInstallations --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeDirectory --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeBundle -->

The foreground extension loads the installed adapter without changing package lifecycle ownership. In-process children do not create competing bridges. Fresh startup restores disabled even after earlier opt-in. Every managed workflow retains native fallbacks. Licensing rationale remains [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install).

Web access retains `web_search`, `source_check`, `fetch_content`, and paged `get_search_content` offset/limit retrieval. Search uses Pi's model registry or zero-config Exa routing without a per-user API key. Create-if-missing `~/.pi/web-search.json` defaults to `{"workflow":"auto-summary"}`; deliberate `summary-review` opt-in survives later boots. Codeflare supplies the retained `librarian` skill in both modes, not a duplicate upstream copy. Optional `web_enable` follows upstream `toolActivation`; an old resumed session may need a new session to acquire its recorded selection.

## Goal and Plan transforms

Goal and Plan share upstream's session-scoped `workflow:mutex:v1`. Activation refuses competing ownership; ending a workflow releases it. Their active tool policy is owned by [Preseed](../lanes/preseed.md#session-modes), not by removing installed packages.

Before JITI warm-up, `scripts/patch-pi-goal-review-control.mjs` transforms exact locked Goal 0.54.8. It accepts published `dist/index.ts` or the already-transformed `src/index.ts` declaration on an idempotent rerun, then normalizes the sole Pi entrypoint to patched `src/index.ts`. Unreviewed versions, entrypoints, or layouts fail before writes. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory -->

The transform calculates the package manifest and all seven patched source files before writing, and admits only reviewed 0.54.3, 0.54.4 and 0.54.8 layouts. The host suite verifies/extracts the exact registry archive and loads the transformed declared entrypoint. Version, declaration, anchor or layout drift leaves every file untouched. Weekly shadow-pin candidates run the same preflight before publication; later releases require source/integrity/anchor review. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration) -->

Goal's session-local control channel delegates pause/resume to its own command controller. Trusted review pause uses the non-aborting option: it cancels Goal continuation without aborting the independently queued review turn or background work. Manual pause retains normal current-turn abort ([REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility)). FIX resume suppresses a separate Goal continuation because the FIX follow-up owns the next turn; closure also suppresses it and schedules none. Neither enables Managed Run RPC, populates the input field, or turns command text into model input ([REQ-AGENT-114](../../sdd/spec/agents.md#req-agent-114-review-owned-goal-continuation)).

The transform adds `continuationLimits.minIntervalMs` to normal loading/saving. Upstream's unconfigured default remains zero; Codeflare startup authoritatively restores `180000`, adds missing `toolVisibility: "after-first-goal"` and `continuationLimits.automaticTurns: 10`, and preserves explicit unrelated limits, unknown fields, `rpc`, and existing visibility. Malformed files remain byte-identical. There is no settings-panel patch for these Codeflare-owned startup values. <!-- @impl: entrypoint.sh::PI_GOAL_STARTUP_CONFIG -->

A positive interval creates one timer. Every later settled boundary clears/re-arms it for the full interval. Pause, clear, replacement, prioritization and shutdown cancel through upstream cleanup. Expiry rechecks session generation, exact marker, Goal identity, workflow ownership, and idle/pending state. Busy state preserves pending intent for a later settled boundary ([REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy), [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing)).

Boundary pause ownership is recorded before awaiting the trusted bridge, so launch begins against settled Goal state. Unavailable ownership/control lets review proceed without pause. An exact persisted review-owned pause retains release ownership even when bridge response is missing or unsuccessful. Matching FIX acknowledgment requests resume; manual resume winning the race clears stale ownership without a false error. Closure and authorized rollback release their correlated ownership. CI or individual reviewer notifications never resume Goal. Missing control, replacement Goal and independent reactivation retain existing fail-open behavior ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-pause-ownership-across-pr-heads), [REQ-AGENT-113](../../sdd/spec/agents.md#req-agent-113-review-owned-goal-release), [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-non-disruptive-review-owned-goal-control)).

Plan 0.58.3's exact-version transform resolves helper availability and configured policy from registered tools rather than the small active bootstrap set. Source-layout/partial-patch drift fails before writes. Its declared `dist/index.ts` is loaded and JITI-verified. <!-- @impl: scripts/patch-pi-plan-mode-tool-policy.mjs::patchPiPlanModeDirectory --> Startup atomically replaces `pi-plan-mode.json`; the managed frozen policy excludes generic questions, arbitrary context execution, MCP, delegation, task mutation, and advisor. `/plan save` remains session-local; pathless export keeps upstream `PLAN.md`. No automatic plan-file writer is added. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

## MCP adapter and consult-llm

Pi reads `consult-llm` from `~/.pi/agent/mcp-adapter.json` through the pi-mcp-adapter `mcp` proxy. A leading `!` in Pi's generated provider-key environment value is doubled so it remains literal, not command-backed; Claude's value is unchanged. Recognizable owned entries regenerate from current inputs, while customized entries and unrelated settings survive. Managed consult-llm is lazy and requires a usable permitted provider; unsupported Enterprise/unavailable-provider startup removes its skill surface without disclosing credentials.

Lossless migration remains governed by [REQ-AGENT-217](../../sdd/spec/agents.md#req-agent-217-lossless-pi-mcp-adapter-migration):

- Pi load/reload migrates valid legacy-only configuration byte-for-byte; startup also regenerates recognizable owned entries.
- Valid active adapters take precedence; displaced or transformed unknown/custom originals, and malformed originals, remain recoverable outside active names.
- Passive archive collisions do not block recovery or overwrite existing data.
- Malformed regular files recover after archival; unsafe active paths and I/O errors fail closed.
- Only successful preparation excludes obsolete root `mcp.json` from subsequent baseline/bisync; other files still sync.

Initial restore still admits the legacy root for recovery. No bucket objects are deleted. Unchanged legacy-only migration needs no extra archive. Existing Pi processes adopt managed delivery at load or `/reload`, not merely when publication appears.

## User workflows and retirement

Advisor requires an explicit current-user request; startup guidance adds no autonomous route. RPIV Advisor 2.11.0 provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. Its `advisor` tool and user-only `/advisor` command do not authorize assistant invocation.

Evaluate 0.1.5 is exact-pinned from its reviewed [MIT npm tarball](https://registry.npmjs.org/pi-evaluate/-/pi-evaluate-0.1.5.tgz). Its extension registers the packaged skill directory on `resources_discover`; it ships no tool or command and runs only when the user invokes `/skill:evaluate`. The skill reads a [reespec](https://github.com/bnenu/reespec) brief and specs when `reespec/requests/` exists, otherwise a user-pasted contract, together with produced outputs. It returns per-capability satisfied/partial/unsatisfied/unclear verdicts and triage, deliberately excludes implementation intent, and reports gaps rather than fixing them. Codeflare applies no patch or fork. The image explicitly loads `extensions/evaluate.ts` and requires its path-correct JITI artifact ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions)). Lock-backed weekly shadow-pin discovery includes future releases.

Usage 0.61.1 is exact-pinned from its reviewed [MIT npm tarball](https://registry.npmjs.org/@narumitw/pi-usage/-/pi-usage-0.61.1.tgz); its package and `@narumitw/pi-tui-kit` dependency are integrity-locked. The earlier 0.59.0 review covered official Codex, GitHub Copilot, OpenRouter, OpenCode Go and Z.AI origin validation, bounded/redacted responses, and explicit confirmation before consuming a Codex reset. That historical review is not live acceptance of every provider path in the updated package. The image explicitly loads `dist/index.ts`, registered as `/usage`, and requires its path-correct JITI artifact ([REQ-AGENT-131](../../sdd/spec/agents.md#req-agent-131-native-usage-workflow-in-pi-sessions)). Lock-backed weekly shadow-pin discovery includes future releases.

Startup removes only explicit retired package identities from persisted settings, preserving unrelated user additions. Todo state stays session/transcript scoped; no global task database or retired AD100 source override returns. `goal_wait` remains execution-blocked even if another extension re-exposes it. Subagents' active-resume guard rejects queued/running mutation through the reviewed public accessor; settled/unknown records retain upstream behavior.

## Adjacent owners

- [Preseed](../lanes/preseed.md): modes, manifests, compiler and runtime delivery.
- [Container](../lanes/container.md#pi-extension-npm-cache): installed cache placement and supervision.
- [Vault & Memory](../lanes/vault.md#memory-capture-system): capture/retrieval/publication lifecycle.
- [Storage & Sync](../lanes/storage-and-sync.md#durable-seed-reconciliation): durable provenance, cleanup, verification and applied state.

Requirement statuses and verification qualifiers remain in Agents; this reference is source documentation, not installation, CI, publication, activation or deployed acceptance.
