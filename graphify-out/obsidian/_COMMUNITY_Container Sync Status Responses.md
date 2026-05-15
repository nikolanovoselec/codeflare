---
type: community
cohesion: 0.06
members: 45
---

# Container Sync Status Responses

**Cohesion:** 0.06 - loosely connected
**Members:** 45 nodes

## Members
- [[ContainerHealthResult]] - code - src/lib/container-helpers.ts
- [[ContainerStubWithState]] - code - src/lib/container-helpers.ts
- [[ContainerVariables]] - code - src/lib/container-helpers.ts
- [[DEFAULTS]] - code - src/routes/container/status.ts
- [[HealthCheckOptions]] - code - src/__tests__/lib/container-helpers.test.ts
- [[HealthData]] - code - src/lib/container-helpers.ts
- [[StartupResponse]] - code - src/routes/container/status.ts
- [[StartupStage]] - code - src/routes/container/status.ts
- [[app_60]] - code - src/routes/container/status.ts
- [[buildReadyResponse()]] - code - src/routes/container/status.ts
- [[buildSyncFailedResponse()]] - code - src/routes/container/status.ts
- [[buildSyncingResponse()]] - code - src/routes/container/status.ts
- [[c]] - code - src/__tests__/lib/container-helpers.test.ts
- [[checkContainerHealth()]] - code - src/lib/container-helpers.ts
- [[container-helpers module]] - code - src/lib/container-helpers.ts
- [[container-helpers.test.ts]] - code - src/__tests__/lib/container-helpers.test.ts
- [[container-helpers.test.ts_1]] - code - src/__tests__/lib/container-helpers.test.ts
- [[container-helpers.ts]] - code - src/lib/container-helpers.ts
- [[containerLogger]] - code - src/routes/container/shared.ts
- [[createMockContext()]] - code - src/__tests__/lib/container-helpers.test.ts
- [[ensureBucketName()]] - code - src/__tests__/lib/container-helpers.test.ts
- [[getContainerContext()]] - code - src/lib/container-helpers.ts
- [[getSessionIdFromQuery()]] - code - src/lib/container-helpers.ts
- [[healthData_3]] - code - src/routes/container/status.ts
- [[healthData_1]] - code - src/__tests__/lib/container-helpers.test.ts
- [[healthData]] - code - src/__tests__/lib/safe-check-container-health.test.ts
- [[healthRequest]] - code - src/routes/container/status.ts
- [[mockContainer_1]] - code - src/__tests__/lib/container-helpers.test.ts
- [[mockContainer]] - code - src/__tests__/lib/safe-check-container-health.test.ts
- [[onProgress_1]] - code - src/__tests__/lib/container-helpers.test.ts
- [[options_4]] - code - src/__tests__/lib/container-helpers.test.ts
- [[passThroughCB]] - code - src/__tests__/lib/safe-check-container-health.test.ts
- [[populateMetrics()]] - code - src/routes/container/status.ts
- [[reqLogger_1]] - code - src/routes/container/status.ts
- [[response_2]] - code - src/routes/container/status.ts
- [[resultPromise]] - code - src/__tests__/lib/container-helpers.test.ts
- [[safe-check-container-health.test.ts]] - code - src/__tests__/lib/safe-check-container-health.test.ts
- [[safe-check-container-health.test.ts_1]] - code - src/__tests__/lib/safe-check-container-health.test.ts
- [[safeCheckContainerHealth()]] - code - src/lib/container-helpers.ts
- [[sessionsRequest]] - code - src/routes/container/status.ts
- [[status.ts]] - code - src/routes/container/status.ts
- [[user_13]] - code - src/routes/container/status.ts
- [[waitForContainerHealth()]] - code - src/__tests__/lib/container-helpers.test.ts
- [[{ bucketName, containerId, container }]] - code - src/routes/container/status.ts
- [[{ containerId, container }]] - code - src/routes/container/status.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Container_Sync_Status_Responses
SORT file.name ASC
```

## Connections to other communities
- 7 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 7 edges to [[_COMMUNITY_Circuit Breakers + Container Map]]
- 6 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 6 edges to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 3 edges to [[_COMMUNITY_CF Access Type Models]]
- 3 edges to [[_COMMUNITY_Community 77]]
- 2 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 2 edges to [[_COMMUNITY_Container Env + Prefs]]
- 2 edges to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 2 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 1 edge to [[_COMMUNITY_Cache + Admin Result Handling]]
- 1 edge to [[_COMMUNITY_Community 258]]
- 1 edge to [[_COMMUNITY_Community 88]]
- 1 edge to [[_COMMUNITY_Session API Serialization]]
- 1 edge to [[_COMMUNITY_Container Health Routes]]

## Top bridge nodes
- [[container-helpers.ts]] - degree 27, connects to 11 communities
- [[status.ts]] - degree 36, connects to 9 communities
- [[container-helpers.test.ts]] - degree 16, connects to 3 communities
- [[safeCheckContainerHealth()]] - degree 9, connects to 3 communities
- [[getContainerContext()]] - degree 5, connects to 2 communities