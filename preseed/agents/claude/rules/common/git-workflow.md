# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

Note: Attribution disabled globally via ~/.claude/settings.json.

## Pre-Push: Code Review + Doc Review

Before every `git push`, run both agents in the background (parallel).
Push immediately — do not wait for reviews to complete. When they
return, fix any HIGH or CRITICAL findings in a follow-up commit.

1. **code-reviewer** agent — reviews code quality, security, correctness
2. **doc-updater** agent — checks if code changes require documentation
   updates in `documentation/`. Flags when API routes, env vars,
   auth flows, configuration, or architecture change without a
   corresponding doc update. See `documentation/README.md` for the
   structure and `doc-updater` agent definition for what goes where.

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
3. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch
