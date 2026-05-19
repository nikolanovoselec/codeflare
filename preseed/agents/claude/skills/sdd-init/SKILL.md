---
name: sdd-init
description: Workflow for /sdd init bootstrap. Covers greenfield (lean two-confirm flow), Import Mode (two-output: REQs + triage), Resume Mode (drain triage queue), the Phase 5 enrichment pass (graphify-backed cross-link / ADR-seed / glossary-seed), and dependency version resolution. Invoked when /sdd init runs. Requires the spec-driven-development skill for REQ format, Status semantics, and templates.
version: 1.0.0
---

# /sdd init — bootstrapping a project

Three scenarios, auto-detected:

1. **Greenfield**: empty project, no existing code. Bootstrap from prose.
2. **Import**: project already has source, no `sdd/` yet. Enter **Import Mode** — derive a spec where behavior is clear from source/tests/comments/commits, file the unclear parts to `sdd/init-triage.md` with concrete Context + Recommendation, write the scaffolding.
3. **Resume**: `sdd/` exists and `sdd/init-triage.md` has `**Status:** open` items. Enter **Resume Mode** — surface one triage item at a time with refreshed Context.

Detect via source-file count (greenfield-vs-import) and presence of open triage items (resume).

## Greenfield — lean two-confirm flow

Compresses the old 10-15-turn back-and-forth into two decisions.

1. **Ask for vision** (one free-form question if `$ARGUMENTS` is empty). Confirm what you heard in one sentence.
2. **Draft the entire spec in memory** without further questions. Derive:
   - Actors (typically 2-3; User, Admin defaults; never "System")
   - Design principles (3-7 specific to this product, not generic)
   - Domains (5-12 with one-line summary + priority)
   - REQs per domain (5-15 each; canonical format from `spec-driven-development` skill; every field populated; `Constraints: None.` / `Dependencies: None.` explicit when empty)
   - CON-* constraints (tech stack, performance, security, observability)
   - Founding ADRs (3-8 seeded from vision + inferred stack)
   - Glossary terms (every product noun, vendor name, protocol mentioned in any REQ)
3. **Present the full draft as a single review surface**: tree of domain index + per-domain summary + ADR list + glossary. Ask one question: "Accept as-is, edit a section (name it), or restart?" On `edit <section>`: re-draft only that section, re-present, ask again. On `restart`: discard, return to step 1. Loop until accepted. Phase 5 enrichment runs once, only after final acceptance.
4. **Run Phase 5 enrichment in memory** (see Enrichment pass below).
5. **Write all files** from `references/templates/` in the `spec-driven-development` skill, substituting placeholders (`{PROJECT_NAME}`, `{ACTOR_1}`, `{INSTALL_COMMAND}`, etc.) inline from the vision + inferred stack as each template is written:
   - `root-readme.md` → `README.md`
   - `sdd-readme.md` → `sdd/README.md`
   - `sdd-glossary.md` → `sdd/glossary.md`
   - `sdd-constraints.md` → `sdd/constraints.md`
   - `sdd-changes.md` → `sdd/changes.md`
   - `sdd-config.yml` → `sdd/config.yml` (mode: interactive; `enforce_tdd: true` for greenfield)
   - `documentation-readme.md` → `documentation/README.md`
   - `documentation-architecture.md`, `-api-reference.md`, `-configuration.md`, `-deployment.md`
   - `documentation-decisions-readme.md` → `documentation/decisions/README.md` (seeded with founding ADRs)
   - One `sdd/{domain}.md` per drafted domain
   - Empty `sdd/.review-needed.md`, `.coverage-report.md`, `.last-clean-run.md` with `_Awaiting first run._` placeholder
   - Empty `tests/` directory
6. **Commit the scaffold** as one commit with subject `[sdd-init] initial spec scaffold`. The `[sdd-init]` prefix is excluded from the spec-reviewer round counter.
7. **Report next steps** to the user.

No internet needed — all templates live in the `spec-driven-development` skill's `references/templates/`.

## Import Mode — two-output model

The migration path from legacy manual coding to autonomous agentic coding. Two simultaneous outputs:

- **Official spec REQs** in `sdd/{domain}.md` — for behavior clearly determinable from the full discovery surface. Normal REQ shape, normal SDD discipline.
- **Triage entries** in `sdd/init-triage.md` — for unclear items (magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent). Each entry carries the agent's **Context** (file:line, git author, commit refs, related tests, PRs, issues, releases) and **Recommendation** (best-guess with one-line Rationale). The user reviews and decides; they don't archaeology from scratch.

**Discovery surface is the full project history**, not just source. Intent in legacy systems lives in PR descriptions, issue threads, code-review comments, release notes. Pull from: working tree (README, configs, source, tests, inline comments, ADRs), git history (commits, tags), and the GitHub corpus when a remote exists (PRs via `gh pr view --comments`, issues via `gh issue view --comments`, releases via `gh release view`, wiki via API). When a PR references an issue ("Closes #142"), Context follows the chain backward.

**Degradation when GitHub sources are unreachable.** Detect failure conditions up front (non-GitHub remote — GitLab / Bitbucket / Forgejo / Gerrit; `gh auth status` fails; rate-limited; private repo with insufficient token scope; air-gapped). On failure, skip the GitHub sources and proceed with working-tree + git-log evidence only. Print a one-line notice (`Note: discovery used working tree + git log only ({reason} - GitHub sources unavailable).`) and append the same to the `sdd/changes.md` import entry.

While `sdd/init-triage.md` contains `**Status:** open` items, the project is in **SDD transition**. Import Mode writes `sdd/config.yml` with `transition: true` and `enforce_tdd: false` at scaffold time (the two Import-Mode-specific config defaults; greenfield uses `transition: false` and `enforce_tdd: true`). During transition, the PR-boundary review pipeline is **entirely suspended**: code-reviewer, spec-reviewer, doc-updater do not fire. Mode-selector behavior during transition (specifically the `/sdd mode unleashed` rejection) is owned by the `spec-driven-development` skill's `/sdd mode` section — single source of truth, see there for the full rule.

When the queue drains to zero, `transition: true` clears automatically. Full SDD discipline applies on the next push. `enforce_tdd` is NOT auto-flipped — user sets it manually when ready (typically after adding REQ-ID test names). `sdd/init-triage.md` is preserved as the audit record.

Import Mode follows the **same lean two-confirm shape as greenfield**. Single user-facing question at step 1: "Derive from existing code, or treat as fresh start?". At step 3 user reviews the full inferred spec (vision pre-filled from README, derived domains, CLEAR REQs, triage queue summary, founding ADRs) and accepts or asks for edits.

**Status default for imported REQs:**
- `enforce_tdd: true` — Status defaults `Implemented` if a test mentions the REQ ID, `Partial` otherwise.
- `enforce_tdd: false` (Import Mode default) — Status defaults `Implemented` unconditionally when source exists. The project has opted out of test-based verification at import time; demoting every imported REQ to Partial would falsely brand the spec 65%+ incomplete. Each `sdd/{domain}.md` file (per domain, not the top-level `sdd/README.md`) receives a single footnote `_Verification: code-only (no automated coverage)._` at the bottom. Per-REQ `Notes:` are not used for this signal.

This rule applies during Import Mode and Resume Mode while `transition: true`. After transition closes, the normal `enforce_tdd` interaction in `spec-enforce-truth` governs Status assignment.

CLEAR REQs land in `sdd/{domain}.md` after the user accepts the draft. The confidence threshold (single matching domain, unambiguous behavior, clear evidence) is the gate; anything below became a triage entry. To correct any CLEAR REQ post-import, run `/sdd edit {domain}`.

Phase 5 enrichment runs in Import Mode too, after the draft is accepted and before files are written.

## Resume Mode — picking up where you left off

Re-invoking `/sdd init` on a project with open triage items enters Resume Mode.

1. **Working tree must be clean** (`git status --porcelain` empty). Refuse if not — Resume Mode commits per decision and would mix WIP edits with triage commits.
2. **Sanity-check transition state.** If `transition: true` is missing from `sdd/config.yml` but open items exist, restore quietly. If `transition: true` is set but `sdd/init-triage.md` is unreadable, abort with a recovery hint.
3. **Print a mode-auto notice** when `sdd/config.yml` says `mode: auto`: Resume Mode is always interactive; auto suspends for this run and resumes after the queue drains.
4. **Surface one item at a time** with **refreshed** Context (re-read source, re-check git log, re-fetch related PRs — the codebase may have evolved). User picks one of:
   - `accept` the recommendation → fold into the relevant REQ
   - `correct` it → free-form prose; agent folds purpose into REQ Intent and behavior into AC bullets named in the entry's `**Target REQ:**` field (no re-inference)
   - `lost` → one-line Reason required; the related REQ (if any) gets `Notes: intent lost during SDD transition - see TRIAGE-{NNN}`
   - `skip` → stays open, advance to next
   - `quit` → exit; prior decisions are already committed per-item

Only `accept` and `correct` promote anything to the official spec. Each decision is its own commit.

**Transition-closure step** after every resolved/lost decision. When zero `**Status:** open` remain:
- `transition: true` is cleared from `sdd/config.yml`
- A closure entry appends to `sdd/changes.md` (e.g., `SDD transition complete. {Total} triage items resolved ({R} accepted, {C} corrected, {L} lost).`)
- `enforce_tdd` is NOT changed (user flips manually when ready)
- Agent enters Plan Mode for the first feature work on top of the now-real spec

## Tool surface compatibility (binding for every `/sdd` sub-command)

