# {PROJECT_NAME} Architecture

**Audience:** Engineers and operators who need the system map and authority boundaries.

**Owns:** System topology, component responsibility, state authority, cross-component flows, failure recovery, and links to detailed owner lanes.

**Does not own:** Endpoint inventories, configuration values, deployment commands, or troubleshooting recipes.

## Contents

- [Purpose, Audience, and Ownership](#purpose-audience-and-ownership)
- [System at a Glance](#system-at-a-glance)
- [System Components](#system-components)
- [Architectural Invariants](#architectural-invariants)
- [State Ownership and Durability](#state-ownership-and-durability)
- [Data Flow](#data-flow)
- [Failure Domains and Recovery Ownership](#failure-domains-and-recovery-ownership)
- [Observability and Operator Signals](#observability-and-operator-signals)
- [Security and Privacy Boundaries](#security-and-privacy-boundaries)
- [Decision and Requirement Map](#decision-and-requirement-map)
- [Related Documentation](#related-documentation)

## Purpose, Audience, and Ownership

Explain what this architecture reference lets a new engineer or operator determine. Name the detailed lanes that own implementation inventories and procedures.

## System at a Glance

Describe the deployment boundary and principal request or job path in one short paragraph.

```mermaid
flowchart LR
  Entry[Entry point] --> Runtime[Primary runtime]
  Runtime --> State[(Authoritative state)]
```

## System Components

Use one dossier per long-lived component or authority boundary. Do not create an exhaustive source-file inventory.

### {COMPONENT_NAME}

**Responsibility:** {Owned behavior or boundary.}

**Inputs:** {Requests, events, or state consumed.}

**Outputs:** {Responses, events, or state produced.}

**State owned:** {Authoritative state, or None.}

**Does not own:** {Important adjacent responsibility.}

**Source:** `{PATH}::{SYMBOL}`

**Requirements:** [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001)

**Detailed documentation:** {Link to the canonical owner lane, when applicable.}

## Architectural Invariants

| Invariant | Consequence | Detailed owner |
|---|---|---|
| {Invariant} | {Failure prevented or behavior guaranteed} | {Lane or ADR link} |

## State Ownership and Durability

| State | Scope | Authority | Durability | Writers | Readers | Recovery owner |
|---|---|---|---|---|---|---|
| {State} | {Scope} | {Authoritative owner} | {Lifetime} | {Writers} | {Readers} | {Recovery owner} |

## Data Flow

Use one short flow per cross-component path. Identify the authoritative state in prose when the diagram alone is ambiguous.

### {FLOW_NAME}

```mermaid
sequenceDiagram
  participant Caller
  participant Owner
  Caller->>Owner: {Input}
  Owner-->>Caller: {Observable result}
```

Failure and recovery are owned by {component or linked runbook}.

## Failure Domains and Recovery Ownership

| Failure domain | Observable disagreement | Authority | Recovery owner | Degradation rule |
|---|---|---|---|---|
| {Failure domain} | {Signal} | {Source of truth} | {Owner or runbook} | {Fail-open or fail-closed behavior} |

## Observability and Operator Signals

Summarize only the signals needed to understand architecture. Link detailed signal fields and incident procedures to Observability or Troubleshooting.

## Security and Privacy Boundaries

Summarize trust boundaries and failure posture. Link detailed controls and residual risks to Security.

## Decision and Requirement Map

| Concern | Architecture section | Requirements | Decisions | Detailed owner |
|---|---|---|---|---|
| {Concern} | {Section link} | [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001) | [AD1](../decisions/README.md#ad1-example) | {Lane link} |

## Related Documentation

{Links to emitted owner lanes and the SDD index.}
