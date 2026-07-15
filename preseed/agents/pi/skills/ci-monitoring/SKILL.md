---
name: ci-monitoring
description: Launch one independent attached Pi CI monitor after an eligible Git event or explicit user request.
version: 3.0.0
---

# Independent Pi CI Monitoring

The Pi PR-boundary extension is the sole automatic dispatcher. On an automatic boundary it service-spawns every requested reviewer first, then runs this resolver once after reviewer agent IDs are obtained:

```bash
node ~/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs request event=<push|pr-create> changed=true repo=<owner/repo> pr=<affected-pr-number> cwd=<absolute-repo-root> reviewState=<launched|not-required>
```

The explicit repository, affected PR number, and cwd bind lookup to the boundary's exact PR independently of the session's starting directory or checked-out branch. The review state keeps CI last in launch order without coupling its execution or result to review. No stdout means no action. Otherwise the extension submits the request once through the stock session subagent service with equivalent background and context-isolation options. The attached script timeout bounds execution; no agent turn cap replaces its verbatim result.

An explicit user request may also launch `ci-monitor` for a known open PR using this exact prompt:

```text
repo=<owner/repo> pr=<number> head=<full headRefOid>
```

The dedicated agent runs the seeded monitor script once. Its native completion begins with exactly one of `CI_RESULT success`, `CI_RESULT failure`, or `CI_RESULT timeout`. Monitoring stays outside the main session. The agent only reports; the main session owns any follow-up changes.

Do not infer another automatic trigger from the Git command itself. If a task is interrupted, wait for a later extension-issued boundary plan or explicit user request rather than relaunching it automatically.
