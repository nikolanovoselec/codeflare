---
name: ci-monitoring
description: Launch an independent Pi CI monitor after an eligible Git event or user request.
version: 2.0.1
---

# Independent Pi CI Monitoring

The Pi extension dispatches CI from an automatic delivery plan or a selected non-delivery review plan. Run this resolver when that plan includes a CI wave, when the user explicitly requests monitoring, or when deploy/merge needs a fresh result. Issue every reviewer call in the plan first, then run the resolver once without waiting for reviewer completion:

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> pr=<affected-pr-number> head=<boundary-plan-head> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

The explicit repository, affected PR number, reviewed head, and cwd bind lookup to the boundary's exact PR independently of the session's starting directory or checked-out branch. The resolver returns no request when the live PR head differs from the boundary plan, preventing review and CI from observing different heads. The review state keeps CI last in launch order without coupling its execution or result to review. No stdout means no action. Otherwise parse the single JSON object and submit it exactly once to the public `subagent` tool without changing any field. It launches `ci-monitor` in the background with no inherited conversation and no agent turn cap; the attached script timeout bounds execution.

An explicit user request may also launch `ci-monitor` for a known open PR using this exact prompt:

```text
repo=<owner/repo> pr=<number> head=<full headRefOid>
```

The dedicated agent runs the seeded monitor script once. Its native completion begins with exactly one of `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout`. Monitoring stays outside the main session. The agent only reports; the main session owns any follow-up changes.

Use only the extension-emitted plan; never independently infer identity from Git text. Successful checked-out-branch push, PR creation, and PR reopen automatically plan review plus CI. If work is interrupted, wait for a later fresh delivery plan, non-delivery marker choice, or explicit user request rather than recovering it.
