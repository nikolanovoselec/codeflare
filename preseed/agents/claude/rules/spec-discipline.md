# Spec Discipline (Core)

Applies to any project with an `sdd/` folder. Inert otherwise. This core rule states what a real requirement is and where things live. Detection algorithms, manifest execution, splitting mechanics, and content-quality checks live in the `spec-enforce*` skill family.

Siblings: `documentation-discipline.md` (doc-updater), `tdd-discipline.md` (code-reviewer). Workflow in the `spec-driven-development` skill.

## What the spec is

`sdd/` is the single source of truth for **what the product does and why**. Not a record of current code, a bug tracker, or a commit changelog. Target state the product is reaching for. The reader is a developer who already knows what the product does and now needs to navigate the spec.

## Spec / docs / code lane separation

| Owner | Owns | Never touches |
|---|---|---|
| `spec-reviewer` | `sdd/` | `documentation/`, source code |
| `doc-updater` | `documentation/`, root `README.md` | `sdd/`, source code |
| Other agents (code-reviewer, etc.) | source code | `sdd/`, `documentation/` |

**Sequential execution after every PR-boundary trigger**: spec-reviewer FIRST, doc-updater SECOND. Never in parallel; they race on shared filesystem state.

## Status vocabulary

Every REQ has one Status value. **One word, no prose.**

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted, not yet committed |
| `Planned` | Committed, not yet built |
| `Partial` | Built but some AC unmet OR no automated verification found |
| `Implemented` | Built AND tests verify the ACs |

Status transitions and auto-fix behaviour live in the `spec-enforce` skill.

Out-of-scope ideas (never-built) go to "Out of Scope" in the domain README, not to a `Deprecated` Status. `Deprecated` is not a valid Status; existing entries are deleted (mechanism in `spec-enforce`).

## What is NOT a requirement

- **Bugs**: GitHub issues. The spec describes target state; bugs are the delta.
- **TODOs / known gaps**: `pending.md`. Status: Partial flags incompleteness; prose details go in `pending.md`.
- **Spec churn**: git history. No strikethrough or "Superseded:" annotations in spec.
- **Build environment quirks**: `documentation/troubleshooting.md`.
- **Out-of-scope ideas**: "Out of Scope" section in the domain README.

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

## Modes (set via `sdd/config.yml`)

`sdd/config.yml` carries `mode` (`interactive`|`auto`|`unleashed`), `enforce_tdd` (bool), `test_globs`, optional `src_globs`, `forbidden_content_allowlist`, `forbidden_content_overrides`.

| Behaviour | interactive | auto | unleashed |
|---|---|---|---|
| SAFE fixes | Confirm | Apply silently | Apply silently |
| RISKY fixes | Confirm + backup | Backup + apply | Backup + apply |
| JUDGMENT | Escalate, pause | Escalate to `.review-needed.md`, continue | Auto-resolve conservatively, continue |
| Output | Inline confirmations | Inline reports | Per-category commits |

All modes push the current branch; unleashed creates no branches or PRs. Unleashed refuses to run on `enforce_tdd: false` (no silent override).

## User overrides

User revert or "don't do that for this REQ" is a normal git operation. Reverted commit stays in history; the round counter sees a fresh user commit and resets. No skip-list, no ADR, no per-rule bypass.

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

## Enforcement skill family

Detection algorithms, manifest execution, splitting mechanics, content-quality checks, auto-fix algorithms, and severity application live in the `spec-enforce*` skill family.

| Skill | Contents | When invoked |
|---|---|---|
| `spec-enforce` (spine) | 18-row execution manifest, REQ rendering template, length guidance, forbidden content + allowlist, status transitions, deprecated deletion, meta-leakage Rules A/B/C, changelog drift + discipline, backlog re-triage, SDD transition state, commit-prefix contract, 2-round limit, JUDGMENT auto-resolution, git diff syntax | Every PR-boundary trigger + `/sdd clean` |
| `spec-enforce-ac` | AC count cap, granularity triggers 1-10, run-on, actor coherence, sub-bullets ban, splitting (chain, cross-cutting, concern-boundary, accretion guard, by actor/concern, by sub-feature), mechanism leakage in AC bullets | When diff touches any AC bullet OR scope=all |
| `spec-enforce-truth` | CQ-1 (REQ-test truth-check, Subclass A/B), CQ-2 (vendor drift), CQ-3 (content-preservation on shrink), test coverage and enforce_tdd interaction | When Implemented REQ in diff OR scope=all |

### Binding invocation rules

- **On every PR-boundary trigger** (spec-reviewer fires on PR sync to main/master): invoke `spec-enforce` skill as the turn's first action, against the current diff. The skill's manifest contract ("every row executes on every run") binds inside the skill body. The spine decides which detail skills to invoke based on diff content.
- **On `/sdd clean`** (any scope): invoke `spec-enforce` with `scope=all` or `scope=diff` as the first action.
- **On manual audit invocation**: invoke with the user-specified scope.
- **On follow-up turns** (responding to a question about a prior finding, applying a user-confirmed fix from an earlier-found issue): skill invocation is OPTIONAL. The core rule above carries enough context to answer most questions.

Skipping enforcement invocation when the trigger fires is itself a HIGH finding `enforcement-skill-not-invoked`, caught by the manifest's own audit log (the skill writes its execution row to `sdd/.last-clean-run.md` or the agent's commit body; absence is detectable).

## Commit-prefix contract (summary)

Anti-spiral parses commit subjects by tag prefix. Every agent-authored commit MUST start with one of the canonical prefixes:

- **Counted as agent-authored**: `[autonomous]`, `[unleashed]`, `[spec-reviewer]`, `[doc-updater]`, `[code-reviewer]`
- **Excluded** (intentional bulk operations): `[sdd-clean]`, `[sdd-init]`, `[sdd-triage]`

Plain commits (no prefix) are user-authored and reset the round counter. Full contract + the 2-round limit detection mechanics live in `spec-enforce`.
