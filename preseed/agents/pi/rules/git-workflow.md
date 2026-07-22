# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

<!-- git-workflow-ci-route -->

| Event | Route |
|---|---|
| Pi PR-boundary plan | Its reviewers first, then independent CI |
| Reviewers listed | `git-review-pipeline` |
| Explicit CI request | `ci-monitoring` |
| Open a PR | `pr-workflow` |
| Credentials unclear | `deploy-credentials` |

## Mandatory boundary stop

After either eligible boundary succeeds — creating an open PR to `main`/`master`, or completing a supported explicit or implicit configured-branch push whose exact destination and head have an open PR to `main`/`master` — **end the turn immediately** and report only the push result or PR URL. Pi delivers the queued boundary plan after idle. Do not call another tool, inspect logs, search for the plan, edit the PR, invoke CI, or attempt another boundary command. Pushes with no open protected-base PR, tag-only pushes, branch deletion/pruning, mirror or multi-ref pushes, and PR edit/update/merge commands are not boundaries and do not require this stop. A plan not yet visible after an eligible boundary is queued, not missing.

## Execute one boundary plan

1. Launch all wave-1 reviewers together as public background `subagent` calls with `inherit_context: false`. Preserve exact ranges and direct-user autonomy markers.
2. Immediately run wave 2 exactly once:

   ```bash
   node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> pr=<number> cwd=<absolute-repo-root> reviewState=<launched|not-required>
   ```

3. No stdout means no monitor. Otherwise submit the sole JSON object unchanged once through public `subagent`; CI is the last launch.
4. Wait for all required reviewers; CI is independent. In a tool-free response after the latest required reviewer notification, publish one table with `FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION`. Reject unsupported proposals, make no file or Git changes, and end the turn immediately.
5. Agent-end enforcement acknowledges the reviewed head from live session state and queues the FIX follow-up; settled enforcement is the fallback. In that separate turn, apply only the accepted minimal fixes unless approval was requested.

A plan may contain reviewers, CI, or both. Vibe-coding repositories receive eligible CI only. No request is returned when launch order is unresolved, cwd is absent, or no PR targets `main`/`master`. Never relaunch an aborted monitor automatically.

With `sdd/` and `sdd/README.md`, plans list required report-only lanes for work headed to `main`/`master`; otherwise no reviewers launch. The root alone evaluates findings and writes files or Git state. Reload never authorizes duplicate work.

<!-- git-workflow-hard-obligations -->

## Hard obligations

- Never recreate or retrigger a plan or use a no-op PR edit for delivery.
- Do not mutate the reviewed work between the triage summary and its acknowledgement/FIX follow-up.
- Do not push a new head before required current-head review completes unless explicitly authorized.
- Never deploy until every required CI check is green.
