---
name: doc-enforce
description: SDD documentation enforcement orchestrator. Runs the 16-row execution manifest against documentation/. Detects forbidden content, per-element budget violations (per-file caps deprecated in v2.0), within-section semantic issues, authoring-quality prose (weasel, unverifiable, missing-why), REQ-backlink gaps, doc source-anchor truth (Pass 15 — always runs). Conditionally invokes doc-enforce-lanes (per file in diff), doc-enforce-shape (api-reference / canonical lane files), and doc-enforce-truth (Implemented REQ docs or scope=all). Invoked by doc-updater on every PR-boundary trigger and by /sdd clean.
version: 2.0.0
---

# Documentation Enforcement (orchestrator)

This skill is the spine for SDD documentation enforcement. It runs the 16-row execution manifest against `documentation/` and orchestrates the conditional detail skills (`doc-enforce-lanes`, `doc-enforce-shape`, `doc-enforce-truth`).

## Inputs

- `diff`: the review window the caller hands you — an incremental `<base>..<head>` range on a re-review, the base...HEAD diff on a first PR-boundary review, or the full-tree view on `scope=all`. Enforce exactly the window provided; never widen a provided incremental window back out to the full PR diff. (The diff-scoped passes operate on this window; the always-on whole-tree consistency passes still walk `documentation/` in full, as their Status note says.)
- `scope`: `all` | `diff` (default `diff`)
- `mode`: `interactive` | `auto` | `unleashed` (read from `sdd/spec/config.yml` when nested layout exists, else `sdd/config.yml` on flat layout)
- `layout`: `nested` | `flat` (auto-detected via `test -d documentation/lanes`)

**Layout-awareness.** All file globs in this skill respect the detected layout:
- Lane files: `documentation/lanes/**/*.md` (nested) OR `documentation/*.md` excluding `README.md` (flat)
- ADR ledger: `documentation/decisions/README.md` (both layouts; unchanged)
- Triage / escalation: `documentation/.doc-coverage.md` (audit accumulator, still used to record Pass 12 cold-read gaps and Pass 15 retrofit-failure entries)

## Execution contract (binding)

Every row of the manifest below MUST execute on every run. No cherry-picking; cost is never a valid skip. Manifest written FIRST with all rows `pending`, updated as each pass completes, finalised at run end. Pending rows at finalize emit HIGH `manifest-pending-at-finalize`. Status rows without concrete evidence counts emit HIGH `manifest-bare-evidence-count`. "skipped (looked clean)" is dishonest.

Audit location by trigger:
- `/sdd clean`: docs-side rows into per-category commit bodies (audit via `git log --grep='\[sdd-clean\]'`); no separate dotfile.
- PR-boundary doc-updater: docs-side manifest into the agent's commit body OR `documentation/.doc-coverage.md` (the audit accumulator; replaces the prior `.review-needed.md` on the doc lane).

## Required execution manifest

| Pass | Required action | Status |
|---|---|---|
| Pass 1 — Per-element budgets | Walk every doc file; count cell/list/snippet/heading/paragraph against caps. | `ran (K files, M findings)` |
| Pass 2 — File-level budgets | DEPRECATED — no file-level line cap. Row remains for manifest stability; status always `inert (file-level cap removed in v2.0; per-element caps in Pass 1 still apply)`. | `inert (file-level cap removed)` |
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
| Pass 15 — Doc source-anchor truth-check | Invoke `doc-enforce-truth` UNCONDITIONALLY for every lane file or ADR file in diff OR scope=all. Never gated. | `ran (D docs, A anchors verified, V drift, O orphaned, U unanchored)` |
| Pass 16 — Doc index integrity | Run the mandated command in § Doc index integrity; every lane/support file under `documentation/lanes/` (flat: `documentation/*.md`) must be indexed in `documentation/README.md`, and every README link must resolve. Non-empty output = finding. Eyeballing the index is forbidden — the command is the check. | `ran (F files, M unindexed/dangling)` |

Pass 12 caches on commit SHA + file mtime. When warm, record `ran (cached, hit on SHA <sha>)`; that IS execution. Cache amortises cost across Stop hooks; never skips the pass.

## Orchestration logic

1. **Parse diff.** Identify: changed doc files, changed sections, changed prose hunks, presence of api-reference*.md or canonical lane files in diff, REQ IDs cited in diff.
2. **Always-runs rows** (Pass 1, 13, 14, 16 actively; Pass 2 always reports `inert (file-level cap removed)` as a manifest-stability stub): execute inline. Each row updates its manifest status to concrete evidence count immediately on completion. Pass 16 is a mandated *command*, not a judgment — run it verbatim and treat its output as the finding set.
3. **Conditional invocations**:
   - For every doc file touched in diff: invoke `doc-enforce-lanes` (covers Pass 3 + Pass 4).
   - IF `documentation/lanes/api-reference*.md` (or flat `documentation/api-reference*.md`) OR any canonical lane file touched in diff OR scope=all: invoke `doc-enforce-shape` (covers Pass 5 + Pass 6 + Pass 7).
   - **Always invoke `doc-enforce-truth` Pass 15** for every lane file or `decisions/README.md` in the diff, OR any path matched by `src_globs` (from the layout-resolved config; default defined in `spec-enforce-truth/SKILL.md` § Inputs) in the diff, OR scope=all. Source-touching diffs trigger invocation because source changes can orphan existing `@impl` anchors in unchanged lane files — Pass 15 must re-validate. Source-anchor truth-check is never gated. The other passes in `doc-enforce-truth` (Pass 8, Pass 9, Pass 10, Pass 11, Pass 12) fire only when Implemented REQ docs touched OR scope=all, as before.
4. **Aggregate** findings from sub-skill invocations into the unified manifest.
5. **Apply mode**:
   - `interactive`: confirm each fix; CRITICAL/HIGH/MEDIUM blocking, LOW deferred.
   - `auto`: silently apply CRITICAL/HIGH/MEDIUM; defer LOW to `/sdd clean`.
   - `unleashed`: apply everything including LOW; per-category commits.

## Doc index integrity

The same incident class as spec-side index drift: a `documentation/README.md` whose links resolve can still omit canonical lane files or never mention support files. Mandated command, not a judgment — run it; non-empty output is the finding set.

Nested layout:

```bash
# (1) every lane/support file under documentation/lanes/ must be named in documentation/README.md
for f in documentation/lanes/*; do b=$(basename "$f"); grep -wqF -- "$b" documentation/README.md || echo "UNINDEXED: $b"; done
# (2) no dangling link: every *.md the README points at must exist
grep -oE '\]\(([^)]+\.md)\)' documentation/README.md | sed -E 's/^\]\(|\)$//g' \
  | while read -r l; do [ -f "documentation/$l" ] || [ -f "$l" ] || echo "DANGLING: $l"; done
```

Flat layout: replace `documentation/lanes/*` with `documentation/*.md` excluding `documentation/README.md`. `documentation/decisions/README.md` is the ADR ledger and is indexed as the decisions entry, not a lane.

Findings:
- Each `UNINDEXED:` line = MEDIUM `doc-index-unindexed-file`.
- Each `DANGLING:` line = MEDIUM `doc-index-dangling-link`.

Auto-fix in `auto`/`unleashed`: add each missing file to the README — lane files to the lanes index, support files to a `## Support files` section — deriving the description from the file's own H1 / first line, never inventing one. Remove dangling links to deleted files. Interactive prompts before each README edit.

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
- **Database table/column names** in `documentation/[lanes/]architecture.md` schema sections (flat or nested layout)
- **Cookie names, env var names, header names** when documenting configuration or HTTP contract
- **Code snippets** illustrating a non-obvious calling pattern (<=15 lines)

## No file-level line cap

Lane files are sized by the project they describe. A 60-file library naturally has a 60-row Source Module Map; a single-endpoint Worker has a one-row API reference. Numeric line caps mis-fit both extremes — they constrain large projects into artificial splits and offer no signal on small ones. **There is no per-file line budget in this skill.** Quality is enforced by per-element caps (Pass 1) and structural shape (Pass 6, Pass 7) instead.

`<!-- doc-allow-large: ... -->` markers and `<!-- doc-allow-element: ... -->` markers are still recognised for backward compatibility but no longer gate any finding. The latter still exempts a specific element from per-element caps in Pass 1 when present.

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

## Pass 2 — File-level budgets (DEPRECATED, no-op)

Pass 2 historically enforced numeric line caps per lane file. The cap was wrong: it constrained large projects into artificial splits while offering no signal on small ones. The cap is removed as of `doc-enforce` v2.0.

Pass 2 is preserved as a manifest row for backward compatibility with downstream tooling that reads the 15-row manifest shape; the row always reports `inert (file-level cap removed)`. Per-element caps (Pass 1) and structural-shape passes (Pass 6, Pass 7) remain authoritative.

`<!-- doc-allow-large: AD-NN ... -->` markers in existing files are silently accepted and no longer required. Removing them is a documentation cleanup task, not an enforcement need.

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
| **HIGH** | Implementation-prose paragraph with no REQ; dual-narrative ADR; doc references removed function/file/route; doc-anchor-orphaned (Pass 15); doc-value-drift (Pass 15) |
| **MEDIUM** | Lane violation; cell >50 words; missing REQ backlink; ADR missing Status; index-table ID not linked; REQ ref in non-API TOC; doc-behavior-orphaned; doc-fact-not-anchored |
| **LOW** | Cell 40-50 words; inconsistent heading capitalisation; broken intra-doc anchor link |

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW
- `unleashed`: auto-fix everything including LOW

## Output contract

Writes manifest to one of two audit locations:
- `/sdd clean` invocation: append to per-category commit bodies (audit via `git log --grep='\[sdd-clean\]'`); no separate dotfile.
- PR-boundary doc-updater: include in agent's commit body OR (if no commits) `documentation/.doc-coverage.md` as `## Execution manifest`.

Every row's status MUST carry concrete evidence counts. Bare `ran` without counts: HIGH `manifest-bare-evidence-count`. Pending rows at finalize: HIGH `manifest-pending-at-finalize`.
