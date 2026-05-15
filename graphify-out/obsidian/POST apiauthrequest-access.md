---
source_file: "src/routes/auth.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# POST /api/auth/request-access

## Connections
- [[apiauth Hono app — auth and subscribe routes]] - `references` [EXTRACTED]
- [[isActiveUser — legacy AccessTier bridge]] - `calls` [EXTRACTED]
- [[sendAccessRequestNotification]] - `calls` [EXTRACTED]
- [[updateUserRecord — atomic KV read-merge-write helper]] - `calls` [EXTRACTED]
- [[verifyTurnstileToken — Cloudflare Turnstile CAPTCHA verifier]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes