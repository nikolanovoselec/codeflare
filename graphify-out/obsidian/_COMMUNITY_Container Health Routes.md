---
type: community
cohesion: 0.08
members: 36
---

# Container Health Routes

**Cohesion:** 0.08 - loosely connected
**Members:** 36 nodes

## Members
- [[initiate, part, complete, abort multipart upload endpoints]] - code - src/routes/storage/upload.ts
- [[DELETE apisessionsid - destroy container then delete KV]] - code - src/routes/session/crud.ts
- [[GET apicontainerhealth - container DO health probe]] - code - src/routes/container/status.ts
- [[GET apicontainerstartup-status - 7-stage startup progression]] - code - src/routes/container/status.ts
- [[GET apisessionsidstatus - container health + PTY probe]] - code - src/routes/session/lifecycle.ts
- [[GET apisessionsbatch-status - KV-authoritative status map]] - code - src/routes/session/lifecycle.ts
- [[GET apistoragebrowse - ListObjectsV2 with auto-bucket-create + seed]] - code - src/routes/storage/browse.ts
- [[GET apistoragedownload - signed R2 fetch, streamed via worker]] - code - src/routes/storage/download.ts
- [[GET apistoragepreview - HEAD then inline text or metadata]] - code - src/routes/storage/preview.ts
- [[GET apistoragestats - paginated ListObjectsV2 + 60s KV cache]] - code - src/routes/storage/stats.ts
- [[List-metadata fast path eliminates N KV.get per session]] - code - src/routes/session/lifecycle.ts
- [[POST apisessions - create session with storage quota check]] - code - src/routes/session/crud.ts
- [[POST apisessionsidstop - persist stopped status then destroy]] - code - src/routes/session/lifecycle.ts
- [[POST apistoragedelete - batch keys + prefix-tree delete]] - code - src/routes/storage/delete.ts
- [[POST apistorageseedagent-configs - reconcile skillsrules to mode]] - code - src/routes/storage/seed.ts
- [[POST apistorageseedgetting-started - recreate starter docs]] - code - src/routes/storage/seed.ts
- [[POST apistorageupload - simple base64 upload to R2]] - code - src/routes/storage/upload.ts
- [[Per-tier storage quota gate on session start (SaaS only)]] - code - src/routes/session/crud.ts
- [[Startup-stage state machine (stopped-starting-syncing-mounting-ready)]] - code - src/routes/container/status.ts
- [[TierConfigSchema - 8-tier config zod validator]] - code - src/routes/admin/tiers.ts
- [[app_58]] - code - src/routes/admin/tiers.ts
- [[app_59]] - code - src/routes/container/index.ts
- [[app_47]] - code - src/routes/session/crud.ts
- [[app_48]] - code - src/routes/session/index.ts
- [[app_49]] - code - src/routes/session/lifecycle.ts
- [[app_55]] - code - src/routes/storage/index.ts
- [[app_53]] - code - src/routes/storage/seed.ts
- [[app_51]] - code - src/routes/storage/upload.ts
- [[buildContentDisposition - CRLF-safe attachment header (RFC 5987)]] - code - src/routes/storage/download.ts
- [[fetchWithTimeout - race container DO fetch against timeout]] - code - src/routes/container/shared.ts
- [[getStoredBucketName - DO internal bucketName fetch via CB]] - code - src/routes/container/shared.ts
- [[index.ts_6]] - code - src/routes/container/index.ts
- [[index.ts_4]] - code - src/routes/session/index.ts
- [[index.ts_5]] - code - src/routes/storage/index.ts
- [[storage-stats{bucket} KV cache (60s TTL)]] - code - src/routes/storage/stats.ts
- [[validateKey - path traversal + protected path + URI decode guard]] - code - src/routes/storage/validation.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Container_Health_Routes
SORT file.name ASC
```

## Connections to other communities
- 6 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 4 edges to [[_COMMUNITY_R2 XML Parsing]]
- 3 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 3 edges to [[_COMMUNITY_Container Env + Prefs]]
- 3 edges to [[_COMMUNITY_Community 78]]
- 3 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 2 edges to [[_COMMUNITY_Session API Serialization]]
- 2 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 2 edges to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 1 edge to [[_COMMUNITY_Community 72]]
- 1 edge to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 1 edge to [[_COMMUNITY_Container Sync Status Responses]]

## Top bridge nodes
- [[index.ts_5]] - degree 13, connects to 8 communities
- [[index.ts_6]] - degree 8, connects to 6 communities
- [[index.ts_4]] - degree 8, connects to 6 communities
- [[app_49]] - degree 5, connects to 1 community
- [[app_58]] - degree 4, connects to 1 community