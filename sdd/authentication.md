# Authentication

Authentication modes, user provisioning, session management, and middleware authorization.

**Domain owner:** Backend (Worker)

### Key Concepts

- **CF Access** -- Cloudflare Access, an identity-aware proxy that handles authentication via external IdPs and issues RS256 JWTs.
- **Direct GitHub OAuth** -- Codeflare-managed OAuth flow used in SaaS mode, issuing HMAC-SHA256 JWTs as session cookies.
- **Session Cookie** -- The `codeflare_session` HttpOnly cookie that carries the signed JWT in Direct GitHub OAuth mode.
- **JWT** -- JSON Web Token used by both auth modes; RS256 (CF Access) or HMAC-SHA256 (Direct GitHub OAuth).
- **Service Token** -- A shared secret header (`X-Service-Auth`) used by E2E tests to bypass browser-based authentication.

### Out of Scope

- Enterprise SSO (SAML, Okta, Azure AD) beyond what CF Access natively supports
- Fine-grained RBAC (only admin/user roles are supported)
- Multi-factor authentication (delegated to the IdP or CF Access policy)

### Domain Dependencies

None. Authentication is foundational; other domains depend on it.

---

## REQ-AUTH-001: Two authentication modes

**Applies To:** User

**Intent:** Codeflare supports two mutually exclusive authentication mechanisms: Cloudflare Access (CF Access) and Direct GitHub OAuth, selected by deployment configuration.

**Acceptance Criteria:**
1. When `OAUTH_CLIENT_ID` is NOT set: authentication is handled by Cloudflare Access. The Worker verifies `CF_Authorization` cookies or `cf-access-jwt-assertion` headers using RS256 JWTs validated against the CF Access JWKS endpoint (`https://{authDomain}/cdn-cgi/access/certs`).
2. When `SAAS_MODE=active` AND `OAUTH_CLIENT_ID` is set: authentication is handled by Direct GitHub OAuth. The Worker manages the entire OAuth flow and issues `codeflare_session` cookies (HMAC-SHA256 JWTs verified against `OAUTH_JWT_SECRET`).
3. The two modes are mutually exclusive at runtime: when the Direct GitHub OAuth branch is entered, CF Access is never checked.
4. The frontend always calls `/auth/logout`; the backend dispatches to the correct logout flow based on mode.

**Constraints:**
- Missing `OAUTH_JWT_SECRET` in SaaS mode throws `AuthError` (fail-loud; never silently falls through to CF Access).
- `cf-access-client-id` header is only trusted when `!isSaasModeActive()` to prevent header spoofing in SaaS mode.

**Priority:** P0
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-002: SaaS mode uses Direct GitHub OAuth

**Applies To:** User

**Intent:** When `SAAS_MODE=active` and `OAUTH_CLIENT_ID` is configured, Codeflare presents a branded login page and handles GitHub OAuth directly, with no Cloudflare Access involvement.

**Acceptance Criteria:**
1. Visiting `/` in SaaS mode shows the Codeflare login page with a "Sign in with GitHub" button.
2. `GET /auth/github/login` sets an `oauth_state` cookie (random UUID, 5-min TTL) and redirects to `github.com/login/oauth/authorize` with `client_id` and `scope=user:email`.
3. `GET /auth/github/callback` validates state (cookie vs query param), exchanges the code for an access token via GitHub API, fetches the user's verified primary email, signs an HMAC-SHA256 JWT, and sets a `codeflare_session` cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=3600).
4. OAuth state validation uses cookies (not KV) to avoid eventual consistency issues.
5. Only `primary: true, verified: true` emails from the GitHub API are accepted.
6. The GitHub access token is used ephemerally during the callback and then discarded (not stored).
7. Callback endpoint is rate-limited (10/min per IP).

**Constraints:**
- OAuth error codes are allowlisted: `access_denied`, `redirect_uri_mismatch`, `application_suspended`.
- No CF Access resources (apps, groups, policies) are created when `OAUTH_CLIENT_ID` is set.

**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-003: CF Access mode for all other deployments

**Applies To:** User

**Intent:** When `OAUTH_CLIENT_ID` is not set, Cloudflare Access provides the authentication layer, supporting multiple identity providers (GitHub, Google, etc.) managed through the CF Access dashboard.

