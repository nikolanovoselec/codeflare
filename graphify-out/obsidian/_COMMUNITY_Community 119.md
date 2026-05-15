---
type: community
cohesion: 0.14
members: 17
---

# Community 119

**Cohesion:** 0.14 - loosely connected
**Members:** 17 nodes

## Members
- [[Access cookie JWT fallback tests]] - code - src/__tests__/lib/access-cookie-jwt.test.ts
- [[AuthError (401, internal message hidden)]] - code - src/__tests__/lib/error-types.test.ts
- [[CF-010 parseUserRecord rejects non-object values]] - code - src/__tests__/lib/access.test.ts
- [[CF_Authorization cookie verified against access_aud_list]] - code - src/__tests__/lib/access-cookie-jwt.test.ts
- [[FIX-1 header trust only pre-setup (cf-access-authenticated-user-email)]] - code - src/__tests__/lib/access.test.ts
- [[SETUP_KEYS constants (setup KV key registry)]] - code - src/lib/kv-keys.ts
- [[Service token cf-access-client-id resolution]] - code - src/__tests__/lib/access.test.ts
- [[access.ts tests]] - code - src/__tests__/lib/access.test.ts
- [[authenticateRequest (AuthError 401  ForbiddenError 403)]] - code - src/__tests__/lib/access.test.ts
- [[cache-reset coordinator tests]] - code - src/__tests__/lib/cache-reset.test.ts
- [[getBaseUrl (custom domain or request origin resolution)]] - code - src/lib/kv-keys.ts
- [[getBucketName (email-to-R2-bucket-name sanitization, 63 char max)]] - code - src/lib/access.ts
- [[getBucketName (worker prefix + sanitized email, =63 chars)]] - code - src/__tests__/lib/access.test.ts
- [[getUserFromRequest (service token + SaaS OIDC + CF Access JWT auth)]] - code - src/lib/access.ts
- [[resetSetupCache fans out to corsauthjwks resets]] - code - src/__tests__/lib/cache-reset.test.ts
- [[resolveOrProvisionUser (SaaS JIT provisioning + welcome email)]] - code - src/lib/access.ts
- [[resolveUserFromKV (Zod-validated record, default role)]] - code - src/__tests__/lib/access.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_119
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Community 173]]
- 1 edge to [[_COMMUNITY_Community 147]]
- 1 edge to [[_COMMUNITY_Community 171]]
- 1 edge to [[_COMMUNITY_Community 206]]
- 1 edge to [[_COMMUNITY_Community 146]]

## Top bridge nodes
- [[authenticateRequest (AuthError 401  ForbiddenError 403)]] - degree 7, connects to 1 community
- [[access.ts tests]] - degree 7, connects to 1 community
- [[SETUP_KEYS constants (setup KV key registry)]] - degree 4, connects to 1 community
- [[getUserFromRequest (service token + SaaS OIDC + CF Access JWT auth)]] - degree 3, connects to 1 community
- [[getBucketName (email-to-R2-bucket-name sanitization, 63 char max)]] - degree 2, connects to 1 community