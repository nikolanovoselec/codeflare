---
type: community
cohesion: 0.06
members: 56
---

# Auth/Container Integration Tests

**Cohesion:** 0.06 - loosely connected
**Members:** 56 nodes

## Members
- [[Auth Middleware test]] - code - src/__tests__/middleware/auth.test.ts
- [[Auth redirect routes test]] - code - src/__tests__/routes/auth-redirects.test.ts
- [[Billing routes and Stripe webhook test]] - code - src/__tests__/routes/billing.test.ts
- [[CF-024 (missing webhook handler tests)]] - document - sdd/
- [[Container Lifecycle scoped R2 tokens test]] - code - src/__tests__/routes/container/lifecycle.test.ts
- [[Container lifecycle extracted helpers test]] - code - src/__tests__/routes/container-lifecycle-helpers.test.ts
- [[LLM Keys routes test]] - code - src/__tests__/routes/llm-keys.test.ts
- [[POST authsubscribe test]] - code - src/__tests__/routes/auth-subscribe.test.ts
- [[REQ-SUB-020 (multi-currency pricing)]] - document - sdd/
- [[REQ-SUB-021 (billingCycleAnchor  trial)]] - document - sdd/
- [[Session CRUD and Lifecycle test]] - code - src/__tests__/routes/session.test.ts
- [[Setup Access test]] - code - src/__tests__/routes/setup/access.test.ts
- [[Setup Account test]] - code - src/__tests__/routes/setup/account.test.ts
- [[Setup Custom Domain test]] - code - src/__tests__/routes/setup/custom-domain.test.ts
- [[Setup Handlers test]] - code - src/__tests__/routes/setup/handlers.test.ts
- [[Setup Turnstile test]] - code - src/__tests__/routes/setup/turnstile.test.ts
- [[Setup shared helpers test]] - code - src/__tests__/routes/setup-shared.test.ts
- [[Storage Delete Route test]] - code - src/__tests__/routes/storage-delete.test.ts
- [[Storage Preview Routes test]] - code - src/__tests__/routes/storage-preview.test.ts
- [[Storage Seed Routes test]] - code - src/__tests__/routes/storage-seed.test.ts
- [[Storage Stats Routes test]] - code - src/__tests__/routes/storage-stats.test.ts
- [[Storage Upload Routes test]] - code - src/__tests__/routes/storage-upload.test.ts
- [[User Profile Routes test]] - code - src/__tests__/routes/user-profile.test.ts
- [[libaccess (authenticateRequest, resetAuthConfigCache)]] - code - src/lib/access.ts
- [[libconstants (MAX_SESSION_NAME_LENGTH)]] - code - src/lib/constants.ts
- [[liberror-types (AppError, AuthError, ValidationError, SetupError, ForbiddenError, CircuitBreakerOpenError)]] - code - src/lib/error-types.ts
- [[libr2-admin (createBucketIfNotExists)]] - code - src/lib/r2-admin.ts
- [[libr2-seed (seedGettingStartedDocs, reconcileAgentConfigs)]] - code - src/lib/r2-seed.ts
- [[libstripe (fetchSubscription, createCheckoutSession, createPortalSession)]] - code - src/lib/stripe.ts
- [[libsubscription (getDefaultTiers, resetTierConfigCache)]] - code - src/lib/subscription.ts
- [[middlewareauth (authMiddleware, requireAdmin)]] - code - src/middleware/auth.ts
- [[routesauth (subscribe handler)]] - code - src/routes/auth.ts
- [[routesauth-redirects (SUT)]] - code - src/routes/auth-redirects.ts
- [[routesbilling (SUT)]] - code - src/routes/billing.ts
- [[routescontainerlifecycle (SUT)]] - code - src/routes/container/lifecycle.ts
- [[routesllm-keys (SUT)]] - code - src/routes/llm-keys.ts
- [[routessessioncrud (SUT)]] - code - src/routes/session/crud.ts
- [[routessessionlifecycle (SUT)]] - code - src/routes/session/lifecycle.ts
- [[routessetupaccess (handleCreateAccessApp, getAccessGroupNames)]] - code - src/routes/setup/access.ts
- [[routessetupaccount (handleGetAccount)]] - code - src/routes/setup/account.ts
- [[routessetupcustom-domain (handleConfigureCustomDomain)]] - code - src/routes/setup/custom-domain.ts
- [[routessetuphandlers (SUT)]] - code - src/routes/setup/handlers.ts
- [[routessetupshared (getWorkerNameFromHostname, detectCloudflareAuthError, withSetupRetry)]] - code - src/routes/setup/shared.ts
- [[routessetupturnstile (handleConfigureTurnstile)]] - code - src/routes/setup/turnstile.ts
- [[routesstoragepreview (SUT)]] - code - src/routes/storage/preview.ts
- [[routesstorageseed (SUT)]] - code - src/routes/storage/seed.ts
- [[routesstoragestats (SUT)]] - code - src/routes/storage/stats.ts
- [[routesstorageupload (SUT)]] - code - src/routes/storage/upload.ts
- [[routesstoragevalidation (validateKey)]] - code - src/routes/storage/validation.ts
- [[routesstripe-webhook (syncSubscriptionState)]] - code - src/routes/stripe-webhook.ts
- [[routesuser-profile (SUT)]] - code - src/routes/user-profile.ts
- [[syncSubscriptionState test]] - code - src/__tests__/routes/stripe-webhook-sync.test.ts
- [[tests helpersmock-factories (createMockR2Config)]] - code - src/__tests__/helpers/mock-factories.ts
- [[tests helpersmock-kv (createMockKV)]] - code - src/__tests__/helpers/mock-kv.ts
- [[tests helperstest-app (createTestApp)]] - code - src/__tests__/helpers/test-app.ts
- [[validateKey unit test]] - code - src/__tests__/routes/storage-validation.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Auth/Container_Integration_Tests
SORT file.name ASC
```
