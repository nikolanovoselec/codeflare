# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

<!-- git-workflow-ci-route -->

| Event | Skill |
|---|---|
| Any push that can produce CI, unless the user explicitly says to skip CI monitoring | `ci-monitoring` (one backgrounded agent monitors CI and reports back to the main session; never tail-follow in the main session) |
| PR-boundary event with `sdd/` present | `git-review-pipeline` (spec/doc/code review pipeline) |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## SDD opt-in is binary

- **Vibe-coding** (no `sdd/`): `git push` + `gh pr create` proceed with NO review agents.
- **SDD mode** (`sdd/` + `sdd/README.md`): review agents fire only on PR-boundary events targeting `main`/`master`. PRs into integration branches (`develop`, `staging`) defer until the integration→main PR opens.

## Review push gate

Do not push while a PR-boundary review is running, pending, missing, stale, or otherwise
incomplete for the current head unless the user explicitly authorizes pushing despite that
active or incomplete review.

## Hard obligations

<!-- git-workflow-hard-obligations -->

- Do not push while a review is running, unless explicitly authorized by the user.
- After any push that can produce CI, invoke `ci-monitoring` unless the user explicitly says to skip CI monitoring for that push.
- CI monitoring must run in a backgrounded agent/subagent. Never run `tail -f`, `gh run watch`, a foreground polling loop, or any long-running CI wait in the main assistant turn. Start the backgrounded agent, report the tracking/log path, and stop so review results can be emitted into the main session.
- The CI-monitoring background agent does not fix, commit, or push. It reports `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout` plus relevant run/log pointers back to the main session; the main session owns any fix/commit/push work.
- Any long-running wait/monitor/poll (CI, deploy status, review completion, log tailing, `watch`, `tail -f`, `gh run watch`, `while sleep` loops, or `ctx_execute`/Bash used as a blocking monitor) must run detached/background or in a subagent/background task. Never keep the main session busy waiting for external state; `ctx_execute` is not an exception. Start only a short background launcher, report how to check it, and stop.
- Never deploy to integration until every required CI run is green.
- Skipping `ci-monitoring` after a CI-producing push without an explicit user skip instruction is HIGH `ci-monitoring-skill-not-invoked`.
