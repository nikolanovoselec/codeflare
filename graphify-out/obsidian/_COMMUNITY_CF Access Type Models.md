---
type: community
cohesion: 0.11
members: 33
---

# CF Access Type Models

**Cohesion:** 0.11 - loosely connected
**Members:** 33 nodes

## Members
- [[.onError()]] - code - src/container/index.ts
- [[AccessApp]] - code - src/routes/setup/access.ts
- [[AccessAppResult]] - code - src/routes/setup/access.ts
- [[AccessGroup]] - code - src/routes/setup/access.ts
- [[AccessGroupResult]] - code - src/routes/setup/access.ts
- [[PROTECTED_DESTINATION_SUFFIXES]] - code - src/routes/setup/access.ts
- [[access.test.ts_1]] - code - src/__tests__/routes/setup/access.test.ts
- [[access.ts_1]] - code - src/routes/setup/access.ts
- [[cfSuccess()]] - code - src/__tests__/routes/setup/access.test.ts
- [[deleteAccessApp()]] - code - src/routes/setup/access.ts
- [[getAccessGroupNames()]] - code - src/routes/setup/access.ts
- [[getLegacyManagedDomains()]] - code - src/routes/setup/access.ts
- [[getManagedAppDomain()]] - code - src/routes/setup/access.ts
- [[getManagedAppName()]] - code - src/routes/setup/access.ts
- [[getManagedDestinations()]] - code - src/routes/setup/access.ts
- [[handleCreateAccessApp()]] - code - src/routes/setup/access.ts
- [[isAlreadyExistsError()]] - code - src/routes/setup/access.ts
- [[listAccessApps()]] - code - src/routes/setup/access.ts
- [[listAccessGroups()]] - code - src/routes/setup/access.ts
- [[listIdentityProviders()]] - code - src/routes/setup/access.ts
- [[mockFetch_17]] - code - src/__tests__/routes/setup/access.test.ts
- [[mockIdpList]] - code - src/__tests__/routes/setup/access.test.ts
- [[names]] - code - src/__tests__/routes/setup/access.test.ts
- [[policyBody_1]] - code - src/__tests__/routes/setup/access.test.ts
- [[policyCall_1]] - code - src/__tests__/routes/setup/access.test.ts
- [[pruneLegacyAccessApps()]] - code - src/routes/setup/access.ts
- [[resolveManagedAccessApp()]] - code - src/routes/setup/access.ts
- [[steps_2]] - code - src/__tests__/routes/setup/access.test.ts
- [[storeAccessConfig()]] - code - src/routes/setup/access.ts
- [[toErrorMessage()]] - code - src/lib/error-types.ts
- [[upsertAccessApp()]] - code - src/routes/setup/access.ts
- [[upsertAccessGroup()]] - code - src/routes/setup/access.ts
- [[upsertAccessPolicy()]] - code - src/routes/setup/access.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/CF_Access_Type_Models
SORT file.name ASC
```

## Connections to other communities
- 12 edges to [[_COMMUNITY_Community 63]]
- 7 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 4 edges to [[_COMMUNITY_Community 79]]
- 3 edges to [[_COMMUNITY_Container Sync Status Responses]]
- 3 edges to [[_COMMUNITY_Container Env + Prefs]]
- 3 edges to [[_COMMUNITY_Community 88]]
- 3 edges to [[_COMMUNITY_Community 83]]
- 2 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 2 edges to [[_COMMUNITY_Community 124]]
- 2 edges to [[_COMMUNITY_Circuit Breakers + Container Map]]
- 2 edges to [[_COMMUNITY_Setup + Origins Configuration]]
- 1 edge to [[_COMMUNITY_Cache + Admin Result Handling]]
- 1 edge to [[_COMMUNITY_Deploy Keys CRUD]]
- 1 edge to [[_COMMUNITY_Community 77]]
- 1 edge to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 1 edge to [[_COMMUNITY_Community 75]]
- 1 edge to [[_COMMUNITY_Community 87]]

## Top bridge nodes
- [[toErrorMessage()]] - degree 25, connects to 11 communities
- [[access.ts_1]] - degree 39, connects to 7 communities
- [[access.test.ts_1]] - degree 15, connects to 3 communities
- [[handleCreateAccessApp()]] - degree 16, connects to 2 communities
- [[upsertAccessApp()]] - degree 7, connects to 1 community