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
| {SOURCE} | {SCOPE} | {CHANGE_MECHANISM} | {AUTHORITY} |

## Runtime Variables

| Variable | Purpose | Default | Required | Consumed by | Implements |
|---|---|---|---|---|---|
| `{VARIABLE}` | {PURPOSE} | `{DEFAULT}` | {REQUIRED_STATE} | `{PATH}::{SYMBOL}` | {REQUIREMENT_LINK} |

## Secrets

Document secret names, consumers, rotation boundaries, and fail-closed behavior. Never include secret values.

## Platform Bindings

| Binding | Purpose | Required | Consumed by | Implements |
|---|---|---|---|---|
| `{BINDING}` | {PURPOSE} | {REQUIRED_STATE} | `{PATH}::{SYMBOL}` | {REQUIREMENT_LINK} |

## Configuration Files

| File | Purpose | Consumer | Source of truth |
|---|---|---|---|
| `{PATH}` | {PURPOSE} | `{CONSUMER}` | {AUTHORITY} |

## Requirement and Source Map

| Configuration concern | Source owner | Requirements | Specialist owner |
|---|---|---|---|
| {CONCERN} | `{PATH}` | {REQUIREMENT_LINK} | {SPECIALIST_OWNER} |

## Related Documentation

{RELATED_DOCUMENTATION}
