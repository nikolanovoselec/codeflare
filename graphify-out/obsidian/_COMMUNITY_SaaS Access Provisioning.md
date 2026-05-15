---
type: community
cohesion: 0.08
members: 30
---

# SaaS Access Provisioning

**Cohesion:** 0.08 - loosely connected
**Members:** 30 nodes

## Members
- [[4-tier fallback to resolve existing managed Access app]] - code - src/routes/setup/access.ts
- [[60s KV lock setupconfiguring preventing concurrent runs]] - code - src/routes/setup/index.ts
- [[GET apisetupdetect-token - verify CLOUDFLARE_API_TOKEN and account]] - code - src/routes/setup/handlers.ts
- [[GET apisetupprefill - prefill adminuser lists from Access groups]] - code - src/routes/setup/handlers.ts
- [[GET apisetupstatus - public configuredsaasMode probe]] - code - src/routes/setup/handlers.ts
- [[GitHub OIDC mode skips CF Access provisioning (issue 140)]] - code - src/routes/setup/index.ts
- [[POST apisetupconfigure - end-to-end setup streaming progress]] - code - src/routes/setup/index.ts
- [[SETUP_KEYS KV namespace (access appgroupaudauth_domainturnstile)]] - code - src/routes/setup/access.ts
- [[SaaS-mode Access provisioning (GitHub IdP + login_method policy)]] - code - src/routes/setup/access.ts
- [[Setup helper-handlers Hono app (statusdetect-tokenprefill)]] - code - src/routes/setup/handlers.ts
- [[Stale-user cleanup pass (SaaS preserves JIT-provisioned users)]] - code - src/routes/setup/index.ts
- [[app_46]] - code - src/routes/setup/index.ts
- [[createConditionalSetupAuth - bootstrap-then-admin gate for setup routes]] - code - src/routes/setup/index.ts
- [[createWorkerRoute - bind domain pattern to worker script]] - code - src/routes/setup/custom-domain.ts
- [[findExistingWidget - namedomain match fallback]] - code - src/routes/setup/turnstile.ts
- [[getAccessGroupNames - worker-scoped adminuser group naming]] - code - src/routes/setup/access.ts
- [[handleConfigureCustomDomain - Step 4 zone+DNS+route]] - code - src/routes/setup/custom-domain.ts
- [[handleConfigureTurnstile - widget upsert and KV secret storage]] - code - src/routes/setup/turnstile.ts
- [[handleCreateAccessApp - Step 5 provision Access appgroupspolicy]] - code - src/routes/setup/access.ts
- [[handleGetAccount - Step 1 fetch Cloudflare account ID]] - code - src/routes/setup/account.ts
- [[listIdentityProviders - fetch Access IdPs for SaaS GitHub-only mode]] - code - src/routes/setup/access.ts
- [[pruneLegacyAccessApps - delete stale legacy-domain Access apps]] - code - src/routes/setup/access.ts
- [[resolveAccountSubdomain - workers.dev subdomain (API + hostname fallback)]] - code - src/routes/setup/custom-domain.ts
- [[resolveZone - ccTLD-aware progressive zone lookup]] - code - src/routes/setup/custom-domain.ts
- [[rotateWidgetSecret - rotate Turnstile widget secret when not returned]] - code - src/routes/setup/turnstile.ts
- [[storeAccessConfig - persist audgroup IDs and auth_domain in KV]] - code - src/routes/setup/access.ts
- [[upsertAccessApp - createupdate Cloudflare Access application]] - code - src/routes/setup/access.ts
- [[upsertAccessGroup - createupdate Access group with email members]] - code - src/routes/setup/access.ts
- [[upsertAccessPolicy - SaaS login_method or group-based include]] - code - src/routes/setup/access.ts
- [[upsertDnsRecord - proxied CNAME to workers.dev target]] - code - src/routes/setup/custom-domain.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/SaaS_Access_Provisioning
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Setup + Origins Configuration]]

## Top bridge nodes
- [[app_46]] - degree 3, connects to 1 community