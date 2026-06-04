---
name: spec-enforce-ac
description: SDD spec AC quality and splitting enforcement. Runs AC granularity triggers 1-10, run-on safety net, per-AC verbosity cap, Constraints conciseness, actor coherence, sub-bullets ban, splitting by actor/sub-feature/concern, accretion guard, chain enforcement, mechanism leakage. Invoked conditionally by spec-enforce when diff touches any AC bullet OR any Constraints bullet OR scope=all.
version: 1.0.0
---

# Spec Enforcement — AC quality and splitting

This skill enforces the rules that operate on Acceptance Criteria bullets and REQ-splitting decisions. Invoked by `spec-enforce` (the spine) when the diff touches any AC bullet or when scope=all.

## Inputs

- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `layout`: `nested` | `flat` (auto-detected by parent `spec-enforce`)

**Layout-awareness.** Cross-cutting REQ extraction and new-domain scaffolding paths resolve per the detected layout:
- Nested: new domain files land in `sdd/spec/{domain}.md`
- Flat: new domain files land in `sdd/{domain}.md` (legacy)

The AC granularity rules, splitting mechanics, and accretion guard are layout-invariant; only the target file paths change.

## Output

Returns findings array + auto-fix actions (per mode). Writes evidence-count rows back to the spine's manifest:
- `Acceptance criteria + AC granularity + REQ accretion guard`: `ran (N REQs, K diff hunks, M findings)`
- `Per-AC verbosity + Constraints conciseness`: `ran (N REQs, M findings)`
- `Actor coherence`: `ran (N REQs, M findings)`
- `Sub-bullets in ACs banned`: `ran (N REQs, M findings)`
- `Cross-cutting concerns get own REQ family`: `ran (N REQs, M findings)`
- `Concern-boundary split`: `ran (N REQs, M findings)`
- `Mechanism leakage in AC bullets`: `ran (N REQs, M findings)`

## Acceptance criteria

### Cap and basic shape

- Each AC is **binary pass/fail**, testable in principle.
- **AC count cap is binding.** 3-5 ACs typical. 6-7 normal for feature-rich surfaces. Beyond 7, the rule fires regardless of axis.

  | AC count | Single actor + single concern | + actor mixing OR cross-cutting concern |
  |---|---|---|
  | <=7 | OK | Mixing rule fires regardless of count |
  | 8-10 | MEDIUM `ac-count-over-cap`. Auto-fix: attempt sibling merge, else **Splitting by sub-feature**. | HIGH - split by actor or concern. |
  | >10 | HIGH `ac-count-binding-cap-exceeded`. Auto-fix mandatory: **Splitting by sub-feature** runs even when no actor/concern axis exists. | HIGH - split immediately. |

  **AC-count is NOT the per-REQ line-length soft warning. Do not conflate them.** The "REQ length guidance" table in `spec-enforce` (`<=25` OK / `26-50` LOW / ...) measures *body line count* and is a never-auto-fixed soft warning. The AC-count cap above measures *number of ACs* and is MEDIUM/HIGH with mandatory auto-fix. A REQ with 8 ACs is `ac-count-over-cap` MEDIUM (act on it) even when its line count is in the LOW band. Reporting an 8-10-AC REQ as "LOW, soft-limit, deferred" is the conflation bug: it is itself a HIGH `ac-count-misclassified-as-deferrable`.

  **No silent downgrade.** Once `ac-count-over-cap`/`ac-count-binding-cap-exceeded` fires, the manifest MUST record, per offending REQ, the concrete action taken: `merged ACx+ACy`, `split -> REQ-..., REQ-...`, or `escalated -> .review-queue.md (reason)`. "deferred", "LOW", "soft limit", or "looked intentional" are NOT valid dispositions for a fired AC-count finding. Downgrading any fired MEDIUM/HIGH finding to LOW/deferred without one of those three dispositions is HIGH `finding-downgraded-to-skip`.

  **Cross-ref-density pre-check (binding before any merge/renumber/split).** ACs are frequently referenced by number elsewhere. BEFORE renumbering or merging ACs, grep the whole repo for by-number references to this REQ's ACs: `grep -rn "REQ-X-NNN AC[0-9]" sdd/ documentation/` PLUS the REQ's own `@test` anchor descriptions (`-> ACn`, `ACn/ACm`) and any `decisions/README.md` `ACn` mentions. Every hit is a cross-ref that a renumber breaks. A merge/split that does not rewrite ALL of them in the same commit corrupts the spec<->test<->doc graph and is forbidden. If the blast radius is large, prefer **Splitting by sub-feature** (which moves whole ACs to a new REQ ID, changing fewer numbers) over an in-place merge that renumbers the tail; record the full hit list in the commit body's AC-mapping table. A blind in-place renumber that leaves any by-number ref dangling is HIGH `ac-renumber-orphaned-crossref`.

- **No sub-bullets in ACs.** A sub-bulleted AC (`a./b./c.` or indented `-`) is conjunction-stuffing.
- Avoid "should" - use "must" or describe the observable outcome.
- Avoid vague terms ("responsive", "fast") - specify the criterion.

### Granularity — one behaviour per AC (binding)

**An AC MUST encode exactly one observable behaviour. If an AC can be split into >=2 distinct test names, it MUST be split.** Hard triggers below; any one fires the rule. Agent MUST attempt a split and only abandon when the AC encodes one behaviour with sentences 2..N as pure rationale.

1. **Sentence count >= 3** in one AC. Sentence = run ending `.`/`!`/`?` + whitespace + capital. Escape: sentences 2..N are rationale (`so`/`so that`/`because`) AND share the subject AND introduce no new contractual verb.
2. **Word count > 130** in a single-sentence AC. Split at the load-bearing conjunction.
3. **Word count > 80 AND sentence count >= 2**.
4. **Subject shift across sentences**: sentence 1 subject != sentence 2 subject. Two subjects = two enforcement sites = two ACs.
5. **Multi-site enforcement phrase**: literal tokens `applies the same`, `also applies`, `is enforced both`, `the same X defensively`. Each names >=2 sites.
6. **Tie-break or appendage after `;`**: `; among ...`, `; within ...`, `; tie-break ...`, `; with ...` attaching a new rule to a primary rule.
7. **Multi-path contract**: `regardless of (path|order|whether)` + substantive contract clause: one positive-path AC and one negative-path AC.
8. **Transform + downstream effect** in one bullet: transform (canonicalisation, normalisation, parsing, validation) AND effect (idempotency, dedup, cache hit, retry).
9. **>=2 distinct verb phrases joined by `and` / `then` / `before`** with own subjects or distinct objects (outside comma-enumerations).
10. **Reviewer can write >=2 test-name candidates** exercising distinct code paths. Borderline tiebreaker.

Binding examples:
- VALID (escape): "Articles older than 48 hours are dropped before LLM summarisation so stale items do not consume LLM budget." Sentence 2 is rationale, same subject. No split.
- INVALID (trigger 1): "Articles older than 48 hours are dropped before LLM summarisation. Candidates with no parsable date fall back to ingestion time and are kept." Sentence 2 introduces a new positive-path contract. Split.
- INVALID (trigger 4): "On settings save, any submitted tag triggers an INSERT. The discovery cron applies the same short-circuit defensively." Subject shifts; two sites. Split.

Severity: MEDIUM `ac-multi-behaviour`. Auto-fix in `auto`/`unleashed`: split at the boundary named by the firing trigger; preserve every clause; never silently drop. If post-split count exceeds 7, chain-enforcement binds Splitting by sub-feature in the same pass.

### Run-on AC bullets (length safety net)

Residual catch-net for single-behaviour ACs that slipped past triggers 1-10: >150 words OR >=3 semicolons outside comma-separated enumerations. MEDIUM `ac-run-on`. Auto-fix: split at conjunctions, preserving every clause. Granularity fires first.

### Per-AC verbosity cap (rationale belongs in Intent / changes.md / ADRs)

The granularity triggers permit a rationale tail (`so`/`because`) on a single-behaviour AC, and the run-on net only catches >150 words. Between them sits the common bloat the line-count gauge also misses: a 40-90 word AC that states one behaviour but pads it with embedded justification ("rather than X, which would...", "the SDK reads false because...", "so a Y can never be mistaken for Z"). That rationale is not contractual - it duplicates the Intent and the `sdd/changes.md` / ADR narrative, and an AC is a pass/fail assertion, not a place to explain WHY.

Detection (per AC, counting prose words only - exclude trailing `<!-- @impl/@test -->` anchors and markdown link URLs): **prose word count > 45** = MEDIUM `ac-verbose`. The rationale-tail escape from the granularity rule does NOT exempt this: an escape-qualified rationale sentence that pushes the AC past 45 words still fires `ac-verbose`.

Auto-fix in `auto`/`unleashed`: trim the AC to the bare testable assertion. The stripped rationale, if it is not already in the REQ's Intent, moves to the `sdd/changes.md` entry for the change (one sentence) or, for a design tradeoff, to the relevant ADR - never back into the AC. If the over-length came from two behaviours rather than rationale, defer to the granularity split instead. Reporting an `ac-verbose` AC as "fine / single-behaviour / acceptable" without trimming is `finding-downgraded-to-skip` (HIGH), per the no-silent-downgrade rule.

### Constraints conciseness (one terse boundary per bullet)

`**Constraints:**` bullets are boundaries (invariants, limits, and accepted-residual one-liners), NOT a place for why-narratives. The same rationale that is banned from ACs is banned here: "for the same reason X follows Y", "a DO eviction mid-shutdown would discard...", multi-sentence explanations of mechanism or history. The full rationale lives in `sdd/changes.md` and `documentation/decisions/README.md`; a Constraint may carry at most a one-clause pointer (`... (rationale in [ADxx](...))`).

Detection (per Constraints bullet, prose words excluding cross-ref link URLs):
- **bullet > 45 words** OR **>= 2 sentences** OR contains a rationale-narrative connective chaining a justification (`because`, `so that`, `for the same reason`, `rather than ... which would`, `the same ... follows`, `and for the same reason`) = MEDIUM `constraint-bloat` on that bullet.
- **any single bullet > 80 words**, OR the whole `**Constraints:**` section prose > 150 words = HIGH `constraint-section-bloat` (the paragraph-bible failure mode).

Auto-fix in `auto`/`unleashed`: reduce each bullet to its boundary statement; move the stripped rationale to the `sdd/changes.md` entry or the relevant ADR (with a one-clause pointer left in the bullet only if a reader needs the reference). Never delete a genuine boundary, only the narration around it. A Constraint that is purely narration with no boundary (pure "we tried X then Y" history) is deleted, not trimmed (that belongs in git history per `spec-driven-development` "What is NOT a requirement"). Reporting a fired `constraint-bloat`/`constraint-section-bloat` as LOW/intentional/acceptable is `finding-downgraded-to-skip` (HIGH).

Writes evidence row to the spine manifest: `Per-AC verbosity + Constraints conciseness: ran (N REQs, M findings)`.

### Actor coherence (one actor per REQ)

Every REQ declares a single actor in `Applies To:`. **Every AC must describe behaviour of that same actor.** When an AC describes a different actor, the REQ is incoherent at the actor level.

Detection: parse the first 8 words of each AC for an actor keyword (`user`, `admin`, `operator`, `visitor`, `guest`, role names from `sdd/README.md`). Subject differs from `Applies To:`: finding.

Severity: HIGH when 2+ ACs target a different actor. MEDIUM when 1 AC targets a different actor.

Auto-fix: split the REQ along the actor axis. The AC subjects declare the boundary mechanically; SAFE refactor, not JUDGMENT.

### Sub-bullets banned

Any indented list item (`   a.`, `   - `, `   1.`) under a numbered AC is conjunction-stuffing that bypasses the run-on rule. Each sub-bullet is an independent behaviour.

Severity: MEDIUM. Auto-fix: promote each sub-bullet to its own AC at the parent level. If the resulting count exceeds the <=7 cap, splitting rules apply.

## Splitting

### Chain enforcement (binding)

When Granularity, Concern-boundary, or Sub-bullets fires, the agent MUST complete the chain in one auto-fix pass: granulate, check resulting AC count, if >7 run `Splitting by sub-feature`, emit sibling REQs each <=7 ACs. Committing a granulated-but-unsplit REQ with >7 ACs is itself a HIGH finding `chain-not-completed`.

Worked outcomes:
- REQ with 8 packed ACs: Granularity yields ~22 single-behaviour ACs, cap binds, Splitting by sub-feature, 3-4 sibling REQs each with 3-5 ACs.
- REQ with 7 multi-concern ACs: Concern-boundary detects 3 operationally distinct clusters, 3 sibling REQs with 2-3 ACs each.
- Deprecated REQ deletion: clauses not already covered by successor are folded into successor in the same commit; `sdd/changes.md` records the deletion.

### Cross-cutting concerns get their own REQ family

Cross-cutting concerns (rate limiting, CSRF, audit logging, security headers, auth gating, caching, retry/backoff) apply across many features. When a feature REQ's ACs encode such a policy, it infects every feature REQ on that surface.

Detection: AC bullets with policy-shape language (`Every <route family> is rate-limited`, `Every response carries`, `All <verb> endpoints reject`) in a feature REQ.

Severity: MEDIUM when 1-2 policy-shape ACs appear. HIGH when policy ACs dominate (>=3 of <=7 ACs).

Auto-fix: extract the policy ACs to a new policy REQ in the appropriate cross-cutting domain. Feature REQ keeps one AC referencing the policy REQ by ID.

**Deterministic target-domain rule (unleashed):**

| Concern keyword | Target domain file | Domain ID prefix |
|---|---|---|
| rate limit / throttle / 429 | `sdd/rate-limits.md` | `REQ-RATE-` |
| CSP / security header / CSRF policy | `sdd/security-policy.md` | `REQ-SEC-` |
| audit log / observability / metrics / tracing | existing `sdd/observability.md` | `REQ-OPS-` |
| cache / Cache-Control / CDN | `sdd/cache-policy.md` | `REQ-CACHE-` |
| retry / backoff / circuit breaker | `sdd/resilience.md` | `REQ-RES-` |

New domain file scaffolded with standard header. First extracted REQ gets `REQ-{PREFIX}-001`. Default catch-all when no keyword matches: `sdd/policies.md` with prefix `REQ-POL-`.

### Concern-boundary split (sub-feature trigger below the numeric cap)

A single-actor REQ whose ACs span >=2 distinct sub-features MUST split, **regardless of AC count**. Adds a concern-boundary trigger to the existing cap-based and actor/cross-cutting axes; fires when the REQ is structurally two REQs even at <=7 ACs.

Detection (both must hold): (1) lexical clustering of AC first-clause subjects yields >=2 clusters, each with >=2 ACs; (2) clusters describe operationally distinct sub-jobs (different verb families).

Severity: MEDIUM `concern-boundary-split-required`. Auto-fix in `auto`/`unleashed`: apply **Splitting by sub-feature** mechanics even without numeric cap trip.

A 9-AC REQ where every AC is one job from different angles is NOT a split target; clusters must be operationally distinct.

### Accretion guard (diff-level check)

The structural rules catch a REQ that is **already** bloated. The accretion guard catches the diff that is **about to** bloat it.

Detection runs against the diff:

1. **AC addition introducing a new actor**: HIGH regardless of count. Propose: move to the actor-appropriate REQ.
2. **AC addition introducing a cross-cutting concern**: HIGH regardless of count. Propose: extract to a cross-cutting REQ.
3. **AC addition pushing count past 7** (single-actor + single-concern): MEDIUM `ac-count-over-cap`. Propose: sibling merge, else **Splitting by sub-feature**.
4. **AC addition pushing count past 10**: HIGH `ac-count-binding-cap-exceeded`. Split is mandatory.
5. **AC extension grows sub-bullets**: MEDIUM. Propose: promote each sub-bullet.
6. **AC extension grows past 150 words** OR **multi-behaviour added in diff**: MEDIUM. Propose: split per AC-granularity rule.

The accretion guard is fail-loud: it names the diff hunk, the violated rule, the proposed split target, and (when mechanical) the auto-fix preview.

### Splitting by actor or concern (SAFE refactor)

Splitting by **prose semantics** stays under JUDGMENT. Splitting by **actor** or by **cross-cutting concern** is mechanical: the AC subject declares the boundary; resulting REQs carry the same ACs verbatim under a new header.

SAFE when ALL hold:
1. Split axis is actor OR cross-cutting concern.
2. No AC needs rewriting; each moves verbatim or with whitespace-only edits.
3. Each resulting REQ has a coherent single actor and a coherent single job.
4. Tests and doc cross-refs update by ID renaming alone.

Mechanics: original REQ ID stays with the largest coherent piece; new REQs get next free IDs (cross-cutting in the cross-cutting domain). Update **every** cross-ref in the same commit. The complete cross-ref set (not just REQ bodies + `documentation/` backlinks + `sdd/changes.md`) is: (1) other REQs citing old AC numbers, (2) `documentation/lanes/**` + `documentation/decisions/README.md` by-number AC mentions (`REQ-X-NNN ACn`), (3) this REQ's own `<!-- @test: ... -> ACn -->` and `<!-- @impl: ... -->` anchor descriptions, (4) the moved ACs' inline `@impl` comments travel WITH the AC to its new REQ, (5) `sdd/changes.md` entries that name the moved ACs by number. Commit body MUST include an AC-mapping table (old REQ ACn -> new REQ ACm). After the rewrite, re-grep `REQ-X-NNN AC[0-9]` and the new REQ ID across `sdd/` + `documentation/`; any dangling old-number ref is HIGH `ac-renumber-orphaned-crossref` and blocks the commit. Commit: `[spec-reviewer] split: REQ-X-NNN by actor/concern -> ...`. Tests NOT renamed in the same commit; substring matching keeps coverage green.

### Splitting by sub-feature (binding-cap safety net)

When AC count cap binds (>10, or 8-10 with no axis) AND no actor or cross-cutting axis exists, **Splitting by sub-feature** is the deterministic fallback. Also fires from the **Concern-boundary split** rule above when clusters are operationally distinct even at <=7 ACs.

Cluster identification: tokenise each AC's first 12 words (content-words only); cluster greedily; two ACs share cluster when they share >=2 tokens (Jaccard >=0.25). Dominant cluster keeps the original REQ ID; remaining clusters become new REQs; singletons join the dominant. If all ACs land in one cluster: **median split**; ACs 1..N/2 stay; N/2+1..N become a sibling REQ with `-extended` suffix, Intent copied verbatim.

Mechanics: original REQ ID stays with dominant cluster; new REQs get next free IDs in same domain. Each new REQ inherits parent's `Applies To:`, `Constraints:`, `Priority:`, `Verification:` verbatim; Intent rewritten per sub-feature; parent-child via `Dependencies:` (NOT Notes). Cross-refs update in same commit; commit body MUST include AC-mapping table. Commit: `[spec-reviewer] split: REQ-X-NNN by sub-feature -> ...`. Tests NOT renamed.

SAFE when ALL hold:
1. No AC rewritten; every AC moves verbatim.
2. Each resulting REQ has <=7 ACs.
3. Clustering boundary was identifiable OR median fallback applied.

If 1 or 2 fails: emit HIGH `sub-feature-split-cannot-mechanize`; don't edit.

## Mechanism leakage in AC bullets

An AC describes WHAT the user observes, not HOW. Move to `documentation/`: cookie attributes (`HttpOnly`, `SameSite=Lax`), vendor-prefix headers (`Cf-Access-Jwt-Assertion`), internal middleware names, HTTP method+path enumerations in non-API REQs, internal query params, cache directive strings, crypto algorithm names.

A user observes "JavaScript on the page cannot read the session token", not `HttpOnly`.

Severity: MEDIUM. Auto-fix: rewrite AC to user-observable consequence; move mechanism to the relevant `documentation/` lane file with a backlink.
