---
type: community
cohesion: 0.10
members: 34
---

# Auth Cookie + Bucket Resolution

**Cohesion:** 0.10 - loosely connected
**Members:** 34 nodes

## Members
- [[.constructor()_16]] - code - src/lib/error-types.ts
- [[.constructor()_17]] - code - src/lib/error-types.ts
- [[AppContent()]] - code - web-ui/src/App.tsx
- [[AuthError]] - code - src/lib/error-types.ts
- [[ForbiddenError]] - code - src/lib/error-types.ts
- [[VALID_ACCESS_TIERS]] - code - src/lib/access.ts
- [[VALID_SUBSCRIPTION_TIERS]] - code - src/lib/access.ts
- [[access-cookie-jwt.test.ts]] - code - src/__tests__/lib/access-cookie-jwt.test.ts
- [[access.test.ts]] - code - src/__tests__/lib/access.test.ts
- [[access.ts]] - code - src/lib/access.ts
- [[authenticateRequest()]] - code - src/lib/access.ts
- [[env_1]] - code - src/__tests__/lib/access.test.ts
- [[env_2]] - code - src/__tests__/lib/jit-provisioning.test.ts
- [[flag]] - code - src/__tests__/lib/access.test.ts
- [[getBucketName()]] - code - src/lib/access.ts
- [[getCookieValue()_1]] - code - src/lib/access.ts
- [[getUserFromRequest()]] - code - src/lib/access.ts
- [[isSaasModeActive()]] - code - src/lib/onboarding.ts
- [[jit-provisioning.test.ts]] - code - src/__tests__/lib/jit-provisioning.test.ts
- [[jit-provisioning.test.ts_1]] - code - src/__tests__/lib/jit-provisioning.test.ts
- [[logger_6]] - code - src/lib/access.ts
- [[makeEnv()_1]] - code - src/__tests__/lib/access-cookie-jwt.test.ts
- [[makeEnv()]] - code - src/__tests__/lib/access.test.ts
- [[makeEnv()_2]] - code - src/__tests__/lib/jit-provisioning.test.ts
- [[mockKV_2]] - code - src/__tests__/lib/access-cookie-jwt.test.ts
- [[name_1]] - code - src/__tests__/lib/access.test.ts
- [[normalizeEmail()_1]] - code - src/lib/access.ts
- [[request_2]] - code - src/__tests__/lib/access-cookie-jwt.test.ts
- [[request_1]] - code - src/__tests__/lib/access.test.ts
- [[resolveOrProvisionUser()]] - code - src/lib/access.ts
- [[resolveUserFromKV()]] - code - src/lib/access.ts
- [[trimTrailingHyphens()]] - code - src/lib/access.ts
- [[{ mockLoggerWarn }]] - code - src/__tests__/lib/access.test.ts
- [[{ mockSendWelcomeEmail }]] - code - src/__tests__/lib/access.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Auth_Cookie__Bucket_Resolution
SORT file.name ASC
```

## Connections to other communities
- 24 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 9 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 8 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 8 edges to [[_COMMUNITY_Community 124]]
- 8 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 7 edges to [[_COMMUNITY_Community 135]]
- 7 edges to [[_COMMUNITY_Community 77]]
- 4 edges to [[_COMMUNITY_Container Env + Prefs]]
- 4 edges to [[_COMMUNITY_Community 61]]
- 3 edges to [[_COMMUNITY_Community 78]]
- 3 edges to [[_COMMUNITY_CF Access Mocks]]
- 3 edges to [[_COMMUNITY_Community 92]]
- 3 edges to [[_COMMUNITY_Community 103]]
- 3 edges to [[_COMMUNITY_Community 161]]
- 3 edges to [[_COMMUNITY_Community 93]]
- 3 edges to [[_COMMUNITY_Auth Subscribe Routes]]
- 3 edges to [[_COMMUNITY_Setup + Origins Configuration]]
- 2 edges to [[_COMMUNITY_Cache + Admin Result Handling]]
- 1 edge to [[_COMMUNITY_Setup + Auth Provider API]]
- 1 edge to [[_COMMUNITY_Billing API Client]]
- 1 edge to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 1 edge to [[_COMMUNITY_Session API Serialization]]
- 1 edge to [[_COMMUNITY_R2 XML Parsing]]
- 1 edge to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 1 edge to [[_COMMUNITY_Community 87]]

## Top bridge nodes
- [[access.ts]] - degree 54, connects to 19 communities
- [[isSaasModeActive()]] - degree 24, connects to 13 communities
- [[getBucketName()]] - degree 10, connects to 6 communities
- [[access.test.ts]] - degree 21, connects to 5 communities
- [[ForbiddenError]] - degree 12, connects to 5 communities