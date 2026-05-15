---
source_file: "src/__tests__/routes/billing.test.ts"
type: "code"
community: "Auth/Container Integration Tests"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth/Container_Integration_Tests
---

# Billing routes and Stripe webhook test

## Connections
- [[CF-024 (missing webhook handler tests)]] - `cites` [EXTRACTED]
- [[REQ-SUB-020 (multi-currency pricing)]] - `cites` [EXTRACTED]
- [[REQ-SUB-021 (billingCycleAnchor  trial)]] - `cites` [EXTRACTED]
- [[liberror-types (AppError, AuthError, ValidationError, SetupError, ForbiddenError, CircuitBreakerOpenError)]] - `references` [EXTRACTED]
- [[libstripe (fetchSubscription, createCheckoutSession, createPortalSession)]] - `calls` [EXTRACTED]
- [[libsubscription (getDefaultTiers, resetTierConfigCache)]] - `calls` [EXTRACTED]
- [[middlewareauth (authMiddleware, requireAdmin)]] - `references` [EXTRACTED]
- [[routesbilling (SUT)]] - `references` [EXTRACTED]
- [[routesstripe-webhook (syncSubscriptionState)]] - `references` [EXTRACTED]
- [[tests helpersmock-kv (createMockKV)]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth/Container_Integration_Tests