---
source_file: "src/routes/container/lifecycle.ts"
type: "code"
community: "Auth Middleware Stack"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth_Middleware_Stack
---

# POST /api/container/start route handler

## Connections
- [[AuthVariables Hono context type]] - `references` [EXTRACTED]
- [[configureContainerDO]] - `calls` [EXTRACTED]
- [[containerStartRateLimiter (5min)]] - `implements` [EXTRACTED]
- [[ensureBucketAndSeed]] - `calls` [EXTRACTED]
- [[setupR2Credentials]] - `calls` [EXTRACTED]
- [[startOrRestartContainer]] - `calls` [EXTRACTED]
- [[validateSessionAndCheckLimits]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth_Middleware_Stack