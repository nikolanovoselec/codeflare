---
name: git-review-pipeline
description: SDD-mode review pipeline mechanics. PR-boundary trigger semantics, the three agents (code-reviewer, spec-reviewer, doc-updater), execution order (all three lanes run in parallel — report-only, the main session applies fixes), branch-protection setup commands. Invoked at PR-boundary events when sdd/ is bootstrapped, and when configuring branch protection on a new repo.
version: 1.0.0
---

# SDD Review Pipeline

Carries the detailed mechanics of the SDD-mode review pipeline. The core `git-workflow.md` rule states the gating contract; this skill carries the execution order, PR-boundary semantics, and branch-protection setup.

## PR-boundary trigger semantics (SDD mode)

Review fires on PRs that target `main`, `master`, or `develop`. PRs into any other integration branch (for example `staging`) defer until that branch opens or syncs a PR to one of those protected bases.

| Checked-out branch state | What fires |
|---|---|
| Open PR to `main`, `master`, or `develop`; authoritative PR head equals local `HEAD`; head is unacknowledged | Required review lanes and independent CI |
| Same authoritative head already acknowledged for that PR | Nothing |
| No open protected-base PR, detached HEAD, nonstandard worktree, or remote head not synchronized locally | Nothing |
| After a merge, switch to and synchronize the merge-target branch; its open protected-base PR now has a new exact local head | Required review lanes and independent CI |

The cost model is per protected-base PR head: each authoritative head is reviewed once, independent of the Git or GitHub CLI syntax that exposed it. Successful `git push` and `gh pr create` delivery boundaries launch review and CI automatically; non-delivery Git/GitHub activity alone requires consent.

## Recommended workflow

```
feature --> PR --> develop --> PR --> main
             ^                   ^
             review fires        review fires
             at open + sync      at open + sync
```

The repository may permit direct fast-forward repairs on `develop`; deletion and non-fast-forward updates remain blocked. Direct push to `main` should be prevented at the GitHub layer (see Branch protection below) rather than worked around in-session.

The `git-push-review-reminder.sh` PostToolUse hook checks for `sdd/` + `sdd/README.md`, treats executable `git` and `gh` commands as candidates, and emits only after the checked-out branch, local `HEAD`, and authoritative open PR head agree. The `enforce-review-spawn.sh` Stop hook repeats the same state check before entering the existing acknowledgement, triage, and FIX lifecycle. Both use PR-number-specific checkpoints. On non-SDD projects the hooks exit silently.

To manually invoke code-reviewer or doc-updater on a non-SDD project (e.g., to audit code quality or maintain a `documentation/` folder by hand), use the Task tool directly with the agent name. The automatic PR-boundary workflow is the only thing that's gated.

## Execution order when SDD is bootstrapped (full parallelism)

All three review agents run **in parallel** — `code-reviewer` (source lane), `spec-reviewer` (`sdd/` lane), and `doc-updater` (`documentation/` + root `README.md` lane).

**Why parallel:** review agents are **report-only**. Each returns one complete structured report to the root session and writes no project, triage, or review-artifact files. The root waits for every required lane notification to reach its visible context, persists any deferred findings, applies legitimate fixes, and alone owns Git. With immutable reviewer inputs there is no shared-write race or ordering dependency.

## Finding triage (root-owned, after ALL lanes return)

Do not act on a subset of required reviewer outputs. Wait until every required lane has returned, then assess all findings together in one visible triage summary BEFORE any mutation: one line per finding — lane, severity, category, decision (`fix` / `reject (evidence)` / `defer` / `debt`), so the user sees every decision without reading the raw reports.

A terminal background record can reach the transcript before its native notification reaches the root. The first Stop observation of a newly complete round ends silently to let queued reports arrive; triage and acknowledgement happen only afterward. If a report remains absent, retrieve it with `Read` or `TaskOutput` before the final tool-free table.

Finding validity and proposed-fix validity are separate decisions: a real issue can still carry an unnecessary or overengineered correction. Prefer an existing implementation path before adding machinery; reject unsupported or oversized proposals with evidence while still fixing the underlying finding minimally. Fix every legitimate finding by default; record exactly one decision per finding; defer, reject, and debt decisions persist to `sdd/.review-decisions.md` (the `/review` triage-history contract). Ask before acting only when the user explicitly requested approval or the change is destructive or irreversible. (This mirrors the Pi pipeline's Finding-discipline contract, so both agents hand review results to the root under identical rules.)

After acknowledgement, the separate FIX turn applies only accepted decisions. If files change, the root verifies focused static checks, commits, and pushes the checked-out PR branch without asking again; that delivery push starts exactly one incremental review wave and one CI monitor. The runner binds each lane to the PR-specific acknowledged-head-to-current-head range even if a stale `--base` argument is supplied. Never relaunch an in-flight lane, never merge automatically, and create no commit or push when no fix was accepted.

## The three agents (SDD mode only)

1. **code-reviewer**: reviews code quality, security, correctness. Invokes `tdd-enforce` for test files.
2. **spec-reviewer**: reviews `sdd/` as the single source of truth, returns drafted REQs, AC edits, status corrections, changelog entries, and `spec-enforce` findings without writing files.
3. **doc-updater**: reviews documentation against the same immutable range, returns drafted route/configuration/architecture updates and REQ backlinks, and invokes the `doc-enforce` family without writing files. It never runs automatically on non-SDD projects.

## Branch protection on main (proactive surfacing during CI setup)

When the agent is helping the user set up CI for a new repository (adding `.github/workflows/`, configuring required checks, drafting a release process, or auditing an existing repo's CI), **proactively surface the branch-protection conversation**. Don't wait for the user to ask. The protection is the **actual enforcement** that makes the PR-boundary trigger model complete; without it, direct pushes to `main` silently bypass both the review pipeline and the GitHub Actions checks that gate merges.

Surface it as a one-paragraph explanation followed by a concrete proposal. Example phrasing:

> "Before this CI is meaningful, `main` needs branch protection turned on. Right now anyone with push access can land code on `main` without a PR, which means CI never runs on the change and the SDD review pipeline never sees it. Want me to enable branch protection on `main` (require PR before merge, require these CI checks to pass, require branch up-to-date before merge)?"

If the user says yes, configure via `gh api`:

```bash
gh api -X PUT "repos/{owner}/{repo}/branches/main/protection" \
  --input branch-protection.json
```

Recommended `branch-protection.json` settings (adjust `required_status_checks.contexts` to match the actual workflow job names from `.github/workflows/`):

- **Require a pull request before merging**: `required_pull_request_reviews` enabled, `required_approving_review_count: 0` (the SDD review pipeline does the substantive review; this just enforces the PR gate)
- **Require status checks to pass before merging**: list each required CI workflow's job name in `contexts`
- **Require branches to be up to date before merging**: `strict: true` (forces rebase-on-main before merge so CI reflects the merged state, not the pre-merge state)
- **Enforce for administrators**: `enforce_admins: true` (otherwise you'll quietly bypass it yourself when convenient)
- **Restrict pushes that create files**: optional, project-specific

The PR-boundary trigger model assumes branch protection is in place. If the user declines, document it as a project-level workflow decision (ADR or `documentation/decisions/`) so future contributors know the protection is intentionally off, not just forgotten.

## Binding invocation rule

The PostToolUse hook (`git-push-review-reminder.sh`) emits the three-agent directive when an SDD-mode PR-boundary trigger fires. On receipt, run the emitted boundary commands unchanged, launch all required lanes together, wait for every delivered report, and keep all file/Git writes in the root session. This skill is the operational reference; the directive itself is non-negotiable.
