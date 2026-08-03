---
name: git-review-pipeline
description: "SDD-mode PR-boundary review policy for Pi. The root launches visible reviewer lanes, publishes triage, ends the turn for acknowledgement, then fixes in a separate follow-up. Review is independent of CI."
version: 3.0.0
disable-model-invocation: true
---

# Git Review Pipeline in Pi

This skill explains how the root main session handles Pi's PR-boundary review instruction.

## Trigger and scope

Use the `review-scope` skill as the canonical scope contract.

SDD projects (`sdd/` + `sdd/README.md`) are reviewed when work is headed to `main`, `master`, or `develop`. Draft PRs remain eligible. PRs targeting any other integration branch defer review until their PR to one of those protected bases.

The Pi extension emits one structured launch plan after a supported successful boundary and a follow-up naming every reviewer lane still needed for the current head. The plan has separate reviewer and CI waves. Passive startup, branch existence, child sessions, failed commands, and unsupported commands do not launch review.

| Boundary | Review behavior |
|---|---|
| Successful explicit branch push, or implicit configured-branch push, whose exact destination and head have an open PR to `main`/`master`/`develop` | Extension may name the required lanes |
| Successful `gh pr create` whose resulting open PR targets `main`/`master`/`develop` | Extension may name required lanes and an independent CI wave |
| Successful supported merge into `develop` whose merge commit exactly heads an open `develop` → `main`/`master` PR | Extension may name required lanes and an independent CI wave for the downstream PR |
| PR into `staging` or another non-protected integration branch | Review deferred |
| Push with no open protected-base PR | No PR-boundary review |
| Branch deletion, tag/multi-ref push, PR edit/update, or unconfirmed/non-`develop` merge | No PR-boundary review |

## Root main-session action

When the reminder or follow-up lists lanes:

1. Call every listed reviewer together through the public `subagent` tool.
2. Set `run_in_background: true` and `inherit_context: false` on every call. Every reviewer prompt carries `scope=diff`: a PR review is a change-set review, never whole-tree enforcement. When the reminder supplies `review_range=<acknowledged>..<current>`, include that exact marker in each prompt; otherwise use the full protected-base PR diff.
3. Do not duplicate any unmatched reviewer call; it remains in flight until a correlated successful native notification or public result retrieval.
4. If the same extension plan includes a CI wave, submit that independent CI request last without waiting for review completion. Do not infer a second CI trigger from the Git command.
5. Wait until every required reviewer has a correlated successful native notification or public result retrieval, regardless of completion order.
6. Publish one consolidated triage summary. For every finding, decide independently whether the finding is evidence-backed and in scope, whether its proposed fix is proportional, and what smallest correction reuses existing machinery.
7. Reject false positives and overengineered proposals with evidence. Make no file or Git changes after triage; end the turn immediately so agent-end enforcement can acknowledge the reviewed head from live session state; settled enforcement is the fallback.
8. In the separate FIX follow-up turn, apply only the accepted legitimate minimal fixes unless the user explicitly requested approval or validation.
9. The root main session alone commits and pushes. Reviewers and other subagents never push.

Review is session-scoped. Reload can discard active work and does not prove completion; a later supported root boundary may request the missing lanes again.

## Independence from CI

Review never launches, tracks, waits for, or relaunches CI. CI never launches reviewers. The boundary dispatcher names both waves in one plan; the root issues CI after reviewer calls and before their completion. Their execution, completion, and acknowledgement remain independent.

## Finding discipline

In `scope=diff`, reviewers inspect changed hunks and only directly invalidated callers, anchors, tests, and owner documentation. They do not run whole-tree manifests or report unchanged baseline debt. `scope=all` is reserved for explicit `/review --all` and `/sdd clean --all` requests.

Do not act on a subset of required reviewer outputs. Wait until every required reviewer has finished, then assess all findings together in the visible triage summary. Finding validity and proposed-fix validity are separate decisions: a real issue can still carry an unnecessary or overengineered correction. Prefer an existing implementation path before adding machinery. End the triage turn without mutation. In the acknowledged FIX follow-up, fix every accepted legitimate finding by default, explain rejected findings or proposals with evidence, and ask only when the user explicitly requested approval or the change is destructive or irreversible.

## Claude behavior

Claude's hook-driven review pipeline is unchanged. Its own lane ordering, checkpoints, bypasses, and enforcement remain governed by the Claude rules and hooks; the Pi session-scoped flow above does not replace or reinterpret them.

## Branch-protection note

The intended workflow is:

```text
feature branch -> develop -> PR to main
```

Branch protection on `main` should require PRs and CI, but changing branch protection is separate from opening a PR. Ask first.
