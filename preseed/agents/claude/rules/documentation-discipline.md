# Documentation Discipline (SDD-Bootstrapped Projects)

Sibling rule file to `spec-discipline.md`. Applies whenever a project has both an `sdd/` folder AND a `documentation/` folder. If `documentation/` does not exist in the project, these rules are inert — ignore them.

The `doc-updater` agent enforces this file. The `spec-reviewer` agent does not touch `documentation/` but may reference these rules when explaining lane violations.

## What documentation is

`documentation/` is the **how** layer of the project: how things are wired, what env vars exist, what HTTP routes return, where files live, why a particular technology was chosen. It is not the spec (that's `sdd/`), not the changelog (that's `sdd/changes.md`), not the README (that's the project tagline + getting-started).

The reader of `documentation/` is a developer who already knows what the product does and now needs to navigate the implementation. Every page should answer one operational question quickly.

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
| `documentation/architecture.md` | 350 lines | LOW (350-500) / MEDIUM (500-800) / HIGH (>800) |
| `documentation/api-reference.md` | 600 lines | LOW (600-1000) / MEDIUM (1000-1500) / HIGH (>1500) |
| `documentation/configuration.md` | 200 lines | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/deployment.md` | 200 lines | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/security.md` | 250 lines | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |
| `documentation/troubleshooting.md` | 300 lines | LOW (300-500) / MEDIUM (500-800) / HIGH (>800) |
| `documentation/decisions/<adr>.md` | 100 lines per ADR | LOW (100-150) / MEDIUM (150-250) / HIGH (>250) |
| Other files in `documentation/` | 250 lines | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |

A file may opt out of length warnings with an HTML comment near the top: `<!-- doc-allow-large -->`. Use sparingly and only for genuinely complex references whose full surface needs to live in one place (e.g., a complete OpenAPI dump).

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

## Enforcement passes (run by doc-updater)

doc-updater runs four passes on every PR-boundary trigger:

### Pass 1 — Per-element budget enforcement

Walks each `documentation/*.md` file and applies every cap from the per-element table above:

- **Table cells**: count words in each cell; flag cells over 50 words as MEDIUM with a suggested rewrite (extract the long content to a body paragraph below the table and replace the cell with a one-line summary plus a link).
- **List items**: count words in each `-`/`*`/numbered list bullet; flag items over 40 words as MEDIUM (split into multiple bullets or promote to body prose).
- **Code snippets**: count lines inside fenced code blocks; flag blocks over 15 lines as MEDIUM (link to source file with line range instead).
- **Heading nesting**: track the deepest `#` count; flag any heading at level 5+ as LOW (promote section to a sibling page).
- **Single paragraphs**: count words between blank lines outside code fences; flag paragraphs over 120 words as LOW (break for emphasis — walls of prose hide the load-bearing sentence).

### Pass 2 — File-level budget enforcement

For each file in `documentation/`, count lines (excluding blank lines and code fences). Apply the budget table above. If a file is over its budget AND lacks `<!-- doc-allow-large -->`, emit a finding at the severity tier.

In `auto` and `unleashed` modes, doc-updater proposes a split: identifies natural section boundaries (top-level `##` headings) and writes a new sibling file with a redirect pointer in the original. The split is committed as `[doc-updater] split: filename.md → filename-{section}.md`.

### Pass 3 — Implementation-prose detection

Scan each `documentation/` file for paragraphs that read like AC text (`must`, `shall`, `ensures that`, `the system rejects`). These belong in `sdd/` not `documentation/` and signal that someone wrote intent in the wrong place. Flag as MEDIUM with the target REQ ID (or "no matching REQ" if none exists, escalating to HIGH because it indicates an unspec'd feature).

### Pass 4 — Lane-violation detection

Scan each file against its lane in the table above. If `architecture.md` contains a section titled `## API Endpoints` with route+method+status-code content, it's a lane violation — flag as MEDIUM and propose moving the section to `api-reference.md` with a backlink in `architecture.md`.

Dual-narrative ADR detection runs alongside pass 4 against `documentation/decisions/`.

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
2. In `auto` and `unleashed` modes, refuse to run on `main` or `master` without `--branch-confirmed`

## Files that live alongside `documentation/`

| File | Committed to git | Purpose |
|---|---|---|
| `documentation/decisions/README.md` | Yes | ADR index — auto-maintained by doc-updater |
| `documentation/.doc-coverage.md` | Yes | Output of doc-updater coverage runs |
| `documentation/.review-needed.md` | Yes | Doc findings escalated for human review |

Nothing in `documentation/` is gitignored.
