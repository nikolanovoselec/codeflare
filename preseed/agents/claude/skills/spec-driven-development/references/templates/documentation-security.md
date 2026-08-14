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
| {Asset or boundary} | {Threat} | {Control and failure behavior} | {Residual risk and owner} |

## Controls and Failure Posture

Explain controls by security concern. Link implementation and behavioral evidence rather than copying source.

## Accepted Exceptions and Residual Risks

| Exception / residual risk | Current decision | Owner / review signal |
|---|---|---|
| {Risk} | {Accepted boundary or mitigation} | {Owner and trigger for review} |

## Verification and Source Map

| Control family | Requirements / decisions | Implementation | Evidence |
|---|---|---|---|
| {Control} | [REQ-SEC-001](../../sdd/spec/security.md#req-sec-001) | `{PATH}::{SYMBOL}` | `{TEST_PATH}` |

## Related Documentation

{Links to emitted Architecture, API, Configuration, Deployment, and Troubleshooting lanes.}
