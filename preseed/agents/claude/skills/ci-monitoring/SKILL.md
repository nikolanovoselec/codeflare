---
name: ci-monitoring
description: Post-push CI monitoring. Runs one continuous tail-followed GitHub Actions monitor per push in a background task (native Bash run_in_background, or ctx_execute + setsid when Bash gh is routing-gated), with bounded timeout, failure triage, and stale-run cancellation. Invoked after every git push that targets a branch with CI workflows.
version: 1.3.0
---

# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL workflows for the pushed HEAD to finish before claiming green or deploying.

## Continuous background monitor pattern

Use **one continuous bounded monitor** per pushed HEAD. Do not manually issue repeated short polling calls in the conversation. Run it as a background task so the main session stays free for other work and can end its turn while CI runs.

The monitor writes a status line to a temp log and `tail -f`s that log until the monitor process exits, giving continuous progress without flooding the main conversation.

### Toolset selection - runs under Bash *or* `ctx_*`

The monitor is a plain shell body (below) and runs identically under either toolset; only the launch wrapper differs. `gh` and `node` work fine **inside** a `ctx_execute` shell subprocess (a context-mode routing gate only intercepts the Bash *tool*, not the binaries), so a session that cannot run `gh` through the Bash tool can still run the exact same monitor through `ctx_*`. Pick whichever the session supports; never fall back to manual chat polling.

- **Native Bash tool** (default when the Bash tool can run `gh`/`node`): launch the shell body with `run_in_background: true`. The harness detaches it and re-invokes you on exit. Retrieve that task's result before any CI claim.
- **context-mode `ctx_*` tools** (use when a Bash `git push`/`gh`/`node` call is rejected with a "violates routing" / context-mode error, e.g. Claude Code + context-mode): run the **same** shell body through `ctx_execute` with `language: "shell"` and `background: true`, wrapped in `setsid` so it survives the turn ending. Read the terminal `CI_RESULT` line from the log before any CI claim.

Detection rule: if a `git push`/`gh` Bash call returns a routing-gate error, use the `ctx_*` path; otherwise use the Bash path. Either way it is exactly **one** continuous background monitor per HEAD.

### The monitor (shell body, identical for both toolsets)

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

### Launch wrappers

The body above is launch-neutral. Wrap it per toolset:

- **Bash tool:** pass the body verbatim as the command with `run_in_background: true`. The `( … ) & … tail -f … --pid` shape keeps the call alive until the loop exits; the harness notifies you on completion.
- **`ctx_execute` (context-mode):** detach the body from the turn so it outlives the session stopping:

  ```bash
  setsid bash -c '<body>' >/dev/null 2>&1 &
  ```

  invoked via `ctx_execute(language: "shell", background: true)`. The detached monitor keeps appending to its `$LOG` after the turn ends; read that log to retrieve the terminal `CI_RESULT` line. (Inside the ctx subprocess `gh`/`node` are not gated.)

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

After every `git push` that targets a branch with CI workflows configured, invoke this skill immediately, start the **one** background monitor for the pushed HEAD via whichever launch wrapper the session supports (native Bash `run_in_background`, or `ctx_execute` + `setsid` when Bash `gh` is routing-gated), and retrieve terminal status before claiming green or deploying.
