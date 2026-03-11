# Deploy

Push current branch to remote, monitor all CI workflows, and deploy to the target environment after CI passes.

## Arguments

$ARGUMENTS can be:
- `integration` (default) — deploy to integration environment
- `production` — deploy to production environment

## Instructions

### Step 1: Pre-flight

1. Run `git status` — warn if there are uncommitted changes
2. Run `git log --oneline -3` — show what's about to be deployed
3. Confirm with user before proceeding

### Step 2: Cancel Stale CI

Cancel any still-running CI runs from previous pushes on this branch:

```bash
gh run list --branch <branch> --limit 5 --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' | xargs -I{} gh run cancel {}
```

### Step 3: Push

```bash
git push origin <branch>
```

### Step 4: Monitor CI

Start a background poll that checks ALL runs every 15 seconds until all complete:

```bash
while true; do
  echo "$(date +%H:%M:%S)"
  gh run list --branch <branch> --limit 5 --json databaseId,name,status,conclusion \
    --template '{{range .}}{{.databaseId}}{{"\t"}}{{.name}}{{"\t"}}{{.status}}{{"\t"}}{{.conclusion}}{{"\n"}}{{end}}'
  ALL_DONE=$(gh run list --branch <branch> --limit 5 --json status \
    --template '{{$all := true}}{{range .}}{{if ne .status "completed"}}{{$all = false}}{{end}}{{end}}{{$all}}')
  if [ "$ALL_DONE" = "true" ]; then
    ANY_FAILED=$(gh run list --branch <branch> --limit 5 --json conclusion \
      --template '{{$fail := false}}{{range .}}{{if ne .conclusion "success"}}{{$fail = true}}{{end}}{{end}}{{$fail}}')
    if [ "$ANY_FAILED" = "true" ]; then
      echo "COMPLETED WITH FAILURES"
    else
      echo "ALL GREEN"
    fi
    break
  fi
  sleep 15
done
```

Use `run_in_background: true` with timeout 600000ms. Do NOT use `gh run watch`.

### Step 5: Evaluate Results

- If ALL GREEN → proceed to Step 6
- If COMPLETED WITH FAILURES → identify failed run IDs, run `gh run view $RUN_ID --log-failed`, report failures to user. Do NOT deploy.

### Step 6: Deploy

For **integration**:
```bash
npx wrangler deploy --env integration
```

For **production**:
- Confirm with user: "Deploying to PRODUCTION. All CI green. Proceed?"
- Only after explicit confirmation:
```bash
npx wrangler deploy --env production
```

### Step 7: Verify Deployment

After deploy, hit the health endpoint to confirm the new version is live:
```bash
curl -s https://<worker-url>/health | jq .
```

Report the deployed version and health status.
