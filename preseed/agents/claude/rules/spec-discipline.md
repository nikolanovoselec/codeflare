# Spec Discipline (SDD-Bootstrapped Projects)

These rules apply to any project that has an `sdd/` folder. They are loaded into every agent's instructions automatically. If `sdd/` does not exist in the project, these rules are inert — ignore them.

The full SDD workflow lives in the `spec-driven-development` skill. These rules are the non-negotiable enforcement layer that runs even when the skill is not explicitly invoked.

**Sibling rule files**:
- `documentation-discipline.md` — what may NOT appear in `documentation/`, per-file/per-cell budgets, lane separation. Enforced by doc-updater.
- `tdd-discipline.md` — what counts as a real test (no text-matching theater, no tautology, no mock-only theater). Enforced by code-reviewer.

Together the three files define the spec / docs / tests lane discipline. spec-reviewer enforces this file.

## What the spec is

`sdd/` is the single source of truth for **what the product does and why**. It is not a record of what the code currently does. It is not a bug tracker. It is not a changelog of every commit. It is the target state the product is trying to reach.

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
| Database column names (`email_status`, `apartment_id`) | `documentation/architecture.md` |
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

The project's `sdd/config.yml` can override the allowlist via `forbidden_content_allowlist` and `forbidden_content_overrides` fields.

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

## REQ length guidance

REQs describing complex features can be long, but length is a smell:

| Length | Severity |
|---|---|
| ≤25 lines | OK |
| 26–50 lines | LOW finding (consider extracting implementation prose to docs) |
| 51–100 lines | MEDIUM finding (likely contains implementation leakage) |
| >100 lines | HIGH finding (almost certainly mixing intent and implementation) |

Oversized REQs are shrunk in place (extract implementation prose to `documentation/`) - never split, never auto-proposed for split. The user can manually split a REQ in a follow-up if needed.

## Acceptance criteria guidance

- Each AC bullet is **binary pass/fail**, testable in principle
- 3-7 bullets is typical; >10 is a smell that the REQ likely covers multiple concerns
- Avoid "should" -- use "must" or describe the observable outcome
- Avoid vague terms like "responsive", "fast", "user-friendly" -- specify the criterion (e.g., "loads in under 2 seconds on 4G mobile")

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
| Oversized REQ refactor | Shrink in place — extract implementation prose to `documentation/{relevant-file}.md` and leave Intent + AC bullets verbatim in the REQ. Never split into multiple REQs (LLMs cannot reliably preserve meaning when splitting). |
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
