# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

Note: Attribution disabled globally via ~/.claude/settings.json.

## Pre-Push: Review workflow is gated on SDD bootstrap

**SDD opt-in is binary.** Two modes:

- **Vibe-coding mode** (no `sdd/` folder in the project) — `git push`
  proceeds with **no review agents**. Nothing fires. No code-reviewer,
  no spec-reviewer, no doc-updater, no auto-generated documentation.
  Pure friction-free push. This is intentional: projects that haven't
  run `/sdd init` are telling you they don't want the workflow.
- **SDD mode** (`sdd/` + `sdd/README.md` exist) — all three review
  agents run in the background alongside the push per the execution
  order below. Push immediately — do not wait for reviews to complete.
  When they return, fix any HIGH or CRITICAL findings in a follow-up
  commit.

The `git-push-review-reminder.sh` PreToolUse hook enforces this: it
checks for `sdd/` + `sdd/README.md` and emits the three-agent reminder
only when both exist. On non-SDD projects the hook exits silently and
no reminder is injected, so no agents are spawned.

To manually invoke code-reviewer or doc-updater on a non-SDD project
(e.g., to audit code quality or maintain a `documentation/` folder by
hand), use the Task tool directly with the agent name. The automatic
post-push workflow is the only thing that's gated.

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
