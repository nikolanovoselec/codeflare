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
| `git push` to a protected branch (default `main`) directly | non-blocking warning via `warn-direct-push-to-shared.sh`; no review pipeline |
| `git push` to `develop` directly | nothing (caught by the develop→main PR later) |

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

Direct push to `main` is the only true bypass of the review pipeline.
The `warn-direct-push-to-shared.sh` hook surfaces a non-blocking
informational reminder when it happens — the push still succeeds.
Direct push to `develop` is fine, because the develop→main PR will
trigger reviews on the cumulative diff.

`sdd_review.protected_branches` in `sdd/config.yml` (default `[main, master]`)
controls which branches surface the warning. `sdd_review.warn_on_direct_push`
(default `true`) toggles the warning on/off.

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

### When the user pushes directly to a protected branch

The `warn-direct-push-to-shared.sh` PostToolUse hook fires when
`git push` runs on a branch in `sdd_review.protected_branches`
(default `main`, `master`). It emits a non-blocking informational
directive — the push still succeeds. The user can:

1. Treat it as a reminder and continue (reviews will fire on the
   next PR that touches the branch)
2. Manually spawn the three review agents themselves if the direct
   push needs immediate review
3. Silence the warning permanently by setting
   `sdd_review.warn_on_direct_push: false` in `sdd/config.yml`

The hook does NOT surface for direct pushes to `develop`, because
the recommended flow is feature → PR → develop → PR → main and the
develop→main PR will catch the cumulative diff.

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
