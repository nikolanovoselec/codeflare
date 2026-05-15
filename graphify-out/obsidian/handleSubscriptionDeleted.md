---
source_file: "src/routes/stripe-webhook.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# handleSubscriptionDeleted

## Connections
- [[POST publicstripewebhook]] - `calls` [EXTRACTED]
- [[resolveEmailFromCustomer — KV-then-Stripe fallback]] - `calls` [EXTRACTED]
- [[updateUserRecord — atomic KV read-merge-write helper]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes