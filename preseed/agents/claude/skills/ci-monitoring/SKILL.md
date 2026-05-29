---
name: ci-monitoring
description: Post-push CI monitoring. Runs one continuous tail-followed GitHub Actions monitor per push in a background task, with bounded timeout, failure triage, and stale-run cancellation. Invoked after every git push that targets a branch with CI workflows.
version: 1.2.0
---

# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL workflows for the pushed HEAD to finish before claiming green or deploying.

## Continuous background monitor pattern

Use **one continuous bounded monitor** per pushed HEAD. Do not manually issue repeated short polling calls in the conversation.

Run that monitor in a background task/subagent so the main session stays open for more work. The background task runs the same Bash monitor below; do not rewrite it into manual polling.

The monitor writes a status line to a temp log and `tail -f`s that log until the monitor process exits. This gives continuous progress without flooding the main conversation with repeated tool calls.

### Background task wrapper

When the runtime supports background agents/tasks, launch one immediately after the push with `run_in_background: true`. The background task's only job is to run the Bash monitor below for `<repo>`, `<branch>`, and the pushed `HEAD`, then report the terminal `CI_RESULT ...` line. The main agent can continue working, but must retrieve the background result before claiming green or deploying.

If no background task facility exists, fall back to running the Bash monitor directly.

### Pi / Bash session

Inside the background task, run the monitor through the native Bash tool. Do not depend on context-mode or `ctx_*` tools; Pi must be able to monitor CI with Bash alone.

```bash
cd <repo>
BRANCH=<branch>
HEAD=$(git rev-parse HEAD)
LOG=$(mktemp /tmp/ci-monitor.XXXXXX.log)
(
  deadline=$((SECONDS + 1800))
  while [ $SECONDS -lt $deadline ]; do
    gh run list --branch "$BRANCH" --limit 12 \
      --json databaseId,workflowName,headSha,status,conclusion,event,url \
      > "$LOG.json"
    node - "$HEAD" "$LOG.json" >> "$LOG" <<'NODE'
const [head, file] = process.argv.slice(2)
const fs = require('fs')
const rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => r.headSha === head)
const stamp = new Date().toISOString()
console.log(`--- ${stamp} ${head.slice(0, 12)} ---`)
for (const r of rows) console.log(`${r.databaseId} ${r.workflowName} ${r.event} ${r.status}/${r.conclusion || ''} ${r.url}`)
const done = rows.length > 0 && rows.every((r) => r.status === 'completed')
const bad = rows.some((r) => r.status === 'completed' && !['success', 'skipped'].includes(r.conclusion))
process.exit(bad ? 10 : done ? 0 : 2)
NODE
    rc=$?
    if [ $rc -eq 0 ]; then echo "CI_RESULT success" >> "$LOG"; exit 0; fi
    if [ $rc -eq 10 ]; then echo "CI_RESULT failure" >> "$LOG"; exit 10; fi
    sleep 15
  done
  echo "CI_RESULT timeout" >> "$LOG"
  exit 124
) &
pid=$!
tail -n +1 -f "$LOG" --pid=$pid
wait $pid
```

### Other shell surfaces

Use the same shell body through the shell tool provided by the current runtime.

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

After every `git push` that targets a branch with CI workflows configured, invoke this skill immediately, start the background monitor for the pushed HEAD, and retrieve terminal status before claiming green or deploying.
