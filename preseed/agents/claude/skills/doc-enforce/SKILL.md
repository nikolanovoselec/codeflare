---
name: doc-enforce
description: SDD documentation enforcement orchestrator. Runs the 14-row execution manifest against documentation/. Detects forbidden content, per-element + per-file budget violations, within-section semantic issues, authoring-quality prose (weasel, unverifiable, missing-why), REQ-backlink gaps. Conditionally invokes doc-enforce-lanes (per file in diff), doc-enforce-shape (api-reference / canonical lane files), and doc-enforce-truth (Implemented REQ docs or scope=all). Invoked by doc-updater on every PR-boundary trigger and by /sdd clean.
version: 1.0.0
---

# Documentation Enforcement (orchestrator)

This skill is the spine for SDD documentation enforcement. It runs the 14-row execution manifest against `documentation/` and orchestrates the conditional detail skills (`doc-enforce-lanes`, `doc-enforce-shape`, `doc-enforce-truth`).

## Inputs

- `diff`: git diff against base (PR-boundary triggers) OR full-tree view (scope=all)
- `scope`: `all` | `diff` (default `diff`)
- `mode`: `interactive` | `auto` | `unleashed` (read from `sdd/config.yml`)

## Execution contract (binding)

Every row of the manifest below MUST execute on every run. No cherry-picking; cost is never a valid skip. Manifest written FIRST with all rows `pending`, updated as each pass completes, finalised at run end. Pending rows at finalize emit HIGH `manifest-pending-at-finalize`. Status rows without concrete evidence counts emit HIGH `manifest-bare-evidence-count`. "skipped (looked clean)" is dishonest.

Audit location by trigger:
- `/sdd clean`: docs-side rows into `sdd/.last-clean-run.md`
- PR-boundary doc-updater: docs-side manifest into the agent's commit body OR `documentation/.review-needed.md`

## Required execution manifest

| Pass | Required action | Status |
|---|---|---|
| Pass 1 — Per-element budgets | Walk every doc file; count cell/list/snippet/heading/paragraph against caps. | `ran (K files, M findings)` |
| Pass 2 — File-level budgets | Walk every doc file; apply file-budget table; honour `doc-allow-large` markers. | `ran (K files, M findings)` |
| Pass 3 — Implementation-prose detection | Invoke `doc-enforce-lanes`. | `ran (...)` or `inert` |
| Pass 4 — Lane-violation detection | Invoke `doc-enforce-lanes`. | `ran (...)` or `inert` |
| Pass 5 — Format-template field presence | Invoke `doc-enforce-shape`. | `ran (...)` or `inert` |
| Pass 6 — File-level shape consistency | Invoke `doc-enforce-shape`. | `ran (...)` or `inert` |
| Pass 7 — Canonical per-endpoint rendering | Invoke `doc-enforce-shape`. | `ran (...)` or `inert (no api-reference*.md present)` |
| Pass 8 — Verification truth-check | Invoke `doc-enforce-truth`. | `ran (...)` or `inert` |
| Pass 9 — Implements-vs-AC cross-walk | Invoke `doc-enforce-truth`. | `ran (...)` or `inert` |
| Pass 10 — Stale code-block detection | Invoke `doc-enforce-truth`. | `ran (...)` or `inert` |
| Pass 11 — Content-preservation on trim | Invoke `doc-enforce-truth`. | `ran (...)` or `inert` |
| Pass 12 — Stranger cold-read | Invoke `doc-enforce-truth`. | `ran (T tasks, M findings)` or `ran (cached, hit on SHA <sha>)` |
| Pass 13 — Within-section semantic consistency | Walk every heading section in every `documentation/**.md`; fire 3 triggers. | `ran (K files, S sections, M findings)` |
| Pass 14 — Authoring quality (reviewer-with-a-brain) | Re-read every prose diff hunk (or every paragraph in every canonical lane file on /sdd clean --all); flag weasel, unverifiable, missing-why. | `ran (D diff hunks, W weasel, U unverifiable, Y missing-why)` |

Pass 12 caches on commit SHA + file mtime. When warm, record `ran (cached, hit on SHA <sha>)`; that IS execution. Cache amortises cost across Stop hooks; never skips the pass.

## Orchestration logic

1. **Parse diff.** Identify: changed doc files, changed sections, changed prose hunks, presence of api-reference*.md or canonical lane files in diff, REQ IDs cited in diff.
2. **Always-runs rows** (Pass 1, 2, 13, 14): execute inline. Each row updates its manifest status to concrete evidence count immediately on completion.
3. **Conditional invocations**:
   - For every doc file touched in diff: invoke `doc-enforce-lanes` (covers Pass 3 + Pass 4).
   - IF `documentation/api-reference*.md` OR any canonical lane file touched in diff OR scope=all: invoke `doc-enforce-shape` (covers Pass 5 + Pass 6 + Pass 7).
   - IF any Implemented REQ docs touched OR scope=all: invoke `doc-enforce-truth` (covers Pass 8-12).
