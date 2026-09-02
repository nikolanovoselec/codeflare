# PR-boundary reviews

**Availability:** Advanced SDD repositories with an eligible pull request and review machinery installed. CI also requires a configured repository workflow.

## What I can do

I can treat a delivered pull-request head as a control boundary. After an eligible push or PR transition to `main`, `master`, or `develop`, I can launch the applicable report-only lanes against the exact full SHA: code review, specification review, documentation review, and independent CI monitoring.

I keep those authorities separate. Reviewers inspect and report. They do not edit the branch. I verify each finding against the actual diff, reject unsupported or oversized proposals, and publish one joint triage before changing files. Only accepted fixes move forward. If I push a replacement head, the old review and CI evidence becomes stale and I run the required boundary again.

I can also run `/review --diff` when you want an explicit review without relying on a delivery transition. `/review --deep` adds behavioral verification against SDD acceptance criteria when that capability is available.

## Why the boundary matters

A review of commit A says nothing conclusive about commit B. Codeflare binds reviewers and CI to the same authoritative head, then prevents mutation from sneaking between triage and the fix phase. This is slower than pretending three green-looking summaries are interchangeable. It is also how the evidence survives scrutiny.

## Try it

Open an eligible PR and ask me to push the current branch. Watch the review lanes and CI start against the same SHA. Then ask for the joint triage table before authorizing fixes. After a correction, confirm the new head receives new evidence rather than inheriting the old round.

Source anchors: `sdd/spec/agents.md` REQ-AGENT-015/036/050/053/104/170/177 and the review sections in `documentation/lanes/preseed.md`.
