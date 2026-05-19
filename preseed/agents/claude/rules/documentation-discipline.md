# Documentation Discipline

Applies when `sdd/` AND `documentation/` both exist. Inert otherwise.

**Trigger:**
- PR-boundary event → doc-updater fires (sequentially after spec-reviewer).
- `/sdd clean` invocation.

**Route:** invoke the `doc-enforce` skill (spine). It runs the 14-row execution manifest and conditionally invokes `doc-enforce-lanes` (per file in diff), `doc-enforce-shape` (when canonical lane files touched), and `doc-enforce-truth` (when Implemented REQ docs touched or scope=all).

## What documentation is

`documentation/` is the **how** layer: how things are wired, what env vars exist, what HTTP routes return, where files live, why a technology was chosen. Not the spec (`sdd/`), not the changelog (`sdd/changes.md`), not the README.

Reader is a developer who already knows what the product does and needs to navigate the implementation. Every page answers one operational question quickly.

## Lane separation

| File | Owns | Never owns |
|---|---|---|
| `architecture.md` | Component layout, data flow, file/folder structure, technology choices, schema overviews | API contracts, env vars, deploy steps, troubleshooting |
| `api-reference*.md` | HTTP routes, request/response schemas, status codes, per-endpoint auth | Architecture rationale, env values, deploy steps |
| `configuration.md` | Env var names, defaults, valid values, consumption points | API contracts, architecture rationale, deploy commands |
| `deployment.md` | Deploy commands, CI workflow names, rollback, secret rotation | API contracts, env docs (link to configuration.md) |
| `security.md` | Threat model, auth flow, cookie/header policies, rate limits | Per-endpoint auth (link to api-reference.md) |
| `troubleshooting.md` | Symptom → cause → fix recipes, build-tool quirks, runtime gotchas | Architecture, env vars, deploy (link) |
| `decisions/README.md` | All ADRs in a single ledger: index table at top, one `### AD-N: Title` section per decision below (Status/Context/Decision/Consequences) | Non-ADR content; runbook prose; spec REQs |

## Severity / mode

Same scale as `spec-discipline.md`. CRITICAL/HIGH/MEDIUM/LOW with the same mode-dependent action.

## REQ backlinks

Every documented feature should reference the REQ that specifies it. Inline `(REQ-X-NNN)` immediately after the feature name in a heading or first sentence. Detection + auto-fix in `doc-enforce`.

## Files alongside `documentation/`

`documentation/decisions/README.md`, `documentation/.doc-coverage.md`, `documentation/.review-needed.md`. All committed; nothing in `documentation/` is gitignored.

Skipping `doc-enforce` invocation when the trigger fires is itself HIGH `enforcement-skill-not-invoked`.
