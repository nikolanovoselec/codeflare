---
name: pr-workflow
description: Pull request creation template. Steps for analyzing the full commit history, drafting summary/body, REQ backlinks (when sdd/ exists), and using -u for new branches. Invoked when the user asks the agent to open a PR.
version: 1.0.0
---

# Pull Request Workflow

When creating PRs:

1. **Analyze full commit history** (not just latest commit). Use `git log --no-merges <base>..HEAD` to see every commit that will land.
2. **Use `git diff [base-branch]...HEAD`** to see all changes that will be merged.
3. **If `sdd/` exists**, reference implemented REQ-* IDs in the PR summary (one line per REQ touched).
4. **Draft a comprehensive PR summary**: 1-3 bullets describing what changed and why.
5. **Include a test plan**: bulleted markdown checklist of TODOs for verifying the PR (smoke tests, browser checks, CI runs to watch).
6. **Push with `-u` flag** if the branch is new (`git push -u origin HEAD`).

## Body template

Use a HEREDOC to ensure correct multi-line formatting:

```bash
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
- <1-3 bullets describing what changed>
- <one bullet per implemented REQ if sdd/ exists, e.g. "REQ-PIPE-003 AC 4-7 now have labeled tests">

## Test plan
- [ ] CI green on develop (PR Checks + CodeQL)
- [ ] Smoke test: <feature-specific check>
- [ ] <browser/playwright check if UI changed>
EOF
)"
```

## Title guidance

- Keep under 70 characters; details go in the body.
- Lead with the type (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`).
- Match the project's existing PR title convention (read `gh pr list --limit 10` to see recent titles).

## After the PR is open

- The PostToolUse hook fires the SDD review pipeline if the PR base is `main`/`master` and `sdd/` is bootstrapped. See `git-review-pipeline` skill for the execution order.
- Monitor CI per the `ci-monitoring` skill.
- `gh pr merge` is **user-only**. The assistant opens PRs and monitors CI but does not merge unless the user explicitly asks.

## Binding invocation rule

When the user asks the agent to open a PR, invoke this skill as a first action. The skill's steps are mechanical and the body template is the canonical shape.
