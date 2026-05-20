---
name: spec-enforce-truth
description: SDD spec content-quality / source-of-truth checks. Runs CQ-1 (REQ-test truth-check), CQ-2 (vendor / external-interface drift), CQ-3 (content-preservation on shrink), CQ-TEST (test-anchor coverage, gated by enforce_tdd), and CQ-SOURCE (source-anchor truth-check, ALWAYS runs). Invoked conditionally by spec-enforce when Implemented REQs are touched OR scope=all.
version: 2.0.0
---

# Spec Enforcement — content quality and source-of-truth

This skill checks that the spec says what it claims by cross-referencing tests and source. Invoked by `spec-enforce` (the spine) when an Implemented REQ is in the diff or when scope=all.

## Inputs

- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `enforce_tdd`: bool from `sdd/config.yml`
- `test_globs`: from `sdd/config.yml` (defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright)
- `src_globs`: from `sdd/config.yml` (defaults `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs)

## Output

Returns findings array + auto-fix actions. Writes evidence-count rows back to the spine's manifest:
- `CQ-TEST — Test-anchor coverage`: `ran (N REQs, M findings)` or `inert (enforce_tdd: false)`
- `CQ-SOURCE — Source-anchor truth-check`: `ran (N REQs, A anchors verified, V drift, O orphaned, U unanchored)` — ALWAYS runs, never inert
- `CQ-1 — REQ-test truth-check`: `ran (N REQs, K files, A auto-fixed, B escalated)`
- `CQ-2 — Vendor / external-interface drift`: `ran (N REQs, T tokens, M findings)`
- `CQ-3 — Content-preservation on shrink`: `ran (K shrink ops, M findings)` or `inert (no shrink ops)`

**Layout-awareness.** Spec file discovery uses `sdd/spec/**/*.md` when the nested layout exists (`test -d sdd/spec`); falls back to `sdd/*.md` (excluding `README.md`) on flat layout.

## CQ-1 — REQ-test truth-check

**Skip clause:** Does not fire on REQs whose `Verification:` field is `Manual check`. The REQ should carry a `Notes:` doc-pointer to where the manual checklist or runbook lives.

For every other `Implemented` REQ, walk every test file (per `test_globs`) containing the REQ ID literally. REQ-ID mention must satisfy both:

1. It appears in the name of a `describe`/`test`/`it` block; not just a code comment, not just a fixture filename.
2. At least one assertion references content that the REQ's ACs describe; by symbol, user-observable string, or named behaviour.

When neither holds, the finding splits:

**Subclass A — name-only-match (MEDIUM `req-test-name-only-match-fixable`).** Test file contains the REQ ID literally and has real assertions on AC content but no block name carries the REQ ID. Auto-fix in `auto`/`unleashed`: rename the most-relevant existing describe by appending ` / REQ-X-NNN (one-line concern)` to its title. Pick the describe whose nested `it()` blocks have strongest AC-content overlap; first-in-document-order wins on ties. No test logic changes.

**Subclass B — no-coverage (MEDIUM `req-test-name-only-match`).** No test file mentions the REQ ID at all, OR mentions are only in comments / fixture paths, OR every named block asserts unrelated behaviour. Real coverage absence. No auto-fix; escalate to `.review-needed.md`.

Classification mechanics:
1. For each Implemented REQ (excluding Manual check): grep `test_globs` for the REQ ID.
2. Zero matches: Subclass B.
3. Matches exist; walk matched files: any block name contains the REQ ID? Yes: CQ-1 passes. No: block has assertions on AC-content tokens? Yes: Subclass A. No: Subclass B.

## CQ-2 — Vendor / external-interface drift

For every allowlisted vendor/protocol token in an `Implemented` REQ's ACs, find at least one mention in source (case-insensitive, allowing variants; `cf_access` counts for `Cloudflare Access`). No source mention: MEDIUM `vendor-reference-orphaned-in-spec`.

This catches "AC mentions Stripe Checkout but the codebase removed Stripe six months ago." No auto-fix.

## CQ-3 — Content-preservation on shrink

The shrink-in-place rule and run-on AC split rule both delete content. Before committing either edit, tokenise removed clauses; for each, check whether its specific subject appears in candidate kept locations (kept REQ body, surrounding ACs, REQ Intent, target doc file).

Three outcomes:
- All removed clauses match elsewhere: commit.
- Context-loss with relocation target: promote with `Trimmed from REQ-X-NNN on YYYY-MM-DD:` marker, then commit.
- Context-loss with no target: REVERT, emit MEDIUM `shrink-would-lose-load-bearing-content`. Cap violation persists; content preserved.

## CQ-TEST — Test-anchor coverage (gated by `enforce_tdd`)

Every `Implemented` REQ must have at least one test file referencing its REQ ID. **This pass is gated by `enforce_tdd: true`** (default). When `enforce_tdd: false`, the pass writes informational entries to `sdd/spec/triage.md` (or `sdd/triage.md` flat) under a `## Coverage gaps` section but never mutates Status.

**Test discovery** uses `test_globs` from `sdd/spec/config.yml` (or `sdd/config.yml` flat). Defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright.

**Detection is binary**: REQ ID literally in test file, or not. Plain substring; no parsing.

When `enforce_tdd: true`:

1. **Auto-demote**: `Implemented` REQ with no test reference: `Partial` with Notes. Changelog entry. Skip clause: `Verification: Manual check` REQs are exempt; verify Notes carries a doc-pointer to manual checklist; if missing: LOW `manual-check-missing-pointer`.
2. **Source-vs-test coverage**: `Planned`/`Partial` REQ with source but no test: HIGH; auto-promote `Planned` to `Partial` with explanatory Notes.
3. **Test quality heuristics**: AC count vs test count, tautology / empty-body / skip patterns. Quality findings produce no changelog entry.

When `enforce_tdd: false`:

1. **Status assignment for newly-drafted REQs (Import Mode + `/sdd edit` / `/sdd add` while `enforce_tdd: false`)**: default `Implemented` when source code implements the AC AND the AC's `<!-- @impl: ... -->` anchor resolves via CQ-SOURCE. The project has opted out of test-based verification; demoting every REQ to `Partial` because tests don't reference REQ IDs would falsely brand the spec 65%+ incomplete. Each `sdd/spec/{domain}.md` file (per domain, not the top-level `sdd/README.md`) receives one footnote `_Verification: code-only (no automated coverage)._` at the bottom; per-REQ `Notes:` are NOT used for this signal.
2. **No auto-demote on existing REQs**: do not move `Implemented` → `Partial` based on test absence alone. Test-coverage findings still emit, but as informational entries in `sdd/spec/triage.md` under `## Coverage gaps`, never as Status mutations.
3. **CQ-1, CQ-2, CQ-3, CQ-SOURCE still run normally** (see below); CQ-SOURCE specifically is NEVER gated by `enforce_tdd`.

## CQ-SOURCE — Source-anchor truth-check (ALWAYS runs, never gated)

CQ-SOURCE is the framework's Truth guarantee. It verifies every spec claim against its source anchor. **This pass runs unconditionally**: both `enforce_tdd: true` and `enforce_tdd: false`; both Greenfield, Import Mode, and Resume Mode; both inside and outside SDD transition; both via `/sdd clean` and on every PR-boundary trigger. Fabrication is never permitted.

### Anchor parsing

For every `Implemented` or `Partial` REQ in `sdd/spec/**/*.md` (or `sdd/*.md` flat), scan every AC bullet for the inline source-anchor comment:

```
<!--\s*@impl:\s*([^:]+)::([^\s=]+)(?:\s*=\s*(.+?))?\s*-->
```

Capture groups: `<path>`, `<symbol>`, optional `<value-pattern>`.

Same regex applies to ADR `Context:` blocks in `documentation/decisions/README.md` (one anchor per ADR Context, immediately at end of the Context paragraph).

### Per-anchor validation

For each captured anchor:

1. **Resolve symbol.** Call `mcp__graphify__get_node(<symbol>)` against the unified graph. If graphify cannot resolve (graph absent, stale, or symbol not indexed), fall back to `Grep` against `<path>`. Symbol not resolved by either path → HIGH `spec-anchor-orphaned` listing REQ-ID, AC-N, the searched `<path>::<symbol>`. No auto-fix; escalate to `sdd/spec/triage.md`.
2. **Verify value (when `<value-pattern>` present).** Read the symbol's source body (graphify `source_location` or direct file read on the path slice). Grep for the literal `<value-pattern>`. Not found → HIGH `spec-value-drift` listing REQ-ID, AC-N, expected vs anything-found-in-symbol. No auto-fix; escalate.
3. **Verify behaviour overlap (when `<value-pattern>` absent).** Compute token overlap between the AC text (content words ≥4 chars, stopwords excluded) and the symbol body. Overlap <3 tokens → MEDIUM `spec-behavior-orphaned`. Auto-fix in `auto`/`unleashed`: attempt to find a sibling symbol with stronger overlap via `get_neighbors`; on success, rewrite the anchor; otherwise escalate.

### Unanchored AC detection

For every AC bullet without `<!-- @impl: ... -->`:

- Skip clause: `Verification: Manual check` REQs are exempt. Their behaviour cannot be source-anchored by construction.
- For other REQs: MEDIUM `ac-missing-source-anchor` listing REQ-ID, AC-N. Auto-fix in `auto`/`unleashed`: best-effort retrofit — extract symbol candidate by AC verb-phrase + Phase 5a community map; if a plausible symbol resolves AND overlap ≥3 tokens, write the anchor inline via Edit. Otherwise escalate to `sdd/spec/triage.md` with the missing-anchor recommendation.

### ADR Context anchors

ADR `Context:` blocks (in `documentation/decisions/README.md`) use the same convention. Validation identical: symbol must resolve, optional value-pattern must match. Anchor missing on an ADR with status `Accepted` → MEDIUM `adr-context-missing-source-anchor` (auto-fix similar to AC retrofit).

### CQ-SOURCE during SDD transition

Unlike CQ-TEST, CQ-SOURCE runs during `transition: true`. The Truth guarantee is the entire point of the source-evidence pass in Phase 5d; suppressing CQ-SOURCE during transition would allow fabricated Import-Mode REQs to ship unchecked. Findings during transition go to `sdd/spec/init-triage.md` (not `triage.md`) so they fold into the Resume Mode queue.

### CQ-SOURCE output

Manifest row evidence count: `ran (N REQs, A anchors verified, V drift findings, O orphaned, U unanchored)`. Never `inert`. Layout-aware (nested or flat).

## Auto-demote suppression during SDD transition

When `transition: true` in `sdd/spec/config.yml`, spec-reviewer exits no-op entirely (Phase 0b.5 in the spec-reviewer agent definition); this skill is therefore never invoked on PR-boundary triggers during transition. The suppression rule documented here describes the correct behaviour for the rare path that DOES reach this skill while transition is active — e.g. a manual `/sdd clean` invocation against the transition branch.

In that path: **CQ-TEST auto-demote is SUPPRESSED**, identical to `enforce_tdd: false` semantics. Findings write to `sdd/spec/triage.md` rather than mutating Status. Imported REQs default `Implemented` when source code implements the AC AND CQ-SOURCE confirms the anchor. **CQ-SOURCE itself is NOT suppressed** — it runs during transition exactly as outside transition. Genuinely unmet behaviour goes to `sdd/spec/init-triage.md`, not to a Partial Status that's actually false.

## Severity application

CRITICAL: never emitted by this skill.

HIGH:
- CQ-TEST `source-vs-test coverage gap` on Implemented REQ when not in transition (only when `enforce_tdd: true`).
- CQ-SOURCE `spec-anchor-orphaned` (symbol not resolved).
- CQ-SOURCE `spec-value-drift` (value-pattern not found in symbol body).

MEDIUM:
- CQ-1 Subclass A/B.
- CQ-2 vendor drift.
- CQ-3 content-loss revert.
- CQ-SOURCE `spec-behavior-orphaned` (token overlap <3).
- CQ-SOURCE `ac-missing-source-anchor` (AC has no `@impl` comment).
- CQ-SOURCE `adr-context-missing-source-anchor`.

LOW: `manual-check-missing-pointer`.

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM where mechanical (CQ-SOURCE HIGH is NOT auto-fixable — symbol orphaned or value drift requires JUDGMENT; escalate)
- `unleashed`: auto-fix everything including LOW; CQ-SOURCE HIGH still escalates to triage (Truth findings never silently rewrite)
