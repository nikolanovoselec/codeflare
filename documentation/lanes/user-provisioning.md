# User Provisioning

JIT user provisioning, subscription UX flows, session mode authorization, and frontend auth components for Codeflare SaaS mode.

**Audience:** Operators, Developers

See [Authentication](authentication.md) for auth flows. See [Billing](billing.md) for subscription tiers and Stripe integration.

---

## Contents

- [JIT User Provisioning](#jit-user-provisioning)
- [Enterprise Mode Provisioning](#enterprise-mode-provisioning)
- [Self-Service Subscription Flow](#self-service-subscription-flow)
- [Session Mode Authorization](#session-mode-authorization)
- [CF Access Configuration Strategy](#cf-access-configuration-strategy)
- [Frontend Components](#frontend-components)
- [Legacy Compatibility](#legacy-compatibility)

## JIT User Provisioning

When a GitHub-authenticated user makes their first request to a protected endpoint:

1. `authenticateRequest()` in `src/lib/access.ts` extracts the user's email from the JWT
2. `resolveUserFromKV()` looks up `user:{email}` - not found (first login)
3. If `SAAS_MODE=active`, `resolveOrProvisionUser()` creates a new KV record with `subscriptionTier: 'pending'`
4. The user is returned with pending tier; `requireActiveUser` rejects with 403, frontend redirects to `/app/subscribe`

**Concurrency note:** Simultaneous first-logins produce identical records (KV per-key serialization prevents split-brain).

**User data cleanup:** `cleanupUserData()` normalizes email before constructing KV keys and performs full cleanup: destroys active sessions, deletes bucket-keyed KV entries, deletes R2 scoped token, empties and deletes R2 bucket.

---

## Enterprise Mode Provisioning

When `ENTERPRISE_MODE=active`, users are owned by the customer's Cloudflare Access, not by Codeflare. A dedicated branch in `authenticateRequest()` (`src/lib/access.ts`) runs **before** the SaaS path and provisions any Access-authenticated user just-in-time:

1. `resolveOrProvisionEnterpriseUser()` looks up `user:{email}`. An existing record (admin, or a prior JIT user) is returned **unchanged** — enterprise provisioning never downgrades.
2. For an unknown email, if the optional access-group gate is configured (see below) it is checked; on pass, a new KV record is written with `addedBy: 'enterprise-jit'`, `role: 'user'`, `accessTier: 'advanced'`, `subscriptionTier: 'unlimited'`. **No welcome/subscription email is sent** (unlike the SaaS path).
3. The user lands working on `/app/` immediately — there is no pending tier, subscribe page, or onboarding/waitlist flow ([REQ-ENTERPRISE-008](../../sdd/spec/enterprise-mode.md#req-enterprise-008-enterprise-frontend-surface-suppression) AC5).

**Enterprise frontend surface suppression ([REQ-ENTERPRISE-008](../../sdd/spec/enterprise-mode.md#req-enterprise-008-enterprise-frontend-surface-suppression)):** When `ENTERPRISE_MODE=active`, the following surfaces are globally suppressed for all users regardless of role: Subscribe button, billing management page, setup-wizard access for non-admin users, and any onboarding/waitlist flow. The app header renders an enterprise-mode variant. These suppressions apply in the frontend unconditionally — there is no role or tier combination that re-enables them in enterprise mode.

**Optional access-group gate (`ENTERPRISE_ACCESS_GROUP`):** an operator-managed value stored in KV (`setup:enterprise_access_group`), set via the setup wizard — editable without a redeploy. When set (a comma/newline-separated list of group names/ids), `resolveUserAccessGroup()` calls the Cloudflare Access **get-identity** endpoint (`GET https://{auth_domain}/cdn-cgi/access/get-identity` with the request's `CF_Authorization` cookie) and admits a user who is a member of **any** configured group — the single matched group is what gets forwarded to the gateway as `cf-aig-metadata.group`; a user in none gets a 403. The check **fails closed** — a missing token, non-OK response, or fetch error denies provisioning rather than admitting on incomplete information. When unset, any user the Access policy admits is provisioned on their valid Access JWT alone. The application JWT does not carry group membership by default, which is why the gate uses get-identity rather than reading a JWT claim. Each group name/id is matched **case-sensitively** against the configured value exactly as it appears in the Cloudflare dashboard — a mismatch denies every user. See [Configuration — Enterprise Mode Runtime Configuration](configuration.md#enterprise-mode-runtime-configuration) for the KV key details.

**Admin access groups widen the entry gate (`ENTERPRISE_ADMIN_ACCESS_GROUP`):** members of a configured admin Access group ([REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups)) are granted admin access, and so they must also be admitted by the entry gate. When the user-access gate is active, membership is tested against the **union** of user-access + admin groups, so an admin who belongs to no *user* group is not locked out. Admin groups never arm the entry gate by themselves — with no user-access groups configured, entry stays open exactly as before. Provisioning still creates the user as a normal `unlimited` user (role `user`); admin elevation happens per-request in `requireAdmin`, not at provisioning, so it leaves no `role:'admin'` record. See [Authentication — Admin authorization](authentication.md#admin-authorization-admin-by-email-and-admin-by-group) and [Configuration — Admin Access Group Configuration](configuration.md#admin-access-group-configuration).

**Defense in depth:** the SaaS/admin routes that would let an enterprise user self-manage are also hardened server-side — billing, user-management, tier-config, subscribe, request-access, and the Stripe webhook all fail closed (403 / no-op) in enterprise mode ([REQ-ENTERPRISE-009](../../sdd/spec/enterprise-mode.md#req-enterprise-009-enterprise-backend-route-hardening)).

**Non-enterprise unchanged:** the entire branch is gated on `isEnterpriseMode(env)`; with the flag unset an unknown user follows the existing SaaS or non-SaaS-allowlist path exactly as before.

**Subscribe route and billing UI suppression:** When `ENTERPRISE_MODE=active`, the subscribe page (`/subscribe`) and all billing-management routes return 403. The billing UI and "Subscribe" button are suppressed globally in the frontend regardless of the user's role. There is no path to reach a subscribe or payment flow in enterprise mode ([REQ-ENTERPRISE-002](../../sdd/spec/enterprise-mode.md#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded)).

---

## Self-Service Subscription Flow

When a pending user lands on `/app/subscribe`:

1. **Tier selection:** Frontend fetches `/api/auth/tiers` to display 5 subscribable tiers (free, standard, advanced, max, unlimited)
2. **Turnstile CAPTCHA:** User selects a tier; Turnstile CAPTCHA widget renders
3. **Subscription request:** `POST /api/auth/subscribe` with `{ tier, turnstileToken, mode? }`
4. **Backend validation:** Verifies Turnstile, validates tier, writes to KV: `subscriptionTier`, `accessTier`, `subscribedAt`, `subscribedMode`, `trialUsed: false`
5. **Redirect:** Frontend redirects to `/app/onboarding` (first-time) or `/app/` (returning user)

For paid tiers when `STRIPE_SECRET_KEY` is set, `POST /api/auth/subscribe` rejects with "Paid subscriptions require checkout." Only `free` tier goes through the direct endpoint.

**First-time onboarding redirect:** After subscription, `AppContent.onMount` checks `onboardingComplete` from `/api/user`. If `false`, redirects to `/app/onboarding`. The onboarding page sets `onboardingComplete: true` via `POST /api/user/onboarding-complete`.

---

## Session Mode Authorization

Session mode access requires both tier support AND an active Pro mode subscription.

**Two distinct mode fields:**
- `subscribedMode` (KV record `user:{email}`) - what mode the user paid for. Set by `POST /api/auth/subscribe`. Read by SettingsPanel Pro gate and subscribe page.
- `sessionMode` (preferences KV `user-prefs:{bucket}`) - what mode the next session uses. Changed by Settings toggle. Does not affect the Pro gate.

Users can freely toggle Standard/Pro in Settings within what they subscribed to. To change subscription mode, users go through the subscribe page.

**Backend authorization (`canUseSessionMode()`):** Admin users always have advanced access. `getAllowedSessionModes()` reads from tier config - by default, `standard` allows `['default', 'advanced']`.

**Session Mode Upgrade (Auto-Advanced):** When an admin changes a user's tier to `advanced`, `max`, or `unlimited`, the backend auto-sets `sessionMode: 'advanced'` in user preferences if not already set.

---

## CF Access Configuration Strategy

The setup wizard calls `handleCreateAccessApp()` only when GitHub OIDC is NOT configured. When `SAAS_MODE=active` and `OAUTH_CLIENT_ID` is set, the `create_access_app` step is skipped entirely - the Worker handles auth directly, and creating a CF Access app on the same domain would intercept requests before the Worker runs.

**Why `login_method` in SaaS mode (not groups):**
- **Groups (default mode):** `include: { group: { id: adminGroupId } }` - only allowlisted users can authenticate
- **login_method (SaaS mode):** `include: { login_method: { id: githubIdpId } }` - ANY GitHub-authenticated user passes CF Access; the Worker enforces subscription tiers

In SaaS mode, the admin group is NOT included in the CF Access policy because admin status is enforced by `requireAdmin` middleware, not CF Access.

**`syncAccessPolicy` is skipped in SaaS mode** - if called, it would overwrite the `login_method` policy with group includes, breaking open signup.

---

## Frontend Components

See [Architecture Internals - SaaS UI Components](architecture-internals.md#saas-ui-components) for LoginPage, SubscribePage, RootPage, and admin user management details.

---

## Legacy Compatibility

**Legacy `accessTier` backward compatibility:** The original 4-tier system is preserved. New code uses `subscriptionTier` with fallback to `accessTier`. When writing tier changes via `PATCH /api/users/:email`, both fields are written.

**Default tier behavior for users without a stored tier:**
- Auth status: returns `'advanced'` (pre-subscription backward compat)
- Tier resolution: returns the `isDefault` tier from config (standard)
- `isActiveTier(undefined)`: returns `true` (backward compat for non-SaaS users)

---

## Specification Coverage

- [REQ-AUTH-007](../../sdd/spec/authentication.md#req-auth-007-jit-user-provisioning-in-saas-mode) - JIT user provisioning in SaaS mode
- [REQ-ENTERPRISE-002](../../sdd/spec/enterprise-mode.md#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded) - Subscription UI hidden and subscribe route guarded in enterprise mode
- [REQ-ENTERPRISE-008](../../sdd/spec/enterprise-mode.md#req-enterprise-008-enterprise-frontend-surface-suppression) - Enterprise frontend surface suppression
- [REQ-ENTERPRISE-009](../../sdd/spec/enterprise-mode.md#req-enterprise-009-enterprise-backend-route-hardening) - Enterprise backend route hardening
- [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning) - Access-gated JIT user provisioning
- [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) - Admin access via Cloudflare Access groups (entry-gate union; per-request elevation)

---

## Related Documentation

- [Authentication](authentication.md) - Auth flows and SaaS mode
- [Billing](billing.md) - Subscription tiers, Stripe, Timekeeper
- [Preseed System](preseed.md#session-modes) - Session mode preseed matrix
- [API Reference](api-reference.md#auth-saas-mode) - Auth API endpoints
