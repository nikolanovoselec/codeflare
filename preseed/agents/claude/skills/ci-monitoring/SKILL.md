---
name: ci-monitoring
description: Post-push CI monitoring. Uses one continuous tail-followed GitHub Actions monitor per push, with bounded timeout, failure triage, and stale-run cancellation. Invoked after every git push that targets a branch with CI workflows.
version: 1.1.0
---

# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL workflows for the pushed HEAD to finish before claiming green or deploying.

## Continuous monitor pattern

Use **one continuous bounded monitor** per pushed HEAD. Do not manually issue repeated short polling calls in the conversation.

The monitor writes a status line to a temp log and `tail -f`s that log until the monitor process exits. This gives the user continuous progress without flooding the conversation with repeated tool calls.

### Pi / Bash session

Run the monitor through the native Bash tool. Do not depend on context-mode or `ctx_*` tools; Pi must be able to monitor CI with Bash alone.

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

Never claim CI is passing without seeing the terminal `CI_RESULT success` line for the current HEAD.

## Stale-run cancellation

Before pushing a new commit, cancel still-running runs from the previous pushed HEAD:

```bash
gh run list --branch <branch> --limit 12 --json databaseId,status \
  --jq '.[] | select(.status != "completed") | .databaseId' \
  | xargs -r -I{} gh run cancel {}
```

## Binding invocation rule

After every `git push` that targets a branch with CI workflows configured, invoke this skill immediately and monitor the pushed HEAD to terminal status.
