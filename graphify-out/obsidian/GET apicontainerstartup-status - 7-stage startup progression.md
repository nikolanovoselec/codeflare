---
source_file: "src/routes/container/status.ts"
type: "code"
community: "Container Health Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Container_Health_Routes
---

# GET /api/container/startup-status - 7-stage startup progression

## Connections
- [[GET apicontainerhealth - container DO health probe]] - `semantically_similar_to` [INFERRED]
- [[Startup-stage state machine (stopped-starting-syncing-mounting-ready)]] - `implements` [EXTRACTED]
- [[app_59]] - `references` [EXTRACTED]
- [[fetchWithTimeout - race container DO fetch against timeout]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Container_Health_Routes