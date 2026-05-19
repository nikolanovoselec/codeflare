# Spec Discipline

Applies when `sdd/` exists. Inert otherwise.

**Trigger:**
- PR-boundary event (PR opens or syncs against `main`/`master`) → spec-reviewer fires.
- `/sdd clean` invocation.
- Any `/sdd init` / `/sdd edit` / `/sdd add` invocation.

**Route:**
- `spec-driven-development` skill — workflow for all `/sdd` sub-commands.
- `spec-enforce` skill (spine) — runs the 18-row execution manifest on PR-boundary + `/sdd clean`. Conditionally invokes `spec-enforce-ac` (when ACs touched) and `spec-enforce-truth` (when Implemented REQs touched or scope=all).

## What the spec is

`sdd/` is the single source of truth for **what the product does and why**. Target state, not a record of current code or a bug tracker. Reader is a developer who already knows what the product does and needs to navigate the spec.

## Lane separation

`spec-reviewer` owns `sdd/` only. `doc-updater` owns `documentation/` + root `README.md`. Other agents (code-reviewer, etc.) own source. Sequential PR-boundary execution: spec-reviewer first, doc-updater second.

## Status vocabulary

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted |
| `Planned` | Committed, not yet built |
| `Partial` | Built but some AC unmet OR no automated verification |
| `Implemented` | Built AND tests verify the ACs |

One word, no prose. `Deprecated` is not valid; out-of-scope ideas go to "Out of Scope" in the domain README.

**Required REQ fields (all 8 always present):** Intent, Applies To, Acceptance Criteria, Constraints, Priority, Dependencies, Verification, Status. `Constraints` and `Dependencies` render as `None.` when empty.

## What is NOT a requirement

- **Bugs** → GitHub issues. Spec = target state; bugs = the delta.
- **TODOs / known gaps** → `pending.md`. Status: Partial flags incompleteness; prose detail there.
- **Spec churn** → git history. No strikethrough or "Superseded:" annotations.
- **Build-environment quirks** → `documentation/troubleshooting.md`.

## Severity / mode

| Severity | Mode interactive | Mode auto | Mode unleashed |
|---|---|---|---|
| CRITICAL / HIGH / MEDIUM | Confirm before fix | Auto-fix | Auto-fix |
| LOW | Confirm | Defer to `/sdd clean` | Auto-fix |
| JUDGMENT | Escalate, pause | Escalate to `.review-needed.md` | Auto-resolve conservatively |

Unleashed refuses to run on `enforce_tdd: false`. Working tree must be clean before any mode runs.

## Files alongside `sdd/`

`sdd/config.yml`, `sdd/.review-needed.md`, `sdd/.review-decisions.md`, `sdd/.coverage-report.md`, `sdd/.last-clean-run.md`, `sdd/changes-archive-*.md`, `sdd/init-triage.md`. All committed; nothing in `sdd/` is gitignored.

## Commit-prefix contract

Agent-authored commits MUST start with `[autonomous]`, `[unleashed]`, `[spec-reviewer]`, `[doc-updater]`, or `[code-reviewer]`. Excluded (bulk ops): `[sdd-clean]`, `[sdd-init]`, `[sdd-triage]`. Plain commits = user-authored, reset the round counter. Full 2-round-limit mechanics in `spec-enforce`.

Skipping enforcement-skill invocation when the trigger fires is itself HIGH `enforcement-skill-not-invoked`.
