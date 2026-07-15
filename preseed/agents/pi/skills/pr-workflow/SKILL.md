---
name: pr-workflow
description: "Pull request creation workflow for Pi. Covers commit/diff review, title and body drafting, REQ backlinks, push/upstream handling, independent CI request dispatch, and visible PR-boundary reviewers."
version: 4.0.0
---

# Pull Request Workflow in Pi

Use this when the user asks to open a PR.

## Ownership boundaries

PR review and CI monitoring are separate.

- The Pi boundary extension emits one ordered launch plan after an eligible push or protected-base PR creation. Its first wave names any required SDD reviewers; its second wave names independent CI when eligible.
- At the settled idle boundary, the extension invokes all named reviewers together through exact public background `subagent` calls without inherited context, then invokes the resolver's zero-or-one CI request unchanged once. The root does not duplicate either wave.
- Reviewer agents and the CI agent are report-only. They never fix, commit, push, or launch each other. The root main session alone owns follow-up edits and Git writes.

## Mandatory boundary stop

After any successful `git push` or `gh pr create`, **end the current assistant turn immediately**. Becoming idle is what delivers the extension's queued `deliverAs: "followUp"` boundary launch plan.

After the Git command succeeds:

- report only the push result or new PR URL, then stop;
- do not call another tool in that turn;
- do not inspect the session JSONL or search for a launch plan;
- do not run `gh pr edit`, another push, or the CI resolver to retrigger a boundary;
- do not infer that a plan is missing while the current turn is still active.

The extension dispatches the exact plan after the turn becomes idle. The root does not execute the visible plan manually.

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

7. Report the push result and **stop the current turn**. Do not perform step 8 in the same turn.
8. In a later turn, create the PR and report its URL.
9. **Stop the current turn immediately after PR creation.** Do not search for, recreate, or retrigger the boundary plan.
10. After the PR-creation turn becomes idle, observe the extension's exact public reviewer calls and independent CI call. Do not submit the visible plan manually.
11. Wait for every named reviewer before evaluating findings or changing the head. Fix every legitimate finding unless the latest user instruction says to wait or not autofix. Only the root main session may commit or push those fixes.

No open PR targeting `main`/`master`, or no JSON request from the resolver, means no automatic CI monitor. Do not relaunch an aborted monitor automatically. A later extension-issued boundary plan or explicit user request is the only other launch path.

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
- observe the exact reviewer calls the Pi boundary extension dispatches together with the supplied review range
- observe its zero-or-one CI request dispatched last, immediately after reviewer calls and before their results
- verify and fix legitimate reviewer findings in the root main session

Not allowed unless explicitly requested:

- merging the PR
- changing branch protection
