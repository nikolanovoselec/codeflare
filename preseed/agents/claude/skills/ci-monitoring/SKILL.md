---
name: ci-monitoring
description: Background CI monitoring after every CI-producing push unless the user explicitly skips it; never blocks the main session.
version: 1.5.0
---

# Background CI Monitoring

A push can trigger multiple GitHub Actions workflows for the same commit. After any push that can produce CI, start CI monitoring unless the user explicitly says to skip CI monitoring for that push. Monitoring is never owned by the main assistant turn: launch a backgrounded agent/subagent to monitor and report the result back to the main session.

## Hard rule: never monitor in the main session

<!-- ci-no-main-session-monitor -->

CI monitoring MUST run in a backgrounded agent/subagent. Do not run `tail -f`, `gh run watch`, a foreground polling loop, `ctx_execute` as a blocking monitor, Bash as a blocking monitor, or any long-running CI wait in the main assistant turn. Never keep the main session busy waiting for CI or any external state. The main session must be able to stop immediately after the backgrounded agent is launched so PR-boundary review results can be emitted into the next main-session turn.

If you catch yourself about to run any tool call that waits for CI and streams or accumulates output back to chat, stop and launch the backgrounded CI agent instead.

## Backgrounded agent pattern

<!-- ci-background-agent -->

Start one backgrounded agent/subagent per pushed HEAD. The backgrounded agent owns a bounded monitor, writes status to a temp log, and reports back to the main session with one terminal line: `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout`.

The main session launches the backgrounded agent, reports the tracking/log path, and stops. Do not read the log in a loop in the same turn.

Use this task shape for the backgrounded CI agent:

```text
Monitor CI for <repo> at HEAD <head> on branch <branch>. Never block the main session. Use one bounded workflow-agnostic monitor with a stable workflow/run-id fingerprint. If CI succeeds, report success. If CI fails, report the failed workflow/run id and failed-log command or log path to the main session. Do not fix, commit, or push. If CI times out or credentials are missing, report the blocker and stop.
```

The backgrounded agent may use this detached monitor internally:

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

Use Bash or `ctx_execute` only inside the backgrounded agent, or for the short launcher that starts that agent. `ctx_execute(background: true)` is allowed only for a short detached launcher; do not use `ctx_execute` to keep a foreground `tail -f`, `while sleep`, `gh run watch`, or any other polling/monitoring wait alive in the main session.

## Reading the result

Only read the log after the background monitor has had time to finish, after the user asks for status, or before a deploy/merge decision. Use a bounded one-shot read such as:

```bash
tail -80 /tmp/ci-monitor-<head>.log
```

- `CI_RESULT success` and every workflow row returned for the monitored head is `completed/success` or `completed/skipped` across two consecutive checks with the same workflow/run-id fingerprint -> CI passed.
- `CI_RESULT failure` -> the backgrounded agent reports the failed workflow/run id and failed-log command or log path to the main session. The main session decides and performs any fix/commit/push work.
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

Invoke this skill after every push that can produce CI unless the user explicitly says to skip CI monitoring for that push. When invoked, start exactly one backgrounded agent for the target HEAD, report the tracking/log path, and stop the main-session turn. Skipping this skill without an explicit user skip instruction is HIGH `ci-monitoring-skill-not-invoked`.
