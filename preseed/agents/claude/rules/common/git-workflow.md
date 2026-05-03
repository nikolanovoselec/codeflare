# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

Note: Attribution disabled globally via ~/.claude/settings.json.

## Review workflow is gated on SDD bootstrap AND PR boundary

**SDD opt-in is binary.** Two modes:

- **Vibe-coding mode** (no `sdd/` folder in the project) — `git push`
  and `gh pr create` proceed with **no review agents**. Nothing fires.
  No code-reviewer, no spec-reviewer, no doc-updater, no auto-generated
  documentation. Pure friction-free workflow. This is intentional:
  projects that haven't run `/sdd init` are telling you they don't
  want the workflow.
- **SDD mode** (`sdd/` + `sdd/README.md` exist) — review agents fire
  on PR-boundary events only, not on every push.

### PR-boundary trigger semantics (SDD mode)

| Action | What fires |
|---|---|
| `gh pr create` (PR open) | code-reviewer + spec-reviewer + doc-updater (full pipeline) |
| `git push` to a branch with an open PR | full pipeline (PR-sync) |
| `git push` to a branch with no open PR | nothing (deferred until PR opens) |
| `git push` to `develop` directly | nothing (caught by the develop→main PR later) |
| `git push` to `main`/`master` with no PR | nothing (the user is expected to have branch protection on; if off, manual verification is on the user) |

The cost model shifts from per-push (every commit pair burned a full
review) to per-PR (one review at PR open + one per push while the PR
is open). Same coverage, ~10× fewer review tokens.

### Recommended workflow

```
feature ──► PR ──► develop ──► PR ──► main
   ↑                  ↑                 ↑
   you push           review fires      review fires
                      at PR open        at PR open
```

Direct push to `develop` is fine — the develop→main PR catches the
cumulative diff. Direct push to `main` should be prevented at the
GitHub layer (see "Branch protection on main" below) rather than
worked around in-session.

The `git-push-review-reminder.sh` PostToolUse hook enforces this:
checks for `sdd/` + `sdd/README.md`, classifies the trigger
(`gh pr create` → PR-OPEN; `git push` + `gh pr view` returns OPEN →
PR-SYNC; otherwise deferred), and emits the three-agent directive
only when the trigger fires. On non-SDD projects the hook exits
silently and no agents are spawned.

To manually invoke code-reviewer or doc-updater on a non-SDD project
(e.g., to audit code quality or maintain a `documentation/` folder by
hand), use the Task tool directly with the agent name. The automatic
PR-boundary workflow is the only thing that's gated.

### Branch protection on main (proactive surfacing during CI setup)

When you (the agent) are helping the user set up CI for a new
repository — adding `.github/workflows/`, configuring required
checks, drafting a release process, or auditing an existing repo's
CI — **proactively surface the branch-protection conversation**.
Don't wait for the user to ask. The protection is the **actual
enforcement** that makes the PR-boundary trigger model complete;
without it, direct pushes to `main` silently bypass both the review
pipeline and the GitHub Actions checks that gate merges.

Surface it as a one-paragraph explanation followed by a concrete
proposal. Example phrasing the agent should use:

> "Before this CI is meaningful, `main` needs branch protection
> turned on. Right now anyone with push access can land code on
> `main` without a PR — which means CI never runs on the change and
> the SDD review pipeline never sees it. Want me to enable branch
> protection on `main` (require PR before merge, require these CI
> checks to pass, require branch up-to-date before merge)?"

If the user says yes, configure it via `gh api`:

```bash
gh api -X PUT "repos/{owner}/{repo}/branches/main/protection" \
  --input branch-protection.json
```

Recommended `branch-protection.json` settings (adjust the
`required_status_checks.contexts` array to match the actual workflow
job names from `.github/workflows/`):

- **Require a pull request before merging** — `required_pull_request_reviews`: enabled, `required_approving_review_count: 0` (the SDD review pipeline does the substantive review; this just enforces the PR gate)
- **Require status checks to pass before merging** — list each required CI workflow's job name in `contexts`
- **Require branches to be up to date before merging** — `strict: true` (forces rebase-on-main before merge so CI reflects the merged state, not the pre-merge state)
- **Enforce for administrators** — `enforce_admins: true` (otherwise you'll quietly bypass it yourself when convenient)
- **Restrict pushes that create files** — optional, project-specific

The PR-boundary trigger model assumes branch protection is in
place. If the user declines, document it as a project-level
workflow decision (ADR or `documentation/decisions/`) so future
contributors know the protection is intentionally off, not just
forgotten.


### Execution order when SDD is bootstrapped — partial parallelism

1. **code-reviewer** runs in parallel with the others (it touches
   source code only, not `sdd/` or `documentation/`)
2. **spec-reviewer** runs FIRST among the docs/spec agents
3. **doc-updater** runs SECOND, AFTER spec-reviewer has finished
   (sequential to spec-reviewer)

**Why sequential between spec-reviewer and doc-updater:** both agents
may touch related files (spec-reviewer may move REQs, doc-updater may
generate cross-references to those REQ IDs). Running them in parallel
races on shared filesystem state and produces dangling cross-links.
The discipline rule (`rules/spec-discipline.md` "Spec/docs/code lane
separation" section) makes this explicit.

**code-reviewer** can run in parallel with both because its lane
(source code) doesn't overlap with `sdd/` or `documentation/`.

### The three agents (SDD mode only)

1. **code-reviewer** — reviews code quality, security, correctness.
   When `sdd/` exists, it also checks that new source files implementing
   observable behavior include the `// Implements REQ-X-NNN` annotation.
2. **spec-reviewer** — keeps `sdd/` as the single source of truth.
   When code changes introduce new features, modify behavior, or change
   APIs without a corresponding spec update, this agent updates `sdd/`
   to match: adds new REQ-* entries for unspec'd features, updates
   acceptance criteria for changed behavior, marks deprecated
   requirements, adds changelog entries to `sdd/changes.md`, runs
   TDD coverage checks (per `enforce_tdd` in `sdd/config.yml`).
3. **doc-updater** — reads the post-edit spec from spec-reviewer and
   updates `documentation/` to match the code. Flags when API routes,
   env vars, auth flows, configuration, or architecture change without
   a corresponding doc update. Generates cross-references from docs to
   REQ IDs. Never runs on non-SDD projects — manual invocation only.


## Post-Push: CI Monitoring

After every `git push`, monitor CI in the background so the user can
continue working:
1. Spawn a background Bash command that polls `gh run list` every 15s
2. Wait for ALL runs on the pushed commit to complete
3. If ALL GREEN — report to user
4. If ANY FAILED — check `gh run view <id> --log-failed`, fix the issue,
   commit, push, and repeat from step 1
5. Continue this loop until CI is green

Never report CI as passing unless you have confirmed it.

## Pull Request Workflow

When creating PRs:
1. Analyze full commit history (not just latest commit)
2. Use `git diff [base-branch]...HEAD` to see all changes
3. If `sdd/` exists, reference implemented REQ-* IDs in the PR summary
4. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch
