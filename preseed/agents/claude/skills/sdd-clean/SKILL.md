---
name: sdd-clean
description: Workflow for /sdd clean — rescuing a rotted spec. Mode-aware behaviors (interactive/auto/unleashed), safety nets, what gets cleaned, JUDGMENT auto-resolution rules. Invoked when /sdd clean runs. Requires the spec-driven-development skill for REQ format and Status semantics, and the spec-enforce skill family for the detection mechanics.
version: 1.0.0
---

# /sdd clean — rescuing a rotted spec

The rescue command for projects whose spec has accumulated implementation leakage, fake deprecations, prose Status fields, oversized REQs, and bloated changelogs.

**First action (binding):** invoke the `spec-enforce` skill (spine) with `scope=all` or `scope=diff` per the user's flag. The skill runs the 19-row execution manifest and conditionally invokes `spec-enforce-ac` (when ACs touched) and `spec-enforce-truth` (when Implemented or Partial REQs touched — Partial included so CQ-SOURCE can validate `@impl` anchors). This file describes what `/sdd clean` does on top of the skill's findings.

## What it does (per mode)

**interactive** — reports findings batch-by-batch, asks for confirmation before applying.

**auto** — applies SAFE and RISKY fixes silently on the current branch. JUDGMENT items go to the layout-resolved triage file (`sdd/spec/.review-queue.md` nested, `sdd/.review-needed.md` flat).

**unleashed** — applies SAFE + RISKY + JUDGMENT on the current branch (conservative defaults for JUDGMENT), commits per category, pushes directly. No new branch, no PR. If `enforce_tdd: false`, unleashed refuses to run and emits a finding asking the user to either flip the value or use `auto` instead. Commits land where the user pushed from.

## Safety nets (all modes)

- **Working tree must be clean** before running (refuses if `git status --porcelain` is non-empty).
- **Backup files** before any RISKY operation (e.g. `sdd/spec/changes.md` → `sdd/spec/changes-archive-YYYY-MM.md`; flat: `sdd/changes.md` → `sdd/changes-archive-YYYY-MM.md`).
- **Per-category commits** for selective revert.
- **`[sdd-clean]` commit prefix** that bypasses round-detection in spec-reviewer.
- **Sequential execution** — spec-reviewer first, then doc-updater.

Unleashed-specific:
- Pushes commits directly to the current branch (no new branch, no PR).
- Each commit is per-category and tagged `[sdd-clean]` — `git revert <sha>` is the rollback surface.
- Audit log lives in per-category commit bodies (`git log --grep='\[sdd-clean\]' -p`); no separate dotfile.

Both `auto` and `unleashed` push to whatever branch is checked out. User is responsible for the right branch before invoking.

## Conservative JUDGMENT auto-resolution (unleashed only)

When unleashed mode encounters a JUDGMENT call, it never picks a winner that overwrites intent:

| JUDGMENT type | Conservative resolution |
|---|---|
| Doc-vs-spec conflict | Mark BOTH the REQ and the related doc as `Status: Partial` with `Notes:` describing the conflict. Log to `sdd/spec/.review-queue.md` (nested) / `sdd/.review-needed.md` (flat). **Never overwrite either side.** |
| Oversized REQ by **line count** (>50 lines, bloated by implementation prose) | Shrink in place — extract implementation prose to the relevant lane file (`documentation/lanes/{file}.md` nested, `documentation/{file}.md` flat), leave Intent + AC verbatim. **This row does NOT cover oversize-by-AC-count.** REQs with >7 ACs are handled deterministically by `spec-enforce-ac` § Splitting by sub-feature (which DOES auto-split in `auto`/`unleashed`); they never enter the JUDGMENT path. |
| Fake-Deprecated REQ (no Replaced By) | Move REQ definition to README's `## Out of Scope` section, remove from domain file. Content preserved. |
| Truly ambiguous content | Mark `Partial` with `Notes:`, log to triage file. |
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
4. Consolidate prior dotfiles into `sdd/spec/.review-queue.md`: concatenate any non-empty contents of `sdd/.review-needed.md`, `sdd/.coverage-report.md`, `sdd/.last-clean-run.md`, `sdd/.review-decisions.md` under labelled sections (`## Escalations (from .review-needed.md)`, `## Coverage gaps (from .coverage-report.md)`, etc.). Then `git rm` the four dotfiles.
5. Move every `documentation/*.md` file EXCEPT `documentation/README.md` into `documentation/lanes/`. Use `git mv`. Keep `documentation/decisions/` as sibling (no move).
6. Rewrite cross-file backlinks throughout `sdd/spec/**/*.md`, `documentation/lanes/**/*.md`, `documentation/decisions/README.md`, root `README.md`. Use the Edit tool, never `sed`. Patterns:
   - `(../sdd/{file}.md)` → `(../sdd/spec/{file}.md)` (from documentation lanes pointing into spec)
   - `(../../sdd/{file}.md)` → `(../../sdd/spec/{file}.md)` (from decisions/README.md pointing into spec)
   - `(../documentation/{file}.md)` → `(../../documentation/lanes/{file}.md)` (from sdd/spec/*.md pointing into lanes)
   - `(documentation/{file}.md)` → `(documentation/lanes/{file}.md)` (from sdd/README.md pointing into lanes)
   - `(../documentation/decisions/README.md)` → `(../../documentation/decisions/README.md)` (relative depth increased by one)
7. Add migration entry to `sdd/spec/changes.md` under today's date (`SDD layout migrated from flat to nested. Single-commit mechanical move; cross-file backlinks rewritten.`).
8. Commit as a single commit with subject `[sdd-clean] migrate sdd to nested layout` and a body that lists every moved file + the count of rewritten backlinks. The `[sdd-clean]` prefix bypasses the spec-reviewer round counter.

**Idempotency.** Re-running `/sdd clean` on an already-nested layout: migration step is a no-op and exits silently before normal cleanup begins.

**Rollback surface.** Single commit; `git revert <sha>` restores flat layout. The framework continues to support flat-layout projects after rollback (skills are layout-aware).

**Migration ordering vs. other cleanup.** Layout migration runs FIRST in `/sdd clean` (before any other category). All subsequent cleanups operate against the nested layout. If migration is declined in interactive mode, the rest of `/sdd clean` runs against flat layout (still supported).

## What gets cleaned

**Cleanup order (binding).** Categories run in this fixed order; later passes consume earlier passes' output. Each pass commits independently with subject `[sdd-clean] <category>` so individual passes are revertable.

1. Layout migration (flat → nested, when applicable).
2. Shape rewrite (heading level, blank lines, field order, numbered ACs, anchor-linked cross-refs) — `spec-enforce` row 3 mechanics.
3. AC-cap split (>7 ACs) — `spec-enforce-ac` § Splitting by sub-feature.
4. **REQ anchor backfill** (legacy-spec @impl injection) — described below. Outputs feed pass 5.
5. **Test-anchor backfill** (REQ-ID comments on the test `describe`/`it` blocks of every annotated symbol) — described below.
6. Status revaluation — CQ-TEST runs on the now-anchored spec + now-annotated tests. Implemented REQs whose tests now reference the REQ ID pass; the residual flows to Coverage gaps triage. Status drift caught here is the TRUE coverage gap, not an artefact of the legacy anchor-less shape.
7. Implementation leakage extraction, false-positive ADR reclassification, changelog archival, doc backlink generation, fake-Deprecated cleanup.

Passes 4 and 5 are the legacy-import bridge. On a project where every REQ already carries `@impl` anchors and every test already mentions its REQ IDs they are both inert no-ops.

### Per-category mechanics

- **Strikethrough text** → stripped (git history is the strikethrough).
- **Prose Status fields** (multi-line status notes) → truncated to one word, prose moved to `pending.md` or `Notes:` field for `Partial` status.
- **Implementation leakage** (hex codes, CSS classes, file paths, function names, env vars) → moved to appropriate `documentation/` files.
- **Fake-Deprecated REQs** (Deprecated without `Replaced By:`) → moved to `## Out of Scope` in domain README (per the escalation rules above).
- **Oversized REQs by line count** (>50 lines, typically bloated by implementation prose) → flagged; in `unleashed`, implementation prose extracted to `documentation/` while Intent + AC stay verbatim. This rule fires on body size only.
- **Oversized REQs by AC count** (>7 ACs) → handled deterministically by `spec-enforce-ac` § Splitting by sub-feature, invoked from row 5 of the spec-enforce manifest. In `auto`/`unleashed`: 8-10 ACs are MEDIUM with auto-fix (attempt sibling merge, else split by sub-feature); >10 ACs are HIGH with mandatory auto-split. Split mechanics: Jaccard-cluster ACs by first-12-content-word overlap (≥0.25), dominant cluster keeps the original REQ ID, remaining clusters become sibling REQs with the next free IDs. Cross-refs in `documentation/` and `sdd/changes.md` rewrite in the same commit. Tests are NOT renamed (substring matching keeps coverage green).
- **Bloated `changes.md`** (verification log entries, commit SHAs, multi-paragraph entries) → archived to `sdd/changes-archive-YYYY-MM.md`, new file with user-facing entries only.
- **REQs missing `@impl` source anchors** (legacy specs that predate the anchor convention) → backfill from source in `auto`/`unleashed`. Mechanics:
  1. For each AC bullet without a trailing `<!-- @impl: ... -->` comment, extract candidate symbols from the bullet body: PascalCase identifiers, camelCase identifiers, `backtick`-quoted tokens, and explicit file path mentions.
  2. For each candidate, grep the source globs from `sdd/config.yml` `src_globs:` (defaults to `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs) for declaration patterns: `class X`, `function X`, `def X`, `const X =`, `interface X`, `export function X`, `func X(`, `fn X(`, etc. (language-aware by file extension).
  3. If exactly one declaration site matches: emit `<!-- @impl: <repo-relative-path>::<symbol> -->`. For ACs asserting a concrete numeric/string value, additionally grep the symbol body for the literal value pattern; on match, emit the `= <value-pattern>` tail.
  4. If multiple sites match: rank by Jaccard overlap (≥0.25) between the AC's first 12 content-words and each candidate's surrounding 50-token window. Pick the highest scorer. If a tie remains, defer to triage rather than guess.
  5. If zero sites match: leave the AC anchorless and emit MEDIUM `ac-anchor-unresolvable` to the layout-resolved triage file with Context = AC text + candidate symbols tried + globs scanned, Recommendation = "rewrite AC against the actual implementing symbol OR confirm the AC describes intent that no current code satisfies (Status -> Partial)".
  6. ADR `Context:` blocks get the same treatment.

  Severity: MEDIUM `req-missing-impl-anchors` per anchorless AC. Auto-fix in `auto`/`unleashed`: the backfill above. Interactive prompts per REQ before writing. Runs BEFORE test-anchor backfill below — the @impl anchors are that pass's input.

- **REQs missing REQ-ID test references** (CQ-TEST flags after @impl anchors exist) → backfill in `auto`/`unleashed`. Mechanics:
  1. For each REQ with at least one resolved `@impl` anchor, collect every `path::symbol` from its ACs and ADR `Context:` blocks.
  2. Grep `test_globs` (from `sdd/config.yml`) for any test file mentioning any collected symbol (word-bounded match).
  3. For each matching test file, locate the outermost `describe(...)` / `test(...)` / `it(...)` block whose body references the symbol. If no `describe` wraps the relevant `it`/`test`, target the `it`/`test` directly.
  4. Insert a comment line immediately preceding the located block: `// REQ-X-NNN: <REQ title>`. If a same-REQ comment already precedes the block, no-op (idempotent).
  5. For language-specific cases: Dart uses `///`, Python uses `#`, Go uses `//`, Ruby uses `#`. Plain `// REQ-...` is the canonical form for JS/TS.
  6. Test files are NOT renamed and `describe` titles are NOT mutated; the comment is the contract anchor that CQ-TEST greps. spec-enforce-truth's test-coverage check is a substring match on the REQ-ID literal, not a parser, so comments suffice.

  Severity: MEDIUM `req-test-anchor-missing` per REQ that had matchable symbols but no current REQ-ID mention. Auto-fix in `auto`/`unleashed`: the backfill above. Interactive prompts per test file before writing. REQs with zero matchable symbols in any test fall through to the `Coverage gaps` triage entry below — there is no test to annotate, the spec is genuinely uncovered.

- **Status: Implemented REQs without test coverage** → if `enforce_tdd: true`, demoted to `Partial` with `Notes:`; if `enforce_tdd: false`, written to the layout-resolved triage file (`sdd/spec/.review-queue.md` nested OR `sdd/.review-needed.md` flat legacy) under `## Coverage gaps` only. After the two backfill passes above run, this check fires against the residual — REQs that genuinely have no test, not just REQs that lacked the anchor.
- **Status: Planned/Partial REQs with source but no test** → if `enforce_tdd: true`, HIGH finding + auto-promote `Planned → Partial` with `Notes:`.
- **Test quality heuristics** → AC-count vs test-count check, tautology detection, skipped-test detection (run when `enforce_tdd: true`).
- **Missing doc→spec backlinks** → generated automatically.
- **False-positive ADRs** (SAST accommodations, naming-compat notes, risk acceptance with no alternative, implementation notes framed as decisions) → reclassified to canonical home (inline source comment, `troubleshooting.md`, `configuration.md`, or `security.md`). Original `### AD-N:` heading preserved as `Status: Reclassified` stub so inbound `AD-N` references keep resolving. Applied only by `/sdd clean` — PR-boundary doc-updater flags but never reclassifies (to avoid surprising the user mid-PR).

## Tool surface compatibility

Same as `sdd-init` — discovery commands run through the native Bash/Grep/Glob/Read tools available in the current runtime; file writes always use Write/Edit. Graph tools are shell-surface agnostic.