Two surfaces — plain Bash and context-mode MCP. Every phase below MUST work on both.

- **Behavioural contract is tool-agnostic.** Skill describes WHAT, not WHICH shell wrapper.
- **In context-mode environments**, discovery commands >20 lines (e.g. `gh pr list --state all --limit 200`, `git log --follow`, full-tree scans, `npm view <pkg> peerDependencies`) MUST go through `mcp__context-mode__ctx_batch_execute` or `mcp__context-mode__ctx_execute`. Bare Bash will be denied.
- **In plain Bash environments**, same commands run via Bash directly.
- **File writes always use Write/Edit** — both surfaces accept these natively. Never construct file contents inside `ctx_execute` shell heredocs.
- **Scaffold-only lockfile carveout** (`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and equivalents) runs through `ctx_execute` in context-mode — output exceeds 20 lines. The `no-local-builds` rule permits this single resolution-only call at scaffold time.

## Enrichment pass (Phase 5 — binding for greenfield and Import Mode)

**Pre-condition: a graphify graph at `graphify-out/graph.json` is the load-bearing source of truth for this phase.** Per REQ-AGENT-025, the post-clone PostToolUse hook prompts the user to build one immediately after `git clone`. If missing at `/sdd init` time, prompt the user ONCE: "No graphify graph found. Build one now via `/graphify cluster-only` (AST-only, free, ~30s)? Or proceed with in-memory enrichment (less reliable cross-link density)?". On accept: dispatch `/graphify cluster-only` and wait. On decline: fallback (below).

After the draft exists in memory, run three passes in one cycle before writing files:

**a. Cross-link pass.** For every drafted REQ, call `mcp__graphify__get_neighbors(<concept-or-symbol>)` against every named concept, vendor, protocol, file, or symbol in its Intent or AC bullets. Returned neighbors that are other drafted REQs → lift into `Dependencies:` as `[REQ-X-NNN](#req-x-nnn-title-slug)`. Returned CON-* nodes → lift into `Constraints:` as `[CON-X-NNN](constraints.md#con-x-nnn-title-slug)`. Use `mcp__graphify__shortest_path` to validate non-obvious dependency edges before lifting.

**b. ADR-seed pass.** Call `mcp__graphify__god_nodes(top_n=20)`. Filter to nodes representing technology / framework / external service / pattern choices (drop pure files, drop generic primitives). Each survivor becomes a founding ADR candidate. Draft 3-8 ADRs covering tech stack, framework, deployment target, auth pattern, data store, key middleware, observability. Drop candidates that fail the "What is NOT an ADR" test from `documentation-decisions-readme.md` (no real alternative considered → not an ADR). Each ADR carries Status, Context, Decision, Alternatives, Rationale, Consequences, Related requirements.

**c. Glossary-seed pass.** Query the graph for concept-tagged nodes (`mcp__graphify__query_graph` with concept filter; graphify emits these with `source_file: null` when they represent vocabulary). Each becomes a one-line glossary entry in `sdd/glossary.md`. For nodes appearing under multiple labels in the graph (clustering identifies synonyms), record both in the synonym glossary slot of `documentation/README.md`.

The three passes run in one in-memory cycle. The user already accepted the full draft in step 3; enrichment does not re-prompt.

**Fallback: in-memory heuristic.** Fire fallback when ANY of:
1. `graphify-out/graph.json` is absent AND the user declined to build a graph.
2. `god_nodes(top_n=20)` returns zero nodes (graph exists but empty — fresh repo, build truncated). Same trigger if `query_graph` returns no concept nodes during glossary-seed.
3. Any `mcp__graphify__*` call errors (MCP server down, graph corrupt, permission denied).

Fallback behaviour: walk every drafted REQ; for every other REQ whose Intent or ACs reference the same concept by literal string, propose a `Dependencies:` entry. Same for CON-*. ADR-seed + glossary-seed derived by re-reading the draft, extracting nouns/vendors/protocols. Print: `Note: enrichment used in-memory heuristic ({reason}). Cross-link density may be lower than a graphify-backed run.` Append same notice to `sdd/changes.md`.

MCP graph tools are tool-agnostic across Bash and context-mode — no shell-wrapper required for graph queries. The fallback uses no shell tool at all.

## Dependency version resolution

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

## Aborts

- `sdd/` already exists with no open triage items → abort, point user at `/sdd clean`.
- `sdd/` exists with open triage items → enter Resume Mode.

## Post-init hard gate: Plan Mode

After `/sdd init` (greenfield OR transition closure on the last triage item), the next action MUST be entering Plan Mode (Claude Code: `EnterPlanMode`). Hard gate. "build now" / "go" / "execute" never authorize skipping. See the `spec-driven-development` skill § Plan Mode integration for the plan structure (RED → GREEN → VERIFY).
