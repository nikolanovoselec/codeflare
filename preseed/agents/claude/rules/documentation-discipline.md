# Documentation Discipline (SDD-Bootstrapped Projects)

Applies whenever a project has both `sdd/` AND `documentation/`. Inert otherwise. Enforced by `doc-updater`. Sibling: `spec-discipline.md` (spec-reviewer).

Every row in the manifest below MUST execute on every run. No cherry-picking; cost is never a valid skip. Manifest written FIRST with all rows `pending`, updated as each pass completes, finalised at run end. Pending rows at finalize → HIGH `manifest-pending-at-finalize`. Status rows without concrete evidence counts (`ran (K files, M findings)`) → HIGH `manifest-bare-evidence-count`. "skipped (looked clean)" is dishonest.

## What documentation is

`documentation/` is the **how** layer: how things are wired, what env vars exist, what HTTP routes return, where files live, why a particular technology was chosen. Not the spec (`sdd/`), not the changelog (`sdd/changes.md`), not the README.

The reader is a developer who already knows what the product does and now needs to navigate the implementation. Every page answers one operational question quickly.

## Required execution manifest

Every clean / PR-boundary run MUST emit a manifest with one row per pass. Audit location:
- **`/sdd clean`** → docs-side rows into `sdd/.last-clean-run.md`.
- **PR-boundary doc-updater** → docs-side manifest into the agent's commit body, OR into `documentation/.review-needed.md`.

| Pass | Required action | Status |
|---|---|---|
| Pass 1 — Per-element budgets | Walk every doc file; count cell/list/snippet/heading/paragraph against caps. | `ran (K files, M findings)` |
| Pass 2 — File-level budgets | Walk every doc file; apply file-budget table; honour `doc-allow-large` markers. | `ran (K files, M findings)` |
| Pass 3 — Implementation-prose detection | Walk every doc file; flag AC-shaped paragraphs that belong in `sdd/`. | `ran (K files, M findings)` |
| Pass 4 — Lane-violation detection | Walk every doc file against signature catalogue. | `ran (K files, M findings)` |
| Pass 5 — Format-template field presence | Walk every section in canonical lane files; verify required fields. Includes TOC content rule and index-table link rule. | `ran (S sections, M findings)` |
| Pass 6 — File-level shape consistency | Verify each lane file against the shape expected from the per-lane format templates table (filename-resolved); flag deviant sections. | `ran (K files, M findings)` |
| Pass 7 — Canonical per-endpoint rendering | For every `documentation/api-reference*.md` file (family), verify each endpoint section matches the binding template AND obeys the file-level shape uniformity, per-field rendering uniformity (Response / Request sub-shape), field-order uniformity, and prose paragraph cap rules. | `ran (E endpoints, M findings)` or `inert (no api-reference*.md present)` |
| Pass 8 — Verification truth-check | For every `**Verification:**` field, open cited test file and verify REQ ID + content-word match. | `ran (V fields, F files, M findings)` |
| Pass 9 — Implements-vs-AC cross-walk | For every `**Implements:**` field, read linked REQ; classify section-vs-AC. | `ran (I fields, M findings)` |
| Pass 10 — Stale code-block detection | For every fenced block / route / signature / JSON / env var ref, resolve against `src_globs`. | `ran (B blocks, M findings)` |
| Pass 11 — Content-preservation on trim | On every Pass 1 trim, run tokenisation check before committing. | `ran (T ops, M findings)` or `inert (no trim ops)` |
| Pass 12 — Stranger cold-read | For every canonical lane file in task registry, dispatch fresh `general-purpose` subagent with one simulated task. | `ran (T tasks, M findings)` or `ran (cached, hit on SHA <sha>)` |
| Pass 13 — Within-section semantic consistency | Walk every heading section in every `documentation/**.md` file; fire the three semantic triggers — duplicate fields, hybrid shape within section, repeated cross-section prose. | `ran (K files, S sections, M findings)` |
| Pass 14 — Authoring quality (reviewer-with-a-brain) | Re-read the agent's own diff with the three authoring questions below; flag weasel sentences, unverifiable claims, missing-why sections; restructure with judgment, not pattern-matching. | `ran (D diff hunks, W weasel, U unverifiable, Y missing-why)` |

Pass 12 caches on commit SHA + file mtime. When warm, the agent records `ran (cached, hit on SHA <sha>)` — that IS execution. Cache amortises cost across Stop hooks; never skips the pass.

## Forbidden content in documentation/

| Banned | Where it goes instead |
|---|---|
| Product motivation prose | `sdd/README.md` Intent fields or REQ Intent |
| Acceptance-criterion language (`must`, `shall`, `the system rejects`) | `sdd/{domain}.md` AC bullets |
| User-visible feature copy | Source code |
| Implementation rationale told as story | ADR (`documentation/decisions/`) |
| Long regex internals inline | Source-code docstring at the regex site |
| Magic-constant prose | Source-code comment, OR an ADR |
| Strikethrough text | Delete. Git history is the strikethrough. |
| TODO bullets, "coming soon", "planned but not built" | GitHub issue or `pending.md` |
| Future-tense roadmap items | `sdd/{domain}.md` as `Status: Planned` REQs |
| Any content that duplicates a REQ instead of cross-referencing | Backlink to REQ ID — never copy-paste |
| Big-O jargon in narrative prose (`O(n log n)`, "logarithmic time", "amortised constant") | Measurable target ("p95 < 200ms") or plain-language description; else drop |

## Allowlist (acceptable in documentation/)

- **REQ backlinks** `(REQ-API-003)` — encouraged
- **Source-file paths** next to the section they document
- **Function and class names** when documenting how to call them
- **Database table/column names** in `documentation/architecture.md` schema sections
- **Cookie names, env var names, header names** when documenting configuration or HTTP contract
- **Code snippets** illustrating a non-obvious calling pattern (≤15 lines)

## Per-file line budgets

| File | Soft budget | Severity above budget |
|---|---|---|
| `documentation/architecture.md` | 500 | LOW (500-700) / MEDIUM (700-1000) / HIGH (>1000) |
| `documentation/api-reference*.md` | 600 | LOW (600-1000) / MEDIUM (1000-1500) / HIGH (>1500) |
| `documentation/configuration.md` | 200 | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/deployment.md` | 200 | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/security.md` | 250 | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |
| `documentation/troubleshooting.md` | 300 | LOW (300-500) / MEDIUM (500-800) / HIGH (>800) |
| `documentation/decisions/README.md` | No soft budget | ADR ledger grows monotonically; use `doc-allow-large` hatch with an AD reference for any size-related finding |
| Other files in `documentation/` | 250 | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |

**File-level exemption marker.** A `<!-- doc-allow-large: AD-NN reason -->` HTML comment in the file's preamble (after H1, before first `##`) exempts that file from its Pass 2 budget. The `AD-NN` reference is required; Pass 4 verifies the cited ADR exists. Multiple markers allowed. When marker is present but the cited ADR does NOT exist → MEDIUM `doc-allow-large-ad-missing`. Element-level markers from Pass 1 do NOT exempt from Pass 2.

## Per-element budgets

| Element | Cap |
|---|---|
| Table cell | ≤50 words |
| List item | ≤40 words |
| Code snippet | ≤15 lines |
| Heading nesting | ≤4 levels (`####`) |
| Single paragraph | ≤120 words |

## Lane separation

| File | Owns | Never owns |
|---|---|---|
| `architecture.md` | Component layout, data flow, file/folder structure, technology choices, schema overviews | API contracts, env vars, deploy steps, troubleshooting |
| `api-reference*.md` | HTTP routes, request/response schemas, status codes, per-endpoint auth | Architecture rationale, env values, deploy steps |
| `configuration.md` | Env var names, defaults, valid values, consumption points | API contracts, architecture rationale, deploy commands |
| `deployment.md` | Deploy commands, CI workflow names, rollback, secret rotation | API contracts, env documentation (link to configuration.md) |
| `security.md` | Threat model, auth flow, cookie/header policies, rate limits | Per-endpoint auth (link to api-reference.md) |
| `troubleshooting.md` | Symptom → cause → fix recipes, build-tool quirks, runtime gotchas | Architecture, env vars, deploy (link) |
| `decisions/README.md` | All ADRs in a single ledger: index table at top with rows linked to in-file `### AD-N` anchors below, followed by one `### AD-N: Title` section per decision (Status, Context, Decision, Consequences) | Non-ADR content; runbook prose; spec REQs |

## Big-O jargon in narrative documentation

Big-O notation in narrative prose is a flag that the writer reached for academic shorthand instead of stating either (a) a real measurable performance target or (b) a plain-language description.

Detection:
- `\bO\([^)]+\)` in body prose AND inline backticks. Allowed only in fenced code blocks documenting an algorithm's actual implementation, or in headings that explicitly title an algorithm section. Inline backticks are NOT a free pass.
- "logarithmic time", "amortised constant", "polynomial-time", "quadratic", "linear-time" as load-bearing nouns
- Hand-wavy complexity claims with no measurable backing

