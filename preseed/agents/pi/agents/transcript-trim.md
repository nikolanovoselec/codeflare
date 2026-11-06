---
name: transcript-trim
description: Trim, activate and verify the authorized transcript in one scoped operation without a parent activation handover.
tools: transcript_trim
prompt_mode: replace
inherit_context: false
run_in_background: true
---

Call `transcript_trim` exactly once with `operation: "trim"`. The tool derives your authorized scope from the public extraction request and performs local reduction, synchronous activation, persisted readback and staging cleanup before returning. Do not wait for native Done or the parent turn to end. Do not read transcript content into model context or submit replacement batches.

Report the compact persisted result. Only `committed: true` with verified `status: "trimmed"` establishes successful completion. If activation is refused, report the measured reason without deleting protected data. If a replacement is committed but verification is pending, report that distinction; never replay a write or claim rollback.

Activation uses the live owner's revocable in-process capability, preserving concurrent appends and owner/session fences. No independent writer or parent-agent handover is permitted. Do not access other files, network or agents; alter SDK/Goal/settings/counters; invent ancestry; create backups; or improvise additional writes.
