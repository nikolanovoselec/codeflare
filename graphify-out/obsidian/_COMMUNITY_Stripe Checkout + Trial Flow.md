---
type: community
cohesion: 0.07
members: 40
---

# Stripe Checkout + Trial Flow

**Cohesion:** 0.07 - loosely connected
**Members:** 40 nodes

## Members
- [[CachedPrice]] - code - src/lib/stripe.ts
- [[CheckoutSessionOptions]] - code - src/lib/stripe.ts
- [[CheckoutSessionResult]] - code - src/lib/stripe.ts
- [[StripeEvent]] - code - src/lib/stripe.ts
- [[StripeSubscriptionSnapshot]] - code - src/lib/stripe.ts
- [[body_4]] - code - src/__tests__/lib/stripe.test.ts
- [[body_10]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[buildEvent()]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[createApp()_3]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[createPortalSession()_1]] - code - src/lib/stripe.ts
- [[createSwitchPortalSession()]] - code - src/lib/stripe.ts
- [[endTrialNow()]] - code - src/lib/stripe.ts
- [[event_1]] - code - src/__tests__/lib/stripe.test.ts
- [[fetchSubscription()]] - code - src/lib/stripe.ts
- [[futureSync]] - code - src/__tests__/routes/stripe-webhook-sync.test.ts
- [[generateSignature()]] - code - src/__tests__/lib/stripe.test.ts
- [[getStripePriceId()]] - code - src/lib/stripe.ts
- [[getStripePrices()]] - code - src/lib/stripe.ts
- [[isStripeConfigured()]] - code - src/lib/stripe.ts
- [[makeSnapshot()]] - code - src/__tests__/routes/stripe-webhook-sync.test.ts
- [[makeTiers()]] - code - src/__tests__/lib/stripe.test.ts
- [[mockSubscriptionSnapshot()]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[parseStripeEvent()]] - code - src/lib/stripe.ts
- [[postWebhook()]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[prefs_2]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[price]] - code - src/__tests__/lib/stripe.test.ts
- [[priceCache]] - code - src/lib/stripe.ts
- [[raw]] - code - src/__tests__/lib/stripe.test.ts
- [[resolveTierFromPriceId()]] - code - src/lib/stripe.ts
- [[seedCustomer()]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[selectCurrency()]] - code - src/lib/stripe.ts
- [[stripe-webhook-sync.test.ts]] - code - src/__tests__/routes/stripe-webhook-sync.test.ts
- [[stripe-webhook.test.ts]] - code - src/__tests__/routes/stripe-webhook.test.ts
- [[stripe.test.ts]] - code - src/__tests__/lib/stripe.test.ts
- [[stripe.ts]] - code - src/lib/stripe.ts
- [[stripeRequest()]] - code - src/lib/stripe.ts
- [[tiers]] - code - src/__tests__/lib/stripe.test.ts
- [[user_2]] - code - src/__tests__/routes/stripe-webhook-sync.test.ts
- [[verifyWebhookSignature()]] - code - src/lib/stripe.ts
- [[{ mockReconcileAgentConfigs, mockSendAdminNotification, mockSendSubscriptionEmail }]] - code - src/__tests__/routes/stripe-webhook.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Stripe_Checkout__Trial_Flow
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_Community 135]]
- 6 edges to [[_COMMUNITY_Community 177]]
- 5 edges to [[_COMMUNITY_Community 67]]
- 4 edges to [[_COMMUNITY_CF Access AppsGroups Models]]
- 4 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 3 edges to [[_COMMUNITY_Container Env + Prefs]]
- 3 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 3 edges to [[_COMMUNITY_Auth Subscribe Routes]]
- 2 edges to [[_COMMUNITY_Admin TierSlot Counting]]

## Top bridge nodes
- [[stripe.ts]] - degree 30, connects to 8 communities
- [[stripe-webhook.test.ts]] - degree 18, connects to 4 communities
- [[stripe-webhook-sync.test.ts]] - degree 12, connects to 4 communities
- [[stripe.test.ts]] - degree 19, connects to 3 communities
- [[fetchSubscription()]] - degree 8, connects to 3 communities