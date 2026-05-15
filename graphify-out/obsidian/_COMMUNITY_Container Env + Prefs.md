---
type: community
cohesion: 0.08
members: 34
---

# Container Env + Prefs

**Cohesion:** 0.08 - loosely connected
**Members:** 34 nodes

## Members
- [[ContainerEnvState]] - code - src/container/container-env.ts
- [[Env]] - code - src/types.ts
- [[MetricsCallbacks]] - code - src/container/container-metrics.ts
- [[MetricsState]] - code - src/container/container-metrics.ts
- [[RestartPrefsInput]] - code - src/container/container-env.ts
- [[SetBucketNameCreds]] - code - src/container/container-env.ts
- [[TabConfig]] - code - src/types.ts
- [[applyBucketName()]] - code - src/container/container-env.ts
- [[applyPrefsOnRestart()]] - code - src/container/container-env.ts
- [[buildEnvVars()]] - code - src/container/container-env.ts
- [[container-env.ts]] - code - src/container/container-env.ts
- [[containerState]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[createEnv()]] - code - src/__tests__/lib/r2-config.test.ts
- [[createEnv()_1]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[deleteIdx]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[env_5]] - code - src/__tests__/lib/r2-config.test.ts
- [[getIdx]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[getR2Config()]] - code - src/lib/r2-config.ts
- [[index.ts_7]] - code - src/container/index.ts
- [[kvCallOrder]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[logger_31]] - code - src/container/container-env.ts
- [[mockCreateR2Client]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[mockDeleteScopedR2Token]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[mockEmptyR2Bucket]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[mockFetch_7]] - code - src/__tests__/lib/r2-config.test.ts
- [[mockFetch_10]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[mockGetContainer]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[origDelete]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[origGet]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[r2-config.test.ts]] - code - src/__tests__/lib/r2-config.test.ts
- [[r2-config.ts]] - code - src/lib/r2-config.ts
- [[sanitized]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[user-cleanup.test.ts]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[validateBucketNameInput()]] - code - src/container/container-env.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Container_Env__Prefs
SORT file.name ASC
```

## Connections to other communities
- 26 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 17 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 16 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 11 edges to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 10 edges to [[_COMMUNITY_R2 XML Parsing]]
- 8 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 7 edges to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 6 edges to [[_COMMUNITY_Session Creation + Header UI]]
- 6 edges to [[_COMMUNITY_Community 88]]
- 5 edges to [[_COMMUNITY_Community 135]]
- 4 edges to [[_COMMUNITY_Auth Cookie + Bucket Resolution]]
- 3 edges to [[_COMMUNITY_Stripe Checkout + Trial Flow]]
- 3 edges to [[_COMMUNITY_Container Health Routes]]
- 3 edges to [[_COMMUNITY_Community 72]]
- 3 edges to [[_COMMUNITY_CF Access Type Models]]
- 2 edges to [[_COMMUNITY_KV Crypto (AES-GCM)]]
- 2 edges to [[_COMMUNITY_Community 87]]
- 2 edges to [[_COMMUNITY_Container Sync Status Responses]]
- 2 edges to [[_COMMUNITY_Community 83]]
- 1 edge to [[_COMMUNITY_User Management + Tier Resolution]]
- 1 edge to [[_COMMUNITY_File Preview UI]]
- 1 edge to [[_COMMUNITY_Community 68]]
- 1 edge to [[_COMMUNITY_Session State Atoms]]
- 1 edge to [[_COMMUNITY_Floating Terminal UI]]
- 1 edge to [[_COMMUNITY_Community 110]]
- 1 edge to [[_COMMUNITY_Community 78]]
- 1 edge to [[_COMMUNITY_Community 278]]
- 1 edge to [[_COMMUNITY_Community 198]]
- 1 edge to [[_COMMUNITY_Community 165]]
- 1 edge to [[_COMMUNITY_Community 162]]
- 1 edge to [[_COMMUNITY_Community 103]]
- 1 edge to [[_COMMUNITY_CF Access Mocks]]
- 1 edge to [[_COMMUNITY_Community 60]]
- 1 edge to [[_COMMUNITY_Community 89]]
- 1 edge to [[_COMMUNITY_Community 177]]
- 1 edge to [[_COMMUNITY_Test App Factory]]
- 1 edge to [[_COMMUNITY_Community 124]]
- 1 edge to [[_COMMUNITY_Auth Subscribe Routes]]
- 1 edge to [[_COMMUNITY_Community 61]]
- 1 edge to [[_COMMUNITY_Community 67]]
- 1 edge to [[_COMMUNITY_OAuth Nonce + HMAC]]
- 1 edge to [[_COMMUNITY_Community 77]]
- 1 edge to [[_COMMUNITY_Community 152]]
- 1 edge to [[_COMMUNITY_Setup + Origins Configuration]]
- 1 edge to [[_COMMUNITY_Session API Serialization]]
- 1 edge to [[_COMMUNITY_Community 65]]
- 1 edge to [[_COMMUNITY_Community 79]]
- 1 edge to [[_COMMUNITY_Community 161]]

## Top bridge nodes
- [[Env]] - degree 87, connects to 36 communities
- [[r2-config.ts]] - degree 24, connects to 10 communities
- [[getR2Config()]] - degree 21, connects to 9 communities
- [[TabConfig]] - degree 16, connects to 9 communities
- [[index.ts_7]] - degree 25, connects to 7 communities