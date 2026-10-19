# Pi package reference

**Audience:** Agent-environment contributors

**Owns:** installed package inventory, entrypoints, image-owned compatibility transforms, prewarm gates, and package-specific startup preparation. [Preseed](../lanes/preseed.md) owns manifests, modes, tool discovery, workflow delivery, and configuration assembly; [Container](../lanes/container.md#pi-extension-npm-cache) owns runtime cache placement and supervision. Package installation is not activation, authorization, or deployed acceptance.

## Source inventory

The authoritative inventory is [`preseed/agents/pi/package.json`](../../preseed/agents/pi/package.json), its committed lockfile, [`preseed/npm-tools/package.json`](../../preseed/npm-tools/package.json), Docker inputs, and startup assembly. The image uses `npm ci` and rejects runtime/prewarm Pi drift. This reference authorizes no dependency update.

| Package | Surface |
|---|---|
| `@earendil-works/pi-coding-agent` | Runtime/prewarm lockstep |
| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` | Matching development SDKs |
| `@gotgenes/pi-subagents` | Native background delivery and public service accessor |
| `@juicesharp/rpiv-advisor` | Explicit-current-user advisor workflow |
| `@juicesharp/rpiv-ask-user-question` | Questionnaire and stable notifier channel |
| `@juicesharp/rpiv-todo` | Session-scoped task state |
| `@narumitw/pi-goal` | Native Goal and exact-version continuation/review transform |
| `@narumitw/pi-plan-mode` | Native Plan and registered-tool policy transform |
| `pi-open-tui` | Native terminal header, footer, prompt editor and `/open-tui` settings |
| `pi-smart-compact` | Provider-neutral native-pressure compaction, without a competing footer or memory stack |
| `context-mode` | Enabled at container start; foreground-owned, with explicit `/ctx off` |
| `pi-evaluate` | User-invoked reporting skill, no tool or command |
| `pi-mcp-adapter` | Lazy managed MCP servers and lossless legacy migration |
| `pi-web-access` | Web retrieval and headless-safe default search workflow |

## Loading and warm compatibility

Image construction warms RPIV, Subagents, MCP Adapter, web-access, Evaluate, Open TUI, Smart Compact, Goal/Plan, and every local TypeScript extension through the exact installed path. Required JITI artifacts must exist. A second fresh Pi process must report cache hits without misses, including imported dependencies. JavaScript entrypoints use native import checks rather than nonexistent JITI artifacts. This is a transpilation-cache gate, not V8-cache evidence or a startup-latency guarantee for restored user content. Runtime updates invalidate only runtime-owned caches.

Every file scanned as a Pi extension exports a default factory; pure helpers retain a no-op default beside named exports. Package-presence checks cannot replace actual extension loading.

### Native terminal UI

[REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-local-statusline-footer) owns the native UI and session-status contract. Open TUI is exact-pinned and integrity-locked in the image's Pi extension inventory. Startup selects `{source: "npm:pi-open-tui@0.3.11", extensions: []}`: package auto-discovery is suppressed because managed `startup-header.ts` delegates the installed native entrypoint once. Open TUI owns header, footer and editor in both modes; the adapter gates terminal handlers and `/open-tui` to TUI contexts and bounds header/footer lines by real terminal column width. RPC, print and background execution do not acquire its settings overlay or project probes.

`local-statusline.ts` publishes only repository and branch through the native status area, without installing a competing footer or duplicating context, model or effort. Parent-workspace sessions retain remembered nested repositories and the guarded display-only sentinel. Other extensions keep their statuses and colors; native context/model rendering remains upstream-owned. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel -->

After home restore, entrypoint enforces the following `open-tui.json` preferences on every container startup, including existing workplaces ([REQ-AGENT-221](../../sdd/spec/agents.md#req-agent-221-pi-startup-presentation-preferences)). Unrelated root and nested fields survive. <!-- @impl: entrypoint.sh::configure_pi_open_tui -->

| Group | Enforced preferences |
|---|---|
| General | Enabled, English, thinking peek two lines, inline footer off |
| Appearance | ASCII icons, block cursor |
| Footer on | Session name, context bar, extension statuses |
| Footer off | CWD, hostname, Git branch/status/detached commit, runtime, tokens, cost, provider capitalization |
| Telemetry | Master disabled; subordinate TPS, TTFT, duration, token counts, stall details and cost switches on but inactive |

Entrypoint uses a private atomic replacement for safe configuration. Malformed, symlink or nonregular files stay unchanged and produce a content-free warning. The terminal adapter performs read-only validation before native activation and falls back to Pi's built-in UI on unsafe configuration without blocking execution. `/open-tui` remains the upstream settings UI; later container startups restore the enforced fields. <!-- @impl: preseed/agents/pi/extensions/startup-header.ts::validateConfig -->

The image explicitly warms `extensions/open-tui/index.ts` and verifies its path-correct cache. Source tests, image loading, a compatible curation compiler, signed publication and actual terminal activation are distinct gates; the older curation checkpoint cannot supply this new package.

The complete RPIV preparation contract remains [REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation):

- The image-installed Pi preseed RPIV extensions declare host TypeBox as a wildcard peer, preserving other package metadata.
- Actual image startup must load advisor, questionnaire and todo tools without host-dependency warnings or extension errors.
- Startup updates and npm repair reapply the peer correction to the Pi profile extension tree before PTY release.
- RPIV shadow-pin candidates update matching lock-backed manifests and must pass the patch and actual loading of the preseed extensions through both installed Pi SDKs before any branch push.
- Incompatible candidates fail the job without publication.

Pi includes native MCP, but deferred tool exposure is not lazy server allocation: enabled native servers connect eagerly. The adapter remains the managed MCP lifecycle owner. Managed startup must disable `builtin:mcp` with the documented `-builtin:mcp` extension entry while preserving unrelated extension selections; a first-session command warning is not proof of correct ownership. The coordinated upgrade's source startup, transform and authentic-adapter checks passed [PR Checks 39013450649](https://github.com/nikolanovoselec/codeflare/actions/runs/39013450649) at `bece2e3065f81ffd038f71dc255ef508eb0c6ea2`. Image construction, installed runtime behavior and deployed acceptance remain separate pending gates; package presence and source CI do not satisfy them.

## Context-mode and web access

Context-mode has image-owned ESM compatibility and update-probe suppression in both installed copies. Version mismatch, missing required bundles, or failed post-write shim/probe verification fails the image build. An already-absent update-probe URL is permitted; no self-update path is introduced. <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeInstallations --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeDirectory --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeBundle -->

The foreground extension loads the installed adapter without changing package lifecycle ownership. In-process children do not create competing bridges. Fresh startup restores enabled; `/ctx off` remains effective across Pi reloads until the next container startup. Every managed workflow retains native fallbacks. Licensing rationale remains [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install).

Web access retains `web_search`, `source_check`, `fetch_content`, and paged `get_search_content` offset/limit retrieval. Search uses Pi's model registry or zero-config Exa routing without a per-user API key. The [reviewed upstream changelog](https://github.com/nicobailon/pi-web-access/blob/7e6e2386dc9a31d5e2a448172060dd1339c604f7/CHANGELOG.md) specifies all-failed tool errors, structured results, Perplexity Search API snippets for ordinary search and isolated session/cache lifetimes. OpenAI search prefers the newest Luna model; the API-key default is `gpt-6-luna`. Paid Ceramic is explicit-only, excluded from `auto`/`all`.

Its declared native `dist/index.js` remains the image warm target; the standalone MCP CLI is not configured for Claude. Native import evidence is not a V8 cache-hit claim. Create-if-missing `~/.pi/web-search.json` defaults to `{"workflow":"auto-summary"}`; deliberate `summary-review` opt-in survives later boots. Codeflare supplies the retained `librarian` skill in both modes, not a duplicate upstream copy. Optional `web_enable` follows upstream `toolActivation`; an old resumed session may need a new session to acquire its recorded selection ([REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility)).

## Smart Compact

Smart Compact is exact-pinned and integrity-locked in the image inventory; its native `dist/index.js` is an explicit warm-verification target. Both Pi modes receive `00-smart-compact-config.ts`, which seeds the managed preset only when both `smartCompact` and the supported legacy `semanticCompact` alias are absent. Existing valid preference values, including empty or partial sections under either name, remain unchanged; without a package-registration migration, the settings bytes are also unchanged. User edits in `~/.pi/agent/settings.json` follow its existing R2 sync/restore path; startup does not reapply missing options. Malformed settings and occupied settings locks are left untouched.

The initial preset uses Auto mode, EESV, current-model routing, low summary thinking, four calls and a 120-second generation budget. Auto selects the package's existing modes and budgets; the Smart Compact package and retention planner are not patched. `autoTriggerStrategy: "native-hook"` replaces compaction only when Pi reaches its own pressure boundary; `minContextPercent: 0` adds no early trigger. The `272000` target does not rewrite provider model-window metadata or Pi's native reserve/recent settings. Manual runs retain approval, backups retain upstream secret scrubbing, and lost-detail monitoring stays on. The package footer, agent tools, additional memory and overlapping cleanup/navigation features default off. Codeflare's existing capture and post-compaction recall remain their owners ([REQ-AGENT-222](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults), [REQ-AGENT-223](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation)).

Restored settings can contain the earlier `./packages/pi-smart-compact-10.6.2` registration (or its absolute agent-directory equivalent) alongside the managed npm package. Container startup treats this known location as the same identity and retains only the required npm registration before Pi discovery. The curated config factory repairs the same duplicate only when an npm declaration already exists, preserving its filters and all package/memory files. Because factories run after path selection, that repair applies to the next discovery/reload, not the current load; it never forces another reload. Custom paths, similarly named packages and local-only installations remain untouched ([single-installation contract](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults), [safe migration contract](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation)).

A compatible image must exist before publishing a curation release requiring a new package. This registration-only repair uses the existing runtime ABI and can publish without a new image, but boot-time prevention requires the corrected image. Source CI and publication do not establish installed or deployed acceptance; see [managed curation ownership and runtime compatibility](../lanes/preseed.md#managed-curation-ownership).

## Goal and Plan transforms

Goal and Plan share upstream's session-scoped `workflow:mutex:v1`. Activation refuses competing ownership; ending a workflow releases it. Their active tool policy is owned by [Preseed](../lanes/preseed.md#session-modes), not by removing installed packages.

Before JITI warm-up, `scripts/patch-pi-goal-review-control.mjs` transforms the exact locked Goal package. It accepts published `dist/index.ts` or the already-transformed `src/index.ts` declaration on an idempotent rerun, then normalizes the sole Pi entrypoint to patched `src/index.ts`. Unreviewed versions, entrypoints, or layouts fail before writes. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory -->

The transform calculates the package manifest and all seven patched source files before writing, and admits only the reviewed layouts listed in the transform. The host suite verifies/extracts the exact registry archive and loads the transformed declared entrypoint. Version, declaration, anchor or layout drift leaves every file untouched. Weekly shadow-pin candidates run the same preflight before publication; later releases require source/integrity/anchor review. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration) -->

The same image-owned transform publishes concise Goal extension status: `goal - blocked`, `goal - paused`, or `goal - active 17h 33m`. Waiting and other retained states remain explicit; automatic-work and budget counters stay in `/goal`, not the footer. This changes presentation only, including for token-budget goals: execution limits, accumulated active-time accounting and continuation controls are unchanged. There is no supported Goal/Open TUI status-template preference; the repository-only Codeflare statusline and Open TUI footer remain their existing owners ([REQ-AGENT-111 AC7](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions)). Final image activation and rendered acceptance remain separate gates. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory -->

Goal's session-local control channel delegates pause/resume to its own command controller. Trusted review pause uses the non-aborting option: it cancels Goal continuation without aborting the independently queued review turn or background work. Manual pause retains normal current-turn abort ([REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility)). FIX resume suppresses a separate Goal continuation because the FIX follow-up owns the next turn; closure also suppresses it and schedules none. Neither enables Managed Run RPC, populates the input field, or turns command text into model input ([REQ-AGENT-114](../../sdd/spec/agents.md#req-agent-114-review-owned-goal-continuation)).

The transform adds `continuationLimits.minIntervalMs` to normal loading/saving. Upstream's unconfigured default remains zero; Codeflare startup authoritatively restores `180000`, adds missing `toolVisibility: "after-first-goal"` and `continuationLimits.automaticTurns: 10`, and preserves explicit unrelated limits, unknown fields, `rpc`, and existing visibility. Malformed files remain byte-identical. There is no settings-panel patch for these Codeflare-owned startup values. <!-- @impl: entrypoint.sh::PI_GOAL_STARTUP_CONFIG -->

A positive interval creates one timer. Every later settled boundary clears/re-arms it for the full interval. Pause, clear, replacement, prioritization and shutdown cancel through upstream cleanup. Expiry rechecks session generation, exact marker, Goal identity, workflow ownership, and idle/pending state. Busy state preserves pending intent for a later settled boundary ([REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy), [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing)).

Boundary pause ownership is recorded before awaiting the trusted bridge, so launch begins against settled Goal state. Unavailable ownership/control lets review proceed without pause. An exact persisted review-owned pause retains release ownership even when bridge response is missing or unsuccessful. Matching FIX acknowledgment requests resume; manual resume winning the race clears stale ownership without a false error. Closure and authorized rollback release their correlated ownership. CI or individual reviewer notifications never resume Goal. Missing control, replacement Goal and independent reactivation retain existing fail-open behavior ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-pause-ownership-across-pr-heads), [REQ-AGENT-113](../../sdd/spec/agents.md#req-agent-113-review-owned-goal-release), [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-non-disruptive-review-owned-goal-control)).

Plan's exact-version transform resolves helper availability and configured policy from registered tools rather than the small active bootstrap set. Source-layout/partial-patch drift fails before writes. Its declared `dist/index.ts` is loaded and JITI-verified. <!-- @impl: scripts/patch-pi-plan-mode-tool-policy.mjs::patchPiPlanModeDirectory --> Startup atomically replaces `pi-plan-mode.json`; the managed frozen policy excludes generic questions, arbitrary context execution, MCP, delegation, task mutation, and advisor. `/plan save` remains session-local; pathless export keeps upstream `PLAN.md`. No automatic plan-file writer is added. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

## MCP adapter and consult-llm

Pi reads `consult-llm` from `~/.pi/agent/mcp-adapter.json` through the pi-mcp-adapter `mcp` proxy. A leading `!` in Pi's generated provider-key environment value is doubled so it remains literal, not command-backed; Claude's value is unchanged. Recognizable owned entries regenerate from current inputs, while customized entries and unrelated settings survive. Managed consult-llm is lazy and requires a usable permitted provider; unsupported Enterprise/unavailable-provider startup removes its skill surface without disclosing credentials.

Lossless migration remains governed by [REQ-AGENT-217](../../sdd/spec/agents.md#req-agent-217-lossless-pi-mcp-adapter-migration):

- Filename migration alone preserves valid legacy-only bytes; startup also regenerates recognizable owned entries.
- Startup and managed Pi load/reload explicitly apply [REQ-BROWSER-009](../../sdd/spec/browser-run.md#req-browser-009-mcp-and-chrome-sdk-timeout-profile) timeout preparation, including AC6 inactivity on managed load. Active bytes may change; transformed custom originals remain archived byte-for-byte before replacement. Credentials, lifecycle, unrelated fields and external routing remain preserved.
- Valid active adapters take precedence; displaced or transformed unknown/custom originals, and malformed originals, remain recoverable outside active names.
- Passive archive collisions do not block recovery or overwrite existing data.
- Malformed regular files recover after archival; unsafe active paths and I/O errors fail closed.
- Only successful preparation excludes obsolete root `mcp.json` from subsequent baseline/bisync; other files still sync.

Initial restore still admits the legacy root for recovery. No bucket objects are deleted. Unchanged legacy-only migration needs no extra archive. Existing Pi processes adopt managed delivery at load or `/reload`, not merely when publication appears.

## User workflows and retirement

Advisor requires an explicit current-user request; startup guidance adds no autonomous route. RPIV Advisor provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. Its `advisor` tool and user-only `/advisor` command do not authorize assistant invocation.

The [Pi manifest](../../preseed/agents/pi/package.json) and [lockfile](../../preseed/agents/pi/package-lock.json) pin Evaluate's reviewed MIT package and integrity. Its extension registers the packaged skill directory on `resources_discover`; it ships no tool or command and runs only when the user invokes `/skill:evaluate`. The skill reads a [reespec](https://github.com/bnenu/reespec) brief and specs when `reespec/requests/` exists, otherwise a user-pasted contract, together with produced outputs. It returns per-capability satisfied/partial/unsatisfied/unclear verdicts and triage, deliberately excludes implementation intent, and reports gaps rather than fixing them. Codeflare applies no patch or fork. The image explicitly loads `extensions/evaluate.ts` and requires its path-correct JITI artifact ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions)). Lock-backed weekly shadow-pin discovery includes future releases.

Managed `@narumitw/pi-usage` and its `/usage` provider-quota workflow are retired. Startup removes only that exact npm identity from restored string/object package entries; credentials, history and unrelated packages remain untouched ([REQ-AGENT-209](../../sdd/spec/agents.md#req-agent-209-retired-pi-package-migration)). Only Usage's private nested TUI-kit is removed from the lock; Goal/Plan retain theirs. Open TUI's local token/context/cost display is not equivalent to subscription-quota reporting and does not change Codeflare billing or usage records.

Startup removes only explicit retired package identities from persisted settings, preserving unrelated user additions. Todo state stays session/transcript scoped; no global task database or retired AD100 source override returns. `goal_wait` remains execution-blocked even if another extension re-exposes it. Subagents' active-resume guard rejects queued/running mutation through the reviewed public accessor; settled/unknown records retain upstream behavior.

## Adjacent owners

- [Preseed](../lanes/preseed.md): modes, manifests, compiler and runtime delivery.
- [Container](../lanes/container.md#pi-extension-npm-cache): installed cache placement and supervision.
- [Vault & Memory](../lanes/vault.md#memory-capture-system): capture/retrieval/publication lifecycle.
- [Storage & Sync](../lanes/storage-and-sync.md#durable-seed-reconciliation): durable provenance, cleanup, verification and applied state.

Requirement statuses and verification qualifiers remain in Agents; this reference is source documentation, not installation, CI, publication, activation or deployed acceptance.
