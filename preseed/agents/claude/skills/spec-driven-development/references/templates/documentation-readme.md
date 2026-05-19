<!-- doc-discipline: 200 lines soft cap, one-line table cells, no implementation prose -->

# {PROJECT_NAME} — Documentation

**Audience:** Developers, Operators

This is the implementation documentation. The product specification (what the system does and why) lives at [`sdd/README.md`](../sdd/README.md). This folder describes **how the system actually works** — components, contracts, env vars, deploy steps, decisions.

A future contributor reading this folder should be able to navigate the implementation without re-reading every source file.

---

## Jump-TOC

| Document | One-line role |
|---|---|
| [Architecture](architecture.md) | System overview, components, request flow, file/folder map |
| [API Reference](api-reference.md) | All HTTP routes — request shapes, response shapes, status codes |
| [Configuration](configuration.md) | Environment variables, secrets, runtime bindings |
| [Deployment](deployment.md) | Dev setup, deploy steps, rollback |
| [Security](security.md) | Threat model, auth flow, cookies, headers, rate limits |
| [Observability](observability.md) | Logging shape, metrics, dashboards |
| [Troubleshooting](troubleshooting.md) | Symptom → cause → fix recipes |
| [Decisions](decisions/README.md) | Architecture Decision Records (ADR ledger) |

Files marked above that don't exist yet for this project will be created on demand. Don't create empty stubs — wait until there's real content for a lane.

---

## Lane ownership

Each file owns one lane. When something falls in multiple lanes, the canonical owner is the row in this table; other docs link instead of duplicating.

| File | Owns | Never owns |
|---|---|---|
| `architecture.md` | Component layout, data flow, file/folder structure, technology choices, schema overviews | API contracts, env vars, deploy steps, troubleshooting |
| `api-reference.md` | HTTP routes, request/response schemas, status codes, per-endpoint auth | Architecture rationale, env values, deploy steps |
| `configuration.md` | Env var names, defaults, valid values, consumption points | API contracts, architecture rationale, deploy commands |
| `deployment.md` | Deploy commands, CI workflow names, rollback, secret rotation | API contracts, env documentation (link to `configuration.md`) |
| `security.md` | Threat model, auth flow, cookie/header policies, rate limits | Per-endpoint auth (link to `api-reference.md`) |
| `observability.md` | Log shape, metrics, dashboards | Architecture, troubleshooting recipes |
| `troubleshooting.md` | Symptom → cause → fix recipes, build-tool quirks, runtime gotchas | Architecture, env vars, deploy steps (link) |
| `decisions/README.md` | All ADRs in a single ledger: index table at top, per-ADR sections below with Status/Context/Decision/Consequences | Non-ADR content; runbook prose; spec REQs |

---

## REQ backlinks

Every documented feature should reference the spec REQ that defines it. Format: inline `(REQ-X-NNN)` immediately after the feature name in a heading or first sentence.

```markdown
## Inquiry email delivery (REQ-API-002)
```

The link form is preferred: `[(REQ-API-002)](../sdd/{domain}.md#req-api-002-title-slug)` — let `doc-updater` rewrite plain-text refs to anchored links on the next PR.

---

## Synonym glossary

Vocabulary that appears in multiple forms across the codebase + spec. Single canonical name on the left, common synonyms on the right. This anchor stops drift across REQs, source comments, and docs.

| Canonical term | Synonyms / variants | Where defined |
|---|---|---|
| {Term} | {variant 1, variant 2} | [{file}](../sdd/{domain}.md) |

For domain-specific definitions (single canonical name, one sentence of meaning) see [`sdd/glossary.md`](../sdd/glossary.md). This table is for the messier real-world case where two or more names point at the same concept.

---

## Reading order for a new contributor

1. **Start here.** Read this index to understand which lane owns what.
2. **Architecture** (`architecture.md`) — what the system is and how requests move through it.
3. **API Reference** (`api-reference.md`) — what callers can do.
4. **Configuration** (`configuration.md`) — what knobs exist.
5. **Decisions** (`decisions/README.md`) — why the system looks the way it does.
6. **Security**, **Observability**, **Troubleshooting**, **Deployment** — on demand, when working in those areas.

---

## Related

- [Product Specification](../sdd/README.md) — Requirements and design intent
- [Glossary](../sdd/glossary.md) — Canonical term definitions
- [Project README](../README.md) — Project overview and quickstart
- [Changelog](../sdd/changes.md) — Specification history
