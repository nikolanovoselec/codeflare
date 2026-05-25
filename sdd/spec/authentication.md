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

<!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-001 SaaS mode mutual exclusivity describe -> AuthError when OAUTH_JWT_SECRET missing + no fallthrough to CF Access + valid SaaS cookie authenticates -> AC2,3) -->
### REQ-AUTH-001: Two authentication modes

<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @impl: src/lib/onboarding.ts::isSaasModeActive -->

**Intent:** Codeflare supports two mutually exclusive authentication mechanisms: Cloudflare Access (CF Access) and Direct GitHub OAuth, selected by deployment configuration.

**Applies To:** User

**Acceptance Criteria:**

1. When GitHub OAuth is not configured, authentication is handled by Cloudflare Access; the Worker verifies CF Access JWTs against the deployment's CF Access JWKS endpoint.
2. When the deployment is configured as SaaS with GitHub OAuth, the Worker manages the entire OAuth flow and issues its own session cookies signed against an operator-provided JWT secret.
3. The two modes are mutually exclusive at runtime: when the Direct GitHub OAuth branch is entered, CF Access is never checked.
4. The frontend always calls a single logout endpoint; the backend dispatches to the correct logout flow based on mode.

**Constraints:**

- Missing SaaS credentials cause a fail-loud authentication error; there is no silent fallback to CF Access.
- CF Access identity headers are not trusted in SaaS mode.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Integration test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 describe -> /auth/github/login redirect with signed state, /auth/github/callback validates state/expiry/redemption, exchanges code for token, fetches verified primary email, sets codeflare_session cookie, redirects /app or /subscribe based on tier -> AC1..AC5) -->
### REQ-AUTH-002: SaaS mode uses Direct GitHub OAuth

<!-- @impl: src/routes/github-auth.ts -->
<!-- @impl: src/lib/oauth-state.ts -->

**Intent:** When the deployment is configured as SaaS with GitHub OAuth, Codeflare presents a branded login page and handles the OAuth flow directly, with no Cloudflare Access involvement.

**Applies To:** User

**Acceptance Criteria:**

1. Visiting the root URL in SaaS mode shows the Codeflare login page with a "Sign in with GitHub" button.
2. The login endpoint initiates a GitHub OAuth flow with a signed, self-contained state token (no cookie required during the redirect).
3. The OAuth callback validates the state token, rejecting tokens not issued by this server, issued more than 30 minutes ago, or already redeemed.
4. Successful callback validation creates an authenticated session and redirects the user to their workspace if their subscription is active, or to the subscription page if pending or blocked; the GitHub access token used during the exchange is held only for the duration of the callback and never persisted to KV, DO storage, or any session record.
5. State-validation failure redirects to the login page with an error indicator.
6. The OAuth handshake works on browsers that drop or partition cross-site cookies during the github.com bounce-back, including iOS WebKit (Safari, Brave) in standard, private, and ephemeral browsing modes.
7. Only verified primary GitHub emails are accepted.

**Constraints:**

- User-initiated OAuth rejections (e.g. access denied) are handled gracefully; unexpected errors surface as system errors.
- No CF Access resources (apps, groups, policies) are created when SaaS OAuth is active.
- The callback endpoint is rate-limited per source IP to bound brute-force replay attempts on intercepted state tokens; the window and threshold are operational tuning parameters.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Integration test](../../src/__tests__/routes/github-auth.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 describe -> verifyAccessJWT validates CF Access signature against JWKS + extracts email claim + JWKS cache invalidation via resetJWKSCache -> AC2, AC3, AC4) -->
<!-- @test: src/__tests__/routes/setup/access.test.ts (setup access wizard describe -> creates Access Application with 5 destinations + per-worker Access Groups admins/users -> AC5) -->
### REQ-AUTH-003: CF Access mode for all other deployments

<!-- @impl: src/lib/jwt.ts::verifyAccessJWT -->
<!-- @impl: src/lib/jwt.ts::resetJWKSCache -->
<!-- @impl: src/routes/setup/access.ts -->

**Intent:** When the deployment is not configured for SaaS, Cloudflare Access provides the authentication layer, supporting multiple identity providers managed through the CF Access dashboard.

**Applies To:** User

**Acceptance Criteria:**

1. Accessing protected application pages or API endpoints triggers a CF Access redirect to the configured identity provider.
2. After IdP authentication, CF Access issues a session credential that the Worker validates on every request.
3. The Worker verifies the credential signature against the CF Access JWKS endpoint.
4. User email is extracted from the credential claims, normalized, and resolved from persistent storage.
5. The setup wizard provisions a CF Access Application covering all protected paths and creates Access Groups scoped to admin and regular user roles.

**Constraints:**

- JWKS responses are cached per Worker isolate with a TTL and can be invalidated for testing.
- Concurrent cold-start JWKS fetches are deduplicated.
- Admin-only deployments (no regular users) are supported.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Integration test](../../src/__tests__/lib/jwt.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004 Service token describe -> X-Service-Auth checked first beats SaaS + constant-time comparison rejects wrong/length-mismatch + admin role + SERVICE_TOKEN_EMAIL normalization + AC5 ignored when secret unset -> AC1..AC3,AC5) -->
### REQ-AUTH-004: Service token authentication for E2E testing

<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @test: src/__tests__/lib/service-token-auth.test.ts (service-token-auth describe → X-Service-Auth precedence + constant-time compare + admin mapping → AC1/AC2/AC3/AC5) -->

**Intent:** Automated E2E tests can authenticate without a browser-based OAuth flow by presenting a service token header.

**Applies To:** User

**Acceptance Criteria:**

1. The service-token header is checked first, before any other authentication method, regardless of deployment mode.
2. The header value is compared against the configured service-auth secret using constant-time comparison.
3. Successful service-token auth returns an admin user with a preconfigured test identity.
4. The secret source varies by deployment mode but is unified under a single shared secret name at runtime.
5. When no service-token secret is configured, service auth is disabled (no fallback).

**Constraints:**

- Service token auth is the highest priority in the resolution order (checked before cookies or JWTs).
- Constant-time comparison prevents timing attacks on the secret.

**Priority:** P0

**Dependencies:** [REQ-AUTH-011](#req-auth-011-auth-resolution-order)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-005: Three-tier authorization middleware

<!-- @impl: src/middleware/auth.ts::requireIdentity -->
<!-- @impl: src/middleware/auth.ts::requireActiveUser -->
<!-- @impl: src/middleware/auth.ts::requireAdmin -->
<!-- @impl: src/lib/subscription.ts::isActiveTier -->
<!-- @test: src/__tests__/middleware/auth-saas.test.ts (SaaS auth middleware describe → identity + active + admin tiers + PENDING/BLOCKED → AC1-AC4) -->

**Intent:** Protected routes use a layered middleware stack that enforces identity verification, active subscription status, and admin role checks independently.

**Applies To:** User

**Acceptance Criteria:**

1. The identity middleware resolves the authenticated user from the active auth mechanism and auto-provisions first-time SaaS users with a pending subscription tier.
2. The active-user middleware additionally verifies the user holds an active subscription tier; pending users are rejected with code PENDING, blocked users with code BLOCKED; tier checking is skipped outside SaaS mode for backward compatibility.
3. The admin middleware restricts access to users with the admin role and must be composed after one of the user-identity middlewares.

**Constraints:**

- Outside SaaS mode, the active-user check does not enforce tier (backward compatibility with pre-subscription deployments).
- Users with no tier field are treated as active for backward compatibility.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Automated test](../../src/__tests__/middleware/auth-saas.test.ts)

**Status:** Implemented

---

### REQ-AUTH-006: User email normalized

<!-- @impl: src/lib/access.ts::getBucketName -->
<!-- @impl: src/lib/access.ts::resolveUserFromKV -->
<!-- @test: src/__tests__/lib/access.test.ts (getBucketName + authenticateRequest describes → trim + lowercase + deterministic bucket name → AC1/AC2/AC3) -->

**Intent:** User email addresses are normalized before any lookup, comparison, or storage operation to prevent case-sensitive duplicates and whitespace-related mismatches.

**Applies To:** User

**Acceptance Criteria:**

1. All email addresses are trimmed (leading/trailing whitespace removed) and lowercased before use.
2. Normalization is applied before KV lookup, role resolution, bucket name derivation, and CF Access group membership operations.
3. User storage resources are named deterministically from the normalized email address.

**Constraints:**

- Normalization is applied consistently wherever email addresses are processed.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/access.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-007 describe -> resolveOrProvisionUser creates user:{email} record with pending tier when SaaS + unknown email -> AC1) -->
<!-- @test: src/__tests__/middleware/auth-saas.test.ts (requireActiveUser describe -> 403 PENDING for pending tier + allows identity-only routes -> AC2 pending-blocked-from-IDE) -->
### REQ-AUTH-007: JIT user provisioning in SaaS mode

<!-- @impl: src/lib/access.ts::resolveOrProvisionUser -->
<!-- @impl: src/middleware/auth.ts::requireIdentity -->

**Intent:** In SaaS mode, users who authenticate via GitHub OAuth for the first time are automatically provisioned in KV with a `pending` subscription tier, eliminating manual allowlisting.

**Applies To:** User

**Acceptance Criteria:**

1. A new user record is created with a pending subscription tier on first SaaS login.
2. Pending users can access identity-only endpoints but are blocked from the IDE.
3. The frontend detects the pending state and redirects the user to the subscription page.
4. After subscription (self-service or admin approval), the user record is updated with an active tier.
5. First-time active users are redirected to onboarding for guided setup.

**Constraints:**

- Non-SaaS mode does not perform JIT provisioning; users must be allowlisted via the setup wizard or admin API.
- Blocked users cannot self-upgrade to a free tier.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Integration test](../../src/__tests__/lib/access.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-008 Session cookie auto-refresh describe -> shouldRefreshJWT true at 14min + false at 16min + boundary at exactly 15min + refresh produces 3600s TTL + expired token returns false -> AC1,2,4) -->
### REQ-AUTH-008: Session cookie auto-refresh

<!-- @impl: src/index.ts -->
<!-- @impl: src/routes/github-auth.ts -->
<!-- @test: src/__tests__/lib/session-jwt.test.ts (shouldRefreshJWT describe → 15-min threshold + transparent refresh → AC1/AC2) -->

**Intent:** SaaS-mode session credentials are automatically refreshed before expiry so users do not experience session interruption during active use.

**Applies To:** User

**Acceptance Criteria:**

1. Global middleware checks the SaaS session credential's remaining lifetime on every response.
2. When less than 15 minutes remain on the 1-hour TTL, a fresh credential is issued with a new 1-hour expiry and returned on the response.
3. The refresh is transparent to the user (no redirect, no re-authentication).
4. The refresh occurs on any response, not just specific routes.

**Constraints:**

- Only applies to SaaS-mode session credentials.
- CF Access sessions are managed by CF Access's own policy and are not refreshed by the Worker.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout describe -> redirects to CF Access logout URL when auth_domain set + redirects to request host origin when not set + encodes returnTo with custom_domain -> AC2, AC3, AC4 backend dispatch by mode) -->
### REQ-AUTH-009: Logout dispatches by mode

<!-- @impl: src/routes/auth-redirects.ts -->
<!-- @impl: src/routes/github-auth.ts -->

**Intent:** Logout correctly terminates the session regardless of the active authentication mode, with a single frontend endpoint that dispatches to the appropriate backend flow.

**Applies To:** User

**Acceptance Criteria:**

1. The frontend triggers logout via a single endpoint, irrespective of deployment mode.
2. In SaaS mode, the backend clears the session credential and redirects the user to the login page.
3. In CF Access mode, the backend redirects through CF Access's system logout endpoint so CF Access clears its own credential.
4. The dispatch decision is made by the backend based on the current deployment configuration, not by the frontend.

**Constraints:**

- Logout redirect responses carry the full security header set.
- After logout, the user always lands on the appropriate login page for the deployment mode.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Automated test](../../src/__tests__/routes/auth-redirects.test.ts)

**Notes:** Logout dispatch is covered by automated tests at `src/__tests__/routes/auth-redirects.test.ts`.

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 Auth bypass prevention sentinel describe -> pre-setup header trust before config fetched + header trust permanently disabled once authConfigFetched=true + resetAuthConfigCache restores pre-setup -> AC1,2,4) -->
### REQ-AUTH-010: Auth bypass prevention

<!-- @impl: src/lib/access.ts::resetAuthConfigCache -->
<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → authConfigFetched sentinel + pre-setup-header-trust gate + resetAuthConfigCache → AC1-AC4) -->

**Intent:** A transient KV failure must not permanently degrade a configured deployment to the pre-setup header-trust model, which would allow unauthenticated access.

**Applies To:** User

**Acceptance Criteria:**

1. Once auth configuration has been successfully fetched from persistent storage at least once, the isolate records that fact for its lifetime.
2. Once that flag is set, the pre-setup header-trust fallback is permanently disabled for the isolate.
3. Subsequent transient storage failures do not revert the flag.
4. The cached state can be explicitly invalidated for test purposes.

**Constraints:**

- This is a per-isolate flag; new isolates must complete the initial auth-config fetch before the pre-setup fallback is disabled.
- Concurrent cold-start auth-config fetches are deduplicated; no redundant storage reads are issued.

**Priority:** P0

**Dependencies:** [REQ-AUTH-003](#req-auth-003-cf-access-mode-for-all-other-deployments)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011 Auth resolution order describe -> service token beats SaaS OIDC + SaaS beats CF Access + service-token early-return skips SaaS branch (no AuthError thrown without OAUTH_JWT_SECRET) + pre-setup fallback is last + SaaS no-fallthrough on bad cookie -> AC1,2,3) -->
### REQ-AUTH-011: Auth resolution order

<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → strict priority order + no-fall-through-on-failure → AC1/AC2/AC3) -->

**Intent:** Authentication methods are checked in a strict priority order to prevent ambiguity and ensure the most specific credential takes precedence.

**Applies To:** User

**Acceptance Criteria:**

1. Authentication is resolved in strict priority order: (a) service token, (b) SaaS session credential, (c) CF Access JWT, (d) pre-setup header fallback.
2. Once a method succeeds, subsequent methods are not checked.
3. Once a method's branch is entered, it does not fall through to the next method on failure.

**Constraints:**

- Pre-setup fallback is permanently disabled once auth configuration has been successfully loaded ([REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)).
- The resolution order is the same for all routes; individual routes choose which middleware layer (identity, active user, admin) they require.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes), [REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/email.test.ts (sendWelcomeEmail describe -> POSTs Resend with branded HTML + skips silently when RESEND_API_KEY unset -> AC1 sent on JIT, AC4 skipped without API key) -->
<!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-012 describe -> resolveOrProvisionUser fires sendWelcomeEmail fire-and-forget + dedupes via KV flag -> AC2 fire-and-forget, AC3 dedup) -->
### REQ-AUTH-012: Welcome email on first login

<!-- @impl: src/lib/email.ts::sendWelcomeEmail -->
<!-- @impl: src/lib/access.ts::resolveOrProvisionUser -->

**Intent:** New users in SaaS mode receive a welcome email on first login, providing a professional onboarding touchpoint and confirming their account was created.

**Applies To:** User

**Acceptance Criteria:**

1. When a user is JIT-provisioned on first login, a welcome email is sent.
2. Email sending is fire-and-forget; delivery failure does not block login.
3. Email is sent only once per user (deduplicated via a per-user flag in storage).
4. When the email provider is not configured, the send is silently skipped.

**Constraints:**

- Must comply with [CON-REL-001](constraints.md#con-rel-001-graceful-shutdown-with-final-sync-before-exit) (non-blocking).
- Email content must not expose internal system details.

**Priority:** P2

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode)

**Verification:** [Integration test](../../src/__tests__/lib/email.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 describe -> renders Codeflare branding + animated logo + Sign in with GitHub button + lists auth providers -> AC1, AC2, AC3) -->
### REQ-AUTH-013: Custom branded login page

<!-- @impl: web-ui/src/components/LoginPage.tsx -->

**Intent:** SaaS mode provides a branded login experience instead of the raw CF Access login page.

**Applies To:** User

**Acceptance Criteria:**

1. The SaaS login page shows Codeflare branding with an animated logo.
2. "Sign in with GitHub" button is displayed.
3. Available auth providers are listed.

**Constraints:**

None.

**Priority:** P0

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/LoginPage.test.tsx)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 describe -> renders amber re-auth banner on 401 from API + clicking banner refreshes auth + stops session polling -> AC1, AC2, AC3) -->
<!-- @test: web-ui/src/__tests__/api/client.test.ts (API Client describe -> 401 response surfaces a typed AuthExpired signal consumed by Layout banner -> AC1 wiring) -->
### REQ-AUTH-014: Auth expiry detection mid-session

<!-- @impl: web-ui/src/api/client.ts -->
<!-- @impl: web-ui/src/components/Layout.tsx -->

**Intent:** Users are warned when their auth session expires during active use instead of silently failing.

**Applies To:** User

**Acceptance Criteria:**

