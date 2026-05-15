---
type: community
cohesion: 0.08
members: 33
---

# Admin Tier/Slot Counting

**Cohesion:** 0.08 - loosely connected
**Members:** 33 nodes

## Members
- [[ACTIVE_TIERS]] - code - src/lib/subscription.ts
- [[PAID_TIERS]] - code - src/lib/subscription.ts
- [[SLOT_TIERS]] - code - src/lib/subscription.ts
- [[SubscriptionTierConfig]] - code - src/types.ts
- [[UsageRecordSchema]] - code - src/types.ts
- [[UserManagement()]] - code - web-ui/src/components/admin/UserManagement.tsx
- [[bad]] - code - src/__tests__/lib/subscription.test.ts
- [[config_1]] - code - src/__tests__/lib/subscription.test.ts
- [[countPaidSlots()]] - code - src/lib/subscription.ts
- [[createApp()_10]] - code - src/__tests__/routes/billing.test.ts
- [[custom_1]] - code - src/__tests__/lib/subscription.test.ts
- [[defaults]] - code - src/__tests__/lib/subscription.test.ts
- [[expired]] - code - src/__tests__/lib/subscription.test.ts
- [[found]] - code - src/__tests__/lib/subscription.test.ts
- [[future]] - code - src/__tests__/lib/subscription.test.ts
- [[getAllowedSessionModes()]] - code - src/lib/subscription.ts
- [[getDefaultTiers()]] - code - src/lib/subscription.ts
- [[getMaxSessionsForTier()]] - code - src/lib/subscription.ts
- [[getTierConfig()]] - code - src/lib/subscription.ts
- [[getUserTier()]] - code - src/lib/subscription.ts
- [[ids_2]] - code - src/__tests__/lib/subscription.test.ts
- [[past_1]] - code - src/__tests__/lib/subscription.test.ts
- [[resetTierConfigCache()]] - code - src/lib/subscription.ts
- [[result_24]] - code - src/__tests__/lib/subscription.test.ts
- [[subscribable]] - code - src/__tests__/lib/subscription.test.ts
- [[subscription.test.ts]] - code - src/__tests__/lib/subscription.test.ts
- [[subscription.ts]] - code - src/lib/subscription.ts
- [[tier]] - code - src/__tests__/lib/subscription.test.ts
- [[tiers_1]] - code - src/__tests__/lib/subscription.test.ts
- [[users]] - code - src/__tests__/lib/subscription.test.ts
- [[validRecord]] - code - src/__tests__/lib/subscription.test.ts
- [[validTiers]] - code - src/__tests__/lib/subscription.test.ts
- [[zero]] - code - src/__tests__/lib/subscription.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Admin_Tier/Slot_Counting
SORT file.name ASC
```

## Connections to other communities
- 13 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 9 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 7 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 6 edges to [[_COMMUNITY_Container Lifecycle + Rate Limiting]]
- 5 edges to [[_COMMUNITY_Community 135]]
- 4 edges to [[_COMMUNITY_Community 77]]
- 4 edges to [[_COMMUNITY_Community 177]]
- 4 edges to [[_COMMUNITY_Tier Config + Validation Schemas]]
- 3 edges to [[_COMMUNITY_Community 152]]
- 3 edges to [[_COMMUNITY_Auth Subscribe Routes]]
- 3 edges to [[_COMMUNITY_Community 67]]
- 3 edges to [[_COMMUNITY_Session API Serialization]]
- 3 edges to [[_COMMUNITY_R2 XML Parsing]]
- 2 edges to [[_COMMUNITY_Stripe Checkout + Trial Flow]]
- 1 edge to [[_COMMUNITY_User Management + Tier Resolution]]
- 1 edge to [[_COMMUNITY_Community 78]]
- 1 edge to [[_COMMUNITY_OAuth Nonce + HMAC]]
- 1 edge to [[_COMMUNITY_Error Types + Fetch Utilities]]

## Top bridge nodes
- [[subscription.ts]] - degree 40, connects to 16 communities
- [[getTierConfig()]] - degree 18, connects to 10 communities
- [[getUserTier()]] - degree 13, connects to 6 communities
- [[subscription.test.ts]] - degree 34, connects to 3 communities
- [[getDefaultTiers()]] - degree 7, connects to 2 communities