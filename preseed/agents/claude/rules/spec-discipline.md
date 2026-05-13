# Spec Discipline (SDD-Bootstrapped Projects)

These rules apply to any project that has an `sdd/` folder. They are loaded into every agent's instructions automatically. If `sdd/` does not exist in the project, these rules are inert — ignore them.

The full SDD workflow lives in the `spec-driven-development` skill. These rules are the non-negotiable enforcement layer that runs even when the skill is not explicitly invoked.

**Sibling rule files**:
- `documentation-discipline.md` — what may NOT appear in `documentation/`, per-file/per-cell budgets, lane separation. Enforced by doc-updater.
- `tdd-discipline.md` — what counts as a real test (no text-matching theater, no tautology, no mock-only theater). Enforced by code-reviewer.

Together the three files define the spec / docs / tests lane discipline. spec-reviewer enforces this file.

## What the spec is

`sdd/` is the single source of truth for **what the product does and why**. It is not a record of what the code currently does. It is not a bug tracker. It is not a changelog of every commit. It is the target state the product is trying to reach.

## Unleashed-first design intent

The SDD framework is optimized for **fully autonomous, unleashed execution**. `interactive` and `auto` modes exist for the rare cases where a human wants to review individual fixes, but unleashed is the default operating mode — the assumption that drives every rule below.

What this means concretely:

- **Every rule has a deterministic auto-fix path.** When a rule fires in unleashed mode, the auto-fix must run without human input. Decisions that depend on JUDGMENT (the human picks which winner overwrites which loser) are eliminated wherever possible, replaced with content-preserving conservative defaults (both sides marked Partial, both pieces preserved, the conflict logged for a later human pass).
- **No structural choice escalates.** If a rule encounters genuine ambiguity (two shapes equally dominant in a file, two REQ IDs equally plausible for a new split), the rule has a documented deterministic tiebreak — e.g., "first section wins," "next free REQ ID in the existing domain," "default to the conservative interpretation." Tiebreaks favor convention over invention.
- **Content preservation is by construction, not by review.** Auto-fixes move content verbatim, never rewrite prose. The only safe rewrite is whitespace and field-label normalization. When a fix would require dropping or rewriting content, the rule defers (marks Partial, logs to `.review-needed.md`) rather than guessing.
- **JUDGMENT is a last resort, not a routing mechanism.** The `Conservative JUDGMENT auto-resolution rules` section below is for the few cases where no deterministic answer exists. New rules should not introduce new JUDGMENT branches without a strong reason — every JUDGMENT entry in unleashed becomes a `.review-needed.md` row that piles up across runs.
- **Findings are noise unless they're actionable.** LOW findings on legitimately-complex single-axis REQs (e.g., a 9-AC animation REQ where every AC is a phase) get no auto-fix and no escalation; they are smells the user may notice but the framework does not act on.

When writing or revising any rule below, the test is: "does this run cleanly in unleashed mode on a real project, without piling JUDGMENT calls into `.review-needed.md`?" If the answer is no, rewrite the rule until it does.

## Binding execution contract (NO CHERRY-PICKING)

**This section exists because the framework has failed in practice when agents executed only the cheap structural subset and silently skipped the expensive content-quality and verification passes. That is the failure mode this contract eliminates. Read this section first; obey it before applying any individual rule below.**

Every execution path that enters this rule file — `/sdd clean`, `/sdd init` Resume Mode, PR-boundary spec-reviewer triggers, manual spec-reviewer invocations — MUST execute every check listed in the **Required execution manifest** below on every run. There is no "structural-only" mode. There is no "skip if the corpus looks clean." There is no agent-side optimization that drops the expensive passes because they cost more tokens. If a check is genuinely inapplicable this cycle (e.g., CQ-3 on a run with no shrink ops), it is reported as `inert` with a one-line reason — not skipped silently.

### Required execution manifest

Every clean / PR-boundary run MUST emit a manifest with one row per rule. The manifest is written FIRST as a template with every row marked `pending`, updated as each rule completes, and finalized at run end. A manifest still containing `pending` rows at finalize time is itself a HIGH finding logged to `sdd/.review-needed.md`.

**Where the manifest is written depends on the trigger:**

- **`/sdd clean` runs** → write the full manifest into `sdd/.last-clean-run.md`. This is the audit artifact for `/sdd clean` specifically.
- **PR-boundary spec-reviewer triggers** → write the spec-side rows of the manifest into the commit body of the agent's commit, OR — if no commits are produced this run — into the `sdd/.review-needed.md` entry for the run as a `## Execution manifest` sub-section above the findings list. PR-boundary triggers do NOT write to `.last-clean-run.md`.

**Manifest format** (same shape regardless of where written):

| Rule | Required action this run | Status (with evidence) |
|---|---|---|
| Forbidden content in REQs | Walk every Active REQ; flag banned tokens in AC/Intent. | `ran (N REQs walked, M findings)` |
| Status field semantics + Deprecated discipline | Walk every REQ; verify Status field shape + Deprecated `Replaced By:` / `Removed In:` presence. | `ran (N REQs, M findings)` |
| REQ rendering template (binding) | Walk every Active REQ; verify the binding render shape. | `ran (N REQs, M findings)` |
| REQ length guidance | Walk every Active REQ; flag length tiers. | `ran (N REQs, M findings)` |
| Acceptance criteria guidance + REQ accretion guard | Walk every Active REQ; flag AC count > cap; on a diff run, scan diff hunks for the accretion patterns. | `ran (N REQs, K diff hunks, M findings)` |
| Actor coherence | Walk every Active REQ; flag actor-axis violations in ACs. | `ran (N REQs, M findings)` |
| Sub-bullets in ACs are banned | Walk every Active REQ; flag indented list items under ACs. | `ran (N REQs, M findings)` |
| Cross-cutting concerns get their own REQ family | Walk every Active REQ; flag policy-shape ACs in feature REQs. | `ran (N REQs, M findings)` |
| Run-on AC bullets | Walk every AC; flag length / semicolon-density thresholds. | `ran (N ACs scanned, M findings)` |
| Mechanism leakage in AC bullets | Walk every Active REQ; flag mechanism tokens (cookie attrs, headers, CSS, etc.) against the current allowlist. | `ran (N REQs, M findings)` |
| Changelog drift | Diff `sdd/changes.md` against AC-changed diff hunks. | `ran (K entries scanned, M findings)` |
| Meta-content leakage Rule A (stub-after-extraction) | Walk every REQ; flag stub-after-extraction shape. | `ran (N REQs, M findings)` |
| Meta-content leakage Rule B (Notes two-shape) | Walk every REQ; flag Notes-vs-two-shape violations. | `ran (N Notes fields, M findings)` |
| Meta-content leakage Rule C (preamble edit-history) | Walk every `sdd/{domain}.md` preamble (per Rule C scope); flag edit-history prose. | `ran (K domain files, M findings)` |
| Test coverage and enforce_tdd | If `enforce_tdd: true`, run all three classification passes (auto-demote, source-vs-test, test-quality). | `ran (N REQs, M findings)` or `inert (enforce_tdd: false)` |
| CQ-1 — REQ-test truth-check | For every Implemented REQ, walk every test file containing the REQ ID; verify REQ-ID-in-name AND assertion-references-AC-content. | `ran (N Implemented REQs, K test files opened, M findings)` |
| CQ-2 — Vendor / external-interface drift | For every Implemented REQ, extract vendor/protocol tokens from ACs; grep `src_globs` for each token; flag orphans. | `ran (N REQs, T tokens scanned, M findings)` |
| CQ-3 — Content-preservation on shrink | On every shrink/run-on-split edit proposed this run, run the content-preservation tokenization check before committing. | `ran (K shrink ops, M findings)` or `inert (no shrink ops)` |

### Evidence requirement is binding

Every row's status MUST include concrete numbers naming WHAT was inspected — the REQ count walked, the test files opened, the tokens scanned, the diff hunks read. A row that says `ran (0 findings)` without an evidence count is itself a HIGH finding. Numbers are spot-checkable: when the user audits the manifest, they can sample three REQs and confirm the agent actually inspected them. Faking the manifest requires fabricating numbers that survive spot-check; an honest `ran` is cheaper than a credible lie.

`inert` is valid ONLY when the rule itself defines the no-work case (CQ-3 needs a shrink op; TDD-COVERAGE needs `enforce_tdd: true`). A claim of `inert` outside those documented cases is a HIGH finding. `skipped: <reason>` is reserved for user-override situations (user explicitly told the agent to skip this run); a `skipped:` row without a recorded user override in the conversation log is itself a HIGH finding.

### Cost is not a valid reason to skip

CQ-1 requires opening one test file per Implemented REQ. CQ-2 requires one grep per vendor token. These are not optional. An agent that drops them because "the structural sweep passed and the corpus looked clean" is the failure mode this contract was written to eliminate. The whole point of the discipline is to catch what structural checks miss; skipping them inverts the framework's purpose.

If a real cost ceiling exists for a session (e.g., a token budget the user has explicitly set), the agent surfaces that ceiling BEFORE starting the run, asks the user whether to defer the expensive passes to a follow-up cycle, and records the user's decision as the `skipped: <reason>` justification. Silent unilateral deferral is forbidden.

### Sibling-discipline coupling

A `/sdd clean` run executes the union of THIS file's manifest AND `documentation-discipline.md`'s execution manifest (Passes 1-12). A run that completes only one side is incomplete and emits a HIGH finding `clean-run-partial-execution` listing the skipped half. The single source of truth for what "ran" means is the manifest table written to `sdd/.last-clean-run.md`.

## Forbidden content in REQs

REQs in `sdd/{domain}.md` describe **observable behavior** at the user-facing level. The following are NEVER acceptable inside a REQ acceptance criterion or intent (they belong in `documentation/` instead):

| Banned | Where it goes instead |
|---|---|
| Hex color codes (`#1A6B8F`) | `documentation/architecture.md` or `documentation/design-system.md` |
| CSS class names (`.section--wave-in`, `.btn-primary`) | `documentation/architecture.md` |
| CSS keyframe names (`@keyframes heroZoom`) | `documentation/architecture.md` |
| viewBox values, bezier path coordinates | `documentation/architecture.md` |
| Animation timings in seconds (`12s ease-in-out`) | `documentation/architecture.md` |
| z-index values | `documentation/architecture.md` |
| File paths (`src/pages/api/inquiry.ts`, `Hero.astro`) | `documentation/architecture.md` |
| Function names (`getEmDashCollection`, `parsePhotoArray`) | `documentation/architecture.md` |
| Database column names (`email_status`, `apartment_id`) when the column is implementation detail (internal counter, soft-delete flag, audit timestamp) | `documentation/architecture.md` |
| Cookie names (`CF_Authorization`, `_locale`) | `documentation/security.md` or `authentication.md` |
| HTTP status code enumerations (`200/202/400/403/409/429/500`) | `documentation/api-reference.md` |
| JSON request/response schemas | `documentation/api-reference.md` |
| Endpoint paths (`/api/inquiry`, `/api/img/{key}`) | `documentation/api-reference.md` |
| Env var names (`RESEND_API_KEY`, `CF_ACCESS_AUDIENCE`) | `documentation/configuration.md` |
| Build-tool internals ("Vite cannot import cloudflare:workers at build time") | `documentation/troubleshooting.md` |
| TypeScript code snippets (`env as unknown as Env`) | `documentation/architecture.md` |
| SQL queries | `documentation/architecture.md` |
| Debugging checklists | `documentation/troubleshooting.md` |
| Strikethrough text (`~~old behavior~~`) | Delete entirely. Git history is the strikethrough. |
| "Current implementation:" branches inside an AC | `pending.md` at repo root |
| "Planned (not implemented):" branches inside an AC | `pending.md` at repo root |
| Implementation TODOs ("retry is aspirational, no Cron Trigger exists") | GitHub issue |

## Allowlist (these ARE acceptable in REQs)

Don't over-correct. The following ARE acceptable inside REQs because they describe the contract, not implementation:

- **Vendor product names**: "Cloudflare Access", "Stripe", "Resend" (these are integration points, not implementation)
- **Protocol names**: "OAuth 2.0", "JWT", "WebSocket", "Server-Sent Events"
- **Standards references**: "WCAG 2.1 AA", "GDPR Art. 6(1)(b)", "RFC 9116"
- **Performance numbers as targets**: "p95 < 200ms", "LCP < 2.5s", "60s cache TTL" (these are acceptance criteria for performance REQs)
- **User-facing strings in quotes**: `"This is an estimate. Final price confirmed by owner."` (these ARE the AC — what the user sees)
- **HTTP status codes when documenting an error contract REQ**: when the REQ is specifically about error handling, the codes are part of the contract (allowed in moderation)
- **Env var names when the REQ is about Configuration domain**: when the env var IS the contract (allowed contextually)
- **Database column / KV key names when the storage shape IS the persistence contract**: the column / key name is the contract noun shared between the UI control, the persisted row, and the dispatcher's predicate (e.g., `email_enabled` toggle in settings, `session_version` for instant revocation, `sources:{tag}` KV key shape). Same reasoning as env-var-as-contract: when the storage shape is what callers code against, naming it in the AC IS the contract, not implementation leakage. This carveout exists because the same pattern recurred across 8+ REQs in a single project (the AD9 cluster); promoting it to a first-class allowlist retires the per-REQ ADR-override mechanism.

The project's `sdd/config.yml` can override the allowlist via `forbidden_content_allowlist` and `forbidden_content_overrides` fields.

## Deprecated REQs are historical artifacts, not active contract

Structural rules (sub-bullets banned, ≤7 AC cap and co-occurring-axis severity, actor coherence, run-on AC bullets, mechanism leakage in ACs, REQ length guidance, Rule A stub-after-extraction, Rule B Notes-shape, REQ accretion guard) DO NOT fire on REQs with `Status: Deprecated`. A Deprecated REQ records what the product USED to do; rewriting it to fit current structural rules would corrupt the historical record. The `Replaced By:` / `Removed In:` field is the rule's exit clause — once present, the REQ is read-only for cleanup purposes.

Content-quality rules also skip Deprecated REQs:
- CQ-1 (REQ-test truth-check) skips Deprecated — the tests that used to verify the deprecated behavior may have been removed.
- CQ-2 (vendor / external-interface drift) skips Deprecated — a vendor token in a Deprecated AC may refer to an integration that's been removed; that's the whole point of marking it Deprecated.
- CQ-3 (content-preservation on shrink) does not apply (no shrink edits happen on Deprecated REQs).

What still applies to Deprecated REQs:
- The `Replaced By:` OR `Removed In:` field MUST be present (this is the only validation).
- "Never delete REQs" preservation rule — Deprecated REQs are moved to "Out of Scope" in the README only when no replacement exists AND no historical reference is needed; otherwise they stay in their domain file.
- The structural template (`### REQ-X-NNN: Title` heading, `**Status:** Deprecated`) — corrupted heading or missing Status field IS still a finding.

This carveout is what makes the spec usable as a record of evolution. The active contract is everything not-Deprecated; the Deprecated entries are evidence of how the product got here.

**Implementation note for detectors and dry-run scripts:** any corpus-walking detector that flags findings against REQs MUST check `Status: Deprecated` first and skip. This is the load-bearing carveout — an AWK / grep script that walks `### REQ-` headings without honoring Status will retroactively flag historical artifacts and an unleashed agent will dutifully "fix" them, corrupting the spec's record of evolution. When writing a one-off detector (in a session, in CI, in a hook), the Status: Deprecated check is the first filter, not an optional refinement.

## Status field semantics

Every REQ has exactly one Status value. **One word, no prose.**

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted, not yet committed to spec |
| `Planned` | Committed to spec, not yet built |
| `Partial` | Built but some AC unmet OR no automated verification (test) found |
| `Implemented` | Built AND tests verify the acceptance criteria |
| `Deprecated` | Was implemented, then removed or replaced. Requires `Replaced By:` or `Removed In:` field. |

`Partial` may optionally have a `Notes:` field of ≤3 sentences describing what's missing. No other status uses Notes.

**Implementation tracking** (commit SHAs, file paths, partial completion notes, missing features) goes in `pending.md` at repo root or in GitHub issues — never in the Status field.

## Status transitions

- `Proposed` → `Planned` → (`Partial` ↔ `Implemented`) → `Deprecated`
- A REQ can move from `Implemented` back to `Partial` if tests are removed or fail
- A REQ can never move from `Implemented` to `Proposed` — that's a new REQ
- `Deprecated` is terminal in the sense that the next change is usually deletion/move to "Out of Scope" (see below)

## What "Deprecated" really means

`Deprecated` is for features that **were built and then removed or replaced**. It is NOT a graveyard for ideas that were never built. If you see a REQ marked Deprecated with a reason like "not needed for MVP" or "scope reduction" or "all sections always visible", that REQ was never built — it should not be Deprecated.

**Never-built REQs** should be moved to a "Out of Scope" section in the relevant domain README (or `sdd/README.md` if it cuts across domains). This preserves the decision history without bloating the active spec. The REQ's full text is preserved in the "Out of Scope" section. **Never delete REQs outright** — content is always moved, never lost.

`Deprecated` requires a `Replaced By: REQ-X-NNN` field (pointing to the REQ that supersedes it) or a `Removed In: YYYY-MM-DD` field (with the date the feature was removed). Without one of these, it's not deprecated — it's never-built.

## What is NOT a requirement

- **Bugs** → GitHub issues, tagged appropriately. The spec describes the target state; bugs are the delta between target and actual implementation.
- **TODOs / known gaps** → `pending.md` at repo root. The Status field can say `Partial` to flag incompleteness, but the prose details go in `pending.md`.
- **Spec churn / "we tried X then Y"** → git history. Don't preserve history inside the spec via strikethrough or "Superseded:" annotations.
- **Build environment quirks** → `documentation/troubleshooting.md`. They're operational notes, not product requirements.
- **Out-of-scope ideas** → "Out of Scope" section in the relevant domain README. They are decisions, not requirements.

