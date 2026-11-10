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
| `@calesennett/pi-codex-fast` | Native Fast/Ultrafast controls for supported OpenAI models |
| `pi-open-tui` | Native terminal header, footer, prompt editor and `/open-tui` settings |
| `pi-smart-compact` | Provider-neutral native-pressure compaction, without a competing footer or memory stack |
| `context-mode` | Disabled at container start; foreground-owned after explicit `/ctx on` |
| `pi-evaluate` | User-invoked reporting skill, no tool or command |
| `pi-mcp-adapter` | Cached/deferred MCP discovery, idle cleanup and one managed connection owner |
| `pi-web-access` | Web retrieval and headless-safe default search workflow |

## Loading and warm compatibility

Image construction warms RPIV, Subagents, MCP Extension, web-access, Evaluate, Open TUI, Codex Fast, Smart Compact, Goal/Plan, and every local TypeScript extension through the exact installed path. Required JITI artifacts must exist. A second fresh Pi process must report cache hits without misses, including imported dependencies. JavaScript entrypoints use native import checks rather than nonexistent JITI artifacts. This is a transpilation-cache gate, not V8-cache evidence or a startup-latency guarantee for restored user content. Runtime updates invalidate only runtime-owned caches.

Every file scanned as a Pi extension exports a default factory; pure helpers retain a no-op default beside named exports. Package-presence checks cannot replace actual extension loading. Warming loads resources without requesting model completions. Extension-load errors in either warm-up process fail qualification even when Pi exits zero; genuine cache hits do not excuse a failed factory.

Changed restored or managed-release bytes safely invalidate old transpiles and can require first-load compilation. Fast Start Off deliberately isolates caches after runtime updates. Preserve authoritative restored content rather than overwriting it to obtain image-cache hits; these paths are not an unchanged-image startup-latency guarantee.

### Pi 1.5 and operator compatibility

Pi 1.5 retains JITI 2.7's path/content-sensitive cache rules; keep the fresh-process replay gate rather than infer reuse from artifact presence. Its extension loader supplies the upstream Pi-AI compatibility view, while ordinary package-root imports no longer export TypeBox. New extension schemas import `typebox` directly and follow Pi's JSON-Schema validation rules; TypeBox-only refinements/codecs are not validation guarantees. The image's gateway-label preparation accepts only its reviewed 1.5 source/bundle hashes and avoids repeating the label as a secondary name. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay -->

Interactive/runtime and prewarm Pi 1.5 are independent of the Worker and immutable App's Pi-AI 1.4 pins. Agents 0.30.1 requires `~1.4.0`; Flue 2.3.0 imports the root `Type` export removed in 1.5. Preserve both supported pins. Root owns OAuth resolution/refresh; the App receives only the protected token DTO. Direct OpenAI/ChatGPT compatibility still requires producer/consumer CI and fresh-owner acceptance, not blanket Codex/Copilot support or credential bridging.

### Native terminal UI

[REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-local-statusline-footer) owns the native UI and session-status contract. Open TUI is exact-pinned and integrity-locked in the image's Pi extension inventory. Startup selects `{source: "npm:pi-open-tui@0.3.13", extensions: []}`: package auto-discovery is suppressed because managed `startup-header.ts` delegates the installed native entrypoint once. Open TUI owns header, footer and editor in both modes; the adapter gates terminal handlers and `/open-tui` to TUI contexts and bounds header/footer lines by real terminal column width. RPC, print and background execution do not acquire its settings overlay or project probes.

`local-statusline.ts` publishes only repository and branch through the native status area, without installing a competing footer or duplicating context, model or effort. Parent-workspace sessions retain remembered nested repositories and the guarded display-only sentinel. Other extensions keep their statuses and colors; native context/model rendering remains upstream-owned. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel -->

