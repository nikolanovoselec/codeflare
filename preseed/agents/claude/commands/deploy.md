# Deploy

Push current branch to remote, monitor all CI workflows, and deploy to the target environment after CI passes.

## Arguments

$ARGUMENTS can be:
- `integration` (default) — deploy to integration environment
- `production` — deploy to production environment

## Shell execution (applies to every step)

Every shell snippet in this command runs through one of two transparent paths,
depending on whether the session has context-mode active:

- **Context-mode session** — `enforce-ctx-mode.sh` denies `gh`, `while`, `until`,
  `echo`, `head`, `tail`, `awk`, `sed`, `cat` in the native Bash tool and routes
  them through `mcp__context-mode__ctx_execute(language: "shell", code: "<body>")`
  (or `ctx_batch_execute` for multi-step batches). The sandbox interior is
  unrestricted shell; output stays in sandbox FTS5.
- **Non-context-mode session** — same snippet body via the Bash tool directly.
  No routing layer, no denial list, same observable result.

The two paths are byte-equivalent in command body and output. When this file
shows a bare code block, run it via whichever path your session is in. There is
no separate "context-mode version" of any command.

## Instructions

### Step 1: Pre-flight

1. Run `git status` — warn if there are uncommitted changes
2. Run `git log --oneline -3` — show what's about to be deployed
3. Confirm with user before proceeding

### Step 2: Cancel Stale CI

Cancel any still-running CI runs from previous pushes on this branch:

```
gh run list --branch <branch> --limit 5 --json databaseId,status \
  --jq '.[] | select(.status != "completed") | .databaseId' \
  | xargs -I{} gh run cancel {}
```

### Step 3: Push

```
git push origin <branch>
```

### Step 4: Monitor CI — bounded per-iteration polling

**DO NOT** spawn a long-running `while true` loop. Long-running scripts hang on
CI stalls, network blips, or shell quoting bugs — and the agent cannot
intervene mid-flight. INSTEAD: run **one** 15-second-spaced check per
iteration, read the table, decide, repeat. Cap at ~30 iterations
(~7-8 min wall time) before escalating to the user.

Each iteration is one shell call (via ctx_execute or Bash, per the routing note
above):

```
sleep 15
gh run list --branch <branch> --limit 5 --json databaseId,name,status,conclusion \
  --template '{{range .}}{{.databaseId}}{{"\t"}}{{.name}}{{"\t"}}{{.status}}{{"\t"}}{{.conclusion}}{{"\n"}}{{end}}'
```

After every iteration, read the printed table and decide explicitly:

1. **Every row `completed` + `success`** → CI passed. Proceed to Step 5.
2. **Every row `completed` + at least one non-`success`** → failure. For each
   failed run, inspect via `gh run view <id> --log-failed`. Fix, commit, push,
   then restart at iteration 1.
3. **Any row still `queued` or `in_progress`** → call the same one-shot snippet
   again to recheck 15 seconds later.
4. **Iteration cap (~30, ~7-8 min)** → stop polling, escalate to user. Don't
   burn cycles forever; something is genuinely stuck.

Never use `gh run watch` — it hangs. Never claim "CI is passing" without seeing
every row `completed` AND `success` in the **same** iteration.

### Step 5: Evaluate Results

- All rows `completed` + `success` → proceed to Step 6.
- Any row `completed` with non-`success` conclusion → identify failed run IDs,
  run `gh run view $RUN_ID --log-failed`, report failures to user. Do NOT deploy.

### Step 6: Deploy

For **integration**:
```
npx wrangler deploy --env integration
```

For **production**:
- Confirm with user: "Deploying to PRODUCTION. All CI green. Proceed?"
- Only after explicit confirmation:
```
npx wrangler deploy --env production
```

### Step 7: Verify Deployment

After deploy, hit the health endpoint to confirm the new version is live:
```
curl -s https://<worker-url>/health | jq .
```

Report the deployed version and health status.