## REQ rendering template (binding)

Every REQ in `sdd/{domain}.md` MUST render in exactly this shape. The shape is enforced — deviations are MEDIUM findings, auto-fixed in `auto`/`unleashed` by re-rendering. Uniformity is what makes the spec readable: a developer scanning ten REQs should see ten identical visual structures, not ten variations.

```
### REQ-{DOMAIN}-{NNN}: {Title}

**Intent:** {one paragraph, 1–4 sentences. No bullets, no headings, no code blocks.}

**Applies To:** {single actor name from sdd/README.md actors table. Never "System".}

**Acceptance Criteria:**

1. {first AC, single behavioral statement, ≤150 words, no sub-bullets, no nested lists}
2. {second AC, same shape}
3. {…up to 7 maximum per the ≤7 cap rule}

**Notes:** {OPTIONAL. Two sanctioned shapes — see **Meta-content leakage** section below for full rule. (a) `Status: Partial` Notes: ≤3 sentences explaining what's unmet. (b) Doc-pointer Notes (any Status): ≤2 sentences, MUST contain ≥1 markdown link to `documentation/**` or `sdd/**`, prose pattern is "X is documented at [link]" — link dominates.}

**Constraints:** {comma-separated CON-* IDs, or "None"}
**Priority:** {P0 | P1 | P2 | P3}
**Dependencies:** {comma-separated REQ-* IDs, or "None"}
**Verification:** {Automated test | Integration test | Manual check}
**Status:** {Proposed | Planned | Partial | Implemented | Deprecated}
```

For `Status: Deprecated`, the trailing fields additionally include `**Replaced By:** REQ-*-*` or `**Removed In:** YYYY-MM-DD`.

**Banned inside a REQ body:**

- Sub-headings (`####`, `#####`) — every field above is already a bolded label
- Nested lists (any indented `-`, `*`, or letter-list under an AC) — see the **Sub-bullets in ACs are banned** rule
- Code blocks (fenced or indented) — implementation detail belongs in `documentation/`
- Tables — implementation detail belongs in `documentation/`
- Strikethrough — git history is the strikethrough
- "Current behavior:" / "Planned behavior:" / "Previously:" / "Now:" branches — these belong in `pending.md` or git history
- Block quotes — REQs are statements of contract, not commentary

**Blank-line policy:**

- One blank line between every labeled field
- One blank line between the `**Acceptance Criteria:**` label and the numbered list
- One blank line between the last AC and `**Notes:**` (or `**Constraints:**` when no Notes)
- The closing `---` separator sits on its own line, preceded and followed by one blank line

The rendering template is what every REQ-generating action emits — `/sdd add`, `/sdd edit`, spec-reviewer auto-fixes, accretion-guard splits, conservative JUDGMENT resolutions. Auto-fixes that re-render a REQ to match the template are SAFE refactors (mechanical, no semantic change), not JUDGMENT calls.

## REQ length guidance

REQs describing complex features can be long, but length is a smell:

| Length | Severity |
|---|---|
| ≤25 lines | OK |
| 26–50 lines | LOW finding (consider extracting implementation prose to docs) |
| 51–100 lines | MEDIUM finding (likely contains implementation leakage) |
| >100 lines | HIGH finding (almost certainly mixing intent and implementation) |

Oversized REQs are first shrunk in place (extract implementation prose to `documentation/`). When shrinking-in-place is exhausted and the REQ is still oversized, see the **Splitting by actor or concern** rule below — splits along the actor axis or the cross-cutting-concern axis are mechanical refactors, not JUDGMENT calls, because the boundary is declared by the AC's subject.

## Acceptance criteria guidance

- Each AC bullet is **binary pass/fail**, testable in principle.
- **AC count cap is binding.** 3-5 ACs is typical. 6-7 is normal for feature-rich surfaces. Beyond 7, the rule fires regardless of whether the REQ is "single actor + single concern" - a 17-AC REQ is not a real requirement, it's a folder of requirements pretending to be one. Cap is binding in unleashed: the agent MUST split, never "defer to owner".

  | AC count | Single actor + single concern | + actor mixing OR cross-cutting concern present |
  |---|---|---|
  | ≤7 | OK | The mixing rule fires regardless of count (see Actor coherence, Cross-cutting concerns) |
  | 8–10 | MEDIUM `ac-count-over-cap`. Auto-fix in `auto`/`unleashed`: attempt merge of compatible sibling ACs (two ACs whose subjects share ≥3 content tokens AND whose verbs are compatible) first; if merge fails to bring count to ≤7, apply **Splitting by sub-feature** (see below). | HIGH - almost certainly the REQ that motivated this rule. Auto-fix: split by actor or concern. |
  | >10 | HIGH `ac-count-binding-cap-exceeded`. Auto-fix in `auto`/`unleashed` is mandatory: **Splitting by sub-feature** runs even when no actor or cross-cutting axis exists. Single-actor + single-concern is presumed false at this scale - the agent surfaces the dominant secondary axis (typically a sub-feature carve-out) by lexical clustering of AC subjects. | HIGH - split immediately along the actor/concern axis. |

  Why the change from "≤10 LOW smell, no auto-fix": the prior rule let REQ-PIPE-003 grow to 17 ACs and REQ-AUTH-001 to ~10 because each individual AC was legitimate. The unleashed-first design intent is to never accept a 10+ AC REQ as a final product. The cap is a hard product-quality bound, not a hint.

- **No sub-bullets in ACs.** A sub-bulleted AC (`a./b./c.` or indented `-`) is conjunction-stuffing that bypasses the run-on-bullet rule. Each sub-bullet is an independent observable behavior. See the **Sub-bullets in ACs are banned** section below.
- Avoid "should" — use "must" or describe the observable outcome.
- Avoid vague terms like "responsive", "fast", "user-friendly" — specify the criterion (e.g., "loads in under 2 seconds on 4G mobile").

## Actor coherence (one actor per REQ)

Every REQ declares a single actor in its `Applies To:` field (User, Admin, Operator, or another named role; never "System" — that's a qualifier). **Every AC bullet in the REQ must describe behavior of that same actor.** When an AC describes a different actor's behavior, the REQ is incoherent at the actor level: a User REQ with Admin-actor ACs has no clean test contract (a test naming the REQ ID may cover either actor's surface) and produces the AC-bloat pattern (ACs grow nested sub-bullets because separate actors need separate organization within one bullet list).

Detection: parse the first 8 words of each AC for an actor keyword (`user`, `admin`, `operator`, `visitor`, `guest`, role names declared in `sdd/README.md` actors table). If the AC's subject differs from `Applies To:`, emit a finding.

Severity: HIGH when 2+ ACs target a different actor (clear split signal). MEDIUM when 1 AC targets a different actor (likely belongs in the relevant actor's REQ; may be a one-off cross-reference instead).

Auto-fix in `auto`/`unleashed`: split the REQ along the actor axis. The AC subjects declare the boundary mechanically — this is a SAFE refactor, not a JUDGMENT call. See **Splitting by actor or concern** below.

## Sub-bullets in ACs are banned

A sub-bulleted AC takes the shape:

```
8. Operator endpoints under `/api/admin/*` enforce two baseline layers...
   a. When the deployment is configured with a Cloudflare Access tag...
   b. The requester holds a live Worker session cookie.
   c. The session user is the configured operator...
   d. The destructive pipeline mode that wipes...
   e. Admin GET endpoints additionally reject cross-site...
```

This is conjunction-stuffing by another name: the run-on-AC rule (≤150 words, ≤3 semicolons) catches semicolon-joined behaviors; the sub-bulleting shape bypasses it by using markdown nesting to hide N independent ACs inside one numbered bullet. Each sub-bullet `a./b./c.` is an independent observable behavior.

Detection: any indented list item (`   a.`, `   - `, `   1.`) under a numbered AC.

Severity: MEDIUM. Auto-fix in `auto`/`unleashed`: promote each sub-bullet to its own AC at the parent level. If the resulting count exceeds the ≤7 cap, **Splitting by actor or concern** applies — the sub-bullets were almost certainly mixing actors or concerns.

## Cross-cutting concerns get their own REQ family

Cross-cutting concerns are policies that apply across many features rather than belonging to any one feature. Typical concerns:

- Rate limiting
- CSRF defense
- Audit logging / observability
- Security headers
- Authentication/authorization gating (the policy, not any specific endpoint)
- Caching policy
- Retry / backoff policy

When a feature REQ's AC list grows to encode such a policy, the policy infects every feature REQ that touches the surface — every endpoint REQ ends up restating the rate-limiting rules, every UI REQ ends up restating the CSP rules. The fix is to give the concern its own REQ family in its own domain (typical names: `sdd/security-policy.md`, `sdd/observability.md`, `sdd/rate-limits.md`), and have feature REQs reference the policy REQ by ID instead of restating it.

Detection: AC bullets that begin with policy-shape language (`Every <route family> is rate-limited`, `Every response carries`, `All <verb> endpoints reject`) inside a feature REQ that's not titled as a policy REQ.

Severity: MEDIUM when 1-2 policy-shape ACs appear in a feature REQ. HIGH when policy ACs dominate (≥3 of ≤7 ACs are policy-shape) — the REQ is structurally a policy REQ wearing a feature-REQ hat.

Auto-fix in `auto`/`unleashed`: extract the policy ACs to a new policy REQ in the appropriate cross-cutting domain. The feature REQ keeps one AC referencing the policy REQ by ID (e.g., "rate-limited per REQ-SEC-RATE-001"). See **Splitting by actor or concern** below.

**Deterministic target-domain rule (unleashed):** when the policy belongs in a cross-cutting domain that does not yet exist in `sdd/`, auto-fix CREATES the domain file using a fixed slugging rule rather than escalating to JUDGMENT. The slug is derived from a concern-to-domain map:

| Concern keyword in the policy AC | Target domain file | Domain ID prefix |
|---|---|---|
| rate limit / rate-limit / throttle / 429 | `sdd/rate-limits.md` | `REQ-RATE-` |
| CSP / security header / strict-transport / X-Frame-Options / CSRF policy | `sdd/security-policy.md` | `REQ-SEC-` |
| audit log / observability / metrics / tracing | existing `sdd/observability.md` (do not create new) | `REQ-OPS-` |
| cache / Cache-Control / CDN / stale-while-revalidate | `sdd/cache-policy.md` | `REQ-CACHE-` |
| retry / backoff / circuit breaker | `sdd/resilience.md` | `REQ-RES-` |

The new domain file is scaffolded with the standard header (`# {Domain Title}`, brief intent paragraph derived from the policy ACs, `---` separator, then the extracted REQ). The first extracted REQ gets the next free `REQ-{PREFIX}-001` ID; subsequent extractions on later runs increment. The agent commits the new file alongside the source REQ's edit in the same per-category commit.

When the policy keyword does not match any row in the table, the agent defaults to `sdd/policies.md` with prefix `REQ-POL-` — a catch-all that holds together until the user reorganizes it. The catch-all is deliberately ugly so a future human pass migrates it to a properly-named domain.

## REQ accretion guard (diff-level check)

The structural rules above (≤7 ACs, actor coherence, no sub-bullets, cross-cutting lane) catch a REQ that is *already* bloated. The accretion guard catches the diff that's *about to* bloat it, before the rule fires retroactively.

`sdd/changes.md` history shows the failure mode in detail: REQ-AUTH-001 grew from ~5 ACs to 10 across nine entries that each added or extended a single AC ("AC 8d extended", "AC 8a extended", "AC 10 added", "AC 8e added and REQ-AUTH-003 AC 3 narrowed", "AC 9a broadened", "AC 9 refined", ...). Every individual diff looked reasonable. The cumulative result is unreadable. No single review trigger fired because no single edit crossed a threshold.

Detection runs on every spec-reviewer trigger, against the diff (not the post-edit state):

1. **AC addition that introduces a new actor** (diff adds an AC whose subject differs from the REQ's `Applies To:`): HIGH finding regardless of count. This is the load-bearing check — actor drift is the failure mode that produced REQ-AUTH-001. Propose: move the new AC to the actor-appropriate REQ (existing if one fits, new if not).
2. **AC addition that introduces a cross-cutting concern** (diff adds an AC matching policy-shape language: `Every <route family> is X`, `All <verb> endpoints Y`, `Application-layer Z protects ...`): HIGH finding regardless of count. Propose: extract to a cross-cutting-concern REQ.
3. **AC addition that pushes count past 7 in a single-actor, single-concern REQ** (diff adds the 8th AC): MEDIUM `ac-count-over-cap`. Propose: attempt merge of compatible sibling ACs; if that fails, apply **Splitting by sub-feature**. Auto-fix runs in `auto` and `unleashed`.
4. **AC addition that pushes count past 10** (regardless of axis): HIGH `ac-count-binding-cap-exceeded`. The cap is binding; the agent MUST split. **Splitting by sub-feature** runs even when no actor or cross-cutting axis exists. Auto-fix is mandatory in `auto` and `unleashed`.
5. **AC extension grows sub-bullets** (diff adds indented `a./b./c.` items beneath an existing AC): MEDIUM finding. Propose: promote each sub-bullet to its own AC (which then triggers the actor/concern checks).
6. **AC extension grows word count past 150** (diff extends an existing AC bullet from ≤150 words to >150 words via a clause-joining edit): MEDIUM finding per the existing run-on rule. Propose: split at the conjunction.

Note: rules 1 and 2 (actor mixing, cross-cutting concern) catch the REQ-AUTH-001 failure mode at the diff level. Rules 3 and 4 (count cap) are the safety net for REQs that have no clean actor or cross-cutting axis but accrete legitimate ACs past the readable threshold (REQ-PIPE-003 was the canonical example at 17 ACs). The cap binds even when no axis is obvious - **Splitting by sub-feature** below provides the deterministic boundary.

The accretion guard is fail-loud: when fired, the spec-reviewer's report names the diff hunk, the violated rule, the proposed split target, and (when actor/concern is mechanical) the auto-fix preview. The user sees the diagnosis at the diff level, before the REQ silently accretes another year of edits.

## Splitting by actor or concern (SAFE refactor, not JUDGMENT)

The 2025-era rule was "never split a REQ — LLMs lose meaning when splitting." That rule overgeneralized. Splitting by **prose semantics** (intent paragraph re-written, ACs re-interpreted) is genuinely meaning-risky and stays under JUDGMENT. Splitting by **actor** or by **cross-cutting concern** is mechanical: each AC's subject is declared in its first 8 words, the boundary is the actor or concern, and the resulting REQs are the same ACs verbatim under a new header.

A split is SAFE when ALL of these hold:

1. The split axis is actor (each AC declares its actor in its opening clause) OR cross-cutting concern (the policy-shape language is unambiguous).
2. No AC needs to be rewritten — each AC moves to its target REQ verbatim or with whitespace-only edits.
3. Each resulting REQ has a coherent single actor and a coherent single job-to-be-done.
4. Tests and documentation cross-references can be updated by ID renaming alone (no test logic changes).

If any condition fails, the split is JUDGMENT — escalate.

Mechanics of a SAFE split:

1. The original REQ ID stays with the **largest coherent piece** (typically the feature's core job under its declared actor).
2. New REQs get the next free IDs in the relevant domain. Cross-cutting concerns get IDs in the cross-cutting domain (e.g., `REQ-SEC-RATE-001` in `sdd/security-policy.md`), not in the feature's domain.
3. Update all cross-references in the same commit:
   - Other REQs that mention old AC numbers (e.g., "narrows REQ-AUTH-001 AC 3") get the new REQ ID
   - `documentation/` backlinks get the new REQ ID
   - `sdd/changes.md` records the split with the new IDs listed
   - The commit body MUST include an AC-mapping table (`AUTH-001 AC 8 → AUTH-006 AC 1`, `AUTH-001 AC 9 → RATE-001 AC 2`, etc.) so doc-updater can mechanically rewrite stale `AC N` references on its next run. The same requirement applies to sub-feature splits below.
4. The split is committed as `[spec-reviewer] split: REQ-X-NNN by actor/concern → REQ-X-NNN + REQ-Y-MMM + ...`
5. Tests are NOT renamed in the same commit — substring matching keeps the existing test coverage assertions green, and test renames are the test author's lane (separate PR if desired).

## Splitting by sub-feature (the binding-cap safety net)

When the AC count cap binds (>10 ACs, or 8-10 ACs in a single-actor + single-concern REQ where AC merge failed), and no actor or cross-cutting-concern axis exists, **Splitting by sub-feature** is the deterministic fallback. The rule eliminates the "no axis, defer to owner" escape hatch — every REQ over the cap gets split, even when the agent has to find the boundary.

A sub-feature is a contiguous (or nearly contiguous) cluster of ACs that share subject vocabulary or describe the same sub-job. The agent identifies clusters by lexical clustering of AC first-clause subjects:

1. **Tokenize each AC's first 12 words** (after stripping stop-words). Tokens are content-words: nouns, verbs, named entities, vendor names, domain concepts.
2. **Cluster by token overlap.** Two ACs belong to the same cluster when they share ≥2 content tokens (Jaccard similarity ≥0.25 on the token sets is the equivalent threshold). Cluster greedily by walking ACs in document order.
3. **The dominant cluster (largest by AC count) keeps the original REQ ID.** Remaining clusters become new REQs. Singleton ACs (no cluster siblings) join the dominant cluster - a sub-feature with one AC is just an outlier, not a split target.
4. **If clustering yields a single cluster covering ALL ACs** (true single-concern REQ at high AC count), the agent falls back to **median split**: ACs 1..N/2 stay with the original REQ ID, ACs N/2+1..N become a sibling REQ with a `-extended` or `-continued` suffix in its title. The Intent paragraph is copied verbatim to both. Owner reviews and either accepts the boundary or moves individual ACs between the two. The median split is the last-resort guarantee that the cap always binds.

Mechanics of a sub-feature SAFE split:

1. The original REQ ID stays with the dominant cluster.
2. New REQs get the next free IDs in the same domain (sub-features are domain-local; they do not migrate to cross-cutting domains - that's the **Splitting by actor or concern** path).
3. Each new REQ inherits the parent's `Applies To:`, `Constraints:`, `Priority:`, `Verification:` fields verbatim. The Intent is rewritten to describe the sub-feature's own contract (not copied verbatim from the parent, which would describe the wider scope). The parent-child relationship is encoded in `Dependencies:` (the new sibling lists the parent REQ ID, the parent lists the new sibling) — NOT in Notes. This honors Rule B's clarification that sibling-REQ cross-references live in Dependencies.
4. Cross-references update in the same commit (REQs citing old AC numbers, `documentation/` backlinks, `sdd/changes.md`). The commit body MUST include an AC-mapping table listing every AC that moved (`PIPE-006 AC 8 → PIPE-016 AC 3`, `SET-002 AC 8 → SET-008 AC 4`, etc.) so doc-updater can mechanically rewrite stale `AC N` references in `documentation/` on its next run. Without the mapping table, doc-updater cannot distinguish "AC 8 stayed put" from "AC 8 moved" and the backlink hygiene becomes manual labor.
5. The split commits as `[spec-reviewer] split: REQ-X-NNN by sub-feature → REQ-X-NNN + REQ-X-MMM + ...`
6. Tests are NOT renamed in the same commit (same rule as the actor/concern split).

A sub-feature split is SAFE when ALL of these hold:

1. No AC is rewritten - every AC moves to its target REQ verbatim or with whitespace-only edits.
2. Each resulting REQ has ≤7 ACs after the split (the cap that motivated the split is now respected).
3. The clustering boundary was identifiable OR the median fallback applied.

If condition 1 or 2 fails, the agent emits HIGH `sub-feature-split-cannot-mechanize` listing the REQ and the clustering output, but does not edit the spec. The owner makes the call - this is the rare residual JUDGMENT case where the AC list is genuinely orthogonal to any clustering.

The sub-feature path is the lower-precedence option: when the actor axis OR cross-cutting-concern axis exists, those win because their boundaries are declared by the AC subject itself. Sub-feature clustering kicks in only when neither axis applies, which is the case for accreted single-actor + single-concern feature REQs (PIPE-001, PIPE-003 at the time of this rule's adoption).

## Run-on AC bullets

A single AC bullet that runs longer than ~150 words almost always conjoins multiple observable behaviors with semicolons or commas. Each observable behavior should be its own bullet so tests can target it individually.

Detection: any AC bullet matching either of:
- exceeding 150 words, OR
- containing 3+ semicolons not inside a comma-separated enumeration

Note: a bare "5+ ands" rule false-positives on enumeration patterns ("supports CSV, TSV, JSON, XML, YAML, and Parquet") which describe a single observable behavior across a list. Ignore the conjunction count when the conjunctions appear inside a comma-separated list — focus instead on semicolons (which usually mark separate behaviors) and total bullet length.

Severity: MEDIUM. Auto-fix in `auto`/`unleashed`: split at conjunctions, preserving every clause as a separate bullet under the same AC heading. Never silently drop a clause.

## Mechanism leakage in AC bullets

An AC bullet describes WHAT the user observes, not HOW it's implemented. The following are mechanism tokens that leak into ACs and should move to `documentation/`:

- Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/`, `Max-Age=…`
- Header names with vendor prefix: `Cf-Access-Jwt-Assertion`, `X-Forwarded-For`, `X-Request-Id`
- Internal middleware names: `csrfMiddleware`, `rateLimiter`, `requireAuth`
- HTTP method + path enumerations inside non-API REQs (the path goes in the AC for an API REQ — but not in a UI REQ)
- Query parameter internal names: `?_t=`, `?nonce=`
- Cache directive strings: `s-maxage=60, stale-while-revalidate=300`
- Crypto algorithm names: `RS256`, `HS512`, `AES-256-GCM` (the standard reference is fine; the algorithm choice is implementation)

A user does not observe `HttpOnly`. They observe "JavaScript on the page cannot read the session token." The first goes in `documentation/security.md`, the second goes in the AC.

Severity: MEDIUM. Auto-fix in `auto`/`unleashed`: rewrite the AC bullet to describe the user-observable consequence; move the mechanism description to `documentation/security.md` (or the relevant lane file) with a backlink to the REQ.

## Changelog drift (no AC change → no changelog entry)

`sdd/changes.md` is a product changelog. An entry is justified only when an AC changed in a user-observable way OR a REQ was added/deprecated/moved. The drift pattern: changelog entries appearing for spec format fixes, prose tightening, or implementation-leakage cleanup with no corresponding AC delta.

Detection on every spec-reviewer run:

1. For each new entry in `sdd/changes.md` (added in the diff): scan the same diff for any AC change in the REQ the entry references
2. If the entry references no REQ, OR the diff shows no AC delta in the referenced REQ → the entry is drift

Severity: LOW (cleanup). Auto-fix in `unleashed`: delete the drift entry. In `auto`: list under deferred LOW. In `interactive`: confirm before deletion.

This pattern enforces the changelog-discipline rules already in this file ("When NOT to add a changelog entry") at the per-commit level instead of relying on humans to remember.

## Meta-content leakage (stub REQs, repurposed Notes, edit-history preambles)

The same failure mode at three scales — meta-content about the spec leaking into the spec — produces three structurally similar rules. All three have deterministic detection signals and mechanical auto-fixes; none requires JUDGMENT.

### Rule A — Stub REQ after cross-cutting extraction

A REQ whose entire contract is "participates in [REQ-Y-NNN]" with no observable predicate of its own is a hop, not a contract. After a cross-cutting extraction (REQ-AUTH-009 → REQ-RATE-001), the source REQ has two valid outcomes — deleted entirely (cleanest) or rewritten with auth-specific predicates (deployment-tunable buckets, surface-specific fail modes). The "stub with one tautological AC pointing at the policy" middle path is forbidden.

Detection (all four must hold):

1. The REQ has ≤1 acceptance criterion.
2. The AC body contains a markdown link to another REQ.
3. The AC body matches one of: `participates in`, `inherits`, `defined by`, `applies the policy`, `governed by`, `subject to` (case-insensitive).
4. The REQ's `Dependencies:` list includes that linked REQ.

Severity: MEDIUM `stub-after-extraction`. Auto-fix in `unleashed`: delete the source REQ. If the source REQ's Intent paragraph carries a surface-specific framing sentence (e.g., "the auth surface's specific bucket sizes are 5/min sign-in, 60/min refresh"), prepend it to the policy REQ's Notes (creating doc-pointer Notes if needed, see Rule B). Append a `sdd/changes.md` entry recording the deletion + replacement REQ ID. Update all backlinks in `documentation/**` to point at the policy REQ.

Edge case — when the source REQ has an actor-specific predicate beyond the bare pointer ("auth buckets are per-IP, mutation buckets are per-user-id"), it is NOT a stub. The four detection signals fail in that case (the AC body has more than the pointer-shape clause), so the auto-fix does not fire. Keeping the REQ is the correct outcome.

### Rule B — `Notes:` field two sanctioned shapes

The original binding template restricted Notes to `Status: Partial` with ≤3 sentences explaining what's missing. Reality across the corpus: Implemented REQs use Notes as a one-line pointer to where mechanism detail lives ("Cookie attributes documented in [documentation/security.md](...)") — a load-bearing navigation aid the strict rule disallows.

Two sanctioned Notes shapes:

| Shape | When valid | Form |
|---|---|---|
| (a) Partial-explanation | `Status: Partial` only | ≤3 sentences explaining what's unmet |
| (b) Doc-pointer | Any status | ≤2 sentences, MUST contain ≥1 markdown link to `documentation/**` or `sdd/**`, prose pattern is "X is documented at [link]" — the link dominates the prose |

Sibling-REQ cross-references use the `Dependencies:` field, NOT Notes. Same-file anchor links like `[REQ-X-NNN](#anchor)` inside Notes are a third shape that creates ambiguity with doc-pointer Notes and have a canonical home already (Dependencies). After a sub-feature split, encode the "this REQ relates to that sibling" relationship by listing the sibling REQ ID in Dependencies; do not add a Notes pointer for the same purpose.

Detection: Notes on a non-Partial REQ without a markdown link to `documentation/` or `sdd/` → MEDIUM `notes-on-non-partial-without-pointer`. Notes on a Partial REQ that exceeds 3 sentences OR contains test-name migration prose or implementation-leakage tokens (cookie names, function names, etc.) → MEDIUM `notes-partial-bloat`.

Auto-fix in `unleashed`:

- If the offending Notes contains a markdown link to an existing `documentation/**` or `sdd/**` file → reshape to doc-pointer form (`"{Subject} is documented at [link]."`); preserve the link, trim surrounding prose.
- Otherwise → fold the Notes content into the Intent paragraph (concatenate at end with a leading space) and delete the Notes field.
- For Partial-bloat: trim to ≤3 sentences naming what's unmet; if the content cannot be trimmed without losing the "what's missing" answer, emit MEDIUM `notes-partial-bloat-cannot-trim` instead (rare JUDGMENT case).

Test-name migration prose (`"test-name migration to REQ-X-NNN is pending and tracked separately"`) is a special case — this is operational tracking that belongs in `pending.md` or a GitHub issue, not in spec Notes. Auto-fix deletes the sentence and appends a one-line entry to `pending.md` naming the affected REQ and migration target.

### Rule C — Domain file preamble bans edit-history prose

The prose between an `sdd/{domain}.md` H1 and the first `---` separator (or the first `### REQ-` heading, whichever comes first) describes WHAT the domain is — its purpose, the actors involved, the boundary with adjacent domains. It is NOT a record of how the file has been edited. Edit history belongs in git log and `sdd/changes.md`.

**Scope:** Rule C applies ONLY to `sdd/{domain}.md` files — concrete domain spec files. It does NOT apply to framework metadata files that live in `sdd/` with a leading dot or a reserved name: `sdd/.review-needed.md`, `sdd/.review-decisions.md`, `sdd/.coverage-report.md`, `sdd/.last-clean-run.md`, `sdd/.skip-next-review`, `sdd/changes.md`, `sdd/changes-archive-*.md`, `sdd/glossary.md`, `sdd/constraints.md`, `sdd/README.md`, `sdd/init-triage.md`, `sdd/config.yml`. These files legitimately carry dates and edit-history prose because their entire purpose is to record state over time. Detection skips any file whose basename starts with `.`, matches `README.md`, or appears in the reserved-name list.

Forbidden patterns in domain file preamble:

- ISO dates (`\d{4}-\d{2}-\d{2}`) in any sentence
- Verb tokens describing prior edits: `refactored`, `updated`, `migrated`, `extracted from`, `moved from`, `previously contained`, `was reshaped`, `now describes`
- References to rule names (`actor-coherence`, `sub-bullets-banned`, `cross-cutting-concerns-get-their-own-REQ`, `mechanism-leakage`, etc.)
- "This file was X to apply Y" sentence pattern (regex: `^This file (was|has been)`)
- Self-referential framing ("the REQs below", "this file") that describes the file rather than the domain — soft signal; flagged only when co-occurring with one of the above

Detection: regex against the preamble block. Any match → LOW `preamble-edit-history-leakage`.

Auto-fix in `unleashed`: delete the offending paragraph(s). If the deletion describes a structural change (REQ split, REQ relocation, file creation), append a single dated entry to `sdd/changes.md`. The entry is consolidated: one entry per refactor commit, not one entry per touched file. Format: `## YYYY-MM-DD\n\n- {Refactor name}. Affected: {comma-separated REQ IDs and new file paths}.`

### Why these three together

Same failure mode at three scales. Rule A leaks at the REQ level (the REQ describes its own relationship to another REQ instead of describing user-observable behavior). Rule B leaks at the field level (Notes drifts from "what's missing" to "where mechanism lives" — currently unsanctioned). Rule C leaks at the file level (preamble drifts from "what this domain is" to "what this file's history is"). One coherent rule cluster.

Severity ladder is deliberate. A is MEDIUM (deletes a REQ — visible operation). B is MEDIUM (changes a field — could break a backlink). C is LOW (deletes prose — cosmetic). Unleashed auto-fixes all three. None requires JUDGMENT — every detection signal is regex-matchable, every fix is mechanical.

## Changelog discipline

`sdd/changes.md` is a **product changelog**, not a verification log. Strict format:

- Entries are dated (`## YYYY-MM-DD`)
- Each entry is ≤2 sentences, user-facing only
- No commit SHAs
- No "verification pass after commit XXX" entries
- No entries for spec cleanup, doc corrections, or format fixes (those are git history)
- No entries that document the agent's own operations

**When to add a changelog entry**:
- New requirement added
- Existing requirement's intent or AC changed in a way that affects users
- Requirement deprecated or moved to "Out of Scope"
- Auto-demote from Implemented → Partial (this IS a behavioral observation worth recording)

**When NOT to add a changelog entry**:
- Strikethrough cleanup
- Status field truncation (prose → one word)
- Format fixes
- Implementation leakage moved to docs
- Any change that doesn't affect what the product does

## Spec/docs/code lane separation

| Owner | Owns | Never touches |
|---|---|---|
| `spec-reviewer` agent | `sdd/` folder | `documentation/`, source code |
| `doc-updater` agent | `documentation/` folder, root `README.md` | `sdd/`, source code |
| Other agents (code-reviewer, build-error-resolver, etc.) | source code | `sdd/`, `documentation/` |

**Sequential execution after every push**: spec-reviewer runs FIRST (it's the source of truth and may move REQs), doc-updater runs SECOND (it consumes the post-edit spec to generate cross-references). Never in parallel — they would race on shared filesystem state.

## User-only enforcement bypasses (Stop hook)

The Stop hook (`enforce-review-spawn.sh`) supports three bypass methods so the **user** can choose to skip review on a specific push (trivial doc edits, emergencies, post-mortem). All three are USER-ONLY — agents must never use them:

| Bypass | Who may use it | Why |
|---|---|---|
| `sdd/.skip-next-review` sentinel file (auto-deleted on use) | User only | If the assistant could `touch` it, the entire enforcement layer would be trivially defeatable |
| `skip review` / `skip verification` magic phrase in a user message | User only (USER message text, not assistant text) | Same reason — assistant-written phrases must not bypass the gate |
| 3-strike circuit breaker (per-push counter) | Triggered by the hook itself, not invokable | After 3 blocks for the same push, assume something is genuinely stuck and let the user unblock manually |

**Hard rule for all agents**: do NOT create `sdd/.skip-next-review`, do NOT write the bypass phrase in your own output, do NOT instruct the user to add it. The hook exists to enforce SDD discipline; routing around it from inside the agent is the failure mode the hook was built to prevent.

If the review pipeline is genuinely blocking legitimate work (e.g., the hook is misfiring on a chained-pipeline detection bug), fix the hook in a separate commit rather than bypassing it.

## Operational requirements for the Stop hook

The v5 Stop hook (`enforce-review-spawn.sh`) uses `gh pr view` as its authoritative truth signal — it queries the current branch for an open PR, the PR HEAD SHA, and the PR base branch on every Stop event (with a cheap `@{u}`-based short-circuit when the local remote-tracking ref is fresh and matches the last ack). Enforcement only fires when the PR base is `main` or `master` — feature → develop PRs defer until the develop → main PR opens, mirroring the PostToolUse trigger model. Reflog is no longer read at runtime in v5; the v4 reflog mention in the script header is preserved as a documentation reference only.

This means the hook needs:
- `gh` on PATH and authenticated for the project's GitHub remote.
- `sdd/README.md` to exist (vibe-coding gate).
- The current branch's open PR (if any) must target `main` or `master` for the gate to fire. PRs into intermediate integration branches (`develop`, `staging`) are silently deferred.
- For the cheap-path optimization to fire (~200-500ms saved per Stop event in the post-review tail of a session): `git rev-parse @{u}` must resolve to a remote-tracking ref. A vanilla `git clone https://github.com/owner/repo.git` sets this up automatically.

If you cloned with `-b <branch>` and later checked out a different branch, or used `git checkout -B <branch> origin/<branch>` without `--track`, the cheap path silently won't fire and every Stop event will pay the gh round-trip. Repair tracking once with:

```bash
git branch --set-upstream-to=origin/<branch> <branch>
```

The hook is fail-safe (any unexpected error → exit 0), so missing upstream or missing gh just means the optimization or enforcement is skipped — never a hard lock-out.

### Known under-block conditions

The Stop hook deliberately under-blocks (lets a push through unreviewed) rather than over-blocks (locks the user out) in three cases:

1. **PR HEAD changed via the GitHub web UI** (amend from the UI, branch reset via API, force-push from another machine): the current Claude session has no `git push` line in its transcript, so PUSH_LINE detection exits 0 and no enforcement fires this turn. Review fires on the next local push to the branch — the new PR HEAD is still un-acked, so the next push correctly re-triggers the pipeline.
2. **Spec-reviewer subagent errored** before writing `completed</status>` for its tool-use id: doc-updater is not required and the push is allowed to proceed. The user sees the spec-reviewer failure in the agent's own report; rerunning spec-reviewer manually then satisfies the gate on the next Stop.
3. **Transcript file rotated or truncated mid-session**: PUSH_LINE detection silently exits 0. Review fires on the next push.

DRAFT PRs (`gh pr view` reports `state: OPEN` for drafts) are treated as fully open. Drafts often want early feedback, and silently skipping review on them would surprise users whose draft is the de-facto review target. Users who want a review-free WIP should defer the PR open until ready, or use a per-push USER bypass.

## Content-quality checks (CQ-1 through CQ-3)

The rules above are **structural** - they ask "does this REQ have the right shape, the right fields, the right length?" CQ-1..CQ-3 are **content-quality** - they ask "does this REQ say what it claims, and can a stranger use it?" Same shape of gap that motivated doc-discipline Passes 6-10; same shape of fix.

A spec can satisfy every structural check (zero findings) and still ship:

- REQs marked `Implemented` whose only tests mention the REQ ID in a comment but assert unrelated behavior
- AC bullets naming vendor products or external interfaces no longer present in the source
- Shrink-in-place edits that satisfy a length cap by dropping load-bearing AC clauses
- REQs whose Intent paragraph is technically present but reads as a feature list, so a fresh reader can't articulate what the feature buys the user

CQ checks run on every PR-boundary spec-reviewer trigger, after the structural checks. Mode-dependent action mirrors the structural checks: `interactive` confirms, `auto` applies CRITICAL+HIGH+MEDIUM and defers LOW, `unleashed` applies everything.

### CQ-1 — REQ-test truth-check

For every REQ marked `Status: Implemented`, walk every test file (per `test_globs`) that contains the REQ ID literally. The REQ-ID mention must satisfy both:

1. It appears in the name of a `describe` / `test` / `it` block (or the language equivalent — `def test_`, `t.Run("...")`, etc.) — not just a code comment, not just a fixture filename.
2. At least one assertion in that block references content that the REQ's ACs describe — by symbol name, by user-observable string, or by behavior the AC names.

A REQ whose only test cites the REQ ID in a code comment, in a fixture path, or in a test that asserts unrelated behavior (`expect(result.length > 0)` under a test named after the REQ) is name-drop, not coverage. Emit MEDIUM `req-test-name-only-match` naming the REQ, the cited files, and the AC bullet that has no test referencing its observable behavior. No auto-fix — writing a real test is authoring work for `tdd-guide` or the developer.

### CQ-2 — Vendor / external-interface drift

REQ ACs may reference external products and protocols (`Cloudflare Access`, `Stripe`, `OAuth 2.0`, `WCAG 2.1 AA`, ...) per the existing allowlist. For every allowlisted vendor/protocol token appearing in an `Implemented` REQ's AC bullets, the agent must find at least one mention of the same token in source (case-insensitive, allowing reasonable variants — `cf_access` counts for `Cloudflare Access`). If no source mention exists, emit MEDIUM `vendor-reference-orphaned-in-spec` naming the REQ, the AC bullet, and the orphan token.

This catches "AC mentions Stripe Checkout but the codebase removed Stripe six months ago." Spec passes structurally, ships a lie about reality. The remediation is either delete/update the AC (integration removed) or restore the source (integration lost). No auto-fix — the agent can't disambiguate.

### CQ-3 — Content-preservation on shrink

The "Shrink in place" rule and the run-on AC bullet split rule both delete content. Before committing either edit in `auto` or `unleashed` mode, the agent must check that nothing load-bearing is lost.

Tokenize the **removed** clauses. For each removed clause, the agent asks itself: does the specific subject of this clause — the named function, the named constraint, the load-bearing example — appear in any of the candidate kept locations (the kept body of the REQ, surrounding ACs, the REQ Intent, the doc file the prose is being moved to)? A clause that does **not** appear elsewhere is context-loss.

Three outcomes:

- All removed clauses match elsewhere → commit the edit.
- Context-loss with a natural relocation target (a doc file, an adjacent paragraph) → promote the clause to that target with a leading `Trimmed from REQ-X-NNN on YYYY-MM-DD:` marker, then commit the edit.
- Context-loss with no relocation target → REVERT the edit, emit MEDIUM `shrink-would-lose-load-bearing-content` listing the REQ, the edit, and the at-risk clauses. The length-cap violation persists, but the content is preserved.

## Severity classification on findings

Both `spec-reviewer` and `doc-updater` agents tag every finding with severity:

| Severity | Definition |
|---|---|
| **CRITICAL** | Spec-vs-shipped mismatch on safety/security/billing behavior. Real users could lose money or data. |
| **HIGH** | Spec doesn't match observable behavior, missing REQ for shipped feature, broken dependency chain |
| **MEDIUM** | Missing AC for known edge case, unclear Intent, conflicting cross-references, missing doc backlink to a REQ |
| **LOW** | Cleanup (format, length, strikethrough, prose Status, implementation leakage in existing REQs) |

**Mode-dependent action** (see modes section below):
- `interactive`: confirm before applying any finding's fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW to `/sdd clean`
- `unleashed`: auto-fix everything including LOW, on the current branch

## Test coverage and enforce_tdd

Every REQ marked `Status: Implemented` must have at least one test file referencing its REQ ID. Every REQ with source code must have tests covering its acceptance criteria. Both rules are enforced by spec-reviewer when `enforce_tdd: true` in `sdd/config.yml` (default: `true`).

**Test discovery** uses `test_globs` from `sdd/config.yml`. The full default list is defined in the `sdd-config.yml` template and covers vitest/jest (`tests/**/*.test.*`, `tests/**/*.spec.*`, `test/**/*.test.*`, `__tests__/**/*`), pytest (`test_*.py`, `*_test.py`), go test (`*_test.go`), rspec (`*_test.rb`), cypress (`cypress/**`), and playwright (`playwright/**`, `tests/e2e/**`, `e2e/**`).

**Source discovery** uses a built-in default list (`src/**`, `lib/**`, `app/**`, `pkg/**`, `cmd/**`, `internal/**` minus `test_globs` minus `node_modules`/`dist`/`.git`/`build`/`target`). Projects can override via an optional `src_globs` field.

**Detection is binary**: the REQ ID literally appears in a source or test file, or it doesn't. The comparison is a plain substring match; no parsing.

When `enforce_tdd: true`, spec-reviewer runs three classification passes on every push:

1. **Auto-demote**: `Implemented` REQ with no test reference → demoted to `Partial` with `Notes:` explaining the gap. Behavioral observation → changelog entry.
2. **Source-vs-test coverage**: `Planned`/`Partial` REQ with source code (REQ ID found in source) but no test → HIGH finding, auto-promote `Planned` → `Partial` with `Notes: "Code exists but no test verifies it."` Behavioral observation → changelog entry. `Implemented` REQ in the same state → handled by the auto-demote rule above.
3. **Test quality heuristics**: for every REQ with tests, count AC bullets vs test count (MEDIUM finding if mismatched), scan for tautology patterns and empty bodies (HIGH finding), and detect skipped tests (MEDIUM finding). Quality findings do not produce changelog entries.

When `enforce_tdd: false`, spec-reviewer writes `sdd/.coverage-report.md` without modifying the spec. Opt out per project if the product domain genuinely does not admit automated testing (e.g., pure visual design systems).

## SDD transition state (legacy-codebase imports)

When `/sdd init` runs in Import Mode on an existing codebase, it produces both official REQs (for behavior clear from source/tests/comments/commits) and a triage queue at `sdd/init-triage.md` for everything unclear. While any triage item carries `**Status:** open`, the project is in **SDD transition** and `sdd/config.yml` carries `transition: true`.

**During transition, the entire review pipeline is suspended.** No review agents fire automatically (PostToolUse + Stop hooks short-circuit when the transition gate condition below is true). If any review agent is invoked manually (Task tool, slash command), it MUST check the same gate condition and exit no-op with a one-line notice (`SDD transition in progress; review suspended until triage drains.`). Single rule, single gate, all enforcement layers honor it.

If `transition: true` is set in config but NO open items exist in the triage file (stuck/corrupted state, usually from a crashed closure step), the gate condition is FALSE so agents run normally; spec-reviewer additionally emits a HIGH finding to `sdd/.review-needed.md` asking the user to either re-run the closure step or clear `transition: true` manually.

`/sdd mode unleashed` is rejected while `transition: true`. Unleashed mode applies fixes without confirmation, which is incompatible with triage entries that require user judgment.

**Transition gate condition** (single source of truth across all enforcement layers):

```
IN_TRANSITION = (grep -q '^transition: true' sdd/config.yml)
                 AND (test -f sdd/init-triage.md)
                 AND (grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' sdd/init-triage.md)
```

Case-insensitive on `open` and tolerant of multiple whitespace -- the triage file is human-edited and a single-space-strict pattern is too brittle. All three conditions must be true. If `transition: true` is set but no open items exist (or the file is missing), this is corrupted state: spec-reviewer writes a HIGH finding to `.review-needed.md` and treats the run as no-transition.

When the last open triage item is resolved or marked `lost` (via Resume Mode), the closure commit:
1. Clears `transition: true` from `sdd/config.yml`
2. Appends a closure entry to `sdd/changes.md` recording totals (accepted / corrected / lost)

`enforce_tdd` is NOT touched by the closure commit. The import-time default is `enforce_tdd: false`; the user flips it to `true` manually when they're ready for full TDD enforcement (typically after adding REQ-ID references to test names in the imported source).

`sdd/init-triage.md` is preserved as the audit record. The closure commit is tagged `[sdd-init] transition complete` and is excluded from the round counter for the same reason as `[sdd-init]` resolution commits.

`sdd/init-triage.md` itself is owned by `/sdd init`. All review agents and PR-boundary hooks read it to determine transition state; nothing else writes it.

## Commit-prefix contract (load-bearing for anti-spiral)

The anti-spiral mechanism parses commit subjects by **tag prefix**, not infix. Every agent-authored commit MUST start its subject with one of the canonical tag prefixes; otherwise the spiral detectors miss it.

**Counted as agent-authored** (contribute to the round counter):

| Tag | Used by |
|---|---|
| `[autonomous]` | spec-reviewer/doc-updater in `auto` mode |
| `[unleashed]` | spec-reviewer/doc-updater in `unleashed` mode |
| `[spec-reviewer]` | manual spec-reviewer invocations that commit |
| `[doc-updater]` | doc-updater commits when distinct from `[autonomous]`/`[unleashed]` |
| `[code-reviewer]` | code-reviewer commits when distinct from above |

**Excluded** (do NOT contribute to the round counter):

| Tag | Used by |
|---|---|
| `[sdd-clean]` | `/sdd clean` runs - intentional bulk cleanup |
| `[sdd-init]` | `/sdd init` Import or Resume Mode - intentional bulk transition |
| `[sdd-triage]` | reserved for triage-tool commits |

Plain commits (no tag prefix) are treated as user-authored and reset the round counter. The counted/excluded sets are **closed** -- introducing a new tag without adding it to the table above creates a silent spiral-detector blind spot, which is a HIGH finding against the agent that introduced it.

## The 2-round commit cycle limit

Spec-reviewer and doc-updater self-limit to prevent infinite micro-fix spirals. Each agent's counter is **scoped to its own lane** so the two don't cross-contaminate (a doc-updater fix should not trip spec-reviewer's spiral guard, and vice versa):

1. At the start of every run, list the last 3 commits with their touched paths via `git log -3 --name-only --format="--- %H %s"`
2. From those, count commits whose subject starts with any tag from the **counted** set above **AND** that touched at least one path in the agent's lane:
   - **spec-reviewer** counts only commits touching `sdd/**`
   - **doc-updater** counts only commits touching `documentation/**`
3. If ≥2 of the last 3 commits qualify, hard stop
4. Write the would-be findings to `sdd/.review-needed.md` and exit
5. The counter resets when a non-agent commit lands in the agent's lane (real user code or manual edits in `sdd/` for spec-reviewer, in `documentation/` for doc-updater)

Path-based discrimination means a `[doc-updater]` commit touching only `documentation/`/* does not count toward spec-reviewer's spiral guard. Cross-cutting commits that touch BOTH `sdd/` and `documentation/` count for whichever agents own touched lanes.

The next push after `/sdd clean` or `/sdd init` is round 1, not round 3 -- excluded-tag commits do not contribute to the round count. They are not "round 0 placeholders" but rather invisible to the counter entirely; the round number is the count of counted-tag commits among the last 3. Doc-updater applies the same exclusion rule.

## User overrides

When the user reverts an automated fix or tells the agent "don't do that for this REQ", that is a normal git operation. The reverted commit stays in history; the agent's round counter sees a fresh user-authored commit and resets. No skip-list file, no ADR mechanism, no per-rule bypass keys -- if the same finding keeps re-firing, fix the underlying rule or the REQ, don't paper over it.

## Modes (set via `sdd/config.yml`)

```yaml
mode: interactive    # or 'auto' or 'unleashed'
enforce_tdd: true    # TDD enforcement. Unleashed mode refuses to run when this is false (no silent override); use `auto` if opting out per project.
test_globs:
  - "tests/**/*.test.{ts,js}"
  - "__tests__/**/*"
  - "tests/e2e/**"
# src_globs is optional; defaults to src/** lib/** app/** pkg/** cmd/** internal/**
forbidden_content_allowlist:
  protocols: true    # OAuth, JWT, etc. allowed in REQs
  vendors: true      # Cloudflare Access, Stripe, etc. allowed
  http_codes_in_api_reqs: true
forbidden_content_overrides: []  # explicit REQ IDs that opt out of forbidden checks
```

| Behavior | interactive | auto | unleashed |
|---|---|---|---|
| Where work lands | Current branch | Current branch | Current branch |
| SAFE fixes | Confirm before applying | Apply silently | Apply silently |
| RISKY fixes (truncate changes.md, mass moves) | Confirm + backup | Backup + apply | Backup + apply |
| JUDGMENT calls | Escalate to user, pause | Escalate to `sdd/.review-needed.md`, continue | **Auto-resolve conservatively** (rules below), continue |
| enforce_tdd default | per config (default true) | per config (default true) | per config; if `enforce_tdd: false`, refuse to run |
| Output | Inline confirmations | Inline reports | Inline reports; per-category commits |

The fundamental difference between modes is **how JUDGMENT is handled**. All modes push to the current branch; unleashed does not create branches or PRs.

**enforce_tdd interaction with unleashed**: prior wording said unleashed "forces enforce_tdd: true". That silently overrode a deliberate per-project opt-out (e.g., pure visual design systems where automated testing is genuinely inapplicable). The current rule is: unleashed *refuses to run* on a project with `enforce_tdd: false` and emits an explanatory finding pointing the user to either (a) flip `enforce_tdd: true` if the opt-out is no longer warranted, or (b) keep the opt-out and use `auto` mode instead. This preserves the project-level decision instead of stomping it.

## Conservative JUDGMENT auto-resolution rules (unleashed mode only)

When unleashed mode encounters a JUDGMENT call, it never picks a winner that overwrites intent. It applies the most conservative resolution that preserves data and makes the spec honest:

| JUDGMENT type | Conservative resolution |
|---|---|
| Doc-vs-spec conflict | Mark BOTH the REQ and the related doc as `Status: Partial` (or note in the doc) with `Notes:` describing the conflict. Log to `sdd/.review-needed.md`. Never overwrite either side. |
| Oversized REQ refactor | First shrink in place (extract implementation prose to `documentation/`). If still oversized: apply **Splitting by actor or concern** when an actor/cross-cutting axis exists; otherwise apply **Splitting by sub-feature** (lexical-cluster fallback, with median split as the last-resort guarantee). The AC count cap is binding - the agent never escalates "oversized REQ, no axis" to the owner; the sub-feature path always produces a split. The only residual JUDGMENT is the rare `sub-feature-split-cannot-mechanize` case where every AC is orthogonal. |
| Fake-Deprecated REQ (no Replaced By) | Move REQ definition to README's "Out of Scope" section, remove from domain file. Content preserved (satisfies "never delete" rule). |
| Mass operations (>100 changes) | No cap. Each commit is per-category for selective revert. |
| Truly ambiguous content | Mark as `Partial` with `Notes:`, log to `sdd/.review-needed.md` regardless of mode. |

## Git diff syntax for spec-reviewer

Spec-reviewer reads the diff to find what changed. Use the upstream-aware syntax to avoid breaking on first commits, rebases, and merge commits:

```bash
git diff origin/main...HEAD
# or, if origin/main isn't available:
git diff @{push}..HEAD 2>/dev/null || git diff HEAD~1..HEAD 2>/dev/null || git diff
```

Falls back gracefully when there's no upstream.

## Working tree and branch safety

Before any agent-driven write to `sdd/` or `documentation/`:

1. **Working tree must be clean**: refuse to run if `git status --porcelain` is non-empty (avoids mixing the user's WIP edits with agent commits)
2. **Current branch**: `auto` and `unleashed` modes push to whatever branch is checked out. The user is responsible for checking out the right branch before invoking (e.g., a feature branch rather than `main`). Neither mode creates a new branch or opens a PR.

## Files that live alongside `sdd/`

| File | Committed to git | Purpose |
|---|---|---|
| `sdd/config.yml` | Yes | Mode, enforce_tdd, test_globs, src_globs (optional), allowlists |
| `sdd/.review-needed.md` | Yes | Findings escalated for human review (cleared on resolution) |
| `sdd/.review-decisions.md` | Yes | Cumulative per-finding triage history (Defer/Ignore/Tech-Debt). Read by `/review` Phase 5 Reality Filter for repeat-offender detection. Append-only by Phase 8 of `/review`. |
| `sdd/.coverage-report.md` | Yes | Output of enforce_tdd: false runs |
| `sdd/.last-clean-run.md` | Yes | Audit log of the most recent /sdd clean run |
| `sdd/changes-archive-*.md` | Yes | Archived old changelogs from /sdd clean runs |
| `sdd/init-triage.md` | Yes | Open / resolved / lost items from `/sdd init` Import Mode. Owned by `/sdd init`. Presence of any `Status: open` item triggers transition state (auto-demote suppressed; `unleashed` rejected). Preserved as audit record after queue drains. |

Nothing in `sdd/` is gitignored. Everything is part of the project's history.
