---
source_file: "src/routes/setup/access.ts"
type: "code"
community: "SaaS Access Provisioning"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/SaaS_Access_Provisioning
---

# handleCreateAccessApp - Step 5: provision Access app/groups/policy

## Connections
- [[4-tier fallback to resolve existing managed Access app]] - `calls` [EXTRACTED]
- [[GET apisetupprefill - prefill adminuser lists from Access groups]] - `conceptually_related_to` [INFERRED]
- [[GitHub OIDC mode skips CF Access provisioning (issue 140)]] - `conceptually_related_to` [EXTRACTED]
- [[POST apisetupconfigure - end-to-end setup streaming progress]] - `calls` [EXTRACTED]
- [[SETUP_KEYS KV namespace (access appgroupaudauth_domainturnstile)]] - `shares_data_with` [EXTRACTED]
- [[SaaS-mode Access provisioning (GitHub IdP + login_method policy)]] - `implements` [INFERRED]
- [[getAccessGroupNames - worker-scoped adminuser group naming]] - `calls` [EXTRACTED]
- [[listIdentityProviders - fetch Access IdPs for SaaS GitHub-only mode]] - `calls` [EXTRACTED]
- [[pruneLegacyAccessApps - delete stale legacy-domain Access apps]] - `calls` [EXTRACTED]
- [[storeAccessConfig - persist audgroup IDs and auth_domain in KV]] - `calls` [EXTRACTED]
- [[upsertAccessApp - createupdate Cloudflare Access application]] - `calls` [EXTRACTED]
- [[upsertAccessGroup - createupdate Access group with email members]] - `calls` [EXTRACTED]
- [[upsertAccessPolicy - SaaS login_method or group-based include]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/SaaS_Access_Provisioning