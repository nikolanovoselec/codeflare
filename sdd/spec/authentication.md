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

### REQ-AUTH-001: Two authentication modes

**Intent:** Codeflare supports two mutually exclusive authentication mechanisms: Cloudflare Access (CF Access) and Direct GitHub OAuth, selected by deployment configuration.

**Applies To:** User

**Acceptance Criteria:**

1. When GitHub OAuth is not configured, authentication is handled by Cloudflare Access; the Worker verifies CF Access JWTs against the deployment's CF Access JWKS endpoint. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/jwt.test.ts (verifyAccessJWT validates CF Access signature against JWKS) -->
2. When the deployment is configured as SaaS with GitHub OAuth, the Worker manages the entire OAuth flow and issues its own session cookies signed against an operator-provided JWT secret. <!-- @impl: src/lib/onboarding.ts::isSaasModeActive --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-001 SaaS mode mutual exclusivity describe -> AuthError when OAUTH_JWT_SECRET missing + no fallthrough to CF Access + valid SaaS cookie authenticates) -->
3. The two modes are mutually exclusive at runtime: when the Direct GitHub OAuth branch is entered, CF Access is never checked. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-001 SaaS mode mutual exclusivity describe -> AuthError when OAUTH_JWT_SECRET missing + no fallthrough to CF Access + valid SaaS cookie authenticates) -->
4. The frontend always calls a single logout endpoint; the backend dispatches to the correct logout flow based on mode. <!-- @impl: src/routes/auth-redirects.ts --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout dispatches GitHub-logout vs CF Access logout by mode) -->

**Constraints:**

- Missing SaaS credentials cause a fail-loud authentication error; there is no silent fallback to CF Access.
- CF Access identity headers are not trusted in SaaS mode.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Integration test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-002: SaaS mode uses Direct GitHub OAuth

**Intent:** When the deployment is configured as SaaS with GitHub OAuth, Codeflare presents a branded login page and handles the OAuth flow directly, with no Cloudflare Access involvement.

**Applies To:** User

**Acceptance Criteria:**

1. Visiting the root URL in SaaS mode shows the Codeflare login page with a "Sign in with GitHub" button. <!-- @impl: src/routes/github-auth.ts --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 describe -> /auth/github/login redirect with signed state, /auth/github/callback validates state/expiry/redemption, exchanges code for token, fetches verified primary email, sets codeflare_session cookie, redirects /app or /subscribe based on tier) -->
2. The login endpoint initiates a GitHub OAuth flow with a signed, self-contained state token (no cookie required during the redirect). <!-- @impl: src/lib/oauth-state.ts::signOauthState --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 describe -> /auth/github/login redirect with signed state, /auth/github/callback validates state/expiry/redemption, exchanges code for token, fetches verified primary email, sets codeflare_session cookie, redirects /app or /subscribe based on tier) -->
3. The OAuth callback validates the state token, rejecting tokens not issued by this server, issued more than 30 minutes ago, or already redeemed. <!-- @impl: src/lib/oauth-state.ts::verifyOauthState --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 describe -> /auth/github/login redirect with signed state, /auth/github/callback validates state/expiry/redemption, exchanges code for token, fetches verified primary email, sets codeflare_session cookie, redirects /app or /subscribe based on tier) -->
4. Successful callback validation creates an authenticated session and redirects the user to their workspace if their subscription is active, or to the subscription page if pending or blocked; the GitHub access token used during the exchange is held only for the duration of the callback and never persisted to KV, DO storage, or any session record. <!-- @impl: src/routes/github-auth.ts --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 describe -> /auth/github/login redirect with signed state, /auth/github/callback validates state/expiry/redemption, exchanges code for token, fetches verified primary email, sets codeflare_session cookie, redirects /app or /subscribe based on tier) -->
5. State-validation failure redirects to the login page with an error indicator. <!-- @impl: src/lib/oauth-state.ts::verifyOauthState --> <!-- @impl: src/routes/github-auth.ts --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 describe -> /auth/github/login redirect with signed state, /auth/github/callback validates state/expiry/redemption, exchanges code for token, fetches verified primary email, sets codeflare_session cookie, redirects /app or /subscribe based on tier) -->
6. The OAuth handshake works on browsers that drop or partition cross-site cookies during the github.com bounce-back, including iOS WebKit (Safari, Brave) in standard, private, and ephemeral browsing modes. <!-- @impl: src/lib/oauth-state.ts::signOauthState --> <!-- @test: src/__tests__/routes/github-auth.test.ts (login sets no oauth_state cookie; stateless HMAC-signed state in URL) -->
7. Only verified primary GitHub emails are accepted. <!-- @impl: src/routes/github-auth.ts --> <!-- @test: src/__tests__/routes/github-auth.test.ts (callback redirects ?error=no-verified-email when primary email unverified) -->

**Constraints:**

- User-initiated OAuth rejections (e.g. access denied) are handled gracefully; unexpected errors surface as system errors.
- No CF Access resources (apps, groups, policies) are created when SaaS OAuth is active.
- The callback endpoint is rate-limited per source IP to bound brute-force replay attempts on intercepted state tokens; the window and threshold are operational tuning parameters.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Integration test](../../src/__tests__/routes/github-auth.test.ts)

**Status:** Implemented

---

### REQ-AUTH-003: CF Access mode for all other deployments

**Intent:** When the deployment is not configured for SaaS, Cloudflare Access provides the authentication layer, supporting multiple identity providers managed through the CF Access dashboard.

**Applies To:** User

**Acceptance Criteria:**

1. Accessing protected application pages or API endpoints triggers a CF Access redirect to the configured identity provider. <!-- @impl: src/middleware/auth.ts::requireIdentity --> <!-- coverage-gap: CF Access redirect to the IdP is performed by Cloudflare Access infrastructure, not Worker code; no automated test exercises the proxy redirect -->
2. After IdP authentication, CF Access issues a session credential that the Worker validates on every request. <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 describe -> verifyAccessJWT validates CF Access signature against JWKS + extracts email claim + JWKS cache invalidation via resetJWKSCache) -->
3. The Worker verifies the credential signature against the CF Access JWKS endpoint. <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 describe -> verifyAccessJWT validates CF Access signature against JWKS + extracts email claim + JWKS cache invalidation via resetJWKSCache) -->
4. User email is extracted from the credential claims, normalized, and resolved from persistent storage. <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 describe -> verifyAccessJWT validates CF Access signature against JWKS + extracts email claim + JWKS cache invalidation via resetJWKSCache) -->
5. The setup wizard provisions a CF Access Application covering all protected paths and creates Access Groups scoped to admin and regular user roles. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (setup access wizard describe -> creates Access Application with 5 destinations + per-worker Access Groups admins/users) -->

**Constraints:**

- JWKS responses are cached per Worker isolate with a TTL and can be invalidated for testing.
- Concurrent cold-start JWKS fetches are deduplicated.
- Admin-only deployments (no regular users) are supported.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Integration test](../../src/__tests__/lib/jwt.test.ts)

**Status:** Implemented

---

### REQ-AUTH-004: Service token authentication for E2E testing

**Intent:** Automated E2E tests can authenticate without a browser-based OAuth flow by presenting a service token header.

**Applies To:** User

**Acceptance Criteria:**

1. The service-token header is checked first, before any other authentication method, regardless of deployment mode. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004 Service token describe -> X-Service-Auth checked first beats SaaS + constant-time comparison rejects wrong/length-mismatch + admin role + SERVICE_TOKEN_EMAIL normalization + AC5 ignored when secret unset) --> <!-- @test: src/__tests__/lib/service-token-auth.test.ts (service-token-auth describe → X-Service-Auth precedence + constant-time compare + admin mapping) -->
2. The header value is compared against the configured service-auth secret using constant-time comparison. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004 Service token describe -> X-Service-Auth checked first beats SaaS + constant-time comparison rejects wrong/length-mismatch + admin role + SERVICE_TOKEN_EMAIL normalization + AC5 ignored when secret unset) --> <!-- @test: src/__tests__/lib/service-token-auth.test.ts (service-token-auth describe → X-Service-Auth precedence + constant-time compare + admin mapping) -->
3. Successful service-token auth returns an admin user with a preconfigured test identity. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004 Service token describe -> X-Service-Auth checked first beats SaaS + constant-time comparison rejects wrong/length-mismatch + admin role + SERVICE_TOKEN_EMAIL normalization + AC5 ignored when secret unset) --> <!-- @test: src/__tests__/lib/service-token-auth.test.ts (service-token-auth describe → X-Service-Auth precedence + constant-time compare + admin mapping) -->
4. The secret source varies by deployment mode but is unified under a single shared secret name at runtime. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (service-auth secret unified under one runtime name across modes) -->
5. When no service-token secret is configured, service auth is disabled (no fallback). <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004 Service token describe -> X-Service-Auth checked first beats SaaS + constant-time comparison rejects wrong/length-mismatch + admin role + SERVICE_TOKEN_EMAIL normalization + AC5 ignored when secret unset) --> <!-- @test: src/__tests__/lib/service-token-auth.test.ts (service-token-auth describe → X-Service-Auth precedence + constant-time compare + admin mapping) -->

**Constraints:**

- Service token auth is the highest priority in the resolution order (checked before cookies or JWTs).
- Constant-time comparison prevents timing attacks on the secret.

**Priority:** P0

**Dependencies:** [REQ-AUTH-011](#req-auth-011-auth-resolution-order)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-005: Three-tier authorization middleware

**Intent:** Protected routes use a layered middleware stack that enforces identity verification, active subscription status, and admin role checks independently.

**Applies To:** User

**Acceptance Criteria:**

1. The identity middleware resolves the authenticated user from the active auth mechanism and auto-provisions first-time SaaS users with a pending subscription tier. <!-- @impl: src/middleware/auth.ts::requireIdentity --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (SaaS auth middleware describe → identity + active + admin tiers + PENDING/BLOCKED) -->
2. The active-user middleware additionally verifies the user holds an active subscription tier; pending users are rejected with code PENDING, blocked users with code BLOCKED; tier checking is skipped outside SaaS mode for backward compatibility. <!-- @impl: src/middleware/auth.ts::requireActiveUser --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (SaaS auth middleware describe → identity + active + admin tiers + PENDING/BLOCKED) -->
3. The admin middleware restricts access to users with the admin role and must be composed after one of the user-identity middlewares. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (SaaS auth middleware describe → identity + active + admin tiers + PENDING/BLOCKED) -->

**Constraints:**

- Outside SaaS mode, the active-user check does not enforce tier (backward compatibility with pre-subscription deployments).
- Users with no tier field are treated as active for backward compatibility.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Automated test](../../src/__tests__/middleware/auth-saas.test.ts)

**Status:** Implemented

---

### REQ-AUTH-006: User email normalized

**Intent:** User email addresses are normalized before any lookup, comparison, or storage operation to prevent case-sensitive duplicates and whitespace-related mismatches.

**Applies To:** User

**Acceptance Criteria:**

1. All email addresses are trimmed (leading/trailing whitespace removed) and lowercased before use. <!-- @impl: src/lib/access.ts::resolveUserFromKV --> <!-- @test: src/__tests__/lib/access.test.ts (getBucketName + authenticateRequest describes → trim + lowercase + deterministic bucket name) -->
2. Normalization is applied before KV lookup, role resolution, bucket name derivation, and CF Access group membership operations. <!-- @impl: src/lib/access.ts::resolveUserFromKV --> <!-- @test: src/__tests__/lib/access.test.ts (getBucketName + authenticateRequest describes → trim + lowercase + deterministic bucket name) -->
3. User storage resources are named deterministically from the normalized email address. <!-- @impl: src/lib/access.ts::getBucketName --> <!-- @test: src/__tests__/lib/access.test.ts (getBucketName + authenticateRequest describes → trim + lowercase + deterministic bucket name) -->

**Constraints:**

- Normalization is applied consistently wherever email addresses are processed.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/access.test.ts)

**Status:** Implemented

---

### REQ-AUTH-007: JIT user provisioning in SaaS mode

**Intent:** In SaaS mode, users who authenticate via GitHub OAuth for the first time are automatically provisioned in KV with a `pending` subscription tier, eliminating manual allowlisting.

**Applies To:** User

**Acceptance Criteria:**

1. A new user record is created with a pending subscription tier on first SaaS login. <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-007 describe -> resolveOrProvisionUser creates user:{email} record with pending tier when SaaS + unknown email) -->
2. Pending users can access identity-only endpoints but are blocked from the IDE. <!-- @impl: src/middleware/auth.ts::requireIdentity --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (requireActiveUser describe -> 403 PENDING for pending tier + allows identity-only routes) -->
3. The frontend detects the pending state and redirects the user to the subscription page. <!-- @impl: web-ui/src/App.tsx --> <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (pending user redirected to subscribe) -->
4. After subscription (self-service or admin approval), the user record is updated with an active tier. <!-- @impl: src/lib/user-record.ts::updateUserRecord --> <!-- @test: src/__tests__/lib/user-record.test.ts (active tier persisted after subscription) -->
5. First-time active users are redirected to onboarding for guided setup. <!-- @impl: web-ui/src/App.tsx --> <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (first-time active user redirected to onboarding) -->

**Constraints:**

- Non-SaaS mode does not perform JIT provisioning; users must be allowlisted via the setup wizard or admin API.
- Blocked users cannot self-upgrade to a free tier.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Integration test](../../src/__tests__/lib/access.test.ts)

**Status:** Implemented

---

### REQ-AUTH-008: Session cookie auto-refresh

**Intent:** SaaS-mode session credentials are automatically refreshed before expiry so users do not experience session interruption during active use.

**Applies To:** User

**Acceptance Criteria:**

1. Global middleware checks the SaaS session credential's remaining lifetime on every response. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-008 Session cookie auto-refresh describe -> shouldRefreshJWT true at 14min + false at 16min + boundary at exactly 15min + refresh produces 3600s TTL + expired token returns false) --> <!-- @test: src/__tests__/lib/session-jwt.test.ts (shouldRefreshJWT describe → 15-min threshold + transparent refresh) -->
2. When less than 15 minutes remain on the 1-hour TTL, a fresh credential is issued with a new 1-hour expiry and returned on the response. <!-- @impl: src/index.ts --> <!-- @impl: src/lib/session-jwt.ts::shouldRefreshJWT --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-008 Session cookie auto-refresh describe -> shouldRefreshJWT true at 14min + false at 16min + boundary at exactly 15min + refresh produces 3600s TTL + expired token returns false) --> <!-- @test: src/__tests__/lib/session-jwt.test.ts (shouldRefreshJWT describe → 15-min threshold + transparent refresh) -->
3. The refresh is transparent to the user (no redirect, no re-authentication). <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (in-TTL refresh serves 200 with a rotated cookie, no redirect/re-auth) -->
4. The refresh occurs on any response, not just specific routes. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-008 Session cookie auto-refresh describe -> shouldRefreshJWT true at 14min + false at 16min + boundary at exactly 15min + refresh produces 3600s TTL + expired token returns false) -->

**Constraints:**

- Only applies to SaaS-mode session credentials.
- CF Access sessions are managed by CF Access's own policy and are not refreshed by the Worker.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-009: Logout dispatches by mode

**Intent:** Logout correctly terminates the session regardless of the active authentication mode, with a single frontend endpoint that dispatches to the appropriate backend flow.

**Applies To:** User

**Acceptance Criteria:**

