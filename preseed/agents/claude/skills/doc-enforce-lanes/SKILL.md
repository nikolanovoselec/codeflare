---
name: doc-enforce-lanes
description: SDD documentation lane-discipline enforcement. Runs Pass 3 (implementation-prose detection), Pass 4 (lane-violation signature catalogue), dual-narrative ADR detection, Big-O jargon detection, per-subsystem lane-split probe (graphify community + prefix coherence), and ADR marker sidecar staleness detection. Invoked conditionally by doc-enforce per file in diff or on scope=all when the sidecar exists.
version: 2.1.0
---

# Documentation Enforcement — Lane discipline

This skill enforces the rules that police what content belongs in which `documentation/*` file. Invoked by `doc-enforce` (the spine) per file in diff.

## Inputs

- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `files`: list of changed doc files in diff (when scope=diff)

## Output

Returns findings array + auto-fix actions. Writes evidence-count rows back to the spine's manifest:
- `Pass 3 — Implementation-prose detection`: `ran (K files, M findings)`
- `Pass 4 — Lane-violation detection`: `ran (K files, M findings)`

## Pass 3 — Implementation-prose detection

Scan each file for paragraphs that read like AC text (`must`, `shall`, `ensures that`, `the system rejects`). These belong in `sdd/`. Flag MEDIUM with target REQ ID (or "no matching REQ": HIGH because it indicates an unspec'd feature).

Detection heuristic:
1. Paragraph contains >=2 of the AC-shape tokens: `must`, `shall`, `MUST`, `the system`, `rejects`, `ensures that`, `requires that`.
2. Paragraph is not inside a fenced code block.
3. Paragraph is not inside a `**Notes**` block referencing a doc-pointer.

For each match, emit MEDIUM `implementation-prose-in-docs` naming source file, section heading, AC-shape tokens detected. If a REQ in `sdd/` has matching AC content (token overlap >=3): suggest backlink. If no matching REQ exists: HIGH `unspec-feature-documented` (the doc is the only place this behaviour is captured, which means the spec is incomplete).

Auto-fix in `auto`/`unleashed`: when a matching REQ exists, rewrite the prose to a backlink form ("Behaviour specified in [REQ-X-NNN](../sdd/...)"). Otherwise escalate; never silently delete prose.

## Pass 4 — Lane-violation detection (pattern-based)

Scan each file against per-lane content signatures:

| Signature | Belongs in | Flagged in |
|---|---|---|
| HTTP method + path + status code triplet | `api-reference*.md` | `architecture.md`, `deployment.md`, `configuration.md`, `security.md` |
| Env var name + default value + consumption point | `configuration.md` | `architecture.md`, `deployment.md`, `security.md` |
| Shell command intended to be copy-pasted at deploy time | `deployment.md` | `api-reference*.md`, `troubleshooting.md` (unless `Fix:` block), `architecture.md` |
| Symptom -> Cause -> Fix recipe block | `troubleshooting.md` | `deployment.md`, `architecture.md`, `api-reference*.md` |
| Threat model paragraph | `security.md` | `architecture.md`, `api-reference*.md`, `configuration.md` |
| Auth/rate-limit rationale | `security.md` OR ADR | `api-reference*.md`, `configuration.md` |
| Decision rationale ("we chose X because...") | ADR | `architecture.md`, `troubleshooting.md`, `deployment.md` |
| Admin-only endpoint with operator runbook prose | `api-reference*.md` (contract) **and** `deployment.md` (runbook); split | wherever the unsplit blob lives |

Each match: MEDIUM naming source file, section heading, signature, proposed target lane. Proposed-move plan written into `documentation/.doc-coverage.md`.

## Big-O jargon in narrative documentation

Big-O notation in narrative prose is a flag that the writer reached for academic shorthand instead of stating either (a) a real measurable performance target or (b) a plain-language description.

Detection:
- `\bO\([^)]+\)` in body prose AND inline backticks. Allowed only in fenced code blocks documenting an algorithm's actual implementation, or in headings that explicitly title an algorithm section. Inline backticks are NOT a free pass.
- "logarithmic time", "amortised constant", "polynomial-time", "quadratic", "linear-time" as load-bearing nouns.
- Hand-wavy complexity claims with no measurable backing.

Fix: write a target number, or plain English, or delete the filler. Severity: MEDIUM `big-o-jargon-without-anchor`. Auto-fix in `auto`/`unleashed`: if a target exists in a related performance REQ, replace with a backlink; otherwise flag.

## Dual-narrative ADRs

An ADR describes ONE decision. The dual-narrative anti-pattern tells two competing stories; usually because someone updated the ADR after the decision was reversed instead of writing a superseding ADR.

Detection: two `## Decision` headings in one file; phrases like "this was later changed to", "we updated this in", "now we do X instead"; "Status: Accepted" header followed by a different decision; "However, after further investigation..." pattern.

Fix: the original ADR is immutable. Write a new ADR `Supersedes: <original-adr>.md`. Mark the original `Status: Superseded by <new-adr>.md`. Never edit the original's decision or consequences sections.

Severity: HIGH `dual-narrative-adr`. No mechanical auto-fix; the supersedure decision is JUDGMENT (the user decides which decision is the current one). Escalate to `documentation/.review-needed.md` with both narratives quoted.

## Per-subsystem lane-split probe

When a project has distinct subsystems (e.g., a Worker + a mobile app, or a backend + admin UI), each subsystem may merit its own lane file rather than being co-mingled. The probe uses graphify community detection plus name-prefix coherence to detect candidate splits.

**Trigger:**
- `subsystem_lane_threshold` (default 40 files OR 800 lines in a single canonical lane file) is exceeded, AND
- A graphify community within the project's primary source tree has >=`subsystem_prefix_coherence` (default 60%) of its files sharing a directory prefix (e.g., `src/admin/*`, `mobile/lib/*`, `worker/src/api/*`).

Both knobs read from `sdd/config.yml`.

**Detection (graphify-backed):**
1. Call `mcp__graphify__get_community(<community-id>)` for each community returned by `mcp__graphify__query_graph(communities)`.
2. For each community, compute the most common directory prefix and its share of community members.
3. If share >= threshold AND the community has >=10 files: candidate subsystem.
4. Cross-check against `documentation/architecture.md § Source Module Map`: if the candidate is already isolated into its own subsection, the split has been documented at the architecture level; otherwise propose a lane split.

**Detection (graphify-less fallback):**
1. Walk the source tree; group by top-level directory under `src/`.
2. Apply the prefix-share calculation by directory size.

**Findings:**
- A lane file (e.g., `api-reference.md`) covers >=2 detected subsystems and exceeds the threshold: MEDIUM `subsystem-lane-split-candidate` with the proposed split (e.g., `api-reference-admin.md`, `api-reference-mobile.md`).
- The same finding becomes HIGH if the file is >=2x its soft budget AND a clean split exists.

**Auto-fix.** Mode `auto`/`unleashed`: split along the proposed boundary. Write the new sibling lane file with the carved subsystem's entries. Replace the carved section in the original with a single redirect line. Commit per category. The split heuristic uses the same subsystem subsection structure that `documentation/architecture.md § 4` already organises by; honour that ordering.

## ADR marker sidecar staleness

When `documentation/.adr-marker-proposals.md` exists (emitted by `sdd-init` Phase 6f), each row is a proposed inline ADR marker for the user to apply manually. The sidecar is short-lived: rows are deleted as markers are applied; the file is deleted entirely when the last row is removed. This pass detects staleness.

**Trigger:** fires whenever `documentation/.adr-marker-proposals.md` exists (regardless of diff scope).

**Detection rules:**

1. **Stale row (marker already applied).** Parse each table row; extract `File` and `Line`. Read the indicated source file; check whether a `// AD-N: ...` (or `// CF-N:`, `// {PREFIX}-N:` per `adr_marker_style`) comment exists at or within 5 lines of the indicated line, with `AD-N` matching the row's ADR ID. If yes: MEDIUM `adr-marker-sidecar-stale` (row should be deleted; the user applied the marker but forgot to clean the sidecar).
2. **Orphaned row (target file/line no longer exists).** If the indicated source file does not exist, OR the indicated line is past EOF, OR the surrounding 10 lines do not contain the original ADR target concept (use the row's `Title` field as a string-overlap probe): MEDIUM `adr-marker-sidecar-orphaned` (row should be deleted; the code drifted after the sidecar was generated, the proposal is no longer actionable).
3. **Empty sidecar (table has header but zero rows).** When the file contains only the preamble + header row and no data rows: HIGH `adr-marker-sidecar-empty` (file should be deleted; its persistence is documentation rot).

**Auto-fix in `auto`/`unleashed`:** rule 1 + rule 3 are mechanical (delete row / delete file). Rule 2 is conservative — the orphaned row might still be salvageable (refactored code may have moved the concept elsewhere); escalate to `documentation/.review-needed.md` rather than auto-delete. Rule 3 auto-delete fires only when rule 1 cleanup leaves the file empty in the same pass.

**Why this pass exists:** without it, the sidecar becomes a documentation-rot vector — proposal rows for markers already in source persist indefinitely, and a future reader cannot tell which rows are pending vs. already done. The lifecycle contract in `sdd-init/SKILL.md` § Pass 6f names this finding; this pass implements it.

## Severity application

- Pass 3 implementation-prose with matching REQ: MEDIUM (auto-fix: rewrite to backlink).
- Pass 3 implementation-prose with NO matching REQ: HIGH (spec gap; escalate, do not auto-rewrite).
- Pass 4 lane violations: MEDIUM each; cumulative file may push file-budget over cap, which then escalates via Pass 2.
- Big-O jargon: MEDIUM.
- Dual-narrative ADR: HIGH.
- Subsystem-lane-split candidate: MEDIUM (default) or HIGH (file >=2x budget + clean split available).
- `adr-marker-sidecar-stale`: MEDIUM (auto-fix: delete row).
- `adr-marker-sidecar-orphaned`: MEDIUM (escalate to `.review-needed.md`; do not auto-delete).
- `adr-marker-sidecar-empty`: HIGH (auto-fix: delete file).

Mode-dependent action mirrors the spine.
