---
type: community
cohesion: 0.50
members: 4
---

# Community 315

**Cohesion:** 0.50 - moderately connected
**Members:** 4 nodes

## Members
- [[GET usage (real-time monthlydaily)]] - code - src/__tests__/timekeeper/index.test.ts
- [[POST ping (delta accumulation, alarm arming)]] - code - src/__tests__/timekeeper/index.test.ts
- [[UsageRecord (Timekeeper KV record)]] - code - src/types.ts
- [[alarm() flushes pendingSeconds to KV]] - code - src/__tests__/timekeeper/index.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_315
SORT file.name ASC
```