1. The frontend triggers logout via a single endpoint, irrespective of deployment mode. <!-- @impl: src/routes/auth-redirects.ts --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout describe -> SaaS mode + onboarding mode (OAuth configured) redirect to the GitHub logout route not CF Access + redirects to CF Access logout URL when auth_domain set + redirects to request host origin when not set + encodes returnTo with custom_domain) -->
2. In any mode that issues the app's own GitHub-OIDC session (SaaS or onboarding), the backend redirects to the GitHub logout route, which clears the session credential and returns the user to the login page. It must not redirect to the CF Access logout endpoint. <!-- @impl: src/routes/auth-redirects.ts --> <!-- @impl: src/routes/github-auth.ts --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout describe -> SaaS mode + onboarding mode (OAuth configured) redirect to the GitHub logout route not CF Access + redirects to CF Access logout URL when auth_domain set + redirects to request host origin when not set + encodes returnTo with custom_domain) -->
3. In CF Access mode, the backend redirects through CF Access's system logout endpoint so CF Access clears its own credential. <!-- @impl: src/routes/auth-redirects.ts --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout describe -> SaaS mode + onboarding mode (OAuth configured) redirect to the GitHub logout route not CF Access + redirects to CF Access logout URL when auth_domain set + redirects to request host origin when not set + encodes returnTo with custom_domain) -->
4. The dispatch decision is made by the backend based on the current deployment configuration, not by the frontend. <!-- @impl: src/routes/auth-redirects.ts --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout describe -> SaaS mode + onboarding mode (OAuth configured) redirect to the GitHub logout route not CF Access + redirects to CF Access logout URL when auth_domain set + redirects to request host origin when not set + encodes returnTo with custom_domain) -->

**Constraints:**

- Logout redirect responses carry the full security header set.
- After logout, the user always lands on the appropriate login page for the deployment mode.
- The CF Access logout endpoint rejects a `returnTo` pointing at an onboarding/SaaS origin as an invalid redirect URL, so any mode issuing a `codeflare_session` must use the GitHub logout path instead.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** [Automated test](../../src/__tests__/routes/auth-redirects.test.ts)

**Status:** Implemented

---

### REQ-AUTH-010: Auth bypass prevention

**Intent:** A transient KV failure must not permanently degrade a configured deployment to the pre-setup header-trust model, which would allow unauthenticated access.

**Applies To:** User

**Acceptance Criteria:**

1. Once auth configuration has been successfully fetched from persistent storage at least once, the isolate records that fact for its lifetime. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 Auth bypass prevention sentinel describe -> pre-setup header trust before config fetched + header trust permanently disabled once authConfigFetched=true + resetAuthConfigCache restores pre-setup) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → authConfigFetched sentinel + pre-setup-header-trust gate + resetAuthConfigCache) -->
2. Once that flag is set, the pre-setup header-trust fallback is permanently disabled for the isolate. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 Auth bypass prevention sentinel describe -> pre-setup header trust before config fetched + header trust permanently disabled once authConfigFetched=true + resetAuthConfigCache restores pre-setup) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → authConfigFetched sentinel + pre-setup-header-trust gate + resetAuthConfigCache) -->
3. Subsequent transient storage failures do not revert the flag. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → authConfigFetched sentinel + pre-setup-header-trust gate + resetAuthConfigCache) -->
4. The cached state can be explicitly invalidated for test purposes. <!-- @impl: src/lib/access.ts::resetAuthConfigCache --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 Auth bypass prevention sentinel describe -> pre-setup header trust before config fetched + header trust permanently disabled once authConfigFetched=true + resetAuthConfigCache restores pre-setup) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → authConfigFetched sentinel + pre-setup-header-trust gate + resetAuthConfigCache) -->

**Constraints:**

- This is a per-isolate flag; new isolates must complete the initial auth-config fetch before the pre-setup fallback is disabled.
- Concurrent cold-start auth-config fetches are deduplicated; no redundant storage reads are issued.

**Priority:** P0

**Dependencies:** [REQ-AUTH-003](#req-auth-003-cf-access-mode-for-all-other-deployments)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-011: Auth resolution order

**Intent:** Authentication methods are checked in a strict priority order to prevent ambiguity and ensure the most specific credential takes precedence.

**Applies To:** User

**Acceptance Criteria:**

1. Authentication is resolved in strict priority order: (a) service token, (b) SaaS session credential, (c) CF Access JWT, (d) pre-setup header fallback. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011 Auth resolution order describe -> service token beats SaaS OIDC + SaaS beats CF Access + service-token early-return skips SaaS branch (no AuthError thrown without OAUTH_JWT_SECRET) + pre-setup fallback is last + SaaS no-fallthrough on bad cookie) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → strict priority order + no-fall-through-on-failure) -->
2. Once a method succeeds, subsequent methods are not checked. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011 Auth resolution order describe -> service token beats SaaS OIDC + SaaS beats CF Access + service-token early-return skips SaaS branch (no AuthError thrown without OAUTH_JWT_SECRET) + pre-setup fallback is last + SaaS no-fallthrough on bad cookie) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → strict priority order + no-fall-through-on-failure) -->
3. Once a method's branch is entered, it does not fall through to the next method on failure. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011 Auth resolution order describe -> service token beats SaaS OIDC + SaaS beats CF Access + service-token early-return skips SaaS branch (no AuthError thrown without OAUTH_JWT_SECRET) + pre-setup fallback is last + SaaS no-fallthrough on bad cookie) --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest describe → strict priority order + no-fall-through-on-failure) -->

**Constraints:**

- Pre-setup fallback is permanently disabled once auth configuration has been successfully loaded ([REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)).
- The resolution order is the same for all routes; individual routes choose which middleware layer (identity, active user, admin) they require.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes), [REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)

**Verification:** [Automated test](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-012: Welcome email on first login

**Intent:** New users in SaaS mode receive a welcome email on first login, providing a professional onboarding touchpoint and confirming their account was created.

**Applies To:** User

**Acceptance Criteria:**

1. When a user is JIT-provisioned on first login, a welcome email is sent. <!-- @impl: src/lib/email.ts::sendWelcomeEmail --> <!-- @test: src/__tests__/lib/email.test.ts (sendWelcomeEmail describe -> POSTs Resend with branded HTML + skips silently when RESEND_API_KEY unset) -->
2. Email sending is fire-and-forget; delivery failure does not block login. <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-012 describe -> resolveOrProvisionUser fires sendWelcomeEmail fire-and-forget + dedupes via KV flag) -->
3. Email is sent only once per user (deduplicated via a per-user flag in storage). <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-012 describe -> resolveOrProvisionUser fires sendWelcomeEmail fire-and-forget + dedupes via KV flag) -->
4. When the email provider is not configured, the send is silently skipped. <!-- @impl: src/lib/email.ts::sendWelcomeEmail --> <!-- @test: src/__tests__/lib/email.test.ts (sendWelcomeEmail describe -> POSTs Resend with branded HTML + skips silently when RESEND_API_KEY unset) -->

**Constraints:**

- Must comply with [CON-REL-001](constraints.md#con-rel-001-graceful-shutdown-with-final-sync-before-exit) (non-blocking).
- Email content must not expose internal system details.

**Priority:** P2

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode)

**Verification:** [Integration test](../../src/__tests__/lib/email.test.ts)

**Status:** Implemented

---

### REQ-AUTH-013: Custom branded login page

**Intent:** SaaS mode provides a branded login experience instead of the raw CF Access login page.

**Applies To:** User

**Acceptance Criteria:**

1. The SaaS login page shows Codeflare branding with an animated logo. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 describe -> renders Codeflare branding + animated logo + Sign in with GitHub button + lists auth providers + core login content has no entrance opacity/transform animation) -->
2. A "Continue with <provider>" button is displayed for the configured identity provider. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 describe -> renders Codeflare branding + animated logo + Sign in with GitHub button + lists auth providers + core login content has no entrance opacity/transform animation) -->
3. Available auth providers are listed. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 describe -> renders Codeflare branding + animated logo + Sign in with GitHub button + lists auth providers + core login content has no entrance opacity/transform animation) -->
4. Core login content is visible at first paint and is not hidden behind entrance opacity or transform animation. <!-- @impl: web-ui/src/styles/login-page.css::.login-content --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 describe -> renders Codeflare branding + animated logo + Sign in with GitHub button + lists auth providers + core login content has no entrance opacity/transform animation) -->

**Constraints:**

None.

**Priority:** P0

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/LoginPage.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-014: Auth expiry detection mid-session

**Intent:** Users are warned when their auth session expires during active use instead of silently failing.

**Applies To:** User

**Acceptance Criteria:**

