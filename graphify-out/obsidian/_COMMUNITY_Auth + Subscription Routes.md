---
type: community
cohesion: 0.05
members: 61
---

# Auth + Subscription Routes

**Cohesion:** 0.05 - loosely connected
**Members:** 61 nodes

## Members
- [[apiauth Hono app — auth and subscribe routes]] - code - src/routes/auth.ts
- [[apipreferences Hono app]] - code - src/routes/preferences.ts
- [[apiuser Hono app — current user identity]] - code - src/routes/user-profile.ts
- [[apiusers Hono app — admin CRUD]] - code - src/routes/users.ts
- [[authgithub Hono app — GitHub OAuth (SaaS mode)]] - code - src/routes/github-auth.ts
- [[billing Hono app — Stripe checkoutportalswitch]] - code - src/routes/billing.ts
- [[public Hono app — onboarding landing endpoints]] - code - src/routes/public/index.ts
- [[publicstripe Hono app — Stripe webhook handler]] - code - src/routes/stripe-webhook.ts
- [[Auth redirects app — loginlogout dispatcher (CF Access vs GitHub OIDC)]] - code - src/routes/auth-redirects.ts
- [[DELETE apiusersemail]] - code - src/routes/users.ts
- [[GET apiauthstatus]] - code - src/routes/auth.ts
- [[GET apiauthtiers]] - code - src/routes/auth.ts
- [[GET apiuser]] - code - src/routes/user-profile.ts
- [[GET apiusers (admin list)]] - code - src/routes/users.ts
- [[GET authgithubcallback — code exchange + JWT issuance]] - code - src/routes/github-auth.ts
- [[GET authgithublogin]] - code - src/routes/github-auth.ts
- [[GET authgithublogout]] - code - src/routes/github-auth.ts
- [[GET billingstatus]] - code - src/routes/billing.ts
- [[GET publictiers]] - code - src/routes/public/index.ts
- [[PATCH apipreferences — auto-reconcile preseed on sessionMode change]] - code - src/routes/preferences.ts
- [[PATCH apiusersemail — change subscription tier]] - code - src/routes/users.ts
- [[POST apiauthcontact-team]] - code - src/routes/auth.ts
- [[POST apiauthrequest-access]] - code - src/routes/auth.ts
- [[POST apiauthsubscribe — self-service tier selection]] - code - src/routes/auth.ts
- [[POST apiuserensure-r2-token]] - code - src/routes/user-profile.ts
- [[POST apiuseronboarding-complete]] - code - src/routes/user-profile.ts
- [[POST billingcheckout]] - code - src/routes/billing.ts
- [[POST billingportal]] - code - src/routes/billing.ts
- [[POST billingswitch]] - code - src/routes/billing.ts
- [[POST publicstripewebhook]] - code - src/routes/stripe-webhook.ts
- [[POST publicwaitlist]] - code - src/routes/public/index.ts
- [[SaaS mode access-tier gating]] - code - src/__tests__/routes/terminal-ws.test.ts
- [[UserRecordSchema — KV user record Zod schema]] - code - src/lib/user-record.ts
- [[Users Routes test suite]] - code - src/__tests__/routes/users.test.ts
- [[admin-only access control (requireAdmin)]] - code - src/__tests__/routes/users.test.ts
- [[buildPlanChangeRows]] - code - src/lib/email.ts
- [[buildSubscriptionDetailRows]] - code - src/lib/email.ts
- [[getModeLabel]] - code - src/lib/email.ts
- [[handleCheckoutCompleted]] - code - src/routes/stripe-webhook.ts
- [[handleSubscriptionDeleted]] - code - src/routes/stripe-webhook.ts
- [[handleSubscriptionUpdated]] - code - src/routes/stripe-webhook.ts
- [[handleWebSocketUpgrade (tested)]] - code - src/__tests__/routes/terminal-ws.test.ts
- [[handleWebSocketUpgrade test suite]] - code - src/__tests__/routes/terminal-ws.test.ts
- [[handleWebSocketUpgrade — auth, rate-limit, container forwarding]] - code - src/routes/terminal.ts
- [[isActiveUser — legacy AccessTier bridge]] - code - src/lib/access-tier.ts
- [[parseUserRecord]] - code - src/lib/user-record.ts
- [[resolveEmailFromCustomer — KV-then-Stripe fallback]] - code - src/routes/stripe-webhook.ts
- [[sendAccessRequestNotification]] - code - src/lib/email.ts
- [[sendEmail — Resend API email transport]] - code - src/lib/email.ts
- [[sendSubscriptionAdminNotification_1]] - code - src/lib/email.ts
- [[sendSubscriptionEmail]] - code - src/lib/email.ts
- [[sendTierChangeNotification]] - code - src/lib/email.ts
- [[sendWaitlistEmail]] - code - src/routes/public/index.ts
- [[sendWelcomeEmail]] - code - src/lib/email.ts
- [[syncSubscriptionState — Signal-and-Sync KV writer]] - code - src/routes/stripe-webhook.ts
- [[trySyncAccessPolicy helper]] - code - src/routes/users.ts
- [[updateUserRecord — atomic KV read-merge-write helper]] - code - src/lib/user-record.ts
- [[users routes module]] - code - src/__tests__/routes/users.test.ts
- [[validateWebSocketRoute (tested)]] - code - src/__tests__/routes/terminal.test.ts
- [[validateWebSocketRoute test suite]] - code - src/__tests__/routes/terminal.test.ts
- [[verifyTurnstileToken — Cloudflare Turnstile CAPTCHA verifier]] - code - src/lib/turnstile.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Auth__Subscription_Routes
SORT file.name ASC
```
