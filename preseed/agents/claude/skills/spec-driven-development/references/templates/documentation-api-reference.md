# {PROJECT_NAME} API Reference

**Audience:** Integrators, client authors, and operators diagnosing request behavior.

**Owns:** Route, authorization, request, response, error, rate-limit, requirement, and source contracts.

**Does not own:** Architecture rationale, configuration values, or deployment procedures.

## Contents

- [Contract Conventions](#contract-conventions)
- [Endpoint Register](#endpoint-register)
- [Detailed Contracts](#detailed-contracts)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Contract Conventions

Document the shared authentication vocabulary, error envelope, pagination, and response headers once.

## Endpoint Register

Group endpoints by resource family. Add detailed contracts only when request, response, or failure behavior cannot fit the register safely.

### {RESOURCE_FAMILY}

| Method | Path | Auth | Implements | Description |
|---|---|---|---|---|
| `{METHOD}` | `{PATH}` | {AUTH_BOUNDARY} | [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001) | {OBSERVABLE_BEHAVIOR} |

## Detailed Contracts

### {METHOD} `{PATH}`

**Request:** {REQUEST_CONTRACT}

**Response:** {RESPONSE_CONTRACT}

**Errors:** {ERROR_CONTRACT}

**Source:** `{SOURCE_PATH}::{SYMBOL}`

**Implements:** [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001)

## Requirement and Source Map

| Resource family | Source owner | Requirements | Behavioral evidence |
|---|---|---|---|
| {RESOURCE_FAMILY} | `{SOURCE_PATH}` | [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001) | `{TEST_PATH}` |

## Related Documentation

{RELATED_DOCUMENTATION}
