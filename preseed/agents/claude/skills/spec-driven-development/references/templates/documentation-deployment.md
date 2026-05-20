<!-- doc-discipline: one-line table cells (≤50 words), deploy commands and rollback steps only — no env var documentation (link to configuration.md), no API contracts (link to api-reference.md). -->

# Deployment

**Audience:** Developers, Operators

Local development setup and production deployment steps.

---

## Prerequisites

- {Tool name} version {X.Y+}
- {Account or credential needed}

## Local Development

```bash
{install command}
{seed/migration command}
{dev server command}
```

The dev server runs at {URL}.

## Tests

```bash
{test command}
```

Tests are organized so each test references a REQ ID — `spec-reviewer` reads test files to verify which Implemented REQs have automated coverage.

## Production Deployment

```bash
{deploy command}
```

### Environment-specific configuration

| Environment | Branch | Notes |
|---|---|---|
| Development | `develop` | {what's special} |
| Production | `main` | {what's special} |

## Cloudflare Resources

| Resource | Type | Purpose |
|---|---|---|
| `{name}` | D1/R2/KV/Worker | {purpose} |

---

## Related Documentation

- [Configuration](configuration.md) — Env vars and secrets
- [Architecture](architecture.md) — System overview
