---
name: ci-monitoring
description: Launch one independent attached Pi CI monitor after an eligible Git event or explicit user request.
version: 2.0.0
---

# Independent Pi CI Monitoring

The Pi PR-boundary extension is the sole automatic dispatcher. Run this resolver only when its launch plan includes a CI wave (or when the user explicitly requests monitoring). Issue every reviewer call in the plan first, then run the resolver once without waiting for reviewer completion:

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

The explicit cwd makes current-branch PR lookup independent of the session's starting directory. The review state keeps CI last in launch order without coupling its execution or result to review. No stdout means no action. Otherwise parse the single JSON object and submit it exactly once to the public `subagent` tool without changing any field. It launches `ci-monitor` in the background with no inherited conversation and no agent turn cap; the attached script timeout bounds execution.

An explicit user request may also launch `ci-monitor` for a known open PR using this exact prompt:

```text
repo=<owner/repo> pr=<number> head=<full headRefOid>
```

The dedicated agent runs the seeded monitor script once. Its native completion begins with exactly one of `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout`. Monitoring stays outside the main session. The agent only reports; the main session owns any follow-up changes.

Do not infer another automatic trigger from the Git command itself. If a task is interrupted, wait for a later extension-issued boundary plan or explicit user request rather than relaunching it automatically.
