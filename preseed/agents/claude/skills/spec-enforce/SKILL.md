---
name: spec-enforce
description: SDD spec enforcement orchestrator. Runs the 19-row execution manifest against the current diff (or full spec on scope=all). Detects forbidden content, REQ-shape violations, status drift, meta-leakage, changelog drift, backlog state, source-anchor truth-check (CQ-SOURCE — always runs). Conditionally invokes spec-enforce-ac (when ACs touched) and spec-enforce-truth (when Implemented or Partial REQs touched or scope=all — Partial included so CQ-SOURCE can validate anchors). Invoked by spec-reviewer on every PR-boundary trigger and by /sdd clean.
version: 2.0.0
---

# Spec Enforcement (orchestrator)

This skill is the spine for SDD spec enforcement. It runs the 19-row execution manifest against `sdd/` and orchestrates the conditional detail skills (`spec-enforce-ac`, `spec-enforce-truth`).

## Inputs

- `diff`: git diff against base (PR-boundary triggers) OR full-tree view (scope=all)
- `scope`: `all` | `diff` (default `diff`)
- `mode`: `interactive` | `auto` | `unleashed` (read from `sdd/spec/config.yml` when nested layout exists, else `sdd/config.yml` on flat layout)
- `layout`: `nested` | `flat` (auto-detected via `test -d sdd/spec`)

**Layout-awareness.** All file globs in this skill respect the detected layout:
- Spec files: `sdd/spec/**/*.md` (nested) OR `sdd/*.md` excluding `README.md` (flat)
- Config: `sdd/spec/config.yml` (nested) OR `sdd/config.yml` (flat)
- Triage / escalation: `sdd/spec/.review-queue.md` (nested) OR `sdd/.review-needed.md` (flat, legacy)

The flat layout is supported during the migration window; `/sdd clean` migrates flat → nested on demand. Both layouts coexist correctly in this skill.

## Execution contract (binding)

Every row of the manifest below MUST execute on every run. No cherry-picking; cost is never a valid skip. Manifest written FIRST with all rows `pending`, updated as each rule completes, finalised at run end. Pending rows at finalize emit HIGH `manifest-pending-at-finalize`. Status rows without concrete evidence counts (`ran (N REQs, M findings)`) emit HIGH `manifest-bare-evidence-count`. "skipped (looked clean)" is dishonest.

**In-depth, not at-a-glance (binding).** Each row is a full pass over its scope, not a spot-check. A row that reports `0 findings` is asserting it walked every REQ/file in scope and each passed — if you did not actually inspect each one, that is a dishonest `0`. On `scope=all`, "looked fine" / "appears clean" / "intentional given the feature" are not dispositions; either the item passes the rule or it is a finding.

**Every fired finding MUST be disposed of (binding).** When a rule fires at MEDIUM or HIGH, the run MUST record one of exactly three dispositions per occurrence: `auto-fixed (what)`, `escalated -> .review-queue.md (reason + blast radius)`, or — interactive mode only — `deferred to user confirmation`. Silently re-labelling a fired MEDIUM/HIGH as LOW, "soft limit", "deferred", or "by design" to avoid acting on it is itself HIGH `finding-downgraded-to-skip`. The severity in the rule table is the floor; an agent may not lower it. This rule exists because a prior run downgraded four `ac-count-over-cap` MEDIUMs (8-AC REQs) to "LOW soft-limit, never auto-fixed" and skipped them — a contract breach. If an auto-fix would itself be destructive (e.g. an AC renumber that orphans by-number cross-refs), the correct disposition is `escalated` with the blast radius, never `deferred`/`LOW`.

Audit location by trigger: `/sdd clean` writes to the per-category commit bodies (audit via `git log --grep='\[sdd-clean\]'`). PR-boundary spec-reviewer writes to the agent's commit body OR (if no commits) `sdd/spec/.review-queue.md` (nested) / `sdd/.review-needed.md` (flat, legacy) as a `## Execution manifest` sub-section.

## Required execution manifest

| Rule | Required action this run | Status |
|---|---|---|
| Forbidden content in REQs | Walk every Active REQ; flag banned tokens in AC/Intent. | `ran (N REQs, M findings)` |
| Status field semantics + Deprecated cleanup | Walk every REQ; verify Status is one of the four valid values; delete any `Status: Deprecated` entries per the deletion rule. | `ran (N REQs, M findings)` |
| REQ rendering template (binding) | Walk every Active REQ; verify render shape AND that cross-reference fields render IDs as markdown anchor links. | `ran (N REQs, M findings)` |
| REQ length guidance | Walk every Active REQ; flag length tiers. | `ran (N REQs, M findings)` |
| Acceptance criteria + AC granularity + REQ accretion guard | Invoke `spec-enforce-ac` when diff touches any AC bullet OR scope=all. | `ran (N REQs, K diff hunks, M findings)` or `inert (no AC diff)` |
| Actor coherence | Invoke `spec-enforce-ac` (same condition as above). | `ran (N REQs, M findings)` or `inert` |
| Sub-bullets in ACs banned | Invoke `spec-enforce-ac`. | `ran (N REQs, M findings)` or `inert` |
| Cross-cutting concerns get own REQ family | Invoke `spec-enforce-ac`. | `ran (N REQs, M findings)` or `inert` |
| Concern-boundary split | Invoke `spec-enforce-ac`. | `ran (N REQs, M findings)` or `inert` |
| Mechanism leakage in AC bullets | Invoke `spec-enforce-ac`. | `ran (N REQs, M findings)` or `inert` |
| Changelog drift | Diff `sdd/changes.md` against AC-changed diff hunks. | `ran (K entries, M findings)` |
| Meta-content leakage Rule A (stub-after-extraction) | Walk every REQ; flag stub shape. | `ran (N REQs, M findings)` |
| Meta-content leakage Rule B (Notes two-shape) | Walk every Notes field; flag violations. | `ran (N Notes, M findings)` |
| Meta-content leakage Rule C (preamble edit-history) | Walk every `sdd/{domain}.md` preamble; flag edit-history prose. | `ran (K files, M findings)` |
| CQ-TEST — Test-anchor coverage | Invoke `spec-enforce-truth` if `enforce_tdd: true` AND (Implemented REQs touched OR scope=all). | `ran (N REQs, M findings)` or `inert (enforce_tdd: false)` |
| CQ-SOURCE — Source-anchor truth-check | During `/sdd init`: consume both the Phase 7a verifier JSON (`.verify-anchors.json`) AND the Phase 7b enumeration-coverage verifier JSON (`.phase-7b.json`). The Phase 7a output drives anchor-orphaned / value-drift findings; the Phase 7b output drives `phase-7b-evidence-missing` / `import-mode-narrowed-scope` findings (a Phase 7b `unaccounted > 0` reported in the `[sdd-init]` commit body is itself a CRITICAL spec-side finding). Outside `/sdd init`: invoke `spec-enforce-truth` UNCONDITIONALLY when any Implemented or Partial REQ in diff OR scope=all. Never gated by `enforce_tdd`. Agent self-attestation without verifier output = CRITICAL `phase-7a-self-attestation` / `phase-7b-self-attestation` (see `sdd-init/SKILL.md` steps 7 and 8). When reading the most recent `[sdd-init]` commit body to verify the bulk-op actually ran, both the Phase 7a line (`Phase 7a verifier: parsed=...`) AND the Phase 7b line (`Phase 7b enum verifier: enumerated=...`) MUST be present; either line missing = CRITICAL `phase-7a-evidence-missing` / `phase-7b-evidence-missing`. | `ran (N REQs, A anchors verified, V drift, O orphaned, U unanchored)` |
| CQ-1, CQ-2, CQ-3 | Invoke `spec-enforce-truth`. | `ran (...)` or `inert` |
| Backlog re-triage | Walk every open finding in the layout-resolved triage file (`sdd/spec/.review-queue.md` nested OR `sdd/.review-needed.md` flat legacy); re-classify under current rules; auto-fix what is now mechanisable. | `ran (B items, R re-triaged, F auto-fixed, S still-escalated)` |
| Commit-prefix + 5-round limit | Check last 6 commits; halt if 5+ counted-tag commits in lane. | `ran (6 commits inspected, M findings)` |

## Orchestration logic

1. **Parse diff.** Identify: changed REQs, changed files, changed AC bullets, REQ ID set in diff, Status field changes, `sdd/changes.md` deltas.
2. **Always-runs rows** (the 10 inline rows in the manifest above — Forbidden content, Status field semantics, REQ rendering, REQ length, Changelog drift, the three Meta-content leakage rules, Backlog re-triage, Commit-prefix + 5-round limit): execute inline. Each row updates its manifest status to `ran (N REQs, M findings)` immediately on completion. The remaining 9 rows invoke `spec-enforce-ac` (6 rows: AC granularity, actor coherence, sub-bullets, cross-cutting, concern-boundary, mechanism leakage) or `spec-enforce-truth` (3 rows: CQ-TEST, CQ-SOURCE, CQ-1/2/3) per the conditional rules below.
3. **Conditional invocations**:
   - IF any AC bullet line changed in diff OR scope=all: invoke `spec-enforce-ac` skill with the diff + scope + mode.
   - IF any REQ with `Status: Implemented` or `Status: Partial` is in the diff, OR any path matched by `src_globs` (from the layout-resolved config; default defined in `spec-enforce-truth/SKILL.md` § Inputs) is in the diff, OR scope=all: invoke `spec-enforce-truth` skill with the diff + scope + mode. Source-touching diffs trigger invocation because source changes can orphan existing `@impl` anchors in unchanged REQs — CQ-SOURCE must re-validate. Partial REQs are included because they may carry source anchors that can drift, and CQ-SOURCE must run wherever an anchor exists (Truth guarantee is never gated). The skill itself decides per-pass which REQs each pass applies to (CQ-TEST only fires on Implemented when `enforce_tdd: true`; CQ-SOURCE fires on every REQ whose `@impl` anchors target the changed source OR every Implemented/Partial REQ on `scope=all`).
4. **Aggregate** findings from sub-skill invocations into the unified manifest. Each sub-skill returns its own evidence rows.
5. **Apply mode**:
   - `interactive`: confirm each fix; CRITICAL/HIGH/MEDIUM blocking, LOW deferred.
   - `auto`: silently apply CRITICAL/HIGH/MEDIUM; defer LOW to `/sdd clean`.
   - `unleashed`: apply everything including LOW; per-category commits.
6. **Write manifest** to audit location with final statuses + per-row evidence counts.

## Forbidden content in REQs

REQs in `sdd/{domain}.md` describe **observable behaviour**. The following NEVER appear inside a REQ AC or Intent:

Lane file paths below use the form `documentation/[lanes/]<name>.md` because projects use either flat (`documentation/<name>.md`) or nested (`documentation/lanes/<name>.md`) layouts. Resolve to whichever exists in the target project.

| Banned | Where it goes instead |
|---|---|
| Hex color codes, CSS class names, keyframe names, viewBox values, bezier coords, animation timings, z-index | `documentation/[lanes/]architecture.md` or `design-system.md` |
| File paths, function names | `documentation/[lanes/]architecture.md` |
| Database column names (implementation-detail columns) | `documentation/[lanes/]architecture.md` |
| Cookie names | `documentation/[lanes/]security.md` or `authentication.md` |
| HTTP status code enumerations | `documentation/[lanes/]api-reference.md` |
| JSON request/response schemas, endpoint paths | `documentation/[lanes/]api-reference.md` |
| Env var names | `documentation/[lanes/]configuration.md` |
| Build-tool internals | `documentation/[lanes/]troubleshooting.md` |
| TypeScript code snippets, SQL queries | `documentation/[lanes/]architecture.md` |
| Debugging checklists | `documentation/[lanes/]troubleshooting.md` |
| Strikethrough text | Delete. Git history is the strikethrough. |
| "Current implementation:" / "Planned (not implemented):" branches in an AC | `pending.md` |
| Implementation TODOs | GitHub issue |

### Allowlist (acceptable in REQs)

Vendor product names (Cloudflare Access, Stripe), protocol names (OAuth 2.0, JWT, SSE), standards refs (WCAG 2.1 AA, GDPR, RFC 9116), performance targets ("p95 < 200ms"), user-facing strings in quotes (these ARE the AC), HTTP status codes when the REQ is about an error contract, env var names when in Configuration domain, DB column / KV key names when the storage shape IS the persistence contract.

`sdd/config.yml` overrides via `forbidden_content_allowlist` and `forbidden_content_overrides`.

## Deprecated REQs are deleted

When a REQ stops being the contract — feature removed, replaced by another REQ, scope dropped — delete it from `sdd/{domain}.md` entirely. Do not mark `Status: Deprecated`, do not keep a tombstone, do not preserve old ACs. Git log is the history.

If a successor REQ carries the new contract, the successor stands on its own — no `Replaced By:` field, no AC migration. Any clauses worth keeping are folded into the successor's ACs before the source REQ is deleted, in the same commit.

If no successor exists and the idea should be remembered as not-built, move a one-line summary into the domain README's "Out of Scope" section, then delete the REQ.

Auto-fix in `auto`/`unleashed`: detect `Status: Deprecated` REQs and delete them; if `Replaced By:` was set, fold any AC clauses not already covered into the successor first; append a `sdd/changes.md` entry naming the deleted REQ and successor (if any). No successor and no Out-of-Scope candidacy: escalate to `.review-needed.md` rather than delete blind.

## REQ rendering template (binding)

**Canonical shape: `spec-driven-development/references/templates/req-shape-example.md`.** That fixture is the single source of truth for REQ rendering. Every Active REQ in `sdd/{domain}.md` (flat layout) or `sdd/spec/{domain}.md` (nested layout) MUST copy its shape exactly. Deviations from any rule below are MEDIUM, auto-fixed by re-rendering.

**Rules walked by this row (single normative list):**

- **Heading**: `### REQ-{DOMAIN}-{NNN}: {Title}` (H3, never H2).
- **Field order is locked**: Intent → Applies To → Acceptance Criteria → Notes (optional) → Constraints → Priority → Dependencies → Verification → Status. Status is ALWAYS the last field. Out-of-order fields = MEDIUM `req-field-order-violation`.
- **Required fields** present in every REQ: Intent, Applies To, Acceptance Criteria, Constraints, Priority, Dependencies, Verification, Status. Missing field = MEDIUM `req-missing-required-field`.
- **Empty Constraints/Dependencies render the literal `None.`** (with trailing period). Omitting the field entirely is a `req-missing-required-field` violation, NOT a no-op.
- **Cross-reference linking**: Every `CON-*` and `REQ-*` ID inside `**Constraints:**` and `**Dependencies:**` MUST render as a markdown anchor link. Same-file REQ: `[REQ-X-NNN](#req-x-nnn-title-slug)`. Other-domain REQ: `[REQ-X-NNN](other-domain.md#req-x-nnn-title-slug)`. Constraint: `[CON-X-NNN](constraints.md#con-x-nnn-title-slug)`. Slugs follow GFM convention. Plain-text IDs in these fields = MEDIUM `cross-reference-not-linked`. Detection: regex `\b(REQ|CON)-[A-Z]+-\d+\b` inside the field values, outside `]( )` parentheses.
- **Blank-line policy**: one blank line between every `**Field:**` line, including each member of the trailing-fields block (Constraints, Priority, Dependencies, Verification, Status). Two label lines on consecutive lines collapse on GitHub render = MEDIUM `trailing-fields-collapsed`. Closing `---` separator on its own line, blank lines either side.
- **AC numbering**: ACs are numbered (`1. 2. 3.`), never bulleted (`-`) = MEDIUM `ac-bullets-not-numbered`. Maximum 7 ACs per REQ.
- **Source anchors**: Every AC describing observable behaviour ends with `<!-- @impl: <path>::<symbol> -->`. ACs asserting a concrete value use `<!-- @impl: <path>::<symbol> = <value-pattern> -->`. Anchor absent on an AC = MEDIUM `ac-missing-source-anchor` (Manual-check REQs exempt).
- **Banned inside a REQ body**: sub-headings (`####`/`#####`), nested lists, code blocks, tables, strikethrough, "Current behaviour:" / "Previously:" branches, block quotes.

Auto-fix in `auto`/`unleashed`: re-render the REQ from its parsed fields into the canonical shape (inserts blank lines, renumbers ACs, reorders fields, rewrites cross-refs as anchor links, fills `None.` on empty Constraints/Dependencies). Interactive mode prompts before each rewrite. If a required field cannot be inferred from existing content (e.g. `Applies To:` was never written), escalate to triage rather than fabricate.

## REQ length guidance

| Length | Severity |
|---|---|
| <=25 lines | OK |
| 26-50 lines | LOW |
| 51-100 lines | MEDIUM |
| >100 lines | HIGH |

Oversized REQs are shrunk in place first (extract implementation prose to `documentation/`); when shrinking is exhausted, split. The split mechanics live in `spec-enforce-ac`.

## Status field semantics — transitions and auto-fix

Status transitions: `Proposed` -> `Planned` -> (`Partial` <-> `Implemented`). When a REQ stops being the contract, it is deleted (see Deprecated rule above). Implementation tracking (SHAs, paths) belongs in `pending.md` or issues, never in Status.

`Partial` may have a `Notes:` field <=3 sentences. No other status uses Notes (except doc-pointer per Rule B). Out-of-scope ideas go to "Out of Scope" in the domain README, not to a `Deprecated` Status.

Auto-fix: invalid Status values (e.g. `Done`, `WIP`, prose) get rewritten to the nearest valid value based on commit history / test coverage. `Deprecated` triggers the deletion auto-fix above.

## Changelog drift

`sdd/changes.md` is a product changelog. An entry is justified only when an AC changed in a user-observable way OR a REQ was added/deprecated/moved.

Detection: for each new entry, scan the same diff for AC change in the referenced REQ. If no REQ reference OR no AC delta: drift.

Severity: LOW. Auto-fix in `unleashed`: delete the drift entry.

## Changelog discipline

`sdd/changes.md` is a **product changelog**. Strict format:
- Entries dated (`## YYYY-MM-DD`)
- Each entry <=2 sentences, user-facing only
- No commit SHAs
- No verification-pass entries
- No entries for spec cleanup, doc corrections, format fixes
- No entries documenting agent's own operations

**When to add**: new REQ; AC changed in user-affecting way; REQ deprecated or moved to Out of Scope; auto-demote from Implemented -> Partial.

**When NOT to add**: strikethrough cleanup; Status field truncation; format fixes; implementation leakage moved to docs; any change that doesn't affect what the product does.

## Meta-content leakage (three rules)

Same failure mode at three scales: meta-content about the spec leaking into the spec.

### Rule A — Stub REQ after cross-cutting extraction

A REQ whose entire contract is "participates in [REQ-Y-NNN]" with no observable predicate of its own is a hop, not a contract.

Detection (all four must hold):
1. REQ has <=1 AC.
2. AC body contains a markdown link to another REQ.
3. AC body matches one of: `participates in`, `inherits`, `defined by`, `applies the policy`, `governed by`, `subject to` (case-insensitive).
4. REQ's `Dependencies:` includes that linked REQ.

Severity: MEDIUM `stub-after-extraction`. Auto-fix in `unleashed`: delete the source REQ. Surface-specific framing prepended to policy REQ Notes. Append `sdd/changes.md` entry. Update all backlinks.

Edge case: when the source REQ has an actor-specific predicate beyond the bare pointer ("auth buckets are per-IP, mutation buckets are per-user-id"), detection condition 3 fails. Keeping the REQ is correct.

### Rule B — `Notes:` field two sanctioned shapes

| Shape | When valid | Form |
|---|---|---|
| (a) Partial-explanation | `Status: Partial` only | <=3 sentences explaining what's unmet. No mechanism tokens (file paths, function names, env vars, commit SHAs) - those go in `pending.md` or `documentation/`. |
| (b) Doc-pointer | Any status | <=2 sentences, MUST contain >=1 markdown link to `documentation/**` or `sdd/**`, prose pattern "X is documented at [link]" |

Sibling-REQ cross-references use `Dependencies:`, NOT Notes.

Detection: Notes on non-Partial REQ without a markdown link: MEDIUM `notes-on-non-partial-without-pointer`. Notes on Partial REQ exceeding 3 sentences OR carrying mechanism tokens: MEDIUM `notes-partial-bloat`.

Auto-fix in `unleashed`: reshape to doc-pointer form if a link to `documentation/**` or `sdd/**` exists; otherwise fold content into Intent and delete Notes. For Partial-bloat: trim to <=3 sentences. Test-name migration prose moves to `pending.md`.

### Rule C — Domain file preamble bans edit-history prose

Prose between an `sdd/{domain}.md` H1 and the first `---` separator (or first `### REQ-` heading) describes WHAT the domain is. Edit history belongs in git log and `sdd/changes.md`.

**Scope:** Rule C applies ONLY to `sdd/{domain}.md` concrete domain spec files. Does NOT apply to dotfiles, README.md, `sdd/changes.md`, `sdd/glossary.md`, `sdd/constraints.md`, `sdd/.init-triage.md`, `sdd/config.yml`.

Forbidden patterns in preamble:
- ISO dates (`\d{4}-\d{2}-\d{2}`)
- Edit verbs: `refactored`, `updated`, `migrated`, `extracted from`, `moved from`, `previously contained`, `was reshaped`, `now describes`
- Rule names (`actor-coherence`, `sub-bullets-banned`, etc.)
- `^This file (was|has been)` pattern
- Self-referential framing co-occurring with above

Severity: LOW `preamble-edit-history-leakage`. Auto-fix in `unleashed`: delete offending paragraph(s). Structural-change descriptions go as a single consolidated dated entry to `sdd/changes.md`.

## Backlog re-triage

Without re-triage, escalated findings become permanent terminal state. Every PR-boundary trigger MUST run Backlog re-triage. Walks each open finding in `sdd/spec/.review-queue.md` (nested) or `sdd/.review-needed.md` (flat, legacy); three outcomes:

1. **Re-classified as auto-fixable**: the finding's category now has a deterministic auto-fix. Apply, remove from triage file, record `Backlog re-triage:` in `sdd/spec/changes.md` (or `sdd/changes.md` flat).
2. **Still-escalated, content unchanged**: still ownership work. Entry stays verbatim.
3. **Superseded**: underlying state changed (REQ deleted, test renamed, file moved). Remove with `Resolved (superseded by <state-change>):` marker in commit body.

Re-triage runs BEFORE other CQ checks this cycle so newly-fixable backlog items resolve before the structural sweep emits the same finding again.

**Format requirement for triage entries:**
```
**Finding ID:** {category}-{N}  ({YYYY-MM-DD})
**Category:** req-test-name-only-match | sub-feature-split-cannot-mechanize | spec-anchor-orphaned | ...
**Affected:** REQ-X-NNN | documentation/lanes/{file}.md | tests/path
```

Older entries lacking this header re-classify as "still-escalated" and emit LOW `backlog-entry-missing-header`. The `/sdd init` scaffold placeholder `_Awaiting first finding._` (entire file body) is recognised as the empty-slot marker and does NOT trigger the finding; only entries that look like real findings but lack the header do.

**No re-triage during SDD transition.** When `transition: true`, the pass is `inert (transition active)`.

## SDD transition state (legacy-codebase imports)

When `/sdd init` runs in Import Mode, it produces official REQs and a triage queue at `sdd/.init-triage.md`. While any triage item carries `Status: open`, the project is in **SDD transition** and `sdd/config.yml` carries `transition: true`.

**Transition gate condition** (single source of truth — layout-aware):

```
CONFIG=$(test -f sdd/spec/config.yml && echo sdd/spec/config.yml || echo sdd/config.yml)
TRIAGE=$(test -f sdd/spec/.init-triage.md && echo sdd/spec/.init-triage.md || echo sdd/.init-triage.md)
IN_TRANSITION = grep -q '^transition: true' "$CONFIG"
                AND test -f "$TRIAGE"
                AND grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "$TRIAGE"
```

All three conditions must be true. Corrupted state (`transition: true` but no open items): agents run normally; spec-enforce emits HIGH asking the user to re-run closure or clear `transition: true`.

**During transition**: this skill's CQ-TEST auto-demote of Implemented -> Partial is SUPPRESSED. CQ-1 still runs but writes to `sdd/spec/.review-queue.md` (under `## Coverage gaps`) rather than mutating Status. **CQ-SOURCE is NOT suppressed during transition** — Truth guarantee runs always.

`/sdd mode unleashed` is rejected during transition. Closure commit clears `transition: true` from `sdd/spec/config.yml` (or `sdd/config.yml` flat) + appends closure entry to `sdd/spec/changes.md` (or `sdd/changes.md` flat).

## Commit-prefix contract (load-bearing for anti-spiral)

Anti-spiral parses commit subjects by **tag prefix**. Every agent-authored commit MUST start with one of the canonical prefixes.

**Counted as agent-authored** (contribute to round counter): `[autonomous]`, `[unleashed]`, `[spec-reviewer]`, `[doc-updater]`, `[code-reviewer]`.

**Excluded** (intentional bulk operations): `[sdd-clean]`, `[sdd-init]`, `[sdd-triage]`.

Plain commits (no prefix) are user-authored and reset the round counter. The counted/excluded sets are **closed**; introducing a new tag without adding it is a HIGH finding.

## The 5-round commit cycle limit

Self-limit to prevent micro-fix spirals. Counter is scoped to spec-reviewer's lane (`sdd/**`).

1. `git log -6 --name-only --format="--- %H %s"`.
2. Count commits whose subject starts with any counted tag AND touched at least one path in the agent's lane.
3. >=5 of last 6 qualify: hard stop. Write would-be findings to the layout-resolved triage file (`sdd/spec/.review-queue.md` nested OR `sdd/.review-needed.md` flat legacy) and exit.
4. Counter resets when a non-agent commit lands in the lane.

Cross-cutting commits count for whichever agents own touched lanes. Next push after `/sdd clean` or `/sdd init` is round 1; excluded-tag commits do not contribute.

## Conservative JUDGMENT auto-resolution (unleashed)

| JUDGMENT type | Resolution |
|---|---|
| Doc-vs-spec conflict | Mark BOTH `Partial` with conflict Notes; log to `.review-needed.md`. Never overwrite. |
| Oversized REQ refactor | Shrink, then invoke `spec-enforce-ac` Splitting by actor/concern, then Splitting by sub-feature. Cap binding. |
| Deprecated REQ with no successor and no Out-of-Scope candidacy | Escalate to `.review-needed.md`; do not delete blind. |
| Mass operations (>100 changes) | No cap. Per-category commits for selective revert. |
| Truly ambiguous content | Mark Partial with Notes, log to `.review-needed.md`. |

## Git diff syntax

```bash
git diff origin/main...HEAD
# or
git diff @{push}..HEAD 2>/dev/null || git diff HEAD~1..HEAD 2>/dev/null || git diff
```

## Working tree and branch safety

1. Working tree must be clean (`git status --porcelain` empty); refuse to run otherwise.
2. `auto` and `unleashed` push to whatever branch is checked out; user is responsible for the right branch.

## User overrides

User revert or "don't do that for this REQ" is a normal git operation. Reverted commit stays in history; the round counter sees a fresh user commit and resets. No skip-list, no ADR, no per-rule bypass.

## Output contract

This skill writes to one of two audit locations:

- `/sdd clean` invocation: append to the per-category commit body (audit via `git log --grep='\[sdd-clean\]'`); no separate dotfile.
- PR-boundary spec-reviewer: include in agent's commit body OR (if no commits) `sdd/spec/.review-queue.md` (nested) / `sdd/.review-needed.md` (flat, legacy) as `## Execution manifest`.

Every row's status MUST carry concrete evidence counts (`ran (N REQs, M findings)` or `inert (reason)`). Bare `ran` without counts: HIGH `manifest-bare-evidence-count`. Pending rows at finalize: HIGH `manifest-pending-at-finalize`.
