---
name: ci-monitoring
description: On-demand CI monitoring. Starts one detached GitHub Actions monitor only when explicitly requested or required by deploy/merge; never blocks the main session.
version: 1.4.0
---

# On-Demand CI Monitoring

A push can trigger multiple GitHub Actions workflows for the same commit. Do not auto-start this monitor after routine pushes. Start it only when the user explicitly asks to monitor CI, or when a deploy/merge action requires a fresh CI result.

## Hard rule: never monitor in the main session

<!-- ci-no-main-session-monitor -->

CI monitoring MUST be detached/background. Do not run `tail -f`, `gh run watch`, a foreground polling loop, `ctx_execute` as a blocking monitor, Bash as a blocking monitor, or any long-running CI wait in the main assistant turn. Never keep the main session busy waiting for CI or any external state. The main session must be able to stop immediately after the monitor is launched so PR-boundary review results can be emitted into the next main-session turn.

If you catch yourself about to run any tool call that waits for CI and streams or accumulates output back to chat, stop and use the detached launch below instead.

## Detached monitor pattern

<!-- ci-detached-monitor -->

Use one bounded detached monitor per pushed HEAD. It writes status to a temp log and exits with one terminal line: `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout`.

Launch the monitor with a short command that returns immediately, then end your turn with the log path. Do not read the log in a loop in the same turn.

```bash
cd <repo>
BRANCH=<branch>
HEAD=$(git rev-parse HEAD)
LOG="/tmp/ci-monitor-${HEAD}.log"
SCRIPT="/tmp/ci-monitor-${HEAD}.sh"
cat > "$SCRIPT" <<'BASH'
#!/usr/bin/env bash
set -u
repo="$1"
branch="$2"
head="$3"
log="$4"
cd "$repo" || exit 124
: > "$log"
stable_done=0
last_fingerprint=""
deadline=$((SECONDS + 1800))
while [ $SECONDS -lt $deadline ]; do
  gh run list --branch "$branch" --limit 24 \
    --json databaseId,workflowName,headSha,status,conclusion,event,url \
    > "$log.json"
  node - "$head" "$log.json" "$log.state" >> "$log" <<'NODE'
const [head, file, stateFile] = process.argv.slice(2)
const fs = require('fs')
const rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => r.headSha === head)
const fingerprint = rows
  .map((r) => `${r.databaseId}:${r.workflowName}:${r.event}`)
  .sort()
  .join('|')
fs.writeFileSync(stateFile, JSON.stringify({ fingerprint }))
const stamp = new Date().toISOString()
console.log(`--- ${stamp} ${head.slice(0, 12)} ---`)
if (rows.length === 0) console.log('waiting for workflows to appear')
for (const r of rows) console.log(`${r.databaseId} ${r.workflowName} ${r.event} ${r.status}/${r.conclusion || ''} ${r.url}`)
const bad = rows.some((r) => r.status === 'completed' && !['success', 'skipped'].includes(r.conclusion))
const done = rows.length > 0 && rows.every((r) => r.status === 'completed')
process.exit(bad ? 10 : done ? 0 : 2)
NODE
  rc=$?
  if [ $rc -eq 0 ]; then
    fingerprint=$(node -e 'const fs=require("fs"); try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).fingerprint || "") } catch {}' "$log.state")
    if [ -n "$fingerprint" ] && [ "$fingerprint" = "$last_fingerprint" ]; then
      stable_done=$((stable_done + 1))
    else
      last_fingerprint="$fingerprint"
      stable_done=1
    fi
    if [ "$stable_done" -ge 2 ]; then echo "CI_RESULT success" >> "$log"; exit 0; fi
  else
    stable_done=0
    last_fingerprint=""
  fi
  if [ $rc -eq 10 ]; then echo "CI_RESULT failure" >> "$log"; exit 10; fi
  sleep 15
done
echo "CI_RESULT timeout" >> "$log"
exit 124
BASH
chmod +x "$SCRIPT"
setsid bash "$SCRIPT" "$PWD" "$BRANCH" "$HEAD" "$LOG" >/dev/null 2>&1 &
printf 'CI_MONITOR_STARTED head=%s pid=%s log=%s\n' "$HEAD" "$!" "$LOG"
```

<!-- ci-workflow-row-fingerprint -->

Use Bash or `ctx_execute` for the short launcher, but the launcher must return immediately. `ctx_execute(background: true)` is allowed only for this short detached launcher; do not use `ctx_execute` to keep a foreground `tail -f`, `while sleep`, `gh run watch`, or any other polling/monitoring wait alive.

## Reading the result

Only read the log after the background monitor has had time to finish, after the user asks for status, or before a deploy/merge decision. Use a bounded one-shot read such as:

```bash
tail -80 /tmp/ci-monitor-<head>.log
```

- `CI_RESULT success` and every workflow row returned for the monitored head is `completed/success` or `completed/skipped` across two consecutive checks with the same workflow/run-id fingerprint -> CI passed.
- `CI_RESULT failure` -> inspect the failed run with `gh run view <id> --log-failed`, fix, commit, push, and start a new detached monitor for the new HEAD.
- `CI_RESULT timeout` -> stop and escalate to the user; do not claim green.

Never claim CI is passing without seeing `CI_RESULT success` for the current HEAD.

## Stale-run cancellation

Before pushing a new commit, cancel still-running runs from the previous pushed HEAD:

```bash
gh run list --branch <branch> --limit 24 --json databaseId,status \
  --jq '.[] | select(.status != "completed") | .databaseId' \
  | xargs -r -I{} gh run cancel {}
```

## Binding invocation rule

Invoke this skill only when the user explicitly asks to monitor CI, or when a deploy/merge gate requires a fresh CI result. Routine pushes must not start a monitor. When invoked, start exactly one detached monitor for the target HEAD, report the log path, and stop the main-session turn.
