---
name: git-review-pipeline
description: SDD-mode review pipeline mechanics. PR-boundary trigger semantics, the three agents (code-reviewer, spec-reviewer, doc-updater), execution order (code-reviewer parallel; spec-reviewer then doc-updater sequential), branch-protection setup commands. Invoked at PR-boundary events when sdd/ is bootstrapped, and when configuring branch protection on a new repo.
version: 1.0.0
---

# SDD Review Pipeline

Carries the detailed mechanics of the SDD-mode review pipeline. The core `git-workflow.md` rule states the gating contract; this skill carries the execution order, PR-boundary semantics, and branch-protection setup.

## PR-boundary trigger semantics (SDD mode)

Review fires only on PRs that target `main` or `master`. PRs into an integration branch (`develop`, `staging`, etc.) are deferred until the integration branch's own PR-to-main opens or syncs - the cumulative review at that point covers everything that landed.

| Action | PR base | What fires |
|---|---|---|
| `gh pr create --base main` | main | code-reviewer + spec-reviewer + doc-updater (full pipeline) |
| `gh pr create --base develop` | develop | nothing (deferred) |
| `git push` to a branch with open PR -> main | main | full pipeline (PR-sync) |
| `git push` to a branch with open PR -> master | master | full pipeline (PR-sync) |
| `git push` to a branch with open PR -> develop | develop | nothing (deferred - review fires when develop -> main PR opens or syncs) |
| `git push` to a branch with no open PR | - | nothing (deferred until PR opens) |
| `git push` to `develop` directly | - | nothing (caught by the develop -> main PR later) |
| `git push` to `main`/`master` with no PR | - | nothing (user is expected to have branch protection on; if off, manual verification is on the user) |

The cost model shifts from per-push (every commit pair burned a full review) to **per-main-bound PR** (one review at the moment the change is destined for `main`, one per push while that PR is open). Same coverage, ~10x fewer review tokens than per-push, ~2x fewer than per-any-PR.

## Recommended workflow

```
feature --> PR --> develop --> PR --> main
   ^                              ^
   you push                       review fires
   (no review yet)                at PR open + each sync push
```

Direct push to `develop` is fine; the develop -> main PR catches the cumulative diff. Direct push to `main` should be prevented at the GitHub layer (see Branch protection below) rather than worked around in-session.

The `git-push-review-reminder.sh` PostToolUse hook enforces this: checks for `sdd/` + `sdd/README.md`, classifies the trigger (`gh pr create` -> poll gh for the just-created PR's base; `git push` -> `gh pr view` -> check state OPEN AND base IN (main, master)), and emits the three-agent directive only when the trigger fires. On non-SDD projects the hook exits silently and no agents are spawned.

The `enforce-review-spawn.sh` Stop hook is the safety net: calls `gh pr view` at turn end and blocks the turn from ending only if a PR-to-main has an un-acked HEAD with the required agents not spawned. Same base gate (main/master only).

Branch-tracking note: the hook's cheap-path `@{u}` short-circuit relies on the current branch having upstream tracking (`git rev-parse @{u}` must resolve). Vanilla `git clone https://github.com/owner/repo.git` sets this up automatically. If you manually create a branch with `git checkout -B <branch>` (no `--track`), repair tracking once with `git branch --set-upstream-to=origin/<branch> <branch>`. The hook still works without it (falls back to `gh pr view`), just pays an extra 200-500ms per Stop event.

To manually invoke code-reviewer or doc-updater on a non-SDD project (e.g., to audit code quality or maintain a `documentation/` folder by hand), use the Task tool directly with the agent name. The automatic PR-boundary workflow is the only thing that's gated.

## Execution order when SDD is bootstrapped (partial parallelism)

1. **code-reviewer** runs in parallel with the others (it touches source code only, not `sdd/` or `documentation/`)
2. **spec-reviewer** runs FIRST among the docs/spec agents
3. **doc-updater** runs SECOND, AFTER spec-reviewer has finished (sequential to spec-reviewer)

**Why sequential between spec-reviewer and doc-updater:** both may touch related files (spec-reviewer may move REQs, doc-updater may generate cross-references to those REQ IDs). Running them in parallel races on shared filesystem state and produces dangling cross-links. The discipline rule (`rules/spec-discipline.md` lane-separation section) makes this explicit.

**code-reviewer** can run in parallel with both because its lane (source code) doesn't overlap with `sdd/` or `documentation/`.

## The three agents (SDD mode only)

1. **code-reviewer**: reviews code quality, security, correctness. Invokes `tdd-enforce` for test files.
2. **spec-reviewer**: keeps `sdd/` as the single source of truth. When code changes introduce new features, modify behavior, or change APIs without a corresponding spec update, this agent updates `sdd/` to match: adds new REQ-* entries for unspec'd features, updates ACs for changed behavior, marks deprecated requirements, adds changelog entries to `sdd/changes.md`, runs TDD coverage checks (per `enforce_tdd` in `sdd/config.yml`). Invokes `spec-enforce` family.
3. **doc-updater**: reads the post-edit spec from spec-reviewer and updates `documentation/` to match the code. Flags when API routes, env vars, auth flows, configuration, or architecture change without a corresponding doc update. Generates cross-references from docs to REQ IDs. Never runs on non-SDD projects (manual invocation only). Invokes `doc-enforce` family.

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

The PostToolUse hook (`git-push-review-reminder.sh`) emits the three-agent directive when an SDD-mode PR-boundary trigger fires. On receipt, launch all three agents per the execution order above. This skill is the operational reference; the directive itself is non-negotiable.
