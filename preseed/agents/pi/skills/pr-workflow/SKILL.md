---
name: pr-workflow
description: "Pull request creation workflow for Pi. Covers commit/diff review, title and body drafting, REQ backlinks, push/upstream handling, independent CI request dispatch, and visible PR-boundary reviewers."
version: 3.0.0
---

# Pull Request Workflow in Pi

Use this when the user asks to open a PR.

## Ownership boundaries

PR review and CI monitoring are separate.

- The Pi review extension emits a reminder or follow-up naming the required reviewer lanes for an eligible SDD PR boundary. When it does, the root main session launches all named reviewers together through public background `subagent` calls without inherited context.
- The root Git workflow rule is the sole automatic CI owner. After successful creation of a PR targeting `main` or `master`, it runs the seeded CI request resolver once and submits its zero-or-one request unchanged once.
- Reviewer agents and the CI agent are report-only. They never fix, commit, push, or launch each other. The root main session alone owns follow-up edits and Git writes.

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
4. Draft a concise title under 70 characters, using the repository convention when visible.
5. Draft a body with a summary and test plan.
6. Push with upstream if needed:

   ```bash
   git push -u origin HEAD
   ```

7. After that successful head-changing push, follow the root Git rule once: launch any required reviewers first, then submit the independent CI request last without waiting for review completion.
8. Create the PR and report its URL.
9. If the Pi extension names reviewer lanes, launch all listed lanes together with `run_in_background: true`, `inherit_context: false`, and the exact supplied `review_range` marker in every prompt.
10. If the PR targets `main` or `master`, immediately follow those reviewer calls with the root Git rule's single `pr-create` CI request. CI is the last launch, not a review completion dependency.
11. Wait for every named reviewer before evaluating findings or changing the head. Fix every legitimate finding unless the latest user instruction says to wait or not autofix. Only the root main session may commit or push those fixes.

No open PR targeting `main`/`master`, or no JSON request from the resolver, means no automatic CI monitor. Do not relaunch an aborted monitor automatically. An explicit user request is the only other launch path.

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

Allowed and required without asking:

- print the PR URL and branch/base
- summarize what changed
- obey a Pi review reminder or follow-up by launching every listed reviewer together with its exact review range
- dispatch the root Git rule's zero-or-one CI request last, immediately after reviewer calls and before waiting for their results
- verify and fix legitimate reviewer findings in the root main session

Not allowed unless explicitly requested:

- merging the PR
- changing branch protection
