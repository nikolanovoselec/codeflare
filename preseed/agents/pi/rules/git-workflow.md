# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

<!-- git-workflow-ci-route -->

| Event | Skill |
|---|---|
| Pi emits a PR-boundary launch plan after a successful push or protected-base PR creation | The extension service-dispatches reviewers, then independent `ci-monitoring` |
| PR-boundary launch plan includes reviewers | `git-review-pipeline` (visible spec/doc/code reviewer policy, independent of CI) |
| User explicitly requests CI monitoring | `ci-monitoring` |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## Mandatory stop after boundary commands

After any successful `git push` or `gh pr create`, **end the current assistant turn immediately**. The extension appends a extension-only review window that never enters LLM context; becoming idle triggers its deterministic settled dispatch.

In the boundary-command turn, report only the push result or PR URL. Do not call another tool, inspect session JSONL, search for the plan, run `gh pr edit`, invoke the CI resolver, launch reviewers, or attempt another boundary command. The extension—not the model—executes the plan exactly once after the turn settles.

## Unified PR-boundary launch plan

The Pi extension is the sole automatic boundary dispatcher. Do not independently infer, launch, or duplicate reviewer or CI work from the preceding Git command.

1. On settled enforcement, the extension calls the already-published stock `@gotgenes/pi-subagents` service once for every missing reviewer, with background execution and inherited context disabled. Each reviewer prompt preserves the exact `review_range=<acknowledged>..<current>` marker when supplied and carries `autonomy_override=fully-autonomous` only after a direct current-session user activation.
2. Every successful spawn appends minimal session evidence containing the exact head, range, lane, and returned agent ID. A dispatch unknown to a reloaded service remains in flight; a live stopped, aborted, or failed agent is retried from its recorded ID within the existing five-round bound.
3. Managed `maxConcurrent: 1` queues memory-heavy reviewers one at a time. Only after all requested reviewer spawns return agent IDs, the extension runs the existing CI request resolver once with the affected repository cwd and explicit review launch state. No request is persisted as resolved; a returned request is service-spawned last with queue bypass so monitoring remains independent.
4. The boundary extension correlates every dispatched reviewer and CI record internally by immutable agent ID. A focused copy of the stock `AgentWidget` renderer/lifecycle displays those correlated public records because the service API omits the invocation field used by the package widget filter; Codeflare adds no second execution path. These service launches are not assistant public-tool-call transcript blocks. Only a successful matching reviewer record can acknowledge the head.
5. Wait for every required reviewer result before editing, committing, or pushing. CI completion is independent and never gates review acknowledgement.
6. After all required reviewer results arrive, automatically publish one consolidated adversarial triage table before the first fixing or other project-mutation tool call. Include exactly one row per finding under `FINDING (as output by reviewer) | PROPOSED FIX (by reviewer) | STATUS | DECISION`; omit none. Challenge evidence and scope against implementation, specifications, documentation, architecture decisions, project intent, and direct current-session instructions. Classify finding validity separately from proposal proportionality.
7. Reject unsupported findings and wrong or overengineered proposals. In `DECISION`, explain every rejection and name the smallest correction that reuses existing machinery, designing a minimal replacement when needed. Apply every legitimate minimal fix automatically unless the user explicitly requested approval or validation.

A plan may contain reviewers only, CI only, or both. Vibe-coding repositories receive CI-only plans for eligible boundaries. The resolver returns no request when launch order is unresolved, repository cwd is absent, or there is no open PR targeting `main`/`master`. If monitoring aborts, do not relaunch it automatically; a later eligible boundary plan or explicit user request may launch a new monitor.

## SDD review flow

- **Vibe-coding** (no `sdd/`): pushes and PR creation do not launch reviewers; an eligible plan may still launch CI.
- **SDD mode** (`sdd/` + `sdd/README.md`): the launch plan lists only required reviewer lanes for work headed to `main`/`master`.
- Reviewers are independent and report-only. The root main session evaluates all findings, fixes legitimate findings, and alone commits or pushes follow-up work. No subagent pushes.
- Review and CI never wait for or recover each other. Reload replays session dispatch IDs without fabricating completion; absent terminal records remain in flight.

## Hard obligations

<!-- git-workflow-hard-obligations -->

- After a successful push or PR creation, stop the current turn before any other tool call so settled dispatch can run.
- Never search for, recreate, retrigger, or manually execute a boundary plan from the same turn; in particular, never use a no-op `gh pr edit` as a delivery mechanism.
- Let the extension dispatch all listed reviewers first and independent CI last; do not issue duplicate public `subagent` calls.
- Never create a second automatic CI trigger from the Git command itself.
- The extension passes explicit repository cwd and review launch state to the resolver and service-spawns a returned request once; no request means no monitor.
- Never run long CI, deploy, log, watch, or polling commands in the root session.
- Wait for all required visible reviewers, then publish the complete four-column adversarial triage table before any review follow-up mutation. Triage and apply legitimate minimal fixes automatically unless the user explicitly requests approval.
- Never deploy to integration until every required CI check is green.
