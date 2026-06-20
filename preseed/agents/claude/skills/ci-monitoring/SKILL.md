---
name: ci-monitoring
description: On-demand CI monitoring. Runs one continuous tail-followed GitHub Actions monitor in a background task only when the user explicitly asks to monitor CI, or when a deploy/merge action requires a fresh CI result.
version: 1.3.0
---

# On-Demand CI Monitoring

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). Do not auto-start this monitor after routine pushes. Start it only when the user explicitly asks to monitor CI, or when you are about to deploy/merge and need a fresh CI result. You MUST wait for ALL workflows for the monitored HEAD to finish before claiming green or deploying.

## Continuous background monitor pattern

When monitoring is requested, use **one continuous bounded monitor** per pushed HEAD. Do not manually issue repeated short polling calls in the conversation. Run it as a background task so the main session stays free for other work and can end its turn while CI runs.

The monitor writes a status line to a temp log and `tail -f`s that log until the monitor process exits, giving continuous progress without flooding the main conversation.

### Toolset selection - runs under Bash *or* `ctx_*`

The monitor is a plain shell body (below) and runs identically under either toolset; only the launch wrapper differs. `gh` and `node` work fine **inside** a `ctx_execute` shell subprocess (a context-mode routing gate only intercepts the Bash *tool*, not the binaries), so a session that cannot run `gh` through the Bash tool can still run the exact same monitor through `ctx_*`. Pick whichever the session supports; never fall back to manual chat polling.

- **Native Bash tool** (default when the Bash tool can run `gh`/`node`): launch the shell body with `run_in_background: true`. The harness detaches it and re-invokes you on exit. Retrieve that task's result before any CI claim.
- **context-mode `ctx_*` tools** (use when a Bash `git push`/`gh`/`node` call is rejected with a "violates routing" / context-mode error, e.g. Claude Code + context-mode): run the **same** shell body through `ctx_execute` with `language: "shell"` and `background: true`, wrapped in `setsid` so it survives the turn ending. Read the terminal `CI_RESULT` line from the log before any CI claim.

Detection rule: if a `git push`/`gh` Bash call returns a routing-gate error, use the `ctx_*` path; otherwise use the Bash path. Either way it is exactly **one** continuous background monitor per HEAD.

### The monitor launcher

Use the temp-script launcher below for both Bash and `ctx_execute`; it prints the durable log path before returning.

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
deadline=$((SECONDS + 1800))
while [ $SECONDS -lt $deadline ]; do
  if ! gh run list --branch "$branch" --limit 24 \
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
const bad = rows.some((r) => r.status === 'completed' && !['success', 'skipped'].includes(r.conclusion))
const done = rows.length > 0 && rows.every((r) => r.status === 'completed')
process.exit(bad ? 10 : done ? 0 : 2)
NODE
  rc=$?
  if [ $rc -eq 1 ]; then echo "CI_RESULT timeout invalid_workflow_json head=$head" >> "$log"; exit 124; fi
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

### Launch wrappers

The launcher above is safe to run through either toolset:

- **Bash tool:** run it as a short background-launch command and stop after printing `CI_MONITOR_STARTED`.
- **`ctx_execute` (context-mode):** run the same launcher with `language: "shell"` and `background: true`; the detached `setsid bash "$SCRIPT" ...` monitor owns the long poll, and the printed log path is the recovery handle.

## Reading the result

- `CI_RESULT success` and every row is `completed/success` or `completed/skipped` -> CI passed.
- `CI_RESULT failure` -> inspect failing runs with `gh run view <id> --log-failed`, fix, commit, push, and start a new continuous monitor for the new HEAD.
- `CI_RESULT timeout` -> stop and escalate to the user; do not claim green.

When the monitor is running in a background task, retrieve that task's result before making any CI claim. Never claim CI is passing without seeing the terminal `CI_RESULT success` line for the current HEAD.

## Stale-run cancellation

Before pushing a new commit, cancel still-running runs from the previous pushed HEAD:

```bash
gh run list --branch <branch> --limit 12 --json databaseId,status \
  --jq '.[] | select(.status != "completed") | .databaseId' \
  | xargs -r -I{} gh run cancel {}
```

## Binding invocation rule

Invoke this skill only when the user explicitly asks to monitor CI, or when a deploy/merge gate requires a fresh CI result. Routine pushes must not start a monitor. When this skill is invoked, start the **one** background monitor for the target HEAD via whichever launch wrapper the session supports (native Bash `run_in_background`, or `ctx_execute` + `setsid` when Bash `gh` is routing-gated), and retrieve terminal status before claiming green or deploying.
