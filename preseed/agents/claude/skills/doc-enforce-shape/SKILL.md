---
name: doc-enforce-shape
description: SDD documentation structural shape enforcement. Runs Pass 5 (format-template field presence), Pass 6 (file-level shape consistency), Pass 7 (canonical per-endpoint rendering for api-reference*.md), plus the jump-TOC binding rule, TOC content rule, and index-table link rule. Invoked conditionally by doc-enforce when api-reference*.md or any canonical lane file is touched in diff (OR scope=all).
version: 1.0.0
---

# Documentation Enforcement — Structural shape

This skill enforces the rules that police HOW canonical lane files are rendered: per-section field presence, file-wide shape uniformity, and the strict per-endpoint binding template for `api-reference*.md` files. Invoked by `doc-enforce` (the spine) when an api-reference file or canonical lane file is in the diff.

## Inputs

- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `files`: list of canonical lane files in diff (when scope=diff)
- `layout`: `nested` | `flat` (auto-detected by parent `doc-enforce` via `test -d documentation/lanes`)

**Layout-awareness.** Canonical lane file resolution is layout-aware:
- Nested: `documentation/lanes/{architecture,api-reference*,configuration,deployment,security,observability,troubleshooting}.md`
- Flat: `documentation/{architecture,api-reference*,configuration,deployment,security,observability,troubleshooting}.md`
- ADR ledger: `documentation/decisions/README.md` in both layouts.

Per-lane format templates and the binding endpoint template apply identically across layouts; only the file globs change.

## Output

Returns findings array + auto-fix actions. Writes evidence-count rows back to the spine's manifest:
- `Pass 5 — Format-template field presence`: `ran (S sections, M findings)`
- `Pass 6 — File-level shape consistency`: `ran (K files, M findings)`
- `Pass 7 — Canonical per-endpoint rendering`: `ran (E endpoints, M findings)` or `inert (no api-reference*.md present)`

## Per-lane format templates

| File | Required per-section fields |
|---|---|
| `api-reference*.md` | Per endpoint: `**Method:**`, `**Path:**`, `**Auth:**`, `**Request:**` (or "no body"), `**Response:**`, `**Implements:** (REQ-X-NNN)` |
| `configuration.md` | Per env var: `**Variable:**`, `**Default:**`, `**Required:**`, `**Consumed by:**`, `**Implements:**` |
| `deployment.md` | Per runbook: `**When:**`, `**Command:**` (fenced block), `**Verifies:**`, `**Rollback:**` |
| `security.md` | Per policy: `**Threat:**`, `**Mitigation:**`, `**Verification:**`, `**Implements:**` |
| `architecture.md` | Per component: `**Responsibility:**`, `**Inputs:**`, `**Outputs:**`, `**Source:**` |
| `troubleshooting.md` | Per recipe: `**Symptom:**`, `**Cause:**`, `**Fix:**`, `**Prevention:**` (optional) |
| `decisions/README.md` | Per ADR section: `**Status:**` (`Proposed`/`Accepted`/`Superseded`/`Reclassified` + date), `**Context:**`, `**Decision:**`, `**Consequences:**`, optional `**Supersedes:**` |

**Rules of engagement:**
- Templates apply per **section** (`##` or `###`), not per file. Top-of-file preamble paragraph exempt.
- Sections describing a different concern than their lane are flagged separately by `doc-enforce-lanes` Pass 4.
- A section with no value for a field uses an explicit marker (`**Auth:** none (public endpoint)`).
- Missing fields: Pass 5 MEDIUM.

**Two equivalent shapes per FILE.** A section satisfies the template in either shape:
- **Per-item shape**: one section per item with bolded label/value pairs.
- **Grouped-table shape**: one section per area with a markdown table whose column headers contain the required fields.

Choice is made once per FILE via dominant-shape detection (>=60% of sections match one shape; first-content-section tiebreak otherwise). Pass 6 enforces consistency against that resolved shape.

Required-field set is the same in both shapes. For `api-reference*.md`, grouped tables must carry columns >= `Method`, `Path`, `Auth`, `Implements`. For `configuration.md`: `Variable`, `Default`, `Required`, `Consumed by`, `Implements`. For `security.md`: `Threat`, `Mitigation`, `Verification`, `Implements`. For `troubleshooting.md`: `Symptom`, `Cause`, `Fix`. For `architecture.md`: `Component`, `Responsibility`, `Source`. For `deployment.md`: `When`, `Command`, `Verifies`, `Rollback`.

## Jump-TOC at file top (lane files, binding)

Any lane file with **>=5 `##` top-level sections** MUST carry a `## Contents` section immediately after the file's preamble, before the first content section. Flat markdown link list; one link per `##` section in document order, using section heading text as label.

```
## Contents

- [Conventions](#conventions)
- [Pages](#pages)
- [Authentication](#authentication)
```

Rules:
- One link per `##` section. `###` sub-sections NOT in TOC.
- Link labels match heading text verbatim.
- Anchor slugs follow GitHub-flavoured Markdown.
- Auto-maintained by doc-updater.
- TOC carries NO section descriptions or commentary; jump list, not summary.

Files under 5 sections exempt.

Pass 5: missing TOC on file with >=5 sections: MEDIUM `missing-jump-toc`. Out-of-sync entries: MEDIUM `toc-out-of-sync`. **Position drift** — TOC exists but is NOT the first `##` heading after the file's preamble (any non-Contents `##` heading appears before `## Contents`): MEDIUM `toc-out-of-position`. All three auto-fix in `auto`/`unleashed`: relocate TOC to position immediately after preamble (before any `##` content section), regenerate entries.

## TOC content rule (binding)

Contents/TOC blocks in any `documentation/**.md` file MUST NOT contain `REQ-*` or `CON-*` references. These IDs belong on individual sections as `**Implements:**` fields, not in the navigation block.

Detection: any `(REQ|CON)-[A-Z]+-\d+` token inside a `## Contents` block (or any `^##\s+(Contents|Table of Contents)` block).

Severity: MEDIUM `toc-contains-req-ref`. Auto-fix in `auto`/`unleashed`: strip the REQ/CON token from the TOC entry (keeping the section-heading link); add the token as `**Implements:** REQ-X-NNN` on the target section if not already present there.

Body content (tables, prose, per-endpoint `**Implements:**` lines) is unaffected; the rule only forbids these IDs inside `## Contents` navigation blocks.

## Index-table link rule (binding)

Tables in `documentation/decisions/README.md` and any file matching `*-index.md` MUST hyperlink ID cells (AD-*, REQ-*, CON-*, or filename) to their target anchors. Plain-text ID cells in index tables are a MEDIUM finding `index-table-id-not-linked`.

Forms:
- AD index row: `| [AD-12](ad-12-some-decision.md) | Some Decision | Accepted | ... |`
- REQ index row: `| [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-...) | ... |`

Detection: in any table inside `decisions/README.md` or `*-index.md`, scan each row for a leading or first-column cell matching `(AD|REQ|CON)-[A-Z]*-?\d+`. Bare ID without surrounding `[...]( ... )`: finding.

Auto-fix in `auto`/`unleashed`: wrap the bare ID with a markdown link to the resolved target.

## Pass 5 — Format-template field presence

**Scope:** Pass 5 (and Pass 6, Pass 7) operate on canonical lane files. Framework metadata files excluded by name: any basename starting with `.` (`.doc-coverage.md`, `.review-needed.md`, `.cold-read-tasks.yml`), `documentation/README.md` index. `documentation/decisions/README.md` is covered by the **Index-table link rule** above and by the per-ADR-section template in the per-lane templates table.

Walk every `##`/`###` section in each canonical lane file. Verify required fields from the per-lane template in either shape. Missing fields: MEDIUM `template-field-missing` listing section + missing fields.

Pass 5 also enforces:
- The jump-TOC rule on the file as a whole (>=5 `##` sections: required TOC).
- The **TOC content rule** above.
- The **Index-table link rule** above.

Shape detection per section:
1. Section contains a markdown table whose header row matches >=3 of the lane's required fields: enforce **grouped-table shape**.
2. Otherwise: enforce **per-item shape**.

Auto-fix in `auto`/`unleashed` requires inferable content from source; otherwise stays as a finding.

## Pass 6 — File-level shape consistency

Verify each canonical lane file against its expected shape declared by the per-lane format templates table (resolved by filename). Every section that deviates: MEDIUM `rendering-shape-mismatch` naming the section, deviant shape, expected file shape.

**Content-preservation guarantee:** auto-fix preserves all original prose verbatim. Restructuring a per-item section to grouped-table shape collapses the bolded pairs into table rows; extended prose preserved as body prose below the table. Reverse direction splits table rows into sections. Either direction, no clause dropped or paraphrased. If a section's prose cannot be split or merged without semantic loss (>200 words of inline prose that does not fit any single cell), auto-fix DEFERS that one section, emits MEDIUM `shape-conversion-content-bloat`. Rare residual JUDGMENT.

Auto-fix in `auto`/`unleashed`: mechanical re-render; commit `[doc-updater] re-render: {file} to canonical shape`.

## Pass 7 — Canonical per-endpoint rendering

**Binding scope:** Pass 7 fires on every `documentation/api-reference*.md` file; the entire family (`api-reference.md`, `api-reference-admin.md`, and any future split sibling). Pass 5's per-lane format templates and Pass 13's three within-section triggers also apply, but Pass 7 adds the stricter per-endpoint binding template below: file-level shape uniformity, the prose paragraph cap, the fenced `METHOD path` block in place of bolded Method/Path lines, and the canonical Authentication / Origin check vocabularies.

**File-level shape uniformity.** Within a single `api-reference*.md` file, every endpoint section MUST use the SAME shape (per-item OR grouped-table; per-item is the binding default below). A file mixing both is `rendering-shape-mismatch` per-section against the file's dominant resolved shape, MEDIUM, per Pass 6.

**Per-field rendering uniformity within file.** Within a single `api-reference*.md` file, every endpoint section's `Response` field MUST render in the SAME sub-shape: either all inline `**Response:** {value}` OR all heading-plus-table (`**Response**\n\n| Status | Outcome | Body |\n...`). Same rule for `Request`. Mixing both sub-shapes within one file is `response-rendering-mixed` (or `request-rendering-mixed`), MEDIUM. Auto-fix in `auto`/`unleashed`: re-render all minority-shape sections to the majority shape; ties resolved to heading-plus-table (carries more contract).

**Field-order uniformity within file.** Within one `api-reference*.md` file, every endpoint section MUST present its bolded field labels in the same order. Canonical order: `Authentication`, `Origin check`, `Path parameters` (optional), `Query parameters` / `Request body` (optional), `Response`, `Error codes` (optional), `Rate limit` (optional), `Implements`, `Notes` (optional). A section whose label sequence does not match canonical order is `endpoint-field-order-drift`, MEDIUM. Auto-fix: re-order to canonical; field values move with their labels verbatim.

**Prose paragraph cap per endpoint section.** Outside the optional `**Notes**` block (<=3 paragraphs), an endpoint section MUST NOT carry standalone prose. A paragraph that is not (a) a field line, (b) a fenced block, (c) a table, or (d) inside `**Notes**` is MEDIUM `endpoint-section-prose-leakage`. Auto-fix in `auto`/`unleashed`: move prose into a `**Notes**` block at the section bottom; prose spanning >=3 endpoints relocates to `## Conventions` via Pass 13 Trigger 3. Three-paragraph operational descriptions signal architectural rationale leakage; escalate to `documentation/.review-needed.md`.

### Binding endpoint template

Every endpoint section in any `api-reference*.md` file MUST use this exact structure:

```
### {METHOD path} ({optional descriptive title})

{One-sentence operational summary.}

```
{METHOD} {path}
```

**Authentication:** {none | session | refresh cookie | state cookie | session + admin email | dev-bypass token}
**Origin check:** {applies | exempt | n/a}

[OPTIONAL — present only when endpoint accepts a body or parameters:
**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| ... | ... | ... | ... |
]

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | ... | ... |
| `4xx` | ... | error envelope |

[OPTIONAL — present only when rate-limited:
**Rate limit:** {N}/{window} per {scope}, fail-{open|closed}
]

**Implements:** [REQ-X-NNN]({backlink})

[OPTIONAL — present only when caveats not captured above:
**Notes**

{1-3 prose paragraphs.}
]

---
```

**Canonical Authentication vocabulary** is exactly the six values listed; any other value: MEDIUM. **Canonical Origin check vocabulary** is exactly three values: `applies`, `exempt`, `n/a`. Exempt requires a parenthetical justification on the same line.

**Tombstoned endpoints** use a distinct minimal shape: only heading + `**Status:** Tombstoned` + `**Replacement:**`. No Method/Path/Auth fields.

**Conventions section.** A file-level `## Conventions` section at the top of an `api-reference*.md` file factors out error envelope shape, Authentication vocabulary, Origin check vocabulary, Rate-limit format.

Pass 7 validates the binding shape, not just field presence. A section with `**Auth:**` instead of `**Authentication:**`, or Method/Path as separate fields instead of a fenced code block, is MEDIUM even though content is present. Auto-fix: mechanical re-render; commit `[doc-updater] re-render: {file} to canonical shape`.

## Severity application

All shape findings are MEDIUM. (Pass 2 file-budget escalation removed; per-element caps in the spine's Pass 1 remain authoritative.)

Mode-dependent action mirrors the spine.