4. **Aggregate** findings from sub-skill invocations into the unified manifest.
5. **Apply mode**:
   - `interactive`: confirm each fix; CRITICAL/HIGH/MEDIUM blocking, LOW deferred.
   - `auto`: silently apply CRITICAL/HIGH/MEDIUM; defer LOW to `/sdd clean`.
   - `unleashed`: apply everything including LOW; per-category commits.

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
| Any content that duplicates a REQ instead of cross-referencing | Backlink to REQ ID; never copy-paste |
| Big-O jargon in narrative prose | Measurable target ("p95 < 200ms") or plain-language description; else drop. Invoke `doc-enforce-lanes` for detection. |

### Allowlist (acceptable in documentation/)

- **REQ backlinks** `(REQ-API-003)`: encouraged
- **Source-file paths** next to the section they document
- **Function and class names** when documenting how to call them
- **Database table/column names** in `documentation/architecture.md` schema sections
- **Cookie names, env var names, header names** when documenting configuration or HTTP contract
- **Code snippets** illustrating a non-obvious calling pattern (<=15 lines)

## Per-file line budgets

| File | Soft budget | Severity above budget |
|---|---|---|
| `documentation/architecture.md` | 500 | LOW (500-700) / MEDIUM (700-1000) / HIGH (>1000) |
| `documentation/api-reference*.md` | 600 | LOW (600-1000) / MEDIUM (1000-1500) / HIGH (>1500) |
| `documentation/configuration.md` | 200 | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/deployment.md` | 200 | LOW (200-350) / MEDIUM (350-500) / HIGH (>500) |
| `documentation/security.md` | 250 | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |
| `documentation/troubleshooting.md` | 300 | LOW (300-500) / MEDIUM (500-800) / HIGH (>800) |
| `documentation/decisions/README.md` | No soft budget | ADR ledger; use `doc-allow-large` hatch with AD reference |
| Other files in `documentation/` | 250 | LOW (250-400) / MEDIUM (400-600) / HIGH (>600) |

**File-level exemption marker.** A `<!-- doc-allow-large: AD-NN reason -->` HTML comment in the file's preamble (after H1, before first `##`) exempts that file from its Pass 2 budget. The `AD-NN` reference is required; verified to exist. Multiple markers allowed. When marker is present but the cited ADR does NOT exist: MEDIUM `doc-allow-large-ad-missing`. Element-level markers from Pass 1 do NOT exempt from Pass 2.

## Per-element budgets

| Element | Cap |
|---|---|
| Table cell | <=50 words |
| List item | <=40 words |
| Code snippet | <=15 lines |
| Heading nesting | <=4 levels (`####`) |
| Single paragraph | <=120 words |

## Pass 1 — Per-element budget enforcement

Walk each `documentation/*.md` and apply per-element caps. Cells over 50 words: MEDIUM (extract to body prose with link). List items over 40 words: MEDIUM. Code snippets over 15 lines: MEDIUM (link to source with line range). Heading nesting at level 5+: LOW. Paragraphs over 120 words: LOW.

**Per-element exemption markers.** A `<!-- doc-allow-element: AD-NN reason -->` HTML comment on the line immediately above an element exempts that specific element from its cap. `AD-NN` reference required. The marker exempts ONLY the next element.

## Pass 2 — File-level budget enforcement

Count lines per file (excluding blank lines and code fences). Apply budget table. Emit finding at severity tier.

In `auto`/`unleashed`, doc-updater proposes a split: identify natural section boundaries (top-level `##`); write a new sibling file with a redirect pointer. Commit: `[doc-updater] split: filename.md -> filename-{section}.md`.

## Pass 13 — Within-section semantic consistency

**Scope:** every `documentation/**.md` file (lane file, ADR, runbook, index, anything). Independent of per-lane format templates. A "section" means any heading block (`##`, `###`, `####`, any depth) plus everything between that heading and the next heading of the same or shallower depth. Three triggers fire deterministically; each is MEDIUM with mechanical auto-fix.

**Trigger 1 — Duplicate field within section.** Any bolded label `**{Label}:**` appearing 2+ times as a line prefix within the same heading section is `field-duplicated-within-section`. Detection: scan the section body for lines matching `^\*\*([A-Z][A-Za-z0-9 _-]+):\*\*`; count occurrences per label; >=2 fires.

Auto-fix in `auto`/`unleashed`: same value (whitespace-normalised) in every occurrence: keep the first, delete the rest. Different values: escalate to `documentation/.review-needed.md` with both quoted.

**Trigger 2 — Hybrid shape within section.** A heading section contains BOTH (a) >=2 lines of bolded label/value pairs in the section's prefix block (before the first paragraph, table, or fenced code block), AND (b) one or more markdown tables whose column headers overlap >=2 of those bolded labels. Severity: `hybrid-shape-within-section`. The same contract is rendered twice in two shapes; duplication is the bug.

