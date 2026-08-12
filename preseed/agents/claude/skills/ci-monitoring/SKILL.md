---
name: ci-monitoring
description: Starts one detached GitHub Actions monitor for an eligible PR-boundary plan, an explicit user request, or a deploy/merge gate.
version: 1.3.0
---

# On-Demand CI Monitoring

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). Do not auto-start this monitor after routine pushes. Start it for an eligible protected-base PR-boundary plan, when the user explicitly asks to monitor CI, or when a deploy/merge gate needs a fresh CI result. You MUST wait for ALL workflows for the monitored HEAD to finish before claiming green or deploying.

## Continuous background monitor pattern

When monitoring is requested, use **one detached bounded monitor** per pushed HEAD. Do not manually issue repeated GitHub Actions polling calls in the conversation. Launch the temp script, print its `CI_MONITOR_STARTED ... log=<path>` handle, and leave the long-running polling inside that script so the main session stays free.

The monitor appends progress and the terminal `CI_RESULT` line to its durable temp log. The printed log path is the completion source; the short launcher output is not proof of CI success or failure.

### Toolset selection - runs under Bash *or* `ctx_*`

The launcher is plain shell and runs under either toolset. `gh` and `node` work fine **inside** a `ctx_execute` shell subprocess (a context-mode routing gate only intercepts the Bash *tool*, not the binaries), so a session that cannot run `gh` through the Bash tool can still run the exact same launcher through `ctx_*`. Pick whichever the session supports; never fall back to manual chat polling.

- **Native Bash tool** (default when the Bash tool can run `gh`/`node`): run the launcher as a short command. It starts `setsid bash "$SCRIPT" ... &` and returns after printing `CI_MONITOR_STARTED`.
- **context-mode `ctx_*` tools** (use when a Bash `git push`/`gh`/`node` call is rejected with a "violates routing" / context-mode error, e.g. Claude Code + context-mode): run the same launcher through `ctx_execute` with `language: "shell"` and `background: true`.

Detection rule: if a `git push`/`gh` Bash call returns a routing-gate error, use the `ctx_*` path; otherwise use the Bash path. Either way it is exactly **one** detached monitor per HEAD, and its durable log must be read before any CI claim.

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
    if [ "$stable_done" -ge 2 ]; then echo "CI_RESULT success head=$head" >> "$log"; exit 0; fi
  else
    stable_done=0
    last_fingerprint=""
  fi
  if [ $rc -eq 10 ]; then echo "CI_RESULT failure head=$head" >> "$log"; exit 10; fi
  sleep 15
done
echo "CI_RESULT timeout head=$head" >> "$log"
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

Every terminal line names the head it is about, because a monitor outlives its
head: push again and the old one keeps polling, then reports a verdict for a head
nobody is waiting on. Check the `head=` before acting on any of these.

- `CI_RESULT success head=<sha>` and every row is `completed/success` or `completed/skipped` -> that head passed.
- `CI_RESULT failure head=<sha>` -> inspect failing runs with `gh run view <id> --log-failed`, fix, commit, push, and start a new detached monitor for the new HEAD.
- `CI_RESULT timeout head=<sha>` -> stop and escalate to the user; do not claim green.

A result whose `head=` is not the current HEAD is not a verdict on the current
HEAD, whatever it says. It satisfies no merge or deploy gate. Read the current
head's log instead, which is a separate file: the log path is keyed by head.

Never claim CI is passing from the launcher output alone. Only a terminal
`CI_RESULT success` line naming the current HEAD is green.

## Stale-run cancellation: not your job

Do not cancel runs from here. The workflows decide this themselves, and they are
the only thing that knows which runs are safe to cancel.

Every workflow whose superseded runs are worth killing already declares
`concurrency` with `cancel-in-progress: true`. Most key the group on
`github.ref` (`test`, `codeql`, `zizmor`, `fuzz`, `scorecard`), which for a
`pull_request` event is the per-PR merge ref, so two PRs sharing a head branch
name never cancel each other while superseded pushes of the same PR always do.
`pentest` and `stress-test` use a constant group instead and self-cancel across
branches, which is what they want. Either way the choice is per workflow, and a
client script reconstructing it from a branch name gets it wrong.

The ones that omit it omit it deliberately. `deploy.yml` sets
`cancel-in-progress: false` because a cancelled deploy leaves the worker,
secrets, KV, and registry half-configured; `sign-release.yml` and
`bump-shadow-pins.yml` do the same. A `gh run cancel` loop driven from a branch
name cannot see any of that, so it eventually cancels the one run that must
never be cancelled.

## Binding invocation rule

Invoke this skill only when the user explicitly asks to monitor CI, or when a deploy/merge gate requires a fresh CI result. Routine pushes must not start a monitor. When this skill is invoked, start the **one** detached monitor for the target HEAD via whichever launch path the session supports (native Bash, or `ctx_execute` when Bash `gh` is routing-gated), then read the printed log path until a terminal `CI_RESULT` appears before claiming green or deploying.
