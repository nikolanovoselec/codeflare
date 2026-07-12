# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

<!-- git-workflow-ci-route -->

| Event | Skill |
|---|---|
| A successful head-changing push, or creation of a PR targeting `main`/`master` | `ci-monitoring` request resolver; this root rule is Pi's sole automatic CI owner |
| PR-boundary reminder or follow-up with `sdd/` present | `git-review-pipeline` (visible spec/doc/code reviewers, independent of CI) |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## Automatic Pi CI launch

After a successful head-changing push or successful creation of a PR targeting `main` or `master`:

1. Resolve the GitHub `owner/repo` for the affected repository.
2. Run exactly once:

   ```bash
   node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo>
   ```

3. No stdout means no CI monitor is requested. Otherwise parse the sole JSON object and submit it unchanged exactly once through the public `subagent` tool.

The resolver returns no request when there is no open PR targeting `main`/`master`. An explicit user request is the only other reason to launch CI monitoring. If monitoring aborts, do not relaunch it automatically; a later eligible Git action or explicit user request may launch a new monitor.

## SDD review flow

- **Vibe-coding** (no `sdd/`): pushes and PR creation do not launch reviewers.
- **SDD mode** (`sdd/` + `sdd/README.md`): the Pi extension emits a reminder or follow-up listing the required reviewer lanes only for eligible work headed to `main`/`master`.
- On that instruction, the root main session calls every listed reviewer together through public `subagent` calls with `run_in_background: true` and `inherit_context: false`.
- Reviewers are independent and report-only. The root main session waits for every listed reviewer, evaluates all findings, fixes legitimate findings, and alone commits or pushes follow-up work. No subagent pushes.
- Review and CI never launch, wait for, or recover each other. Reload may lose active reviewer or CI work; only a later supported review boundary, eligible Git action, or explicit user request starts fresh work.

## Hard obligations

<!-- git-workflow-hard-obligations -->

- Resolve and invoke the automatic CI request exactly once after each eligible successful Git action; never create a second automatic CI trigger.
- Submit a returned CI request unchanged exactly once through public `subagent`; no request means no monitor.
- Never run long CI, deploy, log, watch, or polling commands in the root session.
- Wait for all required visible reviewers before fixing, committing, or pushing review follow-up work unless the user explicitly directs otherwise.
- Never deploy to integration until every required CI check is green.
