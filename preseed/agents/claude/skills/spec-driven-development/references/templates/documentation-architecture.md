<!-- doc-discipline: 350 lines max, one-line table cells (≤50 words), no implementation prose, no API endpoint contracts (those go in api-reference.md). -->

# Architecture

System overview, component map, and data flow.

**Audience:** Developers

---

## Overview

{One paragraph describing what the system is and what it does at a high level. Reference [`sdd/README.md`](../sdd/README.md) for the product intent.}

## Components

| Component | Role |
|---|---|
| {Component} | {What it does} |

## Source Modules

| Path | Responsibility | Implements |
|---|---|---|
| `src/{path}` | {What this module does} | [REQ-X-N](../sdd/{domain}.md#req-x-n) |

## Request Lifecycle

```
{Diagram or step-by-step flow}
```

## Data Flow

{How data moves through the system. Include database, storage, and external services.}

---

## Related Documentation

- [Configuration](configuration.md) — Env vars and secrets
- [API Reference](api-reference.md) — Endpoint contracts
- [Decisions](decisions/README.md) — Architectural decisions and rationale