**Acceptance Criteria:**
1. Visiting a protected URL (`/app`, `/api/*`, `/setup`) is intercepted by CF Access and redirected to the CF Access login page.
2. After IdP authentication, CF Access issues a `CF_Authorization` cookie (RS256 JWT).
3. The Worker verifies the JWT signature against the CF Access JWKS endpoint.
4. User email is extracted from JWT claims, normalized, and resolved from KV.
5. The setup wizard creates an Access Application with five destinations (`/app`, `/app/*`, `/api/*`, `/setup`, `/setup/*`) and per-worker Access Groups (`<worker-name>-admins`, `<worker-name>-users`).

**Constraints:**
- JWKS is cached per Worker isolate with TTL; `resetJWKSCache()` clears it.
- Concurrent cold-start JWKS fetches are deduplicated via `pendingJWKSFetch` Promise sentinel.
- Admin-only deployments (0 regular users) are supported: the users group is skipped.

**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-004: Service token authentication for E2E testing

**Applies To:** User

**Intent:** Automated E2E tests can authenticate without a browser-based OAuth flow by presenting a service token header.

**Acceptance Criteria:**
1. `X-Service-Auth` header is checked first in `getUserFromRequest()` across all auth modes.
2. The header value is compared against `SERVICE_AUTH_SECRET` using constant-time comparison.
3. Successful service token auth returns an admin user mapped to the email configured in `SERVICE_TOKEN_EMAIL`.
4. In CF Access mode, the secret originates from `CF_ACCESS_CLIENT_SECRET`; in Direct GitHub OAuth mode, from `OAUTH_E2E_TEST_SECRET`. Both are deployed as `SERVICE_AUTH_SECRET`.
5. When neither secret is set, service auth is disabled (no fallback).

**Constraints:**
- Service token auth is the highest priority in the resolution order (checked before cookies or JWTs).
- Constant-time comparison prevents timing attacks on the secret.

**Priority:** P0
**Dependencies:** REQ-AUTH-011
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AUTH-005: Three-tier authorization middleware

**Applies To:** User

**Intent:** Protected routes use a layered middleware stack that enforces identity verification, active subscription status, and admin role checks independently.

**Acceptance Criteria:**
1. **`requireIdentity`** resolves the user from the appropriate auth mechanism. If the user is not in KV (SaaS mode), auto-provisions with `pending` tier via `resolveOrProvisionUser()`. Sets `c.get('user')` with email, role, subscriptionTier, and accessTier. Used for subscribe-page endpoints.
2. **`requireActiveUser`** authenticates (same as requireIdentity) then checks that `subscriptionTier ?? accessTier` is an active tier (free/trial/standard/advanced/max/unlimited). Pending users receive 403 with code `'PENDING'`; blocked users receive 403 with code `'BLOCKED'`. When `SAAS_MODE` is not active, behaves identically to `requireIdentity` (no tier checking).
3. **`requireAdmin`** checks `role === 'admin'`. Must be composed after `requireIdentity` or `requireActiveUser`. Used for `/admin/*` and user management.
4. `requireActiveUser` is also exported as `authMiddleware` for backward compatibility.

**Constraints:**
- In non-SaaS mode, `requireActiveUser` does not enforce tier checking (backward compatibility with pre-subscription deployments).
- `isActiveTier(undefined)` returns `true` for backward compatibility with users who have no tier field.

**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AUTH-006: User email normalized

**Applies To:** User

**Intent:** User email addresses are normalized before any lookup, comparison, or storage operation to prevent case-sensitive duplicates and whitespace-related mismatches.

**Acceptance Criteria:**
1. All email addresses are trimmed (leading/trailing whitespace removed) and lowercased before use.
2. Normalization is applied before KV lookup, role resolution, bucket name derivation, and CF Access group membership operations.
3. Bucket name derivation from email produces deterministic, sanitized names (max 63 chars): `user@example.com` -> `codeflare-user-example-com`.

**Constraints:**
- Normalization must be applied consistently across all code paths that handle email (Worker auth, setup wizard, user management API).

**Priority:** P0
**Dependencies:** None
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AUTH-007: JIT user provisioning in SaaS mode

**Applies To:** User

**Intent:** In SaaS mode, users who authenticate via GitHub OAuth for the first time are automatically provisioned in KV with a `pending` subscription tier, eliminating manual allowlisting.

