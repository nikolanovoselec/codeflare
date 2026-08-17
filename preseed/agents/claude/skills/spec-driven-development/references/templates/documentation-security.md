# {PROJECT_NAME} Security

**Audience:** Engineers, operators, and reviewers evaluating trust boundaries and failure posture.

**Owns:** Threats, controls, residual risks, security verification, and source ownership.

**Does not own:** Secret values or private operational credentials.

## Contents

- [Security Posture](#security-posture)
- [Threat Model](#threat-model)
- [Controls and Failure Posture](#controls-and-failure-posture)
- [Accepted Exceptions and Residual Risks](#accepted-exceptions-and-residual-risks)
- [Verification and Source Map](#verification-and-source-map)
- [Related Documentation](#related-documentation)

## Security Posture

Summarize the trust model and default fail-open or fail-closed posture.

## Threat Model

| Asset / boundary | Threat or failure | Control and failure posture | Residual risk / owner |
|---|---|---|---|
| {ASSET_OR_BOUNDARY} | {THREAT_OR_FAILURE} | {CONTROL_AND_FAILURE_POSTURE} | {RESIDUAL_RISK_AND_OWNER} |

## Controls and Failure Posture

Explain controls by security concern. Link implementation and behavioral evidence rather than copying source.

## Accepted Exceptions and Residual Risks

| Exception / residual risk | Current decision | Owner / review signal |
|---|---|---|
| {RESIDUAL_RISK} | {CURRENT_DECISION} | {OWNER_AND_REVIEW_SIGNAL} |

## Verification and Source Map

Link every requirement file and every decision identifier directly. Do not use unresolved shorthand such as `Operations SDD`, `Browser IDE SDD`, or bare decision identifiers.

| Control family | Requirements / decisions | Implementation | Evidence |
|---|---|---|---|
| {CONTROL_FAMILY} | {REQUIREMENT_LINK} | `{PATH}::{SYMBOL}` | `{TEST_PATH}` |

## Related Documentation

{RELATED_DOCUMENTATION}