1. When API calls return 401, an amber re-auth banner appears in the UI.
2. Clicking the banner refreshes auth.
3. Session polling stops on expiry to prevent noise.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-008](#req-auth-008-session-cookie-auto-refresh)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (OnboardingPage / REQ-AUTH-015 describe -> renders 4-step flow (idle timeout, GitHub PAT, Cloudflare API token, agent subscription) + free-tier 15m locked + paying-tier 5m-2h selector + auto-redirect for first-time users + onboardingComplete flag prevents re-redirect -> AC1, AC2, AC3, AC4) -->
### REQ-AUTH-015: Guided onboarding flow

<!-- @impl: web-ui/src/components/OnboardingPage.tsx -->

**Intent:** First-time users are walked through connecting their accounts step by step.

**Applies To:** User

**Acceptance Criteria:**

1. The onboarding page shows four steps: idle timeout selector, GitHub PAT, Cloudflare API token, and agent subscription.
2. The idle timeout step explains compute usage and lets users choose their auto-sleep duration. Free-tier users see a locked 15m selector with upgrade hint; paying users can select 5m-2h.
3. First-time users are auto-redirected to onboarding.
4. Once onboarding has been completed, the user is not redirected there again.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode), [REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/OnboardingPage.test.tsx)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component describe -> header-user-menu testid renders + dropdown items header-user-dropdown-usage etc. + user name display -> AC1 dropdown with Profile/Guided Setup/Logout, AC3 desktop positioning) -->
### REQ-AUTH-016: Header user dropdown

<!-- @impl: web-ui/src/components/Header.tsx -->

**Intent:** Quick access to account actions from any page.

**Applies To:** User

**Acceptance Criteria:**

1. Clicking avatar/username in header opens dropdown with Profile, Guided Setup, Logout.
2. Mobile renders as bottom sheet.
3. Desktop positioned below avatar.

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../web-ui/src/__tests__/components/Header.test.tsx)

**Notes:** Dropdown items, mobile sheet, and desktop positioning are covered by `web-ui/src/__tests__/components/Header.test.tsx`.

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/lib/gravatar.test.ts (getGravatarUrl / REQ-AUTH-017 AC3 describe -> MD5 hash of trimmed+lowercased email + known-answer vector + ?d=404 fallback contract for AC2 + size honored -> AC1, AC2, AC3) -->
<!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component describe -> shows default avatar when no user name (outline-icon fallback path) -> AC2 fallback) -->
### REQ-AUTH-017: Gravatar integration

<!-- @impl: web-ui/src/components/Header.tsx -->
<!-- @impl: web-ui/src/lib/gravatar.ts -->

**Intent:** Visual user identification via avatar.

**Applies To:** User

**Acceptance Criteria:**

1. User avatar from Gravatar displayed in header and dashboard.
2. Falls back to outline icon when no Gravatar exists.
3. The hashed normalized email is used for the Gravatar lookup.

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/gravatar.test.ts)

**Notes:** Lookup contract is covered by `web-ui/src/__tests__/lib/gravatar.test.ts`; fallback rendering is covered by `web-ui/src/__tests__/components/Header.test.tsx`.

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/users.test.ts (Users Routes / REQ-AUTH-018 describe -> /admin/users lists users grouped by tier + admin can approve/change-tier/delete -> AC1, AC2) -->
<!-- @test: src/__tests__/lib/user-cleanup.test.ts (cleanupUserData describe -> deletes user from KV + revokes scoped R2 token + empties R2 bucket + deletes bucket via CF API -> AC2 full cleanup pipeline on delete) -->
### REQ-AUTH-018: User management admin panel

<!-- @impl: src/routes/admin -->
<!-- @impl: src/routes/users.ts -->
<!-- @impl: src/lib/user-cleanup.ts::cleanupUserData -->
<!-- @test: src/__tests__/routes/users.test.ts (Users Routes + GET/DELETE + Admin-only access control describes -> AC1/AC2/AC3 admin panel listing + tier mutations + delete cascade) -->

**Intent:** Admins can manage users, approve access, and configure tiers without CLI tools.

**Applies To:** Admin

**Acceptance Criteria:**

1. `/admin/users` shows all users grouped by tier.
2. Admin can search, approve pending users, change tiers, delete users (triggers full cleanup: KV + R2 + sessions + scoped tokens).
3. User count vs capacity displayed.

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Integration test](../../src/__tests__/routes/users.test.ts)

**Status:** Implemented
