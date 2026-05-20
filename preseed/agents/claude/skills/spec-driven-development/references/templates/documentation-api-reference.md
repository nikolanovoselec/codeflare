<!-- doc-discipline: 600 lines soft cap (split admin endpoints to api-reference-admin.md beyond that), one-line table cells (≤50 words), no architecture rationale (lives in architecture.md), no env var docs (lives in configuration.md). -->

# API Reference

All public and internal API endpoints.

**Audience:** Developers

One entry per route. Stub entries are NOT allowed — every entry must be fully populated per the per-endpoint template below. Empty `{placeholder}` text in any field after `sdd-init` Phase 6d emission is a HIGH `scaffold-section-empty` finding from `doc-enforce`.

---

## Public API

### {METHOD} {/path}

{One-line description of what the endpoint does in ≤50 words.}

**Implements:** [REQ-X-NNN](../sdd/{domain}.md#req-x-nnn-...)

**Authentication:** None | Required (session cookie) | Required (Bearer token) | Required (signed request) — describe specifically

**Rate limit:** {N requests / window} | None

**Path Parameters:**

| Parameter | Format | Description |
|---|---|---|
| `{name}` | `{format}` | {description} |

(Omit table if endpoint has no path parameters.)

**Query Parameters:**

| Parameter | Required | Format | Description |
|---|---|---|---|
| `{name}` | yes / no | `{format}` | {description} |

(Omit table if endpoint has no query parameters.)

**Request body:**

```json
{
  "{field}": "{example value}"
}
```

(Replace with the actual JSON schema. Omit block for GET / DELETE without body.)

**Response 200:**

```json
{
  "{field}": "{example value}"
}
```

(Replace with the actual response shape. Use the success status code returned by the implementation, which may not be 200 — 201 for creates, 202 for accepted-async, 204 for empty-OK.)

**Error responses:**

| Code | When | Body |
|---|---|---|
| 400 | {specific condition} | `{"error":"..."}` |
| 401 | {specific condition} | `{"error":"..."}` |
| 403 | {specific condition} | `{"error":"..."}` |
| 404 | {specific condition} | `{"error":"..."}` |
| 429 | {rate limit exceeded} | `{"error":"..."}` |
| 500 | {specific condition} | `{"error":"..."}` |

Include every non-2xx code the handler can return. `doc-enforce-shape` Pass 7 flags missing error rows. Rows for codes the handler cannot return are NOT included (no boilerplate 500 row on an endpoint that has no 500 path).

**Cache:** `Cache-Control: {policy}` — `no-store` for mutating endpoints, `private, max-age=N` for user-scoped reads, `public, max-age=N` for public reads.

**Implementation:** `src/{path}/{file}.ts:{line}` — pointer to the handler definition.

---

## Internal API

(Endpoints that exist but are not publicly documented. Same template as Public API. Omit this section if the project has no internal endpoints.)

---

## Admin API

(Endpoints gated by admin middleware. Same template. If the project has ≥3 admin endpoints OR this section exceeds 100 lines, split to `api-reference-admin.md` per `doc-enforce` Pass 2.)

---

## Webhooks (if applicable)

(Endpoints called by external services. Document the expected payload shape, the verification mechanism (HMAC signature, IP allowlist, etc.), and the response contract. Same template otherwise.)

---

## WebSocket / Server-Sent Events (if applicable)

For long-lived connections, document the connection contract:

### {Endpoint path}

**Implements:** [REQ-X-NNN](...)

**Authentication:** {how the connection is authenticated}

**Subprotocol:** {if applicable}

**Messages from client:**

| Type | Shape | Triggers |
|---|---|---|
| `{name}` | `{shape}` | {server-side action} |

**Messages from server:**

| Type | Shape | Sent when |
|---|---|---|
| `{name}` | `{shape}` | {triggering event} |

**Close codes:**

| Code | When |
|---|---|
| {code} | {condition} |

---

## Related Documentation

- [Architecture](architecture.md) — Component overview, request flow
- [Configuration](configuration.md) — Required env vars and secrets
- [Security](security.md) — Auth flow, rate limits (if emitted by Phase 6a probe)
