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
| `{SIGNAL}` | {MEANING_AND_NON_EVIDENCE} | `{PATH}::{SYMBOL}` | {ESCALATION_THRESHOLD} | {RUNBOOK_LINK} |

## Dashboards and Alerts

| Surface | Signals | Audience | Authority |
|---|---|---|---|
| {SURFACE} | {SIGNALS} | {AUDIENCE} | {AUTHORITY} |

## Failure and Degradation

Document collection failures and whether product behavior continues, degrades, or fails closed.

## Requirement and Source Map

| Observability concern | Requirements | Source owner | Behavioral evidence |
|---|---|---|---|
| {CONCERN} | {REQUIREMENT_LINK} | `{PATH}::{SYMBOL}` | `{TEST_PATH}` |

## Related Documentation

{RELATED_DOCUMENTATION}