After home restore, entrypoint enforces the following `open-tui.json` preferences on every container startup, including existing workplaces ([REQ-AGENT-221](../../sdd/spec/agents.md#req-agent-221-pi-startup-presentation-preferences)). Unrelated root and nested fields survive. <!-- @impl: entrypoint.sh::configure_pi_open_tui -->

| Group | Enforced preferences |
|---|---|
| General | Enabled, English, thinking peek two lines, inline footer off |
| Appearance | ASCII icons, block cursor |
| Footer on | Session name, context bar, extension statuses |
| Footer off | CWD, hostname, Git branch/status/detached commit, runtime, tokens, cost, live TPS, provider capitalization |
| Telemetry | Master disabled; subordinate TPS, TTFT, duration, token counts, stall details and cost switches on but inactive |

Open TUI 0.3.13's live-TPS footer segment is independent of the telemetry master; startup explicitly disables it to preserve the quiet presentation.

Entrypoint uses a private atomic replacement for safe configuration. Malformed, symlink or nonregular files stay unchanged and produce a content-free warning. The terminal adapter performs read-only validation before native activation and falls back to Pi's built-in UI on unsafe configuration without blocking execution. `/open-tui` remains the upstream settings UI; later container startups restore the enforced fields. <!-- @impl: preseed/agents/pi/extensions/startup-header.ts::validateConfig -->

The image explicitly warms `extensions/open-tui/index.ts` and verifies its path-correct cache. Source tests, image loading, a compatible curation compiler, signed publication and actual terminal activation are distinct gates; the older curation checkpoint cannot supply this new package.

The complete RPIV preparation contract remains [REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation):

- The image-installed Pi preseed RPIV extensions declare host TypeBox as a wildcard peer, preserving other package metadata.
- Actual image startup must load advisor, questionnaire and todo tools without host-dependency warnings or extension errors.
- Startup updates and npm repair reapply the peer correction to the Pi profile extension tree before PTY release.
- RPIV shadow-pin candidates update matching lock-backed manifests and must pass the patch and actual loading of the preseed extensions through both installed Pi SDKs before any branch push.
- Incompatible candidates fail the job without publication.

Pi includes native MCP, but deferred tool exposure is not lazy server allocation: enabled native servers connect eagerly. The replacement extension remains the managed MCP lifecycle owner. Managed startup must disable `builtin:mcp` with the documented `-builtin:mcp` extension entry while preserving unrelated extension selections; a first-session command warning is not proof of correct ownership. The retired adapter's [Git/CI history](https://github.com/nikolanovoselec/codeflare/actions/runs/39013450649) does not qualify the replacement MCP extension. Image construction, installed runtime behavior and deployed acceptance remain separate pending gates; package presence and source CI do not satisfy them.

## Fast and Ultrafast

The image exact-pins `@calesennett/pi-codex-fast`; startup registers it once before Pi discovery and preserves `pi-codex-fast.mode`, provider/model choices and authentication. Only the known recovery path `packages/pi-codex-fast-0.1.13` (relative or under the agent directory) converges to the managed npm registration; custom paths and package files remain untouched. The native `/codex-fast` and `/codex-ultrafast` commands opt into supported OpenAI request tiers without an SDK patch. Existing preferences survive; new profiles retain upstream Off. Provider entitlement and separately hosted Operator inference are outside this extension ([REQ-AGENT-224](../../sdd/spec/agents.md#req-agent-224-pi-fast-and-ultrafast-controls)).

Never install into the live `~/.pi/agent/npm` link. Dependency changes belong in the committed preseed manifest/lock and image build; publication of dependent curation follows a successful compatible deployment.

## Context-mode and web access

Context-mode has image-owned ESM compatibility and update-probe suppression in both installed copies. Version mismatch, missing required bundles, or failed post-write shim/probe verification fails the image build. An already-absent update-probe URL is permitted; no self-update path is introduced. <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeInstallations --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeDirectory --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeBundle -->

Context-mode 2.1.4 still embeds Zod 4.0.0 internally. This known residual risk is retained by explicit owner decision pending an upstream update; removing transitive Zod 3 lock records is not remediation of that bundled copy.

The foreground extension loads v2's installed `pi/index.js` in-process without changing package lifecycle ownership. In-process children do not initialize competing context-mode owners. Entrypoint preserves nonzero bridge idle overrides only during startup configuration; the foreground runtime clears inherited process-wide `CONTEXT_MODE_BRIDGE_IDLE_MS` before upstream initialization, retaining upstream managed root/subagent ownership and reaping rather than promising nonzero override preservation end to end. Startup-prefix evidence is not enabled-runtime evidence. Fresh startup defaults to disabled; `/ctx on` enables the managed runtime and tools across Pi reloads until the next container startup. Every managed workflow retains native fallbacks. Licensing rationale remains [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install). [REQ-AGENT-076 AC7](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) distinguishes startup configuration from enabled runtime.

Web access retains `web_search`, `source_check`, `fetch_content`, and paged `get_search_content` offset/limit retrieval. Search uses Pi's model registry or zero-config Exa routing without a per-user API key. The [reviewed upstream changelog](https://github.com/nicobailon/pi-web-access/blob/7e6e2386dc9a31d5e2a448172060dd1339c604f7/CHANGELOG.md) specifies all-failed tool errors, structured results, Perplexity Search API snippets for ordinary search and isolated session/cache lifetimes. OpenAI search prefers the newest Luna model; the API-key default is `gpt-6-luna`. Paid Ceramic is explicit-only, excluded from `auto`/`all`.

Its declared native `dist/index.js` remains the image warm target; the standalone MCP CLI is not configured for Claude. Native import evidence is not a V8 cache-hit claim. Create-if-missing `~/.pi/web-search.json` defaults to `{"workflow":"auto-summary"}`; deliberate `summary-review` opt-in survives later boots. Codeflare supplies the retained `librarian` skill in both modes, not a duplicate upstream copy. Optional `web_enable` follows upstream `toolActivation`; an old resumed session may need a new session to acquire its recorded selection ([REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility)).

Web Access 0.46 adds explicit-only Cloudflare/SearchApi/Tabstack search and opt-in hosted fetching. Hosted fetch requires provider-order inclusion and `fetchRouting.allowRemoteHostedProviders: true`; credentials alone do not authorize external URL disclosure or cost. Node fetch remains default; optional curl configuration never authorizes a private-URL or egress bypass. Provider summaries are not page quotations, and returned PDF text retains bounded stored-result paging.

## Smart Compact

Smart Compact is exact-pinned and integrity-locked in the image inventory; its native `dist/index.js` is an explicit warm-verification target. Both Pi modes receive `00-smart-compact-config.ts`, which seeds the managed preset only when both `smartCompact` and the supported legacy `semanticCompact` alias are absent. Existing valid preference values, including empty or partial sections under either name, remain unchanged; without a package-registration migration, the settings bytes are also unchanged. User edits in `~/.pi/agent/settings.json` follow its existing R2 sync/restore path; startup does not reapply missing options. Malformed settings and occupied settings locks are left untouched.

The initial preset uses Auto mode, EESV, current-model routing, low summary thinking, four calls and a 120-second generation budget. Auto selects the package's existing modes and budgets; the Smart Compact package and retention planner are not patched. `autoTriggerStrategy: "native-hook"` replaces compaction only when Pi reaches its own pressure boundary; `minContextPercent: 0` adds no early trigger. The `272000` target does not rewrite provider model-window metadata or Pi's native reserve/recent settings. Manual runs retain approval, backups retain upstream secret scrubbing, and lost-detail monitoring stays on. The package footer, agent tools, additional memory and overlapping cleanup/navigation features default off. Codeflare's existing capture and post-compaction recall remain their owners ([REQ-AGENT-222](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults), [REQ-AGENT-223](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation)).

Smart Compact 10.7.3 can allocate completion headroom above its target summary length and retry truncated synthesis once, within existing provider/model, call and run budgets. This is not a settings migration or proof of live provider quality.

Restored settings can contain the earlier `./packages/pi-smart-compact-10.6.2` registration (or its absolute agent-directory equivalent) alongside the managed npm package. Container startup treats this known location as the same identity and retains only the required npm registration before Pi discovery. The curated config factory repairs the same duplicate only when an npm declaration already exists, preserving its filters and all package/memory files. Because factories run after path selection, that repair applies to the next discovery/reload, not the current load; it never forces another reload. Custom paths, similarly named packages and local-only installations remain untouched ([single-installation contract](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults), [safe migration contract](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation)).

A compatible image must exist before publishing a curation release requiring a new package. This registration-only repair uses the existing runtime ABI and can publish without a new image, but boot-time prevention requires the corrected image. Source CI and publication do not establish installed or deployed acceptance; see [managed curation ownership and runtime compatibility](../lanes/preseed.md#managed-curation-ownership).

## Goal and Plan transforms

Goal and Plan share upstream's session-scoped `workflow:mutex:v1`. Activation refuses competing ownership; ending a workflow releases it. Their active tool policy is owned by [Preseed](../lanes/preseed.md#session-modes), not by removing installed packages.

Before JITI warm-up, `scripts/patch-pi-goal-review-control.mjs` transforms the exact locked Goal package. It accepts published `dist/index.ts` or the already-transformed `src/index.ts` declaration on an idempotent rerun, then normalizes the sole Pi entrypoint to patched `src/index.ts`. Unreviewed versions, entrypoints, or layouts fail before writes. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory -->

The transform calculates the package manifest and all seven patched source files before writing, and admits only the reviewed layouts listed in the transform. The host suite verifies/extracts exact registry archives or a digest-pinned immutable raw-source capture and loads the transformed declared entrypoint. The 0.54.13 capture records tagged commit `42738907182c43eb99e5134652fd37e7d06b5e3a`, reuses the verified 0.54.11 archive for unchanged files, and checks every source digest; it is not a fabricated registry tarball. Its queued Goal-contract publication and custom-startup ownership are retained.

The published `0.54.13` npm archive was separately streamed and verified against its registry SHA-512 integrity; all 23 published source files including `package.json` match the capture byte-for-byte. Compiled `dist` files were not compared. This proves published-source equivalence, not a passing CI run or installed activation. Version, declaration, anchor or layout drift leaves every file untouched. Weekly shadow-pin candidates run the same preflight before publication; later releases require source/integrity/anchor review. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration) -->

The same image-owned transform publishes concise Goal extension status: `goal - blocked`, `goal - paused`, or `goal - active 17h 33m`. Waiting and other retained states remain explicit; automatic-work and budget counters stay in `/goal`, not the footer. This changes presentation only, including for token-budget goals: execution limits, accumulated active-time accounting and continuation controls are unchanged. There is no supported Goal/Open TUI status-template preference; the repository-only Codeflare statusline and Open TUI footer remain their existing owners ([REQ-AGENT-111 AC7](../../sdd/spec/agents.md#req-agent-111-native-goal-workflow-in-pi-sessions)). Final image activation and rendered acceptance remain separate gates. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory -->

Goal's existing session-local control channel remains a separate compatibility capability that delegates pause/resume to Goal's own command controller. Its non-aborting pause option cancels Goal continuation without aborting other Pi work; manual pause retains normal current-turn abort ([REQ-AGENT-144](../../sdd/spec/agents.md#req-agent-144-review-owned-goal-pause-command-compatibility)). Explicit bridge-controlled resume can suppress a separate Goal continuation without enabling Managed Run RPC or populating user input. PR review does not invoke this channel: FIX delivery and closure neither pause nor resume Goal ([REQ-AGENT-114](../../sdd/spec/agents.md#req-agent-114-review-and-goal-continuation-separation)).

The transform adds `continuationLimits.minIntervalMs` to normal loading/saving. Upstream's unconfigured default remains zero; Codeflare startup authoritatively restores `300000`, adds missing `toolVisibility: "after-first-goal"` and `continuationLimits.automaticTurns: 10`, and preserves explicit unrelated limits, unknown fields, `rpc`, and existing visibility. Malformed files remain byte-identical. There is no settings-panel patch for these Codeflare-owned startup values. <!-- @impl: entrypoint.sh::PI_GOAL_STARTUP_CONFIG -->

A positive interval creates one timer. Every later settled boundary clears/re-arms it for the full interval. Pause, clear, replacement, prioritization and shutdown cancel through upstream cleanup. Expiry rechecks session generation, exact marker, Goal identity, workflow ownership, and idle/pending state. Busy state preserves pending intent for a later settled boundary ([REQ-AGENT-129](../../sdd/spec/agents.md#req-agent-129-goal-continuation-settings-policy), [REQ-AGENT-130](../../sdd/spec/agents.md#req-agent-130-goal-continuation-runtime-pacing)).

Review launch, completion and cleanup preserve Goal identity and state, including explicit user pauses. Review works without Goal installed, and session restoration ignores legacy review-owned pause records rather than resuming Goal. Reviewers, exact-head CI, triage, acknowledgement and FIX delivery retain their own gates ([REQ-AGENT-112](../../sdd/spec/agents.md#req-agent-112-goal-independent-pr-review), [REQ-AGENT-113](../../sdd/spec/agents.md#req-agent-113-goal-independent-review-completion), [REQ-AGENT-117](../../sdd/spec/agents.md#req-agent-117-goal-independent-review-restoration)).

Plan's exact-version transform resolves helper availability and configured policy from registered tools rather than the small active bootstrap set. Source-layout/partial-patch drift fails before writes. Its declared `dist/index.ts` is loaded and JITI-verified. <!-- @impl: scripts/patch-pi-plan-mode-tool-policy.mjs::patchPiPlanModeDirectory --> Startup atomically replaces `pi-plan-mode.json`; the managed frozen policy excludes generic questions, arbitrary context execution, MCP, delegation, task mutation, and advisor. `/plan save` remains session-local; pathless export keeps upstream `PLAN.md`. No automatic plan-file writer is added. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

<a id="mcp-extension-and-consult-llm"></a>
## MCP adapter and consult-llm

The Pi inventory restores exact-pinned `pi-mcp-adapter@5.3.1`, with `index.ts` as its warm target. Pi remains 1.5.0 and existing unrelated SDK/security overrides stay unchanged. Installed archive integrity and real-client behavior are qualified independently of manifest edits.

Startup removes the replaced stock npm registration and retains `-builtin:mcp`, leaving one managed lifecycle owner. Native `mcp-adapter.json` supports proxy discovery/execution and deferred direct tools. Managed portals use lazy ten-minute idle cleanup, public placeholder headers and `auth: false`; all real portal OAuth remains on Cloudflare. Active calls prevent idle closure, cached discovery survives it, and the next call reconnects. Deferred startup still permits a metadata-only discovery pass when the gateway runtime first initializes. External consultation remains explicitly user-gated.

`requestTimeoutMs: 360000` is the adapter's progress-resetting request timeout, not a fixed total deadline. Browser navigation can use 120000ms where supported; provider retention remains twenty minutes. Unmanaged local OAuth uses the adapter's own supported storage and is not a reason to import another client's grants.

Guarded native preparation preserves valid native definitions over proven generated duplicates and imports missing supported legacy servers. It archives exact originals before retiring the obsolete `mcp.json` filename. Generated policy differences are not custom conflicts; genuine custom collisions, unsupported expressions and unsafe paths preserve both originals. Known generated consult/browser entries refresh from current startup inputs; portal reconciliation retains Worker-owned credentials. Literal leading bangs are escaped, never executed. Explicit stock-only loading and dual/unknown-selection guards remain unchanged. Native configuration and passive recovery files stay sync-eligible. See [REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration).

Client qualification covers actual Pi proxy/deferred exposure, placeholder transport, idle reconnect, stdio cancellation/progress timeout behavior, uncertain-write non-replay and unmanaged OAuth. It does not prove why an existing hosted portal grant failed, publish curation, deploy an image or activate the current process.

## User workflows and retirement

Advisor requires an explicit current-user request; startup guidance adds no autonomous route. RPIV Advisor provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. Its `advisor` tool and user-only `/advisor` command do not authorize assistant invocation.

The [Pi manifest](../../preseed/agents/pi/package.json) and [lockfile](../../preseed/agents/pi/package-lock.json) pin Evaluate's reviewed MIT package and integrity. Its extension registers the packaged skill directory on `resources_discover`; it ships no tool or command and runs only when the user invokes `/skill:evaluate`. The skill reads a [reespec](https://github.com/bnenu/reespec) brief and specs when `reespec/requests/` exists, otherwise a user-pasted contract, together with produced outputs. It returns per-capability satisfied/partial/unsatisfied/unclear verdicts and triage, deliberately excludes implementation intent, and reports gaps rather than fixing them. Codeflare applies no patch or fork. The image explicitly loads `extensions/evaluate.ts` and requires its path-correct JITI artifact ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions)). Lock-backed weekly shadow-pin discovery includes future releases.

Managed `@narumitw/pi-usage` and its `/usage` provider-quota workflow are retired. Startup removes only that exact npm identity from restored string/object package entries; credentials, history and unrelated packages remain untouched ([REQ-AGENT-209](../../sdd/spec/agents.md#req-agent-209-retired-pi-package-migration)). Only Usage's private nested TUI-kit is removed from the lock; Goal/Plan retain theirs. Open TUI's local token/context/cost display is not equivalent to subscription-quota reporting and does not change Codeflare billing or usage records.

Startup removes only explicit retired package identities from persisted settings, preserving unrelated user additions. Todo state stays session/transcript scoped; no global task database or retired AD100 source override returns. `goal_wait` remains execution-blocked even if another extension re-exposes it. Subagents' active-resume guard rejects queued/running mutation through the reviewed public accessor; settled/unknown records retain upstream behavior.

## Native terminal qualification

These methods are not acceptance evidence. Record exact source/image/seed/mode and redacted outcomes; missing prerequisites remain blocked. Marked manual observations are not replaced by supplemental tests. Runtime, inference, protected access, state changes and publication need separate current authorization with existing disposable resources. Never replay uncertain operations or expose secrets. Static guidance review does not prove deterministic obedience or deployed behavior; CI/image/publication/deployment gates remain separately owned.

### Native Pi terminal acceptance

Use separately authorized existing candidate-image/deployed terminals and the installed native commands. Record image/runtime/seed identities, mode, terminal width and observed outcomes. Do not install a package, write a UI harness, patch an SDK, enable a provider route or make inference merely to inspect presentation. Every runtime claim requires actual observation; source presence is not terminal activation.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-152](../../sdd/spec/agents.md#req-agent-152-native-plan-mode-workflow-in-pi-sessions) | In the candidate packaged Pi terminal, record active tools, reload Pi, enter /plan, do read-only discovery, answer a native structured question, explicitly complete the plan, and hand off implementation; compare the restored tool inventory with the initial one. Do not perform implementation without its own approval. | Native /plan supports discovery, structured questions, explicit completion and implementation handoff; planning stays read-only and exiting restores the prior tool set. |
| [REQ-AGENT-161](../../sdd/spec/agents.md#req-agent-161-pi-startup-header-terminal-width-safety) | Open candidate-image Pi at a desktop width and a narrow embedded-terminal width; count rendered columns of each startup-header line against the terminal's supplied width, including colored text rather than escape-byte length. | Every rendered startup-header line fits Pi's supplied columns at both observed widths, including the narrow embedded pane. |
| [REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-terminal-ui-and-session-status) | In authorized candidate-image terminals for both modes, inspect one native header/footer/editor and terminal-only /open-tui settings, repository/branch versus no-repository status, other nonempty extension statuses and empty-status absence. Resize desktop/narrow widths with colored statuses and inspect clipping/wrapping/style bleed; do not add a competing footer or infer model identity from display. | Both modes activate exactly one native header/footer/editor and terminal-only settings. Codeflare status is repo/branch-only or absent, other nonempty statuses survive, empty-only rows do not, and narrow colored lines fit without style bleed or routing-identity changes. |
| [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) | In separately authorized fresh Standard and Advanced Pi terminals inspect /ctx disabled and no runtime owner; run /ctx on, activate one context tool via capability and perform a harmless read; run /ctx off and inspect reload/tool disappearance. Do not treat command text or config presence as successful tool operation. | Fresh startup is disabled without a context runtime; /ctx on reload enables an actual harmless context operation, and /ctx off reload removes those tools in both modes. |
| [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership) | In an already-authorized context-mode-enabled foreground session inspect completed reviewer child manifests/process evidence, then exercise a harmless foreground context read after they finish. Inspect session shutdown and a subsequent fresh session's successful context initialization. Children must not initialize an additional owner/server; no reviewer or service is launched by this preparation. | Children have no context tools or competing owner/server; foreground context remains functional after child completion and a later session initializes after prior shutdown releases ownership. |
| [REQ-AGENT-224](../../sdd/spec/agents.md#req-agent-224-pi-fast-and-ultrafast-controls) | Use a separately authorized fresh deployed Pi profile. Inspect Off before native speed commands; record provider/model and redacted auth identity. Enable Fast/Ultrafast natively; inspect supported request-tier acceptance and preserved preferences. UI toggles are insufficient. Never run inference or change authentication/model merely for evidence. | Fresh profile begins Off; native commands select supported request tiers while provider/model/auth identity and existing preferences survive. Real supported-tier acceptance, not only a displayed toggle, is observed under separate authorization. |

## Adjacent owners

- [Preseed](../lanes/preseed.md): modes, manifests, compiler and runtime delivery.
- [Container](../lanes/container.md#pi-extension-npm-cache): installed cache placement and supervision.
- [Vault & Memory](../lanes/vault.md#memory-capture-system): capture/retrieval/publication lifecycle.
- [Storage & Sync](../lanes/storage-and-sync.md#durable-seed-reconciliation): durable provenance, cleanup, verification and applied state.

Requirement statuses and verification qualifiers remain in Agents; this reference is source documentation, not installation, CI, publication, activation or deployed acceptance.
