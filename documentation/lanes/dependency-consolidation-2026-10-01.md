# Dependency consolidation: 1 October 2026

## Scope and gates

The captured input is 59 open Codeflare PRs (#1129 through #1213, not every number in that interval), based on `develop` at `0dbb3d3984d562a4c1e804e59071024cfbd15287`. Consolidation uses `merge/all-open-prs-2026-10-01`; it does not promote to `main`. All captured PR heads are incorporated in its ancestry, including superseded proposals without rolling back newer versions. Net changes and retained compatibility constraints, rather than the presence of a merge commit, determine what ships.

The baseline contains the MCP adapter filename repair and the native VS Code upgrade transport repair. Integration deployment [36890828004](https://github.com/nikolanovoselec/codeflare/actions/runs/36890828004) passed for that baseline; it is not evidence for these later dependency changes. Curation baseline `fe89e82` published `seed-v121`. EI VS Code acceptance is an owner report; later dependency-image acceptance remains pending.

Required sequence: complete compatible source and paired skill updates; open one PR to `develop`; complete exact-head review and CI; merge only after both pass; deploy that resulting tested tree to Integration and Enterprise Integration; independently verify final post-secrets deployment versions and signed managed-seed compatibility. Only then remove remaining temporary branches. `main` promotion and production deployment are explicitly not authorized. Operators remain paused; this work admits no Activities and replays none of the preserved unknowns.

## Compatibility decisions

### Agents SDK: retain 0.20.1, not the proposed 0.24.0

The grouped root PR #1166 proposes ten updates. Nine are incorporated. Its Agents update cannot safely ship with the existing immutable Flue 2.1.0 / Dispatcher packages and parent compatibility bridge.

Upstream 0.22 replaces private `_cf_*ForFacet` schedule RPCs with `_cf_routeLifecycle`. Codeflare's `src/operators/activity.ts` and real native fixture still expose/forward `_cf_scheduleForFacet`, `_cf_scheduleEveryForFacet`, schedule lookup/cancellation, facet keep-alive and run bookkeeping. Its Loader children are independently bundled with Agents 0.20.1. The upstream assumption that facets always run the same deployed script does not establish compatibility for that mixed-version bridge. The published 0.24 declaration exposes the new routed Lifecycle aperture; a version bump alone is not an adapter migration.

Other material upstream changes:

- 0.22 changes scheduled callback arguments from raw rows to parsed `Schedule` values, removes standalone `MCPClientManagerOptions.storage`, and removes the placeholder `agents` CLI.
- 0.23 moves scheduling to a Lifecycle job queue, migrates and drops legacy schedule tables, removes `getNextAlarm`/capability `onAlarm`/`LifecycleServices.alarms`, and introduces the `dynamicAgents` facade. Existing public `subAgent` aliases remain; that does not preserve private bridge RPCs.
- 0.23 removes the experimental memory subpaths and Postgres providers. Installing Sessions lifts and drops legacy conversation tables. Downgrading package bytes does not restore migrated conversations.
- 0.24 makes queue inspection/deletion asynchronous, renames `created_at` to `createdAt`, and executes callbacks outside the enqueuing request context. Its temporary old-queue migration is scheduled to disappear in the next minor, so populated deployments must not skip that migration release.
- 0.24 changes experimental WebSocket/Lifecycle composition and transport selection. No new transport, session topology or callback authority is enabled here.

Decision: keep the exact existing `agents@0.20.1` package and required original lock records; update the other grouped packages. No alias dependency, second scheduler, invented bridge or private SQL migration is added. A future SDK change requires matching parent/child lifecycle, scheduling, settlement and cleanup tests, plus an independently approved package/compiler migration. Existing real native tests remain mandatory on this consolidation.

The shared Agents SDK skill now describes the version boundaries, correct asynchronous queue lookup signatures, migration/rollback risks and explicit capability composition. Examples do not imply that Codeflare itself has upgraded to 0.24.

Source: [Agents changelog](https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md), release sections 0.21 through 0.24; [published 0.24 package](https://registry.npmjs.org/agents/0.24.0). The published declaration and current source, not the stale repository graph, establish the private-RPC incompatibility.

### Node: update Node 26 digest, retain embedded IDE Node 22

PR #1209 changes all Node 26 image stages to digest `662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2`. That part is incorporated.

The proposal also replaces three Node 22 IDE stages with Node 26.10.0 while leaving executable assertions requiring `22.21.1`. Those stages build the embedded IDE/sidebar and assemble its immutable inventories; they have a separate Node runtime contract. Retain their existing digest-verified Node 22.21.1 image and assertions. No native-addon ABI or embedded extension-host upgrade is inferred from a general runtime update.

The new jsdom 30.1.1 engine range is `^22.22.2 || ^24.15.0 || >=26.0.0`. Host checks use the separate Node 26 lane; CI must confirm every consuming lane satisfies the engine requirement. Do not loosen engine checks or change the embedded IDE pin to accommodate an unrelated test dependency.

### Graphify 0.9.61 to 0.9.73: preserve managed source ownership

The complete 0.9.62 through 0.9.73 release interval was inspected. Important changes include Terraform credential redaction, Fortran include-file disclosure prevention, quoted watcher-path handling, preservation of incremental cross-file edges, JSX/enum call relationships, Astro parsing and inherited Java-call resolution. These are desirable extraction/security fixes, not authorization to rebuild existing graphs.

**Breaking integration risk:** 0.9.72 introduces automatic installed-skill refresh on non-install CLI commands. That can replace Codeflare's paired curated Graphify guidance. The upstream opt-out is `GRAPHIFY_NO_AUTO_REFRESH=1`. The image and bounded Claude/Pi update wrappers must enforce it. Behavioral tests simulate an upstream refresh and observe that synthetic managed skill bytes remain unchanged; both wrappers first demonstrated RED without the guard.

0.9.73 reports semantic files clipped at 20,000 characters. A warning is incomplete coverage, not successful full-document analysis. Updated skills require bounded reads of the remaining source. New enum `case_of` edges are additive; existing graph schema, consent, provider exclusions and private-input handling remain unchanged. Older hook status does not authorize overwriting managed hooks.

Sources: [0.9.72](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.72), [0.9.73](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.73), [0.9.70 security fixes](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.70). The repository's root `CHANGELOG.md` stops at 0.1.8 and is not adequate evidence for this release interval.

### Chrome DevTools MCP 1.8.0 to 1.10.1

Inspected 1.9.0, 1.10.0 and 1.10.1. New viewport/geolocation validation makes guessing an old tool schema unsafe. CLI unrestricted-path defaults must not be mistaken for permission to use a different execution surface. Performance trace defaults can use substantially more memory (upstream notes 1.2 GB), and performance/usage features have external-data implications. Version 1.10.1 fixes bundled Node export-condition resolution.

Retain the configured remote CDP server, lazy MCP lifecycle, authentication and existing user retention. Do not run `npx @latest`, launch a local replacement browser, enable optional performance/CrUX tooling implicitly, or overwrite user MCP configuration. Paired Claude/Pi Browser Run skills require current tool discovery and explicit authorization before sending private trace URLs. This patch does not add new telemetry settings or change user credentials.

Sources: [1.9.0](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.9.0), [1.10.0](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.10.0), [1.10.1](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.10.1), [pinned README](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.10.1/README.md).

### Coding-agent CLIs and official IDE extension

- **Claude Code 2.1.263 to 2.1.282:** inspect the full intervening changelog, especially managed-policy parsing, namespace restrictions for `anthropic-skills`/`claude-ai`, MCP validation and resumed-turn reasoning/tool handling. Keep object-form attribution configuration for backwards compatibility; do not enable newly offered Chrome/managed-MCP overrides. Existing Codeflare skills have different namespaces. VSIX 2.1.281 is separately pinned by its checksum and installed unmodified; CLI and VSIX releases are not assumed interchangeable.
- **Codex 0.153.4 to 0.156.1:** inspected 0.154, 0.155, 0.156 and the 0.156.1 hotfix. `codex mcp-server` and `thread/rollback` are removed. MCP OAuth failures must not be replayed as writes. Voice/worktrees are newly enabled defaults in upstream TUI; that is not permission for Codeflare to access microphones, create worktrees or alter user settings. Server model catalog additions do not change approved gateway routes or inference bounds.
- **OpenCode 1.18.29 to 1.18.32:** inspected 1.18.30 through 1.18.32. Bedrock ARN/model identifiers, ACP resume/fork context and image-attachment handling change. Remote configuration authentication failures now exit unsuccessfully: retain failure evidence rather than treating an unsuccessful start as an empty healthy session. No provider switch or credential migration is added.
- **Copilot 1.0.86 to 1.0.88:** update the package and all platform-specific locked assets consistently. Preserve the current Pi 0.99.1 prewarm/runtime selection; older bump branches must not restore 0.87.1. Existing terminal/subscription launch behavior remains the compatibility gate.

Sources: [Claude changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [Codex 0.154](https://github.com/openai/codex/releases/tag/rust-v0.154.0), [0.155](https://github.com/openai/codex/releases/tag/rust-v0.155.0), [0.156](https://github.com/openai/codex/releases/tag/rust-v0.156.0), [0.156.1](https://github.com/openai/codex/releases/tag/rust-v0.156.1), [OpenCode 1.18.30](https://github.com/anomalyco/opencode/releases/tag/v1.18.30), [1.18.31](https://github.com/anomalyco/opencode/releases/tag/v1.18.31), [1.18.32](https://github.com/anomalyco/opencode/releases/tag/v1.18.32). Metadata/engines/integrity were retrieved from the authoritative npm registry for the selected package versions. This is static compatibility analysis, not live acceptance for every CLI.

### Remaining grouped updates

Root Hono 4.13.8 and Zod 4.6.5 are gated by real authorization/input-boundary tests, not a semver assumption. Wrangler 4.137.0 changes the build/deploy tooling without changing deploy targets. Vite 8.3.0, jsdom 30.1.1, Astro 7.3.4 and motion 13.4.2 require the full frontend/landing suites and build gates; no interface redesign is added. fast-check, types, knip, oxlint, typebox and yaml updates retain the existing test/quality contracts. Workflow actions remain immutable-SHA pinned; Buildx, CodeQL and zizmor changes do not grant additional workflow permissions or broaden triggers.

SilverBullet 2.11.1 changes its tracked service-worker artifact/cache constants; verify Vault editor/static routing through existing tests and deployment acceptance, without changing user notes or running a Vault index. code-server 4.139.1 retains the native authenticated WebSocket transport fix and exact protocol/binary tests. Herdr 0.9.3 retains the reviewed launcher's terminal-ID interface, immutable native provenance and checksum. uv 0.12.18 is downloaded from its versioned release asset and verified before extraction; no installer checksum bypass is added. Browser Run's separate MCP SDK moves from 1.30.0 to 1.30.1, not from v1 to v2; it does not replace the Pi adapter's distinct MCP v2 transport.

## Shared source and release ownership

Update both Codeflare `preseed/` and curation for the Graphify metadata, Graphify/Browser Run skills, SDK migration references and managed update wrappers. Image-owned npm locks remain in Codeflare. Curation's compiler checkpoint must advance only through its existing verified-deployment/pin workflow when the shared compiler/runtime inputs change. Do not replace the pin with an uncommitted source tree or infer automatic EI activation from source publication.

Companion source changes are staged locally until their release gate is reached. Private Managed seed CI, signed immutable publication, runtime-hash selection and consuming-session activation are separate checks. Existing sessions do not silently reload newly delivered Pi extensions.

## Requirement and verification mapping

| Outcome | Existing contract | Evidence/gate |
|---|---|---|
| Graphify pin, managed ownership and bounded updates | [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) | Guard RED/GREEN tests, seed compilation, image smoke |
| Browser Run discovery, auth and retained MCP settings | [REQ-BROWSER-006](../../sdd/spec/browser-run.md#req-browser-006-pi-interactive-browser-via-chrome-devtools-mcp) | Existing startup/configuration tests, managed prompt checks |
| IDE Node ABI and native WebSocket behavior | [Browser IDE contract](../../sdd/spec/browser-ide.md) | Image's executable Node assertion, real 101/text/256-KiB tests |
| Immutable package/parent bridge compatibility | [Operator contracts](../../sdd/spec/operators.md), [registry](../../sdd/spec/operator-registry.md) | Exact legacy SDK retained; native Flue settlement/collection/restart tests |
| Lock consistency, builds and quality | [Deployment gates](deployment.md) | Exact-head full PR Checks, reviewed tree, v3 receipts |
| Two authorized rollouts; no main promotion | User's scoped deployment authority | Separate final post-secrets readbacks; cleanup only after success |

## Branch cleanup

Eight remote branches whose heads were already ancestors of `develop` were deleted first. PR heads remain until incorporated or explicitly closed as already present/superseded. Unique unmerged historical work must remain recoverable before removing its branch pointer; do not silently erase the preserved Flue timing work. The final branch inventory must contain only `develop` and `main` after the consolidation/review/deployment gates, with no write to `main` itself.

## Verification status

- Captured PR-head ancestry: all 59 present in the local consolidation history.
- Eighteen obsolete/already-included Pi PRs closed with current-version evidence; their proposals cannot undo the 3.3.0 MCP migration.
- Graphify skill-preservation local RED: both Claude and Pi wrappers fail without the upstream opt-out, while the six existing wrapper checks pass.
- Final GREEN, exact-head PR review/CI, companion publication and the two consolidated rollouts: pending. No completion or live compatibility claim is made from these source merges alone.