**Acceptance Criteria:**
1. When `requireIdentity` resolves a user not found in KV and SaaS mode is active, `resolveOrProvisionUser()` creates a new KV record at `user:{email}` with `pending` tier.
2. Pending users can access `/api/auth/status` and `/api/auth/subscribe` (identity-only routes) but are blocked from IDE access by `requireActiveUser` with 403 code `'PENDING'`.
3. Frontend catches the `PENDING` 403 and redirects to `/app/subscribe`.
4. After subscription (self-service or admin approval), the user record is updated with an active tier.
5. First-time active users are redirected to `/app/onboarding` for guided setup.

**Constraints:**
- Non-SaaS mode does not perform JIT provisioning; users must be allowlisted via the setup wizard or admin API.
- Blocked users with valid OIDC sessions cannot self-upgrade to free tier (subscribe handler checks `getEffectiveTier` at top).

**Priority:** P1
**Dependencies:** REQ-AUTH-002, REQ-AUTH-005
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-008: Session cookie auto-refresh

**Applies To:** User

**Intent:** The `codeflare_session` cookie (Direct GitHub OAuth mode) is automatically refreshed before expiry to prevent session interruption during active use.

**Acceptance Criteria:**
1. Middleware in `index.ts` checks the `codeflare_session` JWT expiry on every response.
2. When less than 15 minutes remain on the 1-hour TTL, a new JWT is signed with a fresh 1-hour expiry and set as a replacement cookie on the response.
3. The refresh is transparent to the user (no redirect, no re-authentication).
4. The refresh occurs on any response, not just specific routes.

**Constraints:**
- Only applies in Direct GitHub OAuth mode (`codeflare_session` cookie).
- CF Access mode sessions are managed by CF Access's own policy and are not refreshed by the Worker.

**Priority:** P1
**Dependencies:** REQ-AUTH-002
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AUTH-009: Logout dispatches by mode

**Applies To:** User

**Intent:** Logout correctly terminates the session regardless of the active authentication mode, with a single frontend endpoint that dispatches to the appropriate backend flow.

**Acceptance Criteria:**
1. Frontend navigates to `/auth/logout` via `window.location.href` for all modes.
2. In Direct GitHub OAuth mode: backend redirects to `/auth/github/logout`, which clears the `codeflare_session` cookie and redirects to the login page.
3. In CF Access mode: backend redirects to `https://{authDomain}/cdn-cgi/access/logout?returnTo=https://{customDomain}/`, which clears the `CF_Authorization` cookie via CF Access's system endpoint.
4. The dispatch decision is made by the backend based on the current deployment configuration, not by the frontend.

**Constraints:**
- Logout redirect responses include HSTS headers via `redirectWithHeaders()`.
- After logout in SaaS mode, the user lands on the `/login` page. After logout in CF Access mode, the user lands on the CF Access login page.

**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Manual check
**Status:** Implemented

---

## REQ-AUTH-010: Auth bypass prevention

**Applies To:** User

**Intent:** A transient KV failure must not permanently degrade a configured deployment to the pre-setup header-trust model, which would allow unauthenticated access.

**Acceptance Criteria:**
1. An `authConfigFetched` boolean sentinel in `access.ts` is set to `true` once KV auth config has been successfully fetched with real data (auth domain + audience).
2. Once the sentinel is set, the pre-setup fallback that trusts `cf-access-authenticated-user-email` headers is permanently disabled for the isolate's lifetime.
3. Subsequent KV read failures do not revert the sentinel.
4. `resetAuthConfigCache()` clears the sentinel (used in tests).

**Constraints:**
- This is a per-isolate sentinel; new isolates must fetch auth config at least once before the fallback is disabled.
- Concurrent cold-start auth config fetches are deduplicated via `pendingAuthConfigFetch` Promise sentinel.

**Priority:** P0
**Dependencies:** REQ-AUTH-003
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AUTH-011: Auth resolution order

**Applies To:** User

**Intent:** Authentication methods are checked in a strict priority order to prevent ambiguity and ensure the most specific credential takes precedence.

**Acceptance Criteria:**
1. `getUserFromRequest()` checks in this order: (a) Service token (`X-Service-Auth` header), (b) Direct GitHub OAuth (`codeflare_session` cookie, only when SaaS + OIDC), (c) Cloudflare Access (`cf-access-jwt-assertion` header or `CF_Authorization` cookie), (d) Pre-setup fallback (`cf-access-authenticated-user-email` header, only before setup completes).
2. Once a method succeeds, subsequent methods are not checked.
3. Once a method's branch is entered (e.g., SaaS + OIDC), it does not fall through to the next method on failure.

**Constraints:**
- Pre-setup fallback is disabled permanently once `authConfigFetched` sentinel is set (REQ-AUTH-010).
- The resolution order is the same for all routes; individual routes choose which middleware layer (identity, active user, admin) they require.

**Priority:** P0
**Dependencies:** REQ-AUTH-001, REQ-AUTH-010
**Verification:** Automated test
**Status:** Implemented

---

## REQ-AUTH-012: Welcome email on first login

**Intent:** New users in SaaS mode receive a welcome email on first login, providing a professional onboarding touchpoint and confirming their account was created.

**Applies To:** User

**Acceptance Criteria:**
1. When a user is JIT-provisioned on first login, a welcome email is sent via Resend
2. Email is fire-and-forget — delivery failure does not block login
3. Email is sent only once per user (dedup via KV flag)
4. When RESEND_API_KEY is not configured, the email is silently skipped

**Constraints:**
- Must comply with CON-REL-001 (non-blocking)
- Email content must not expose internal system details

**Priority:** P2
**Dependencies:** REQ-AUTH-007
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-013: Custom branded login page

**Intent:** SaaS mode provides a branded login experience instead of the raw CF Access login page.

**Applies To:** User

**Acceptance Criteria:**
1. Login page at `/login` shows Codeflare branding with animated logo.
2. "Sign in with GitHub" button is displayed.
3. Available auth providers are listed.

**Constraints:**
- None

**Priority:** P0
**Dependencies:** REQ-AUTH-002
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-014: Auth expiry detection mid-session

**Intent:** Users are warned when their auth session expires during active use instead of silently failing.

**Applies To:** User

**Acceptance Criteria:**
1. When API calls return 401, an amber re-auth banner appears in the UI.
2. Clicking the banner refreshes auth.
3. Session polling stops on expiry to prevent noise.

**Constraints:**
- None

**Priority:** P1
**Dependencies:** REQ-AUTH-008
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-015: Guided onboarding flow

**Intent:** First-time users are walked through connecting their accounts step by step.

**Applies To:** User

**Acceptance Criteria:**
1. `/app/onboarding` shows steps for GitHub PAT, CF API token, and agent subscription.
2. First-time users are auto-redirected to onboarding.
3. `onboardingComplete` flag prevents re-redirect.

**Constraints:**
- None

**Priority:** P1
**Dependencies:** REQ-AUTH-007
**Verification:** Integration test
**Status:** Implemented

---

## REQ-AUTH-016: Header user dropdown

**Intent:** Quick access to account actions from any page.

**Applies To:** User

**Acceptance Criteria:**
1. Clicking avatar/username in header opens dropdown with Profile, Guided Setup, Logout.
2. Mobile renders as bottom sheet.
3. Desktop positioned below avatar.

**Constraints:**
- None

**Priority:** P2
**Dependencies:** None
**Verification:** Manual check
**Status:** Implemented

---

## REQ-AUTH-017: Gravatar integration

**Intent:** Visual user identification via avatar.

**Applies To:** User

**Acceptance Criteria:**
1. User avatar from Gravatar displayed in header and dashboard.
2. Falls back to outline icon when no Gravatar exists.
3. MD5 hash of email used for lookup.

**Constraints:**
- None

**Priority:** P2
**Dependencies:** None
**Verification:** Manual check
**Status:** Implemented

---

## REQ-AUTH-018: User management admin panel

**Intent:** Admins can manage users, approve access, and configure tiers without CLI tools.

**Applies To:** Admin

**Acceptance Criteria:**
1. `/admin/users` shows all users grouped by tier.
2. Admin can search, approve pending users, change tiers, delete users (triggers full cleanup: KV + R2 + sessions + scoped tokens).
3. User count vs capacity displayed.

**Constraints:**
- None

**Priority:** P1
**Dependencies:** REQ-AUTH-005
**Verification:** Integration test
**Status:** Implemented
