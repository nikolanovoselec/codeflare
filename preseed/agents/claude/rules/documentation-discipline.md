# Documentation Discipline (SDD-Bootstrapped Projects)

Sibling rule file to `spec-discipline.md`. Applies whenever a project has both an `sdd/` folder AND a `documentation/` folder. If `documentation/` does not exist in the project, these rules are inert — ignore them.

The `doc-updater` agent enforces this file. The `spec-reviewer` agent does not touch `documentation/` but may reference these rules when explaining lane violations.

## What documentation is

`documentation/` is the **how** layer of the project: how things are wired, what env vars exist, what HTTP routes return, where files live, why a particular technology was chosen. It is not the spec (that's `sdd/`), not the changelog (that's `sdd/changes.md`), not the README (that's the project tagline + getting-started).

The reader of `documentation/` is a developer who already knows what the product does and now needs to navigate the implementation. Every page should answer one operational question quickly.

## Binding execution contract (NO CHERRY-PICKING)

**This section exists because the framework has failed in practice when agents executed only the cheap structural passes (1-7) and silently skipped the expensive content-quality and cold-read passes (8-12). That is the failure mode this contract eliminates. Read this section first; obey it before applying any individual pass below.**

Every execution path that enters this rule file — `/sdd clean`, PR-boundary doc-updater triggers, manual doc-updater invocations — MUST execute every pass listed in the **Required execution manifest** below on every run. There is no "structural-only" mode. There is no "skip if the corpus looks clean." There is no agent-side optimization that drops Passes 8-12 because they cost more tokens or require subagent spawns. If a pass is genuinely inapplicable this cycle (e.g., Pass 11 on a run with no Pass 1 trim ops), it is reported as `inert` with a one-line reason — not skipped silently.

### Required execution manifest

Every clean / PR-boundary run MUST emit a manifest with one row per pass. The manifest is written FIRST as a template with every row marked `pending`, updated as each pass completes, and finalized at run end. A manifest still containing `pending` rows at finalize time is itself a HIGH finding logged to `documentation/.review-needed.md`.

**Where the manifest is written depends on the trigger:**

- **`/sdd clean` runs** → write the docs-side rows of the manifest into `sdd/.last-clean-run.md` (the same audit file `spec-discipline.md`'s contract writes to). This is the audit artifact for `/sdd clean` specifically.
- **PR-boundary doc-updater triggers** → write the docs-side manifest into the commit body of the agent's commit, OR — if no commits are produced this run — into the `documentation/.review-needed.md` entry for the run as a `## Execution manifest` sub-section above the findings list. PR-boundary triggers do NOT write to `.last-clean-run.md`.

**Manifest format** (same shape regardless of where written):

| Pass | Required action this run | Status (with evidence) |
|---|---|---|
| Pass 1 — Per-element budgets | Walk every doc file; count cell/list/snippet/heading/paragraph against caps. | `ran (K files, M findings)` |
| Pass 2 — File-level budgets | Walk every doc file; apply file-budget table; honor `doc-allow-large` markers. | `ran (K files, M findings)` |
| Pass 3 — Implementation-prose detection | Walk every doc file; flag AC-shaped paragraphs that belong in `sdd/`. | `ran (K files, M findings)` |
| Pass 4 — Lane-violation detection | Walk every doc file against the signature catalogue; propose lane moves to `.doc-coverage.md`. | `ran (K files, M findings)` |
| Pass 5 — Format-template field presence | Walk every section in canonical lane files; verify required fields in either shape; check jump-TOC. | `ran (S sections scanned, M findings)` |
| Pass 6 — File-level shape consistency | Detect dominant rendering shape per file; flag deviant sections; apply first-section tiebreak. | `ran (K files, M findings)` |
| Pass 7 — Canonical per-endpoint rendering | For `api-reference.md`, verify each endpoint section matches the binding template. | `ran (E endpoints, M findings)` or `inert (no api-reference.md)` |
| Pass 8 — Verification truth-check | For every `**Verification:**` field, open the cited test file and verify REQ ID + content-word match. | `ran (V fields scanned, F test files opened, M findings)` |
| Pass 9 — Implements-vs-AC cross-walk | For every `**Implements:** REQ-X-NNN` field, read the linked REQ; classify section-vs-AC relationship. | `ran (I fields scanned, M findings)` |
| Pass 10 — Stale code-block detection | For every fenced code block / route path / function signature / JSON example / env var ref, resolve against `src_globs`; flag drift. | `ran (B blocks resolved, M findings)` |
| Pass 11 — Content-preservation on trim | On every Pass 1 trim proposed this run, run the content-preservation tokenization check before committing. | `ran (T trim ops, M findings)` or `inert (no trim ops)` |
| Pass 12 — Stranger cold-read | For every canonical lane file in the task registry, dispatch a fresh `general-purpose` subagent with one simulated task; record gaps to `documentation/.doc-coverage.md`. | `ran (T tasks dispatched, M findings)` or `ran (cached, hit on SHA <sha>)` |

### Evidence requirement is binding

Every row's status MUST include concrete numbers naming WHAT was inspected — the file count walked, the sections scanned, the endpoints verified, the cited test files opened. A row that says `ran (0 findings)` without an evidence count is itself a HIGH finding. Numbers are spot-checkable: when the user audits the manifest, they can sample three sections and confirm the agent actually inspected them.

`inert` is valid ONLY when the pass itself defines the no-work case (Pass 7 needs `api-reference.md`; Pass 11 needs a trim op). A claim of `inert` outside those documented cases is a HIGH finding. `skipped: <reason>` is reserved for user-override situations (user explicitly told the agent to skip this run); a `skipped:` row without a recorded user override in the conversation log is itself a HIGH finding.

### Cost is not a valid reason to skip

Pass 8 requires opening one cited test file per Verification field. Pass 10 requires one resolve per fenced block / route / signature. Pass 12 spawns one fresh subagent per canonical lane file. These are not optional. An agent that drops them because "the structural sweep passed and the corpus looked clean" is the failure mode this contract was written to eliminate. The whole point of the discipline is to catch what structural checks miss; skipping them inverts the framework's purpose.

If a real cost ceiling exists for a session (e.g., a token budget the user has explicitly set), the agent surfaces that ceiling BEFORE starting the run, asks the user whether to defer the expensive passes to a follow-up cycle, and records the user's decision as the `skipped: <reason>` justification. Silent unilateral deferral is forbidden.

### Pass 12 caching is not a skip

Pass 12 caches results on commit SHA + file mtime (per the pass definition). When the cache is warm, the agent records `ran (cached, hit on SHA <sha>)` — that is execution. When the cache is cold or the SHA has advanced, Pass 12 runs fresh. The cache exists to amortize cost across multiple Stop hooks within one PR sync, not to skip the pass altogether.

### Sibling-discipline coupling

A `/sdd clean` run executes the union of THIS file's manifest (Passes 1-12) AND `spec-discipline.md`'s execution manifest (STRUCT-* + TDD-COVERAGE + CQ-1/2/3). A run that completes only one side is incomplete and emits a HIGH finding `clean-run-partial-execution` listing the skipped half. The single source of truth for what "ran" means is the manifest table written to `sdd/.last-clean-run.md`.

## Forbidden content in documentation/

| Banned | Where it goes instead |
|---|---|
| Product motivation prose ("we built this to help users…") | `sdd/README.md` Intent fields or REQ Intent |
| Acceptance-criterion language ("the system must reject expired tokens") | `sdd/{domain}.md` AC bullets |
| User-visible feature copy ("Welcome to Apartmani Pašman!") | source code (where the string actually lives) |
| Implementation rationale told as story ("we tried X, then Y, then settled on Z") | ADR (`documentation/decisions/`) — not architecture.md |
| Long regex internals inline (`^(?<scheme>\w+)://(?<host>[^/]+)/(?<path>.*)$`) | source-code docstring at the regex site |
| Magic-constant prose ("we picked 60s because cache TTL aligns with…") | source-code comment next to the constant, OR an ADR |
| Strikethrough text | Delete entirely. Git history is the strikethrough. |
| TODO bullets, "coming soon" sections, "planned but not built" | GitHub issue or `pending.md` at repo root |
| Future-tense roadmap items | `sdd/{domain}.md` as `Status: Planned` REQs |
| Any content that duplicates a REQ instead of cross-referencing it | A backlink to the REQ ID — never copy-paste |
| Big-O jargon in narrative prose (`O(n log n)`, "logarithmic time", "amortized constant") | If a real performance target exists, write it as a measurable number ("p95 < 200ms", "linear in input size up to N records"); otherwise drop the prose. Big-O notation is academic implementation detail, not user-observable behavior. |

## Allowlist (these ARE acceptable in documentation/)

- **REQ backlinks**: `(REQ-API-003)` next to the section that documents the API contract — encouraged
- **Source-file paths**: `src/server/auth.ts` next to the section it documents
- **Function and class names** when documenting how to call them
- **Database table and column names** in `documentation/architecture.md` schema sections
- **Cookie names, env var names, header names** when documenting the configuration or HTTP contract
- **Code snippets** when illustrating a non-obvious calling pattern (≤15 lines per snippet)

## Per-file line budgets

`documentation/` files describe one bounded operational concern each. Long files signal that the concern was split incorrectly OR that the file is mixing implementation prose with reference material.

| File | Soft budget | Severity above budget |
|---|---|---|
| `documentation/architecture.md` | 500 lines | LOW (500-700) / MEDIUM (700-1000) / HIGH (>1000) |
| `documentation/api-reference.md` | 600 lines | LOW (600-1000) / MEDIUM (1000-1500) / HIGH (>1500) |
| `documentation/configuration.md` | 200 lines | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/deployment.md` | 200 lines | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/security.md` | 250 lines | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |
| `documentation/troubleshooting.md` | 300 lines | LOW (300-500) / MEDIUM (500-800) / HIGH (>800) |
| `documentation/decisions/<adr>.md` | 100 lines per ADR | LOW (100-150) / MEDIUM (150-250) / HIGH (>250) |
| Other files in `documentation/` | 250 lines | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |

Files over budget produce a finding at the severity tier.

**File-level exemption marker.** A `<!-- doc-allow-large: AD-NN reason -->` HTML comment placed in the file's preamble (after the H1, before the first `##` section) exempts the entire file from its Pass 2 budget. The `AD-NN` reference is required and a Pass 4 check verifies the cited ADR exists. The reason after it is a one-line operator note. Multiple markers per file are allowed (some files carve out for multiple ADRs). When a marker is present and references a real ADR, Pass 2 emits no finding. When a marker is present but the cited ADR does NOT exist, Pass 2 emits a MEDIUM `doc-allow-large-ad-missing` instead of the budget finding — the file is not silently exempted by a dead reference. Element-level markers from Pass 1 do NOT exempt from Pass 2; the rules are independent.

## Per-element budgets

These caps apply inside a file regardless of whether the file is under or over its own budget.

| Element | Cap | Why |
|---|---|---|
| Table cell | ≤50 words | Cells are scanned, not read. Anything longer belongs in body prose below the table. |
| List item | ≤40 words | Same logic — bullets are scanned. |
| Code snippet | ≤15 lines | Longer snippets indicate the doc is duplicating source code instead of pointing at it. Link to the source file with line range. |
| Heading nesting | ≤4 levels (`####`) | Deeper nesting fragments the reader's mental model. Promote to a sibling page. |
| Single paragraph | ≤120 words | Walls of prose hide the load-bearing sentence. Break for emphasis. |

## Lane separation between documentation files

Each documentation file owns one lane. Cross-lane content is a MEDIUM finding and belongs in the correct lane file.

| File | Owns | Never owns |
|---|---|---|
| `documentation/architecture.md` | Component layout, data flow, file/folder structure, technology choices, schema overviews | API endpoint contracts, env var definitions, deploy steps, troubleshooting recipes |
| `documentation/api-reference.md` | HTTP routes, request/response schemas, status codes, auth requirements per endpoint | Architecture rationale, env var values, deploy steps |
| `documentation/configuration.md` | Env var names, defaults, valid values, where each one is consumed | API contracts, architecture rationale, deploy commands |
| `documentation/deployment.md` | Deploy commands, CI workflow names, rollback procedures, secret rotation steps | API contracts, env var documentation (link to configuration.md instead) |
| `documentation/security.md` | Threat model, auth flow, cookie/header policies, rate limits | Per-endpoint auth (link to api-reference.md instead) |
| `documentation/troubleshooting.md` | Symptom → cause → fix recipes, build-tool quirks, runtime gotchas | Architecture (link), env vars (link), deploy steps (link) |
| `documentation/decisions/<adr>.md` | One ADR each — context, decision, consequences | Anything not specific to that one decision |

When a cell or paragraph in `architecture.md` describes an HTTP route's contract, it's a lane violation — the content belongs in `api-reference.md` and `architecture.md` should reference the route by name only.

## Big-O jargon in narrative documentation

A documentation file should describe what the system does in observable terms, not analyze its theoretical complexity. Big-O notation in narrative prose is a flag that the writer reached for academic shorthand instead of stating either (a) a real, measurable performance target or (b) a plain-language description of scaling behavior.

Detection signals:

- `\bO\([^)]+\)` — any `O(n)`, `O(n log n)`, `O(n^2)`, `O(1)`, etc., **in body prose AND inline backticks**. Allowed only in (a) fenced code blocks documenting an algorithm's actual implementation, (b) headings that explicitly title an algorithm or analysis section. Inline backticks (`` `O(n)` ``) are NOT a free pass — wrapping the jargon in backticks doesn't make it a measurable contract; writers will reach for backticks defensively to silence the linter without rewriting, and the rule is supposed to make them rewrite.
- "logarithmic time", "amortized constant", "polynomial-time", "quadratic", "linear-time" as load-bearing nouns in a sentence describing system behavior
- Hand-wavy complexity claims ("scales gracefully", "performs well") with no measurable backing

The fix:

- If a real performance contract exists, write it as a target number: `"p95 < 200ms for inputs up to 10k rows"`, `"loads in < 2s on 4G mobile"`. Targets belong in the relevant performance REQ, doc backlinks point there.
- If the contract is qualitative, write plain English: `"the index is rebuilt incrementally so adding a record stays cheap as the dataset grows"` instead of `"amortized O(log n) insertions"`.
- If neither applies, the prose was filler — delete it.

Severity: MEDIUM. Auto-fix in `auto`/`unleashed`: if a target exists in a related performance REQ, replace the big-O prose with a backlink. Otherwise flag and let the user decide.

## Dual-narrative ADRs

An ADR (`documentation/decisions/<adr>.md`) describes ONE decision. The dual-narrative anti-pattern is an ADR that tells two competing stories — usually because someone updated it after the decision was reversed instead of writing a new ADR that supersedes it.

Detection signals:

- Two `## Decision` headings in one file
- Phrases like "this was later changed to", "we updated this in", "now we do X instead"
- A "Status: Accepted" header followed by paragraphs describing a different decision
- Any "However, after further investigation…" pattern

The fix: the original ADR is immutable. Write a new ADR that references the original by file name and is marked `Supersedes: <original-adr>.md`. Mark the original `Status: Superseded by <new-adr>.md`. Never edit the original's decision or consequences sections.

This is enforced as a HIGH finding by doc-updater because dual-narrative ADRs corrupt the decision log — readers cannot tell which decision is current.

## Per-lane format templates

Each canonical lane file follows a per-section template so readers can scan the file in one pass instead of reverse-engineering each section's format. Templates are sibling-registered to the lane separation table.

| File | Required per-section fields |
|---|---|
| `documentation/api-reference.md` | Per endpoint section: `**Method:** {GET\|POST\|...}`, `**Path:**`, `**Auth:**`, `**Request:**` (or "no body"), `**Response:**` (status code list with one-line description each), `**Implements:** (REQ-X-NNN)` |
| `documentation/configuration.md` | Per env var section: `**Variable:**`, `**Default:**`, `**Required:**` (yes/no), `**Consumed by:** {file/module}`, `**Implements:** (REQ-X-NNN if applicable)` |
| `documentation/deployment.md` | Per command/runbook section: `**When:**` (trigger), `**Command:**` (fenced block), `**Verifies:**` (success signal), `**Rollback:**` |
| `documentation/security.md` | Per policy section: `**Threat:**`, `**Mitigation:**`, `**Verification:**` (test/audit reference), `**Implements:** (REQ-X-NNN)` |
| `documentation/architecture.md` | Per component section: `**Responsibility:**` (one-sentence), `**Inputs:**`, `**Outputs:**`, `**Source:**` (file path or `src/foo/**`) |
| `documentation/troubleshooting.md` | Per recipe section: `**Symptom:**`, `**Cause:**`, `**Fix:**`, `**Prevention:**` (optional) |
| `documentation/decisions/<adr>.md` | ADR header: `**Status:** {Proposed\|Accepted\|Superseded\|Reclassified} ({YYYY-MM-DD})`, `**Context:**`, `**Decision:**`, `**Consequences:**`, optional `**Supersedes:**` |

**Rules of engagement**:

- Templates apply per **section** (`##` or `###` heading), not per file. A top-of-file preamble paragraph is exempt.
- Sections describing a different concern than their lane (e.g., a `## Glossary` section at the bottom of `configuration.md`) are exempt — they're flagged separately by Pass 4 lane-violation detection.
- A section that legitimately has no value for a field uses an explicit marker: `**Auth:** none (public endpoint)` rather than omission. The marker counts as the field being present.
- Missing fields are emitted by Pass 5 as MEDIUM findings naming the section and the missing field list.

**Two equivalent shapes per FILE (not per section).** A section satisfies the template if it carries the required fields in either of these shapes — Pass 5 accepts both:

- **Per-item shape**: one section per item (one endpoint, one env var, one threat, one recipe) with each required field as a bolded label/value pair (`**Method:** GET`, `**Auth:** Cloudflare Access`, ...).
- **Grouped-table shape**: one section per area (`### Session Management`, `### Container Lifecycle`) listing multiple items in a markdown table whose **column headers contain the required fields**. The table itself counts as the contract for every row. Per-row prose (notes, edge-case warnings) can follow the table.

**The choice between the two is made once per FILE, not per section.** A file mixing both shapes is unreadable: the reader has to retrain their scan pattern on every heading. Pass 6 detects the **dominant** shape in the file (>50% of sections by count) and flags every section that deviates from it as MEDIUM `rendering-shape-mismatch`. The dominant shape is determined by the count of sections that match each shape; ties are broken in favor of the **first** section's shape, so the file's opening sets the contract.

The required-field set is the same in both shapes — only the encoding differs. For `api-reference.md`, a grouped table must carry columns named at least `Method`, `Path`, `Auth`, `Implements` (Request/Response shapes can live in body prose below the table when they're shared across the section's endpoints). For `configuration.md`, a grouped table must carry columns `Variable`, `Default`, `Required`, `Consumed by`, `Implements`. For `security.md`, `Threat`, `Mitigation`, `Verification`, `Implements`. For `troubleshooting.md`, `Symptom`, `Cause`, `Fix`. For `architecture.md`, `Component`, `Responsibility`, `Source`. For `deployment.md`, `When`, `Command`, `Verifies`, `Rollback`.

The full project's template set is the registry above. Projects may extend it via a `templates` field in `sdd/config.yml` (future), but the canonical lane templates are not overridable — the lane is the contract.

## Jump-TOC at file top (lane files, binding)

Any lane file with **5 or more `##` top-level sections** MUST carry a `## Contents` section immediately after the file's preamble (the H1 + audience/intro paragraph), before the first content section. The TOC is a flat markdown link list — one link per `##` section, in document order, using the section's heading text as the link label.

Format:

```
## Contents

- [Conventions](#conventions)
- [Pages](#pages)
- [Authentication](#authentication)
- [Settings](#settings)
- ...
```

Rules:

- One link per `##` section. `###` sub-sections are NOT in the TOC — they're navigated by scrolling within the parent section once the reader has jumped there.
- Link labels match the heading text verbatim (case included).
- Anchor slugs follow the GitHub-flavored Markdown convention (lowercase, spaces → hyphens, punctuation stripped).
- The TOC is auto-maintained by doc-updater: when a new `##` section is added, doc-updater inserts the corresponding TOC entry; when a section is removed, doc-updater removes the entry. Re-ordering sections re-orders the TOC.
- The TOC does NOT carry section descriptions, line counts, or any other commentary. It's a jump list, not a summary.

Files under 5 sections are exempt — the reader can scan them in one screen. Files with a `## Contents` TOC under the threshold are not flagged (a TOC never hurts; the rule only adds it, never removes it).

Pass 5 enforcement: missing TOC on a file with ≥5 sections is a MEDIUM finding `missing-jump-toc`, auto-fixed by doc-updater inserting the TOC. TOC entries out-of-sync with section headings (link label drift, missing entry for an existing section, dangling entry for a removed section) are MEDIUM `toc-out-of-sync`, auto-fixed by re-generating the list.

## Canonical per-endpoint rendering (api-reference.md, binding)

`api-reference.md` is the most-affected lane for shape drift because endpoints accrete one at a time over years and every new endpoint gets rendered in whatever shape the contributor prefers. To make this file scannable, the **per-item** rendering shape is fully bound (every endpoint section uses this exact structure, in this exact field order):

```
### {METHOD path} ({optional descriptive title in parens})

{One-sentence operational summary.}

```
{METHOD} {path}
```

**Authentication:** {none | session | refresh cookie | state cookie | session + admin email | dev-bypass token}
**Origin check:** {applies | exempt | n/a}

[OPTIONAL — present only when the endpoint accepts a body or parameters:
**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| ... | ... | ... | ... |

**Query parameters** / **Path parameters** as separate tables with identical column shape.
]

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | ... | ... |
| `4xx` | ... | error envelope |

[OPTIONAL — present only when the endpoint is rate-limited:
**Rate limit:** {N}/{window} per {scope}, fail-{open|closed}
]

**Implements:** [REQ-X-NNN]({backlink})

[OPTIONAL — present only when the endpoint has caveats not captured above:
**Notes**

{1–3 prose paragraphs.}
]

---
```

The **canonical Authentication vocabulary** is exactly the six values listed; an Authentication field with any other value is a MEDIUM finding. The **canonical Origin check vocabulary** is exactly three values: `applies`, `exempt`, `n/a`. Exempt requires a parenthetical justification on the same line.

**Tombstoned endpoints** (routes that no longer exist but kept for historical reference) use a distinct minimal shape — only the heading + `**Status:** Tombstoned` + `**Replacement:**` field. They do NOT carry Method/Path/Auth fields because those would falsely imply the route exists.

**Conventions section.** A file-level `## Conventions` section at the top of `api-reference.md` factors out the rules that apply to every endpoint (error envelope shape, Authentication vocabulary, Origin check vocabulary, Rate-limit format) so per-endpoint sections stay scannable. Pass 5 does NOT require each endpoint to restate these conventions; the file-level section covers them.

Pass 7 validates the binding shape, not just field presence. A section that has `**Auth:**` instead of `**Authentication:**`, or `**Method:**` + `**Path:**` as separate fields instead of a fenced code block, is a MEDIUM finding even though all required content is present.

## Enforcement passes (run by doc-updater)

doc-updater runs twelve passes on every PR-boundary trigger. Passes 1-7 are **structural** (shape, budgets, lane). Passes 8-12 are **content-quality** (does the doc say what it claims, and can a reader actually use it):

### Pass 1 — Per-element budget enforcement

Walks each `documentation/*.md` file and applies every cap from the per-element table above:

- **Table cells**: count words in each cell; flag cells over 50 words as MEDIUM with a suggested rewrite (extract the long content to a body paragraph below the table and replace the cell with a one-line summary plus a link).
- **List items**: count words in each `-`/`*`/numbered list bullet; flag items over 40 words as MEDIUM (split into multiple bullets or promote to body prose).
- **Code snippets**: count lines inside fenced code blocks; flag blocks over 15 lines as MEDIUM (link to source file with line range instead).
- **Heading nesting**: track the deepest `#` count; flag any heading at level 5+ as LOW (promote section to a sibling page).
- **Single paragraphs**: count words between blank lines outside code fences; flag paragraphs over 120 words as LOW (break for emphasis — walls of prose hide the load-bearing sentence).

**Per-element exemption markers.** A `<!-- doc-allow-element: AD-NN reason -->` HTML comment placed on the line immediately above an element exempts that specific element from its Pass 1 cap. The `AD-NN` reference is required (an ADR must justify the exemption); the reason after it is a one-line operator note. Examples: a 47-line ASCII component diagram preceded by `<!-- doc-allow-element: AD46b component-diagram -->`, a 23-line shell-command runbook block preceded by `<!-- doc-allow-element: AD46a deploy-command -->`. The marker exempts ONLY the element on the next line; the next element is checked normally. This is intentional — exemptions earn their keep one element at a time, not file-wide.

### Pass 2 — File-level budget enforcement

For each file in `documentation/`, count lines (excluding blank lines and code fences). Apply the budget table above. Emit a finding at the severity tier when a file exceeds its budget.

In `auto` and `unleashed` modes, doc-updater proposes a split: identifies natural section boundaries (top-level `##` headings) and writes a new sibling file with a redirect pointer in the original. The split is committed as `[doc-updater] split: filename.md → filename-{section}.md`.

### Pass 3 — Implementation-prose detection

Scan each `documentation/` file for paragraphs that read like AC text (`must`, `shall`, `ensures that`, `the system rejects`). These belong in `sdd/` not `documentation/` and signal that someone wrote intent in the wrong place. Flag as MEDIUM with the target REQ ID (or "no matching REQ" if none exists, escalating to HIGH because it indicates an unspec'd feature).

### Pass 4 — Lane-violation detection (pattern-based)

Scan each file against its declared lane using **per-lane content signatures**, not a single hardcoded example. The pattern catalogue:

| Signature | Belongs in | Flagged in |
|---|---|---|
| HTTP method + path + status code triplet (e.g., `POST /api/foo → 201`) | `api-reference.md` | `architecture.md`, `deployment.md`, `configuration.md`, `security.md` |
| Env var name + default value + consumption point | `configuration.md` | `architecture.md`, `deployment.md`, `security.md` |
| Shell command intended to be copy-pasted at deploy time | `deployment.md` | `api-reference.md`, `troubleshooting.md` (unless `Fix:` block), `architecture.md` |
| Symptom → Cause → Fix recipe block | `troubleshooting.md` | `deployment.md`, `architecture.md`, `api-reference.md` |
| Threat model paragraph (attacker capability + system response) | `security.md` | `architecture.md`, `api-reference.md`, `configuration.md` |
| Auth/rate-limit rationale (why the limits exist, not what they are) | `security.md` OR ADR | `api-reference.md`, `configuration.md` |
| Decision rationale ("we chose X because…", "we tried X then Y") | ADR (`documentation/decisions/`) | `architecture.md`, `troubleshooting.md`, `deployment.md` |
| Admin-only endpoint with operator runbook prose | `api-reference.md` (the contract) **and** `deployment.md` (the runbook) — split, do not duplicate | wherever the unsplit blob currently lives |

For each match, emit a MEDIUM finding naming **the source file**, **the section heading**, **the detected signature**, and **the proposed target lane**. The proposed-move plan is written into `documentation/.doc-coverage.md` so operators can review before accepting.

Dual-narrative ADR detection runs alongside Pass 4 against `documentation/decisions/`.

Triggering examples from the original audit that motivated the pattern catalogue:

- `deployment.md` containing the admin-routes contract → split: contract to `api-reference.md`, deploy-time runbook stays in `deployment.md` with a backlink.
- `deployment.md` containing the dev-bypass diagnostic recipe → move to `troubleshooting.md`.
- `api-reference.md` paragraphs explaining "why fingerprint-drift checks exist" → move to `security.md` or a fresh ADR.

### Pass 5 — Format-template field presence

**Scope:** Pass 5 (and all other passes) operate on canonical lane files in `documentation/`. Framework metadata files are excluded by name: any file whose basename starts with `.` (`.doc-coverage.md`, `.review-needed.md`, `.cold-read-tasks.yml`), the `documentation/README.md` index page (its job is to link out, not to carry per-section templates), and `documentation/decisions/README.md` (the ADR index — covered by the per-ADR template registry, not by lane templates). The scope is identical for Passes 1-12: dot-prefixed framework files and `README.md` indexes are skipped throughout. This prevents framework-output files from being flagged for failing to comply with rules about content they were never meant to hold.

Walk every `##`/`###` section in each canonical lane file and verify it carries the required fields from the per-lane template registry above in either of the two shapes (per-item bolded fields or grouped-table column headers). Missing fields are emitted as MEDIUM `template-field-missing` listing the section + missing field list.

Pass 5 also enforces the jump-TOC rule on the file as a whole: a lane file with ≥5 `##` sections must carry a `## Contents` section per the "Jump-TOC at file top" rule. Missing TOC is MEDIUM `missing-jump-toc`; out-of-sync TOC entries are MEDIUM `toc-out-of-sync`. Both auto-fix by regenerating the TOC list.

Shape detection per section:

1. If the section contains a markdown table whose header row matches ≥3 of the lane's required fields → enforce **grouped-table shape**. Missing fields are columns absent from the header row. The body prose may carry the remaining contract fields (e.g., a single `**Request:**` block shared across all endpoints in a `### Session Management` section).
2. Otherwise → enforce **per-item shape**. Missing fields are bolded label/value pairs absent from the section body.

Per-section findings name the source file, section heading, detected shape, and missing field list:

```
documentation/api-reference.md
  Section "### Session Management" (line 27) — grouped-table shape detected
    Missing columns: Auth, Implements
documentation/api-reference.md
  Section "### Inquiry email delivery" (line 142) — per-item shape detected
    Missing fields: **Auth:**, **Response:**, **Implements:**
```

Auto-fix in `auto`/`unleashed`: requires content (the missing field's value) and only auto-fixes when the value can be inferred from source — otherwise stays as a finding.

### Pass 6 — File-level shape consistency

Detect the dominant rendering shape (per-item vs. grouped-table) by count across all sections in each canonical lane file. The dominant shape is the file's contract. Every section that deviates is emitted as MEDIUM `rendering-shape-mismatch` naming the section, the deviant shape, and the file's dominant shape. Files with a single section have no dominant-shape rule (any shape is fine).

**Deterministic tiebreak (unleashed-first):** when the per-item and grouped-table counts are equal, OR when the dominant shape is ≤60% of sections (file genuinely mixed), the **first content section's shape wins** — that section sets the file's contract and every other section converts to it. No escalation, no operator prompt. This is the same first-section rule already documented under "Two equivalent shapes per FILE"; Pass 6 enforces it deterministically without a HIGH file-level finding.

**Content-preservation guarantee:** the auto-fix preserves all original prose verbatim. Restructuring a per-item section to grouped-table shape collapses the bolded `**Field:** value` pairs into table rows; extended prose (notes, edge-case warnings, paragraphs that don't fit table cells) is preserved as body prose immediately below the table. The reverse direction (grouped-table → per-item) splits each table row into its own section with bolded fields. Either direction, no clause is dropped or paraphrased. If a section's prose genuinely cannot be split or merged without semantic loss (>200 words of inline prose that does not belong in any single table cell), the auto-fix DEFERS that one section, leaves it in its current shape, and emits MEDIUM `shape-conversion-content-bloat` naming the section for a future human pass. This is the one remaining JUDGMENT escalation in Pass 6; it fires rarely in practice.

Auto-fix in `auto`/`unleashed`: mechanical re-render (no semantic change); auto-apply with a per-file commit `[doc-updater] re-render: {file} to canonical shape`.

### Pass 7 — Canonical per-endpoint rendering (api-reference.md only)

For `api-reference.md`, every endpoint section MUST match the **Canonical per-endpoint rendering** template above (heading shape, fenced code block, exact field labels, exact Authentication/Origin-check vocabulary, Response table column shape, Implements link form). Deviations are emitted as MEDIUM `canonical-rendering-violation` naming the section, the deviation (e.g., `**Auth:**` used instead of `**Authentication:**`, missing fenced method-path block, non-canonical Authentication value), and the corrected form. Tombstoned endpoints use the distinct minimal shape per the canonical template and are evaluated against that shape, not the active-endpoint shape.

Auto-fix in `auto`/`unleashed`: mechanical re-render (no semantic change); auto-apply with a per-file commit `[doc-updater] re-render: api-reference.md to canonical shape`.

### Pass 8 — Verification truth-check

For every `**Verification:** <test-file>` field in a doc section, open the cited test file and check both:

1. The section's `**Implements:** REQ-X-NNN` REQ ID appears in a `describe`, `test`, or `it` block name within the cited file. A plain substring match is sufficient (mirrors the spec-discipline source-vs-test detector).
2. At least one content-word token (≥4 chars, stopwords excluded) from the section's `**Threat:**` or `**Mitigation:**` prose appears anywhere in the cited file.

If neither match fires, emit MEDIUM finding `verification-field-cites-unrelated-test` naming the section, the cited file path, and the missing match dimension(s). The cited file existing on disk is necessary but not sufficient — Pass 8 verifies the file actually exercises what the doc claims.

Multiple files in one `**Verification:**` field (comma- or `+`-separated) are evaluated independently; the finding lists only the files that fail. If at least one cited file matches both criteria, the field passes — the convention is that the **first** cited file is the load-bearing one and additional files supplement it.

Severity: MEDIUM. Auto-fix in `auto`/`unleashed`: rewrite the failing field to `**Verification:** {kept-files-that-passed}` (drop the unrelated ones). If every file failed, replace the field with `**Verification:** audit pending — see `documentation/.doc-coverage.md`` and append an audit-pending entry naming the section. Never silently keep a misleading citation.

### Pass 9 — Implements-vs-AC cross-walk

For every `**Implements:** REQ-X-NNN` (or `REQ-X-NNN AC N`) field in a doc section, read the linked REQ's Intent and AC bullets from `sdd/{domain}.md` and classify the doc section's relationship to that REQ. The agent makes the call by reading both sides:

| Classification | Severity | Auto-fix |
|---|---|---|
| (a) Section describes a specific AC's behavior, and the linked AC matches | (no finding) | Accept. |
| (b) Section describes generic REQ context (intent paragraph, cross-cutting behavior), not a specific AC, and the field cites the REQ without an AC suffix | (no finding) | Accept (the bare-REQ form is the correct shape for cross-AC context). |
| (b') Section describes generic REQ context but the field cites a specific AC (`REQ-X-NNN AC N`) | MEDIUM `implements-field-too-narrow` | Strip the AC suffix; cite the REQ alone. |
| (c) Section describes behavior outside every AC of the linked REQ | HIGH `implements-field-mismatched` | Replace cited REQ with the better-matching REQ ID if the agent can identify one; otherwise mark `audit pending` and log to `.doc-coverage.md`. |

If the agent is uncertain — multiple ACs plausibly match, or the section straddles AC and Intent — it emits MEDIUM `implements-field-low-confidence` rather than auto-rewriting. HIGH `implements-field-mismatched` (case c) is reserved for cases the agent is confident are mismatches. The rule of thumb: under-flag rather than over-rewrite.

### Pass 10 — Stale code-block detection

For every fenced code block, `**Path:** /api/foo`-style field, function signature in body prose, and JSON shape example in `documentation/`, locate the matching source artifact via the project's `src_globs` (from `sdd/config.yml`) and compute a structural diff. The pass runs four sub-checks per artifact:

1. **Route paths**: any `**Path:** /api/foo` or fenced block whose first line is an HTTP method + path. Resolve via filename convention (`src/pages/api/foo*.ts`, `src/routes/foo.ts`, `app/api/foo/route.ts`, framework equivalents). HIGH finding `route-not-in-source` if no handler resolves; MEDIUM `route-handler-renamed` if a near-match exists at a sibling path.
2. **Function signatures**: any `function fooBar(...)`, `export function fooBar(...)`, or `fooBar(...): Foo` in body prose or fenced TS/JS blocks. Resolve via `src/**` grep for the exported symbol. MEDIUM finding `function-signature-drift` if found but with different parameter count or type list. HIGH finding `function-removed` if the symbol no longer exports.
3. **JSON shape examples**: any fenced ```json block paired with a `**Response:**` or `**Request:**` field. If a TS type matches the section (by name match against `src/types/**` or `src/**.types.ts`), compare top-level keys. MEDIUM finding `json-example-shape-drift` listing missing/extra keys. If a fixture exists at `tests/fixtures/{normalized-name}.json`, prefer the fixture over the example.
4. **Env var references**: any `**Variable:** FOO_BAR` or fenced `env.FOO_BAR` usage. Grep `src/**` for the symbol. HIGH finding `env-var-removed-from-source` if no consumer found.

Severity: HIGH for route-not-in-source / function-removed / env-var-removed-from-source; MEDIUM otherwise. Auto-fix in `auto`/`unleashed`: for shape-drift, regenerate the example from the resolved source artifact (read the route handler's return-type, the function's signature, the JSON type's keys) and replace the block. Never delete a stale block silently — replace or flag, never drop.

### Pass 11 — Content-preservation on trim

When doc-updater (in `auto` or `unleashed` mode) proposes a Pass 1 trim — shortening a bullet to fit the 40-word cap, a paragraph to fit the 120-word cap, or a cell to fit the 50-word cap — the agent must run a content-preservation check on the proposed trim **before committing it**:

1. Tokenize the **removed** content clause-by-clause (split on semicolons, conjunctions, comma-separated enumerations).
2. For each removed clause, check whether its content tokens reappear in: the kept body of the same bullet, the surrounding prose paragraphs (same `##`/`###` section), the parent section's `**Rationale:**` / `**Consequences:**` / `**Context:**` fields, or — when a linked ADR exists — the ADR body.
3. A removed clause whose content tokens have no match anywhere is "context-loss" — typically a load-bearing example or a constraint that gave the bullet its meaning.

Three outcomes:

- **All removed clauses match elsewhere**: trim commits as-is.
- **Some clauses are context-loss but a natural relocation exists** (an adjacent `**Rationale:**` paragraph, an ADR body, a parent section's prose): the agent promotes the clause — appends it to the relocation target with a leading marker `Trimmed from <bullet/section> on <date>:` — and then commits the trim. The agent's commit body lists `trimmed N clauses; preserved K in-place; promoted M to {target}`.
- **Clauses are context-loss with no relocation target**: the trim is REVERTED. The agent leaves the over-cap bullet in place and emits MEDIUM finding `trim-would-lose-load-bearing-content` listing the bullet location and the at-risk clauses. The cap is violated, but the content is preserved — the operator decides whether to split the bullet, promote inline, or write an ADR.

The agent decides "context-loss" by reading both the removed text and the candidate kept locations. A clause is context-loss when its specific subject (the function name, the constraint, the example) does not appear in any of the candidate locations. A clause is safe to drop when its content is paraphrased or restated nearby.

Severity: MEDIUM as a finding on the auto-trim itself when the revert path fires. No finding when promotion succeeds (the agent's commit body is the audit trail).

### Pass 12 — Stranger cold-read

For each top-level canonical file in `documentation/`, dispatch a fresh subagent (`general-purpose` subtype, **not** `doc-updater` — must come in cold with no project context) with: (i) only the contents of the one doc file, (ii) a simulated task the file is supposed to answer. The default task registry:

| File | Simulated task |
|---|---|
| `api-reference.md` | "Call the most-used public endpoint and parse the response. Output the exact curl command plus the field list you'd extract from a successful response." |
| `api-reference-admin.md` | "Manually trigger a backend job listed in this file. Output the exact request (method, path, headers, body) and the specific success signal the operator looks for." |
| `architecture.md` | "Find the source file that owns request authentication for admin endpoints. Output the path. If the doc points elsewhere, say where." |
| `configuration.md` | "List every env var the dev-bypass code path consumes. Output: name, type, default, where it's consumed." |
| `deployment.md` | "Roll back the last production deploy. Output the exact commands in order, including any verification commands between steps." |
| `security.md` | "An external researcher claims the session cookie is readable from JavaScript on the production site. Refute or confirm using only the doc; output the load-bearing sentence." |
| `troubleshooting.md` | "A user reports the page returns 500 after login. Output the first three diagnostic steps from the doc." |
| `decisions/README.md` | "Why was the most recent ADR raised? Output the ADR ID and the one-line reason." |

The subagent reports one of three outcomes per file: `succeeded` (task completed using only the doc), `partial` (some sub-question answered, others required guessing), `failed` (the doc lacks the load-bearing information). Partial and failed outcomes each produce a MEDIUM finding `stranger-cold-read-gap` naming the specific information the doc failed to surface — typically the load-bearing path, the exact command, the field name, or the one-line constraint that decides the task.

The task list is project-overridable via `documentation/.cold-read-tasks.yml` (per-file: `simulated_task: "..."`). Files not in the registry skip Pass 12. The pass runs at most once per PR-boundary trigger (caches results on commit SHA + file mtime).

Severity: MEDIUM. No auto-fix — this pass is a signal, not a corrector. doc-updater writes the per-file gap report to `documentation/.doc-coverage.md` under a `## Cold-read gaps` heading and surfaces it to the operator. This is the only pass in the framework that answers "is this doc actually usable?" — every other pass answers a structural question.

## Severity classification on doc findings

| Severity | Definition |
|---|---|
| **CRITICAL** | Doc claims behavior that contradicts shipped code in a way that would mislead a developer into a security/data-loss mistake (e.g., "tokens are HttpOnly" when they aren't) |
| **HIGH** | Implementation-prose paragraph with no corresponding REQ; dual-narrative ADR; doc references removed function/file/route; file >2× soft budget |
| **MEDIUM** | Lane violation; cell >50 words; file 1×–2× soft budget; missing REQ backlink for documented feature; ADR missing Status field |
| **LOW** | Cell 40-50 words; file 0.8×–1× soft budget (approaching); inconsistent heading capitalization; broken intra-doc anchor link |

Mode-dependent action mirrors spec-reviewer's table in `spec-discipline.md`:

- `interactive`: confirm before applying any finding's fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW to `/sdd clean`
- `unleashed`: auto-fix everything including LOW, on the current branch

## REQ backlinks in documentation/

Every documented feature should reference the REQ that specifies it. Backlinks let readers cross from operational reference into product intent without searching.

**Format**: inline `(REQ-X-NNN)` immediately after the feature's name in a heading or first sentence of a section.

```markdown
## Inquiry email delivery (REQ-API-002)

The `/api/inquiry` endpoint…
```

doc-updater scans every section heading and first paragraph for likely-feature content. If a section describes a feature with a matching REQ in `sdd/` but lacks a backlink, emit a MEDIUM finding and auto-insert in `auto` and `unleashed` modes.

## Working tree and branch safety

Same rules as spec-reviewer (see `spec-discipline.md` "Working tree and branch safety"):

1. Working tree must be clean before any agent-driven write
2. In `auto` and `unleashed` modes, push to whatever branch is currently checked out; user is responsible for checking out the right branch first

## Files that live alongside `documentation/`

| File | Committed to git | Purpose |
|---|---|---|
| `documentation/decisions/README.md` | Yes | ADR index — auto-maintained by doc-updater |
| `documentation/.doc-coverage.md` | Yes | Output of doc-updater coverage runs and Pass 4 proposed-move plans |
| `documentation/.review-needed.md` | Yes | Doc findings escalated for human review |

Nothing in `documentation/` is gitignored.
