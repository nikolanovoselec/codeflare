# {PROJECT_NAME} Deployment

**Audience:** Operators releasing, verifying, and rolling back the project.

**Owns:** Executable deployment, verification, and rollback runbooks.

**Does not own:** Architecture rationale, configuration inventories, or private credentials.

## Contents

- [Standard Deployment](#standard-deployment)
- [Rollback](#rollback)
- [Development Reference](#development-reference)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Standard Deployment

**When:** {DEPLOY_WHEN}

**Prerequisites:** {DEPLOY_PREREQUISITES}

**Action:**

```sh
{DEPLOY_COMMAND}
```

**Verify:** {DEPLOY_VERIFICATION}

**Rollback:** {DEPLOY_ROLLBACK}

## Rollback

**When:** {ROLLBACK_WHEN}

**Prerequisites:** {ROLLBACK_PREREQUISITES}

**Action:**

```sh
{ROLLBACK_COMMAND}
```

**Verify:** {ROLLBACK_VERIFICATION}

**Rollback:** Escalate rather than applying another unreviewed change if restoration fails.

## Development Reference

Keep local development commands separate from production runbooks.

## Requirement and Source Map

| Procedure | Requirements | Source owner | Evidence |
|---|---|---|---|
| Standard deployment | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001) | `{WORKFLOW_PATH}` | {DEPLOY_EVIDENCE} |

## Related Documentation

{RELATED_DOCUMENTATION}
