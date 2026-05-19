---
name: sdd-clean
description: Workflow for /sdd clean — rescuing a rotted spec. Mode-aware behaviors (interactive/auto/unleashed), safety nets, what gets cleaned, JUDGMENT auto-resolution rules. Invoked when /sdd clean runs. Requires the spec-driven-development skill for REQ format and Status semantics, and the spec-enforce skill family for the detection mechanics.
version: 1.0.0
---

# /sdd clean — rescuing a rotted spec

The rescue command for projects whose spec has accumulated implementation leakage, fake deprecations, prose Status fields, oversized REQs, and bloated changelogs.

**First action (binding):** invoke the `spec-enforce` skill (spine) with `scope=all` or `scope=diff` per the user's flag. The skill runs the 18-row execution manifest and conditionally invokes `spec-enforce-ac` (when ACs touched) and `spec-enforce-truth` (when Implemented REQs touched). This file describes what `/sdd clean` does on top of the skill's findings.

## What it does (per mode)

**interactive** — reports findings batch-by-batch, asks for confirmation before applying.

**auto** — applies SAFE and RISKY fixes silently on the current branch. JUDGMENT items go to `sdd/.review-needed.md`.

**unleashed** — applies SAFE + RISKY + JUDGMENT on the current branch (conservative defaults for JUDGMENT), commits per category, pushes directly. No new branch, no PR. If `enforce_tdd: false`, unleashed refuses to run and emits a finding asking the user to either flip the value or use `auto` instead. Commits land where the user pushed from.

## Safety nets (all modes)

- **Working tree must be clean** before running (refuses if `git status --porcelain` is non-empty).
- **Backup files** before any RISKY operation (e.g. `sdd/changes.md` → `sdd/changes-archive-YYYY-MM.md`).
- **Per-category commits** for selective revert.
- **`[sdd-clean]` commit prefix** that bypasses round-detection in spec-reviewer.
- **Sequential execution** — spec-reviewer first, then doc-updater.

Unleashed-specific:
- Pushes commits directly to the current branch (no new branch, no PR).
- Each commit is per-category and tagged `[sdd-clean]` — `git revert <sha>` is the rollback surface.
- Full audit log in `sdd/.last-clean-run.md` + per-category commit messages.

Both `auto` and `unleashed` push to whatever branch is checked out. User is responsible for the right branch before invoking.

## Conservative JUDGMENT auto-resolution (unleashed only)

When unleashed mode encounters a JUDGMENT call, it never picks a winner that overwrites intent:

| JUDGMENT type | Conservative resolution |
|---|---|
| Doc-vs-spec conflict | Mark BOTH the REQ and the related doc as `Status: Partial` with `Notes:` describing the conflict. Log to `sdd/.review-needed.md`. **Never overwrite either side.** |
| Oversized REQ refactor | Shrink in place — extract implementation prose to `documentation/{relevant-file}.md`, leave Intent + AC verbatim. **Never split into multiple REQs.** |
| Fake-Deprecated REQ (no Replaced By) | Move REQ definition to README's `## Out of Scope` section, remove from domain file. Content preserved. |
| Truly ambiguous content | Mark `Partial` with `Notes:`, log to `sdd/.review-needed.md`. |

The user comes back to new commits on the current branch, inspects per-category commits and `sdd/.review-needed.md`, and can `git revert <sha>` per-category. No PR, no merge step.

## What gets cleaned

- **Strikethrough text** → stripped (git history is the strikethrough).
- **Prose Status fields** (multi-line status notes) → truncated to one word, prose moved to `pending.md` or `Notes:` field for `Partial` status.
- **Implementation leakage** (hex codes, CSS classes, file paths, function names, env vars) → moved to appropriate `documentation/` files.
- **Fake-Deprecated REQs** (Deprecated without `Replaced By:`) → moved to `## Out of Scope` in domain README (per the escalation rules above).
- **Oversized REQs** (>50 lines) → flagged; in unleashed, implementation prose extracted to docs while Intent + AC stay verbatim.
- **Bloated `changes.md`** (verification log entries, commit SHAs, multi-paragraph entries) → archived to `sdd/changes-archive-YYYY-MM.md`, new file with user-facing entries only.
- **Status: Implemented REQs without test coverage** → if `enforce_tdd: true`, demoted to `Partial` with `Notes:`; if `enforce_tdd: false`, written to `sdd/.coverage-report.md` only.
- **Status: Planned/Partial REQs with source but no test** → if `enforce_tdd: true`, HIGH finding + auto-promote `Planned → Partial` with `Notes:`.
- **Test quality heuristics** → AC-count vs test-count check, tautology detection, skipped-test detection (run when `enforce_tdd: true`).
- **Missing doc→spec backlinks** → generated automatically.
- **False-positive ADRs** (SAST accommodations, naming-compat notes, risk acceptance with no alternative, implementation notes framed as decisions) → reclassified to canonical home (inline source comment, `troubleshooting.md`, `configuration.md`, or `security.md`). Original `### AD-N:` heading preserved as `Status: Reclassified` stub so inbound `AD-N` references keep resolving. Applied only by `/sdd clean` — PR-boundary doc-updater flags but never reclassifies (to avoid surprising the user mid-PR).

## Tool surface compatibility

Same as `sdd-init` — discovery commands >20 lines route through `ctx_execute` in context-mode environments; file writes always via Write/Edit. MCP graph tools are tool-agnostic.
