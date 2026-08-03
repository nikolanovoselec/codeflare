---
name: pr-workflow
description: Create a pull request with review, REQ backlinks, push, and CI handoff.
version: 3.0.0
---

# Pull Request Workflow in Pi

Use this when the user asks to open a PR.

## Ownership boundaries

PR review and CI monitoring are separate.

- The Pi boundary extension emits one ordered launch plan when successful `git` or `gh` activity exposes an unacknowledged exact PR head for the checked-out branch. Its first wave names any required SDD reviewers; its second wave names independent CI when eligible.
- The root main session follows that plan exactly once: all named reviewers together through public background `subagent` calls without inherited context, then the resolver's zero-or-one CI request unchanged once.
- Reviewer agents and the CI agent are report-only. They never fix, commit, push, or launch each other. The root main session alone owns follow-up edits and Git writes.

## Mandatory boundary stop

After successful `git` or `gh` activity leaves the checked-out branch at an unacknowledged exact head of an open PR targeting `main`/`master`/`develop`, **end the current assistant turn immediately**. Becoming idle is what delivers the extension's queued `deliverAs: "followUp"` boundary launch plan. Other pushes and PR commands are not boundaries.

After the Git command succeeds:

- report only the push result or new PR URL, then stop;
- do not call another tool in that turn;
- do not inspect the session JSONL or search for a launch plan;
- do not run `gh pr edit`, another push, or the CI resolver to retrigger a boundary;
- do not infer that a plan is missing while the current turn is still active.

The next turn begins when the queued launch plan arrives. Execute that supplied plan exactly once in that next turn.

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

7. If that push updated a branch with an open PR to `main`/`master`/`develop`, report the push result and **stop the current turn**. Otherwise continue to step 8.
8. In a later turn, create the PR and report its URL.
9. **Stop the current turn immediately after PR creation.** Do not search for, recreate, or retrigger the boundary plan.
10. When the queued PR-creation launch plan starts the next turn, launch all listed reviewers with `run_in_background: true`, `inherit_context: false`, and the exact supplied `review_range` marker in every prompt.
11. Immediately follow those reviewer calls with the same plan's CI wave when present. CI is the last launch, not a review completion dependency.
12. Wait for every named reviewer, then publish one consolidated triage without changing files or Git state. End the turn immediately after triage so agent-end enforcement can acknowledge the reviewed head from live session state; settled enforcement is the fallback.
13. In the next turn started by the queued FIX follow-up, apply only the accepted minimal fixes unless the latest user instruction says to wait or not autofix. Only the root main session may commit or push those fixes.

No open PR targeting `main`/`master`/`develop`, or no JSON request from the resolver, means no automatic CI monitor. Do not relaunch an aborted monitor automatically. A later extension-issued boundary plan or explicit user request is the only other launch path.

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

- print the PR URL and branch/base, then stop that turn
- summarize what changed without calling another tool
- in the next turn started by the queued Pi boundary plan, launch every listed reviewer together with its exact review range
- dispatch that same plan's zero-or-one CI request last, immediately after reviewer calls and before waiting for their results
- publish triage after all reviewers finish, make no mutation, and end that turn
- in the separate FIX follow-up turn, apply accepted legitimate findings in the root main session

Not allowed unless explicitly requested:

- merging the PR
- changing branch protection
