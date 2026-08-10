---
type: "query"
date: "2026-08-10T21:01:02.628760+00:00"
question: "Where are Cloudflare OAuth/API connection levels or tiers defined, and how are requested OAuth scopes assembled and tested? Focus on zone analytics scope additions."
contributor: "graphify"
outcome: "useful"
source_nodes: ["CLOUDFLARE_OAUTH_SCOPES", "cloudflareScopeForTier", "oauth-scopes.test.ts", "routes/cloudflare.ts", "CLOUDFLARE_TIERS"]
---

# Q: Where are Cloudflare OAuth/API connection levels or tiers defined, and how are requested OAuth scopes assembled and tested? Focus on zone analytics scope additions.

## Answer

Cloudflare connection tiers are defined server-side in src/lib/oauth-scopes.ts: CF_MINIMAL feeds CF_RECOMMENDED, which feeds CF_ADVANCED, and cloudflareScopeForTier appends offline_access. The actual authorize URL is assembled in src/routes/cloudflare.ts. Behavioral coverage lives in src/__tests__/lib/oauth-scopes.test.ts and src/__tests__/routes/cloudflare-oauth.test.ts; UI labels live in web-ui/src/lib/token-scopes.ts and the public scope matrix lives in documentation/lanes/configuration.md. Adding zone.analytics.read to CF_MINIMAL is the smallest change that places it in minimal, recommended, and advanced through existing inheritance.

## Outcome

- Signal: useful

## Source Nodes

- CLOUDFLARE_OAUTH_SCOPES
- cloudflareScopeForTier
- oauth-scopes.test.ts
- routes/cloudflare.ts
- CLOUDFLARE_TIERS