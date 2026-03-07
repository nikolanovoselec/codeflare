# CI Monitoring After Push

A single push can trigger multiple GitHub Actions workflows (PR Checks, Fuzz, CodeQL, etc.). You MUST wait for ALL of them to pass before deploying or proceeding.

## After every push

1. List ALL triggered runs:
   ```
   gh run list --branch <branch> --limit 5 --json databaseId,name,status,conclusion --jq '.[] | [.databaseId, .name, .status, .conclusion] | @tsv'
   ```
2. Poll every 15s until EVERY run shows `completed success`. Do not proceed when only some runs are green.
3. If any run fails: `gh run view $RUN_ID --log-failed`, fix, commit, push, and monitor all runs again.
4. NEVER deploy to integration until every CI run from the push is green.
5. Do NOT use `gh run watch` — it can exceed the Bash timeout.
