---
type: community
cohesion: 0.21
members: 12
---

# Community 180

**Cohesion:** 0.21 - loosely connected
**Members:** 12 nodes

## Members
- [[CachedDiskMetrics]] - code - host/src/types.ts
- [[SyncStatus]] - code - host/src/types.ts
- [[SystemMetrics]] - code - host/src/types.ts
- [[cachedDiskMetrics]] - code - host/src/metrics.ts
- [[execFileAsync]] - code - host/src/metrics.ts
- [[getDiskMetrics()]] - code - host/src/metrics.ts
- [[getSyncStatus()]] - code - host/src/metrics.ts
- [[getSystemMetrics()]] - code - host/src/metrics.ts
- [[getWorkingDirectory()]] - code - host/src/server.ts
- [[log()]] - code - host/src/server.ts
- [[metrics.ts]] - code - host/src/metrics.ts
- [[shutdown()]] - code - host/src/server.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_180
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_Prewarm + Activity Tracker]]
- 5 edges to [[_COMMUNITY_Community 126]]

## Top bridge nodes
- [[metrics.ts]] - degree 11, connects to 2 communities
- [[log()]] - degree 5, connects to 1 community
- [[getSystemMetrics()]] - degree 4, connects to 1 community
- [[getSyncStatus()]] - degree 2, connects to 1 community
- [[getWorkingDirectory()]] - degree 2, connects to 1 community