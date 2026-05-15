---
source_file: "src/routes/storage/download.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# GET /api/storage/download - signed R2 fetch, streamed via worker

## Connections
- [[app_55]] - `references` [EXTRACTED]
- [[buildContentDisposition - CRLF-safe attachment header (RFC 5987)]] - `calls` [EXTRACTED]
- [[validateKey - path traversal + protected path + URI decode guard]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes