---
name: git-review-pipeline
description: "SDD-mode PR-boundary review policy for Pi. The extension names required visible reviewer lanes; the root main session launches them together, waits for all, fixes legitimate findings, and alone pushes. Review is independent of CI."
version: 3.0.0
---

# Git Review Pipeline in Pi

This skill explains how the root main session handles Pi's PR-boundary review instruction.

## Trigger and scope

Use the `review-scope` skill as the canonical scope contract.

SDD projects (`sdd/` + `sdd/README.md`) are reviewed only when work is headed to `main` or `master`. Draft PRs remain eligible. Integration-branch PRs defer review until their PR to `main`/`master`.

The Pi extension emits one structured launch plan after a supported successful boundary and a follow-up naming every reviewer lane still needed for the current head. The plan has separate reviewer and CI waves. Passive startup, branch existence, child sessions, failed commands, and unsupported commands do not launch review.

| Boundary | Review behavior |
|---|---|
| Successful `git push` with an open PR to `main`/`master` | Extension may name the required lanes |
| Successful `gh pr create --base main|master` | Extension may name required lanes and an independent CI wave |
| Successful protected-base `gh pr edit` | Extension may name the required lanes |
| Successful `gh pr merge` | Settled boundary only; there is no pre-command merge interceptor |
| PR into `develop` / `staging` | Review deferred |
| Push with no open main-bound PR | No PR-boundary review |

## Root main-session action

When the reminder or follow-up lists lanes:

1. Call every listed reviewer together through the public `subagent` tool.
2. Set `run_in_background: true` and `inherit_context: false` on every call. Every reviewer prompt carries `scope=diff`: a PR review is a change-set review, never whole-tree enforcement. When the reminder supplies `review_range=<acknowledged>..<current>`, include that exact marker in each prompt; otherwise use the full protected-base PR diff.
3. Do not duplicate any unmatched reviewer call; it remains in flight until its native terminal notification.
4. If the same extension plan includes a CI wave, submit that independent CI request last without waiting for review completion. Do not infer a second CI trigger from the Git command.
5. Wait for every required reviewer notification, regardless of completion order.
6. Read each reviewer's native output, verify every finding, and fix legitimate findings unless the latest user instruction says to wait or not autofix.
7. The root main session alone commits and pushes. Reviewers and other subagents never push.

Review is session-scoped. Reload can discard active work and does not prove completion; a later supported root boundary may request the missing lanes again.

## Independence from CI

Review never launches, tracks, waits for, or relaunches CI. CI never launches reviewers. The boundary dispatcher names both waves in one plan; the root issues CI after reviewer calls and before their completion. Their execution, completion, and acknowledgement remain independent.

## Finding discipline

In `scope=diff`, reviewers inspect changed hunks and only directly invalidated callers, anchors, tests, and owner documentation. They do not run whole-tree manifests or report unchanged baseline debt. `scope=all` is reserved for explicit `/review --all` and `/sdd clean --all` requests.

Do not act on a subset of required reviewer outputs. Wait until every required reviewer has finished, then assess all findings together. A finding's age is not a reason to skip it: fix every legitimate finding, explain false positives, and ask before destructive or irreversible changes.

## Claude behavior

Claude's hook-driven review pipeline is unchanged. Its own lane ordering, checkpoints, bypasses, and enforcement remain governed by the Claude rules and hooks; the Pi session-scoped flow above does not replace or reinterpret them.

## Branch-protection note

The intended workflow is:

```text
feature branch -> develop -> PR to main
```

Branch protection on `main` should require PRs and CI, but changing branch protection is separate from opening a PR. Ask first.
