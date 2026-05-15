---
source_file: "src/routes/stripe-webhook.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# handleCheckoutCompleted

## Connections
- [[POST apiauthsubscribe — self-service tier selection]] - `semantically_similar_to` [INFERRED]
- [[POST publicstripewebhook]] - `calls` [EXTRACTED]
- [[sendSubscriptionAdminNotification_1]] - `calls` [EXTRACTED]
- [[sendSubscriptionEmail]] - `calls` [EXTRACTED]
- [[syncSubscriptionState — Signal-and-Sync KV writer]] - `calls` [EXTRACTED]
- [[updateUserRecord — atomic KV read-merge-write helper]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes