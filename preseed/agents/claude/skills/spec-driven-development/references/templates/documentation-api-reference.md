# API Reference

All public and internal API endpoints.

**Audience:** Developers

---

## Public API

### {METHOD} {/path}

{One-line description.}

**Implements:** [REQ-X-N](../sdd/{domain}.md#req-x-n)

**Authentication:** None | Required (describe)

**Path Parameters:**

| Parameter | Format | Description |
|---|---|---|
| `{name}` | `{format}` | {description} |

**Request:**

```json
{example}
```

**Response 200:**

```json
{example}
```

**Error responses:**

| Code | When | Body |
|---|---|---|
| 400 | {when} | `{error shape}` |
| 401 | {when} | `{error shape}` |

**Cache:** `Cache-Control: {policy}`

**Implementation:** `src/{path}`

---

## Admin API

{Same format as Public API for admin-only endpoints.}

---

## Related Documentation

- [Architecture](architecture.md) — Component overview
- [Configuration](configuration.md) — Required env vars and secrets
