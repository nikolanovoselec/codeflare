---
type: community
cohesion: 0.13
members: 22
---

# Community 82

**Cohesion:** 0.13 - loosely connected
**Members:** 22 nodes

## Members
- [[REQ-SETUP-009 Subscribe page with tier selection]] - document - sdd/setup.md
- [[REQ-SUB-001 Eight-Tier Subscription System]] - document - sdd/subscription.md
- [[REQ-SUB-002 Tier Property Definitions]] - document - sdd/subscription.md
- [[REQ-SUB-003 Free Tier Requires No Payment]] - document - sdd/subscription.md
- [[REQ-SUB-004 Paid Tiers Integrate with Stripe Checkout]] - document - sdd/subscription.md
- [[REQ-SUB-005 Trial Is Compute-Based, Not Time-Based]] - document - sdd/subscription.md
- [[REQ-SUB-006 Real-Time Usage Tracking via Timekeeper DO]] - document - sdd/subscription.md
- [[REQ-SUB-007 Quota Enforcement at Session Start (402)]] - document - sdd/subscription.md
- [[REQ-SUB-008 Mid-Session Quota Enforcement (Graceful Stop)]] - document - sdd/subscription.md
- [[REQ-SUB-009 Admin-Configurable Tiers]] - document - sdd/subscription.md
- [[REQ-SUB-010 Tier Config Cached with 60s TTL]] - document - sdd/subscription.md
- [[REQ-SUB-011 Graceful Degradation Without Stripe]] - document - sdd/subscription.md
- [[REQ-SUB-012 Billing Status Enforcement (Effective Tier)]] - document - sdd/subscription.md
- [[REQ-SUB-013 Concurrent Session Limits]] - document - sdd/subscription.md
- [[REQ-SUB-015 Stripe Webhook Signal-and-Sync]] - document - sdd/subscription.md
- [[REQ-SUB-016 Customer Portal and Plan Switching]] - document - sdd/subscription.md
- [[REQ-SUB-017 Enterprise tier contact flow]] - document - sdd/subscription.md
- [[REQ-SUB-018 Usage dashboard page]] - document - sdd/subscription.md
- [[REQ-SUB-019 Session limit popup]] - document - sdd/subscription.md
- [[REQ-SUB-020 Multi-Currency Pricing]] - document - sdd/subscription.md
- [[REQ-SUB-021 Billing Cycle Alignment (1st of UTC month)]] - document - sdd/subscription.md
- [[Subscription Tiers (default config)]] - document - sdd/constraints.md

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_82
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Community 106]]
- 1 edge to [[_COMMUNITY_Community 94]]
- 1 edge to [[_COMMUNITY_Community 225]]

## Top bridge nodes
- [[REQ-SUB-001 Eight-Tier Subscription System]] - degree 12, connects to 3 communities