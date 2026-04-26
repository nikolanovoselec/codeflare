# Spec Discipline (SDD-Bootstrapped Projects)

These rules apply to any project that has an `sdd/` folder. They are loaded into every agent's instructions automatically. If `sdd/` does not exist in the project, these rules are inert — ignore them.

The full SDD workflow lives in the `spec-driven-development` skill. These rules are the non-negotiable enforcement layer that runs even when the skill is not explicitly invoked.

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

## User overrides

When a user reverts an automated fix or explicitly tells the agent "don't do that", the override is recorded in `sdd/.user-overrides.md` (committed to git). Format:

```markdown
# User Overrides

## auto-demote:REQ-VD-1
- Date: 2026-04-07
- User note: Visual design REQs don't have unit tests by nature; manual verification only.
- Skip: yes

## move-to-out-of-scope:REQ-AP-7
- Date: 2026-04-07
- User note: Keep as Deprecated history, don't move to Out of Scope.
- Skip: yes
```

Each entry is keyed by `{rule_id}:{target_id}`. Spec-reviewer reads this file at the start of every run and skips any finding whose key matches an override entry. Once an override exists, the agent never re-attempts the same change.

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
| `sdd/.user-overrides.md` | Yes | User decisions to skip specific findings |
| `sdd/.review-needed.md` | Yes | Findings escalated for human review (cleared on resolution) |
| `sdd/.coverage-report.md` | Yes | Output of enforce_tdd: false runs |
| `sdd/.last-clean-run.md` | Yes | Audit log of the most recent /sdd clean run |
| `sdd/changes-archive-*.md` | Yes | Archived old changelogs from /sdd clean runs |

Nothing in `sdd/` is gitignored. Everything is part of the project's history.
