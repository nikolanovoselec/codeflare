# Spec Discipline (SDD-Bootstrapped Projects)

Applies to any project with an `sdd/` folder. Inert otherwise. Enforced by `spec-reviewer`.

Siblings: `documentation-discipline.md` (doc-updater), `tdd-discipline.md` (code-reviewer). Workflow in the `spec-driven-development` skill.

Every row in the manifest below MUST execute on every run. No cherry-picking; cost is never a valid skip. Manifest written FIRST with all rows `pending`, updated as each rule completes, finalised at run end. Pending rows at finalize → HIGH `manifest-pending-at-finalize`. Status rows without concrete evidence counts (`ran (N REQs, M findings)`) → HIGH `manifest-bare-evidence-count`. "skipped (looked clean)" is dishonest.

## What the spec is

`sdd/` is the single source of truth for **what the product does and why**. Not a record of current code, a bug tracker, or a commit changelog. Target state the product is reaching for.

## Required execution manifest

Audit location by trigger: `/sdd clean` → `sdd/.last-clean-run.md`. PR-boundary spec-reviewer → agent's commit body OR (if no commits) `sdd/.review-needed.md` as a `## Execution manifest` sub-section.

| Rule | Required action this run | Status |
|---|---|---|
| Forbidden content in REQs | Walk every Active REQ; flag banned tokens in AC/Intent. | `ran (N REQs, M findings)` |
| Status field semantics + Deprecated discipline | Walk every REQ; verify Status shape + Deprecated tombstone shape (Intent + Replaced By + Removed In + Status only). | `ran (N REQs, M findings)` |
| REQ rendering template (binding) | Walk every Active REQ; verify render shape AND that cross-reference fields render IDs as markdown anchor links. | `ran (N REQs, M findings)` |
| REQ length guidance | Walk every Active REQ; flag length tiers. | `ran (N REQs, M findings)` |
| Acceptance criteria guidance + AC granularity + REQ accretion guard | Walk every Active REQ; flag AC count > cap, multi-behaviour ACs (split-into-≥2-test-names), accretion patterns. | `ran (N REQs, K diff hunks, M findings)` |
| Actor coherence | Walk every Active REQ; flag actor-axis violations. | `ran (N REQs, M findings)` |
| Sub-bullets in ACs banned | Walk every Active REQ; flag indented list items under ACs. | `ran (N REQs, M findings)` |
| Cross-cutting concerns get their own REQ family | Walk every Active REQ; flag policy-shape ACs in feature REQs. | `ran (N REQs, M findings)` |
| Concern-boundary split | Walk every Active REQ; flag ACs spanning ≥2 sub-features regardless of AC count. | `ran (N REQs, M findings)` |
| Mechanism leakage in AC bullets | Walk every Active REQ; flag mechanism tokens against current allowlist. | `ran (N REQs, M findings)` |
| Changelog drift | Diff `sdd/changes.md` against AC-changed diff hunks. | `ran (K entries, M findings)` |
| Meta-content leakage Rule A (stub-after-extraction) | Walk every REQ; flag stub shape. | `ran (N REQs, M findings)` |
| Meta-content leakage Rule B (Notes two-shape) | Walk every Notes field; flag violations. | `ran (N Notes, M findings)` |
| Meta-content leakage Rule C (preamble edit-history) | Walk every `sdd/{domain}.md` preamble; flag edit-history prose. | `ran (K files, M findings)` |
| Test coverage and enforce_tdd | If `enforce_tdd: true`, run all three classification passes. | `ran (N REQs, M findings)` or `inert (enforce_tdd: false)` |
| CQ-1 — REQ-test truth-check | For every Implemented REQ (excluding `Verification: Manual check`), walk every test file containing the REQ ID; classify pass / Subclass A (name-only-match, AUTO-FIX rename) / Subclass B (no-coverage, owner action). | `ran (N REQs, K files, A auto-fixed, B escalated)` |
| CQ-2 — Vendor / external-interface drift | For every Implemented REQ, extract vendor/protocol tokens; grep `src_globs`; flag orphans. | `ran (N REQs, T tokens, M findings)` |
| CQ-3 — Content-preservation on shrink | On every shrink edit, run tokenisation check before committing. | `ran (K shrink ops, M findings)` or `inert (no shrink ops)` |
| Backlog re-triage | Walk every open finding in `sdd/.review-needed.md`; re-classify under current rules; auto-fix what is now mechanisable. | `ran (B items, R re-triaged, F auto-fixed, S still-escalated)` |

## Forbidden content in REQs

REQs in `sdd/{domain}.md` describe **observable behaviour**. The following NEVER appear inside a REQ AC or Intent:

| Banned | Where it goes instead |
|---|---|
| Hex color codes, CSS class names, keyframe names, viewBox values, bezier coords, animation timings, z-index | `documentation/architecture.md` or `design-system.md` |
| File paths, function names | `documentation/architecture.md` |
| Database column names (implementation-detail columns: counters, soft-delete flags, audit timestamps) | `documentation/architecture.md` |
| Cookie names | `documentation/security.md` or `authentication.md` |
| HTTP status code enumerations | `documentation/api-reference.md` |
| JSON request/response schemas, endpoint paths | `documentation/api-reference.md` |
| Env var names | `documentation/configuration.md` |
| Build-tool internals | `documentation/troubleshooting.md` |
| TypeScript code snippets, SQL queries | `documentation/architecture.md` |
| Debugging checklists | `documentation/troubleshooting.md` |
| Strikethrough text | Delete. Git history is the strikethrough. |
| "Current implementation:" / "Planned (not implemented):" branches in an AC | `pending.md` |
| Implementation TODOs | GitHub issue |

## Allowlist (acceptable in REQs)

Vendor product names (Cloudflare Access, Stripe), protocol names (OAuth 2.0, JWT, SSE), standards refs (WCAG 2.1 AA, GDPR, RFC 9116), performance targets ("p95 < 200ms"), user-facing strings in quotes (these ARE the AC), HTTP status codes when the REQ is about an error contract, env var names when in Configuration domain, DB column / KV key names when the storage shape IS the persistence contract.

`sdd/config.yml` overrides via `forbidden_content_allowlist` and `forbidden_content_overrides`.

## Deprecated REQs are tombstones

A `Status: Deprecated` REQ is a tombstone. The live contract is in the `Replaced By:` REQ.

**Required Deprecated shape (binding):**

```
### REQ-{DOMAIN}-{NNN}: {Title}

**Intent:** {one sentence stating what the deprecated feature did at the user-observable level.}

**Status:** Deprecated
**Replaced By:** REQ-X-NNN   (OR **Removed In:** YYYY-MM-DD)
```

**ACs are deleted on deprecation.** The Replaced By REQ carries the active contract; preserving old ACs duplicates contract and produces sprawl (REQ-PIPE-008 failure: 11 ACs retained on a Deprecated entry). Move still-relevant clauses into the Replaced By REQ first, then trim the deprecated entry to the four-field shape.

Still applies: `Replaced By:` OR `Removed In:` MUST be present; "Out of Scope" rule — move to README's Out-of-Scope section when no replacement AND no historical reference is needed; corrupted heading or missing Status is still a finding.

Auto-fix in `auto`/`unleashed`: trim a Deprecated REQ with body content to the four-field shape; preserved AC content appends to the Replaced By REQ's Notes as `Trimmed from {REQ-ID} on YYYY-MM-DD:`. No Replaced By → escalate.

CQ-1, CQ-2, CQ-3 skip Deprecated REQs (tests removed, vendor tokens stale, trim ≠ shrink). Corpus-walking detectors MUST check `Status: Deprecated` first; the entry is inert after tombstoning.

## Status field semantics

Every REQ has one Status value. **One word, no prose.**

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted, not yet committed |
| `Planned` | Committed, not yet built |
| `Partial` | Built but some AC unmet OR no automated verification found |
| `Implemented` | Built AND tests verify the ACs |
| `Deprecated` | Was implemented, then removed or replaced. Requires `Replaced By:` or `Removed In:`. |

`Partial` may have a `Notes:` field ≤3 sentences. No other status uses Notes (except doc-pointer — Rule B).

Status transitions: `Proposed` → `Planned` → (`Partial` ↔ `Implemented`) → `Deprecated`. Implementation tracking (SHAs, paths) belongs in `pending.md` or issues — never in Status.

`Deprecated` is for built-then-removed features, NOT for never-built ideas (those go to "Out of Scope" in the domain README). **Never delete REQs outright** — content is always moved.

## What is NOT a requirement

- **Bugs** → GitHub issues. The spec describes target state; bugs are the delta.
- **TODOs / known gaps** → `pending.md`. Status: Partial flags incompleteness; prose details go in `pending.md`.
- **Spec churn** → git history. No strikethrough or "Superseded:" annotations in spec.
- **Build environment quirks** → `documentation/troubleshooting.md`.
- **Out-of-scope ideas** → "Out of Scope" section in the domain README.

## REQ rendering template (binding)

Every Active REQ in `sdd/{domain}.md` MUST render in exactly this shape. Deviations are MEDIUM, auto-fixed by re-rendering.

```
### REQ-{DOMAIN}-{NNN}: {Title}

**Intent:** {one paragraph, 1–4 sentences. No bullets, no headings, no code blocks.}

**Applies To:** {single actor name from sdd/README.md actors table. Never "System".}

**Acceptance Criteria:**

1. {first AC, single behavioural statement, ≤150 words, no sub-bullets, no nested lists}
2. {second AC, same shape}
3. {…up to 7 maximum}

**Notes:** {OPTIONAL. Two sanctioned shapes — see Rule B.}

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-title-slug), [CON-SEC-001](constraints.md#con-sec-001-title-slug)

**Priority:** {P0 | P1 | P2 | P3}

**Dependencies:** [REQ-AUTH-002](#req-auth-002-title-slug), [REQ-AUTH-003](authentication.md#req-auth-003-title-slug)

**Verification:** {Automated test | Integration test | Manual check}

**Status:** {Proposed | Planned | Partial | Implemented | Deprecated}
```

For `Status: Deprecated`, trailing fields use the tombstone shape (Intent + Status + Replaced By / Removed In only). `Replaced By` and `Supersedes` render as links: `**Replaced By:** [REQ-PIPE-003](#req-pipe-003-title-slug)`.

**Cross-reference linking (binding).** Every `CON-*` and `REQ-*` ID inside `**Constraints:**`, `**Dependencies:**`, `**Replaced By:**`, `**Supersedes:**` MUST render as a markdown anchor link, not plain text. Form:

- Same-file REQ reference: `[REQ-X-NNN](#req-x-nnn-title-slug)`
- Other-domain REQ reference: `[REQ-X-NNN](other-domain.md#req-x-nnn-title-slug)`
- Constraint reference: `[CON-X-NNN](constraints.md#con-x-nnn-title-slug)`

Slugs follow GitHub-flavoured Markdown convention (lowercase, spaces → hyphens, punctuation stripped, full heading text). Plain-text IDs in these four fields are a MEDIUM finding `cross-reference-not-linked`, auto-fixed by rewriting to the link form. Detection: regex `\b(REQ|CON)-[A-Z]+-\d+\b` inside the four field values, outside `]( )` parentheses.

**Banned inside a REQ body:** sub-headings (`####`/`#####`), nested lists, code blocks, tables, strikethrough, "Current behaviour:" / "Previously:" branches, block quotes.

**Blank-line policy (binding):** one blank line between every labeled field — including each of the trailing-fields block (`Constraints`, `Priority`, `Dependencies`, `Verification`, `Status`). Stacking these on consecutive lines without blank-line separation collapses them into one rendered paragraph on GitHub, MEDIUM `trailing-fields-collapsed`. Closing `---` separator on its own line, preceded and followed by one blank line.

## REQ length guidance

| Length | Severity |
|---|---|
| ≤25 lines | OK |
| 26–50 lines | LOW |
| 51–100 lines | MEDIUM |
| >100 lines | HIGH |

Oversized REQs are shrunk in place first (extract implementation prose to `documentation/`); when shrinking is exhausted, split — see Splitting rules.

## Acceptance criteria

### Cap and basic shape

- Each AC is **binary pass/fail**, testable in principle.
- **AC count cap is binding.** 3-5 ACs typical. 6-7 normal for feature-rich surfaces. Beyond 7, the rule fires regardless of axis.

  | AC count | Single actor + single concern | + actor mixing OR cross-cutting concern |
  |---|---|---|
  | ≤7 | OK | Mixing rule fires regardless of count |
  | 8–10 | MEDIUM `ac-count-over-cap`. Auto-fix: attempt sibling merge, else **Splitting by sub-feature**. | HIGH — split by actor or concern. |
  | >10 | HIGH `ac-count-binding-cap-exceeded`. Auto-fix mandatory: **Splitting by sub-feature** runs even when no actor/concern axis exists. | HIGH — split immediately. |

- **No sub-bullets in ACs.** A sub-bulleted AC (`a./b./c.` or indented `-`) is conjunction-stuffing.
- Avoid "should" — use "must" or describe the observable outcome.
- Avoid vague terms ("responsive", "fast") — specify the criterion.

### Granularity — one behaviour per AC (binding)

**An AC MUST encode exactly one observable behaviour. If an AC can be split into ≥2 distinct test names, it MUST be split.** Supersedes prior word/semicolon thresholds, which under-fired on packed 50–90 word ACs.

Detection (any one signal fires the rule):

1. The AC contains ≥2 distinct verb phrases joined by `and`, `;`, `then`, or `before` where each verb has its own subject or distinct object.
2. The AC describes a transform (canonicalisation, normalisation, parsing) AND a downstream effect (idempotency, deduplication, cache hit) in one bullet.
3. A reviewer can write ≥2 test-name candidates from the AC text where each candidate exercises a distinct code path.

Binding example (REQ-PIPE-003 failure): "URLs are canonicalised by stripping utm_*, trimming trailing slashes, and removing default ports. A canonical URL already in the pool is skipped on subsequent ticks." Two behaviours — canonicalisation algorithm and idempotent re-ingestion. Auto-fix splits at the behaviour boundary; sub-rules of one canonicalisation step MAY share an AC (the rule fires on observable behaviour boundaries, not on every clause).

Severity: MEDIUM `ac-multi-behaviour`. Auto-fix in `auto`/`unleashed`: split at the behaviour boundary; preserve every clause as a separate AC. Never silently drop a clause.

### Run-on AC bullets (length safety net)

Residual safety net for single-behaviour ACs >150 words OR 3+ semicolons outside comma-separated enumerations. Ignore conjunctions inside comma lists. MEDIUM. Auto-fix: split at conjunctions, preserving every clause. Granularity fires first; this covers the over-verbose case.

### Actor coherence (one actor per REQ)

Every REQ declares a single actor in `Applies To:`. **Every AC must describe behaviour of that same actor.** When an AC describes a different actor, the REQ is incoherent at the actor level.

Detection: parse the first 8 words of each AC for an actor keyword (`user`, `admin`, `operator`, `visitor`, `guest`, role names from `sdd/README.md`). Subject differs from `Applies To:` → finding.

Severity: HIGH when 2+ ACs target a different actor. MEDIUM when 1 AC targets a different actor.

Auto-fix: split the REQ along the actor axis. The AC subjects declare the boundary mechanically — SAFE refactor, not JUDGMENT.

### Sub-bullets banned

Any indented list item (`   a.`, `   - `, `   1.`) under a numbered AC is conjunction-stuffing that bypasses the run-on rule. Each sub-bullet is an independent behaviour.

Severity: MEDIUM. Auto-fix: promote each sub-bullet to its own AC at the parent level. If the resulting count exceeds the ≤7 cap, splitting rules apply.

## Splitting

### Chain enforcement (binding)

When Granularity, Concern-boundary, or Sub-bullets fires, the agent MUST complete the chain in one auto-fix pass: granulate → check resulting AC count → if >7, run `Splitting by sub-feature` → emit sibling REQs each ≤7 ACs. Committing a granulated-but-unsplit REQ with >7 ACs is itself a HIGH finding `chain-not-completed`.

Worked outcome (REQ-PIPE-003): 8 packed multi-behaviour ACs → Granularity splits each → ~22 single-behaviour ACs → cap binds → Splitting by sub-feature clusters by content tokens → 3–4 sibling REQs each with 3–5 ACs (e.g., URL canonicalisation + idempotency, same-story merge semantics, aggregator-wrapper handling, cross-tick dedup).

Worked outcome (REQ-OPS-008): 7 multi-concern ACs → Concern-boundary detects 3 operationally distinct clusters → Splitting by sub-feature → 3 sibling REQs (phase dispatch, UI streaming, idempotency), each with 2–3 ACs.

Worked outcome (REQ-PIPE-008 Deprecated): tombstone rule trims body to 4-field shape; preserved AC clauses append to REQ-PIPE-003 Notes as `Trimmed from REQ-PIPE-008 on YYYY-MM-DD:`.

### Cross-cutting concerns get their own REQ family

Cross-cutting concerns (rate limiting, CSRF, audit logging, security headers, auth gating, caching, retry/backoff) apply across many features. When a feature REQ's ACs encode such a policy, it infects every feature REQ on that surface.

Detection: AC bullets with policy-shape language (`Every <route family> is rate-limited`, `Every response carries`, `All <verb> endpoints reject`) in a feature REQ.

Severity: MEDIUM when 1-2 policy-shape ACs appear. HIGH when policy ACs dominate (≥3 of ≤7 ACs).

Auto-fix: extract the policy ACs to a new policy REQ in the appropriate cross-cutting domain. Feature REQ keeps one AC referencing the policy REQ by ID.

**Deterministic target-domain rule (unleashed):**

| Concern keyword | Target domain file | Domain ID prefix |
|---|---|---|
| rate limit / throttle / 429 | `sdd/rate-limits.md` | `REQ-RATE-` |
| CSP / security header / CSRF policy | `sdd/security-policy.md` | `REQ-SEC-` |
| audit log / observability / metrics / tracing | existing `sdd/observability.md` (do not create new) | `REQ-OPS-` |
| cache / Cache-Control / CDN | `sdd/cache-policy.md` | `REQ-CACHE-` |
| retry / backoff / circuit breaker | `sdd/resilience.md` | `REQ-RES-` |

New domain file scaffolded with standard header. First extracted REQ gets `REQ-{PREFIX}-001`. Default catch-all when no keyword matches: `sdd/policies.md` with prefix `REQ-POL-`.

### Concern-boundary split (sub-feature trigger below the numeric cap)

A single-actor REQ whose ACs span ≥2 distinct sub-features MUST split, **regardless of AC count**. Adds a concern-boundary trigger to the existing cap-based and actor/cross-cutting axes — fires when the REQ is structurally two REQs even at ≤7 ACs.

Detection (both must hold):

1. Lexical clustering of AC first-clause subjects yields ≥2 clusters, each with ≥2 ACs.
2. The clusters describe operationally distinct sub-jobs (different verb families: e.g., one cluster verbs are about phase orchestration — `dispatches`, `transitions`, `schedules` — while another cluster verbs are about UI streaming — `renders`, `displays`, `updates`).

Severity: MEDIUM `concern-boundary-split-required`. Auto-fix in `auto`/`unleashed`: apply **Splitting by sub-feature** mechanics (see below) even though no numeric cap is tripped. The split is justified by the concern boundary, not the count.

Binding example (REQ-OPS-008 failure): 7-AC REQ where ACs 1-3 are phase dispatching, 4-5 are UI streaming, 6-7 are idempotency — three operationally distinct clusters → split into three REQs even under cap. The rule binds only when clusters are operationally distinct; a REQ where every AC is one job-to-be-done from different angles (9-AC animation REQ where every AC is a phase) is NOT a split target.

### Accretion guard (diff-level check)

The structural rules above catch a REQ that is **already** bloated. The accretion guard catches the diff that is **about to** bloat it.

Detection runs on every spec-reviewer trigger, against the diff:

1. **AC addition introducing a new actor** → HIGH regardless of count. Propose: move to the actor-appropriate REQ.
2. **AC addition introducing a cross-cutting concern** → HIGH regardless of count. Propose: extract to a cross-cutting REQ.
3. **AC addition pushing count past 7** (single-actor + single-concern) → MEDIUM `ac-count-over-cap`. Propose: sibling merge, else **Splitting by sub-feature**.
4. **AC addition pushing count past 10** → HIGH `ac-count-binding-cap-exceeded`. Split is mandatory.
5. **AC extension grows sub-bullets** → MEDIUM. Propose: promote each sub-bullet.
6. **AC extension grows past 150 words** OR **multi-behaviour added in diff** → MEDIUM. Propose: split per AC-granularity rule.

The accretion guard is fail-loud: it names the diff hunk, the violated rule, the proposed split target, and (when mechanical) the auto-fix preview.

### Splitting by actor or concern (SAFE refactor)

Splitting by **prose semantics** (rewriting Intent, re-interpreting ACs) stays under JUDGMENT. Splitting by **actor** or by **cross-cutting concern** is mechanical: the AC subject declares the boundary; resulting REQs carry the same ACs verbatim under a new header.

SAFE when ALL hold:
1. Split axis is actor OR cross-cutting concern.
2. No AC needs rewriting — each moves verbatim or with whitespace-only edits.
3. Each resulting REQ has a coherent single actor and a coherent single job.
4. Tests and doc cross-refs update by ID renaming alone.

Mechanics: original REQ ID stays with the largest coherent piece; new REQs get next free IDs (cross-cutting in the cross-cutting domain). Update all cross-refs in the same commit (REQs citing old AC numbers, `documentation/` backlinks, `sdd/changes.md`); commit body MUST include an AC-mapping table (`AUTH-001 AC 8 → AUTH-006 AC 1`). Commit: `[spec-reviewer] split: REQ-X-NNN by actor/concern → ...`. Tests NOT renamed in the same commit — substring matching keeps coverage green.

### Splitting by sub-feature (binding-cap safety net)

When AC count cap binds (>10, or 8-10 with no axis) AND no actor or cross-cutting axis exists, **Splitting by sub-feature** is the deterministic fallback. Also fires from the **Concern-boundary split** rule above when clusters are operationally distinct even at ≤7 ACs.

Cluster identification: tokenise each AC's first 12 words (stop-words stripped; content-words: nouns, verbs, named entities). Cluster greedily — two ACs share cluster when they share ≥2 content tokens (Jaccard ≥0.25). Dominant cluster (largest by AC count) keeps the original REQ ID; remaining clusters become new REQs; singleton ACs join the dominant cluster. If all ACs land in one cluster (true single-concern at high count): **median split** — ACs 1..N/2 stay; ACs N/2+1..N become a sibling REQ with `-extended` suffix, Intent copied verbatim.

Mechanics: original REQ ID stays with dominant cluster; new REQs get next free IDs in same domain. Each new REQ inherits parent's `Applies To:`, `Constraints:`, `Priority:`, `Verification:` verbatim; Intent rewritten per sub-feature; parent-child via `Dependencies:` (NOT Notes). Cross-refs update in same commit; commit body MUST include AC-mapping table. Commit: `[spec-reviewer] split: REQ-X-NNN by sub-feature → ...`. Tests NOT renamed.

SAFE when ALL hold:
1. No AC rewritten — every AC moves verbatim.
2. Each resulting REQ has ≤7 ACs.
3. Clustering boundary was identifiable OR median fallback applied.

If 1 or 2 fails, emit HIGH `sub-feature-split-cannot-mechanize`; don't edit.

## Mechanism leakage in AC bullets

An AC describes WHAT the user observes, not HOW. Move to `documentation/`: cookie attributes (`HttpOnly`, `SameSite=Lax`), vendor-prefix headers (`Cf-Access-Jwt-Assertion`), internal middleware names, HTTP method+path enumerations in non-API REQs, internal query params, cache directive strings, crypto algorithm names.

A user observes "JavaScript on the page cannot read the session token", not `HttpOnly`.

Severity: MEDIUM. Auto-fix: rewrite AC to user-observable consequence; move mechanism to the relevant `documentation/` lane file with a backlink.

## Changelog drift (no AC change → no changelog entry)

`sdd/changes.md` is a product changelog. An entry is justified only when an AC changed in a user-observable way OR a REQ was added/deprecated/moved.

Detection: for each new entry, scan the same diff for AC change in the referenced REQ. If no REQ reference OR no AC delta → drift.

Severity: LOW. Auto-fix in `unleashed`: delete the drift entry.

## Meta-content leakage (three rules)

Same failure mode at three scales — meta-content about the spec leaking into the spec. All three have deterministic detection and mechanical auto-fixes.

### Rule A — Stub REQ after cross-cutting extraction

A REQ whose entire contract is "participates in [REQ-Y-NNN]" with no observable predicate of its own is a hop, not a contract.

Detection (all four must hold):
1. REQ has ≤1 AC.
2. AC body contains a markdown link to another REQ.
3. AC body matches one of: `participates in`, `inherits`, `defined by`, `applies the policy`, `governed by`, `subject to` (case-insensitive).
4. REQ's `Dependencies:` includes that linked REQ.

Severity: MEDIUM `stub-after-extraction`. Auto-fix in `unleashed`: delete the source REQ. Surface-specific framing prepended to policy REQ Notes. Append `sdd/changes.md` entry. Update all backlinks.

Edge case: when the source REQ has an actor-specific predicate beyond the bare pointer ("auth buckets are per-IP, mutation buckets are per-user-id"), detection condition 3 fails (the AC body has more than the pointer-shape clause). Keeping the REQ is correct.

### Rule B — `Notes:` field two sanctioned shapes

| Shape | When valid | Form |
|---|---|---|
| (a) Partial-explanation | `Status: Partial` only | ≤3 sentences explaining what's unmet |
| (b) Doc-pointer | Any status | ≤2 sentences, MUST contain ≥1 markdown link to `documentation/**` or `sdd/**`, prose pattern "X is documented at [link]" |

Sibling-REQ cross-references use `Dependencies:`, NOT Notes.

Detection: Notes on non-Partial REQ without a markdown link → MEDIUM `notes-on-non-partial-without-pointer`. Notes on Partial REQ exceeding 3 sentences OR carrying mechanism tokens → MEDIUM `notes-partial-bloat`.

Auto-fix in `unleashed`: reshape to doc-pointer form if a link to `documentation/**` or `sdd/**` exists; otherwise fold content into Intent and delete Notes. For Partial-bloat: trim to ≤3 sentences. Test-name migration prose moves to `pending.md`.

### Rule C — Domain file preamble bans edit-history prose

Prose between an `sdd/{domain}.md` H1 and the first `---` separator (or first `### REQ-` heading) describes WHAT the domain is. Edit history belongs in git log and `sdd/changes.md`.

**Scope:** Rule C applies ONLY to `sdd/{domain}.md` concrete domain spec files. Does NOT apply to dotfiles, README.md, `sdd/changes.md`, `sdd/glossary.md`, `sdd/constraints.md`, `sdd/init-triage.md`, `sdd/config.yml`.

Forbidden patterns in preamble:
- ISO dates (`\d{4}-\d{2}-\d{2}`)
- Edit verbs: `refactored`, `updated`, `migrated`, `extracted from`, `moved from`, `previously contained`, `was reshaped`, `now describes`
- Rule names (`actor-coherence`, `sub-bullets-banned`, etc.)
- `^This file (was|has been)` pattern
- Self-referential framing co-occurring with above

Severity: LOW `preamble-edit-history-leakage`. Auto-fix in `unleashed`: delete offending paragraph(s). Structural-change descriptions go as a single consolidated dated entry to `sdd/changes.md`.

## Changelog discipline

`sdd/changes.md` is a **product changelog**. Strict format:
- Entries dated (`## YYYY-MM-DD`)
- Each entry ≤2 sentences, user-facing only
- No commit SHAs
- No verification-pass entries
- No entries for spec cleanup, doc corrections, format fixes
- No entries documenting agent's own operations

**When to add**: new REQ; AC changed in user-affecting way; REQ deprecated or moved to Out of Scope; auto-demote from Implemented → Partial.

**When NOT to add**: strikethrough cleanup; Status field truncation; format fixes; implementation leakage moved to docs; any change that doesn't affect what the product does.

## Spec/docs/code lane separation

| Owner | Owns | Never touches |
|---|---|---|
| `spec-reviewer` | `sdd/` | `documentation/`, source code |
| `doc-updater` | `documentation/`, root `README.md` | `sdd/`, source code |
| Other agents (code-reviewer, etc.) | source code | `sdd/`, `documentation/` |

**Sequential execution after every push**: spec-reviewer FIRST, doc-updater SECOND. Never in parallel — they race on shared filesystem state.

## Content-quality checks (CQ-1 through CQ-3)

Structural rules check shape; CQ-1..CQ-3 check that the spec says what it claims. Run on every PR-boundary trigger, after structural checks.

### CQ-1 — REQ-test truth-check

**Skip clause:** Does not fire on REQs whose `Verification:` field is `Manual check`. The REQ should carry a `Notes:` doc-pointer to where the manual checklist or runbook lives.

For every other `Implemented` REQ, walk every test file (per `test_globs`) containing the REQ ID literally. REQ-ID mention must satisfy both:

1. It appears in the name of a `describe`/`test`/`it` block — not just a code comment, not just a fixture filename.
2. At least one assertion references content that the REQ's ACs describe — by symbol, user-observable string, or named behaviour.

When neither holds, the finding splits:

**Subclass A — name-only-match (MEDIUM `req-test-name-only-match-fixable`).** Test file contains the REQ ID literally and has real assertions on AC content but no block name carries the REQ ID. Auto-fix in `auto`/`unleashed`: rename the most-relevant existing describe by appending ` / REQ-X-NNN (one-line concern)` to its title. Pick the describe whose nested `it()` blocks have strongest AC-content overlap; first-in-document-order wins on ties. No test logic changes.

**Subclass B — no-coverage (MEDIUM `req-test-name-only-match`).** No test file mentions the REQ ID at all, OR mentions are only in comments / fixture paths, OR every named block asserts unrelated behaviour. Real coverage absence. No auto-fix; escalate to `.review-needed.md`.

Classification mechanics:
1. For each Implemented REQ (excluding Manual check): grep `test_globs` for the REQ ID.
2. Zero matches → Subclass B.
3. Matches exist, walk matched files: any block name contains the REQ ID? Yes → CQ-1 passes. No → block has assertions on AC-content tokens? Yes → Subclass A. No → Subclass B.

### CQ-2 — Vendor / external-interface drift

For every allowlisted vendor/protocol token in an `Implemented` REQ's ACs, find at least one mention in source (case-insensitive, allowing variants — `cf_access` counts for `Cloudflare Access`). No source mention → MEDIUM `vendor-reference-orphaned-in-spec`.

This catches "AC mentions Stripe Checkout but the codebase removed Stripe six months ago." No auto-fix.

### CQ-3 — Content-preservation on shrink

The shrink-in-place rule and run-on AC split rule both delete content. Before committing either edit, tokenise removed clauses; for each, check whether its specific subject appears in candidate kept locations (kept REQ body, surrounding ACs, REQ Intent, target doc file).

Three outcomes:
- All removed clauses match elsewhere → commit.
- Context-loss with relocation target → promote with `Trimmed from REQ-X-NNN on YYYY-MM-DD:` marker, then commit.
- Context-loss with no target → REVERT, emit MEDIUM `shrink-would-lose-load-bearing-content`. Cap violation persists; content preserved.

## Backlog re-triage (`.review-needed.md` is not terminal state)

Without re-triage, escalated findings become permanent terminal state. Every PR-boundary trigger MUST run Backlog re-triage. Walks each open finding; three outcomes:

1. **Re-classified as auto-fixable** — the finding's category now has a deterministic auto-fix (e.g., `req-test-name-only-match` now classifies as CQ-1 Subclass A). Apply, remove from `.review-needed.md`, record `Backlog re-triage:` in `sdd/changes.md`.
2. **Still-escalated, content unchanged** — still ownership work (Subclass B, JUDGMENT with no resolution). Entry stays verbatim.
3. **Superseded** — underlying state changed (REQ deleted, test renamed, file moved). Remove with `Resolved (superseded by <state-change>):` marker in commit body.

Re-triage runs BEFORE other CQ checks this cycle so newly-fixable backlog items resolve before the structural sweep emits the same finding again.

**Format requirement for `.review-needed.md` entries:**
```
**Finding ID:** {category}-{N}  ({YYYY-MM-DD})
**Category:** req-test-name-only-match | sub-feature-split-cannot-mechanize | ...
**Affected:** REQ-X-NNN | documentation/path | tests/path
```

Older entries lacking this header re-classify as "still-escalated" and emit LOW `backlog-entry-missing-header` so the next pass can backfill. Re-triage never silently deletes an entry it can't parse.

**No re-triage during SDD transition.** When `transition: true`, the pass is `inert (transition active)`.

## Severity classification

| Severity | Definition |
|---|---|
| **CRITICAL** | Spec-vs-shipped mismatch on safety/security/billing. Real users could lose money or data. |
| **HIGH** | Spec doesn't match observable behaviour; missing REQ for shipped feature; broken dependency chain |
| **MEDIUM** | Missing AC for known edge case; unclear Intent; conflicting cross-refs; missing doc backlink |
| **LOW** | Cleanup (format, length, strikethrough, prose Status, implementation leakage in existing REQs) |

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW
- `unleashed`: auto-fix everything including LOW

## Test coverage and enforce_tdd

Every `Implemented` REQ must have at least one test file referencing its REQ ID. Both rules enforced by spec-reviewer when `enforce_tdd: true` (default).

**Test discovery** uses `test_globs` from `sdd/config.yml`. Defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright.

**Source discovery** uses `src_globs` defaulting to `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs.

**Detection is binary**: REQ ID literally in source/test file, or not. Plain substring; no parsing.

When `enforce_tdd: true`:

1. **Auto-demote**: `Implemented` REQ with no test reference → `Partial` with Notes. Changelog entry. Skip clause: `Verification: Manual check` REQs are exempt; verify Notes carries a doc-pointer to manual checklist; if missing → LOW `manual-check-missing-pointer`.
2. **Source-vs-test coverage**: `Planned`/`Partial` REQ with source but no test → HIGH; auto-promote `Planned` → `Partial` with explanatory Notes.
3. **Test quality heuristics**: AC count vs test count, tautology / empty-body / skip patterns. Quality findings produce no changelog entry.

When `enforce_tdd: false`, write `sdd/.coverage-report.md` without modifying spec.

## SDD transition state (legacy-codebase imports)

When `/sdd init` runs in Import Mode, it produces official REQs and a triage queue at `sdd/init-triage.md`. While any triage item carries `Status: open`, the project is in **SDD transition** and `sdd/config.yml` carries `transition: true`.

**During transition, the review pipeline is suspended.** No review agents fire automatically. Manually invoked agents check the gate and exit no-op: `SDD transition in progress; review suspended until triage drains.` `/sdd mode unleashed` is rejected.

**Transition gate condition** (single source of truth):

```
IN_TRANSITION = grep -q '^transition: true' sdd/config.yml
                AND test -f sdd/init-triage.md
                AND grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' sdd/init-triage.md
```

All three conditions must be true. Corrupted state (`transition: true` but no open items) → agents run normally; spec-reviewer emits HIGH asking the user to re-run closure or clear `transition: true`.

Closure commit:
1. Clears `transition: true` from `sdd/config.yml`
2. Appends closure entry to `sdd/changes.md` (accepted / corrected / lost totals)

`enforce_tdd` is NOT touched by closure. Tag closure commit `[sdd-init] transition complete`; excluded from round counter.

`sdd/init-triage.md` is owned by `/sdd init`. Preserved as audit record after queue drains.

## Commit-prefix contract (load-bearing for anti-spiral)

Anti-spiral parses commit subjects by **tag prefix**. Every agent-authored commit MUST start with one of the canonical prefixes.

**Counted as agent-authored** (contribute to round counter): `[autonomous]`, `[unleashed]`, `[spec-reviewer]`, `[doc-updater]`, `[code-reviewer]`.

**Excluded** (intentional bulk operations): `[sdd-clean]`, `[sdd-init]`, `[sdd-triage]`.

Plain commits (no prefix) are user-authored and reset the round counter. The counted/excluded sets are **closed**; introducing a new tag without adding it is a HIGH finding.

## The 2-round commit cycle limit

Spec-reviewer and doc-updater self-limit to prevent micro-fix spirals. Each agent's counter is scoped to its own lane (spec-reviewer: `sdd/**`; doc-updater: `documentation/**`).

1. `git log -3 --name-only --format="--- %H %s"`.
2. Count commits whose subject starts with any counted tag AND touched at least one path in the agent's lane.
3. ≥2 of last 3 qualify → hard stop. Write would-be findings to `sdd/.review-needed.md` and exit.
4. Counter resets when a non-agent commit lands in the lane.

Cross-cutting commits count for whichever agents own touched lanes. Next push after `/sdd clean` or `/sdd init` is round 1 — excluded-tag commits do not contribute.

## User overrides

User revert or "don't do that for this REQ" is a normal git operation. Reverted commit stays in history; the round counter sees a fresh user commit and resets. No skip-list, no ADR, no per-rule bypass.

## Modes (set via `sdd/config.yml`)

`sdd/config.yml` carries `mode` (`interactive`|`auto`|`unleashed`), `enforce_tdd` (bool), `test_globs`, optional `src_globs`, `forbidden_content_allowlist`, `forbidden_content_overrides`.

| Behavior | interactive | auto | unleashed |
|---|---|---|---|
| SAFE fixes | Confirm | Apply silently | Apply silently |
| RISKY fixes | Confirm + backup | Backup + apply | Backup + apply |
| JUDGMENT | Escalate, pause | Escalate to `.review-needed.md`, continue | Auto-resolve conservatively, continue |
| Output | Inline confirmations | Inline reports | Per-category commits |

All modes push the current branch; unleashed creates no branches or PRs. Unleashed refuses to run on `enforce_tdd: false` (no silent override).

## Conservative JUDGMENT auto-resolution (unleashed)

| JUDGMENT type | Resolution |
|---|---|
| Doc-vs-spec conflict | Mark BOTH `Partial` with conflict Notes; log to `.review-needed.md`. Never overwrite. |
| Oversized REQ refactor | Shrink → Splitting by actor/concern → Splitting by sub-feature. Cap binding. |
| Fake-Deprecated REQ (no Replaced By) | Move to README "Out of Scope". Content preserved. |
| Mass operations (>100 changes) | No cap. Per-category commits for selective revert. |
| Truly ambiguous content | Mark Partial with Notes, log to `.review-needed.md`. |

## Git diff syntax for spec-reviewer

```bash
git diff origin/main...HEAD
# or
git diff @{push}..HEAD 2>/dev/null || git diff HEAD~1..HEAD 2>/dev/null || git diff
```

## Working tree and branch safety

1. Working tree must be clean (`git status --porcelain` empty); refuse to run otherwise.
2. `auto` and `unleashed` push to whatever branch is checked out; user is responsible for the right branch.

## Files alongside `sdd/`

| File | Committed | Purpose |
|---|---|---|
| `sdd/config.yml` | Yes | Mode, enforce_tdd, test_globs, src_globs (optional), allowlists |
| `sdd/.review-needed.md` | Yes | Findings escalated for human review |
| `sdd/.review-decisions.md` | Yes | Cumulative per-finding triage history. Append-only by Phase 8 of `/review`. |
| `sdd/.coverage-report.md` | Yes | Output of `enforce_tdd: false` runs |
| `sdd/.last-clean-run.md` | Yes | Audit log of most recent `/sdd clean` run |
| `sdd/changes-archive-*.md` | Yes | Archived old changelogs |
| `sdd/init-triage.md` | Yes | Open / resolved / lost items from `/sdd init` Import Mode |

Nothing in `sdd/` is gitignored.
