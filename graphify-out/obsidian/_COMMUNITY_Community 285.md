---
type: community
cohesion: 0.40
members: 5
---

# Community 285

**Cohesion:** 0.40 - moderately connected
**Members:** 5 nodes

## Members
- [[SessionListMetadata (compressed KV list metadata for batch-status)]] - code - src/lib/kv-keys.ts
- [[buildSessionMetadata]] - code - src/lib/kv-keys.ts
- [[expandSessionMetadata]] - code - src/lib/kv-keys.ts
- [[putSessionWithMetadata (session KV write with sync metadata)]] - code - src/lib/kv-keys.ts
- [[toApiSession (strip userId + lastStatusCheck for API response)]] - code - src/lib/session-helpers.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_285
SORT file.name ASC
```
