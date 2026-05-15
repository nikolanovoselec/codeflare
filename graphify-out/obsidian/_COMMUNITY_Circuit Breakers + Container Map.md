---
type: community
cohesion: 0.09
members: 33
---

# Circuit Breakers + Container Map

**Cohesion:** 0.09 - loosely connected
**Members:** 33 nodes

## Members
- [[BreakerEntry]] - code - src/lib/circuit-breakers.ts
- [[all]] - code - src/__tests__/lib/circuit-breakers.test.ts
- [[cb_1]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cb1]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cb2]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cbA]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cbANew]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cbAfter]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cbB]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cbBSame]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cbNew]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[cfApiCB]] - code - src/lib/circuit-breakers.ts
- [[circuit-breakers-per-container.test.ts]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[circuit-breakers-per-container.test.ts_1]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[circuit-breakers.test.ts]] - code - src/__tests__/lib/circuit-breakers.test.ts
- [[circuit-breakers.test.ts_1]] - code - src/__tests__/lib/circuit-breakers.test.ts
- [[circuit-breakers.ts]] - code - src/lib/circuit-breakers.ts
- [[cleanupStaleBreakers()]] - code - src/lib/circuit-breakers.ts
- [[containerHealthMap]] - code - src/lib/circuit-breakers.ts
- [[containerInternalMap]] - code - src/lib/circuit-breakers.ts
- [[containerSessionsMap]] - code - src/lib/circuit-breakers.ts
- [[failFn]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[getContainerHealthCB()]] - code - src/lib/circuit-breakers.ts
- [[getContainerSessionStatus()]] - code - src/routes/session/lifecycle.ts
- [[getContainerSessionsCB()]] - code - src/lib/circuit-breakers.ts
- [[getOrCreateBreaker()]] - code - src/lib/circuit-breakers.ts
- [[health]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[internal]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[per-container circuit breakers]] - code - src/lib/circuit-breakers.ts
- [[resetContainerBreakers()]] - code - src/lib/circuit-breakers.ts
- [[sessions_3]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[successFn]] - code - src/__tests__/lib/circuit-breakers-per-container.test.ts
- [[unique]] - code - src/__tests__/lib/circuit-breakers.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Circuit_Breakers__Container_Map
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Container Sync Status Responses]]
- 5 edges to [[_COMMUNITY_Community 88]]
- 5 edges to [[_COMMUNITY_Community 75]]
- 4 edges to [[_COMMUNITY_Community 63]]
- 3 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 2 edges to [[_COMMUNITY_CF Access Mocks]]
- 2 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 2 edges to [[_COMMUNITY_Community 125]]
- 2 edges to [[_COMMUNITY_Community 77]]
- 2 edges to [[_COMMUNITY_CF Access Type Models]]
- 2 edges to [[_COMMUNITY_Community 79]]
- 2 edges to [[_COMMUNITY_Community 83]]
- 1 edge to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 1 edge to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]

## Top bridge nodes
- [[circuit-breakers.ts]] - degree 31, connects to 14 communities
- [[cfApiCB]] - degree 10, connects to 6 communities
- [[getContainerSessionsCB()]] - degree 9, connects to 3 communities
- [[circuit-breakers.test.ts]] - degree 8, connects to 2 communities
- [[circuit-breakers.test.ts_1]] - degree 6, connects to 2 communities