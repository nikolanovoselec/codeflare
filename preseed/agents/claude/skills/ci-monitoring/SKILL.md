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
  # A monitor outlives its head: pushing again leaves this one polling a head
  # nobody is waiting on, and its CI_RESULT is shaped exactly like an
  # authoritative one. Exit on a distinct token instead. The exit codes differ
  # from success (0) too, because the ctx_execute background path surfaces a
  # status and a wrapper keying on it would otherwise read this as green.
  tip=$(git ls-remote origin "refs/heads/$branch" 2>/dev/null | cut -f1)
  if [ -n "$tip" ] && [ "$tip" != "$head" ]; then
    # A differing tip has two causes and only one is safe to ignore. Fetch the
    # ref so ancestry is answerable at all; this runs once, on the way out.
    git fetch -q origin "refs/heads/$branch" >/dev/null 2>&1 || true
    if git merge-base --is-ancestor "$head" "$tip" >/dev/null 2>&1; then
      echo "CI_RESULT superseded head=$head tip=$tip" >> "$log"
      exit 125
    fi
    echo "CI_RESULT unpushed head=$head tip=$tip" >> "$log"
    exit 126
  fi
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
# Cancel in-flight runs from superseded heads on this branch. Folded in here
# on purpose: as a separate step it gets skipped, and a superseded head then
# burns a full matrix nobody reads.
#
# Cancelling is irreversible, so it is guarded HARDER than polling, not less.
# Two conditions: this checkout must actually be the remote tip (otherwise a
# stale checkout or a concurrent push would cancel the CURRENT head's CI), and
# each candidate must be an ancestor of it (so an unrelated lineage sharing the
# ref is never touched). Failures are reported, never swallowed: a silently
# failed cancel leaves a branch that never goes green with nothing saying why.
TIP=$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
if [ -n "$TIP" ] && [ "$TIP" = "$HEAD" ]; then
  gh run list --branch "$BRANCH" --limit 24 --json databaseId,headSha,status \
    --jq ".[] | select(.status != \"completed\") | select(.headSha != \"$HEAD\") | [.databaseId, .headSha] | @tsv" \
    | while IFS="$(printf '\t')" read -r run_id run_sha; do
        [ -n "$run_id" ] || continue
        git merge-base --is-ancestor "$run_sha" "$HEAD" >/dev/null 2>&1 || continue
        gh run cancel "$run_id" >/dev/null 2>&1 \
          || printf 'warning: could not cancel superseded run %s\n' "$run_id" >&2
      done
else
  printf 'warning: local HEAD %s is not the remote tip %s; skipping stale-run cancellation\n' "$HEAD" "${TIP:-unknown}" >&2
fi
setsid bash "$SCRIPT" "$PWD" "$BRANCH" "$HEAD" "$LOG" >/dev/null 2>&1 &
printf 'CI_MONITOR_STARTED head=%s pid=%s log=%s\n' "$HEAD" "$!" "$LOG"
```

### Launch wrappers

The launcher above is safe to run through either toolset:

- **Bash tool:** run it as a short background-launch command and stop after printing `CI_MONITOR_STARTED`.
- **`ctx_execute` (context-mode):** run the same launcher with `language: "shell"` and `background: true`; the detached `setsid bash "$SCRIPT" ...` monitor owns the long poll, and the printed log path is the recovery handle.

## Reading the result

Read the printed log path until it contains a terminal result line for the current HEAD:

- `CI_RESULT success` and every row is `completed/success` or `completed/skipped` -> CI passed.
- `CI_RESULT failure` -> inspect failing runs with `gh run view <id> --log-failed`, fix, commit, push, and start a new detached monitor for the new HEAD.
- `CI_RESULT timeout` -> stop and escalate to the user; do not claim green.
- `CI_RESULT superseded head=<sha> tip=<sha>` (exit 125) -> the branch moved on
  while this monitor was polling, and the head it names is an ancestor of the new
  tip. It is NOT a verdict: it satisfies no merge or deploy gate, and that head
  needs no investigation. Report it as superseded and read the current head's log.
- `CI_RESULT unpushed head=<sha> tip=<sha>` (exit 126) -> the monitored head is
  NOT an ancestor of the remote tip, so it never reached the remote. This one does
  need investigation: the push failed, or the monitor was launched against the
  wrong branch. Never treat it as superseded.

Never claim CI is passing from the launcher output alone. Only a terminal `CI_RESULT success` line in the durable log for the current HEAD is green.

## Stale-run cancellation

Before pushing a new commit, cancel still-running runs from the previous pushed HEAD:

```bash
gh run list --branch <branch> --limit 12 --json databaseId,status \
  --jq '.[] | select(.status != "completed") | .databaseId' \
  | xargs -r -I{} gh run cancel {}
```

## Binding invocation rule

Invoke this skill only when the user explicitly asks to monitor CI, or when a deploy/merge gate requires a fresh CI result. Routine pushes must not start a monitor. When this skill is invoked, start the **one** detached monitor for the target HEAD via whichever launch path the session supports (native Bash, or `ctx_execute` when Bash `gh` is routing-gated), then read the printed log path until a terminal `CI_RESULT` appears before claiming green or deploying.
