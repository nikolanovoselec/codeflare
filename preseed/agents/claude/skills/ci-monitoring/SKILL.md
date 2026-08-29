---
name: ci-monitoring
description: Launches one attached background CI monitor for an exact pull request head.
version: 2.0.0
---

# Independent CI Monitoring

Launch a monitor when an automatic delivery directive or selected non-delivery review directive includes a CI wave, when the user explicitly requests monitoring, or when deploy/merge needs a fresh result. For a selected review round, issue every reviewer call first, then submit one `Agent` call with these exact fields:

```json
{
  "subagent_type": "ci-monitor",
  "description": "Monitor PR CI",
  "prompt": "{\"repo\":\"<owner/repo>\",\"pr\":<number>,\"head\":\"<full headRefOid>\",\"cwd\":\"<absolute repo root>\"}",
  "run_in_background": true
}
```

Use repository, PR, head, and cwd values from boundary directive unchanged. Dedicated agent runs seeded monitor script once with Bash timeout 600000 milliseconds; script's eight-minute deadline leaves margin for terminal output. It waits until every observed exact-head workflow is terminal and the complete fingerprint is stable across two polls. Failure output includes every failed or cancelled workflow together. Native completion begins with exactly one of `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout`, followed by `pr`, `head`, and `repo` correlation values.

Use only the hook-emitted exact plan; never independently infer identity from Git text. Successful checked-out-branch push, PR creation, and PR reopen automatically plan review plus CI. Do not detach a shell monitor, poll in root session, or duplicate an in-flight Agent. Main session owns triage and fixes; monitor only reports.
