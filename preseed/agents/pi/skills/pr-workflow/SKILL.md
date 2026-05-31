---
name: pr-workflow
description: "Pull request creation workflow for Pi. Use when the user asks to open/create a PR. Covers commit/diff review, title/body drafting, REQ backlinks, and push/upstream handling. Critical: opening a PR is not permission to spawn review agents or start CI monitoring; hooks/enforcement own reviews, and CI monitoring requires an explicit user request or merge/deploy gate."
version: 2.0.0
---

# Pull Request Workflow in Pi

Use this when the user asks to open a PR.

## Critical boundary

Opening a PR is **not** permission to spawn review agents.

After `gh pr create`, do **not** call `Agent` for `code-reviewer`, `spec-reviewer`, `doc-updater`, `security-reviewer`, or any review agent unless:

1. the user explicitly asks for review agents, or
2. an actual hook/enforcement message in the current turn explicitly instructs the assistant to launch specific agents.

If SDD review enforcement is required, the hook/enforcement system owns that. The normal PR workflow is: create the PR, report the URL, and stop.

Also do **not** start CI monitoring after PR creation unless the user explicitly asks, or a merge/deploy action requires a fresh CI result.

## Steps

1. Inspect the full commit history that will land:

   ```bash
   git log --no-merges <base>..HEAD
   ```

2. Inspect the full PR diff:

   ```bash
   git diff <base>...HEAD
   ```

3. If `sdd/` exists, include relevant `REQ-*` backlinks in the PR body.
4. Draft a concise title under 70 characters, using the repo's convention when visible.
5. Draft a body with summary and test plan.
6. Push with upstream if needed:

   ```bash
   git push -u origin HEAD
   ```

7. Create the PR.
8. Report the PR URL. Stop unless the user asked for more.

## Body template

Use a heredoc so markdown is preserved:

```bash
gh pr create --base <base> --head <branch> --title "<title>" --body "$(cat <<'EOF'
## Summary
- <1-3 bullets describing what changed and why>
- <REQ-* backlink bullet if sdd/ exists>

## Test plan
- [ ] CI green on this PR
- [ ] <feature-specific smoke check>
EOF
)"
```

## After the PR is open

Allowed without asking:

- print the PR URL
- print the branch/base
- summarize what changed

Not allowed unless explicitly requested:

- spawning review agents
- monitoring CI
- merging the PR
- changing branch protection
