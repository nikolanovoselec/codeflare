---
name: sdd-clean
description: Workflow for /sdd clean — rescuing a rotted spec. Mode-aware behaviors (interactive/auto/unleashed), safety nets, what gets cleaned (incl. per-AC @impl AND @test anchor backfill at parity, gated by enforce_tdd), JUDGMENT auto-resolution rules. Invoked when /sdd clean runs. Requires the spec-driven-development skill for REQ format and Status semantics, and the spec-enforce skill family for the detection mechanics.
version: 1.3.1
---

# /sdd clean — rescuing a rotted spec

The rescue command for projects whose spec has accumulated implementation leakage, fake deprecations, prose Status fields, oversized REQs, and bloated changelogs.

## Execution ownership (binding)

`/sdd clean` is a root-session mutation workflow in every mode. The root invokes `spec-enforce` and then `doc-enforce` inline, applies changes with its own file tools, and owns every commit and push. Never spawn the report-only `spec-reviewer` or `doc-updater` agents to perform cleanup.

**Preflight once:** resolve the repository, baseline, layout, scope, mode, existing decisions and current-branch push authorization. Refuse a dirty tree on a new invocation. Identify local cleanup/integrity checks and surface unavailable prerequisites or protected operations. Post-push CI is not a cleanup prerequisite: do not invent a CI-green-before-push gate, temporary validation branch or PR. Never install or bypass guards.

Invoke `spec-enforce` with explicit `purpose=clean` and the selected scope. Register its 24 rows, then execute them at the numbered cleanup stages below—not as an independent, competing sequence. After spec enforcement is accounted for, invoke `doc-enforce` inline for stage 8. Every applicable check still runs.

## Finite execution contract (binding)

- The eight numbered stages below are the single execution order. Track the active stage, evidence and finding dispositions in the existing manifest; finish each stage before advancing. A stage is accounted for when its checks ran and each finding is fixed or explicitly escalated, not when every product gap has been implemented.
- Inspect each in-scope item once per applicable check. Reuse source/test evidence across rows and batch compatible corrections. Reopen only checks directly invalidated by subsequent edits; do not restart discovery after commits or handoffs. Existing backlog entries are re-triaged once; newly emitted findings receive dispositions without recursively becoming new investigations.
- Cleanup changes representation, traceability and demonstrably stale metadata—not product behavior. No feature implementation, new test logic, acceptance infrastructure, SDK investigation, dependency change or deployment is implied. Explicitly requested remediation needs its own bounded approved behavior plan; do not silently grow this command into that work.
- Preserve contractual meaning during extraction, splitting and trimming. Existing implementation alone cannot authorize weakening the spec. Use a directly applicable user decision or accepted contract to resolve a conflict; otherwise preserve it and escalate with evidence and blast radius. Unleashed mode and an advisor do not enlarge authorization.
- A supported existing manual procedure may be linked or documented concisely. Missing observation controls or unclear coverage are findings, not invitations to invent probes, credentials, fixtures or qualification campaigns. Preserve the requirement's status and unresolved obligation; never fabricate a valid-looking field.
- Continuation resumes the same run at its first unfinished stage, retaining completed evidence. Known run-owned edits are not a new dirty-tree invocation; unrelated edits require reconciliation without overwriting them. Explicit stop pauses owned work and result adoption. Automatic Goal continuations and delayed notifications never authorize resumption.
- Finish the local pass as **Clean**, **Completed with escalations — not clean**, or **Blocked**, with actual cleanup checks and unresolved findings. Pending required rows cannot be called clean; an explicit requirement to resolve every finding remains binding. Local check failures reopen only affected checks. Cleanup completion is not runtime/CI acceptance.
- On completed authorized cleanup, commit the final local result and push the selected current branch. Prepare the manifest/summary before pushing. A successful final push is the last tool action: end the turn immediately. CI follows repository triggers independently of review eligibility. Boundary review occurs only if the pushed branch heads an open PR targeting `main`, `master` or `develop`; never create/reopen a PR or manually launch reviewers to obtain it. CI/review results, triage, fixes and green qualification belong to subsequent work, not this cleanup loop. A failed or explicitly withheld push is reported honestly, never as successful publication.

## Parallel execution (binding)

- Delegate independent named findings or manifest rows from the active stage while the root continues other stage work. Give each assignment an exact input set, permitted output and completion condition. Do not create assignments merely to replenish agents, repackage unresolved questions or explore adjacent features.
- Consume completed handoffs against retained evidence and actual changed regions before commissioning replacement work. Read additional bodies only for unresolved or invalidated evidence. Reports are not passing execution. Recover interrupted artifacts rather than repeating their investigation.
- Enforcement, repository mutations, commits and pushes remain root-owned. Do not substitute report-only cleanup agents. Existing authorization, TDD and CI gates remain binding; inherit model/reasoning settings unless the user explicitly requests otherwise. Leave `max_turns` unset unless the user requests a limit. Resume budget-interrupted assignments with retained context instead of restarting their investigation.
- Native completion notifications drive handoffs. Collect terminal results without polling in-flight agents, and validate each completed lane without waiting for all lanes to finish.

## What it does (per mode)

**interactive** — reports findings batch-by-batch, asks for confirmation before applying.

**auto** — applies SAFE and RISKY fixes silently on the current branch. JUDGMENT items go to the layout-resolved triage file (`sdd/spec/.review-queue.md` nested, `sdd/.review-needed.md` flat).

**unleashed** — applies SAFE + RISKY fixes and only the conservative JUDGMENT resolutions below, with per-category commits on the current branch. No new branch or PR. If `enforce_tdd: false`, refuse without changing it; ask the user to change the setting or use `auto`. Explicit user publication restrictions remain binding; absent such a restriction, the final cleanup push hands off to CI/review rather than waiting for them.

## Safety nets (all modes)

- **Working tree must be clean** before a new run; same-run continuation follows the finite execution contract above.
- **Backup files** before any RISKY operation (e.g. `sdd/spec/changes.md` → `sdd/spec/changes-archive-YYYY-MM.md`; flat: `sdd/changes.md` → `sdd/changes-archive-YYYY-MM.md`).
- **Per-category commits** for selective revert.
- **`[sdd-clean]` commit prefix** that bypasses round-detection in spec-reviewer.
- **Sequential inline enforcement** — the root runs `spec-enforce` first, then `doc-enforce`; PR-boundary reviewer agents are not involved.

Unleashed-specific:
- Finishes completed cleanup with the authorized current-branch push after local cleanup checks; no temporary validation branch, PR creation, CI dispatch or reviewer launch.
- Each commit is per-category and tagged `[sdd-clean]` — `git revert <sha>` is the rollback surface.
- Audit log lives in per-category commit bodies (`git log --grep='\[sdd-clean\]' -p`); no separate dotfile.

All modes finish completed cleanup with the authorized selected-branch push, unless the user explicitly withholds it. Local checkpoints and cleanup integrity checks do not claim CI/runtime GREEN. CI and any eligible PR-boundary review follow the push; monitoring or fixing them does not extend or restart `/sdd clean`.

## Conservative JUDGMENT auto-resolution (unleashed only)

When unleashed mode encounters a JUDGMENT call, it never picks a winner that overwrites intent:

| JUDGMENT type | Conservative resolution |
|---|---|
| Doc-vs-spec conflict | Preserve both sides and record the exact conflict in the live queue. Resolve only from a directly applicable authorized decision; do not invent a documentation Status field or demote implementation merely because evidence is ambiguous. |
| Oversized REQ by **line count** (>50 lines, bloated by implementation prose) | Shrink in place — extract implementation prose to the relevant lane file (`documentation/lanes/{file}.md` nested, `documentation/{file}.md` flat), leave Intent + AC verbatim. **This row does NOT cover oversize-by-AC-count.** REQs with >7 ACs are handled deterministically by `spec-enforce-ac` § Splitting by sub-feature (which DOES auto-split in `auto`/`unleashed`); they never enter the JUDGMENT path. |
| Deprecated REQ | Follow `spec-enforce`'s single deletion/successor rule. Preserve live clauses in the successor; retain only a one-line never-built idea in Out of Scope. Unclear removal authority escalates without deletion. |
| Truly ambiguous content | Preserve the contract and status; record the precise unanswered question, evidence and blast radius in triage. Actual implementation/coverage defects follow the shared Status rules, not uncertainty alone. |
| CQ-SOURCE Truth findings (anchor orphaned, value drift) | NEVER auto-resolve. Always escalate to triage with the searched anchor + actual source state. Truth is JUDGMENT by construction. |

