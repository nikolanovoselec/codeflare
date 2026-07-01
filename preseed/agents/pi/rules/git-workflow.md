# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

<!-- git-workflow-ci-route -->

| Event | Skill |
|---|---|
| A push or PR that opens or syncs a PR to `main`/`master` (an open main-bound PR exists for the head), unless the user explicitly says to skip CI monitoring | `ci-monitoring` — the CI monitor is spawned together with `review-monitor` from the PR-boundary `codeflare-visible-monitor-handoff` (one backgrounded agent per head; never tail-follow in the main session). No open main-bound PR ⇒ no CI monitoring. |
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
- CI monitoring shares the review trigger: the CI monitor is spawned **together with `review-monitor` from the `codeflare-visible-monitor-handoff`** when a push/PR opens or syncs a PR to `main`/`master` (see the handoff obligation below), unless the user explicitly says to skip it. Do **not** also start a separate per-push CI monitor — that second monitor is what collided with the handoff's ("Agent is already processing a prompt") and killed it. A head with no open main-bound PR is not CI-monitored.
- CI monitoring must run in a backgrounded agent/subagent. Never run `tail -f`, `gh run watch`, a foreground polling loop, or any long-running CI wait in the main assistant turn. Start the backgrounded agent, report the visible agent ID/tracking/log path, and stop so review results can be emitted into the main session.
- The CI-monitoring background agent does not fix, commit, or push. It reports `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout` plus relevant run/log pointers back to the main session; the main session owns any fix/commit/push work.
- If a CI monitor task stops, errors, or completes without a `CI_RESULT` for the current head, immediately start a replacement exact-head CI monitor unless the head was superseded or the user explicitly skipped CI monitoring.
- Any long-running wait/monitor/poll (CI, deploy status, review completion, log tailing, `watch`, `tail -f`, `gh run watch`, `while sleep` loops, or `ctx_execute`/Bash used as a blocking monitor) must run detached/background or in a subagent/background task. Never keep the main session busy waiting for external state; `ctx_execute` is not an exception. Start only a short background launcher, report how to check it, and stop.
- Never deploy to integration until every required CI run is green.
- After opening or syncing an SDD PR to `main`/`master`, obey any `codeflare-visible-monitor-handoff` follow-up immediately: spawn **both** the visible `review-monitor` **and** the CI-monitor background agents for the exact head, then report their agent IDs. This handoff is the **single** trigger for both monitors — do not also start a separate per-push CI monitor. If no handoff appears but `.git/codeflare-review-jobs/<head>/job.json` exists, verify/start **both** the `review-monitor` and the CI monitor for the exact head immediately. This is monitor delivery, not reviewer spawning. If a monitor stops/completes without its `REVIEW_RESULT`/`CI_RESULT`, restart it from the existing job prompt/result paths.
- When a main-bound PR is open, skipping the handoff's CI monitor without an explicit user skip instruction is HIGH `ci-monitoring-skill-not-invoked`.
