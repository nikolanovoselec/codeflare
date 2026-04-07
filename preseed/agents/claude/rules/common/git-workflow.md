# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

Note: Attribution disabled globally via ~/.claude/settings.json.

## Pre-Push: Code Review + Doc Review + Spec Review

Before every `git push`, run review agents in the background.
Push immediately — do not wait for reviews to complete. When they
return, fix any HIGH or CRITICAL findings in a follow-up commit.

**Execution order — partial parallelism:**

1. **code-reviewer** runs in parallel with the others (it touches source code only, not `sdd/` or `documentation/`)
2. **spec-reviewer** runs FIRST among the docs/spec agents (only if `sdd/` exists)
3. **doc-updater** runs SECOND, AFTER spec-reviewer has finished (sequential to spec-reviewer)

**Why sequential between spec-reviewer and doc-updater:** both agents may touch related files (spec-reviewer may move REQs, doc-updater may generate cross-references to those REQ IDs). Running them in parallel races on shared filesystem state and produces dangling cross-links. The discipline rule (`rules/spec-discipline.md` "Spec/docs/code lane separation" section) makes this explicit.

**code-reviewer** can run in parallel with both because its lane (source code) doesn't overlap with `sdd/` or `documentation/`.

### The three agents

1. **code-reviewer** agent — reviews code quality, security, correctness
2. **spec-reviewer** (conditional) — only if `sdd/` exists. Responsible
   for keeping the spec valid as the single source of truth. When code
   changes introduce new features, modify behavior, or change APIs
   without a corresponding spec update, this agent updates `sdd/` to
   match: adds new REQ-* entries for unspec'd features, updates
   acceptance criteria for changed behavior, marks deprecated
   requirements, and adds changelog entries to `sdd/changes.md`.
3. **doc-updater** agent — checks if code changes require documentation
   updates in `documentation/`. Flags when API routes, env vars,
   auth flows, configuration, or architecture change without a
   corresponding doc update. In SDD-strict mode (sdd/ exists), reads
   the post-edit spec from spec-reviewer and generates cross-references
   to REQ IDs. See `documentation/README.md` for the structure and
   `doc-updater` agent definition for what goes where.

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