1. When API calls return 401, an amber re-auth banner appears in the UI. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 describe -> renders amber re-auth banner on 401 from API + clicking banner refreshes auth + stops session polling) --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (API Client describe -> 401 response surfaces a typed AuthExpired signal consumed by Layout banner) -->
2. Clicking the banner refreshes auth. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 describe -> renders amber re-auth banner on 401 from API + clicking banner refreshes auth + stops session polling) -->
3. Session polling stops on expiry to prevent noise. <!-- @impl: web-ui/src/stores/session.ts --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 describe -> renders amber re-auth banner on 401 from API + clicking banner refreshes auth + stops session polling) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-008](#req-auth-008-session-cookie-auto-refresh)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-015: Guided onboarding flow

**Intent:** First-time users are walked through connecting their accounts step by step.

**Applies To:** User

**Acceptance Criteria:**

1. The onboarding page shows four steps: idle timeout selector, **Connect GitHub** (OAuth), **Connect Cloudflare** (OAuth), and agent subscription. The GitHub and Cloudflare steps reuse the shared OAuth connect card ([REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise), [REQ-AGENT-064](agents.md#req-agent-064-connect-to-cloudflare-via-oauth)) — no manual token paste. <!-- @impl: web-ui/src/components/OnboardingPage.tsx::OnboardingPage --> <!-- @impl: web-ui/src/components/connect/OAuthConnectCard.tsx --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (OnboardingPage / REQ-AUTH-015 describe -> renders 4-step flow (idle timeout, Connect GitHub OAuth, Connect Cloudflare OAuth, agent subscription) + free-tier 15m locked + paying-tier 5m-2h selector + auto-redirect for first-time users + onboardingComplete flag prevents re-redirect) -->
2. The idle timeout step explains compute usage and lets users choose their auto-sleep duration. Free-tier users see a locked 15m selector with upgrade hint; paying users can select 5m-2h. <!-- @impl: web-ui/src/components/OnboardingPage.tsx::OnboardingPage --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (OnboardingPage / REQ-AUTH-015 describe -> renders 4-step flow (idle timeout, Connect GitHub OAuth, Connect Cloudflare OAuth, agent subscription) + free-tier 15m locked + paying-tier 5m-2h selector + auto-redirect for first-time users + onboardingComplete flag prevents re-redirect) -->
3. First-time users are auto-redirected to onboarding. <!-- @impl: web-ui/src/App.tsx --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (OnboardingPage / REQ-AUTH-015 describe -> renders 4-step flow (idle timeout, Connect GitHub OAuth, Connect Cloudflare OAuth, agent subscription) + free-tier 15m locked + paying-tier 5m-2h selector + auto-redirect for first-time users + onboardingComplete flag prevents re-redirect) -->
4. Once onboarding has been completed, the user is not redirected there again. <!-- @impl: web-ui/src/App.tsx --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (OnboardingPage / REQ-AUTH-015 describe -> renders 4-step flow (idle timeout, Connect GitHub OAuth, Connect Cloudflare OAuth, agent subscription) + free-tier 15m locked + paying-tier 5m-2h selector + auto-redirect for first-time users + onboardingComplete flag prevents re-redirect) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode), [REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings), [REQ-AGENT-064](agents.md#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/OnboardingPage.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-016: Header user dropdown

**Intent:** Quick access to account actions from any page.

**Applies To:** User

**Acceptance Criteria:**

1. Clicking avatar/username in header opens dropdown with Profile, Guided Setup, Logout. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component describe -> header-user-menu testid renders + dropdown items header-user-dropdown-usage etc. + user name display) -->
2. Mobile renders as bottom sheet. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- coverage-gap: the account dropdown is rendered unconditionally; the mobile bottom-sheet presentation is pure CSS (media query) with no jsdom-observable DOM/attribute difference, so it is visual/Playwright territory, not unit-testable -->
3. Desktop positioned below avatar. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component describe -> header-user-menu testid renders + dropdown items header-user-dropdown-usage etc. + user name display) -->

**Constraints:**

- In Enterprise Mode the dropdown does not open — the avatar/username stays visible but its click is inert — per [REQ-ENTERPRISE-008](enterprise-mode.md#req-enterprise-008-enterprise-frontend-surface-suppression) AC8. This REQ describes the non-enterprise dropdown.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Automated test](../../web-ui/src/__tests__/components/Header.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-017: Gravatar integration

**Intent:** Visual user identification via avatar.

**Applies To:** User

**Acceptance Criteria:**

1. User avatar from Gravatar displayed in header and dashboard. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/lib/gravatar.test.ts (getGravatarUrl / REQ-AUTH-017 AC3 describe -> MD5 hash of trimmed+lowercased email + known-answer vector + ?d=404 fallback contract for AC2 + size honored) -->
2. Falls back to outline icon when no Gravatar exists. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/lib/gravatar.test.ts (getGravatarUrl / REQ-AUTH-017 AC3 describe -> MD5 hash of trimmed+lowercased email + known-answer vector + ?d=404 fallback contract for AC2 + size honored) --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component describe -> shows default avatar when no user name (outline-icon fallback path)) -->
3. The hashed normalized email is used for the Gravatar lookup. <!-- @impl: web-ui/src/lib/gravatar.ts::getGravatarUrl --> <!-- @test: web-ui/src/__tests__/lib/gravatar.test.ts (getGravatarUrl / REQ-AUTH-017 AC3 describe -> MD5 hash of trimmed+lowercased email + known-answer vector + ?d=404 fallback contract for AC2 + size honored) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** [Lookup contract](../../web-ui/src/__tests__/lib/gravatar.test.ts), [fallback rendering](../../web-ui/src/__tests__/components/Header.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-018: User management admin panel

**Intent:** Admins can manage users, approve access, and configure tiers without CLI tools. Approval is a tier mutation (`PATCH /api/users/:email`); the control surface adapts to the deployment mode — SaaS exposes the full subscription-tier picker, while onboarding (which has no paid tiers) collapses it to a plain Approve / Block decision.

**Applies To:** Admin

**Acceptance Criteria:**

1. `/admin/users` shows all users grouped by tier. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @test: src/__tests__/routes/users.test.ts (Users Routes / REQ-AUTH-018 describe -> /admin/users lists users grouped by tier + admin can approve/change-tier/delete) -->
2. Admin can search, approve pending users, change tiers, delete users (triggers full cleanup: KV + R2 + sessions + scoped tokens). <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @test: src/__tests__/routes/users.test.ts (Users Routes / REQ-AUTH-018 describe -> /admin/users lists users grouped by tier + admin can approve/change-tier/delete) --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (cleanupUserData describe -> deletes user from KV + revokes scoped R2 token + empties R2 bucket + deletes bucket via CF API) -->
3. User count vs capacity displayed. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @test: src/__tests__/routes/users.test.ts (Users Routes + GET/DELETE + Admin-only access control describes -> AC1/AC2/AC3 admin panel listing + tier mutations + delete cascade; onboarding-mode PATCH approval + default-mode PATCH rejection) -->
4. In SaaS mode the admin panel renders the full tier + session-mode selectors per user; in onboarding mode it renders a per-user Approve (grants full access: `unlimited` tier + `advanced` session mode) / Block (`blocked` tier) control, and the bulk action approves all pending users to that same full-access tier. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @test: src/__tests__/routes/users.test.ts (Users Routes + GET/DELETE + Admin-only access control describes -> AC1/AC2/AC3 admin panel listing + tier mutations + delete cascade; onboarding-mode PATCH approval + default-mode PATCH rejection) -->

**Constraints:**

- Tier mutation (`PATCH /api/users/:email`) is the access-approval mechanism in the app-owned OIDC modes only: it is gated on `isSessionOidcMode` (`SAAS_MODE` active OR `ONBOARDING_LANDING_PAGE` active). Enterprise mode is already 403'd by the user-management router middleware (REQ-ENTERPRISE-009), and default (CF Access) mode has no tier-gated access, so PATCH returns 400 there.

**Priority:** P1

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Integration test](../../src/__tests__/routes/users.test.ts)

**Status:** Implemented

---

### REQ-AUTH-019: User identity and account-status API

**Intent:** A signed-in user's client needs one authoritative read of who they are and how their account is configured, plus the small account-status writes the onboarding and storage flows depend on.

**Applies To:** User

**Acceptance Criteria:**

1. `GET /api/user` returns the authenticated user's identity and account status (email, role, access and subscription tier, bucket name, worker name, onboarding-active and SaaS-mode flags, onboarding-complete flag, has-subscribed flag, and subscribed session mode) read from the user's stored record, and creates no resources. <!-- @impl: src/routes/user-profile.ts --> <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes / REQ-AUTH-019 describe -> GET /user identity + onboarding-complete + r2-status + ensure-r2-token 503/500 + 401) -->
2. `POST /api/user/onboarding-complete` marks the user's stored record onboarding-complete so later logins skip the onboarding redirect, and is a no-op when the user has no stored record yet. <!-- @impl: src/routes/user-profile.ts --> <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes / REQ-AUTH-019 describe -> GET /user identity + onboarding-complete + r2-status + ensure-r2-token 503/500 + 401) -->
3. `GET /api/user/r2-status` reports whether a scoped R2 token already exists for the user. <!-- @impl: src/routes/user-profile.ts --> <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes / REQ-AUTH-019 describe -> GET /user identity + onboarding-complete + r2-status + ensure-r2-token 503/500 + 401) -->
4. `POST /api/user/ensure-r2-token` creates the user's scoped R2 token when absent, returning ready on success, 503 when account setup is incomplete, and 500 on a provisioning failure. <!-- @impl: src/routes/user-profile.ts --> <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes / REQ-AUTH-019 describe -> GET /user identity + onboarding-complete + r2-status + ensure-r2-token 503/500 + 401) -->
5. Every endpoint requires authentication; unauthenticated requests are rejected with 401. <!-- @impl: src/routes/user-profile.ts --> <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes / REQ-AUTH-019 describe -> GET /user identity + onboarding-complete + r2-status + ensure-r2-token 503/500 + 401) -->
6. `POST /api/user/ensure-r2-token` is rate-limited per user to bound token-provisioning abuse. <!-- @impl: src/routes/user-profile.ts --> <!-- @test: src/__tests__/routes/rate-limits.test.ts (POST /user/ensure-r2-token 5/min describe) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware), [REQ-AUTH-015](#req-auth-015-guided-onboarding-flow)

**Verification:** [Automated test](../../src/__tests__/routes/user-profile.test.ts)

**Status:** Implemented

---

### REQ-AUTH-020: Onboarding-mode landing-integrated login shell

**Intent:** In onboarding mode, `/login` is served by the marketing landing system while SaaS keeps the existing SPA login page.

**Applies To:** User

**Acceptance Criteria:**

1. In onboarding mode (`ONBOARDING_LANDING_PAGE` active, `SAAS_MODE` not active), the Worker rewrites `/login` asset requests to `/landing/login/`. <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021 describe -> /login rewrite to /landing/login/ in onboarding mode + SaaS callback mode-aware redirect) --> <!-- @test: host/__tests__/wrangler-run-worker-first.test.js (wrangler run_worker_first control-plane routes describe -> /login is in run_worker_first so the onboarding rewrite runs at the edge instead of the SPA asset being served directly) -->
2. The landing-built `/login` page uses the shared landing design tokens, preloaded fonts, and login nav chrome. <!-- @impl: landing/src/pages/login.astro::BaseLayout --> <!-- @impl: landing/src/layouts/BaseLayout.astro::BaseLayout --> <!-- @test: landing/src/__tests__/login-page.test.ts (onboarding login page (REQ-AUTH-020 / REQ-AUTH-021) describe -> inherits the shared nav and font preloads while omitting landing-only motion hooks (no data-flare-fluid / ticker / terminal-loop / proof hooks) + robots noindex,nofollow + no em/en dash in the rendered copy) --> <!-- @test: landing/src/__tests__/components.test.ts (REQ-AUTH-020 Header (one nav, two variants) describe -> variant=login renders only the .login-back link equal to LOGIN.back.href + the back arrow, no pillar .nav-links) -->
3. The landing-built `/login` page omits landing-only WebGL/motion hooks for stable first paint. <!-- @impl: landing/src/layouts/BaseLayout.astro::BaseLayout --> <!-- @test: landing/src/__tests__/login-page.test.ts (onboarding login page (REQ-AUTH-020 / REQ-AUTH-021) describe -> inherits the shared nav and font preloads while omitting landing-only motion hooks (no data-flare-fluid / ticker / terminal-loop / proof hooks) + robots noindex,nofollow + no em/en dash in the rendered copy) -->
4. In SaaS mode, `/login` is unchanged and continues to serve the SPA login. <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021 describe -> /login rewrite to /landing/login/ in onboarding mode + SaaS callback mode-aware redirect) -->

**Constraints:**

- The `/login` rewrite only executes if `/login` is listed in the Cloudflare Assets `run_worker_first` allowlist (`wrangler.toml`).

**Priority:** P1

**Dependencies:** [REQ-AUTH-013](#req-auth-013-custom-branded-login-page), [REQ-LANDING-001](landing.md#req-landing-001-mode-aware-public-landing-serving)

**Verification:** [Login page render tests](../../landing/src/__tests__/login-page.test.ts), [Onboarding login route tests](../../src/__tests__/routes/onboarding-login.test.ts), [wrangler control-plane test](../../host/__tests__/wrangler-run-worker-first.test.js)

**Status:** Implemented

---

### REQ-AUTH-021: Onboarding-mode sign-in choices and access-request flow

**Intent:** Onboarding sign-in offers GitHub plus enterprise-SSO request affordances and records access requests when GitHub OAuth resolves to a non-approved user.

**Applies To:** User

**Acceptance Criteria:**

1. The page offers a GitHub sign-in and enterprise SSO request controls that deep-link to the contact form. <!-- @impl: landing/src/scripts/contact-controller.ts::pickDeepLinkTopic --> <!-- @test: landing/src/__tests__/login-page.test.ts (onboarding login page (REQ-AUTH-020 / REQ-AUTH-021) describe -> GitHub is the single primary action; one native exclusive <details name="sso"> per provider; requested confirmation ships hidden while sign-in choices ship visible) --> <!-- @test: landing/src/__tests__/contact-controller.test.ts (contact-controller (REQ-LANDING-002) describe / pickDeepLinkTopic describe -> returns the enterprise-deployment topic from ?topic= and rejects crafted values) -->
2. Non-approved onboarding GitHub users are recorded as pending, emailed, and redirected to the requested state. <!-- @impl: src/routes/github-auth.ts::onboardingAccessRequest --> <!-- @impl: src/lib/user-record.ts::updateUserRecord --> <!-- @impl: src/lib/email.ts::sendAccessRequestConfirmation --> <!-- @test: landing/src/__tests__/login-page.test.ts (onboarding login page (REQ-AUTH-020 / REQ-AUTH-021) describe -> GitHub is the single primary action; one native exclusive <details name="sso"> per provider; requested confirmation ships hidden while sign-in choices ship visible) --> <!-- @test: landing/src/__tests__/login.script.test.ts (REQ-AUTH-021 login.ts onboarding /login outcome handling describe -> ?status / ?error param state handling reshapes the page) --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021 describe -> active redirect, access-request record, emails, sendAccessRequestConfirmation, and SaaS/enterprise exclusions) -->
3. The onboarding access-request branch never runs in SaaS mode or enterprise mode. <!-- @impl: src/routes/github-auth.ts::onboardingAccessRequest --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021 describe -> active redirect, access-request record, emails, sendAccessRequestConfirmation, and SaaS/enterprise exclusions) -->
4. Onboarding trusts and refreshes `codeflare_session` only when `isSessionOidcMode` is active. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @impl: src/lib/onboarding.ts::isSessionOidcMode --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-021 onboarding mode trusts the codeflare_session cookie describe -> valid session authenticates with SaaS inactive + onboarding active, not trusted when neither mode active, AuthError when JWT secret missing, no fallthrough to CF Access on invalid session) --> <!-- @test: src/__tests__/lib/onboarding.test.ts (isSessionOidcMode REQ-AUTH-021 describe -> true for SaaS or onboarding, false when both inactive) -->
5. Active-tier middleware applies in onboarding; pending visitors with sessions remain gated out of app APIs. <!-- @impl: src/middleware/auth.ts::requireActiveUser --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (requireActiveUser REQ-AUTH-021 -> active tier passes and pending is 403 PENDING in onboarding mode with SaaS inactive) -->

**Constraints:**

- Enterprise SSO controls are contact-form deep links, not identity providers.
- The GitHub OAuth App callback URL must match the deployment domain.
- Email delivery is best-effort via `sendEmail`.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode), [REQ-AUTH-020](#req-auth-020-onboarding-mode-landing-integrated-login-shell)

**Verification:** [Login page render tests](../../landing/src/__tests__/login-page.test.ts), [login script tests](../../landing/src/__tests__/login.script.test.ts), [Onboarding login route tests](../../src/__tests__/routes/onboarding-login.test.ts), [auth gap tests](../../src/__tests__/lib/auth-gaps.test.ts), [auth middleware tests](../../src/__tests__/middleware/auth-saas.test.ts), [onboarding helper tests](../../src/__tests__/lib/onboarding.test.ts)

**Status:** Implemented
