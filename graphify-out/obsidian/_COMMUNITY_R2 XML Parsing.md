---
type: community
cohesion: 0.04
members: 65
---

# R2 XML Parsing

**Cohesion:** 0.04 - loosely connected
**Members:** 65 nodes

## Members
- [[AbortUploadSchema]] - code - src/routes/storage/upload.ts
- [[CachedStats]] - code - src/routes/storage/stats.ts
- [[CompleteUploadBodySchema]] - code - src/routes/storage/upload.ts
- [[DeleteBodySchema]] - code - src/routes/storage/delete.ts
- [[EMPTY_STATS]] - code - src/routes/storage/stats.ts
- [[InitiateUploadSchema]] - code - src/routes/storage/upload.ts
- [[SimpleUploadSchema]] - code - src/routes/storage/upload.ts
- [[StorageListResult_1]] - code - src/types.ts
- [[UploadPartSchema]] - code - src/routes/storage/upload.ts
- [[app_4]] - code - src/__tests__/routes/rate-limits.test.ts
- [[app_54]] - code - src/routes/storage/delete.ts
- [[app_50]] - code - src/routes/storage/stats.ts
- [[assertRateLimited()]] - code - src/__tests__/routes/rate-limits.test.ts
- [[bucketName_15]] - code - src/routes/storage/delete.ts
- [[bucketName_11]] - code - src/routes/storage/stats.ts
- [[bucketName_12]] - code - src/routes/storage/upload.ts
- [[content_1]] - code - src/__tests__/routes/rate-limits.test.ts
- [[decodeXmlEntities()]] - code - src/lib/xml-utils.ts
- [[delete.ts]] - code - src/routes/storage/delete.ts
- [[deleted_1]] - code - src/routes/storage/delete.ts
- [[deletedMatches]] - code - src/routes/storage/delete.ts
- [[deletedPrefixes]] - code - src/routes/storage/delete.ts
- [[effectiveTier_3]] - code - src/routes/storage/stats.ts
- [[errorMatches]] - code - src/routes/storage/delete.ts
- [[errors]] - code - src/routes/storage/delete.ts
- [[extractTag()_1]] - code - src/lib/r2-client.ts
- [[folderSet]] - code - src/routes/storage/stats.ts
- [[getR2Url()]] - code - src/lib/r2-client.ts
- [[logger_27]] - code - src/routes/storage/delete.ts
- [[logger_24]] - code - src/routes/storage/stats.ts
- [[mockR2Fetch]] - code - src/__tests__/routes/rate-limits.test.ts
- [[mockSign_1]] - code - src/__tests__/routes/rate-limits.test.ts
- [[objectsXml]] - code - src/routes/storage/delete.ts
- [[params_2]] - code - src/routes/storage/stats.ts
- [[parseInitiateMultipartUploadXml()]] - code - src/lib/r2-client.ts
- [[parseListObjectsXml()]] - code - src/lib/r2-client.ts
- [[parsed_18]] - code - src/routes/storage/delete.ts
- [[parsed_17]] - code - src/routes/storage/upload.ts
- [[parts_4]] - code - src/routes/storage/stats.ts
- [[partsXml]] - code - src/routes/storage/upload.ts
- [[r2-client.test.ts_1]] - code - src/__tests__/lib/r2-client.test.ts
- [[r2-client.ts]] - code - src/lib/r2-client.ts
- [[r2Client_3]] - code - src/routes/storage/delete.ts
- [[r2Client]] - code - src/routes/storage/stats.ts
- [[r2Client_1]] - code - src/routes/storage/upload.ts
- [[rate-limits.test.ts]] - code - src/__tests__/routes/rate-limits.test.ts
- [[result_30]] - code - src/routes/storage/stats.ts
- [[sanitizedKey]] - code - src/routes/storage/upload.ts
- [[singleUrl]] - code - src/routes/storage/delete.ts
- [[stats.ts]] - code - src/routes/storage/stats.ts
- [[statsToCache]] - code - src/routes/storage/stats.ts
- [[storageDeleteRateLimiter]] - code - src/routes/storage/delete.ts
- [[storageEnv()]] - code - src/__tests__/routes/rate-limits.test.ts
- [[storageStatsRateLimiter]] - code - src/routes/storage/stats.ts
- [[storageUploadRateLimiter]] - code - src/routes/storage/upload.ts
- [[tier_4]] - code - src/routes/storage/stats.ts
- [[upload.ts]] - code - src/routes/storage/upload.ts
- [[uploadId_1]] - code - src/routes/storage/upload.ts
- [[url_9]] - code - src/routes/storage/delete.ts
- [[url_8]] - code - src/routes/storage/upload.ts
- [[user_10]] - code - src/routes/storage/stats.ts
- [[validatedKeys]] - code - src/routes/storage/delete.ts
- [[validatedPrefixes]] - code - src/routes/storage/delete.ts
- [[xml-utils.test.ts]] - code - src/__tests__/lib/xml-utils.test.ts
- [[xml-utils.ts]] - code - src/lib/xml-utils.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/R2_XML_Parsing
SORT file.name ASC
```

## Connections to other communities
- 20 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 11 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 10 edges to [[_COMMUNITY_Container Env + Prefs]]
- 9 edges to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 8 edges to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 7 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 7 edges to [[_COMMUNITY_Community 87]]
- 6 edges to [[_COMMUNITY_Cache + Admin Result Handling]]
- 6 edges to [[_COMMUNITY_Community 93]]
- 5 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 5 edges to [[_COMMUNITY_Test App Factory]]
- 5 edges to [[_COMMUNITY_Community 72]]
- 4 edges to [[_COMMUNITY_Community 143]]
- 4 edges to [[_COMMUNITY_Container Health Routes]]
- 3 edges to [[_COMMUNITY_Admin TierSlot Counting]]
- 1 edge to [[_COMMUNITY_Community 364]]
- 1 edge to [[_COMMUNITY_Session API Serialization]]
- 1 edge to [[_COMMUNITY_Community 152]]
- 1 edge to [[_COMMUNITY_Community 161]]
- 1 edge to [[_COMMUNITY_Auth Cookie + Bucket Resolution]]
- 1 edge to [[_COMMUNITY_Community 75]]

## Top bridge nodes
- [[upload.ts]] - degree 41, connects to 11 communities
- [[r2-client.ts]] - degree 24, connects to 11 communities
- [[delete.ts]] - degree 43, connects to 10 communities
- [[stats.ts]] - degree 40, connects to 9 communities
- [[rate-limits.test.ts]] - degree 22, connects to 7 communities