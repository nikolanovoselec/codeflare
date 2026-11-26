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
| `@dumbmice/pi-todo-loop` | Stock RPIV todo continuation, `/todoloop`, and `todo_loop_block` |
| `@narumitw/pi-plan-mode` | Native Plan and registered-tool policy transform |
| `@calesennett/pi-codex-fast` | Native Fast/Ultrafast controls for supported OpenAI models |
| `pi-open-tui` | Native terminal header, footer, prompt editor and `/open-tui` settings |
| `pi-smart-compact` | Provider-neutral native-pressure compaction, without a competing footer or memory stack |
| `pi-hermes-memory` | [Image-locked package](../../preseed/agents/pi/package-lock.json) loaded by the [managed foreground adapter](../../preseed/agents/pi/extensions/hermes-memory-runtime.ts); [Vault & Memory](../lanes/vault.md#durable-pi-facts) owns its lifecycle |
| `context-mode` | Disabled at container start; foreground-owned after explicit `/ctx on` |
| `pi-evaluate` | User-invoked reporting skill, no tool or command |
| `pi-mcp-adapter` | Cached/deferred MCP discovery, idle cleanup and one managed connection owner |
| `pi-web-access` | Web retrieval and headless-safe default search workflow |

## Loading and warm compatibility

Image construction warms RPIV, Subagents, MCP Extension, web-access, Evaluate, Open TUI, Codex Fast, Smart Compact, Todo Loop, Plan Mode, and every local TypeScript extension through the exact installed path. Required JITI artifacts must exist. A second fresh Pi process must report cache hits without misses, including imported dependencies. JavaScript entrypoints use native import checks rather than nonexistent JITI artifacts. This is a transpilation-cache gate, not V8-cache evidence or a startup-latency guarantee for restored user content. Runtime updates invalidate only runtime-owned caches.

Every file scanned as a Pi extension exports a default factory; pure helpers retain a no-op default beside named exports. Package-presence checks cannot replace actual extension loading. Warming loads resources without requesting model completions. Extension-load errors in either warm-up process fail qualification even when Pi exits zero; genuine cache hits do not excuse a failed factory.

Changed restored or managed-release bytes safely invalidate old transpiles and can require first-load compilation. Fast Start Off deliberately isolates caches after runtime updates. Preserve authoritative restored content rather than overwriting it to obtain image-cache hits; these paths are not an unchanged-image startup-latency guarantee.

### Pi 1.5 and operator compatibility

Pi 1.5 retains JITI 2.7's path/content-sensitive cache rules; keep the fresh-process replay gate rather than infer reuse from artifact presence. Its extension loader supplies the upstream Pi-AI compatibility view, while ordinary package-root imports no longer export TypeBox. New extension schemas import `typebox` directly and follow Pi's JSON-Schema validation rules; TypeBox-only refinements/codecs are not validation guarantees. The image's gateway-label preparation accepts only its reviewed 1.5 source/bundle hashes and avoids repeating the label as a secondary name. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay -->

Interactive/prewarm Pi and Worker dependencies have independent ownership. The Worker pairs Agents 0.33.0 with Pi-AI 1.5.2 (`~1.5.0` peer); immutable App pins remain separate. Stock Flue 2.3.0 needs its compatible Pi-AI API, including the root `Type` export removed in 1.5; do not propagate the Worker pair into App/Flue dependencies. Root owns OAuth resolution/refresh; the App receives only the protected token DTO. Direct OpenAI/ChatGPT compatibility still requires producer/consumer CI and fresh-owner acceptance, not blanket Codex/Copilot support or credential bridging.

### Temporary native Codex prompt-cache backport

[REQ-AGENT-261](../../sdd/spec/agents.md#req-agent-261-codex-prompt-prefix-backport-preparation) carries [upstream PR 12319](https://github.com/earendil-works/pi/pull/12319) at commit `f7d9657ce20eb6e660d90a46fa235270abd04010`. Under [REQ-AGENT-238](../../sdd/spec/agents.md#req-agent-238-native-codex-prompt-prefix-compatibility), the initial system prompt travels as a leading developer input message instead of top-level instructions. The image prepares both the Pi-AI library and bundled CLI in the shared and prewarm installations; runtime update/repair restores the same preparation. This makes the prefix eligible for caching but does not prove a live cache hit or cost reduction. <!-- @impl: scripts/patch-pi-codex-prompt-cache.mjs::patchPiCodexPromptCache -->

Tests and the Pi Bump Shadow Pins path inspect pristine candidate packages before publication. An already-fixed upstream package fails with a backport-retirement error; unknown source or version drift also fails closed. Only receipt-verified Codeflare-patched bytes may pass repeat runtime preparation. When an official release incorporates the fix, remove this backport and its build/update hooks, then qualify the normal version bump; do not weaken the pristine guard to keep an obsolete patch alive. No Pi fork or dependency-version substitution is used. <!-- @impl: scripts/patch-pi-codex-prompt-cache.mjs::verifyPiCodexPatchRequired --> <!-- @impl: scripts/update-pi-runtime-artifacts.mjs::updatePiRuntimeArtifacts -->

### Native terminal UI

[REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-local-statusline-footer) owns the native UI and session-status contract. Open TUI is exact-pinned and integrity-locked in the image's Pi extension inventory. Startup selects the exact `pi-open-tui` pin owned by the [Pi manifest](../../preseed/agents/pi/package.json), with `extensions: []`: package auto-discovery is suppressed because managed `startup-header.ts` delegates the installed native entrypoint once. Open TUI owns header, footer and editor in both modes; the adapter gates terminal handlers and `/open-tui` to TUI contexts and bounds header/footer lines by real terminal column width. RPC, print and background execution do not acquire its settings overlay or project probes.

`local-statusline.ts` publishes only repository and branch through the native status area, without installing a competing footer or duplicating context, model or effort. Parent-workspace sessions retain remembered nested repositories and the guarded display-only sentinel. Other extensions keep their statuses and colors; native context/model rendering remains upstream-owned. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel -->

After home restore, entrypoint enforces the following `open-tui.json` preferences on every container startup, including existing workplaces ([REQ-AGENT-221](../../sdd/spec/agents.md#req-agent-221-pi-startup-presentation-preferences)). Unrelated root and nested fields survive. <!-- @impl: entrypoint.sh::configure_pi_open_tui -->

| Group | Enforced preferences |
|---|---|
| General | Enabled, English, thinking peek two lines, inline footer off |
| Appearance | ASCII icons, block cursor |
| Footer on | Session name, context bar, extension statuses |
| Footer off | CWD, hostname, Git branch/status/detached commit, runtime, tokens, cost, live TPS, provider capitalization |
| Telemetry | Master disabled; subordinate TPS, TTFT, duration, token counts, stall details and cost switches on but inactive |

The manifest-pinned Open TUI's live-TPS footer segment is independent of the telemetry master; startup explicitly disables it to preserve the quiet presentation.

Entrypoint uses a private atomic replacement for safe configuration. Malformed, symlink or nonregular files stay unchanged and produce a content-free warning. The terminal adapter performs read-only validation before native activation and falls back to Pi's built-in UI on unsafe configuration without blocking execution. `/open-tui` remains the upstream settings UI; later container startups restore the enforced fields. <!-- @impl: preseed/agents/pi/extensions/startup-header.ts::validateConfig -->

The image explicitly warms `extensions/open-tui/index.ts` and verifies its path-correct cache. Source tests, image loading, a compatible curation compiler, signed publication and actual terminal activation are distinct gates; the older curation checkpoint cannot supply this new package.

The complete RPIV preparation contract remains [REQ-AGENT-210](../../sdd/spec/agents.md#req-agent-210-managed-extension-startup-preparation):

- The image-installed Pi preseed RPIV extensions declare host TypeBox as a wildcard peer, preserving other package metadata.
- Actual image startup must load advisor, questionnaire and todo tools without host-dependency warnings or extension errors.
- Startup updates and npm repair reapply the peer correction to the Pi profile extension tree before PTY release.
- RPIV shadow-pin candidates update matching lock-backed manifests and must pass the patch and actual loading of the preseed extensions through both installed Pi SDKs before any branch push.
- Incompatible candidates fail the job without publication.

Pi includes native MCP, but deferred tool exposure is not lazy server allocation: enabled native servers connect eagerly. The replacement extension remains the managed MCP lifecycle owner. Managed startup must disable `builtin:mcp` with the documented `-builtin:mcp` extension entry while preserving unrelated extension selections <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory -->; a first-session command warning is not proof of correct ownership. Retired-adapter evidence does not qualify the replacement MCP extension. Image construction, installed runtime behavior and deployed acceptance remain separate pending gates; package presence and source CI do not satisfy them.

## Fast and Ultrafast

The image exact-pins `@calesennett/pi-codex-fast`; startup registers it once before Pi discovery and preserves `pi-codex-fast.mode`, provider/model choices and authentication. Only the known recovery path `packages/pi-codex-fast-0.1.13` (relative or under the agent directory) converges to the managed npm registration; custom paths and package files remain untouched ([REQ-AGENT-224](../../sdd/spec/agents.md#req-agent-224-pi-fast-and-ultrafast-controls)). The native `/codex-fast` and `/codex-ultrafast` commands opt into supported OpenAI request tiers without an SDK patch. Version 0.1.14 requests these tiers for GPT‑6.2 Sol and Astra on both OpenAI provider routes. Existing preferences survive; new profiles retain upstream Off. Provider entitlement and separately hosted Operator inference are outside these runtime controls ([REQ-AGENT-247](../../sdd/spec/agents.md#req-agent-247-native-pi-speed-selection)).

Never install into the live `~/.pi/agent/npm` link. Dependency changes belong in the committed preseed manifest/lock and image build; publication of dependent curation follows a successful compatible deployment.

## Context-mode and web access

Context-mode has image-owned ESM compatibility and update-probe suppression in both installed copies. Version mismatch, missing required bundles, or failed post-write shim/probe verification fails the image build. An already-absent update-probe URL is permitted; no self-update path is introduced. <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeInstallations --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeDirectory --> <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeBundle -->

The earlier Context-mode 2.1.4 review found embedded Zod 4.0.0. The current release is recorded in the [Pi package manifest](../../preseed/agents/pi/package.json) and [shared tool manifest](../../preseed/npm-tools/package.json); a version change or removal of transitive Zod 3 lock records alone does not establish remediation of that embedded copy.

The foreground extension loads v2's installed `pi/index.js` in-process without changing package lifecycle ownership. In-process children do not initialize competing context-mode owners. Entrypoint leaves inherited `CONTEXT_MODE_BRIDGE_IDLE_MS` untouched and creates no override; the foreground runtime clears it before upstream initialization, retaining upstream managed root/subagent ownership and idle reaping rather than preserving inherited values end to end. Startup-prefix evidence is not enabled-runtime evidence. Fresh startup defaults to disabled; `/ctx on` enables the managed runtime and tools across Pi reloads until the next container startup. Every managed workflow retains native fallbacks. Licensing rationale remains [AD49](../decisions/README.md#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install). [REQ-AGENT-076 AC4](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement) distinguishes startup configuration from enabled runtime.

Web access retains `web_search`, `source_check`, `fetch_content`, and paged `get_search_content` offset/limit retrieval. Search uses Pi's model registry or zero-config Exa routing without a per-user API key. The [reviewed upstream changelog](https://github.com/nicobailon/pi-web-access/blob/7e6e2386dc9a31d5e2a448172060dd1339c604f7/CHANGELOG.md) specifies all-failed tool errors, structured results, Perplexity Search API snippets for ordinary search and isolated session/cache lifetimes. OpenAI search prefers the newest Luna model; the API-key default is `gpt-6-luna`. Paid Ceramic is explicit-only, excluded from `auto`/`all`.

Its declared native `dist/index.js` remains the image warm target; the standalone MCP CLI is not configured for Claude. Native import evidence is not a V8 cache-hit claim. Create-if-missing `~/.pi/web-search.json` defaults to `{"workflow":"auto-summary"}`; deliberate `summary-review` opt-in survives later boots. Codeflare supplies the retained `librarian` skill in both modes, not a duplicate upstream copy. Optional `web_enable` follows upstream `toolActivation`; an old resumed session may need a new session to acquire its recorded selection ([REQ-AGENT-115](../../sdd/spec/agents.md#req-agent-115-pi-web-access-014-skill-compatibility)).

Web Access retains explicit-only Cloudflare/SearchApi/Tabstack search and opt-in hosted fetching. Hosted fetch requires provider-order inclusion and `fetchRouting.allowRemoteHostedProviders: true`; credentials alone do not authorize external URL disclosure or cost. Node fetch remains default; optional curl configuration never authorizes a private-URL or egress bypass. Provider summaries are not page quotations, and returned PDF text retains bounded stored-result paging.

Version 0.47 adds locked-proxy enforcement and optional Sofya/Outcrawl routes. Leave the tool's `proxy` argument unset by default and never clear a configured `lockProxy` to bypass an authentication or routing failure. New provider availability does not authorize enabling it ([upstream changelog](https://github.com/nicobailon/pi-web-access/blob/v0.47.0/CHANGELOG.md)).

## Smart Compact

Smart Compact is exact-pinned and integrity-locked in the image inventory; its native `dist/index.js` is an explicit warm-verification target. Both Pi modes receive `00-smart-compact-config.ts`, which seeds the managed preset only when both `smartCompact` and the supported legacy `semanticCompact` alias are absent. Existing valid preference values, including empty or partial sections under either name, remain unchanged; the preset writer leaves bytes unchanged unless it applies defaults or repairs the known duplicate registration. User edits in `~/.pi/agent/settings.json` follow its existing R2 sync/restore path; startup does not reapply missing options. That writer leaves malformed settings and occupied settings locks untouched. Startup package assembly has its own write path. <!-- @impl: preseed/agents/pi/extensions/00-smart-compact-config.ts::configureSmartCompact --> <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory -->

The initial preset uses Thorough mode, current-model routing, low summary thinking, four calls and a 240-second generation and trigger budget. It uses the stock background trigger at 80% context. `maxContextTokens: 0` leaves context sizing to Pi and the package rather than imposing a manual limit. <!-- @impl: preseed/agents/pi/extensions/00-smart-compact-config.ts::defaults -->

Approval, secret scrubbing, and lost-detail monitoring stay on; backups are off by default. Context hygiene and artifact offload are enabled, while the package footer, agent tools and additional memory stay off. Codeflare's existing capture and post-compaction recall remain their owners. Startup invokes the same preset writer used by the managed Pi extension; either path preserves existing preferences. <!-- @impl: entrypoint.sh::configure_pi_smart_compact_defaults --> <!-- @impl: preseed/agents/pi/extensions/00-smart-compact-config.ts::configureSmartCompact -->

Codeflare tests its registration, startup defaults, and settings preservation. These tests do not qualify upstream replacement decisions or live summary quality. See [REQ-AGENT-222](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults) and [REQ-AGENT-223](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation).

Smart Compact 10.8.1 retains completion headroom above its target summary length and bounded truncated-synthesis recovery. Its Pi 1.5 compatibility and cache changes require no automatic settings migration; old extraction caches may miss once, and reasoning routes need sufficient headroom. Neither a cache refresh nor a package update reconstructs previously lost detail or proves live provider quality ([upstream changelog](https://github.com/alpertarhan/pi-smart-compact/blob/v10.8.1/CHANGELOG.md)).

Restored settings can contain the earlier `./packages/pi-smart-compact-10.6.2` registration (or its absolute agent-directory equivalent) alongside the managed npm package. Container startup treats this known location as the same identity and retains only the required npm registration before Pi discovery. The curated config factory repairs the same duplicate only when an npm declaration already exists, preserving its filters and all package/memory files. Because factories run after path selection, that repair applies to the next discovery/reload, not the current load; it never forces another reload. Custom paths, similarly named packages and local-only installations remain untouched ([single-installation contract](../../sdd/spec/agents.md#req-agent-222-pi-smart-compact-defaults), [safe migration contract](../../sdd/spec/agents.md#req-agent-223-pi-smart-compact-settings-preservation)).

A compatible image must exist before publishing a curation release requiring a new package. This registration-only repair uses the existing runtime ABI and can publish without a new image, but boot-time prevention requires the corrected image. Source CI and publication do not establish installed or deployed acceptance; see [managed curation ownership and runtime compatibility](../lanes/preseed.md#managed-curation-ownership).

## Goal

Use `/goal` for a session-owned objective and `/todoloop` for continuation driven by open tasks. They are both installed; Todo Loop remains stock and does not read `pi-goal.json`. Do not use both continuation mechanisms to drive the same objective during qualification.

Managed Goal defaults to tools after the first goal and unlimited automatic turns. Existing explicit values for those two preferences are preserved. Codeflare sets the stalled-turn limit to five and the minimum automatic continuation interval to five minutes. The footer shows the Goal state and active duration, and exact activation of `goal_wait` is denied. [Goal requirements](../../sdd/spec/agents.md#req-agent-272-managed-goal-alongside-todo-loop) · [Tool policy](../../sdd/spec/agents.md#req-agent-248-managed-goal_wait-exclusion)

Goal upgrades go through Bump Shadow Pins. The exact locked candidate must pass the Codeflare transform; the image then warms the installed source entrypoint and verifies reuse from a fresh Pi process. <!-- @impl: Dockerfile::goal_hit -->

## Todo Loop

The image exact-pins stock [`@dumbmice/pi-todo-loop` 0.4.0](https://www.npmjs.com/package/@dumbmice/pi-todo-loop/v/0.4.0) and warms its declared `src/index.ts` entrypoint at the installed path. Both Pi modes register it once, independently of context-mode. It uses the lock-backed Pi-extension shadow-pin path with no Codeflare transform ([REQ-AGENT-111](../../sdd/spec/agents.md#req-agent-111-native-todo-loop-workflow-in-pi-sessions)).

Todo Loop reads the current session branch's RPIV `todo` state. After a completed, tool-free reply with open tasks, the loop can request another turn. It neither edits tasks nor grants authority; saving a plan or staging tasks does not authorize execution. The agent updates tasks through `todo` and uses `todo_loop_block` with a reason when it needs the user or is waiting on work it already started. The wait clears on the next user message or when a later turn uses a tool again. These tools use ordinary optional-tool activation in Codeflare. See [`package/src/index.ts` (`turn_end` and block handling) in the pinned 0.4.0 archive](https://registry.npmjs.org/@dumbmice/pi-todo-loop/-/pi-todo-loop-0.4.0.tgz).

Use `/todoloop` to see open tasks, the effective continuation limit, and why the loop stopped. `/todoloop pause` pauses this session until resume or restart; `/todoloop resume` lifts the user pause without clearing a pending block. `/todoloop reset` clears the current count and pending block without changing the task list. The stock extension reads `maxRounds` from `~/.pi/agent/todo-loop.json` as a per-message continuation cap when set; the stock default is uncapped. A `todo-loop-off` file in `~/.pi/agent/` or the working directory’s `.pi/` disables the loop. Stock settings apply; the retired Goal pacing and stalled-work policy do not carry over. See [`package/src/index.ts` (`todoloop` command and settings) in the pinned 0.4.0 archive](https://registry.npmjs.org/@dumbmice/pi-todo-loop/-/pi-todo-loop-0.4.0.tgz).

<a id="goal-and-plan-transforms"></a>
## Plan Mode transform

Plan's exact-version transform resolves helper availability and configured policy from registered tools rather than the small active bootstrap set. It preserves Plan's native custom-turn boundary without adding a duplicate guard, validates the `dist/index.ts` declaration, and rejects source-layout or partial-patch drift before writing. <!-- @impl: scripts/patch-pi-plan-mode-tool-policy.mjs::patchPiPlanModeDirectory --> The image warm verifier loads the entrypoint and checks the JITI output. Shadow-pin candidates still run the Plan transform before publication. <!-- @impl: scripts/verify-pi-lockstep.mjs::warmAndVerifyJitiEntrypoints --> <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions -->

Startup attempts to replace `pi-plan-mode.json` atomically; [startup warns and continues on failure](../../sdd/spec/agents.md#req-agent-266-managed-pi-plan-mode-policy). On successful application, the managed frozen policy excludes generic questions, arbitrary context execution, MCP, delegation, task mutation, and advisor. <!-- @impl: entrypoint.sh::configure_pi_plan_mode -->

In the pinned Plan package, `/plan save` remains session-local; pathless export keeps upstream `PLAN.md`. No automatic plan-file writer is added. See the [pinned Plan source archive](../../host/__fixtures__/narumitw-pi-plan-mode-0.60.1.tgz).

<a id="mcp-extension-and-consult-llm"></a>
## MCP adapter and consult-llm

The Pi inventory restores the exact `pi-mcp-adapter` pin owned by the [Pi manifest](../../preseed/agents/pi/package.json), with `index.ts` as its warm target. Pi runtime-family pins and unrelated SDK/security overrides remain independently owned. Installed archive integrity and real-client behavior are qualified independently of manifest edits.

Startup removes the replaced stock npm registration and retains `-builtin:mcp`, leaving one managed lifecycle owner. Native `mcp-adapter.json` supports proxy discovery/execution and deferred direct tools. Managed portals use lazy ten-minute idle cleanup, public placeholder headers and `auth: false`; all real portal OAuth remains on Cloudflare. Active calls prevent idle closure, cached discovery survives it, and the next call reconnects. Deferred startup still permits a metadata-only discovery pass when the gateway runtime first initializes. External consultation remains explicitly user-gated.

`requestTimeoutMs: 360000` is the adapter's progress-resetting request timeout, not a fixed total deadline. Browser navigation can use 120000ms where supported; provider retention remains twenty minutes. Unmanaged local OAuth uses the adapter's own supported storage and is not a reason to import another client's grants.

Guarded native preparation preserves valid native definitions over proven generated duplicates and imports missing supported legacy servers. It archives exact originals before retiring the obsolete `mcp.json` filename. Generated policy differences are not custom conflicts; genuine custom collisions, unsupported expressions and unsafe paths preserve both originals. Known generated consult/browser entries refresh from current startup inputs; portal reconciliation retains Worker-owned credentials. Literal leading bangs are escaped, never executed. Explicit stock-only loading and dual/unknown-selection guards remain unchanged. Native configuration and passive recovery files stay sync-eligible. See [REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration).

Client qualification covers actual Pi proxy/deferred exposure, placeholder transport, idle reconnect, stdio cancellation/progress timeout behavior, uncertain-write non-replay and unmanaged OAuth. It does not prove why an existing hosted portal grant failed, publish curation, deploy an image or activate the current process.

## User workflows and retirement

Advisor requires an explicit current-user request; startup guidance adds no autonomous route. RPIV Advisor provides one identical-input retry for a transient empty model response while preserving immediate abort/error propagation. Its `advisor` tool and user-only `/advisor` command do not authorize assistant invocation.

The [Pi manifest](../../preseed/agents/pi/package.json) and [lockfile](../../preseed/agents/pi/package-lock.json) pin Evaluate's reviewed MIT package and integrity. Its extension registers the packaged skill directory on `resources_discover`; it ships no tool or command and runs only when the user invokes `/skill:evaluate`. The skill reads a [reespec](https://github.com/bnenu/reespec) brief and specs when `reespec/requests/` exists, otherwise a user-pasted contract, together with produced outputs. It returns per-capability satisfied/partial/unsatisfied/unclear verdicts and triage, deliberately excludes implementation intent, and reports gaps rather than fixing them. Codeflare applies no patch or fork. The image explicitly loads `extensions/evaluate.ts` and requires its path-correct JITI artifact ([REQ-AGENT-133](../../sdd/spec/agents.md#req-agent-133-native-evaluation-workflow-in-pi-sessions)). Lock-backed weekly shadow-pin discovery includes future releases.

Managed `@narumitw/pi-usage` and its `/usage` provider-quota workflow are retired. Startup removes only that exact npm identity from restored string/object package entries; credentials, history and unrelated packages remain untouched ([REQ-AGENT-209](../../sdd/spec/agents.md#req-agent-209-retired-pi-package-migration)). Plan retains its own locked TUI-kit. Open TUI's local token/context/cost display is not equivalent to subscription-quota reporting and does not change Codeflare billing or usage records.

Startup removes explicit retired package registrations, and replaces only the known superseded local Todo Loop registration with the stock npm entry. `pi-goal.json`, package files, session history, and unrelated user additions are not deleted or migrated. Todo state stays session/transcript scoped; no global task database or retired AD100 source override returns. Subagents' active-resume guard rejects queued/running mutation through the reviewed public accessor; settled/unknown records retain upstream behavior.

## Native terminal qualification

These methods are not acceptance evidence. Record exact source/image/seed/mode and redacted outcomes; missing prerequisites remain blocked. Marked manual observations are not replaced by supplemental tests. Runtime, inference, protected access, state changes and publication need separate current authorization with existing disposable resources. Never replay uncertain operations or expose secrets. Static guidance review does not prove deterministic obedience or deployed behavior; CI/image/publication/deployment gates remain separately owned.

### Native Pi terminal acceptance

Use separately authorized existing candidate-image/deployed terminals and the installed native commands. Record image/runtime/seed identities, mode, terminal width and observed outcomes. Do not install a package, write a UI harness, patch an SDK, enable a provider route or make inference merely to inspect presentation. Every runtime claim requires actual observation; source presence is not terminal activation.



| Contract | Action | Required observation |
|---|---|---|
| [REQ-AGENT-266](../../sdd/spec/agents.md#req-agent-266-managed-pi-plan-mode-policy) | In the candidate packaged Pi terminal, record active tools, reload Pi, enter /plan, do read-only discovery, answer a native structured question, explicitly complete the plan, and hand off implementation; compare the restored tool inventory with the initial one. Do not perform implementation without its own approval. | Native /plan supports discovery, structured questions, explicit completion and implementation handoff; planning stays read-only and exiting restores the prior tool set. |
| [REQ-AGENT-161](../../sdd/spec/agents.md#req-agent-161-pi-startup-header-terminal-width-safety) | Open candidate-image Pi at a desktop width and a narrow embedded-terminal width; count rendered columns of each startup-header line against the terminal's supplied width, including colored text rather than escape-byte length. | Every rendered startup-header line fits Pi's supplied columns at both observed widths, including the narrow embedded pane. |
| [REQ-AGENT-056](../../sdd/spec/agents.md#req-agent-056-pi-terminal-ui-and-session-status) | In authorized candidate-image terminals for both modes, inspect the header/footer/editor, terminal-only `/open-tui` settings, and other extensions’ nonempty statuses. Resize desktop/narrow widths with colored statuses and inspect clipping, wrapping and style bleed without adding a competing footer. | Both modes activate exactly one native header/footer/editor and terminal-only settings. Other nonempty statuses survive, empty-only rows do not appear, and narrow colored lines fit without style bleed. |
| [REQ-AGENT-267](../../sdd/spec/agents.md#req-agent-267-repository-only-pi-session-status) | In the same authorized terminals, compare repository/branch and no-repository status alongside native context/model display. Compare routing identity independently of the rendered label. | Codeflare contributes only the repository and branch, or no status when no repository resolves, without changing routing identity. |
| [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) | In separately authorized fresh Standard and Advanced Pi terminals inspect /ctx disabled and no runtime owner; run /ctx on, activate one context tool via capability and perform a harmless read; run /ctx off and inspect reload/tool disappearance. Do not treat command text or config presence as successful tool operation. | Fresh startup is disabled without a context runtime; /ctx on reload enables an actual harmless context operation, and /ctx off reload removes those tools in both modes. |
| [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership) | In an already-authorized context-mode-enabled foreground session inspect completed reviewer child manifests/process evidence, then exercise a harmless foreground context read after they finish. Inspect session shutdown and a subsequent fresh session's successful context initialization. Children must not initialize an additional owner/server; no reviewer or service is launched by this preparation. | Children have no context tools or competing owner/server; foreground context remains functional after child completion and a later session initializes after prior shutdown releases ownership. |
| [REQ-AGENT-247](../../sdd/spec/agents.md#req-agent-247-native-pi-speed-selection) | Use a separately authorized fresh deployed Pi profile. Inspect Off before native speed commands; record provider/model and redacted auth identity. Enable Fast/Ultrafast natively; inspect supported request-tier acceptance and preserved preferences. UI toggles are insufficient. Never run inference or change authentication/model merely for evidence. | Fresh profile begins Off; native commands select supported request tiers while provider/model/auth identity and existing preferences survive. Real supported-tier acceptance, not only a displayed toggle, is observed under separate authorization. |

## Adjacent owners

- [Preseed](../lanes/preseed.md): modes, manifests, compiler and runtime delivery.
- [Container](../lanes/container.md#pi-extension-npm-cache): installed cache placement and supervision.
- [Vault & Memory](../lanes/vault.md#memory-capture-system): capture/retrieval/publication lifecycle.
- [Storage & Sync](../lanes/storage-and-sync.md#durable-seed-reconciliation): durable provenance, cleanup, verification and applied state.

Requirement statuses and verification qualifiers remain in Agents; this reference is source documentation, not installation, CI, publication, activation or deployed acceptance.
