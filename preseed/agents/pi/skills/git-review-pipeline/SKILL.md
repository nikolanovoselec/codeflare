---
name: git-review-pipeline
description: "SDD-mode PR-boundary review policy for Pi. The extension service-dispatches required visible reviewer lanes; the root waits for all, fixes legitimate findings, and alone pushes. Review is independent of CI."
version: 4.0.0
---

# Git Review Pipeline in Pi

This skill explains how Pi deterministically dispatches PR-boundary review and how the root main session handles its results.

## Trigger and scope

Use the `review-scope` skill as the canonical scope contract.

SDD projects (`sdd/` + `sdd/README.md`) are reviewed only when work is headed to `main` or `master`. Draft PRs remain eligible. Integration-branch PRs defer review until their PR to `main`/`master`.

The Pi extension appends one extension-only structured review window after a supported successful boundary; it never sends launch instructions into LLM context. On settled enforcement it uses the stock session subagent service to submit every missing reviewer lane, then resolves and dispatches CI last. Passive startup, branch existence, child sessions, failed commands, and unsupported commands do not launch review.

| Boundary | Review behavior |
|---|---|
| Successful `git push` with an open PR to `main`/`master` | Extension may name the required lanes |
| Successful `gh pr create --base main|master` | Extension may name required lanes and an independent CI wave |
| Successful protected-base `gh pr edit` | Extension may name the required lanes |
| Successful `gh pr merge` | Settled boundary only; there is no pre-command merge interceptor |
| PR into `develop` / `staging` | Review deferred |
| Push with no open main-bound PR | No PR-boundary review |

## Dispatch and root action

When the reminder or follow-up lists lanes:

1. The extension calls the already-published stock `@gotgenes/pi-subagents` service once per missing reviewer with background execution and inherited context disabled. Managed `maxConcurrent: 1` queues reviewer execution to fit the container memory budget. The root must not duplicate those launches through the public `subagent` tool.
2. Every reviewer prompt carries `scope=diff`. When a valid `review_range=<acknowledged>..<current>` exists, the prompt and dispatch record carry that exact range; otherwise they name the full protected-base PR diff.
3. Each successful spawn appends minimal transcript evidence keyed by its returned agent ID. An unmatched dispatch remains in flight until its matching `subagents:record`; reload does not turn absence into completion.
4. After every requested reviewer returns an agent ID, the extension invokes the existing CI resolver and service-spawns a returned monitor request last with queue bypass. Review completion does not gate CI, and no model turn launches either wave.
5. Service-owned launches remain visible session subagents, but they are not assistant public-tool-call transcript blocks.
6. The root waits for every required successful reviewer result, regardless of completion order.
7. The root automatically publishes one consolidated triage summary before any fixing or project mutation. For every finding, decide independently whether the finding is evidence-backed and in scope, whether its proposed fix is proportional, and what smallest correction reuses existing machinery.
8. Reject false positives and overengineered proposals with evidence. Apply legitimate minimal fixes automatically unless the user explicitly requested approval or validation.
9. The root main session alone commits and pushes. Reviewers and other subagents never push.

Review is session-scoped. Reload replays dispatch evidence but cannot fabricate a terminal result; failed spawns remain missing and retry within the existing bound.

## Independence from CI

Review never waits for or relaunches CI. CI never launches reviewers. The boundary dispatcher owns both waves and dispatches CI after reviewer agent IDs are obtained but before reviewer completion. Their execution, completion, and acknowledgement remain independent.

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
