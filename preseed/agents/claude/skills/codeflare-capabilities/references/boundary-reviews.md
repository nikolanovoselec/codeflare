# PR-boundary reviews

Codeflare treats a delivered pull-request head as a control boundary. In an eligible Advanced SDD repository, a push or PR transition to a protected base can launch the applicable report-only lanes against the exact authoritative head: code review, specification review, documentation review, and independent CI monitoring.

The useful part is the separation. Reviewers do not edit the branch. The root agent reads their terminal reports, judges each finding against the actual diff, publishes one triage table, and applies only accepted fixes afterward. A replacement head makes old evidence stale. A missing, pending, stale, or incomplete round blocks another push unless the user explicitly overrides it.

Try it with an open PR to `main`, `master`, or `develop` in an Advanced SDD project:

1. Push the checked-out PR branch.
2. Watch the review lanes and CI start against the same full SHA.
3. Ask the root agent to show the triage table before any correction is made.
4. After accepted fixes land, confirm the replacement head gets its own exact-head evidence.

Use `/review --diff` when you want an explicit user-invoked review without creating a PR boundary. Add `--deep` for behavioral verification against SDD acceptance criteria when that capability is available. It is separate from automatic boundary enforcement.

Source anchors: `sdd/spec/agents.md` REQ-AGENT-015/036/050/053/104/170/177 and `documentation/lanes/preseed.md` review sections.
