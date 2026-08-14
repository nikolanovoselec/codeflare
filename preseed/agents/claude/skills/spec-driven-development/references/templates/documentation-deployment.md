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

**When:** {Reviewed artifact and target preconditions.}

**Prerequisites:** {Required access, checks, and immutable artifact identity.}

**Action:**

```sh
{DEPLOY_COMMAND}
```

**Verify:** {Observable health, version, or smoke-test result.}

**Rollback:** {Exact prior artifact or command and rollback verification.}

## Rollback

**When:** {Failure conditions that require rollback.}

**Prerequisites:** {Prior version, digest, or release identifier.}

**Action:**

```sh
{ROLLBACK_COMMAND}
```

**Verify:** {Evidence that the previous release is restored.}

**Rollback:** Escalate rather than applying another unreviewed change if restoration fails.

## Development Reference

Keep local development commands separate from production runbooks.

## Requirement and Source Map

| Procedure | Requirements | Source owner | Evidence |
|---|---|---|---|
| Standard deployment | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001) | `{WORKFLOW_PATH}` | {Workflow or smoke-test link} |

## Related Documentation

{Links to emitted Architecture, Configuration, Security, Observability, and Troubleshooting lanes.}
