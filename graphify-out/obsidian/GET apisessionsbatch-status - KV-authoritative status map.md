---
source_file: "src/routes/session/lifecycle.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# GET /api/sessions/batch-status - KV-authoritative status map

## Connections
- [[List-metadata fast path eliminates N KV.get per session]] - `implements` [EXTRACTED]
- [[app_49]] - `implements` [EXTRACTED]
- [[storage-stats{bucket} KV cache (60s TTL)]] - `shares_data_with` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes