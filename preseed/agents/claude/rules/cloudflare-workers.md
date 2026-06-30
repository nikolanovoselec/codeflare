---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.mts"
  - "**/*.mjs"
  - "wrangler.toml"
  - "wrangler.json"
  - "wrangler.jsonc"
  - "worker-configuration.d.ts"
  - "**/workers/**"
  - "**/worker/**"
---
# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/ — fetch with WebFetch before citing specific limits, signatures, or config.

For all limits and quotas, retrieve from the product's `/platform/limits/` page.

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

If you encounter `Dynamic require of "X" is not supported` or missing Node.js APIs:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "compatibility_date": "YYYY-MM-DD" // Use today's date
}
```

Docs: https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
