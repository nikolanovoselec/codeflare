# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

<!-- git-workflow-ci-route -->

| Event | Skill |
|---|---|
| Pi emits a PR-boundary launch plan after a successful push or protected-base PR creation | Extension dispatches its exact reviewer wave, then its independent `ci-monitoring` wave |
| PR-boundary launch plan includes reviewers | `git-review-pipeline` (visible spec/doc/code reviewers, independent of CI) |
| User explicitly requests CI monitoring | `ci-monitoring` |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## Mandatory stop after boundary commands

After any successful `git push` or `gh pr create`, **end the current assistant turn immediately**. Becoming idle lets the extension dispatch the exact boundary tool calls without another provider turn.

In the boundary-command turn, report only the push result or PR URL. Do not call another tool, inspect session JSONL, search for the plan, run `gh pr edit`, invoke the CI resolver, or attempt another boundary command. A plan or tool call that is not yet visible while the turn is active is pending, not missing. The extension owns dispatch; the root must not duplicate it.

## Unified PR-boundary launch plan

The Pi extension is the sole automatic boundary dispatcher. Do not independently infer, launch, or duplicate review or CI work from the preceding Git command or its visible plan.

1. At the idle boundary, the extension invokes every listed reviewer together through exact public `subagent` calls with `run_in_background: true` and `inherit_context: false`.
2. Every ranged reviewer request carries the exact `review_range=<acknowledged>..<current>` marker. An exact direct-user `FULLY AUTONOMOUS` marker is carried as `autonomy_override=fully-autonomous` until an explicit `CANCEL FULLY AUTONOMOUS` or `STOP FULLY AUTONOMOUS` marker.
3. Immediately after the reviewer calls start—not after completion—the extension runs the existing wave-2 resolver once with the affected PR, repository cwd, and review launch state. It invokes the resolver's zero-or-one request unchanged; CI is the final launch for that boundary.
4. Wait for every required reviewer result before editing, committing, or pushing. CI completion is independent and never gates review acknowledgement.
5. After all required reviewer results arrive, automatically publish one consolidated triage summary before the first fixing or other project-mutation tool call. For each finding, classify the finding's validity, the proposed fix's proportionality, and the smallest correction that reuses existing machinery.
6. Reject unsupported or overengineered proposals. Apply legitimate minimal fixes automatically unless the user explicitly requested approval or validation.

A plan may contain reviewers only, CI only, or both. Vibe-coding repositories receive CI-only plans for eligible boundaries. The resolver returns no request when launch order is unresolved, repository cwd is absent, or there is no open PR targeting `main`/`master`. If monitoring aborts, do not relaunch it automatically; a later eligible boundary plan or explicit user request may launch a new monitor.

## SDD review flow

- **Vibe-coding** (no `sdd/`): pushes and PR creation do not launch reviewers; an eligible plan may still launch CI.
- **SDD mode** (`sdd/` + `sdd/README.md`): the launch plan lists only required reviewer lanes for work headed to `main`/`master`.
- Reviewers are independent and report-only. The root main session evaluates all findings, fixes legitimate findings, and alone commits or pushes follow-up work. No subagent pushes.
- Review and CI never launch, wait for, or recover each other. Reload may lose active reviewer or CI work; only a later supported boundary or explicit user request starts fresh work.

## Hard obligations

<!-- git-workflow-hard-obligations -->

- After a successful push or PR creation, stop the current turn before any other tool call so settled exact-tool dispatch can run.
- Never search for, recreate, or retrigger a boundary plan from the same turn; in particular, never use a no-op `gh pr edit` as a delivery mechanism.
- Never execute an extension-issued plan manually: the extension invokes all listed reviewers first and independent CI last without waiting between waves.
- Never create a second automatic review or CI trigger from the Git command or visible plan.
- The extension passes explicit repository cwd and review launch state and invokes a returned CI request unchanged exactly once; no request means no monitor.
- Never run long CI, deploy, log, watch, or polling commands in the root session.
- Wait for all required visible reviewers, then publish the consolidated triage summary before any review follow-up mutation. Triage and apply legitimate minimal fixes automatically unless the user explicitly requests approval.
- Never deploy to integration until every required CI check is green.
