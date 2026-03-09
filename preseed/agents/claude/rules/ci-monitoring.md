# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL of them to pass before deploying or proceeding.

## After every push

1. Run a single background Bash poll loop (timeout 600000ms) that checks ALL runs every 15s until all complete AND all succeed:
   ```
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
   Use `run_in_background: true` so the poll does not burn context tokens. You will be notified when it finishes.
2. When notified, read the output. If it ends with `ALL GREEN`, CI passed. If it ends with `COMPLETED WITH FAILURES`, identify the failed run IDs from the output, run `gh run view $RUN_ID --log-failed`, fix the issue, commit, push, then go back to step 1.
3. NEVER report CI as passing unless the poll output ends with `ALL GREEN`. The poll checks BOTH completion AND success — a run that completed with `failure` conclusion is NOT green.
4. NEVER deploy to integration until every CI run from the push is green.
5. Do NOT use `gh run watch` — it hangs.
6. Before pushing a new commit, cancel any still-running CI runs from a previous push on the same branch — they are stale and waste resources:
   ```
   gh run list --branch <branch> --limit 5 --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' | xargs -I{} gh run cancel {}
   ```
