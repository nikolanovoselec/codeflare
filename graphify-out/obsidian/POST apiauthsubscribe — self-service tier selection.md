---
source_file: "src/routes/auth.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# POST /api/auth/subscribe — self-service tier selection

## Connections
- [[apiauth Hono app — auth and subscribe routes]] - `references` [EXTRACTED]
- [[PATCH apiusersemail — change subscription tier]] - `semantically_similar_to` [INFERRED]
- [[POST billingcheckout]] - `conceptually_related_to` [INFERRED]
- [[handleCheckoutCompleted]] - `semantically_similar_to` [INFERRED]
- [[sendSubscriptionAdminNotification_1]] - `calls` [EXTRACTED]
- [[sendSubscriptionEmail]] - `calls` [EXTRACTED]
- [[updateUserRecord — atomic KV read-merge-write helper]] - `calls` [EXTRACTED]
- [[verifyTurnstileToken — Cloudflare Turnstile CAPTCHA verifier]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes