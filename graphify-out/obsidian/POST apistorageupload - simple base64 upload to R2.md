---
source_file: "src/routes/storage/upload.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# POST /api/storage/upload - simple base64 upload to R2

## Connections
- [[app_51]] - `implements` [EXTRACTED]
- [[storage-stats{bucket} KV cache (60s TTL)]] - `shares_data_with` [EXTRACTED]
- [[validateKey - path traversal + protected path + URI decode guard]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes