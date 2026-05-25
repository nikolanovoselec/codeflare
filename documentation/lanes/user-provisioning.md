# User Provisioning

JIT user provisioning, subscription UX flows, session mode authorization, and frontend auth components for Codeflare SaaS mode.

**Audience:** Operators, Developers

See [Authentication](authentication.md) for auth flows. See [Billing](billing.md) for subscription tiers and Stripe integration.

---

## Contents

- [JIT User Provisioning](#jit-user-provisioning)
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

---

## Related Documentation

- [Authentication](authentication.md) - Auth flows and SaaS mode
- [Billing](billing.md) - Subscription tiers, Stripe, Timekeeper
- [Preseed System](preseed.md#session-modes) - Session mode preseed matrix
- [API Reference](api-reference.md#auth-saas-mode) - Auth API endpoints
