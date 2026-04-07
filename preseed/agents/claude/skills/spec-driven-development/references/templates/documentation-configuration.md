# Configuration

**Audience:** Operators, Developers

Environment variables, secrets, and platform bindings required to run the system.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `{NAME}` | yes/no | `{default}` | {description} |

## Secrets

| Secret | Storage | Description |
|---|---|---|
| `{NAME}` | wrangler secret / env / vault | {description} |

## Platform Bindings

| Binding | Type | Purpose |
|---|---|---|
| `{NAME}` | D1 / R2 / KV / Durable Object | {what it stores or does} |

## Configuration Files

| File | Purpose |
|---|---|
| `{path}` | {description} |

---

## Related Documentation

- [Deployment](deployment.md) — How to set these up in dev and prod
- [Architecture](architecture.md) — Where these bindings are used