Detection: parse the section's prefix-block bolded labels; for each table in the section body, take the header row column names; if the intersection size >=2, fire.

Auto-fix in `auto`/`unleashed`: keep whichever shape dominates the file. Delete the duplicate-content side of the hybrid. Preserve only the unique columns/fields, dropping the overlapping ones.

**Trigger 3 — Repeated paragraph across sibling sections.** A normalised paragraph (collapse whitespace, lowercase, strip surrounding emphasis) appearing byte-identical in >=3 sibling sections at the same heading depth within one parent is `repeated-prose-pattern`. Identical prose copy-pasted across >=3 siblings belongs in one shared section the siblings link to.

Detection: walk every paragraph (blank-line separated, excluding fenced blocks, tables, field lines). Normalise, hash, group by sibling depth + parent. >=3 collisions across distinct siblings fires.

Auto-fix in `auto`/`unleashed`: extract to a shared anchor section in the same file. If `## Conventions`/`## Shared`/`## Common` exists, append under `### {short-label}` (4-6 content words from the paragraph's lead); otherwise create `## Conventions` immediately after the preamble. Replace each in-section occurrence with `See [{section} § {short-label}](#anchor-slug).` (<=25 words).

## Pass 14 — Authoring quality (the reviewer-with-a-brain pass)

Passes 1-13 check shape, size, and cross-references. They do not check whether the prose is correct, complete, or useful. A file can be perfectly shaped AND lying; can pass every mechanical pass AND be useless. Pass 14 is read-and-judge, not pattern-match.

Three questions, asked in order on every prose hunk:

1. **Did I weasel?** Lexical seed: `appropriately`, `as needed`, `properly`, `robust`, `handled gracefully`, `where applicable`, `if needed`, `as required`, `should` (non-normative), `may`, `might`, `typically`, `generally`, `usually` without an immediately-following numerical or behavioural anchor is a weasel. Name the specific value/behaviour or delete. "Rate-limited appropriately" -> "60/60s per IP, fail-closed". MEDIUM `prose-weasel`.

2. **Did I claim what I cannot verify?** Every prose claim about *what the code does* MUST be backed within the same paragraph by a fenced code block, a function/file path in `src_globs`, a REQ-ID backlink, or a verifiable external reference (RFC, vendor doc, ADR). "Retries up to 3 times" with no anchor is unverifiable narration. HIGH `prose-unverifiable`.

3. **Did I explain WHY?** Most sections describe what the code does. Ask: would a developer who has never seen this system understand *why* it works this way? If the why is non-obvious (hidden constraint, past incident, deliberate trade-off, vendor quirk, regulation) and is not stated, the section is incomplete. LOW `prose-missing-why`. Auto-fix: escalate to `documentation/.doc-coverage.md` under "Authoring debt".

**Scope.** Pass 14 fires on every prose diff (mechanical re-render counts too). On `/sdd clean --all` or any audit run with no defining diff, scope widens to every paragraph in every canonical lane file. A "ran (N files)" manifest count is dishonest when only diff hunks were inspected.

**Triggers are seeds for judgment.** Deny prose because after reading as a reviewer it is vague, unverifiable, or missing context. A weasel-shaped sentence concretely anchored elsewhere is fine; a sentence with no seed words but no concrete payload is not.

## REQ backlinks in documentation/

Every documented feature should reference the REQ that specifies it. Format: inline `(REQ-X-NNN)` immediately after the feature name in a heading or first sentence.

```markdown
## Inquiry email delivery (REQ-API-002)
```

Scan every section heading and first paragraph. Section describes a feature with a matching REQ in `sdd/` but lacks a backlink: MEDIUM, auto-inserted in `auto`/`unleashed`.

## Severity classification

| Severity | Definition |
|---|---|
| **CRITICAL** | Doc claims behaviour that contradicts shipped code in a security/data-loss-misleading way |
| **HIGH** | Implementation-prose paragraph with no REQ; dual-narrative ADR; doc references removed function/file/route; monolithic decisions README; file >2x soft budget |
| **MEDIUM** | Lane violation; cell >50 words; file 1x-2x budget; missing REQ backlink; ADR missing Status; index-table ID not linked; REQ ref in non-API TOC |
| **LOW** | Cell 40-50 words; file 0.8x-1x budget (approaching); inconsistent heading capitalisation; broken intra-doc anchor link |

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW
- `unleashed`: auto-fix everything including LOW

## Output contract

Writes manifest to one of two audit locations:
- `/sdd clean` invocation: append to `sdd/.last-clean-run.md` as a `## Execution manifest (docs)` section
- PR-boundary doc-updater: include in agent's commit body OR (if no commits) `documentation/.review-needed.md`

Every row's status MUST carry concrete evidence counts. Bare `ran` without counts: HIGH `manifest-bare-evidence-count`. Pending rows at finalize: HIGH `manifest-pending-at-finalize`.