Fix: write a target number, or plain English, or delete the filler. Severity: MEDIUM. Auto-fix in `auto`/`unleashed`: if a target exists in a related performance REQ, replace with a backlink; otherwise flag.

## Dual-narrative ADRs

An ADR describes ONE decision. The dual-narrative anti-pattern tells two competing stories — usually because someone updated the ADR after the decision was reversed instead of writing a superseding ADR.

Detection: two `## Decision` headings in one file; phrases like "this was later changed to", "we updated this in", "now we do X instead"; "Status: Accepted" header followed by a different decision; "However, after further investigation…" pattern.

Fix: the original ADR is immutable. Write a new ADR `Supersedes: <original-adr>.md`. Mark the original `Status: Superseded by <new-adr>.md`. Never edit the original's decision or consequences sections.

Severity: HIGH.

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
- Sections describing a different concern than their lane are flagged separately by Pass 4.
- A section with no value for a field uses an explicit marker (`**Auth:** none (public endpoint)`).
- Missing fields → Pass 5 MEDIUM.

**Two equivalent shapes per FILE.** A section satisfies the template in either shape:

- **Per-item shape**: one section per item with bolded label/value pairs.
- **Grouped-table shape**: one section per area with a markdown table whose column headers contain the required fields. Table itself counts as contract for every row.

Choice is made once per FILE via dominant-shape detection (≥60% of sections match one shape; first-content-section tiebreak otherwise). Pass 6 enforces consistency against that resolved shape.

Required-field set is the same in both shapes. For `api-reference*.md`, grouped tables must carry columns ≥ `Method`, `Path`, `Auth`, `Implements`. For `configuration.md`: `Variable`, `Default`, `Required`, `Consumed by`, `Implements`. For `security.md`: `Threat`, `Mitigation`, `Verification`, `Implements`. For `troubleshooting.md`: `Symptom`, `Cause`, `Fix`. For `architecture.md`: `Component`, `Responsibility`, `Source`. For `deployment.md`: `When`, `Command`, `Verifies`, `Rollback`.

## Jump-TOC at file top (lane files, binding)

Any lane file with **≥5 `##` top-level sections** MUST carry a `## Contents` section immediately after the file's preamble, before the first content section. Flat markdown link list — one link per `##` section in document order, using section heading text as label.

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
- TOC carries NO section descriptions or commentary — jump list, not summary.

Files under 5 sections exempt.

Pass 5: missing TOC on file with ≥5 sections → MEDIUM `missing-jump-toc`. Out-of-sync entries → MEDIUM `toc-out-of-sync`. **Position drift** — TOC exists but is NOT the first `##` heading after the file's preamble (any non-Contents `##` heading appears before `## Contents` in document order) → MEDIUM `toc-out-of-position`. Detection: walk `##` headings in document order; if `## Contents` is present but is not the first one, fire. All three auto-fix in `auto`/`unleashed`: relocate TOC to the position immediately after preamble (before any `##` content section), regenerate entries.

## TOC content rule (binding)

Contents/TOC blocks in any `documentation/**.md` file MUST NOT contain `REQ-*` or `CON-*` references. These IDs belong on individual sections as `**Implements:**` fields (or in body content tables where the IDs are the contract), not in the navigation block.

Detection: any `(REQ|CON)-[A-Z]+-\d+` token inside a `## Contents` block (or any `^##\s+(Contents|Table of Contents)` block) in any `documentation/**.md` file, including `api-reference.md` and `api-reference-admin.md`.

Severity: MEDIUM `toc-contains-req-ref`. Auto-fix in `auto`/`unleashed`: strip the REQ/CON token from the TOC entry (keeping the section-heading link); add the token as `**Implements:** REQ-X-NNN` on the target section if not already present there.

Body content (tables, prose, per-endpoint `**Implements:**` lines) is unaffected — the rule only forbids these IDs inside `## Contents` navigation blocks.

## Index-table link rule (binding)

Tables in `documentation/decisions/README.md` and any file matching `*-index.md` MUST hyperlink ID cells (AD-*, REQ-*, CON-*, or filename) to their target anchors. Plain-text ID cells in index tables are a MEDIUM finding `index-table-id-not-linked`.

Forms:
- AD index row: `| [AD-12](ad-12-some-decision.md) | Some Decision | Accepted | ... |`
- REQ index row: `| [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-...) | ... |`

