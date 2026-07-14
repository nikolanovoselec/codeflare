# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

<!-- git-workflow-ci-route -->

| Event | Skill |
|---|---|
| Pi emits a PR-boundary launch plan after a successful push or protected-base PR creation | Follow its ordered reviewer wave, then its independent `ci-monitoring` wave |
| PR-boundary launch plan includes reviewers | `git-review-pipeline` (visible spec/doc/code reviewers, independent of CI) |
| User explicitly requests CI monitoring | `ci-monitoring` |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## Mandatory stop after boundary commands

After any successful `git push` or `gh pr create`, **end the current assistant turn immediately**. The extension queues its boundary message with `deliverAs: "followUp"`; becoming idle is the delivery trigger.

In the boundary-command turn, report only the push result or PR URL. Do not call another tool, inspect session JSONL, search for the plan, run `gh pr edit`, invoke the CI resolver, or attempt another boundary command. A plan that is not yet visible while the turn is active is queued, not missing. Execute it exactly once when it starts the next turn.

## Unified PR-boundary launch plan

The Pi extension is the sole automatic boundary dispatcher. Do not independently infer or duplicate an automatic CI launch from the preceding Git command. When it emits a launch plan or follow-up in the next turn:

1. Launch every review agent listed in wave 1 together through public `subagent` calls with `run_in_background: true` and `inherit_context: false`. Preserve the exact `review_range=<acknowledged>..<current>` marker when supplied.
2. Immediately after issuing the wave-1 calls—not after reviewer completion—run the plan's wave-2 resolver exactly once:

   ```bash
   node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> cwd=<absolute-repo-root> reviewState=<launched|not-required>
   ```

3. No stdout means no CI monitor is requested. Otherwise parse the sole JSON object and submit it unchanged exactly once through the public `subagent` tool. CI is the last launch for that boundary.
4. Wait for every required reviewer result before evaluating findings, editing, committing, or pushing. CI completion is independent and never gates review acknowledgement.

A plan may contain reviewers only, CI only, or both. Vibe-coding repositories receive CI-only plans for eligible boundaries. The resolver returns no request when launch order is unresolved, repository cwd is absent, or there is no open PR targeting `main`/`master`. If monitoring aborts, do not relaunch it automatically; a later eligible boundary plan or explicit user request may launch a new monitor.

## SDD review flow

- **Vibe-coding** (no `sdd/`): pushes and PR creation do not launch reviewers; an eligible plan may still launch CI.
- **SDD mode** (`sdd/` + `sdd/README.md`): the launch plan lists only required reviewer lanes for work headed to `main`/`master`.
- Reviewers are independent and report-only. The root main session evaluates all findings, fixes legitimate findings, and alone commits or pushes follow-up work. No subagent pushes.
- Review and CI never launch, wait for, or recover each other. Reload may lose active reviewer or CI work; only a later supported boundary or explicit user request starts fresh work.

## Hard obligations

<!-- git-workflow-hard-obligations -->

- After a successful push or PR creation, stop the current turn before any other tool call so the queued boundary plan can be delivered.
- Never search for, recreate, or retrigger a boundary plan from the same turn; in particular, never use a no-op `gh pr edit` as a delivery mechanism.
- Obey each extension-issued launch plan exactly once in the next turn: all listed reviewers first, independent CI last, without waiting between waves.
- Never create a second automatic CI trigger from the Git command itself.
- Pass explicit repository cwd and review launch state. Submit a returned CI request unchanged exactly once through public `subagent`; no request means no monitor.
- Never run long CI, deploy, log, watch, or polling commands in the root session.
- Wait for all required visible reviewers before fixing, committing, or pushing review follow-up work unless the user explicitly directs otherwise.
- Never deploy to integration until every required CI check is green.
