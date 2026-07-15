---
name: git-review-pipeline
description: "SDD-mode PR-boundary review policy for Pi. The extension invokes required visible reviewer lanes together; the root waits for all, fixes legitimate findings, and alone pushes. Review is independent of CI."
version: 4.0.0
---

# Git Review Pipeline in Pi

This skill explains how the root main session handles Pi's PR-boundary review instruction.

## Trigger and scope

Use the `review-scope` skill as the canonical scope contract.

SDD projects (`sdd/` + `sdd/README.md`) are reviewed only when work is headed to `main` or `master`. Draft PRs remain eligible. Integration-branch PRs defer review until their PR to `main`/`master`.

The Pi extension emits one structured launch plan after a supported successful boundary and a follow-up naming every reviewer lane still needed for the current head. At the settled idle boundary, it invokes the exact reviewer and CI tool calls through Pi's normal public tool pipeline without another provider turn. Passive startup, branch existence, child sessions, failed commands, and unsupported commands do not launch review.

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

1. Do not call the listed reviewers or CI monitor manually. The extension invokes every listed reviewer together through exact public `subagent` calls with `run_in_background: true` and `inherit_context: false`, then invokes independent CI last.
2. Observe the normal public tool calls and native notifications. Every reviewer prompt carries `scope=diff`; when the reminder supplies `review_range=<acknowledged>..<current>`, the exact marker is present in each prompt. An exact direct-user fully-autonomous marker is also preserved until exact cancellation.
3. Do not duplicate any unmatched reviewer call; it remains in flight until its native terminal notification.
4. Wait for every required reviewer notification, regardless of completion order. CI remains independent and does not gate review acknowledgement.
5. Automatically publish one consolidated triage summary before any fixing or project mutation. For every finding, decide independently whether the finding is evidence-backed and in scope, whether its proposed fix is proportional, and what smallest correction reuses existing machinery.
6. Reject false positives and overengineered proposals with evidence. Apply legitimate minimal fixes automatically unless the user explicitly requested approval or validation.
7. The root main session alone commits and pushes. Reviewers and other subagents never push.

Review is session-scoped. Reload can discard active work and does not prove completion; a later supported root boundary may request the missing lanes again.

## Independence from CI

Review never launches, tracks, waits for, or relaunches CI. CI never launches reviewers. The boundary dispatcher owns both waves in one plan and invokes CI after reviewer calls start but before they complete. Their execution, completion, and acknowledgement remain independent.

## Finding discipline

In `scope=diff`, reviewers inspect changed hunks and only directly invalidated callers, anchors, tests, and owner documentation. They do not run whole-tree manifests or report unchanged baseline debt. `scope=all` is reserved for explicit `/review --all` and `/sdd clean --all` requests.

Do not act on a subset of required reviewer outputs. Wait until every required reviewer has finished, then assess all findings together in the visible triage summary. Finding validity and proposed-fix validity are separate decisions: a real issue can still carry an unnecessary or overengineered correction. Prefer an existing implementation path before adding machinery. Fix every legitimate finding by default, explain rejected findings or proposals with evidence, and ask only when the user explicitly requested approval or the change is destructive or irreversible.

## Claude behavior

Claude's hook-driven review pipeline is unchanged. Its own lane ordering, checkpoints, bypasses, and enforcement remain governed by the Claude rules and hooks; the Pi session-scoped flow above does not replace or reinterpret them.

## Branch-protection note

The intended workflow is:

```text
feature branch -> develop -> PR to main
```

Branch protection on `main` should require PRs and CI, but changing branch protection is separate from opening a PR. Ask first.