Detection: in any table inside `decisions/README.md` or `*-index.md`, scan each row for a leading or first-column cell matching `(AD|REQ|CON)-[A-Z]*-?\d+`. Bare ID without surrounding `[...]( ... )` → finding.

Auto-fix in `auto`/`unleashed`: wrap the bare ID with a markdown link to the resolved target (target AD file for `decisions/README.md`; target REQ anchor for index files; falls back to logging when target cannot be resolved).

## Pass 1 — Per-element budget enforcement

Walk each `documentation/*.md` and apply per-element caps. Cells over 50 words → MEDIUM (extract to body prose with link). List items over 40 words → MEDIUM. Code snippets over 15 lines → MEDIUM (link to source with line range). Heading nesting at level 5+ → LOW. Paragraphs over 120 words → LOW.

**Per-element exemption markers.** A `<!-- doc-allow-element: AD-NN reason -->` HTML comment on the line immediately above an element exempts that specific element from its cap. `AD-NN` reference required. Examples: a 47-line ASCII component diagram preceded by `<!-- doc-allow-element: AD46b component-diagram -->`. The marker exempts ONLY the next element.

## Pass 2 — File-level budget enforcement

Count lines per file (excluding blank lines and code fences). Apply budget table. Emit finding at severity tier.

In `auto`/`unleashed`, doc-updater proposes a split: identify natural section boundaries (top-level `##`); write a new sibling file with a redirect pointer. Commit: `[doc-updater] split: filename.md → filename-{section}.md`.

## Pass 3 — Implementation-prose detection

