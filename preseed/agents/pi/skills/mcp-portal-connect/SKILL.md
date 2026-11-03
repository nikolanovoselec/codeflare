---
name: mcp-portal-connect
description: Connect, bootstrap and diagnose Codeflare-managed MCP portals without exposing credentials to Pi.
disable-model-invocation: true
---

# Connect and bootstrap MCP portals

## Owner connection

1. Administration → Environment registers unique portal IDs and public HTTPS MCP endpoints on the standard port; IP addresses and private-suffix hosts are unsupported. It does not provision a portal, start compute, or authenticate a user. A name is identity only, not a description of the catalogue.
2. Settings → MCP lists all configured portals. Choose **Connect MCP portal** for each owner-approved portal. The browser navigates through the portal's standard OAuth/SSO flow. Consent, MFA or login may still be required. No popup or browser-cookie copying is needed.
3. Codeflare stores the real portal access/refresh grant encrypted in dedicated owner/portal KV records. Pi receives only a public placeholder header. No real token, verifier or code belongs in Pi's environment, config, arguments, transcript, auth store or model context.
4. Settings shows connected portal IDs and offers Disconnect per portal. Connected means a stored grant, not proof every upstream tool is reachable or permitted. Expired/revoked grants need reconnect in Settings. URL changes invalidate the old binding; never migrate it to a different resource.

Dynamic client registration is preferred where available. For a CIMD-only issuer, the administrator must verify external reachability of `/auth/mcp/client-metadata`; an anonymous Worker handler does not bypass edge Access. Do not provision a bypass or change grants as a connection workaround.

## Bootstrap before selecting tools

Managed entries are `codeflare-portal-<ID>` in `mcp.json`, eager streamable HTTP connections with `Authorization: Bearer codeflare-mcp-portal`. Both supported Pi modes use the stock MCP extension; builtin MCP is disabled to avoid duplicate clients. Restart Pi after adding a portal registration. Do not edit npm, the local OAuth store or unrelated stdio/project servers.

Use `capability` to activate the actual `mcp_status` tool, inspect its live schema and call it (empty-object example when supported):

```json
{}
```

Reconcile **every configured managed portal** against connected state before searching for task relevance. If a previously unavailable portal can now connect, activate the exact `mcp_connect` name and use its live schema (stock shape):

```json
{"name":"codeflare-portal-<configured-ID>"}
```

This does not authorize login or remote mutations. Missing grants produce a Settings reconnect requirement, not a request to paste a token or run Pi-owned `/mcp:auth` for managed portals. Unmanaged local OAuth retains its normal stock lifecycle.

List connected, disconnected and failed IDs explicitly. Continue only with an explicit partial-coverage statement when not all approved portals connect. Do not infer relevance from names. Do not start/warm a Codeflare compute session merely to qualify a portal.

## Diagnosis

- Unregistered wrapper: finish connection/bootstrap, then discover/activate it; activation alone does not connect a server.
- `MCP_RECONNECT_REQUIRED`: reconnect that portal in Settings. Do not substitute another owner's token, a Root Access JWT or a service token.
- Configuration/destination/redirect denial: verify the administrator's exact HTTPS endpoint and restart after correction; do not broaden egress or disable TLS.
- An upstream downstream-server OAuth URL must be opened only with the owner's authorization and kept with its originating portal context. Do not claim hosted downstream acceptance from source or synthetic tests.

Next: [discovery](../mcp-portal-discovery/SKILL.md), then [execution](../mcp-portal-execution/SKILL.md).
