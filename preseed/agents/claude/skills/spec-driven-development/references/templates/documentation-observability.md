# {PROJECT_NAME} Observability

**Audience:** Operators and engineers diagnosing live behavior.

**Owns:** Signals, interpretation boundaries, collection points, escalation thresholds, and runbook links.

**Does not own:** Architecture rationale or troubleshooting procedures.

## Contents

- [Signal Contract](#signal-contract)
- [Signals](#signals)
- [Dashboards and Alerts](#dashboards-and-alerts)
- [Failure and Degradation](#failure-and-degradation)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Signal Contract

Explain identifiers, redaction, sampling, retention, and what an absent signal does not prove.

## Signals

| Signal | Meaning / non-evidence | Observed at | Escalate when | Runbook |
|---|---|---|---|---|
| `{SIGNAL}` | {Meaning and limitation} | `{PATH}::{SYMBOL}` | {Threshold or contradiction} | {Troubleshooting link} |

## Dashboards and Alerts

| Surface | Signals | Audience | Authority |
|---|---|---|---|
| {Dashboard or alert} | {Signals} | {Audience} | {Whether it is authoritative} |

## Failure and Degradation

Document collection failures and whether product behavior continues, degrades, or fails closed.

## Requirement and Source Map

| Observability concern | Requirements | Source owner | Behavioral evidence |
|---|---|---|---|
| {Concern} | [REQ-OPS-001](../../sdd/spec/operations.md#req-ops-001) | `{PATH}::{SYMBOL}` | `{TEST_PATH}` |

## Related Documentation

{Links to emitted Architecture, Deployment, Security, and Troubleshooting lanes.}