The user comes back to new commits on the current branch, inspects per-category commits and the triage file, and can `git revert <sha>` per-category. No PR, no merge step.

## Layout migration (flat → nested)

When `/sdd clean` runs on a project with flat layout (`sdd/{domain}.md` files at top level, no `sdd/spec/` subdirectory), it offers migration to the nested canonical layout.

**Detection (binding):**

```bash
LAYOUT="nested"
[ -d sdd/spec ] || LAYOUT="flat"
```

If `LAYOUT=nested`, no migration needed; layout migration is a no-op. If `LAYOUT=flat` AND any `sdd/{domain}.md` file exists beyond `sdd/README.md`:

**Mode-dependent behaviour:**

| Mode | Behaviour |
|---|---|
| `interactive` | Prompt: "Detected flat layout. Migrate to nested (`sdd/spec/`) layout? Mechanical move + backlink rewrite + commit. (yes/no/show diff)" |
| `auto` | Silently migrate on first invocation. |
| `unleashed` | Silently migrate on first invocation. |

**Migration mechanics:**

1. Create `sdd/spec/` directory and `documentation/lanes/` directory via `mkdir -p`.
2. Move every `sdd/*.md` file EXCEPT `sdd/README.md` into `sdd/spec/`. Use `git mv` so history follows (per-file rename detection).
3. Move `sdd/config.yml` into `sdd/spec/config.yml`. Same for `sdd/.init-triage.md` if present.
4. Consolidate unresolved findings from `sdd/.review-needed.md`, `sdd/.coverage-report.md` and `sdd/.last-clean-run.md` into `sdd/spec/.review-queue.md`, preserving their obligations. Existing Git/audit history is not live debt. Keep append-only `sdd/.review-decisions.md` at its original path; never merge or delete decision history. Remove a replaced legacy queue only after every unresolved entry has a destination.
5. Move every `documentation/*.md` file EXCEPT `documentation/README.md` into `documentation/lanes/`. Use `git mv`. Keep `documentation/decisions/` as sibling (no move).
6. Rewrite cross-file backlinks throughout `sdd/spec/**/*.md`, `documentation/lanes/**/*.md`, `documentation/decisions/README.md`, root `README.md`. Use the Edit tool, never `sed`. Patterns:
   - `(../sdd/{file}.md)` → `(../sdd/spec/{file}.md)` (from documentation lanes pointing into spec)
   - `(../../sdd/{file}.md)` → `(../../sdd/spec/{file}.md)` (from decisions/README.md pointing into spec)
   - `(../documentation/{file}.md)` → `(../../documentation/lanes/{file}.md)` (from sdd/spec/*.md pointing into lanes)
   - `(documentation/{file}.md)` → `(documentation/lanes/{file}.md)` (from sdd/README.md pointing into lanes)
   - `(../documentation/decisions/README.md)` → `(../../documentation/decisions/README.md)` (relative depth increased by one)
7. Record the layout migration and backlink mapping in the migration commit body, not the product changelog.
8. Commit as a single commit with subject `[sdd-clean] migrate sdd to nested layout` and a body that lists every moved file + the count of rewritten backlinks. The `[sdd-clean]` prefix bypasses the spec-reviewer round counter.

**Idempotency.** On an already-nested layout, mark migration inert and advance to stage 2. Only migration is a no-op; do not exit the cleanup command.

**Rollback surface.** Single commit; `git revert <sha>` restores flat layout. The framework continues to support flat-layout projects after rollback (skills are layout-aware).

**Migration ordering vs. other cleanup.** Layout migration runs FIRST in `/sdd clean` (before any other category). All subsequent cleanups operate against the nested layout. If migration is declined in interactive mode, the rest of `/sdd clean` runs against flat layout (still supported).

## What gets cleaned

**Cleanup order (binding).** Categories run in this fixed order; later passes consume earlier passes' output. Each pass commits independently with subject `[sdd-clean] <category>` so individual passes are revertable.

1. Layout migration (flat → nested, when applicable).
2. Mechanical shape repair: headings, blank lines, field order, numbered ACs and linked references. Record field defects now; source/test/method truth depends on stages 4–6, not an invented target to satisfy shape.
3. AC quality: run all `spec-enforce-ac` rows, including cap, granularity, actor and concern checks; perform only lossless supported splits with complete reference mapping.
4. Source-anchor backfill and CQ-SOURCE: validate existing anchors/claims once, retrofit unambiguous missing owners and escalate actual contradictions. Outputs feed stage 5.
5. Test-anchor backfill and Verification methods: inspect actual eligible blocks, add traceability comments/precise spec-side anchors and normalize established automated/manual links. Preserve test titles/logic; unresolved coverage or methods go to live gaps.
6. Status revaluation and remaining truth checks: CQ-TEST/CQ-1 use the now-anchored spec and real behavioral evidence, never ID presence alone; run CQ-2/CQ-3 as applicable. Preserve legitimate manual status; record residual coverage and contract gaps without manufacturing closure.
7. Remaining spec cleanup: implementation leakage, ADR reclassification, changelog archival, backlinks, Deprecated handling and all remaining manifest rows, including structural integrity and one backlog re-triage. Confirm all 24 rows have evidence/dispositions before stage 8; escalations remain visible, not pending investigations.
8. Documentation normalization through `doc-enforce` and its 16 rows, using existing templates. Report newly discovered product/owner gaps rather than restarting spec discovery. Verify local cleanup integrity and directly invalidated checks, finalize the manifest and commit the result. The authorized final push ends the cleanup turn; post-push CI and conditional PR-boundary review are separate work.

Passes 4 and 5 are the legacy-import bridge. On a project where every REQ already carries `@impl` anchors, every AC carries a `@test` anchor (when `enforce_tdd: true`), and every test already mentions its REQ IDs they are both inert no-ops.

**Documentation normalization is collection-scoped.** Architecture component dossiers, API registers, configuration variables, security registers, deployment runbooks, observability signals, troubleshooting recipes, and ADR index/state records normalize toward the same templates `/sdd init` emits. Do not apply one dominant shape to an entire file. Preambles, narrative sections, diagrams, aliases, requirement/source maps, and project-lane subject matter remain intact. Existing `Command`/`Verifies` deployment fields are readable aliases for canonical `Action`/`Verify`; translate only by moving values byte-for-byte. Superseded ADR index entries are struck through without deleting their sections; partially superseded entries remain unstruck; merged or reclassified tombstones use the explicit `Redirect anchor` label and keep their destination links.

Before any documentation rewrite, account for every paragraph, table row, list item, diagram, link, compatibility fragment, REQ/ADR reference, and source anchor in the affected collection. If a destination is ambiguous or two facts conflict, emit a finding and leave the collection unchanged. `/sdd clean` never creates a baseline suppression or deletes content to satisfy shape.

### Strict field and documentation cleanup

Dependencies normalize during shape repair to exact linked prerequisite REQ/CON IDs or `None.`; never retain constraint paragraphs, implementation prose or verification evidence in that field. After the anchor bridge, normalize Verification from independently established tests and concrete existing methods. Reuse supported procedures rather than creating one acceptance project per REQ. If a method cannot be established, preserve the obligation and status, record the exact gap and advance; leave the unresolved field visibly nonconforming rather than inventing a target or an Implemented opt-out. Reformatting never promotes Status. Legitimate manual verification supports `Implemented`: do not demote implemented behaviour merely because its ACs use manual checks or lack automated tests. In mixed REQs, automated-coverage rules apply only to non-manual ACs. Missing or malformed verification guidance is a verification finding, not proof that behaviour is unimplemented; neither a marker nor an authored procedure proves execution.

Documentation normalization also enforces the complete SDD-domain/documentation-owner join and alphabetical indexes under `doc-enforce`. Preserve old links and aliases when creating or consolidating an owner. Remove session, commit, CI-run and experiment chronology from operational docs, retaining its existing Git/PR/CI/Vault history and routing current safety or qualification conditions to their proper requirements/procedures/live gaps. Never create an execution-report lane, duplicate normative authority, or delete load-bearing conditions to satisfy shape.

### Per-category mechanics

- **Strikethrough text** → stripped (git history is the strikethrough), except the ID and decision cells of a fully superseded ADR index row.
- **Prose Status fields** (multi-line status notes) → truncated to one word, prose moved to `pending.md` or `Notes:` field for `Partial` status.
- **Implementation leakage** (hex codes, CSS classes, file paths, function names, env vars) → moved to appropriate `documentation/` files.
- **Deprecated REQs** → use `spec-enforce`'s deletion/successor rule; preserve live clauses, keep only a one-line never-built idea in Out of Scope, and escalate unclear removal authority.
- **Oversized REQs by line count** (>50 lines, typically bloated by implementation prose) → flagged; in `unleashed`, implementation prose extracted to `documentation/` while Intent + AC stay verbatim. This rule fires on body size only.
- **Oversized REQs by AC count** (>7 ACs) → handled deterministically by `spec-enforce-ac` § Splitting by sub-feature, invoked from row 5 of the spec-enforce manifest. In `auto`/`unleashed`: 8-10 ACs are MEDIUM with auto-fix (attempt sibling merge, else split by sub-feature); >10 ACs are HIGH with mandatory auto-split. Split mechanics: Jaccard-cluster ACs by first-12-content-word overlap (≥0.25), dominant cluster keeps the original REQ ID, remaining clusters become sibling REQs with the next free IDs. Cross-refs in `documentation/` and `sdd/changes.md` rewrite in the same commit. Test filenames/titles remain unchanged; substring matching establishes traceability, never behavioral GREEN.
- **Bloated `changes.md`** (verification log entries, commit SHAs, multi-paragraph entries) → archived to `sdd/changes-archive-YYYY-MM.md`, new file with user-facing entries only.
- **REQs missing `@impl` source anchors** (legacy specs that predate the anchor convention) → backfill from source in `auto`/`unleashed`. Mechanics:
  1. For each AC bullet without a trailing `<!-- @impl: ... -->` comment, extract candidate symbols from the bullet body: PascalCase identifiers, camelCase identifiers, `backtick`-quoted tokens, and explicit file path mentions.
  2. For each candidate, grep the source globs from `sdd/config.yml` `src_globs:` (defaults to `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs) for declaration patterns: `class X`, `function X`, `def X`, `const X =`, `interface X`, `export function X`, `func X(`, `fn X(`, etc. (language-aware by file extension).
  3. If exactly one declaration site matches: emit `<!-- @impl: <repo-relative-path>::<symbol> -->`. For ACs asserting a concrete numeric/string value, additionally grep the symbol body for the literal value pattern; on match, emit the `= <value-pattern>` tail.
  4. If multiple sites match: rank by Jaccard overlap (≥0.25) between the AC's first 12 content-words and each candidate's surrounding 50-token window. Pick the highest scorer. If a tie remains, defer to triage rather than guess.
  5. If zero sites match: leave the AC anchorless and emit MEDIUM `ac-anchor-unresolvable` with the AC, candidates and searched globs. Recommend establishing its owner or adjudicating the implementation gap; never rewrite the intended behavior merely to fit a found symbol.
  6. ADR `Context:` blocks get the same treatment.

  Severity: MEDIUM `req-missing-impl-anchors` per anchorless AC. Auto-fix in `auto`/`unleashed`: the backfill above. Interactive prompts per REQ before writing. Runs BEFORE test-anchor backfill below — the @impl anchors are that pass's input.

- **REQs missing REQ-ID test references** (CQ-TEST flags after @impl anchors exist) → backfill in `auto`/`unleashed`. Mechanics:
  1. For each REQ with at least one resolved `@impl` anchor, collect every `path::symbol` from its ACs and ADR `Context:` blocks.
  2. Grep `test_globs` (from `sdd/config.yml`) for any test file mentioning any collected symbol (word-bounded match).
  3. For each matching test file, locate the outermost `describe(...)` / `test(...)` / `it(...)` block whose body references the symbol. If no `describe` wraps the relevant `it`/`test`, target the `it`/`test` directly.
  4. Insert a comment line immediately preceding the located block: `// REQ-X-NNN: <REQ title>`. If a same-REQ comment already precedes the block, no-op (idempotent).
  5. For language-specific cases: Dart uses `///`, Python uses `#`, Go uses `//`, Ruby uses `#`. Plain `// REQ-...` is the canonical form for JS/TS.
  6. Test files and block titles remain unchanged. REQ-ID comments provide discovery/traceability only; they do not establish coverage. CQ-TEST/CQ-1 require independently verified behavioral assertions and actual resolving blocks. Repair spec-side block references when needed, never rename tests merely to satisfy an ID check.

  Severity: MEDIUM `req-test-anchor-missing` per REQ that had matchable symbols but no current REQ-ID mention. Auto-fix in `auto`/`unleashed`: the backfill above. Interactive prompts per test file before writing. REQs with zero matchable symbols in any test fall through to the `Coverage gaps` triage entry below — there is no test to annotate, the spec is genuinely uncovered.

- **ACs missing per-AC `@test` anchors** (the test parallel of the `@impl` backfill above; only when `enforce_tdd: true`) → backfill in `auto`/`unleashed`. Mechanics:
  1. For each AC carrying a resolved `<!-- @impl: <path>::<symbol> -->` anchor, reuse the symbol→test-block resolution from the REQ-ID backfill above: grep `test_globs` for the symbol, then locate the outermost `describe`/`test`/`it` block whose body references it.
  2. If one or more independently verified strong blocks resolve, emit one `<!-- @test: <test-path> (<block-title>) -->` per block inline on the AC, alongside its `@impl` anchors (copy each block title verbatim, parentheses and all). Deduplicate exact path/title pairs and order them by test path then block title. No strong block, or ambiguous candidates: leave the AC unanchored and route to `## Coverage gaps`.
  3. Idempotent: an AC that already carries at least one `@test` anchor is a no-op; existing anchors are not expanded into an exhaustive test inventory.

  Severity: MEDIUM `ac-missing-test-anchor` per anchorless AC (the parallel of pass 4's `req-missing-impl-anchors`). Runs AFTER the `@impl` backfill — those anchors are this pass's input — and produces the spec-side `@test` anchors that the per-AC CQ-TEST check then verifies. Interactive prompts per REQ before writing. Gated by `enforce_tdd: true`; when `false`, write `ac-missing-test-anchor` entries to the `## Coverage gaps` triage section instead of mutating the spec.

- **Status: Implemented REQs whose non-manual ACs lack required automated coverage** → if `enforce_tdd: true`, demoted to `Partial` with `Notes:`; if `enforce_tdd: false`, written to the layout-resolved triage file (`sdd/spec/.review-queue.md` nested OR `sdd/.review-needed.md` flat legacy) under `## Coverage gaps` only. After the two backfill passes above run, this check fires against the residual — REQs that genuinely have no test, not just REQs that lacked the anchor.
- **Status: Planned/Partial REQs with source but no required non-manual test coverage** → if `enforce_tdd: true`, HIGH finding + auto-promote `Planned → Partial` with `Notes:`.
- **Test quality heuristics** → AC-count vs test-count check, tautology detection, skipped-test detection (run when `enforce_tdd: true`).
- **Missing doc→spec backlinks** → generated automatically.
- **False-positive ADRs** (SAST accommodations, naming-compat notes, risk acceptance with no alternative, implementation notes framed as decisions) → reclassified to canonical home (inline source comment, `troubleshooting.md`, `configuration.md`, or `security.md`). Original `### AD-N:` heading preserved as `Status: Reclassified` stub so inbound `AD-N` references keep resolving. Applied only by `/sdd clean` — PR-boundary doc-updater flags but never reclassifies (to avoid surprising the user mid-PR).

## Tool surface compatibility

Same as `sdd-init` — discovery commands run through the native Bash/Grep/Glob/Read tools available in the current runtime; file writes always use Write/Edit. Graph tools are shell-surface agnostic.
