---
source_file: "src/routes/storage/stats.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# storage-stats:{bucket} KV cache (60s TTL)

## Connections
- [[GET apisessionsbatch-status - KV-authoritative status map]] - `shares_data_with` [EXTRACTED]
- [[GET apistoragestats - paginated ListObjectsV2 + 60s KV cache]] - `implements` [EXTRACTED]
- [[POST apistoragedelete - batch keys + prefix-tree delete]] - `shares_data_with` [EXTRACTED]
- [[POST apistorageseedagent-configs - reconcile skillsrules to mode]] - `shares_data_with` [EXTRACTED]
- [[POST apistorageseedgetting-started - recreate starter docs]] - `shares_data_with` [EXTRACTED]
- [[POST apistorageupload - simple base64 upload to R2]] - `shares_data_with` [EXTRACTED]
- [[Per-tier storage quota gate on session start (SaaS only)]] - `shares_data_with` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes