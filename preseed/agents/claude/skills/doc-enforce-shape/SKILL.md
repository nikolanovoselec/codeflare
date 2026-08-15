---
name: doc-enforce-shape
description: SDD documentation structural enforcement for canonical lane records, navigation, and traceability. Invoked by doc-enforce for changed lanes or scope=all.
version: 5.0.0
---

# Documentation Enforcement — Structural shape

Validate the repeated records that a lane owns. Do not force every heading in a file into one shape. Preambles, collection headings, narrative explanations, aliases, source maps, and unrelated tables remain exempt unless another rule governs them.

## Inputs

- `purpose`: `review` | `clean`
- `diff`: bounded patch
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `files`: canonical lane files selected by `doc-enforce`
- `layout`: nested `documentation/lanes/` or flat legacy `documentation/`

Review is report-only. Clean may normalize a recognized record only when every load-bearing clause, link, diagram, compatibility fragment, requirement, and source anchor has a destination.

## Output

Return findings and any permitted clean actions. Populate:

- `Pass 5 — Format-template field presence`
- `Pass 6 — Collection rendering consistency`
- `Pass 7 — API contract rendering`

## Canonical lane records

| Lane | Positively recognized record | Required canonical fields |
|---|---|---|
| `architecture.md` | H3 component dossier under `Components` or `System Components` | `Responsibility`, `Inputs`, `Outputs`, `Source` |
| `api-reference*.md` | Table carrying `Method` and `Path` | `Method`, `Path`, `Auth`, `Implements`; canonical templates also include `Description` |
| `configuration.md` | Table carrying `Variable` | `Variable`, `Purpose`, `Default`, `Required`, `Consumed by`, `Implements` |
| `configuration.md` | Table carrying `Binding` | `Binding`, `Purpose`, `Required`, `Consumed by`, `Implements` |
| `security.md` | Threat table carrying `Asset / boundary` | `Asset / boundary`, `Threat or failure`, `Control and failure posture`, `Residual risk / owner` |
| `security.md` | Residual-risk table carrying `Exception / residual risk` | `Exception / residual risk`, `Current decision`, `Owner / review signal` |
| `security.md` | Evidence table carrying `Control family` | `Control family`, `Requirements / decisions`, `Implementation`, `Evidence` |
| `deployment.md` | H2 runbook carrying at least two runbook fields | `When`, `Action`, `Verify`, `Rollback` |
| `observability.md` | Table carrying `Signal` | `Signal`, `Meaning / non-evidence`, `Observed at`, `Escalate when`, `Runbook` |
| `troubleshooting.md` | H3 recipe under `Common Issues`, `Recipes`, or `Troubleshooting Recipes` | `Symptom`, `Cause`, `Fix`; canonical detailed recipes also include `Diagnose`, `Verify`, and `Escalate` |
| `decisions/README.md` | ADR index row paired with its stable `ADN` section | Linked stable ID, explicit state rendering, retained history for full supersession, successor detail for partial supersession, and linked destinations for redirects |
| project lane | File indexed by `documentation/README.md` | `Audience`, `Owns`, navigation, requirement/source map, and related links; add `Does not own` when an adjacent ownership boundary could be confused; its subject-specific body follows its natural axis |

Architecture state, flow, failure, observability, security, and decision collections have their own tables or diagrams. They are not component records. Configuration permission or binding tables are not variable records. Security control prose is not a threat-table row. Deployment aliases and development references are not runbooks unless their fields begin a runbook record.

## Compatibility

Nested and flat layouts remain readable. Grouped tables and per-item records remain valid where the lane historically supports both.

Accepted migration aliases:

- API: `Authentication` for `Auth`, `Response 200` for `Response`, `Error responses` for `Errors`, and `Implementation` for `Source` in legacy per-endpoint records.
- Configuration: `Description` may carry legacy `Purpose` content during migration.
- Deployment: `Command` for `Action`; `Verifies` for `Verify`.
- Architecture areas: `Components` and `System Components`.
- Troubleshooting areas: `Common Issues`, `Recipes`, and `Troubleshooting Recipes`.

