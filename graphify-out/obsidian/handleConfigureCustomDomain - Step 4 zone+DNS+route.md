---
source_file: "src/routes/setup/custom-domain.ts"
type: "code"
community: "SaaS Access Provisioning"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/SaaS_Access_Provisioning
---

# handleConfigureCustomDomain - Step 4: zone+DNS+route

## Connections
- [[POST apisetupconfigure - end-to-end setup streaming progress]] - `calls` [EXTRACTED]
- [[createWorkerRoute - bind domain pattern to worker script]] - `calls` [EXTRACTED]
- [[resolveZone - ccTLD-aware progressive zone lookup]] - `calls` [EXTRACTED]
- [[upsertDnsRecord - proxied CNAME to workers.dev target]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/SaaS_Access_Provisioning