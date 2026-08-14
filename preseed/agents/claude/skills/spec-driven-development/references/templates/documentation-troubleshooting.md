# {PROJECT_NAME} Troubleshooting

**Audience:** Operators and developers diagnosing known failures.

**Owns:** Symptom, diagnosis, cause, fix, verification, and escalation recipes.

**Does not own:** Deployment procedures or architecture rationale.

## Contents

- [Start Here](#start-here)
- [Troubleshooting Recipes](#troubleshooting-recipes)
- [Failure Index](#failure-index)
- [Diagnostic Reference](#diagnostic-reference)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Start Here

State the safest first checks and the identifiers an operator should capture before changing anything.

## Troubleshooting Recipes

### {SYMPTOM_TITLE}

**Symptom:** {Observable failure.}

**Diagnose:** {Non-destructive checks in order.}

**Cause:** {Verified cause or bounded likely causes.}

**Fix:** {Smallest safe corrective action.}

**Verify:** {Observable evidence that service recovered.}

**Escalate:** {Condition and evidence to hand off.}

## Failure Index

| Symptom | Cause | Fix |
|---|---|---|
| {Symptom} | {Cause summary} | [Recipe](#symptom-title) |

## Diagnostic Reference

Keep reusable read-only commands here. Link destructive actions to Deployment runbooks.

## Requirement and Source Map

| Recipe family | Requirements | Source owner | Evidence |
|---|---|---|---|
| {Family} | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001) | `{PATH}::{SYMBOL}` | `{TEST_PATH}` |

## Related Documentation

{Links to emitted Architecture, Deployment, Observability, and Security lanes.}
