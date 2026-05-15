---
source_file: "src/lib/user-record.ts"
type: "code"
community: "Auth + Subscription Routes"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Auth__Subscription_Routes
---

# updateUserRecord — atomic KV read-merge-write helper

## Connections
- [[GET billingstatus]] - `calls` [EXTRACTED]
- [[PATCH apiusersemail — change subscription tier]] - `calls` [EXTRACTED]
- [[POST apiauthrequest-access]] - `calls` [EXTRACTED]
- [[POST apiauthsubscribe — self-service tier selection]] - `calls` [EXTRACTED]
- [[POST billingcheckout]] - `calls` [EXTRACTED]
- [[POST billingswitch]] - `calls` [EXTRACTED]
- [[handleCheckoutCompleted]] - `calls` [EXTRACTED]
- [[handleSubscriptionDeleted]] - `calls` [EXTRACTED]
- [[parseUserRecord]] - `calls` [EXTRACTED]
- [[syncSubscriptionState — Signal-and-Sync KV writer]] - `calls` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Auth__Subscription_Routes