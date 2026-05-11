# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL of them to pass before deploying or proceeding.

## The polling pattern

DO NOT spawn a long-running `while true` script that blocks until CI completes. Long-running scripts get stuck on CI hangs, network blips, runaway sleeps, or shell quoting bugs — and the agent can't intervene mid-flight, so the session can hang waiting on the orphaned poll.

INSTEAD: run a **single bounded check** every 15 seconds. Each iteration is one `gh run list` call. After every iteration you read the table and decide explicitly: succeed, fail-and-fix, or check again. The decision belongs to you, not to a shell while-loop.

### One iteration — context-mode session

`enforce-ctx-mode.sh` denies `gh` / `while` / `echo` / `tail` via the native Bash tool. Each iteration goes through `mcp__context-mode__ctx_execute(language:"shell", code:"...")`. The sandbox interior is unrestricted shell. Output stays in the sandbox FTS5 (near-zero context burn); only the printed table reaches your context.

```
mcp__context-mode__ctx_execute(language: "shell", code:
  sleep 15
  gh run list --branch <branch> --limit 5 \
    --json databaseId,name,status,conclusion \
    --template '{{range .}}{{.databaseId}}{{"\t"}}{{.name}}{{"\t"}}{{.status}}{{"\t"}}{{.conclusion}}{{"\n"}}{{end}}')
```

Each call sleeps 15 seconds (spacing consecutive iterations) and runs one `gh run list`. ~15 seconds blocked per iteration; full control between iterations.

### One iteration — non-context-mode (vibe-coding) session

Same single-check body via the Bash tool (no `run_in_background:true` — each call is short and bounded):

```
Bash(sleep 15 && gh run list --branch <branch> --limit 5 \
  --json databaseId,name,status,conclusion \
  --template '{{range .}}{{.databaseId}}{{"\t"}}{{.name}}{{"\t"}}{{.status}}{{"\t"}}{{.conclusion}}{{"\n"}}{{end}}')
```

## Reading each iteration's table

After every iteration:

1. **Every row `completed` + `success`** → CI passed. Proceed.
2. **Every row `completed` + at least one non-success** → failure. For each failed run, inspect via `ctx_execute(language:"shell", code:"gh run view <id> --log-failed")` (or `Bash(gh run view <id> --log-failed)` outside context-mode). Fix, commit, push, then restart polling from iteration 1.
3. **Any row still `queued` or `in_progress`** → call the same iteration ctx_execute / Bash again to check 15 seconds later.
4. **Iteration cap: ~30 (~7-8 min wall time)** — if CI hasn't reached a terminal state by then, stop polling and escalate to the user. Don't burn cycles forever; something is genuinely stuck.
5. NEVER claim "CI is passing" without seeing every row `completed` AND `success` in the same iteration.
6. NEVER deploy to integration until every CI run from the push is green.

## Stale-run cancellation

Before pushing a new commit, cancel still-running runs from the previous push (they're stale and waste minutes):

```
mcp__context-mode__ctx_execute(language: "shell", code:
  gh run list --branch <branch> --limit 5 --json databaseId,status \
    --jq '.[] | select(.status != "completed") | .databaseId' \
    | xargs -I{} gh run cancel {})
```

Vibe-coding: same body via Bash directly.

## Do NOT

- `gh run watch` — hangs.
- `while true; do ... done` inside a single ctx_execute or Bash call — bypasses your ability to intervene.
- Claim CI passed without explicitly seeing every row `completed` + `success`.
