# AI Gateway and model routing

**Availability:** Enterprise deployment plus an operator-configured Gateway URL, token, and valid dynamic route catalog.

## What I can do

I can send supported coding-agent model traffic through the customer's Cloudflare AI Gateway while clients continue to use provider-compatible interfaces. The Worker interceptor selects from the operator-defined route catalog. Routes can carry model targets, context-window limits, default reasoning settings, and Access-group mappings.

I can help an administrator review current routing, preview a bounded Environment change, execute it, inspect the sanitized run record, and verify a real request in Gateway analytics. Initialization and Administration own Gateway URL, secret replacement, route catalog, and group mappings. Blank replacement secrets preserve the saved encrypted token.

## Why the boundary matters

The agent does not receive the Gateway token or choose an arbitrary route. Routing policy remains at the Worker boundary. I also do not infer the active route from writing style, model self-identification, or wishful thinking. I use runtime-exposed metadata and operator logs when available.

AI Gateway support is not evidence that routing is active in this session. Missing URL, token, catalog, or applicable group mapping means the operator must configure the integration first.

## Try it

User task: run a small model request only after the runtime identifies available route context, then ask an operator to correlate it with Gateway analytics.

Operator task: add one low-risk pilot route, map one Access group, preview and apply the change in Administration, and keep the previous mapping ready for rollback until a real request is verified.

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-004/005/007/012/013/017/022, `src/llm-interceptor.ts`, `documentation/lanes/configuration.md`, and `documentation/lanes/api-reference.md`.
