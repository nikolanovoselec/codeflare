# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

Note: Attribution disabled globally via ~/.claude/settings.json.

## Pre-Push: Code Review

Before every `git push`, run a **code-reviewer** agent over the changes
being pushed. Fix any HIGH or CRITICAL findings before pushing. This is
not optional — do not push code that hasn't been reviewed.

## Post-Push: CI Monitoring

After every `git push`, monitor CI in the background until all checks
complete:
1. Spawn a background Bash command that polls `gh run list` every 15s
2. Wait for ALL runs on the pushed commit to complete
3. If ALL GREEN — report to user
4. If ANY FAILED — check `gh run view <id> --log-failed`, fix the issue,
   commit, push, and repeat from step 1
5. Continue this loop until CI is green

Never report CI as passing unless you have confirmed it. Never move on
to the next task while CI is failing.

## Pull Request Workflow

When creating PRs:
1. Analyze full commit history (not just latest commit)
2. Use `git diff [base-branch]...HEAD` to see all changes
3. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch
