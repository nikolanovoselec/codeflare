---
name: sdd-init
description: Workflow for /sdd init bootstrap. Covers greenfield (lean two-confirm flow), Import Mode (two-output: REQs + triage), Resume Mode (drain triage queue), the Phase 5 spec extraction + enrichment + validation cycle (graphify-extensive), the Phase 6 documentation extraction + validation cycle (graphify-extensive), and dependency version resolution. Invoked when /sdd init runs. Requires the spec-driven-development skill for REQ format, Status semantics, and templates.
version: 2.0.0
---

# /sdd init — bootstrapping a project

Three scenarios, auto-detected:

1. **Greenfield**: empty project, no existing code. Bootstrap from prose.
2. **Import**: project already has source, no `sdd/` yet. Enter **Import Mode** — derive a spec where behavior is clear from source/tests/comments/commits, file the unclear parts to `sdd/init-triage.md` with concrete Context + Recommendation, write the scaffolding.
3. **Resume**: `sdd/` exists and `sdd/init-triage.md` has `**Status:** open` items. Enter **Resume Mode** — surface one triage item at a time with refreshed Context.

Detect via source-file count (greenfield-vs-import) and presence of open triage items (resume).

## Autonomous-mode defaults (binding when `--unleashed` is supplied)

`--unleashed` at `/sdd init` time implies the user is not available to answer the vision prompt or the draft-accept prompt. The skill MUST proceed without blocking on user input:

- **Vision prompt (Greenfield step 1, Import Mode step 1).** Skip the question. Vision defaults:
  - Greenfield: read repo basename + any README content present; if both empty, vision is `"{repo-basename} — purpose to be filled by /sdd edit"`.
  - Import Mode: vision = first paragraph of `README.md` (or `README` / `readme.md`); fallback to "Imported from existing code" if README absent.
- **Draft-accept prompt (step 4).** Auto-accept the full draft. Skip the section-edit loop entirely. Console-log `Note: --unleashed; auto-accepted draft. Run /sdd edit to refine domains/REQs.`
- **Triage decisions (Resume Mode).** `--unleashed` at Resume Mode does NOT auto-resolve triage items — triage explicitly requires user judgment per the SDD transition gate. Resume Mode prints `Note: --unleashed deferred during triage; triage items still require manual decision.` and presents items one at a time as in interactive mode.

Non-autonomous flags (`--auto`, `--interactive`, no flag) prompt the user normally. The agent must NOT silently auto-accept when the user is present.

## Greenfield — lean two-confirm flow

1. **Ask for vision** (one free-form question if `$ARGUMENTS` is empty). Confirm what you heard in one sentence.
2. **Run Phase 5a pre-extraction** silently (see § Phase 5). For greenfield: a graph almost certainly doesn't exist yet, so 5a degrades to in-memory inference from the vision + stack guess. Most operations skip; ADR-seed + glossary-seed are derived from the vision text alone.
3. **Draft the entire spec in memory** using vision + 5a outputs. Derive:
   - Actors (typically 2-3; User, Admin defaults; never "System")
   - Design principles (3-7 specific to this product, not generic)
   - Domains (5-12 with one-line summary + priority)
   - REQs per domain (5-15 each; canonical format from `spec-driven-development` skill; every field populated; `Constraints: None.` / `Dependencies: None.` explicit when empty)
   - CON-* constraints (tech stack, performance, security, observability)
   - Founding ADRs (3-8 seeded from vision + inferred stack)
   - Glossary terms (every product noun, vendor name, protocol mentioned in any REQ)
4. **Present the full draft as a single review surface**: tree of domain index + per-domain summary + ADR list + glossary. Ask one question: "Accept as-is, edit a section (name it), or restart?" On `edit <section>`: re-draft only that section, re-present, ask again. On `restart`: discard, return to step 1. Loop until accepted.
5. **Run Phase 5 enrichment + validation** (cross-link, ADR-seed, glossary-seed, dependency-graph, iterate-to-clean against `spec-enforce` family). Details in § Phase 5.
6. **Run Phase 6 documentation extraction + validation** (lane probes, source-module exhaustion is trivial here, draft + iterate-to-clean against `doc-enforce` family). Details in § Phase 6.
7. **Write all files** from `references/templates/` in the `spec-driven-development` skill, substituting every placeholder per the substitution contract below. Phase 5 + 6 outputs supply the section bodies; templates supply the section skeleton. The iterate-to-clean loops in 5 + 6 produce the final on-disk state.
8. **Commit the scaffold** as one commit with subject `[sdd-init] initial spec scaffold`. The `[sdd-init]` prefix is excluded from the spec-reviewer round counter.
9. **Report next steps** to the user.

All templates and references live in the `spec-driven-development` and `sdd-init` skills — no internet needed.

### Template placeholder substitution contract (binding)

Every template emission MUST substitute every `{TOKEN}` listed below before writing the file. Unsubstituted tokens become Pass 16 `scaffold-section-empty` findings (HIGH or CRITICAL on load-bearing files). The substitution map is required input to the template-write step; if any required token has no value, the agent computes one from the vision + inferred stack (never leave the literal).

| Token | Source | Used in |
|---|---|---|
| `{PROJECT_NAME}` | User-supplied vision; fallback to repo basename | All templates |
| `{ACTOR_1}`, `{ACTOR_2}`, `{ACTOR_3}` | Phase 4 actor draft | `sdd/README.md`, `sdd/{domain}.md` |
| `{INSTALL_COMMAND}` | Inferred stack (`npm install`, `pip install -e .`, `cargo build`, `flutter pub get`, etc.) | `README.md` |
| `{ADR_MARKER_STYLE}` | `sdd/config.yml` `adr_marker_style` (default `ad`) | `documentation/decisions/README.md` |
| `{REPO_URL}` | `git config --get remote.origin.url` (resolve to https form); blank if no remote | `README.md` |
| `{LICENSE}` | LICENSE file basename if present; else `proprietary` | `README.md` |
| `{PRIMARY_LANG}` | Manifest detection (Dart/TS/Python/Rust/Go) | `README.md`, `documentation/architecture.md` § Overview |
| `{DEPLOY_TARGET}` | Inferred from manifest (Cloudflare Worker, Android, iOS, Vercel, etc.) | `documentation/deployment.md` |

Templates may contain additional `{TOKEN}` placeholders inside specific section bodies (e.g., `{Component}`, `{file:line}`, `{One-line description}`). Those are SECTION-LEVEL placeholders filled by the corresponding Phase 5/6 pre-extraction pass, not by this top-level substitution map. The map above covers WHOLE-FILE substitutions only.

Before writing each file, run a pre-flight check using the **placeholder detection contract** defined in `spec-driven-development` § "Placeholder detection contract (single source of truth)" — that section owns the regex + exemption list. If any non-exempt match remains after substitution, fail loudly (do not silently emit) — either compute a value or omit the placeholder context entirely. The pre-flight is the generation-side dual of `doc-enforce` Pass 16 + `spec-enforce` Scaffold-section-empty (validation-side); all three sites consume one contract.

## Import Mode — two-output model

The migration path from legacy manual coding to autonomous agentic coding. Two simultaneous outputs:

- **Official spec REQs** in `sdd/{domain}.md` — for behavior clearly determinable from the full discovery surface. Normal REQ shape, normal SDD discipline.
- **Triage entries** in `sdd/init-triage.md` — for unclear items (magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent). Each entry carries the agent's **Context** (file:line, git author, commit refs, related tests, PRs, issues, releases) and **Recommendation** (best-guess with one-line Rationale). The user reviews and decides; they don't archaeology from scratch.

**Discovery surface is the full project history**, not just source. Intent in legacy systems lives in PR descriptions, issue threads, code-review comments, release notes. Pull from: working tree (README, configs, source, tests, inline comments, ADRs), git history (commits, tags), and the GitHub corpus when a remote exists (PRs via `gh pr view --comments`, issues via `gh issue view --comments`, releases via `gh release view`, wiki via API). When a PR references an issue ("Closes #142"), Context follows the chain backward.

**Degradation when GitHub sources are unreachable.** Detect failure conditions up front (non-GitHub remote — GitLab / Bitbucket / Forgejo / Gerrit; `gh auth status` fails; rate-limited; private repo with insufficient token scope; air-gapped). On failure, skip the GitHub sources and proceed with working-tree + git-log evidence only. Print a one-line notice (`Note: discovery used working tree + git log only ({reason} - GitHub sources unavailable).`) and append the same to the `sdd/changes.md` import entry.

While `sdd/init-triage.md` contains `**Status:** open` items, the project is in **SDD transition**. Import Mode writes `sdd/config.yml` with `transition: true` and `enforce_tdd: false` at scaffold time (the two Import-Mode-specific config defaults; greenfield uses `transition: false` and `enforce_tdd: true`). During transition, the PR-boundary review pipeline is **entirely suspended**: code-reviewer, spec-reviewer, doc-updater do not fire. Mode-selector behavior during transition (specifically the `/sdd mode unleashed` rejection) is owned by the `spec-driven-development` skill's `/sdd mode` section — single source of truth, see there for the full rule.

**Mode-flag persistence at init time.** When the user invokes `/sdd init --unleashed` (or `--auto`, `--interactive`) the supplied flag MUST be honoured but written to the correct key:

- **Greenfield (no transition):** write the supplied mode to `mode:` in `sdd/config.yml`. Default `interactive` when no flag supplied.
- **Import Mode (transition will be true):** write `mode: interactive` AND a separate key `requested_mode_post_transition: <user-flag>`. The active `mode:` stays `interactive` for the duration of transition so every downstream agent that reads `mode:` (without checking `transition:`) behaves correctly. When Resume Mode completes the last triage item, the transition-closure step copies `requested_mode_post_transition` into `mode:` and removes the requested-mode key.

This preserves the `/sdd mode unleashed` runtime rejection invariant (the active `mode:` is never `unleashed` while `transition: true`) while honouring the user's stated intent for the post-transition phase. Never silently demote `unleashed` to `auto`.

When `requested_mode_post_transition: unleashed` is set with `transition: true`, Resume Mode entry-point prints `Note: unleashed deferred until transition closes. Active mode during transition: interactive.` at start of each session.

When the queue drains to zero, `transition: true` clears automatically. Full SDD discipline applies on the next push. `enforce_tdd` is NOT auto-flipped — user sets it manually when ready (typically after adding REQ-ID test names). `sdd/init-triage.md` is preserved as the audit record.

Import Mode follows the **same lean shape as greenfield**: single user-facing question at step 1, single review surface at step 4, then Phase 5 + Phase 6 run silently. Vision pre-fills from README + git log + 5a pre-extraction; the user mostly confirms or edits.

**Status default for imported REQs:**
- `enforce_tdd: true` — Status defaults `Implemented` if a test mentions the REQ ID, `Partial` otherwise.
- `enforce_tdd: false` (Import Mode default) — Status defaults `Implemented` unconditionally when source exists. The project has opted out of test-based verification at import time; demoting every imported REQ to Partial would falsely brand the spec 65%+ incomplete. Each `sdd/{domain}.md` file (per domain, not the top-level `sdd/README.md`) receives a single footnote `_Verification: code-only (no automated coverage)._` at the bottom. Per-REQ `Notes:` are not used for this signal.

This rule applies during Import Mode and Resume Mode while `transition: true`. After transition closes, the normal `enforce_tdd` interaction in `spec-enforce-truth` governs Status assignment.

CLEAR REQs land in `sdd/{domain}.md` after the user accepts the draft. The confidence threshold (single matching domain, unambiguous behavior, clear evidence) is the gate; anything below became a triage entry. To correct any CLEAR REQ post-import, run `/sdd edit {domain}`.

Phases 5 + 6 run in Import Mode too, after the draft is accepted and before files are written.

## Resume Mode — picking up where you left off

Re-invoking `/sdd init` on a project with open triage items enters Resume Mode.

1. **Working tree must be clean** (`git status --porcelain` empty). Refuse if not — Resume Mode commits per decision and would mix WIP edits with triage commits.
2. **Sanity-check transition state.** If `transition: true` is missing from `sdd/config.yml` but open items exist, restore quietly. If `transition: true` is set but `sdd/init-triage.md` is unreadable, abort with a recovery hint.
3. **Print a mode notice based on `requested_mode_post_transition`:**
   - Key present and `auto`: "Note: auto deferred until transition closes. Resume Mode runs interactive; auto activates on closure."
   - Key present and `unleashed`: "Note: unleashed deferred until transition closes. Resume Mode runs interactive; unleashed activates on closure."
   - Key absent or `interactive`: no notice.
4. **Surface one item at a time** with **refreshed** Context (re-read source, re-check git log, re-fetch related PRs — the codebase may have evolved). User picks one of:
   - `accept` the recommendation → fold into the relevant REQ
   - `correct` it → free-form prose; agent folds purpose into REQ Intent and behavior into AC bullets named in the entry's `**Target REQ:**` field (no re-inference)
   - `lost` → one-line Reason required; the related REQ (if any) gets `Notes: intent lost during SDD transition - see TRIAGE-{NNN}`
   - `skip` → stays open, advance to next
   - `quit` → exit; prior decisions are already committed per-item

Only `accept` and `correct` promote anything to the official spec. Each decision is its own commit.

**Transition-closure step** after every resolved/lost decision. When zero `**Status:** open` remain:
- `transition: true` is cleared from `sdd/config.yml`
- If `requested_mode_post_transition` is set: copy its value into `mode:`, then delete `requested_mode_post_transition`. Print `Note: mode activated: <value>.`
- A closure entry appends to `sdd/changes.md` (e.g., `SDD transition complete. {Total} triage items resolved ({R} accepted, {C} corrected, {L} lost).`)
- **Phase 6 RE-RUNS** (one cycle, no second draft acceptance). Triage decisions may have added new REQs, lifted Status, or revealed lanes the original scaffold missed. The doc enrichment must reflect the closed-transition state. Findings auto-fix per the existing iterate-to-clean loop. Net delta committed as `[sdd-triage] doc reconciliation at transition closure`.
- `enforce_tdd` is NOT changed (user flips manually when ready)
- Agent enters Plan Mode for the first feature work on top of the now-real spec

## Tool surface compatibility (binding for every `/sdd` sub-command)

Two surfaces — plain Bash and context-mode MCP. Every phase below MUST work on both.

- **Behavioural contract is tool-agnostic.** Skill describes WHAT, not WHICH shell wrapper.
- **Graphify is tool-agnostic.** Every `mcp__graphify__*` call works identically under both surfaces; no shell wrapper required. Phase 5 + 6 are designed to be graphify-heavy precisely because the graph queries are cheap on both surfaces and avoid the per-file-read token cost.
- **In context-mode environments**, discovery commands >20 lines (e.g. `gh pr list --state all --limit 200`, `git log --follow`, full-tree scans, `npm view <pkg> peerDependencies`) MUST go through `mcp__context-mode__ctx_batch_execute` or `mcp__context-mode__ctx_execute`. Bare Bash will be denied.
- **In plain Bash environments**, same commands run via Bash directly.
- **File writes always use Write/Edit** — both surfaces accept these natively. Never construct file contents inside `ctx_execute` shell heredocs.
- **Scaffold-only lockfile carveout** (`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and equivalents) runs through `ctx_execute` in context-mode — output exceeds 20 lines. The `no-local-builds` rule permits this single resolution-only call at scaffold time.

## Phase 5 — Spec extraction + enrichment + validation (binding)

**Pre-condition: a graphify graph at `graphify-out/graph.json` is the load-bearing source of truth for this phase.** Per REQ-AGENT-025, the post-clone PostToolUse hook prompts the user to build one immediately after `git clone`. If missing at `/sdd init` time, prompt the user ONCE: "No graphify graph found. Build one now via `/graphify cluster-only` (AST-only, free, ~30s)? Or proceed with in-memory enrichment (less reliable cross-link density)?". On accept: dispatch `/graphify cluster-only` and wait. On decline: fallback (below).

**Project-scoping check (binding, runs before any graphify call).** The unified global graph layer (`~/.graphify/global-graph.json`) merges per-repo graphs + vault notes + session captures into one MCP-queryable surface. `mcp__graphify__*` calls succeed against the global graph even when the local `graphify-out/graph.json` is absent — meaning a naive "graph exists" check passes while the returned nodes belong to UNRELATED projects. Phase 5a MUST:

1. Check `graphify-out/graph.json` exists in `pwd` (file-system check, not MCP).
2. If absent: skip ALL `mcp__graphify__*` calls and fire fallback. Do NOT call `graph_stats` or `god_nodes` expecting useful project data — the global graph will return noise.
3. If present: proceed with `mcp__graphify__*` calls against the (presumably project-scoped) graph.

A project-scoped MCP query attempted while only the global graph exists is the dominant source-of-truth failure for Phase 5/6. The fallback is genuinely the better answer here — in-memory inference from README + filesystem is more reliable than vault-session noise from the global layer.

Phase 5 runs in five passes, then a validation loop:

### Pass 5a — Graphify-extensive pre-extraction

Cache all outputs in memory for the full `/sdd init` session. Avoid re-reading files when the graph already has the answer.

| Operation | Graphify call | Purpose |
|---|---|---|
| Repo overview | `mcp__graphify__graph_stats()` | Node count, edge count, community count — sets the scale budget for the spec |
| Tech-stack pillars | `mcp__graphify__god_nodes(top_n=20)` | Tech stack / framework / external service candidates (feeds 5c ADR-seed) |
| Domain candidates | For each community ≥ N nodes (default N=50, override in `sdd/config.yml` as `domain_community_threshold`): `mcp__graphify__get_community(id)` | Each large community is a domain candidate iff ≥60% of nodes share a directory prefix or file-name prefix. The shared prefix becomes the proposed domain name. Smaller communities are candidates for sub-domains within a larger one. |
| Concept neighbors per REQ candidate | For each named concept inside a domain: `mcp__graphify__get_neighbors(<concept>)` | Direct neighbors become candidate Dependencies / Constraints (feeds 5b cross-link) |
| Cross-domain dependency edges | For each pair of named REQ candidates: `mcp__graphify__shortest_path(a, b)` | Path length ≤ 3 → structural dependency, lift to `Dependencies:` (feeds 5e dependency-graph) |
| Actor identification | Walk reachability from user-facing surfaces (HTTP routes, screens, CLI entry, intent receivers) via `mcp__graphify__query_graph` with each surface as start | Group surfaces by who can reach them → actor set |
| CON candidate probes | Filesystem grep (one-pass) for security-shaped, perf-shaped, reliability-shaped, observability-shaped code patterns | Each hit becomes a CON candidate |

**Pre-extraction outputs feed the draft in step 3 (greenfield) / step 4 (Import).** The agent does NOT invent domains / actors / CONs / REQs from intuition when graphify outputs exist; it consolidates them. Where graphify boundaries don't match semantic domain boundaries (e.g., zipline-native's "Authentication" spans biometric_service + oauth_service + auth_service in two communities), the agent applies judgment to merge — but the candidate list is the starting point.

**Caching contract.** Every `mcp__graphify__*` result is cached in memory under `phase5_cache[<call-signature>]`. Phase 5b-5e re-use the cache without re-calling. Cache lifetime is one `/sdd init` invocation.

### Pass 5b — Cross-link

For every drafted REQ, lift candidate Dependencies + Constraints from the 5a cache. Returned neighbors that are other drafted REQs → lift into `Dependencies:` as `[REQ-X-NNN](#req-x-nnn-title-slug)`. Returned CON-* nodes → lift into `Constraints:` as `[CON-X-NNN](constraints.md#con-x-nnn-title-slug)`.

### Pass 5c — ADR-seed (extended from v1.0)

Sources in priority order:

1. **Inline marker mine.** Grep source for `// (AD|CF|REJECTED|CHOSEN)[- ]?[0-9]+` patterns. Every existing marker is a load-bearing ADR — promote to a formal ADR with the marker as its heading anchor. The marker convention is preserved if the project already uses one; otherwise seed with `AD-N`.
2. **God-node tech-stack.** Filter `god_nodes(top_n=20)` from 5a to nodes representing technology / framework / external service / pattern choices. Each survivor becomes an ADR candidate.
3. **README / CONTRIBUTING decision mine.** Sentences matching `we chose|decided to|rejected|considered|switched from|moved away from|why X` are decision evidence. Cluster by topic.
4. **Dependency-choice synthesis.** Every major dependency in `package.json` / `pubspec.yaml` / `Cargo.toml` / `go.mod` / `requirements.txt` is a candidate. Apply the "real alternative considered" gate from `documentation-decisions-readme.md`.

Survivors render as ADRs with Status, Context, Decision, Alternatives, Rationale, Consequences, Related requirements. Each ADR's heading carries the inline marker (`### AD-N: Title` or `### CF-N: Title`).

The marker convention is set in `sdd/config.yml` as `adr_marker_style: ad | cf | custom:PREFIX | none` (default `ad`). When `none`, ADRs use no inline marker and are referenced by title only (lossy — discouraged).

### Pass 5d — Glossary-seed (extended)

Query the graph for concept-tagged nodes (`mcp__graphify__query_graph` with concept filter; graphify emits these with `source_file: null` when they represent vocabulary). Each becomes a one-line glossary entry in `sdd/glossary.md`.

Synonym mining: for every named concept, check graphify for variant labels (camelCase / snake_case / PascalCase / shortname). Cluster aliases per concept. Concepts with ≥2 variant names go into `documentation/README.md` synonyms slot (built in Phase 6). Concepts with one canonical name go straight into `sdd/glossary.md`.

### Pass 5e — Dependency-graph

For every drafted REQ, look up `mcp__graphify__shortest_path` between concepts named in its body and concepts named in other drafted REQs. Paths of length 1-2 → likely structural dependency. Paths of length 3-4 → soft dependency (mention in Intent or Notes, not Dependencies). Paths > 4 or no path → unrelated.

Auto-populate `Dependencies:` from path length 1-2 results. Where the lift creates a cycle, leave it (cycles between domains are real and the spec must reflect them).

### Pass 5f — Iterate-to-clean (validation loop)

After the draft is accepted (step 4) and Passes 5a-5e have run:

1. Write the current spec draft to working tree (uncommitted, on top of clean tree).
2. Invoke the `spec-enforce` skill with `scope=all`. The skill runs the 18-row execution manifest and conditionally invokes `spec-enforce-ac` + `spec-enforce-truth`.
3. Read the findings. Apply:
   - **Auto-fixable findings**: apply the fix inline (rendering corrections, missing-field fills, status drift).
   - **Extraction-required findings**: re-run the corresponding 5a-5e operation against the specific finding. Example: an `unspec-feature-documented` finding from spec-enforce-ac means a behavior exists with no REQ; run a targeted graphify query on the unspecced code → produce a new REQ candidate → fold into draft.
4. Re-invoke `spec-enforce`.
5. If zero CRITICAL and zero HIGH: exit loop, proceed to Phase 6.
6. Else loop. Maximum 5 iterations.
7. On iteration limit: write remaining CRITICAL/HIGH findings to `sdd/.review-needed.md` with header `Scaffold-time validator residuals`, commit anyway with `[sdd-init]` prefix.

The 5-iteration ceiling mirrors the existing 2-round commit-cycle anti-spiral. JUDGMENT escape hatch is `.review-needed.md`.

### Fallback when graphify is absent or empty

Fire fallback when ANY of:
1. `graphify-out/graph.json` is absent AND the user declined to build a graph.
2. `graph_stats()` returns zero nodes (graph exists but empty — fresh repo, build truncated). Same trigger if `query_graph` returns no concept nodes during 5d.
3. Any `mcp__graphify__*` call errors (MCP server down, graph corrupt, permission denied).

Fallback behaviour for each 5a operation:

| Operation | Fallback |
|---|---|
| Repo overview | `find . -type f` filtered to source extensions; count |
| Tech-stack pillars | Parse package manifest (`package.json` / `pubspec.yaml` / `Cargo.toml` / `go.mod`); top-10 dependencies become tech-stack candidates |
| Domain candidates | Filesystem directory walk: any directory with ≥10 source files is a domain candidate; the directory name is the proposed domain name |
| Concept neighbors | Literal-string grep across all drafted REQ bodies; concepts mentioned in 2+ REQ bodies become cross-link candidates |
| Cross-domain dependency edges | Same literal-string grep across REQ bodies; co-mention in two domains' REQs → dependency candidate |
| Actor identification | Manual: read README + CONTRIBUTING + the entry-point file list (per `references/entry-point-probes.md`) |
| CON candidate probes | Same filesystem grep |

Print: `Note: enrichment used in-memory fallback ({reason}). Cross-link density may be lower than a graphify-backed run.` Append same notice to `sdd/changes.md`.

## Phase 6 — Documentation extraction + validation (binding)

Runs after Phase 5 completes. Same iterate-to-clean shape, different extraction operations and validator family.

### Pass 6a — Conditional lane probes

Lane emission is evidence-driven. For each lane below, run the probe. Lane emitted iff probe hits.

| Lane | Probe |
|---|---|
| `architecture.md` | Always |
| `api-reference.md` | Any HTTP route, RPC handler, or queue message handler exists |
| `configuration.md` | Always |
| `deployment.md` | Always |
| `decisions/README.md` | Always (uses Phase 5c output) |
| `security.md` | Any file path matching `*auth*`, `*session*`, `*jwt*`, `*crypto*`, `*csrf*`, `*rate-limit*`, `*secure*`, `*sanitiz*`, `*permission*` OR any REQ in 5 mentions cookies/tokens/secrets/oauth/csrf |
| `observability.md` | Any structured-log helper (closed `LogEvent` enum, file matching `*log*.ts`/`*logger.dart`/etc.) OR metrics-export code OR telemetry code |
| `troubleshooting.md` | Always (populated from error paths discovered in 6c) |
| `api-reference-admin.md` | Any admin-gated route (middleware match + admin-specific endpoint) |
| `architecture-internals.md` | Only if architecture.md exceeds the soft cap (500 lines) after 6b-6e populate; split rather than trim |
| **Per-subsystem lane** `{subsystem}.md` | A graphify community ≥ N nodes (default 50) AND ≥60% of community nodes share a directory prefix OR file-name prefix OR named import path. The shared prefix becomes the lane name. |

The per-subsystem lane rule is what produces codeflare's `vault.md`, `billing.md`, `container.md`, `subscription.md` pattern at scale. Small projects (zipline-native scale) will hit zero subsystem lanes; large projects (codeflare scale) will hit 10-15.

**No empty stub lanes.** A lane that probes to "emit" but produces zero content from 6b-6h is dropped (don't ship empty stubs).

**No false-positive emission.** A lane that doesn't probe-hit is NOT emitted (don't ship `security.md` for a project with no auth surface).

### Pass 6b — Source-module exhaustion

For every code file in the project's primary source tree (resolved by highest-density `src/` or `lib/` directory, falling back to project root):

- Use `mcp__graphify__get_node(label=<filename>)` to confirm presence in graph and pull the canonical label.
- Determine role from first doc-comment block (read only the first 30 lines of the file, never the full file).
- For each drafted REQ, run `mcp__graphify__get_neighbors(label=<filename>)` and intersect with REQ-referenced concepts → `Implements` column (REQ IDs).

**Output**: one row per source file in `architecture.md § Source Module Map`. Verifiable: row count ≥ 90% of source file count (the 10% slack accounts for trivial files like `index.ts` re-exports).

### Pass 6c — Entry-point enumeration + lifecycle synthesis

Read `references/entry-point-probes.md` for per-language/framework entry-point signatures. For each detected entry point:

- Use `mcp__graphify__get_node(label)` to confirm structural position.
- Use `mcp__graphify__shortest_path(<entry>, <terminal-write-node>)` to extract the flow.
- Identify the dominant failure transition by querying `get_neighbors(<entry>)` for nodes labeled `*Error`, `*Exception`, `catch`, `reject`, `fail*`.
- Emit one numbered Request Lifecycle subsection in `architecture.md § Request Lifecycles`. Each subsection contains an ASCII flow block showing both happy path AND dominant failure transitions.

**Output**: subsection count ≥ entry-point count.

### Pass 6d — Endpoint contract enumeration

Parse routing config (framework-specific — see `references/entry-point-probes.md` § HTTP routing parsers). For each discovered route:

- Request shape (from handler param types / Zod schema / route handler signature)
- Response shape (from handler return type / explicit JSON shape)
- Full error matrix (every `throw`, every non-2xx return, every middleware short-circuit)
- Cache policy (from `Cache-Control` headers in source, default `no-store` if mutating)
- Auth requirement (from middleware chain)
- Implementation pointer (`src/path/file.ts:line`)
- Rate-limit policy (if any)
- Inline `Implements [REQ-X-NNN]` link

**Output**: one entry per route in `api-reference.md`. Admin-gated routes go in `api-reference-admin.md` if Pass 6a emitted that lane.

### Pass 6e — Cross-cutting concerns synthesis

For each of these standard concerns, probe the codebase. If a mechanism exists, emit a row in `architecture.md § Cross-cutting Concerns`. If not, skip.

| Concern | Probe |
|---|---|
| Authentication | files matching `*auth*`, `*session*`, `*jwt*` |
| Authorization | middleware/admin files, role checks |
| CSRF / Origin defense | grep `Origin` header check, SameSite cookies |
| Rate limiting | files matching `*rate-limit*`, `*throttle*` |
| Security headers | grep `Content-Security-Policy`, `Strict-Transport-Security` |
| Observability | structured log helper, closed log event enum |
| Error handling | error enum / sanitiser / `ErrorCode` type |
| Retry policy | `retryCount`, `maxRetries`, backoff helpers |
| Persistence | DB wrapper, storage adapters |
| Network resilience | connectivity tracker, offline queue |

Each row: `Concern → Mechanism (file:line) → REQ`. No empty rows.

### Pass 6f — ADR marker proposals (sidecar)

Extends Phase 5c output. Phase 5c emitted founding ADRs from inline markers + god-nodes + README mine + dependency-choice. Phase 6f does NOT mutate source files — that would be a lane crossing (Phase 6 owns `documentation/`, not source). Instead, Phase 6f emits a sidecar `documentation/.adr-marker-proposals.md` containing one row per proposed marker location.

For each ADR from 5c that has no source-side anchor, identify the canonical implementation site via `mcp__graphify__get_node(<ADR-target-concept>)` and emit a row in the sidecar table:

```markdown
| ADR | Title | File | Line | Confidence |
|---|---|---|---|---|
| AD-N | Short title | src/path/file.ts | 42 | high |
```

`confidence` is `high` when graphify returned a single unambiguous node, `medium` when 2-3 candidate nodes were ranked, `low` when fallback (grep) was used. The sidecar file's preamble documents how the user applies markers (open each file, paste `// AD-N: Title` at the proposed line, commit separately). No `/sdd` subcommand applies them — the action is explicit and user-driven so source mutation gets a code-review surface.

**Sidecar lifecycle.** The sidecar is committed alongside the `[sdd-init]` scaffold so it appears in the initial PR for review. As the user applies markers, they MUST delete the corresponding row from the sidecar in the same commit that adds the inline marker. When the last row is removed, the file MUST be deleted entirely. A stale sidecar (rows for markers already applied) is a `doc-enforce-lanes` MEDIUM finding `adr-marker-sidecar-stale`; an empty sidecar (table with no rows) is auto-deleted on the next `doc-updater` pass.

Skip 6f entirely if `adr_marker_style: none` in `sdd/config.yml`. When skipped, do NOT write the sidecar (its presence is the signal that markers are pending).

**Why sidecar, not auto-write:** an inline marker at the wrong line (stale `get_node` position, refactored code) becomes a load-bearing pointer to nothing. The `[sdd-init]` scaffold commit must not silently mutate source. The sidecar is review surface; the user decides which markers land.

### Pass 6g — Glossary synonym mining

Extends Phase 5d synonym output. Phase 5d emitted synonym candidates into a temporary buffer. Phase 6g writes them to `documentation/README.md § Synonyms` table with `(canonical, [synonyms], where-defined)`. Concepts with no synonyms in the wild are NOT emitted (keeps the table honest).

### Pass 6h — Reciprocal cross-walk

After 6b populates the Source Module Map and 6d populates api-reference, walk every REQ with `Status: Implemented`. For each, find every doc location citing it (`Implements [REQ-X-NNN]`). Append `**Implemented in:**` field to the REQ in `sdd/{domain}.md` with a list of those file:section pointers.

**Output**: every Implemented REQ has the `Implemented in:` field. Verifiable.

### Pass 6i — Draft documentation files

Using the existing templates in `spec-driven-development/references/templates/` with substitutions from Passes 6a-6h. Empty template placeholders are filled from the pre-extraction outputs:

- `architecture.md`: § Source Module Map ← 6b; § Request Lifecycles ← 6c; § Cross-cutting Concerns ← 6e; § Build and Deploy ← inferred from package manifest
- `api-reference.md` (+ optional admin variant): ← 6d
- `configuration.md`: env var enumeration via grep
- `deployment.md`: per-stack deploy commands inferred from package manifest scripts
- `decisions/README.md`: ← 5c (founding ADRs); marker proposals go to sidecar via 6f
- `.adr-marker-proposals.md`: ← 6f (when `adr_marker_style != none`)
- `security.md` (if probe hit): ← cross-cutting concerns subset + threat model from REQ bodies
- `observability.md` (if probe hit): ← log-helper analysis
- `troubleshooting.md`: ← error path mine + common gotchas from README/CONTRIBUTING
- Per-subsystem lanes (if probe hit): ← graphify community subset of source module map

### Pass 6j — Iterate-to-clean (validation loop)

Same shape as 5f:

1. Write all drafted documentation files to working tree.
2. Invoke `doc-enforce` with `scope=all`. The skill runs the 14-row execution manifest and conditionally invokes `doc-enforce-lanes` + `doc-enforce-shape` + `doc-enforce-truth`.
3. Apply auto-fixes; for non-auto-fixable findings, re-run the corresponding 6a-6h operation.
4. Re-invoke `doc-enforce`.
5. Exit when zero CRITICAL/HIGH, max 5 iterations.
6. Iteration limit → write residuals to `documentation/.review-needed.md`, commit anyway.

**Cold-read tier (`doc-enforce-truth` Pass 12).** At scaffold time, cold-read runs via self-simulation only (the agent re-reads its own output cold, asks "does this make sense to a stranger?"). Failures land in `documentation/.review-needed.md` as advisory findings, do not block the scaffold commit. The full subagent-dispatched cold-read fires at PR boundary (existing).

### Fallback when graphify is absent

Same trigger as Phase 5 fallback. Each Phase 6 operation has a degraded path:

| Pass | Graphify-backed | Fallback |
|---|---|---|
| 6a lane probes | community detection for subsystem lanes | filesystem directory-density (>30 files in one subtree) for subsystem lanes |
| 6b source-module exhaustion | `get_node` + first-30-lines read | full filesystem walk + first-30-lines read |
| 6c lifecycle synthesis | `shortest_path` entry → write | grep per-language entry signatures; emit listing without flow synthesis |
| 6d endpoint enumeration | n/a (always source-walk) | same |
| 6e cross-cutting concerns | n/a (always probe-based) | same |
| 6f ADR marker proposals (sidecar) | `get_node` for ADR-target concept; emits sidecar with `confidence: high` | grep for the concept's name across source; emits sidecar with `confidence: low` |
| 6g synonym mining | graph clustering | string distance on identifier names |
| 6h reciprocal cross-walk | string match doc → REQ | same (no graphify dependence) |

The notice from Phase 5 fallback covers Phase 6 too — one notice per `/sdd init` run.

## Iterate-to-clean (shared subroutine)

Used by Phase 5f and Phase 6j. The contract:

1. **Write current draft to working tree** (uncommitted, on top of clean tree from start of `/sdd init`).
2. **Invoke validator** (`spec-enforce` for Phase 5; `doc-enforce` for Phase 6) with `scope=all`.
3. **Read findings**. Categorize:
   - Auto-fixable (mechanical rendering, missing fields, format gaps) → apply inline.
   - Extraction-required (missing Source Module Map row, missing Request Lifecycle, missing ADR for inline marker) → re-run the corresponding pre-extraction pass against the specific finding's target.
   - **Phase 5f only** — Split-induced cross-link breakage (a REQ that Phase 5b/5e linked was split by spec-enforce-ac's accretion guard; old anchor slug no longer resolves) → walk every REQ with Dependencies/Constraints pointing at the now-defunct slug, re-resolve against the split-children by re-querying graphify for the original concept neighborhood, rewrite the link to the child whose ACs cover the original concept. If both children cover it, link to both. Apply BEFORE re-invoking the validator. (Phase 6j does not mutate `sdd/`, so this rule is inert in the Phase 6j call site.)
   - JUDGMENT (genuine ambiguity, conflicting evidence) → write to `.review-needed.md`, do NOT auto-fix.
4. **Re-invoke validator**.
5. **Exit conditions**:
   - Zero CRITICAL and zero HIGH findings → loop terminates clean.
   - 5 iterations elapsed → write residuals to `.review-needed.md` (`sdd/.review-needed.md` for Phase 5; `documentation/.review-needed.md` for Phase 6) under header `Scaffold-time validator residuals`, terminate.
6. **Caching**. Validator runs cache by file SHA + mtime; iterations that don't touch a file inherit the prior result.

The loop is owned by `sdd-init`, not by the enforce skills themselves. Enforce skills remain single-pass.

## Dependency version resolution

(Unchanged from v1.0.)

When `/sdd init` generates a package manifest (`package.json`, `Cargo.toml`, `requirements.txt`, `go.mod`, etc.), NEVER emit memorized version ranges. Resolve each top-level dependency to current latest stable via the ecosystem's metadata tool:

| Ecosystem | Version query | Lockfile generation (scaffold-only carveout) |
|---|---|---|
| npm | `npm view <pkg> version` + `npm view <pkg> peerDependencies` | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` |
| Cargo | `cargo search <crate> --limit 1` | `cargo generate-lockfile` |
| Python | `pip index versions <pkg>` | `uv lock` or `pip-compile` |
| Go | `go list -m -versions <module>` | `go mod tidy` |

For Cloudflare Workers projects, see `cloudflare-stack` § Cloudflare cohort pinning — the 4-pack (wrangler + workers-types + vitest-pool-workers + vitest) must be resolved together before writing `package.json`.

Process (npm example):
1. For each proposed dependency, run `npm view <pkg> version` → capture latest.
2. Run `npm view <pkg> peerDependencies` → capture peer constraints.
3. Cross-check peer ranges: if two packages disagree, drop one to the highest co-compatible version rather than picking the latest of both.
4. Emit specific caret ranges: `^5.14.0`, never `^5.0.0` from memory.
5. Write `package.json`.
6. Run the lockfile generator ONCE (scaffold-only carveout).
7. Commit both manifest and lockfile.

**Local CPU carveout (`/sdd init` only):** the `no-local-builds` rule forbids local installs/builds/tests on the 1-vCPU container. The lockfile generator is a one-time exception because (a) CI's `npm ci` requires a committed lockfile, (b) Dependabot baseline needs a deterministic starting point, (c) the operation is resolution-only with `--ignore-scripts` (no `node_modules` populate, no script execution, no build). Applies ONLY during `/sdd init`. Every other local install/build/test remains forbidden.

**Forbidden at scaffold time:** `npm install` (full), `npm test`, `npm run build`, `tsc`, `cargo build`, `cargo test`, any test runner, any bundler.

## Configurable knobs (`sdd/config.yml`)

The defaults below ship in the `sdd-config.yml` template; per-project override is supported.

| Knob | Default | Purpose |
|---|---|---|
| `domain_community_threshold` | 50 | Min community size to propose as a top-level domain in Phase 5a |
| `subsystem_lane_threshold` | 50 | Min community size to emit a per-subsystem lane in Phase 6a |
| `subsystem_prefix_coherence` | 0.6 | Min fraction of community nodes that must share a directory/name prefix |
| `adr_marker_style` | `ad` | Inline ADR marker convention: `ad` / `cf` / `custom:PREFIX` / `none` |
| `scaffold_iteration_limit` | 5 | Max iterations for Phase 5f and 6j iterate-to-clean loops |

## Aborts

- `sdd/` already exists with no open triage items → abort, point user at `/sdd clean`.
- `sdd/` exists with open triage items → enter Resume Mode.

## Post-init hard gate: Plan Mode

After `/sdd init` (greenfield OR transition closure on the last triage item), the next action MUST be entering Plan Mode (Claude Code: `EnterPlanMode`). Hard gate. "build now" / "go" / "execute" never authorize skipping. See the `spec-driven-development` skill § Plan Mode integration for the plan structure (RED → GREEN → VERIFY).