Scan each file for paragraphs that read like AC text (`must`, `shall`, `ensures that`, `the system rejects`). These belong in `sdd/`. Flag MEDIUM with target REQ ID (or "no matching REQ" → HIGH because it indicates an unspec'd feature).

## Pass 4 — Lane-violation detection (pattern-based)

Scan each file against per-lane content signatures:

| Signature | Belongs in | Flagged in |
|---|---|---|
| HTTP method + path + status code triplet | `api-reference*.md` | `architecture.md`, `deployment.md`, `configuration.md`, `security.md` |
| Env var name + default value + consumption point | `configuration.md` | `architecture.md`, `deployment.md`, `security.md` |
| Shell command intended to be copy-pasted at deploy time | `deployment.md` | `api-reference*.md`, `troubleshooting.md` (unless `Fix:` block), `architecture.md` |
| Symptom → Cause → Fix recipe block | `troubleshooting.md` | `deployment.md`, `architecture.md`, `api-reference*.md` |
| Threat model paragraph | `security.md` | `architecture.md`, `api-reference*.md`, `configuration.md` |
| Auth/rate-limit rationale | `security.md` OR ADR | `api-reference*.md`, `configuration.md` |
| Decision rationale ("we chose X because…") | ADR | `architecture.md`, `troubleshooting.md`, `deployment.md` |
| Admin-only endpoint with operator runbook prose | `api-reference*.md` (contract) **and** `deployment.md` (runbook) — split | wherever the unsplit blob lives |

Each match → MEDIUM naming source file, section heading, signature, proposed target lane. Proposed-move plan written into `documentation/.doc-coverage.md`.

Dual-narrative ADR detection runs alongside.

## Pass 5 — Format-template field presence

**Scope:** Pass 5 (and all other passes) operate on canonical lane files. Framework metadata files excluded by name: any basename starting with `.` (`.doc-coverage.md`, `.review-needed.md`, `.cold-read-tasks.yml`), `documentation/README.md` index. `documentation/decisions/README.md` is covered by the **Index-table link rule** above and by the per-ADR-section template in the per-lane templates table. Same scope applies for Passes 1-12.

Walk every `##`/`###` section in each canonical lane file. Verify required fields from the per-lane template in either shape. Missing fields → MEDIUM `template-field-missing` listing section + missing fields.

Pass 5 also enforces:
- The jump-TOC rule on the file as a whole (≥5 `##` sections → required TOC).
- The **TOC content rule** above (no REQ/CON refs in TOCs of any documentation file).
- The **Index-table link rule** above (ID cells in `decisions/README.md` and `*-index.md` files must be hyperlinks).

Shape detection per section:
1. Section contains a markdown table whose header row matches ≥3 of the lane's required fields → enforce **grouped-table shape**.
2. Otherwise → enforce **per-item shape**.

Auto-fix in `auto`/`unleashed` requires inferable content from source; otherwise stays as a finding.

## Pass 6 — File-level shape consistency

Verify each canonical lane file against its expected shape declared by the per-lane format templates table (resolved by filename). Every section that deviates → MEDIUM `rendering-shape-mismatch` naming the section, deviant shape, expected file shape.

**Content-preservation guarantee:** auto-fix preserves all original prose verbatim. Restructuring a per-item section to grouped-table shape collapses the bolded pairs into table rows; extended prose preserved as body prose below the table. Reverse direction splits table rows into sections. Either direction, no clause dropped or paraphrased. If a section's prose cannot be split or merged without semantic loss (>200 words of inline prose that does not fit any single cell), auto-fix DEFERS that one section, emits MEDIUM `shape-conversion-content-bloat`. Rare residual JUDGMENT.

Auto-fix in `auto`/`unleashed`: mechanical re-render; commit `[doc-updater] re-render: {file} to canonical shape`.

## Pass 7 — Canonical per-endpoint rendering

**Binding scope:** Pass 7 fires on every `documentation/api-reference*.md` file — the entire family (`api-reference.md`, `api-reference-admin.md`, and any future split sibling). Pass 5's per-lane format templates and Pass 13's three within-section triggers also apply, but Pass 7 adds the stricter per-endpoint binding template below — file-level shape uniformity, the prose paragraph cap, the fenced `METHOD path` block in place of bolded Method/Path lines, and the canonical Authentication / Origin check vocabularies.

**File-level shape uniformity.** Within a single `api-reference*.md` file, every endpoint section MUST use the SAME shape (per-item OR grouped-table; per-item is the binding default below). A file mixing both is `rendering-shape-mismatch` per-section against the file's dominant resolved shape, MEDIUM, per the existing Pass 6 contract. Auto-fix re-renders deviant sections.

**Per-field rendering uniformity within file.** Within a single `api-reference*.md` file, every endpoint section's `Response` field MUST render in the SAME sub-shape: either all inline `**Response:** {value}` OR all heading-plus-table (`**Response**\n\n| Status | Outcome | Body |\n...`). The same rule applies to the `Request` field (inline `**Request:** {value}` vs heading-plus-table `**Request body**\n\n| Field | ... |`). Mixing both sub-shapes within one file is `response-rendering-mixed` (or `request-rendering-mixed`), MEDIUM. Detection: walk endpoint sections; tally each section's Response (and Request) sub-shape; if ≥1 section uses inline and ≥1 uses heading-plus-table, fire. Auto-fix in `auto`/`unleashed`: re-render all minority-shape sections to the majority shape; ties resolved to the heading-plus-table form because it carries more contract (success row plus error rows in one table).

**Field-order uniformity within file.** Within one `api-reference*.md` file, every endpoint section MUST present its bolded field labels in the same order. Canonical order from the binding template below: `Authentication`, `Origin check`, `Path parameters` (optional), `Query parameters` / `Request body` (optional), `Response`, `Error codes` (optional), `Rate limit` (optional), `Implements`, `Notes` (optional). `Query parameters` and `Request body` share one slot; either order between them is acceptable when both present. A section whose label sequence does not match the canonical order — skipping optional fields the section legitimately omits — is `endpoint-field-order-drift`, MEDIUM. Detection: extract the sequence of bolded labels per endpoint section; compare against the canonical order with omissions allowed; any out-of-order label fires. Auto-fix in `auto`/`unleashed`: re-order the section's fields to canonical order; field values move with their labels verbatim, no content loss.

**Prose paragraph cap per endpoint section.** Outside the optional `**Notes**` block (≤3 paragraphs per template below), an endpoint section MUST NOT carry standalone prose. A paragraph that is not (a) a field line, (b) a fenced block, (c) a table, or (d) inside `**Notes**` is MEDIUM `endpoint-section-prose-leakage`. Detection: paragraphs whose first non-whitespace token is not `**`, `|`, or ` ``` `. Auto-fix in `auto`/`unleashed`: move prose into a `**Notes**` block at the section bottom; prose spanning ≥3 endpoints relocates to `## Conventions` via Pass 13 Trigger 3. Three-paragraph operational descriptions signal architectural rationale leakage — escalate to `documentation/.review-needed.md`.

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

{1–3 prose paragraphs.}
]

---
```

**Canonical Authentication vocabulary** is exactly the six values listed; any other value → MEDIUM. **Canonical Origin check vocabulary** is exactly three values: `applies`, `exempt`, `n/a`. Exempt requires a parenthetical justification on the same line.

**Tombstoned endpoints** use a distinct minimal shape — only heading + `**Status:** Tombstoned` + `**Replacement:**`. No Method/Path/Auth fields.

**Conventions section.** A file-level `## Conventions` section at the top of an `api-reference*.md` file factors out error envelope shape, Authentication vocabulary, Origin check vocabulary, Rate-limit format.

Pass 7 validates the binding shape, not just field presence. A section with `**Auth:**` instead of `**Authentication:**`, or Method/Path as separate fields instead of a fenced code block, is MEDIUM even though content is present. Auto-fix: mechanical re-render; commit `[doc-updater] re-render: {file} to canonical shape`.

## Pass 8 — Verification truth-check

For every `**Verification:** <test-file>` field, open the cited file and check:

1. The section's `**Implements:** REQ-X-NNN` ID appears in a `describe`/`test`/`it` block name within the cited file.
2. At least one content-word token (≥4 chars, stopwords excluded) from the section's `**Threat:**` or `**Mitigation:**` prose appears anywhere in the cited file.

Neither match → MEDIUM `verification-field-cites-unrelated-test`. The cited file existing on disk is necessary but not sufficient.

Multiple files (comma- or `+`-separated) evaluated independently; if at least one passes, the field passes — first file is load-bearing.

Auto-fix in `auto`/`unleashed`: rewrite failing field to `**Verification:** {kept-files}` (drop unrelated). If every file failed, replace with `**Verification:** audit pending — see `documentation/.doc-coverage.md`` and append entry.

## Pass 9 — Implements-vs-AC cross-walk

For every `**Implements:** REQ-X-NNN` (or `REQ-X-NNN AC N`) field, read the linked REQ's Intent and ACs and classify the section-vs-REQ relationship:

