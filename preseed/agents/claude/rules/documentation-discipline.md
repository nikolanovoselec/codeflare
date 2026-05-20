# Documentation Discipline

Applies when `sdd/` AND `documentation/` both exist. Inert otherwise.

**Trigger:**
- PR-boundary event → doc-updater fires (sequentially after spec-reviewer).
- `/sdd clean` invocation.

**Route:** invoke the `doc-enforce` skill (spine). Runs the 15-row execution manifest and conditionally invokes `doc-enforce-lanes` (per file in diff: lane-violation catalog), `doc-enforce-shape` (when canonical lane files touched: api-reference rendering), and `doc-enforce-truth` (when Implemented REQ docs touched or scope=all). REQ-backlink detection + auto-fix and forbidden-content allowlist live in `doc-enforce`.

## Lane summary (mid-task keepsake)

`architecture.md` (layout/data-flow), `api-reference*.md` (HTTP routes), `configuration.md` (env vars), `deployment.md` (deploy/rollback), `security.md` (threat model/auth), `troubleshooting.md` (symptom→cause→fix), `decisions/README.md` (ADR ledger). Each owns one operational slice; the full owns / never-owns catalog lives in `doc-enforce-lanes`.

## Severity / mode

Same scale as `spec-discipline.md` (CRITICAL/HIGH/MEDIUM/LOW with the same mode-dependent action).

Skipping `doc-enforce` invocation when the trigger fires is itself HIGH `enforcement-skill-not-invoked`.
