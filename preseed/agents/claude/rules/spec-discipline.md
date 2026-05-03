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

A REQ may opt out of length warnings with an HTML comment: `<!-- sdd-allow-large -->`. Use sparingly and only for genuinely complex features whose full surface needs to live in one place.

## Acceptance criteria guidance

- Each AC bullet is **binary pass/fail**, testable in principle
- 3–7 bullets is typical; >10 is a smell that the REQ should be split
- Avoid "should" — use "must" or describe the observable outcome
- Avoid vague terms like "responsive", "fast", "user-friendly" — specify the criterion (e.g., "loads in under 2 seconds on 4G mobile")

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

The v5 Stop hook (`enforce-review-spawn.sh`) uses `gh pr view` as its authoritative truth signal — it queries the current branch for an open PR and the PR HEAD SHA on every Stop event (with a cheap `@{u}`-based short-circuit when the local remote-tracking ref is fresh and matches the last ack). Reflog is no longer read at runtime in v5; the v4 reflog mention in the script header is preserved as a documentation reference only.

This means the hook needs:
- `gh` on PATH and authenticated for the project's GitHub remote.
- `sdd/README.md` to exist (vibe-coding gate).
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

In `unleashed` mode, `enforce_tdd: true` is forced — the commits on the current branch are fully autonomous, so TDD enforcement is non-negotiable.

## Source code ↔ REQ annotations

Source files implementing a requirement must reference the REQ ID in a comment so spec-reviewer can detect code-without-tests by grep. Without annotations, the source-vs-test check has nothing to match and silently passes broken code.

