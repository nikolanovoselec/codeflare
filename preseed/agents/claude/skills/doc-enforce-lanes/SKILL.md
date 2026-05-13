---
name: doc-enforce-lanes
description: SDD documentation lane-discipline enforcement. Runs Pass 3 (implementation-prose detection), Pass 4 (lane-violation signature catalogue), dual-narrative ADR detection, and Big-O jargon detection. Invoked conditionally by doc-enforce per file in diff.
version: 1.0.0
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

## Severity application

- Pass 3 implementation-prose with matching REQ: MEDIUM (auto-fix: rewrite to backlink).
- Pass 3 implementation-prose with NO matching REQ: HIGH (spec gap; escalate, do not auto-rewrite).
- Pass 4 lane violations: MEDIUM each; cumulative file may push file-budget over cap, which then escalates via Pass 2.
- Big-O jargon: MEDIUM.
- Dual-narrative ADR: HIGH.

Mode-dependent action mirrors the spine.
