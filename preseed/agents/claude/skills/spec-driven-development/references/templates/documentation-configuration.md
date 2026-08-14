# {PROJECT_NAME} Configuration

**Audience:** Developers and operators configuring a deployment.

**Owns:** Configuration sources, precedence, defaults, consumers, and security consequences.

**Does not own:** Deployment procedures or secret values.

## Contents

- [Configuration Sources and Precedence](#configuration-sources-and-precedence)
- [Runtime Variables](#runtime-variables)
- [Secrets](#secrets)
- [Platform Bindings](#platform-bindings)
- [Configuration Files](#configuration-files)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Configuration Sources and Precedence

| Source | Scope | Change mechanism | Precedence / authority |
|---|---|---|---|
| {Source} | {Scope} | {How changed} | {Authority order} |

## Runtime Variables

| Variable | Purpose | Default | Required | Consumed by | Implements |
|---|---|---|---|---|---|
| `{VARIABLE}` | {Purpose} | `{DEFAULT}` | {yes/no/conditional} | `{PATH}::{SYMBOL}` | [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001) |

## Secrets

Document secret names, consumers, rotation boundaries, and fail-closed behavior. Never include secret values.

## Platform Bindings

| Binding | Purpose | Required | Consumed by | Implements |
|---|---|---|---|---|
| `{BINDING}` | {Purpose} | {yes/no/conditional} | `{PATH}::{SYMBOL}` | [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001) |

## Configuration Files

| File | Purpose | Consumer | Source of truth |
|---|---|---|---|
| `{PATH}` | {Purpose} | `{CONSUMER}` | {Authority} |

## Requirement and Source Map

| Configuration concern | Source owner | Requirements | Specialist owner |
|---|---|---|---|
| {Concern} | `{PATH}` | [REQ-DOMAIN-001](../../sdd/spec/domain.md#req-domain-001) | {Lane link} |

## Related Documentation

{Links to emitted Architecture, Deployment, and Security lanes.}