**Format** (match the file's language):

| Language / file type | Example |
|---|---|
| TypeScript, JavaScript, Java, C, Go, Rust | `// Implements REQ-SITE-002` |
| JSDoc block above a function or class | `/** Implements REQ-SITE-002 */` |
| Python, Ruby, shell, YAML, TOML | `# Implements REQ-API-001` |
| HTML, Astro, Svelte, Vue template | `<!-- Implements REQ-UI-003 -->` |
| CSS, SCSS | `/* Implements REQ-BRAND-001 */` |

**Rules:**

- Every source file implementing observable behavior from one or more REQs must contain at least one `Implements REQ-X-NNN` comment for each REQ it implements. Place at the top of the file or inline at the function/class level in multi-REQ files.
- spec-reviewer greps for the literal REQ ID substring. The "Implements" keyword is a convention for humans, not a parser token — any comment mentioning the REQ ID counts.
- When refactoring, annotations move with the code. When code is deleted, annotations are deleted. Never leave orphan annotations pointing at moved or removed code.
- Tests already name the REQ ID in their test function name (`test('REQ-X-NNN: rejects expired token', ...)`) — no additional annotation needed in test files.
- Multiple REQs per file: list each separately. Do not concatenate (`Implements REQ-A-001, REQ-A-002` is ambiguous — write two comments).

**Agent responsibilities:**

- **Code-writing agents** (`tdd-guide`, `build-error-resolver`, `refactor-cleaner`, `security-reviewer`, any agent writing new source files): add or preserve annotations for every REQ the code implements
- **Code-reviewing agents** (`code-reviewer`): flag source files that implement observable behavior matching a REQ's AC but lack an annotation (MEDIUM finding)
- **Spec-reviewer**: runs the source-vs-test coverage check above on every push

## The 2-round commit cycle limit

Spec-reviewer and doc-updater self-limit to prevent infinite micro-fix spirals:

1. At the start of every run, check the last 3 commits via `git log -3 --format="%s"`
2. Count commits whose subject starts with `[autonomous]`, `[unleashed]`, or `[spec-reviewer]` — **NOT `[sdd-clean]`**, which is explicitly excluded
3. If ≥2 of the last 3 commits are agent-authored on the **same target REQ-ID or category**, hard stop
4. Write the would-be findings to `sdd/.review-needed.md` and exit
5. The counter resets when a non-agent commit lands (real user code or manual edits)

Commits made by `/sdd clean` are tagged `[sdd-clean]` and **excluded** from the round detection — `/sdd clean` may make many commits in succession without triggering the limit on itself. The next push after `/sdd clean` is round 1, not round 3. Doc-updater applies the same exclusion rule.

## Spiral detection across runs

Beyond the 2-round limit, spec-reviewer detects slow-drip spirals via git log analysis (no local file dependency):

```
git log --since="7 days ago" --grep="\[autonomous\]" --grep="\[unleashed\]" --format="%s"
```

If the last 100 agent commits are >80% the same fix category (parsed from the commit subject's `fix(spec): {category}` portion), pause that category for 24 hours and write a note to `sdd/.review-needed.md`. Other categories continue normally. The user can resume by pushing a commit that touches the relevant REQ themselves (manual override).

## User overrides via ADRs

When the user reverts an automated fix or tells the agent "don't do that for this REQ — that mechanism IS the contract", the resolution is an architectural decision and is recorded as an ADR in `documentation/decisions/`, NOT in any skip-list file. The ADR carries an `Overrides:` header that spec-reviewer and doc-updater grep at the start of every run.

```markdown
### AD-N: {Decision title}

**Status:** Accepted ({YYYY-MM-DD})
**Overrides:** mechanism-leakage:REQ-AUTH-002, mechanism-leakage:REQ-AUTH-003

**Context:** {What the agent flagged and why the rule normally fires.}

**Decision:** {What the user decided — keep current behavior, treat
the mechanism as the contract, etc.}

**Rationale:** {Why this choice over rewriting to user-observable language.}

**Consequences:** {What downstream code/docs must keep in lockstep.}

**Related requirements:** REQ-AUTH-002, REQ-AUTH-003
```

The `Overrides:` line is the parser anchor. Each entry is `{rule_id}:{target_id}` — same key shape spec-reviewer used for the legacy skip list. `target_id` is a REQ ID like `REQ-X-NNN` or `*` for "all REQs in scope of the rule". Multiple keys are comma-separated.

Why ADRs and not a skip-list file:

- Discoverable from the project's docs index (`documentation/decisions/README.md`) instead of buried in `sdd/.user-overrides.md`.
- Structured (Context / Decision / Rationale / Consequences) — a future contributor reading the auth REQs sees the prior reasoning instead of re-litigating the same call.
- Backlinks REQs in a parseable form, can be revised with full Status history (`Accepted` → `Superseded by AD-M`).
- Same machine behavior (skippable by spec-reviewer via the same `{rule}:{target}` key) but the *decision* is now first-class architecture.

The legacy `sdd/.user-overrides.md` file is removed (issue codeflare#266). When `/sdd clean` encounters one, it converts each entry to an ADR with the `User note:` field expanded into the Context/Rationale fields, then deletes the file in the same commit.

## Modes (set via `sdd/config.yml`)

```yaml
mode: interactive    # or 'auto' or 'unleashed'
enforce_tdd: true    # TDD enforcement (forced true in unleashed mode); opt out per project if needed
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
| enforce_tdd default | per config (default true) | per config (default true) | **forced true** |
| Output | Inline confirmations | Inline reports | Inline reports; per-category commits |

The fundamental difference between modes is **how JUDGMENT is handled**. All modes push to the current branch; unleashed does not create branches or PRs.

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
2. **Branch protection**: in `auto` and `unleashed` modes, refuse to run on `main` or `master` without `--branch-confirmed`. Neither mode creates a new branch; both push to the current branch.

## Files that live alongside `sdd/`

| File | Committed to git | Purpose |
|---|---|---|
| `sdd/config.yml` | Yes | Mode, enforce_tdd, test_globs, src_globs (optional), allowlists |
| `sdd/.review-needed.md` | Yes | Findings escalated for human review (cleared on resolution) |
| `sdd/.coverage-report.md` | Yes | Output of enforce_tdd: false runs |
| `sdd/.last-clean-run.md` | Yes | Audit log of the most recent /sdd clean run |
| `sdd/changes-archive-*.md` | Yes | Archived old changelogs from /sdd clean runs |

Nothing in `sdd/` is gitignored. Everything is part of the project's history.
