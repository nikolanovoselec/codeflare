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

**auto** — applies SAFE and RISKY fixes silently on the current branch. JUDGMENT items go to the layout-resolved triage file (`sdd/spec/triage.md` nested, `sdd/.review-needed.md` flat).

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
| Doc-vs-spec conflict | Mark BOTH the REQ and the related doc as `Status: Partial` with `Notes:` describing the conflict. Log to `sdd/spec/triage.md` (nested) / `sdd/.review-needed.md` (flat). **Never overwrite either side.** |
| Oversized REQ refactor | Shrink in place — extract implementation prose to the relevant lane file (`documentation/lanes/{file}.md` nested, `documentation/{file}.md` flat), leave Intent + AC verbatim. **Never split into multiple REQs.** |
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
3. Move `sdd/config.yml` into `sdd/spec/config.yml`. Same for `sdd/init-triage.md` if present.
4. Consolidate prior dotfiles into `sdd/spec/triage.md`: concatenate any non-empty contents of `sdd/.review-needed.md`, `sdd/.coverage-report.md`, `sdd/.last-clean-run.md`, `sdd/.review-decisions.md` under labelled sections (`## Escalations (from .review-needed.md)`, `## Coverage gaps (from .coverage-report.md)`, etc.). Then `git rm` the four dotfiles.
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

- **Strikethrough text** → stripped (git history is the strikethrough).
- **Prose Status fields** (multi-line status notes) → truncated to one word, prose moved to `pending.md` or `Notes:` field for `Partial` status.
- **Implementation leakage** (hex codes, CSS classes, file paths, function names, env vars) → moved to appropriate `documentation/` files.
- **Fake-Deprecated REQs** (Deprecated without `Replaced By:`) → moved to `## Out of Scope` in domain README (per the escalation rules above).
- **Oversized REQs** (>50 lines) → flagged; in unleashed, implementation prose extracted to docs while Intent + AC stay verbatim.
- **Bloated `changes.md`** (verification log entries, commit SHAs, multi-paragraph entries) → archived to `sdd/changes-archive-YYYY-MM.md`, new file with user-facing entries only.
- **Status: Implemented REQs without test coverage** → if `enforce_tdd: true`, demoted to `Partial` with `Notes:`; if `enforce_tdd: false`, written to the layout-resolved triage file (`sdd/spec/triage.md` nested OR `sdd/.review-needed.md` flat legacy) under `## Coverage gaps` only.
- **Status: Planned/Partial REQs with source but no test** → if `enforce_tdd: true`, HIGH finding + auto-promote `Planned → Partial` with `Notes:`.
- **Test quality heuristics** → AC-count vs test-count check, tautology detection, skipped-test detection (run when `enforce_tdd: true`).
- **Missing doc→spec backlinks** → generated automatically.
- **False-positive ADRs** (SAST accommodations, naming-compat notes, risk acceptance with no alternative, implementation notes framed as decisions) → reclassified to canonical home (inline source comment, `troubleshooting.md`, `configuration.md`, or `security.md`). Original `### AD-N:` heading preserved as `Status: Reclassified` stub so inbound `AD-N` references keep resolving. Applied only by `/sdd clean` — PR-boundary doc-updater flags but never reclassifies (to avoid surprising the user mid-PR).

## Tool surface compatibility

Same as `sdd-init` — discovery commands >20 lines route through `ctx_execute` in context-mode environments; file writes always via Write/Edit. MCP graph tools are tool-agnostic.
