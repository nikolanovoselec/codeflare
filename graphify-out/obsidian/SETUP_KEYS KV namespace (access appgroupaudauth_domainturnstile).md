---
source_file: "src/routes/setup/access.ts"
type: "code"
community: "SaaS Access Provisioning"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/SaaS_Access_Provisioning
---

# SETUP_KEYS KV namespace (access app/group/aud/auth_domain/turnstile)

## Connections
- [[handleConfigureTurnstile - widget upsert and KV secret storage]] - `shares_data_with` [EXTRACTED]
- [[handleCreateAccessApp - Step 5 provision Access appgroupspolicy]] - `shares_data_with` [EXTRACTED]
- [[storeAccessConfig - persist audgroup IDs and auth_domain in KV]] - `shares_data_with` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/SaaS_Access_Provisioning