---
name: ci-monitoring
description: Pi-native background CI monitoring after every CI-producing push unless the user explicitly skips it; never blocks the main session.
version: 1.0.0
---

# Pi Background CI Monitoring

After any push that can produce CI, the main session must start exactly one backgrounded subagent to monitor the pushed HEAD unless the user explicitly says to skip CI monitoring for that push.

## Hard rule: never monitor in the main session

CI monitoring MUST run in a backgrounded subagent. Do not run `tail -f`, `gh run watch`, foreground polling loops, `while sleep`, or any long-running wait in the main assistant turn. The main session starts the background monitor, reports the tracking/log path, and stops so review results can hand off cleanly.

## Background subagent prompt

Use this task shape:

```text
Monitor CI for <repo> at HEAD <head> on branch <branch>. Never block the main session. Use the Pi-native CI monitor contract from the ci-monitoring skill. Query workflows by exact commit with `gh run list --commit <head>`, not only by branch. Before every poll and before terminal success/failure, compare `refs/heads/<branch>` to `<head>`; if the branch advanced, report `CI_RESULT timeout superseded head=<head> current_head=<current> branch=<branch>` and stop instead of emitting stale success/failure. If no workflows appear for the pushed head within 5 minutes, report `CI_RESULT timeout` with `no_workflows_for_head=<head>` and stop. If CI fails, report `CI_RESULT failure` with workflow/run id, URL, log path, and failed-log command. If CI succeeds, report `CI_RESULT success` with the monitored head and run rows. Do not fix, commit, or push.
```

## Detached monitor script for the background subagent

<!-- ci-monitor-detached-script -->

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
if ! command -v gh >/dev/null 2>&1; then echo "CI_RESULT timeout gh_unavailable_or_auth_failed head=$head" >> "$log"; exit 124; fi
stable_done=0
last_fingerprint=""
no_rows_deadline=$((SECONDS + 300))
deadline=$((SECONDS + 1800))
exit_if_superseded() {
  current_head=""
  if current_head=$(git rev-parse "refs/heads/$branch" 2>/dev/null) && [ -n "$current_head" ] && [ "$current_head" != "$head" ]; then
    echo "CI_RESULT timeout superseded head=$head current_head=$current_head branch=$branch" >> "$log"
    exit 124
  fi
}
while [ $SECONDS -lt $deadline ]; do
  exit_if_superseded
  if ! gh run list --commit "$head" --limit 24 \
    --json databaseId,workflowName,headSha,status,conclusion,event,url \
    > "$log.json" 2>> "$log"; then
    echo "CI_RESULT timeout gh_unavailable_or_auth_failed head=$head" >> "$log"
    exit 124
  fi
  node - "$head" "$log.json" "$log.state" >> "$log" 2>> "$log" <<'NODE'
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
if (rows.length === 0) process.exit(3)
const bad = rows.some((r) => r.status === 'completed' && !['success', 'skipped'].includes(r.conclusion))
const done = rows.every((r) => r.status === 'completed')
process.exit(bad ? 10 : done ? 0 : 2)
NODE
  rc=$?
  if [ $rc -eq 1 ]; then echo "CI_RESULT timeout invalid_workflow_json head=$head" >> "$log"; exit 124; fi
  if [ $rc -eq 3 ] && [ $SECONDS -ge $no_rows_deadline ]; then echo "CI_RESULT timeout no_workflows_for_head=$head" >> "$log"; exit 124; fi
  if [ $rc -eq 0 ]; then
    fingerprint=$(node -e 'const fs=require("fs"); try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).fingerprint || "") } catch {}' "$log.state")
    if [ -n "$fingerprint" ] && [ "$fingerprint" = "$last_fingerprint" ]; then
      stable_done=$((stable_done + 1))
    else
      last_fingerprint="$fingerprint"
      stable_done=1
    fi
    if [ "$stable_done" -ge 2 ]; then exit_if_superseded; echo "CI_RESULT success" >> "$log"; exit 0; fi
  else
    stable_done=0
    last_fingerprint=""
  fi
  if [ $rc -eq 10 ]; then exit_if_superseded; echo "CI_RESULT failure" >> "$log"; exit 10; fi
  sleep 15
done
echo "CI_RESULT timeout" >> "$log"
exit 124
BASH
chmod +x "$SCRIPT"
setsid bash "$SCRIPT" "$PWD" "$BRANCH" "$HEAD" "$LOG" >/dev/null 2>&1 &
printf 'CI_MONITOR_STARTED head=%s pid=%s log=%s\n' "$HEAD" "$!" "$LOG"
```

## Result contract

The background monitor final result must start with exactly one of:

- `CI_RESULT success`
- `CI_RESULT failure`
- `CI_RESULT timeout`

A superseded monitor reports `CI_RESULT timeout superseded head=<old> current_head=<new> branch=<branch>` and must not report success or failure for the old head. Include the monitored head and log path every time. For failures, include workflow name, run id, URL, and `cd <repo> && gh run view <id> --log-failed`.

The main session's first response after receiving `CI_RESULT` must print the CI summary before analysis, tool calls, todo updates, fixes, deploys, or pushes.
