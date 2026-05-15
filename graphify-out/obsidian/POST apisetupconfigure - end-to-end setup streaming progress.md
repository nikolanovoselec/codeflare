---
source_file: "src/routes/setup/index.ts"
type: "code"
community: "SaaS Access Provisioning"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/SaaS_Access_Provisioning
---

# POST /api/setup/configure - end-to-end setup streaming progress

## Connections
- [[60s KV lock setupconfiguring preventing concurrent runs]] - `implements` [EXTRACTED]
- [[GitHub OIDC mode skips CF Access provisioning (issue 140)]] - `implements` [EXTRACTED]
- [[Stale-user cleanup pass (SaaS preserves JIT-provisioned users)]] - `implements` [EXTRACTED]
- [[handleConfigureCustomDomain - Step 4 zone+DNS+route]] - `calls` [EXTRACTED]
- [[handleConfigureTurnstile - widget upsert and KV secret storage]] - `calls` [EXTRACTED]
- [[handleCreateAccessApp - Step 5 provision Access appgroupspolicy]] - `calls` [EXTRACTED]
- [[handleGetAccount - Step 1 fetch Cloudflare account ID]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/SaaS_Access_Provisioning