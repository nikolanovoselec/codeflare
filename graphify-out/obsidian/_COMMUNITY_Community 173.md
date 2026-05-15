---
type: community
cohesion: 0.17
members: 12
---

# Community 173

**Cohesion:** 0.17 - loosely connected
**Members:** 12 nodes

## Members
- [[CF_API_BASE Cloudflare API URL]] - code - src/lib/constants.ts
- [[cleanupUserData (sessions + containers + KV + R2 token + bucket teardown)]] - code - src/lib/user-cleanup.ts
- [[createBucketIfNotExists (R2 bucket provisioning via CF API)]] - code - src/lib/r2-admin.ts
- [[createScopedR2Token (per-bucket API token with retry)]] - code - src/lib/r2-admin.ts
- [[deleteScopedR2Token]] - code - src/lib/r2-admin.ts
- [[emptyR2Bucket (paginated S3 list + multi-delete)]] - code - src/lib/r2-client.ts
- [[getOrCreateScopedR2Token (KV-cached scoped tokens with dedup)]] - code - src/lib/r2-admin.ts
- [[getR2Url (build S3-compatible URL)]] - code - src/lib/r2-client.ts
- [[getSessionPrefix]] - code - src/lib/kv-keys.ts
- [[listAllKvKeys (paginated KV.list, MAX 100 iterations)]] - code - src/lib/kv-keys.ts
- [[parseListObjectsXml (S3 ListObjectsV2 XML parser)]] - code - src/lib/r2-client.ts
- [[verifyTokenExists (CF API token existence check)]] - code - src/lib/r2-admin.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_173
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Community 119]]
- 1 edge to [[_COMMUNITY_Community 172]]

## Top bridge nodes
- [[cleanupUserData (sessions + containers + KV + R2 token + bucket teardown)]] - degree 8, connects to 2 communities