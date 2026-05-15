---
source_file: "src/routes/setup/turnstile.ts"
type: "code"
community: "SaaS Access Provisioning"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/SaaS_Access_Provisioning
---

# handleConfigureTurnstile - widget upsert and KV secret storage

## Connections
- [[POST apisetupconfigure - end-to-end setup streaming progress]] - `calls` [EXTRACTED]
- [[SETUP_KEYS KV namespace (access appgroupaudauth_domainturnstile)]] - `shares_data_with` [EXTRACTED]
- [[findExistingWidget - namedomain match fallback]] - `calls` [EXTRACTED]
- [[rotateWidgetSecret - rotate Turnstile widget secret when not returned]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/SaaS_Access_Provisioning