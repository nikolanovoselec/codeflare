---
type: community
cohesion: 0.04
members: 103
---

# Session State + Limit Validation

**Cohesion:** 0.04 - loosely connected
**Members:** 103 nodes

## Members
- [[.alarm()]] - code - src/timekeeper/index.ts
- [[.buildUpdatedRecord()]] - code - src/timekeeper/index.ts
- [[.constructor()_13]] - code - src/lib/error-types.ts
- [[.constructor()_11]] - code - src/timekeeper/index.ts
- [[.fetch()]] - code - src/timekeeper/index.ts
- [[.handleGetUsage()]] - code - src/timekeeper/index.ts
- [[.handlePing()]] - code - src/timekeeper/index.ts
- [[ActivityState]] - code - src/lib/activity-policy.ts
- [[CleanupResult]] - code - src/lib/user-cleanup.ts
- [[NOW]] - code - src/__tests__/timekeeper/index.test.ts
- [[NotFoundError]] - code - src/lib/error-types.ts
- [[PingBody]] - code - src/timekeeper/index.ts
- [[SETUP_KEYS]] - code - src/lib/kv-keys.ts
- [[Session_1]] - code - src/types.ts
- [[SessionListMetadata]] - code - src/lib/kv-keys.ts
- [[THIS_MONTH]] - code - src/__tests__/timekeeper/index.test.ts
- [[THIS_WEEK_START]] - code - src/__tests__/timekeeper/index.test.ts
- [[THIS_YEAR]] - code - src/__tests__/timekeeper/index.test.ts
- [[TODAY]] - code - src/__tests__/timekeeper/index.test.ts
- [[Timekeeper]] - code - src/timekeeper/index.ts
- [[UsageRecord]] - code - src/types.ts
- [[YESTERDAY]] - code - src/__tests__/timekeeper/index.test.ts
- [[activePty]] - code - src/routes/session/lifecycle.ts
- [[activity-policy.ts]] - code - src/lib/activity-policy.ts
- [[bucketName_10]] - code - src/routes/session/lifecycle.ts
- [[buildSessionMetadata()]] - code - src/lib/kv-keys.ts
- [[cleanupUserData()]] - code - src/lib/user-cleanup.ts
- [[collectMetrics()]] - code - src/container/container-metrics.ts
- [[container_8]] - code - src/routes/session/lifecycle.ts
- [[container-metrics.ts]] - code - src/container/container-metrics.ts
- [[containerId_3]] - code - src/routes/session/lifecycle.ts
- [[createTimekeeper()]] - code - src/__tests__/timekeeper/index.test.ts
- [[currentDate_1]] - code - src/routes/session/lifecycle.ts
- [[currentMonth_1]] - code - src/routes/session/lifecycle.ts
- [[date]] - code - src/__tests__/lib/kv-keys.test.ts
- [[deleteScopedR2Token()]] - code - src/lib/r2-admin.ts
- [[emailFromKvKey()]] - code - src/lib/kv-keys.ts
- [[emptyR2Bucket()]] - code - src/lib/r2-client.ts
- [[expandSessionMetadata()]] - code - src/lib/kv-keys.ts
- [[expected]] - code - src/__tests__/lib/kv-keys.test.ts
- [[fallbackKeys]] - code - src/routes/session/lifecycle.ts
- [[generateSessionId()]] - code - src/lib/kv-keys.ts
- [[getCachedUserRecord()]] - code - src/timekeeper/index.ts
- [[getContainerId()]] - code - src/lib/container-helpers.ts
- [[getDeployKeysKey()]] - code - src/lib/kv-keys.ts
- [[getIsoWeekStart()]] - code - src/lib/kv-keys.ts
- [[getLlmKeysKey()]] - code - src/lib/kv-keys.ts
- [[getNextUtcMonthStart()]] - code - src/lib/kv-keys.ts
- [[getPresetsKey()]] - code - src/lib/kv-keys.ts
- [[getSessionKey()]] - code - src/lib/kv-keys.ts
- [[getSessionOrThrow()]] - code - src/lib/kv-keys.ts
- [[getSessionPrefix()]] - code - src/lib/kv-keys.ts
- [[getTiersConfigKey()]] - code - src/lib/kv-keys.ts
- [[getTimekeeperKey()]] - code - src/lib/kv-keys.ts
- [[getUtcDateString()]] - code - src/lib/kv-keys.ts
- [[getUtcMonthString()]] - code - src/lib/kv-keys.ts
- [[id]] - code - src/__tests__/lib/kv-keys.test.ts
- [[ids_1]] - code - src/__tests__/lib/kv-keys.test.ts
- [[index.test.ts_1]] - code - src/__tests__/timekeeper/index.test.ts
- [[index.ts_1]] - code - src/timekeeper/index.ts
- [[key_5]] - code - src/routes/session/lifecycle.ts
- [[kv-keys.test.ts]] - code - src/__tests__/lib/kv-keys.test.ts
- [[kv-keys.ts]] - code - src/lib/kv-keys.ts
- [[lastPendingWrite]] - code - src/__tests__/timekeeper/index.test.ts
- [[lifecycle.ts]] - code - src/routes/session/lifecycle.ts
- [[listAllKvKeys()]] - code - src/lib/kv-keys.ts
- [[logger_30]] - code - src/container/container-metrics.ts
- [[logger_7]] - code - src/lib/user-cleanup.ts
- [[logger_4]] - code - src/timekeeper/index.ts
- [[maxSessions]] - code - src/routes/session/lifecycle.ts
- [[meta]] - code - src/__tests__/lib/kv-keys.test.ts
- [[meta_1]] - code - src/routes/session/lifecycle.ts
- [[mockKV_1]] - code - src/__tests__/lib/kv-keys.test.ts
- [[mockKV]] - code - src/__tests__/timekeeper/index.test.ts
- [[mockStorage]] - code - src/__tests__/timekeeper/index.test.ts
- [[now_7]] - code - src/routes/session/lifecycle.ts
- [[parseSleepAfterMs()_1]] - code - src/container/container-metrics.ts
- [[pingRequest()]] - code - src/__tests__/timekeeper/index.test.ts
- [[prefix_3]] - code - src/routes/session/lifecycle.ts
- [[putSessionWithMetadata()]] - code - src/lib/kv-keys.ts
- [[record]] - code - src/__tests__/timekeeper/index.test.ts
- [[resetUserRecordCache()]] - code - src/timekeeper/index.ts
- [[result_21]] - code - src/__tests__/lib/kv-keys.test.ts
- [[result_29]] - code - src/routes/session/lifecycle.ts
- [[sanitizeSessionName()]] - code - src/lib/kv-keys.ts
- [[session_8]] - code - src/__tests__/lib/kv-keys.test.ts
- [[sessionId_4]] - code - src/routes/session/lifecycle.ts
- [[sessionStopRateLimiter]] - code - src/routes/session/lifecycle.ts
- [[sleep-timer-defaults.test.ts]] - code - src/__tests__/lib/sleep-timer-defaults.test.ts
- [[statuses]] - code - src/routes/session/lifecycle.ts
- [[tier_3]] - code - src/routes/session/lifecycle.ts
- [[tk]] - code - src/__tests__/timekeeper/index.test.ts
- [[updateKvStatus()]] - code - src/container/container-metrics.ts
- [[updated_6]] - code - src/routes/session/lifecycle.ts
- [[usageRecord]] - code - src/__tests__/timekeeper/index.test.ts
- [[user_9]] - code - src/routes/session/lifecycle.ts
- [[user-cleanup.test.ts_1]] - code - src/__tests__/lib/user-cleanup.test.ts
- [[user-cleanup.ts]] - code - src/lib/user-cleanup.ts
- [[userRecord]] - code - src/__tests__/timekeeper/index.test.ts
- [[userRecordCache]] - code - src/timekeeper/index.ts
- [[validateSessionAndCheckLimits()]] - code - src/routes/container/lifecycle.ts
- [[values]] - code - src/__tests__/lib/kv-keys.test.ts
- [[written]] - code - src/__tests__/timekeeper/index.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Session_State__Limit_Validation
SORT file.name ASC
```

## Connections to other communities
- 21 edges to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 19 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 16 edges to [[_COMMUNITY_Container Env + Prefs]]
- 15 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 15 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 14 edges to [[_COMMUNITY_Session API Serialization]]
- 13 edges to [[_COMMUNITY_Admin TierSlot Counting]]
- 10 edges to [[_COMMUNITY_Community 88]]
- 9 edges to [[_COMMUNITY_Community 61]]
- 9 edges to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 8 edges to [[_COMMUNITY_Community 77]]
- 8 edges to [[_COMMUNITY_Auth Cookie + Bucket Resolution]]
- 7 edges to [[_COMMUNITY_Cache + Admin Result Handling]]
- 7 edges to [[_COMMUNITY_R2 XML Parsing]]
- 6 edges to [[_COMMUNITY_Container Sync Status Responses]]
- 6 edges to [[_COMMUNITY_KV Crypto (AES-GCM)]]
- 6 edges to [[_COMMUNITY_Setup + Origins Configuration]]
- 4 edges to [[_COMMUNITY_Community 75]]
- 4 edges to [[_COMMUNITY_Community 135]]
- 3 edges to [[_COMMUNITY_Stripe Checkout + Trial Flow]]
- 3 edges to [[_COMMUNITY_Community 67]]
- 3 edges to [[_COMMUNITY_Circuit Breakers + Container Map]]
- 3 edges to [[_COMMUNITY_Community 161]]
- 2 edges to [[_COMMUNITY_File Preview UI]]
- 2 edges to [[_COMMUNITY_Community 89]]
- 2 edges to [[_COMMUNITY_Community 139]]
- 2 edges to [[_COMMUNITY_Community 78]]
- 2 edges to [[_COMMUNITY_Community 87]]
- 2 edges to [[_COMMUNITY_OAuth Nonce + HMAC]]
- 2 edges to [[_COMMUNITY_Community 124]]
- 2 edges to [[_COMMUNITY_Auth Subscribe Routes]]
- 2 edges to [[_COMMUNITY_Community 152]]
- 2 edges to [[_COMMUNITY_CF Access Type Models]]
- 2 edges to [[_COMMUNITY_Community 83]]
- 2 edges to [[_COMMUNITY_Community 63]]
- 2 edges to [[_COMMUNITY_Container Health Routes]]
- 1 edge to [[_COMMUNITY_Session Creation + Header UI]]
- 1 edge to [[_COMMUNITY_User Management + Tier Resolution]]
- 1 edge to [[_COMMUNITY_Community 162]]
- 1 edge to [[_COMMUNITY_Community 60]]
- 1 edge to [[_COMMUNITY_Community 143]]

## Top bridge nodes
- [[kv-keys.ts]] - degree 64, connects to 24 communities
- [[lifecycle.ts]] - degree 61, connects to 15 communities
- [[SETUP_KEYS]] - degree 18, connects to 15 communities
- [[user-cleanup.ts]] - degree 37, connects to 14 communities
- [[Session_1]] - degree 21, connects to 12 communities