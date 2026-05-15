---
type: community
cohesion: 0.04
members: 69
---

# Container Lifecycle + Rate Limiting

**Cohesion:** 0.04 - loosely connected
**Members:** 69 nodes

## Members
- [[AGENT_COMMANDS]] - code - src/lib/agent-config.ts
- [[AgentTypeSchema_1]] - code - src/types.ts
- [[AgentTypeSchema_3]] - code - src/types.ts
- [[ContainerConfigPayload]] - code - src/types.ts
- [[DEFAULT_ALLOWED_ORIGINS]] - code - src/lib/constants.ts
- [[EMPTY_LISTING]] - code - src/routes/storage/browse.ts
- [[EXPECTED_COMMANDS]] - code - src/__tests__/lib/agent-config.test.ts
- [[MAX_TABS]] - code - src/lib/constants.ts
- [[PROTECTED_PATHS]] - code - src/lib/constants.ts
- [[SESSION_ID_PATTERN]] - code - src/lib/constants.ts
- [[SessionMode]] - code - src/types.ts
- [[SetBucketNameBodySchema]] - code - src/lib/container-config-schema.ts
- [[TERMINAL_SERVER_PORT]] - code - src/lib/constants.ts
- [[agent-config.test.ts]] - code - src/__tests__/lib/agent-config.test.ts
- [[agent-config.test.ts_1]] - code - src/__tests__/lib/agent-config.test.ts
- [[agent-config.ts]] - code - src/lib/agent-config.ts
- [[app_61]] - code - src/routes/container/lifecycle.ts
- [[app_52]] - code - src/routes/storage/browse.ts
- [[browse.ts]] - code - src/routes/storage/browse.ts
- [[bucketName_18]] - code - src/routes/container/lifecycle.ts
- [[bucketName_13]] - code - src/routes/storage/browse.ts
- [[constants.test.ts_1]] - code - src/__tests__/contract/constants.test.ts
- [[constants.test.ts]] - code - src/__tests__/lib/constants.test.ts
- [[constants.test.ts_2]] - code - src/__tests__/lib/constants.test.ts
- [[constants.ts_1]] - code - src/lib/constants.ts
- [[container_9]] - code - src/routes/container/lifecycle.ts
- [[container-config-schema.ts]] - code - src/lib/container-config-schema.ts
- [[containerId_4]] - code - src/routes/container/lifecycle.ts
- [[containerStartRateLimiter]] - code - src/routes/container/lifecycle.ts
- [[continuationToken]] - code - src/routes/storage/browse.ts
- [[effectiveTier_6]] - code - src/routes/container/lifecycle.ts
- [[effectiveTier_4]] - code - src/routes/storage/browse.ts
- [[envKeys]] - code - src/__tests__/lib/constants.test.ts
- [[err_2]] - code - src/routes/container/lifecycle.ts
- [[expected_1]] - code - src/__tests__/lib/agent-config.test.ts
- [[getDefaultTabConfig()]] - code - src/lib/agent-config.ts
- [[getMaxSessions()]] - code - src/lib/constants.ts
- [[ids_3]] - code - src/__tests__/lib/agent-config.test.ts
- [[lifecycle.ts_1]] - code - src/routes/container/lifecycle.ts
- [[logger_25]] - code - src/routes/storage/browse.ts
- [[longKey_2]] - code - src/__tests__/routes/storage-validation.test.ts
- [[maxKey]] - code - src/__tests__/routes/storage-validation.test.ts
- [[maxKeysParam]] - code - src/routes/storage/browse.ts
- [[maxSessions_1]] - code - src/routes/container/lifecycle.ts
- [[mode]] - code - src/routes/storage/browse.ts
- [[params_3]] - code - src/routes/storage/browse.ts
- [[preferences]] - code - src/routes/storage/browse.ts
- [[preferencesKey_1]] - code - src/routes/container/lifecycle.ts
- [[prefsKey_2]] - code - src/routes/storage/browse.ts
- [[r2Client_2]] - code - src/routes/storage/browse.ts
- [[reqLogger_2]] - code - src/routes/container/lifecycle.ts
- [[resolveSessionMode()]] - code - src/lib/session-mode.ts
- [[result_27]] - code - src/__tests__/routes/storage-validation.test.ts
- [[result_31]] - code - src/routes/storage/browse.ts
- [[session-mode.test.ts]] - code - src/__tests__/lib/session-mode.test.ts
- [[session-mode.test.ts_1]] - code - src/__tests__/lib/session-mode.test.ts
- [[session-mode.ts]] - code - src/lib/session-mode.ts
- [[sessionId_5]] - code - src/routes/container/lifecycle.ts
- [[sessionKey_1]] - code - src/routes/container/lifecycle.ts
- [[sessionMode]] - code - src/routes/container/lifecycle.ts
- [[shortContainerId]] - code - src/routes/container/lifecycle.ts
- [[storage-validation.test.ts]] - code - src/__tests__/routes/storage-validation.test.ts
- [[storageBrowseRateLimiter]] - code - src/routes/storage/browse.ts
- [[tabs_2]] - code - src/__tests__/lib/agent-config.test.ts
- [[user_14]] - code - src/routes/container/lifecycle.ts
- [[user_11]] - code - src/routes/storage/browse.ts
- [[validateKey()]] - code - src/routes/storage/validation.ts
- [[validation.ts]] - code - src/routes/storage/validation.ts
- [[{ containerId, container }_1]] - code - src/routes/container/lifecycle.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Container_Lifecycle__Rate_Limiting
SORT file.name ASC
```

## Connections to other communities
- 22 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 21 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 11 edges to [[_COMMUNITY_Container Env + Prefs]]
- 11 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 11 edges to [[_COMMUNITY_Community 87]]
- 8 edges to [[_COMMUNITY_R2 XML Parsing]]
- 7 edges to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 7 edges to [[_COMMUNITY_Cache + Admin Result Handling]]
- 7 edges to [[_COMMUNITY_Community 75]]
- 7 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 6 edges to [[_COMMUNITY_Admin TierSlot Counting]]
- 6 edges to [[_COMMUNITY_Container Sync Status Responses]]
- 6 edges to [[_COMMUNITY_Community 88]]
- 4 edges to [[_COMMUNITY_Community 176]]
- 4 edges to [[_COMMUNITY_KV Crypto (AES-GCM)]]
- 3 edges to [[_COMMUNITY_Session Creation + Header UI]]
- 3 edges to [[_COMMUNITY_Community 140]]
- 3 edges to [[_COMMUNITY_Session API Serialization]]
- 2 edges to [[_COMMUNITY_Community 124]]
- 2 edges to [[_COMMUNITY_Community 77]]
- 2 edges to [[_COMMUNITY_Community 135]]
- 2 edges to [[_COMMUNITY_Container Health Routes]]
- 2 edges to [[_COMMUNITY_Community 72]]
- 1 edge to [[_COMMUNITY_Session State Atoms]]
- 1 edge to [[_COMMUNITY_Community 78]]
- 1 edge to [[_COMMUNITY_Test App Factory]]
- 1 edge to [[_COMMUNITY_Community 60]]
- 1 edge to [[_COMMUNITY_Community 89]]
- 1 edge to [[_COMMUNITY_Community 139]]
- 1 edge to [[_COMMUNITY_CF Access Type Models]]
- 1 edge to [[_COMMUNITY_Circuit Breakers + Container Map]]
- 1 edge to [[_COMMUNITY_Community 161]]
- 1 edge to [[_COMMUNITY_Auth Cookie + Bucket Resolution]]

## Top bridge nodes
- [[lifecycle.ts_1]] - degree 93, connects to 20 communities
- [[browse.ts]] - degree 49, connects to 14 communities
- [[constants.ts_1]] - degree 29, connects to 14 communities
- [[SESSION_ID_PATTERN]] - degree 9, connects to 6 communities
- [[validation.ts]] - degree 12, connects to 5 communities