`/sdd init` emits canonical names. `/sdd clean` may translate an alias only when its value moves byte-for-byte. Compatibility is not authority to invent project-specific field vocabularies.

## Binding checker

Run:

```sh
node scripts/check-shape.mjs <lane.md> [...]
```

The checker handles Markdown tables, fenced code, inline code, and HTML comments. It recognizes records by discriminator or by a partial field prefix so malformed records cannot disappear. It contains no product-specific component, endpoint, or recipe inventory.

A missing field produces MEDIUM `template-field-missing` with file, line, collection, item, and missing fields. Unrelated headings and tables produce no finding.

## Pass 5 — Field presence

Run the checker over in-scope canonical lanes. Then apply the navigation and traceability rules below. A field with no applicable value remains explicit, for example `Auth: none` or `Rollback: not applicable — immutable replacement only`.

Auto-fix only when content is directly inferable from the same record or verified source. Otherwise emit a finding.

## Pass 6 — Collection rendering consistency

Consistency is per recognized collection, not per file. A file may legitimately contain component dossiers, state tables, Mermaid flows, and decision maps together.

Within one repeated collection, use one canonical representation unless a detailed record needs fields that the summary table cannot safely contain. Do not choose a file-wide dominant shape or convert unrelated sections.

Clean preserves all original prose. If a conversion cannot account for every clause, defer with MEDIUM `shape-conversion-content-risk`; never delete the minority representation merely because another representation is more common.

## Pass 7 — API contract rendering

The canonical API template uses grouped endpoint registers by resource family:

```markdown
| Method | Path | Auth | Implements | Description |
|---|---|---|---|---|
```

Add a detailed endpoint section only when request, response, error, or rate-limit behavior cannot fit safely in the register. A detailed section uses `Request`, `Response`, `Errors`, `Source`, and `Implements` fields. Do not require empty detailed sections for simple endpoints.

Tombstoned endpoints state status and replacement without pretending they remain callable.

## Jump navigation

A lane with at least five H2 content sections carries a `## Contents` block immediately after its ownership preamble. Entries follow document order and GitHub-compatible fragments. H3 records are omitted from the jump list.

Contents blocks contain navigation only. REQ and CON identifiers belong beside governed facts, not in navigation labels. Missing, stale, or misplaced navigation is MEDIUM and mechanically repairable.

## Index and requirement links

- Every first-level project lane is linked from `documentation/README.md`.
- Every linked lane exists.
- ADR and `*-index.md` ID cells link to their targets.
- In a Security `Verification and Source Map`, every `ADN`, `REQ-*`, and `CON-*` token links to its exact anchor; domain references link the exact requirement file, and vague labels such as `Operations SDD` or `Browser IDE SDD` are findings.
- Every REQ or CON token in an `Implements` table cell links to the corresponding specification anchor.
- `TBD` in an `Implements` cell is a finding, not an auto-guessed requirement.

## Decision ledger state rendering

Decision history must be readable without interpreting parenthetical jargon:

- **Active** rows render normally.
- **Superseded** sections retain their full historical body and stable anchor, while both the ID and decision cells in the index are wrapped in Markdown strikethrough and the category/state says `Superseded`.
- **Partially superseded** records stay unstruck because their remaining decision still governs; the section status names the exact replaced clause and links its successor.
- **Redirect anchor** means a stable historical AD identifier whose content was merged into another ADR or reclassified into a canonical lane. Use that exact label and link the destination; bare `(redirect)` or `(redirected)` is ambiguous and invalid.

Clean may add deterministic links, labels, or strikethrough. It never deletes a superseded body, removes its heading, or guesses whether a record is fully versus partially superseded.

## Severity

All structural findings are MEDIUM. Review reports only. Interactive clean asks before repair; auto and unleashed repair only deterministic, lossless cases using the existing root-owned commit workflow.
