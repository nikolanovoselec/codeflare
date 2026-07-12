---
name: git-review-pipeline
description: "SDD-mode PR-boundary review policy for Pi. The extension names required visible reviewer lanes; the root main session launches them together, waits for all, fixes legitimate findings, and alone pushes. Review is independent of CI."
version: 3.0.0
---

# Git Review Pipeline in Pi

This skill explains how the root main session handles Pi's PR-boundary review instruction.

## Trigger and scope

SDD projects (`sdd/` + `sdd/README.md`) are reviewed only when work is headed to `main` or `master`. Draft PRs remain eligible. Integration-branch PRs defer review until their PR to `main`/`master`.

The Pi extension emits a structured reminder after a supported successful boundary and a follow-up naming every reviewer lane still needed for the current head. Passive startup, branch existence, child sessions, failed commands, and unsupported commands do not launch review.

| Boundary | Review behavior |
|---|---|
| Successful `git push` with an open PR to `main`/`master` | Extension may name the required lanes |
| Successful `gh pr create --base main|master` | Reminder only; a later supported settled boundary reconstructs review demand |
| Successful protected-base `gh pr edit` | Extension may name the required lanes |
| Successful `gh pr merge` | Settled boundary only; there is no pre-command merge interceptor |
| PR into `develop` / `staging` | Review deferred |
| Push with no open main-bound PR | No PR-boundary review |

## Root main-session action

When the reminder or follow-up lists lanes:

1. Call every listed reviewer together through the public `subagent` tool.
2. Set `run_in_background: true` and `inherit_context: false` on every call.
3. Do not duplicate a lane already identified as in flight by the extension.
4. Wait for every required reviewer notification, regardless of completion order.
5. Read each reviewer's native output, verify every finding, and fix legitimate findings unless the latest user instruction says to wait or not autofix.
6. The root main session alone commits and pushes. Reviewers and other subagents never push.

Review is session-scoped. Reload can discard active work and does not prove completion; a later supported root boundary may request the missing lanes again.

## Independence from CI

Review never launches, tracks, waits for, or relaunches CI. CI never launches reviewers. The root Git workflow rule independently runs the seeded CI request resolver exactly once after an eligible successful Git action. Do not add CI actions to a review reminder or follow-up.

## Finding discipline

Do not act on a subset of required reviewer outputs. Wait until every required reviewer has finished, then assess all findings together. A finding's age is not a reason to skip it: fix every legitimate finding, explain false positives, and ask before destructive or irreversible changes.

## Claude behavior

Claude's hook-driven review pipeline is unchanged. Its own lane ordering, checkpoints, bypasses, and enforcement remain governed by the Claude rules and hooks; the Pi session-scoped flow above does not replace or reinterpret them.

## Branch-protection note

The intended workflow is:

```text
feature branch -> develop -> PR to main
```

Branch protection on `main` should require PRs and CI, but changing branch protection is separate from opening a PR. Ask first.
