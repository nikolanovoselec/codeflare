---
source_file: "src/routes/users.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# PATCH /api/users/:email — change subscription tier

## Connections
- [[apiusers Hono app — admin CRUD]] - `references` [EXTRACTED]
- [[POST apiauthsubscribe — self-service tier selection]] - `semantically_similar_to` [INFERRED]
- [[sendTierChangeNotification]] - `calls` [EXTRACTED]
- [[updateUserRecord — atomic KV read-merge-write helper]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes