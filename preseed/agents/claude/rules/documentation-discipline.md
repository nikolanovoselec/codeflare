# Documentation Discipline

Applies when `sdd/` AND `documentation/` both exist. Inert otherwise.

**Trigger:**
- PR-boundary event → doc-updater fires (sequentially after spec-reviewer).
- `/sdd clean` invocation.

**Route:** invoke the `doc-enforce` skill (spine). Runs the 16-row execution manifest and conditionally invokes `doc-enforce-lanes` (per file in diff: lane-violation catalog), `doc-enforce-shape` (when canonical lane files touched: api-reference rendering), and `doc-enforce-truth` (when Implemented REQ docs touched or scope=all). REQ-backlink detection + auto-fix and forbidden-content allowlist live in `doc-enforce`.

## Lane summary (mid-task keepsake)

`architecture.md` (system map and authority), `api-reference*.md` (HTTP routes), `configuration.md` (settings and consumers), `deployment.md` (deploy/verify/rollback), `security.md` (threats and controls), `observability.md` (signals and escalation), `troubleshooting.md` (symptom→cause→fix→verify), indexed first-level project lanes (unowned project concerns), and `decisions/README.md` (ADR ledger). ADR indexes strike fully superseded records, keep partially superseded records visible, and label merged/reclassified tombstones `Redirect anchor`; Security source maps link every ADR and requirement domain directly. `/sdd init`, `/sdd clean`, and review use the bundled `spec-driven-development/references/templates/documentation-*.md` shapes; the full owns / never-owns catalog lives in `doc-enforce-lanes`.

## Severity / mode

Same scale as `spec-discipline.md` (CRITICAL/HIGH/MEDIUM/LOW with the same mode-dependent action).

Skipping `doc-enforce` invocation when the trigger fires is itself HIGH `enforcement-skill-not-invoked`.
