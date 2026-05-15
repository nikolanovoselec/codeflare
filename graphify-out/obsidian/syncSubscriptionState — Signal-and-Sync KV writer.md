---
source_file: "src/routes/stripe-webhook.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# syncSubscriptionState — Signal-and-Sync KV writer

## Connections
- [[PATCH apipreferences — auto-reconcile preseed on sessionMode change]] - `semantically_similar_to` [INFERRED]
- [[handleCheckoutCompleted]] - `calls` [EXTRACTED]
- [[handleSubscriptionUpdated]] - `calls` [EXTRACTED]
- [[parseUserRecord]] - `calls` [EXTRACTED]
- [[resolveEmailFromCustomer — KV-then-Stripe fallback]] - `calls` [EXTRACTED]
- [[updateUserRecord — atomic KV read-merge-write helper]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes