# Documentation Discipline (Core)

Applies whenever a project has both `sdd/` AND `documentation/`. Inert otherwise. This core rule states what real documentation is and where things live. Detection algorithms, manifest execution, per-element + per-file budgets, lane-violation catalogues, format templates, truth-check passes, and authoring-quality checks live in the `doc-enforce*` skill family. Sibling: `spec-discipline.md` (spec-reviewer).

## What documentation is

`documentation/` is the **how** layer: how things are wired, what env vars exist, what HTTP routes return, where files live, why a particular technology was chosen. Not the spec (`sdd/`), not the changelog (`sdd/changes.md`), not the README.

The reader is a developer who already knows what the product does and now needs to navigate the implementation. Every page answers one operational question quickly.

## Lane separation

| File | Owns | Never owns |
|---|---|---|
| `architecture.md` | Component layout, data flow, file/folder structure, technology choices, schema overviews | API contracts, env vars, deploy steps, troubleshooting |
| `api-reference*.md` | HTTP routes, request/response schemas, status codes, per-endpoint auth | Architecture rationale, env values, deploy steps |
| `configuration.md` | Env var names, defaults, valid values, consumption points | API contracts, architecture rationale, deploy commands |
| `deployment.md` | Deploy commands, CI workflow names, rollback, secret rotation | API contracts, env documentation (link to configuration.md) |
| `security.md` | Threat model, auth flow, cookie/header policies, rate limits | Per-endpoint auth (link to api-reference.md) |
| `troubleshooting.md` | Symptom -> cause -> fix recipes, build-tool quirks, runtime gotchas | Architecture, env vars, deploy (link) |
| `decisions/README.md` | All ADRs in a single ledger: index table at top with rows linked to in-file `### AD-N` anchors below, followed by one `### AD-N: Title` section per decision (Status, Context, Decision, Consequences) | Non-ADR content; runbook prose; spec REQs |

## Severity classification

| Severity | Definition |
|---|---|
| **CRITICAL** | Doc claims behaviour that contradicts shipped code in a security/data-loss-misleading way |
| **HIGH** | Implementation-prose paragraph with no REQ; dual-narrative ADR; doc references removed function/file/route; monolithic decisions README; file >2x soft budget |
| **MEDIUM** | Lane violation; cell >50 words; file 1x-2x budget; missing REQ backlink; ADR missing Status; index-table ID not linked; REQ ref in non-API TOC |
| **LOW** | Cell 40-50 words; file 0.8x-1x budget (approaching); inconsistent heading capitalisation; broken intra-doc anchor link |

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW
- `unleashed`: auto-fix everything including LOW

## Modes

Same as `spec-discipline.md`: `mode` (`interactive`|`auto`|`unleashed`) set via `sdd/config.yml`. All modes push the current branch; unleashed creates no branches or PRs.

## Working tree and branch safety

Same rules as spec-reviewer:
1. Working tree must be clean.
2. `auto` and `unleashed` push to whatever branch is currently checked out.

## Files alongside `documentation/`

| File | Committed | Purpose |
|---|---|---|
| `documentation/decisions/README.md` | Yes | ADR ledger; index table at top with rows linked to in-file `### AD-N` anchors, followed by one section per ADR |
| `documentation/.doc-coverage.md` | Yes | Output of doc-updater coverage runs and Pass 4 proposed-move plans |
| `documentation/.review-needed.md` | Yes | Doc findings escalated for human review |

Nothing in `documentation/` is gitignored.

## Enforcement skill family

Detection algorithms, manifest execution, per-element + per-file budgets, lane-violation catalogues, format templates, truth-check passes, and authoring-quality checks live in the `doc-enforce*` skill family.

| Skill | Contents | When invoked |
|---|---|---|
| `doc-enforce` (spine) | 14-row execution manifest, forbidden content + allowlist, per-element budgets, per-file line budgets, Pass 1 (per-element), Pass 2 (per-file), Pass 13 (within-section semantic 3-trigger), Pass 14 (authoring quality / reviewer-with-a-brain), REQ backlinks rule | Every PR-boundary trigger + `/sdd clean` |
| `doc-enforce-lanes` | Pass 3 (implementation-prose detection), Pass 4 (lane-violation signature catalogue), dual-narrative ADR detection, Big-O jargon detection | Per file in diff |
| `doc-enforce-shape` | Per-lane format templates (6 lane tables), jump-TOC at file top, TOC content rule, index-table link rule, Pass 5 (format-template field presence), Pass 6 (file-level shape consistency), Pass 7 (canonical per-endpoint rendering binding template) | When api-reference*.md or canonical lane file touched in diff OR scope=all |
| `doc-enforce-truth` | Pass 8 (verification truth-check), Pass 9 (Implements-vs-AC cross-walk), Pass 10 (stale code-block detection), Pass 11 (content-preservation on trim), Pass 12 (stranger cold-read with task registry) | When Implemented REQ docs touched OR scope=all |

### Binding invocation rules

- **On every PR-boundary trigger** (doc-updater fires on PR sync to main/master, sequentially after spec-reviewer): invoke `doc-enforce` skill as the turn's first action, against the current diff. The skill's manifest contract ("every row executes on every run") binds inside the skill body. The spine decides which detail skills to invoke based on diff content.
- **On `/sdd clean`** (any scope): invoke `doc-enforce` with `scope=all` or `scope=diff`.
- **On manual audit invocation**: invoke with the user-specified scope.
- **On follow-up turns** (responding to a question about a prior finding): skill invocation is OPTIONAL.

Skipping enforcement invocation when the trigger fires is itself a HIGH finding `enforcement-skill-not-invoked`, caught by the manifest's own audit log.

## REQ backlinks in documentation/

Every documented feature should reference the REQ that specifies it. Format: inline `(REQ-X-NNN)` immediately after the feature name in a heading or first sentence.

```markdown
## Inquiry email delivery (REQ-API-002)
```

The detection mechanics and auto-fix behaviour live in `doc-enforce`.
