# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL of them to pass before deploying or proceeding.

## After every push

1. Run a single background Bash poll loop (timeout 600000ms) that checks ALL runs every 15s until all complete:
   ```
   while true; do
     echo "$(date +%H:%M:%S)"
     gh run list --branch <branch> --limit 5 --json databaseId,name,status,conclusion \
       --jq '.[] | [.databaseId, .name, .status, .conclusion] | @tsv'
     DONE=$(gh run list --branch <branch> --limit 5 --json status \
       --jq '[.[] | .status] | all(. == "completed")')
     if [ "$DONE" = "true" ]; then echo "ALL COMPLETE"; break; fi
     sleep 15
   done
   ```
   Use `run_in_background: true` so the poll does not burn context tokens. You will be notified when it finishes.
2. When notified, check the output. Every run must show `completed success`.
3. If any run failed: `gh run view $RUN_ID --log-failed`, fix the issue, commit, push, then go back to step 1. Repeat until ALL runs are green.
4. NEVER deploy to integration until every CI run from the push is green.
5. Do NOT use `gh run watch` — it hangs.
6. Before pushing a new commit, cancel any still-running CI runs from a previous push on the same branch — they are stale and waste resources:
   ```
   gh run list --branch <branch> --limit 5 --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' | xargs -I{} gh run cancel {}
   ```