| Classification | Severity | Auto-fix |
|---|---|---|
| (a) Section describes a specific AC's behaviour, cited AC matches | no finding | Accept |
| (b) Section describes generic REQ context, field cites REQ without AC suffix | no finding | Accept |
| (b') Section describes generic context but field cites specific AC | MEDIUM `implements-field-too-narrow` | Strip AC suffix |
| (c) Section describes behaviour outside every AC of linked REQ | HIGH `implements-field-mismatched` | Replace with better-match REQ or mark audit pending |

If multiple ACs plausibly match → MEDIUM `implements-field-low-confidence` rather than auto-rewrite. Under-flag rather than over-rewrite.

## Pass 10 — Stale code-block detection

For every fenced code block, `**Path:** /api/foo` field, function signature in body, JSON shape example, resolve against `src_globs` from `sdd/config.yml`:

1. **Route paths**: any `**Path:**` or fenced block whose first line is HTTP method + path. Resolve via filename convention. HIGH `route-not-in-source` if no handler resolves; MEDIUM `route-handler-renamed` if near-match at sibling path.
2. **Function signatures**: any `function foo(...)` etc. in body prose or fenced TS/JS. Resolve via `src/**` grep. MEDIUM `function-signature-drift` if different params/types. HIGH `function-removed` if no longer exported.
3. **JSON shape examples**: any fenced `json` block paired with `**Response:**`/`**Request:**`. Compare top-level keys against matching TS type. MEDIUM `json-example-shape-drift`. Prefer `tests/fixtures/` fixture when present.
4. **Env var references**: any `**Variable:** FOO_BAR` or `env.FOO_BAR`. Grep `src/**`. HIGH `env-var-removed-from-source` if no consumer.

Auto-fix in `auto`/`unleashed`: for shape-drift, regenerate from source. Never delete a stale block silently — replace or flag.

## Pass 11 — Content-preservation on trim

When doc-updater proposes a Pass 1 trim, tokenise removed content clause-by-clause. For each removed clause, check whether its content tokens reappear in: the kept body, surrounding prose, parent section's `**Rationale:**`/`**Consequences:**`/`**Context:**`, or linked ADR body.

Three outcomes:
- All removed clauses match elsewhere → trim commits as-is.
- Some clauses are context-loss but relocation exists (adjacent paragraph, ADR, parent prose) → promote with leading `Trimmed from <bullet/section> on <date>:` marker, then commit. Commit body lists `trimmed N clauses; preserved K; promoted M to {target}`.
- Clauses are context-loss with no relocation target → trim is REVERTED. MEDIUM `trim-would-lose-load-bearing-content` listing the bullet and clauses. Cap violation persists; content preserved.

## Pass 12 — Stranger cold-read

For each top-level canonical file, dispatch a fresh subagent (`general-purpose` subtype — **not** `doc-updater`, must come in cold) with: (i) only the contents of the one doc file, (ii) a simulated task. Default task registry:

| File | Simulated task |
|---|---|
| `api-reference.md` | "Call the most-used public endpoint and parse the response. Output the exact curl command + field list." |
| `api-reference-admin.md` | "Manually trigger a backend job listed in this file. Output exact request + success signal." |
| `architecture.md` | "Find the source file that owns request authentication for admin endpoints. Output the path." |
| `configuration.md` | "List every env var the dev-bypass code path consumes. Output: name, type, default, consumed where." |
| `deployment.md` | "Roll back the last production deploy. Output exact commands in order + verification between steps." |
| `security.md` | "External researcher claims session cookie is readable from JavaScript on prod. Refute or confirm using only the doc; output load-bearing sentence." |
| `troubleshooting.md` | "User reports 500 after login. Output first three diagnostic steps from the doc." |
| `decisions/README.md` | "Why was the most recent ADR raised? Output ADR ID and one-line reason." |

Subagent reports `succeeded` / `partial` / `failed`. Partial and failed → MEDIUM `stranger-cold-read-gap` naming the specific information the doc failed to surface.

Project-overridable via `documentation/.cold-read-tasks.yml`. Pass runs at most once per PR-boundary trigger (caches on commit SHA + file mtime). No auto-fix — signal only; written to `documentation/.doc-coverage.md` under `## Cold-read gaps`.

## Pass 13 — Within-section semantic consistency

**Scope:** every `documentation/**.md` file (lane file, ADR, runbook, index, anything). Independent of per-lane format templates — these triggers catch failures in document structure that any well-formed markdown document should avoid, regardless of what it documents.

A "section" here means any heading block (`##`, `###`, `####`, any depth) plus everything between that heading and the next heading of the same or shallower depth. Three triggers fire deterministically; each is MEDIUM with mechanical auto-fix.

**Trigger 1 — Duplicate field within section.** Any bolded label `**{Label}:**` appearing 2+ times as a line prefix within the same heading section is `field-duplicated-within-section`. Detection: scan the section body for lines matching `^\*\*([A-Z][A-Za-z0-9 _-]+):\*\*`; count occurrences per label; ≥2 fires. Rationale: a contract field declared twice means readers cannot tell which value is load-bearing.

Auto-fix in `auto`/`unleashed`: same value (whitespace-normalised) in every occurrence → keep the first, delete the rest. Different values → escalate to `documentation/.review-needed.md` with both quoted; reconciliation is JUDGMENT.

**Trigger 2 — Hybrid shape within section.** A heading section contains BOTH (a) ≥2 lines of bolded label/value pairs in the section's prefix block (before the first paragraph, table, or fenced code block), AND (b) one or more markdown tables whose column headers overlap ≥2 of those bolded labels. Severity: `hybrid-shape-within-section`. Rationale: the same contract is rendered twice in two shapes; the duplication is the bug, not which shape is "right".

Detection: parse the section's prefix-block bolded labels; for each table in the section body, take the header row column names; if the intersection size ≥2, fire.

Auto-fix in `auto`/`unleashed`: keep whichever shape dominates the file (count of sections in each shape across the whole file; ties broken by the file's first content section). Delete the duplicate-content side of the hybrid. If the non-dominant side carries columns or fields the dominant side does not, preserve only the unique columns/fields, dropping the overlapping ones. If preservation cannot be disambiguated mechanically, escalate.

**Trigger 3 — Repeated paragraph across sibling sections.** A normalised paragraph (collapse whitespace, lowercase, strip surrounding emphasis) appearing byte-identical in ≥3 sibling sections at the same heading depth within one parent is `repeated-prose-pattern`. Rationale: identical prose copy-pasted across ≥3 siblings belongs in one shared section the siblings link to. Hash-collision is necessary — divergent clauses do not match; the rule will not fire on near-duplicates, by design.

Detection: walk every paragraph (blank-line separated, excluding fenced blocks, tables, field lines). Normalise, hash, group by sibling depth + parent. ≥3 collisions across distinct siblings fires.

Auto-fix in `auto`/`unleashed`: extract to a shared anchor section in the same file. If `## Conventions`/`## Shared`/`## Common` exists, append under `### {short-label}` (4-6 content words from the paragraph's lead); otherwise create `## Conventions` immediately after the preamble. Replace each in-section occurrence with `See [{section} § {short-label}](#anchor-slug).` (≤25 words). When some siblings carry diverging variants, only the hash-matching set relocates; variants stay because they are not duplicates.

## Pass 14 — Authoring quality (the reviewer-with-a-brain pass)

Passes 1-13 check shape, size, and cross-references. They do not check whether the prose is correct, complete, or useful. A file can be perfectly shaped AND lying; can pass every mechanical pass AND be useless to a developer. Pass 14 is read-and-judge, not pattern-match: re-read every diff hunk that adds or rewrites prose in `documentation/**` as a naïve sceptical reviewer.

Three questions, asked in order on every prose hunk:

1. **Did I weasel?** Lexical seed: `appropriately`, `as needed`, `properly`, `robust`, `handled gracefully`, `where applicable`, `if needed`, `as required`, `should` (non-normative), `may`, `might`, `typically`, `generally`, `usually` — without an immediately-following numerical or behavioural anchor — is a weasel. Name the specific value/behaviour or delete. "Rate-limited appropriately" → "60/60s per IP, fail-closed". MEDIUM `prose-weasel`. Escalates when no concrete anchor is available from surrounding source.

2. **Did I claim what I cannot verify?** Every prose claim about *what the code does* MUST be backed within the same paragraph by a fenced code block, a function/file path in `src_globs`, a REQ-ID backlink, or a verifiable external reference (RFC, vendor doc, ADR). "Retries up to 3 times" with no anchor is unverifiable narration. Fix: grep `src_globs` and add the source path, rewrite to a falsifiable form, or delete. HIGH `prose-unverifiable` — an unverified specific claim is worse than no claim.

3. **Did I explain WHY?** Most sections describe what the code does. Ask: would a developer who has never seen this system understand *why* it works this way after reading my prose? If the why is non-obvious (hidden constraint, past incident, deliberate trade-off, vendor quirk, regulation) and is not stated, the section is incomplete. LOW `prose-missing-why`. Auto-fix: escalate to `documentation/.doc-coverage.md` under "Authoring debt".

**Scope.** Pass 14 fires on every prose diff (mechanical re-render counts too). On `/sdd clean --all` or any audit run with no defining diff, scope widens to every paragraph in every canonical lane file. A "ran (N files)" manifest count is dishonest when only diff hunks were inspected.

**Triggers are seeds for judgment.** Deny prose because — after reading as a reviewer — it is vague, unverifiable, or missing context. A weasel-shaped sentence concretely anchored elsewhere is fine; a sentence with no seed words but no concrete payload is not. Read with a brain, not grep.

## Severity classification

| Severity | Definition |
|---|---|
| **CRITICAL** | Doc claims behaviour that contradicts shipped code in a security/data-loss-misleading way |
| **HIGH** | Implementation-prose paragraph with no REQ; dual-narrative ADR; doc references removed function/file/route; monolithic decisions README; file >2× soft budget |
| **MEDIUM** | Lane violation; cell >50 words; file 1×–2× budget; missing REQ backlink; ADR missing Status; index-table ID not linked; REQ ref in non-API TOC |
| **LOW** | Cell 40-50 words; file 0.8×–1× budget (approaching); inconsistent heading capitalisation; broken intra-doc anchor link |

Mode-dependent action mirrors spec-reviewer:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW
- `unleashed`: auto-fix everything including LOW

## REQ backlinks in documentation/

Every documented feature should reference the REQ that specifies it. Format: inline `(REQ-X-NNN)` immediately after the feature name in a heading or first sentence.

```markdown
## Inquiry email delivery (REQ-API-002)
```

doc-updater scans every section heading and first paragraph. Section describes a feature with a matching REQ in `sdd/` but lacks a backlink → MEDIUM, auto-inserted in `auto`/`unleashed`.

## Working tree and branch safety

Same rules as spec-reviewer (see `spec-discipline.md`):
1. Working tree must be clean.
2. `auto` and `unleashed` push to whatever branch is currently checked out.

## Files alongside `documentation/`

| File | Committed | Purpose |
|---|---|---|
| `documentation/decisions/README.md` | Yes | ADR ledger — index table at top with rows linked to in-file `### AD-N` anchors, followed by one section per ADR |
| `documentation/.doc-coverage.md` | Yes | Output of doc-updater coverage runs and Pass 4 proposed-move plans |
| `documentation/.review-needed.md` | Yes | Doc findings escalated for human review |

Nothing in `documentation/` is gitignored.
