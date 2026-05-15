---
source_file: "src/routes/storage/delete.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# POST /api/storage/delete - batch keys + prefix-tree delete

## Connections
- [[app_55]] - `references` [EXTRACTED]
- [[storage-stats{bucket} KV cache (60s TTL)]] - `shares_data_with` [EXTRACTED]
- [[validateKey - path traversal + protected path + URI decode guard]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes