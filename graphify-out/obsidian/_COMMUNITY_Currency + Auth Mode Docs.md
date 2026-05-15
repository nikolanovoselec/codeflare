---
type: community
cohesion: 0.07
members: 35
---

# Currency + Auth Mode Docs

**Cohesion:** 0.07 - loosely connected
**Members:** 35 nodes

## Members
- [[Auth Mode Cloudflare Access (RS256 JWT)]] - document - documentation/authentication.md
- [[Auth Mode Direct GitHub OAuth (HMAC JWT)]] - document - documentation/authentication.md
- [[CF-013 usage-quota display concept]] - document - web-ui/src/stores/session-usage.ts
- [[Conflict Resolution (newer wins)]] - document - documentation/storage-and-sync.md
- [[Country - currency rules (CHLI=CHF, GB family=GBP, Europe=EUR, default=USD)]] - code - src/__tests__/lib/currency.test.ts
- [[Dismissed quota warning per UTC month (REQ-SUB-018)]] - code - web-ui/src/stores/session-usage.ts
- [[Documentation Authentication & Billing]] - document - documentation/authentication.md
- [[Documentation Billing & Subscriptions]] - document - documentation/billing.md
- [[Documentation Storage & Sync]] - document - documentation/storage-and-sync.md
- [[E2E Service Auth (X-Service-Auth)]] - document - documentation/authentication.md
- [[Paygate Enforcement (validateSessionAndCheckLimits)]] - document - documentation/billing.md
- [[Per-User Bucket Naming]] - document - documentation/authentication.md
- [[Per-user R2 Storage Quota (maxStorageBytes)]] - document - documentation/storage-and-sync.md
- [[REQ-SUB-015]] - document - documentation/billing.md
- [[REQ-SUB-018 (dismissed quota warning)]] - document - web-ui/src/stores/session-usage.ts
- [[REQ-SUB-020 multi-currency pricing]] - document - src/__tests__/lib/stripe.test.ts
- [[SUPPORTED_CURRENCIES = chf, usd, eur, gbp]] - code - src/__tests__/lib/currency.test.ts
- [[SaaS Mode (SAAS_MODE=active)]] - document - documentation/authentication.md
- [[Session Transcript Cleanup (keeps 5 most recent)]] - document - documentation/storage-and-sync.md
- [[Session presetsbookmarks store module]] - code - web-ui/src/stores/session-presets.ts
- [[Session usage quota store (CF-013)]] - code - web-ui/src/stores/session-usage.ts
- [[Stripe Payment Integration (Signal and Sync)]] - document - documentation/billing.md
- [[Subscription Tiers (8-tier system)]] - document - documentation/billing.md
- [[Sync Modes (nonefullmetadata)]] - document - documentation/storage-and-sync.md
- [[Timekeeper DO (Usage Tracking)]] - document - documentation/billing.md
- [[Vanishing-file Recovery Filter]] - document - documentation/storage-and-sync.md
- [[cf_usage localStorage bootstrap cache]] - code - web-ui/src/stores/session-usage.ts
- [[getCurrencyForCountry tests]] - code - src/__tests__/lib/currency.test.ts
- [[getStripePrices currency_options expand (REQ-SUB-020)]] - code - src/__tests__/lib/stripe.test.ts
- [[getUsageWarningLevel 8095100 tiers]] - code - web-ui/src/stores/session-usage.ts
- [[getUserFromRequest() Resolution Order]] - document - documentation/authentication.md
- [[nuke_corrupted_r2_files Self-Healing]] - document - documentation/storage-and-sync.md
- [[rclone bisync (60s daemon)]] - document - documentation/storage-and-sync.md
- [[saveBookmarkForSession]] - code - web-ui/src/stores/session-presets.ts
- [[syncSubscriptionState()_1]] - document - documentation/billing.md

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Currency__Auth_Mode_Docs
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Community 147]]

## Top bridge nodes
- [[getStripePrices currency_options expand (REQ-SUB-020)]] - degree 4, connects to 1 community