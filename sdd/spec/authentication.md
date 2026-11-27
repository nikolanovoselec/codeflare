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

1. When GitHub OAuth is not configured, authentication is handled by Cloudflare Access; the Worker verifies CF Access JWTs against the deployment's CF Access JWKS endpoint. <!-- @test: src/__tests__/lib/access-cookie-jwt.test.ts (REQ-AUTH-001 AC1: $mode without OAuth configuration resolves the Access identity) --> <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)) -->
2. When the deployment is configured as SaaS with GitHub OAuth, the Worker manages the entire OAuth flow and issues its own session cookies signed against an operator-provided JWT secret. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @impl: src/routes/github-auth.ts::app --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-001: SaaS mode mutual exclusivity) -->
3. The two modes are mutually exclusive at runtime: when the Direct GitHub OAuth branch is entered, CF Access is never checked. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-001: SaaS mode mutual exclusivity) -->

**Constraints:**

- Once GitHub OAuth is configured, missing required credentials cause a fail-loud authentication error; authentication failure never falls back to CF Access.
- CF Access identity headers are not trusted by the configured GitHub OAuth branch; unconfigured deployments retain [AD38](../../documentation/decisions/README.md#ad38-github-oidc-replaces-cf-access-in-saas-mode)'s Access selection.
- Mode-specific logout uses [REQ-AUTH-009](#req-auth-009-logout-dispatches-by-mode) AC1/AC4.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [auth-gaps.test.ts](../../src/__tests__/lib/auth-gaps.test.ts), [jwt.test.ts](../../src/__tests__/lib/jwt.test.ts), [access-cookie-jwt.test.ts](../../src/__tests__/lib/access-cookie-jwt.test.ts)

**Status:** Implemented

---

### REQ-AUTH-002: SaaS mode uses Direct GitHub OAuth

**Intent:** When the deployment is configured as SaaS with GitHub OAuth, Codeflare presents a branded login page and handles the OAuth flow directly, with no Cloudflare Access involvement.

**Applies To:** User

**Acceptance Criteria:**

1. In SaaS mode the SPA app/login entry presents the provider chooser with a `Continue with GitHub` control. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (should render provider buttons after loading) -->
2. The login endpoint initiates a GitHub OAuth flow with a signed, self-contained state token (no cookie required during the redirect). <!-- @test: src/__tests__/routes/github-auth.test.ts (REQ-AUTH-002 AC2: login state verifies against the configured HMAC key without a state cookie) --> <!-- @impl: src/lib/oauth-state.ts::signOauthState --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 (SaaS mode GitHub OAuth handshake)) -->
3. The OAuth callback validates the state token, rejecting tokens not issued by this server, issued more than 30 minutes ago, or already redeemed. <!-- @test: src/__tests__/routes/github-auth.test.ts (REQ-AUTH-002 AC3: rejects a genuinely signed state older than 30 minutes without issuing a session or consuming the nonce) --> <!-- @impl: src/lib/oauth-state.ts::verifyOauthState --> <!-- @impl: src/lib/oauth-state.ts::claimOauthNonce --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 (SaaS mode GitHub OAuth handshake)) -->
4. Valid callbacks create a session and redirect active users to workspaces or pending/blocked users to subscriptions; the exchanged GitHub access token exists only during callback and is never persisted. <!-- @test: src/__tests__/routes/github-auth.test.ts (REQ-AUTH-002 AC4: $tier callback issues a real session and redirects to $destination without persisting or exposing the GitHub token) --> <!-- @impl: src/routes/github-auth.ts::app --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 (SaaS mode GitHub OAuth handshake)) -->
5. State-validation failure redirects to the login page with an error indicator. <!-- @impl: src/lib/oauth-state.ts::verifyOauthState --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GitHub OAuth Routes / REQ-AUTH-002 (SaaS mode GitHub OAuth handshake)) -->
6. Only verified primary GitHub emails are accepted. <!-- @test: src/__tests__/routes/github-auth.test.ts (redirects to /?error=no-verified-email when no verified email) --> <!-- @manual -->

**Notes:** Callback routing and state replay limits are documented in [Direct GitHub OAuth Flow](../../documentation/lanes/authentication.md#direct-github-oauth-flow).

**Constraints:**

- User-initiated OAuth rejections (e.g. access denied) are handled gracefully; unexpected errors surface as system errors.
- No CF Access resources (apps, groups, policies) are created when SaaS OAuth is active.
- The callback endpoint is rate-limited per source IP; the window and threshold are operational tuning parameters.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** Automated: [github-auth.test.ts](../../src/__tests__/routes/github-auth.test.ts), [LoginPage.test.tsx](../../web-ui/src/__tests__/components/LoginPage.test.tsx); Manual: [Verified primary email acceptance](../../documentation/lanes/authentication.md#verified-primary-email-acceptance)

**Status:** Implemented

---

### REQ-AUTH-003: CF Access mode for all other deployments

**Intent:** When the deployment is not configured for SaaS, Cloudflare Access provides the authentication layer, supporting multiple identity providers managed through the CF Access dashboard.

**Applies To:** User

**Acceptance Criteria:**

1. Accessing protected application pages or API endpoints triggers a CF Access redirect to the configured identity provider. <!-- @impl: src/middleware/auth.ts::requireIdentity --> <!-- @manual -->
2. After IdP authentication, CF Access issues a session credential that the Worker validates on every request. <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-AUTH-003 AC2: protected HTTP requests revalidate a repeated Access credential and refuse invalid or expired credentials) --> <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)) -->
3. The Worker verifies the credential signature against the CF Access JWKS endpoint. <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)) -->
4. User email is extracted from the credential claims, normalized, and resolved from persistent storage. <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest() / REQ-AUTH-006 AC1/AC2 (trim+lowercase email before KV lookup, role resolution, bucket derivation)) --> <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @impl: src/lib/access.ts::normalizeEmail --> <!-- @impl: src/lib/access.ts::resolveUserFromKV --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)) -->

**Constraints:**

- Completed JWKS snapshots are cached per Worker isolate for one hour, bound to their authentication domain.
- Explicit invalidation clears cached JWKS snapshots.
- A key-ID miss may refresh keys older than 30 seconds.
- Cache misses own their network requests rather than sharing request-bound promises.
- An unfinished or failed request cannot stall another verifier.
- Earlier completions cannot overwrite a newer or reset snapshot. <!-- @impl: src/lib/jwt.ts::getPublicKeys --> <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-AUTH-003: request-owned JWKS reads and completed snapshots) -->
- Access application and role provisioning belongs to [REQ-SETUP-012](setup.md#req-setup-012-setup-wizard-step-sequence) AC6.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** Automated: [jwt.test.ts](../../src/__tests__/lib/jwt.test.ts), [access.test.ts](../../src/__tests__/lib/access.test.ts); Manual: [Access redirect acceptance](../../documentation/lanes/authentication.md#access-redirect-acceptance)

**Status:** Implemented

---

### REQ-AUTH-004: Service token authentication for service automation

**Intent:** Automated clients (stress suites and service automation) can authenticate without a browser-based OAuth flow by presenting a service token header.

**Applies To:** User

**Acceptance Criteria:**

1. The service-token header is checked first, before any other authentication method, regardless of deployment mode. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004: Service token authentication (X-Service-Auth)) -->
2. The header value is compared against the configured service-auth secret using constant-time comparison. <!-- @impl: src/lib/access.ts::validateServiceAuthHeader --> <!-- @test: src/__tests__/lib/service-token-auth.test.ts (Service Token Authentication / REQ-AUTH-004 AC1/AC2/AC3/AC5 (X-Service-Auth header checked first, constant-time compare, admin role, disabled when secret unset)) -->
3. Successful service-token auth returns an active-tier admin user with a preconfigured test identity. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-004 AC3: successful X-Service-Auth returns admin role and SERVICE_TOKEN_EMAIL) --> <!-- @test: src/__tests__/middleware/service-token-active-user.test.ts (REQ-AUTH-004: service automation reaches active-user APIs) -->
4. When no service-token secret is configured, service auth is disabled (no fallback). <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/service-token-auth.test.ts (Service Token Authentication / REQ-AUTH-004 AC1/AC2/AC3/AC5 (X-Service-Auth header checked first, constant-time compare, admin role, disabled when secret unset)) -->

**Constraints:**

- Service token auth is the highest priority in the resolution order (checked before cookies or JWTs).
- Compare the service-auth secret in constant time.
- The secret source varies by deployment mode but is unified under a single shared secret name at runtime. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (REQ-AUTH-004 AC4: service-auth secret unified under one runtime name across modes) -->

**Priority:** P0

**Dependencies:** [REQ-AUTH-011](#req-auth-011-auth-resolution-order)

**Verification:** Automated: [access.test.ts](../../src/__tests__/lib/access.test.ts), [auth-gaps.test.ts](../../src/__tests__/lib/auth-gaps.test.ts), [service-token-auth.test.ts](../../src/__tests__/lib/service-token-auth.test.ts), [service-token-active-user.test.ts](../../src/__tests__/middleware/service-token-active-user.test.ts)

**Status:** Implemented

---

### REQ-AUTH-005: Three-tier authorization middleware

**Intent:** Protected routes use a layered middleware stack that enforces identity verification, active subscription status, and admin role checks independently.

**Applies To:** User

**Acceptance Criteria:**

1. The identity middleware resolves the authenticated user from the active auth mechanism and auto-provisions first-time SaaS users with a pending subscription tier. <!-- @impl: src/middleware/auth.ts::requireIdentity --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (Three-tier auth middleware (SaaS mode) / REQ-AUTH-005 (requireIdentity + requireActiveUser + requireAdmin layered stack)) -->
2. The active-user middleware additionally verifies the user holds an active subscription tier; pending users are rejected with code PENDING, blocked users with code BLOCKED; tier checking is skipped outside the app-owned OIDC modes (SaaS and onboarding) for backward compatibility. <!-- @impl: src/middleware/auth.ts::requireActiveUser --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (Three-tier auth middleware (SaaS mode) / REQ-AUTH-005 (requireIdentity + requireActiveUser + requireAdmin layered stack)) -->
3. The admin middleware restricts access to users with the admin role and must be composed after one of the user-identity middlewares. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (Three-tier auth middleware (SaaS mode) / REQ-AUTH-005 (requireIdentity + requireActiveUser + requireAdmin layered stack)) -->

**Constraints:**

- Outside the app-owned OIDC modes (SaaS and onboarding), the active-user check does not enforce tier.
- Users with no tier field are treated as active.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** Automated: [auth-saas.test.ts](../../src/__tests__/middleware/auth-saas.test.ts)

**Status:** Implemented

---

### REQ-AUTH-006: User email normalized

**Intent:** User email addresses are normalized before any lookup, comparison, or storage operation to prevent case-sensitive duplicates and whitespace-related mismatches.

**Applies To:** User

**Acceptance Criteria:**

1. All email addresses are trimmed (leading/trailing whitespace removed) and lowercased before use. <!-- @impl: src/lib/access.ts::resolveUserFromKV --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest() / REQ-AUTH-006 AC1/AC2 (trim+lowercase email before KV lookup, role resolution, bucket derivation)) -->
2. Normalization is applied before KV lookup, role resolution, bucket name derivation, and CF Access group membership operations. <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-AUTH-006 AC2 / REQ-ENTERPRISE-010 AC1/AC4: $label Access login normalizes identity before group-gated JIT persistence) --> <!-- @impl: src/lib/access.ts::resolveUserFromKV --> <!-- @test: src/__tests__/lib/access.test.ts (authenticateRequest() / REQ-AUTH-006 AC1/AC2 (trim+lowercase email before KV lookup, role resolution, bucket derivation)) -->
3. User storage resources resolve through a strongly consistent ownership claim: unambiguous legacy names are retained, later collisions receive a deterministic digest-suffixed name, and ambiguous legacy collisions are denied. <!-- @impl: src/lib/access.ts::resolveBucketName --> <!-- @test: src/__tests__/lib/access.test.ts (resolveBucketName / REQ-AUTH-006 tenant isolation) -->

**Constraints:**

- Normalization is applied consistently wherever email addresses are processed.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [access.test.ts](../../src/__tests__/lib/access.test.ts), [jwt.test.ts](../../src/__tests__/lib/jwt.test.ts)

**Status:** Implemented

---

### REQ-AUTH-007: JIT user provisioning in SaaS mode

**Intent:** In SaaS mode, users who authenticate via GitHub OAuth for the first time are automatically provisioned in KV with a `pending` subscription tier, eliminating manual allowlisting.

**Applies To:** User

**Acceptance Criteria:**

1. A new user record is created with a pending subscription tier only after a cryptographically verified SaaS login; the pre-setup email header alone cannot persist an unknown identity. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @test: src/__tests__/lib/access.test.ts (access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)) -->
2. Pending users can access identity-only endpoints but are blocked from the IDE. <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (REQ-IDE-050 AC7: rejects a Browser IDE request from an inactive SaaS tier) --> <!-- @impl: src/middleware/auth.ts::requireIdentity --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (requireActiveUser / REQ-AUTH-005 AC2 (active-tier check, PENDING/BLOCKED responses, outside-SaaS and authMiddleware backward compatibility)) -->
3. The frontend detects the pending state and redirects the user to the subscription page. <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (REQ-AUTH-007 AC3: pending user redirected to subscribe) --> <!-- @manual -->
4. After subscription (self-service or admin approval), the user record is updated with an active tier. <!-- @impl: src/lib/user-record.ts::updateUserRecord --> <!-- @impl: src/routes/auth.ts::app --> <!-- @impl: src/routes/users.ts::app --> <!-- @impl: src/routes/stripe-webhook.ts::handleCheckoutCompleted --> <!-- @impl: src/lib/stripe.ts::fetchSubscription --> <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/lib/user-record.test.ts (REQ-AUTH-007 AC4: transitions a pending user record to an active tier after subscription) -->
5. First-time active users are redirected to onboarding for guided setup. <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (REQ-AUTH-007 AC5: first-time active user redirected to onboarding) --> <!-- @manual -->

**Constraints:**

- Non-SaaS mode does not perform JIT provisioning; users must be allowlisted via the setup wizard or admin API.
- Blocked users cannot self-upgrade to a free tier.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated: [access.test.ts](../../src/__tests__/lib/access.test.ts), [user-record.test.ts](../../src/__tests__/lib/user-record.test.ts), [auth-saas.test.ts](../../src/__tests__/middleware/auth-saas.test.ts), [vscode-auth-chain.test.ts](../../src/__tests__/routes/vscode-auth-chain.test.ts); Manual: [Provisioning and onboarding acceptance](../../documentation/lanes/authentication.md#provisioning-and-onboarding-acceptance)

**Status:** Implemented

---

### REQ-AUTH-008: Session cookie auto-refresh

**Intent:** Active SaaS and onboarding sessions can renew before expiry, including when the user is working outside the main API surface.

**Applies To:** User

**Acceptance Criteria:**

1. Every ordinary Worker HTTP response is eligible for session renewal, including static assets and proxied Vault and Browser IDE HTTP responses. <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (renews proxied %s HTTP without losing the body or existing cookies) --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (makes a fingerprinted %s asset private only when issuing renewal) --> <!-- @manual -->
2. A valid session with less than 15 minutes remaining receives a credential for the same identity with a new one-hour lifetime. <!-- @impl: src/index.ts::renewSessionCookie --> <!-- @impl: src/lib/session-jwt.ts::shouldRefreshJWT --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-008: Session cookie auto-refresh) --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (renews proxied %s HTTP without losing the body or existing cookies) -->
3. Renewal preserves the response's status, body and unrelated cookies without introducing a redirect or re-authentication. <!-- @impl: src/index.ts::renewSessionCookie --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (REQ-AUTH-008 AC3: SaaS session refresh is transparent (no redirect / no re-auth)) --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (renews proxied %s HTTP without losing the body or existing cookies) --> <!-- @manual -->
4. Only the valid app-owned session cookie in configured non-Enterprise SaaS or onboarding mode can renew. <!-- @impl: src/index.ts::renewSessionCookie --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (does not renew with %s) -->
5. A response that already issues or clears the session cookie retains that cookie instead of renewing the incoming session. <!-- @impl: src/index.ts::renewSessionCookie --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (keeps the logout redirect and clearing cookie instead of renewing the incoming session) -->
6. Responses carrying a renewed credential are not cacheable; renewal does not change cache behavior for other responses. <!-- @impl: src/index.ts::renewSessionCookie --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (makes a fingerprinted %s asset private only when issuing renewal) --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (renews proxied %s HTTP without losing the body or existing cookies) -->
7. WebSocket upgrades pass through unchanged without issuing a renewal cookie. <!-- @impl: src/index.ts::renewSessionCookie --> <!-- @test: src/__tests__/session-refresh-transparent.test.ts (returns the original terminal upgrade with its attached socket and no renewal) -->

**Constraints:** Cloudflare Access manages its own sessions; the Worker does not renew them.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth)

**Verification:** Automated: [auth-gaps.test.ts](../../src/__tests__/lib/auth-gaps.test.ts), [session-refresh-transparent.test.ts](../../src/__tests__/session-refresh-transparent.test.ts); Manual: [Session refresh acceptance](../../documentation/lanes/authentication.md#session-refresh-acceptance)

**Status:** Implemented

---

### REQ-AUTH-009: Logout dispatches by mode

**Intent:** Logout correctly terminates the session regardless of the active authentication mode, with a single frontend endpoint that dispatches to the appropriate backend flow.

**Applies To:** User

**Acceptance Criteria:**

1. The frontend triggers logout via a single endpoint, irrespective of deployment mode. <!-- @test: src/__tests__/routes/auth-redirects.test.ts (onboarding mode with OAuth configured redirects to the GitHub logout route, not CF Access) --> <!-- @manual -->
2. GitHub-OIDC logout clears the app session and returns to login without using the Cloudflare Access logout endpoint. <!-- @impl: src/routes/auth-redirects.ts::app --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (onboarding mode with OAuth configured redirects to the GitHub logout route, not CF Access) --> <!-- @test: src/__tests__/routes/github-auth.test.ts (GET /logout) -->
3. In CF Access mode, the backend redirects through CF Access's system logout endpoint so CF Access clears its own credential. <!-- @impl: src/routes/auth-redirects.ts::app --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (redirects to CF Access logout URL when auth_domain is set) --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (encodes returnTo parameter correctly with custom_domain) -->
4. The dispatch decision is made by the backend based on the current deployment configuration, not by the frontend. <!-- @test: src/__tests__/routes/auth-redirects.test.ts (onboarding mode with OAuth configured redirects to the GitHub logout route, not CF Access) --> <!-- @test: src/__tests__/routes/auth-redirects.test.ts (GET /logout / REQ-AUTH-009 (logout dispatches by mode)) --> <!-- @manual -->

**Constraints:**

- Logout redirect responses carry the full security header set.
- Operator catalog denial recovery navigates natively to `/auth/logout`; SPA navigation to `/` cannot substitute for session renewal. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-AUTH-009/REQ-OPERATOR-049: denied catalog %i offers native session renewal without operator details) -->
- After logout, the user always lands on the appropriate login page for the deployment mode.
- Any mode issuing a `codeflare_session` must use the GitHub logout path rather than Cloudflare Access logout.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes)

**Verification:** Automated: [auth-redirects.test.ts](../../src/__tests__/routes/auth-redirects.test.ts), [github-auth.test.ts](../../src/__tests__/routes/github-auth.test.ts); Manual: [Logout mode acceptance](../../documentation/lanes/authentication.md#logout-mode-acceptance)

**Status:** Implemented

---

### REQ-AUTH-010: Auth bypass prevention

**Intent:** A transient KV failure must not permanently degrade a configured deployment to the pre-setup header-trust model, which would allow unauthenticated access.

**Applies To:** User

**Acceptance Criteria:**

1. Once a successful persistent-storage fetch contains a nonempty auth domain and at least one configured audience, the isolate latches that configured state for its lifetime. A successful empty fetch leaves pre-setup header fallback available until populated configuration has been fetched. <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 AC1: successful empty reads stay permissive until populated config latches across later loss) --> <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 AC2/AC3: rejects header trust after populated-cache expiry and %s refetch) -->
2. Once that flag is set, the pre-setup header-trust fallback is permanently disabled for the isolate. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 AC2/AC3: rejects header trust after populated-cache expiry and %s refetch) -->
3. Subsequent transient storage failures do not revert the flag. <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/access.test.ts (getUserFromRequest() / REQ-AUTH-010 AC1/AC2/AC3/AC4 (authConfigFetched sentinel disables pre-setup header trust after first KV success) / REQ-AUTH-011 AC1/AC2 (resolution order: service token, cookie, JWT, pre-setup header)) --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010 AC2/AC3: rejects header trust after populated-cache expiry and %s refetch) -->
4. The cached state can be explicitly invalidated for test purposes. <!-- @impl: src/lib/access.ts::resetAuthConfigCache --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-010: Auth bypass prevention sentinel) -->

**Constraints:**

- This is a per-isolate flag; new isolates must successfully fetch a nonempty auth domain and at least one configured audience before the pre-setup fallback is disabled.
- Concurrent auth-config cache misses use independent request-owned reads and only cache complete snapshots; no request awaits another request's storage promise.

**Priority:** P0

**Dependencies:** [REQ-AUTH-003](#req-auth-003-cf-access-mode-for-all-other-deployments)

**Verification:** Automated: [access.test.ts](../../src/__tests__/lib/access.test.ts), [auth-gaps.test.ts](../../src/__tests__/lib/auth-gaps.test.ts)

**Status:** Implemented

---

### REQ-AUTH-011: Auth resolution order

**Intent:** Authentication methods are checked in a strict priority order to prevent ambiguity and ensure the most specific credential takes precedence.

**Applies To:** User

**Acceptance Criteria:**

1. Authentication checks the configured service secret first, then the session credential in configured SaaS or onboarding OAuth, then the CF Access JWT, then the eligible pre-setup email-header fallback. The separate CF Access client-ID policy is [REQ-SEC-014](security.md#req-sec-014-saas-service-token-header-not-trusted-in-saas-mode). <!-- @test: src/__tests__/lib/access-cookie-jwt.test.ts (REQ-AUTH-011 AC1/AC2/AC3: %s resolves competing credentials without falling through failed branches) --> <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @impl: src/lib/access.ts::validateSessionOidc --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011: Auth resolution order) -->
2. Once a method succeeds, subsequent methods are not checked. <!-- @test: src/__tests__/lib/access-cookie-jwt.test.ts (REQ-AUTH-011 AC1/AC2/AC3: %s resolves competing credentials without falling through failed branches) --> <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011: Auth resolution order) -->
3. Once a method's branch is entered, it does not fall through to the next method on failure. <!-- @test: src/__tests__/lib/access-cookie-jwt.test.ts (REQ-AUTH-011 AC1/AC2/AC3: %s resolves competing credentials without falling through failed branches) --> <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-011: Auth resolution order) -->

**Constraints:**

- Pre-setup fallback is permanently disabled once auth configuration has been successfully loaded ([REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)).
- The resolution order is the same for all routes; individual routes choose which middleware layer (identity, active user, admin) they require.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-two-authentication-modes), [REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)

**Verification:** Automated: [auth-gaps.test.ts](../../src/__tests__/lib/auth-gaps.test.ts), [access-cookie-jwt.test.ts](../../src/__tests__/lib/access-cookie-jwt.test.ts)

**Status:** Implemented

---

### REQ-AUTH-012: Welcome email on first login

**Intent:** New users in SaaS mode receive a welcome email on first login, providing a professional onboarding touchpoint and confirming their account was created.

**Applies To:** User

**Acceptance Criteria:**

1. First-login provisioning submits a welcome email within the newly provisioned user's existing ownership boundary. <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/lib/access.test.ts (resolveOrProvisionUser — strongly consistent welcome email claim / REQ-AUTH-012) -->
2. Login awaits Timekeeper's welcome submission result. A rejected response or thrown submission is logged without failing login. <!-- @test: src/__tests__/lib/access.test.ts (REQ-AUTH-012 AC2: a thrown welcome submission preserves the provisioned user and permits later login) --> <!-- @impl: src/lib/access.ts::queueWelcomeEmail --> <!-- @test: src/__tests__/lib/access.test.ts (resolveOrProvisionUser — strongly consistent welcome email claim / REQ-AUTH-012) -->
3. Welcome delivery claims serialize per user; durable provider acceptance prevents another send. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/lib/access.test.ts (resolveOrProvisionUser — strongly consistent welcome email claim / REQ-AUTH-012) -->
4. A rejected or unconfigured-provider send remains unclaimed and retryable on a later login, using the same deterministic provider idempotency key. <!-- @test: src/__tests__/lib/access.test.ts (REQ-AUTH-012 AC4: an unconfigured welcome stays unclaimed until a later configured login retries the same key) --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @impl: src/lib/email.ts::sendEmail --> <!-- @test: src/__tests__/lib/access.test.ts (resolveOrProvisionUser — strongly consistent welcome email claim / REQ-AUTH-012) -->

**Constraints:**

- The nonfatal failure path covers submission to Timekeeper, not earlier configuration and owner resolution.
- Email content must not expose internal system details.

**Priority:** P2

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode)

**Verification:** Automated: [Welcome ownership and login](../../src/__tests__/lib/access.test.ts), [email transport](../../src/__tests__/lib/email.test.ts)

**Status:** Implemented

---

### REQ-AUTH-013: Custom branded login page

**Intent:** SaaS mode provides a branded login experience instead of the raw CF Access login page.

**Applies To:** User

**Acceptance Criteria:**

1. The SaaS login page shows Codeflare branding with an animated logo. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 (branded SaaS login page)) -->
2. A "Continue with <provider>" button is displayed for the configured identity provider. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 (branded SaaS login page)) -->
3. Available auth providers are listed. <!-- @impl: web-ui/src/components/LoginPage.tsx::LoginPage --> <!-- @test: web-ui/src/__tests__/components/LoginPage.test.tsx (LoginPage / REQ-AUTH-013 (branded SaaS login page)) -->
4. Core login content is visible at first paint and is not hidden behind entrance opacity or transform animation. <!-- @impl: web-ui/src/styles/login-page.css::.login-content --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P0

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth)

**Verification:** Automated: [LoginPage.test.tsx](../../web-ui/src/__tests__/components/LoginPage.test.tsx); Manual: [Protected login first-paint acceptance](../../documentation/lanes/authentication.md#protected-login-first-paint-acceptance)

**Status:** Implemented

---

### REQ-AUTH-014: Auth expiry detection mid-session

**Intent:** When authentication expires during active use, the app starts top-level sign-in automatically instead of silently failing or waiting for a manual refresh.

**Applies To:** User

**Acceptance Criteria:**

1. An API 401 or Access redirect on an authenticated path starts top-level sign-in without leaving the expired app reachable through browser history; a re-auth banner may render only while navigation is pending. <!-- @impl: web-ui/src/api/fetch-helper.ts::redirectExpiredSession --> <!-- @test: web-ui/src/__tests__/api/fetch-helper-401-redirect.test.ts (REQ-AUTH-022 AC1: 401 on an authed page redirects + throws (never hangs)) -->
2. Authentication expiry detected during bootstrap or resume starts the same sign-in recovery even when the error lacks redirect metadata. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC2: expired-session 401 shows the redirecting state, not a hung/blank or error page) -->
3. Session polling stops on expiry to prevent noise while the top-level navigation proceeds. <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (should stop session list polling after auth expiry) -->

**Constraints:**

- Top-level sign-in uses history-replacing navigation; Back must not reopen the expired app.

**Priority:** P1

**Dependencies:** [REQ-AUTH-008](#req-auth-008-session-cookie-auto-refresh)

**Verification:** Automated: [fetch-helper-401-redirect.test.ts](../../web-ui/src/__tests__/api/fetch-helper-401-redirect.test.ts), [auth-022-resume-redirect.test.tsx](../../web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-AUTH-015: Guided onboarding flow

**Intent:** First-time users are walked through connecting their accounts step by step.

**Applies To:** User

**Acceptance Criteria:**

1. Onboarding has four steps: idle timeout, **Connect GitHub**, **Connect Cloudflare**, and [agent subscription](#req-auth-025-guided-setup-agent-subscription-cards). Both connection steps share OAuth cards under [REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise) and [REQ-AGENT-064](agents.md#req-agent-064-connect-to-cloudflare-via-oauth), without manual token paste. <!-- @impl: web-ui/src/components/OnboardingPage.tsx::OnboardingPage --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (OnboardingPage / REQ-AUTH-015 (onboarding-mode public landing page)) -->
2. Guided Setup explains compute usage and lets users choose 1h, 2h, 4h, 8h, or 12h. It defaults to 1h when unset and displays a saved legacy duration without offering it as a new selection. <!-- @impl: web-ui/src/components/OnboardingPage.tsx::OnboardingPage --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (REQ-AUTH-015 AC2: offers the shared idle presets and saves a new selection) --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (REQ-AUTH-015 AC2: Guided Setup shows a saved legacy timeout without offering it for selection) -->
3. The app redirects a first-time active user in non-Enterprise SaaS to Guided Setup. Pending users go to subscription first. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (REQ-AUTH-007 AC5: first-time active user redirected to onboarding) --> <!-- @manual -->
4. The app skips the automatic Guided Setup redirect once the account response confirms persisted onboarding completion. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (REQ-AUTH-007 AC5: first-time active user redirected to onboarding) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode), [REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings), [REQ-AGENT-064](agents.md#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** Automated: [OnboardingPage.test.tsx](../../web-ui/src/__tests__/components/OnboardingPage.test.tsx); Manual: [Provisioning and onboarding acceptance](../../documentation/lanes/authentication.md#provisioning-and-onboarding-acceptance)

**Status:** Implemented

---

### REQ-AUTH-025: Guided Setup agent subscription cards

**Intent:** First-time users see which installable agents accept their provider subscriptions.

**Applies To:** User

**Acceptance Criteria:**

1. The agent-subscription step mirrors the six installable agents: Claude Code, Codex, Antigravity, GitHub Copilot, OpenCode, and Pi. <!-- @impl: web-ui/src/components/OnboardingPage.tsx::CODING_AGENTS --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (renders the six installable coding agents and replaces Gemini with Antigravity) -->
2. Every agent card identifies the provider families whose subscriptions the agent can use. <!-- @impl: web-ui/src/components/OnboardingPage.tsx::CODING_AGENTS --> <!-- @test: web-ui/src/__tests__/components/OnboardingPage.test.tsx (shows provider-family subscription support on every coding agent card) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AUTH-015](#req-auth-015-guided-onboarding-flow)

**Verification:** Automated: [OnboardingPage.test.tsx](../../web-ui/src/__tests__/components/OnboardingPage.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-016: Header user dropdown

**Intent:** Quick access to deployment-mode-appropriate account actions from any page without exposing inert or unsupported billing surfaces.

**Applies To:** User

**Acceptance Criteria:**

1. The icon-only Profile control opens the account-action dropdown described in [REQ-AGENT-278](agents.md#req-agent-278-narrow-workspace-header-fallback). <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (shows the Profile email only at the top of the open workspace menu) -->
2. The available account actions follow the deployment-mode contract in [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions). <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Subscription/Usage gating) --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (opens a Usage-only dropdown in enterprise mode) -->
3. Mobile renders as bottom sheet. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @manual -->
4. At widths above 640 CSS px, Profile opens 8px below the control when one 44px action and any email label fit above the 8px viewport-bottom margin; otherwise it opens as a bottom sheet. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/lib/header-fit.ts::measureProfileMenu = max-width: 640px --> <!-- @impl: web-ui/src/lib/header-fit.ts::measureProfileMenu = rect.bottom + 8 --> <!-- @impl: web-ui/src/lib/header-fit.ts::measureProfileMenu --> <!-- @impl: web-ui/src/lib/header-fit.ts::HEADER_ICON_SLOT = 44 --> <!-- @test: web-ui/src/__tests__/lib/header-fit.test.ts (chooses Profile placement at viewport %s × %s) --> <!-- @manual: documentation/lanes/terminal-and-ide.md#workspace-header-acceptance -->
5. In Dashboard and workspace headers, a Profile menu that exceeds the available viewport height scrolls internally so every action remains reachable. <!-- @impl: web-ui/src/styles/header.css::.header-user-dropdown--profile --> <!-- @manual: documentation/lanes/terminal-and-ide.md#workspace-header-acceptance -->

6. Selecting Usage from Dashboard Profile dismisses the menu so it cannot obstruct Usage. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (returns from %s Profile Usage to the same Chat without another writer request) -->
7. The open Profile menu displays the account email on a black label above the actions without increasing the action panel’s width. An address exceeding 90% of the viewport width ends in an ellipsis, with the complete address still available to assistive technology. <!-- @impl: web-ui/src/styles/header.css::.header-user-email --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (shows the Profile email only at the top of the open workspace menu) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (shows the Profile email only at the top of the open Dashboard menu in %s) --> <!-- @manual: documentation/lanes/terminal-and-ide.md#workspace-header-acceptance -->

**Constraints:**

- Deployment mode controls only the action set; the dropdown interaction and responsive presentation remain shared.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated: [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx); Manual: [Account dropdown layout acceptance](../../documentation/lanes/authentication.md#account-dropdown-layout-acceptance), [short-viewport Profile acceptance](../../documentation/lanes/terminal-and-ide.md#workspace-header-acceptance)

**Status:** Implemented

---

### REQ-AUTH-027: Mobile Profile email typography

**Intent:** Make the account email as legible as the mobile Profile actions.

**Applies To:** User

**Acceptance Criteria:**

1. On mobile, the Profile email badge uses the same text size as the account action labels. <!-- @impl: web-ui/src/styles/header.css::.header-user-email --> <!-- @manual: documentation/lanes/terminal-and-ide.md#workspace-header-acceptance -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-AUTH-016](#req-auth-016-header-user-dropdown)

**Verification:** Manual: [Workspace header acceptance](../../documentation/lanes/terminal-and-ide.md#workspace-header-acceptance)

**Status:** Implemented

---

### REQ-AUTH-017: Gravatar integration

**Intent:** Visual user identification via avatar.

**Applies To:** User

**Acceptance Criteria:**

1. The header displays the current user's Gravatar. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-AUTH-017 AC1: renders the Gravatar belonging to the displayed user) -->
2. Falls back to the account-shield icon when no Gravatar exists. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @manual: Use an address with no Gravatar and confirm both Header and Dashboard render the account-shield fallback. -->
3. The hashed normalized email is used for the Gravatar lookup. <!-- @impl: web-ui/src/lib/gravatar.ts::getGravatarUrl --> <!-- @test: web-ui/src/__tests__/lib/gravatar.test.ts (getGravatarUrl / REQ-AUTH-017 AC3 (MD5 of email used for Gravatar lookup)) -->
4. The dashboard displays the current user's Gravatar. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-AUTH-017 AC1: renders the Gravatar belonging to the dashboard user) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated: [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx), [gravatar.test.ts](../../web-ui/src/__tests__/lib/gravatar.test.ts), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx); Manual: [Gravatar fallback acceptance](../../documentation/lanes/authentication.md#gravatar-fallback-acceptance)

**Status:** Implemented

---

<a id="req-auth-018-admin-user-management"></a>
### REQ-AUTH-018: User management admin panel

**Intent:** Admins can approve access and configure tiers without CLI tools. Approval changes a user's tier; onboarding bulk approval grants the same full-access tier as its per-user approval control.

**Applies To:** Admin

**Acceptance Criteria:**

1. An admin can approve pending users. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Approve a pending user from the admin page and confirm the displayed state updates. -->
2. An admin can change tiers. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Change a tier from the admin page and confirm the displayed state updates. -->
3. In onboarding mode the bulk action approves the displayed pending users to the same full-access tier as the per-user Approve control; the current email search limits that set. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Compare SaaS and onboarding deployments and confirm their user controls and bulk-approval outcomes match the criterion. -->

**Notes:** Admin tier and approval verification is documented in [Admin user panel acceptance](../../documentation/lanes/authentication.md#admin-user-panel-acceptance).

**Constraints:**

- Tier mutation approves access only in app-owned OIDC modes gated by `isSessionOidcMode`.
- Enterprise mode returns 403 through [REQ-ENTERPRISE-009](security.md#req-enterprise-009-enterprise-backend-route-hardening); default CF Access mode has no tier-gated access and returns 400.

**Priority:** P1

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** Manual: [Admin user panel acceptance](../../documentation/lanes/authentication.md#admin-user-panel-acceptance)

**Status:** Implemented

---

### REQ-AUTH-026: Admin user offboarding

**Intent:** Administrators can request deletion without CLI tools, with ordered cleanup that preserves the authority needed for an authorized retry.

**Applies To:** Admin

**Acceptance Criteria:**

1. An admin can request user deletion. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Request deletion of an explicitly authorized disposable user from the admin page and confirm a successful result updates the displayed state. -->
2. Deleting a user removes all owned settings, sessions, notification enrollments, R2 data, and scoped tokens. Confirm container cleanup, then provider revocation while user data and scoped access remain; only afterward revoke scoped tokens and remove storage/local state, with the user record last. <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-026 AC2: erases every owned local resource before the user record and preserves neighboring data) --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-018 AC3 / REQ-SEC-003 AC6: provider %s preserves storage authority until revocation and retry converges) --> <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @impl: src/lib/user-cleanup.ts::deleteUserKvEntries --> <!-- @test: src/__tests__/routes/users.test.ts (Users Routes / REQ-AUTH-018 (user management admin panel)) --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-018 AC3: follows paginated push-subscription cursors until complete) -->
3. User offboarding uses strict GitHub App/OAuth revocation: failure retains outstanding provider credentials, storage and scoped access for authorized retry. Ordinary disconnect and manual PAT behavior remain unchanged. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-018 AC3 / REQ-SEC-003 AC6: provider %s preserves storage authority until revocation and retry converges) -->

4. Before destructive cleanup, the owner invalidates MCP grants and pending authorizations. Old callbacks and refreshes cannot publish across that boundary. Failed cleanup keeps admission closed; success permits new explicit authorization, never legacy reimport. <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2: failed %s cleanup and reconstruction remain closed until an authorized retry succeeds) --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/4: permanently stale legacy reads cannot resurrect credentials after owner recreation) --> <!-- @impl: src/container/index.ts::cleanupOwnedUser --> <!-- @impl: src/lib/mcp-portal-state.ts::beginOffboarding --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2/5: offboarding between the final %s observation and commit cannot be overwritten) -->

**Constraints:**

- [REQ-GITHUB-005](github.md#req-github-005-disconnect-and-offboarding-revocation) owns ordinary disconnect and manual PAT handling.
- Live cleanup is owner-serialized; started deletions settle before exclusion is released. Failure does not reopen MCP admission. Retrying deletion remains explicitly authorized, not automatically replayed from an unfinished fence. <!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-AUTH-026 AC2: rejected parallel KV deletion retains live cleanup exclusion until all started deletes settle) -->
- Deletion remains by email, not by account incarnation or public idempotency key; a new authorized deletion can target a recreated account.
- Legacy connection-key deletion is not immediate KV replica erasure. Unfenced legacy pending OAuth records are rejected and retain their existing expiry.

**Priority:** P1

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated: [user-cleanup.test.ts](../../src/__tests__/lib/user-cleanup.test.ts), [users.test.ts](../../src/__tests__/routes/users.test.ts); Manual: [Admin user panel acceptance](../../documentation/lanes/authentication.md#admin-user-panel-acceptance)

**Status:** Implemented

---

<a id="req-auth-023-admin-user-browsing-and-mode-specific-controls"></a>
### REQ-AUTH-023: Admin user browsing and mode-specific controls

**Intent:** Admins can browse users and capacity without CLI tools. The control surface adapts to deployment mode: SaaS exposes the full subscription-tier picker, while onboarding, with no paid tiers, uses a plain Approve / Block decision.

**Applies To:** Admin

**Acceptance Criteria:**

1. Admin user management shows all users grouped by tier. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Open the admin user page with users in multiple tiers and confirm every user appears under the correct tier heading. -->
2. An admin can search displayed users. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Exercise search, approval, tier change, and deletion from the admin user page and confirm each successful action updates the displayed user state. -->
3. The admin page displays the user count against configured capacity. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Open the admin user page with a configured capacity and confirm the current and maximum user counts are displayed. -->
4. In SaaS mode the admin panel renders the full tier + session-mode selectors per user; in onboarding mode it renders a per-user Approve / Block (`blocked` tier) control. <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @manual: Compare SaaS and onboarding deployments and confirm their user controls and bulk-approval outcomes match the criterion. -->

**Constraints:**

- Tier mutation approves access only in app-owned OIDC modes gated by `isSessionOidcMode`.
- Enterprise mode returns 403 through [REQ-ENTERPRISE-009](security.md#req-enterprise-009-enterprise-backend-route-hardening); default CF Access mode has no tier-gated access and returns 400.

**Priority:** P1

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware)

**Verification:** Manual: [Admin user panel acceptance](../../documentation/lanes/authentication.md#admin-user-panel-acceptance)

**Status:** Implemented

---

### REQ-AUTH-019: User identity and account-status API

**Intent:** A signed-in user's client needs one authoritative read of who they are and how their account is configured, plus the small account-status writes the onboarding and storage flows depend on.

**Applies To:** User

**Acceptance Criteria:**

1. The profile handler returns identity, account status, and SaaS billing-effective allowed session modes without itself creating a bucket or token. The preceding authentication path can still provision identity. <!-- @test: src/__tests__/routes/user-profile.test.ts (REQ-AUTH-019 AC1: GET /user leaves %s credentials and bucket state unchanged) --> <!-- @impl: src/routes/user-profile.ts::app --> <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (REQ-SUB-014 / REQ-AUTH-019: projects billing-effective configured modes ($billingStatus, $subscribedMode)) -->
2. Completing onboarding marks the authenticated user's existing record complete and preserves its other fields. If no record exists after authentication, it succeeds without writing one. Later eligible SaaS logins skip Guided Setup. <!-- @impl: src/routes/user-profile.ts::onboarding-complete --> <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: src/__tests__/routes/user-profile.test.ts (marks the stored user record onboarding-complete and preserves existing fields) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (is a no-op when the user has no stored record yet) --> <!-- @manual -->
3. Token-status inspection reports whether a cached scoped R2 credential entry exists for the current user. It does not expose the credential or verify it with the provider. <!-- @impl: src/routes/user-profile.ts::r2-status --> <!-- @test: src/__tests__/routes/user-profile.test.ts (should return { ready: true } when r2token:{email} exists in KV) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (should return { ready: false } when no r2token:{email} in KV) --> <!-- @manual -->
4. Ensuring storage readiness creates the user's scoped R2 token when absent, returning ready on success, 503 when account setup is incomplete and 500 on provisioning failure. <!-- @impl: src/routes/user-profile.ts::ensure-r2-token --> <!-- @test: src/__tests__/routes/user-profile.test.ts (should return { ready: true } when token is created successfully) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (should return 503 when setup is incomplete (no account_id)) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (should return 503 when CLOUDFLARE_API_TOKEN is missing) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (should return 500 with error message when token creation fails) --> <!-- @manual -->
5. Every endpoint requires active-user authentication. Missing identity returns 401 after earlier request guards; a rejected CSRF check on a write returns 403 first. <!-- @test: src/__tests__/routes/user-profile.test.ts (User Profile Routes) --> <!-- @manual -->
6. Requests to ensure a scoped R2 token are rate-limited per user to bound token-provisioning abuse. <!-- @test: src/__tests__/routes/rate-limits.test.ts (POST /user/ensure-r2-token - ensure-r2-token (5/min)) --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AUTH-005](#req-auth-005-three-tier-authorization-middleware), [REQ-AUTH-015](#req-auth-015-guided-onboarding-flow)

**Verification:** Automated: [user-profile.test.ts](../../src/__tests__/routes/user-profile.test.ts); Manual: [Account status API acceptance](../../documentation/lanes/authentication.md#account-status-api-acceptance)

**Status:** Implemented

---

### REQ-AUTH-020: Onboarding-mode landing-integrated login shell

**Intent:** In onboarding mode, the login page is served by the marketing landing system while SaaS keeps the existing SPA login page.

**Applies To:** User

**Acceptance Criteria:**

1. After setup, `/login` and `/login/` in onboarding without SaaS serve the dedicated landing login when the asset is available; missing output falls back to the SPA policy. <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 AC1: $path returns landing when available=$available and otherwise the Assets SPA fallback) --> <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021: onboarding login + access-request) -->
2. The onboarding login shares the landing appearance with preloaded fonts and login navigation. <!-- @impl: landing/src/pages/login.astro::BaseLayout --> <!-- @test: landing/src/__tests__/login-page.test.ts (onboarding login page (REQ-AUTH-020 / REQ-AUTH-021)) -->
3. The onboarding login first paints without initializing the marketing page's WebGL or motion effects. <!-- @impl: landing/src/layouts/BaseLayout.astro::flareFluid --> <!-- @impl: landing/src/layouts/BaseLayout.astro::landingScripts --> <!-- @test: landing/src/__tests__/login-page.test.ts (inherits the shared nav and font preloads while omitting landing-only motion hooks) -->
4. In SaaS mode, the login page is unchanged and continues to serve the existing SPA login. <!-- @impl: src/index.ts::fetch --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021: onboarding login + access-request) -->
5. With JavaScript enabled, the landing-built login holds the dark canvas until its shared stylesheet and critical fonts load. Without JavaScript it shows the server-rendered content. <!-- @impl: landing/src/layouts/BaseLayout.astro::data-design-ready --> <!-- @test: landing/src/__tests__/login-page.test.ts (inherits the shared final-design gate before exposing the login shell) --> <!-- @test: landing/src/__tests__/design-ready.script.test.ts (keeps the document hidden through stylesheet and critical-font loading, then reveals once) -->

**Constraints:**

- Cloudflare Assets must run the Worker before every request (`run_worker_first = true` in `wrangler.toml`) for the `/login` rewrite.

**Priority:** P1

**Dependencies:** [REQ-AUTH-013](#req-auth-013-custom-branded-login-page), [REQ-LANDING-001](landing.md#req-landing-001-public-landing-content-and-interaction), [REQ-LANDING-017](landing.md#req-landing-017-mode-aware-landing-dispatch), [REQ-LANDING-004](landing.md#req-landing-004-first-paint-stability-and-immutable-asset-caching)

**Verification:** Automated: [wrangler-static-assets.test.js](../../host/__tests__/wrangler-static-assets.test.js), [login-page.test.ts](../../landing/src/__tests__/login-page.test.ts), [onboarding-login.test.ts](../../src/__tests__/routes/onboarding-login.test.ts)

**Status:** Implemented

---

### REQ-AUTH-021: Onboarding-mode sign-in choices and access-request flow

**Intent:** Onboarding sign-in offers GitHub plus enterprise-SSO request affordances and records access requests when GitHub OAuth resolves to a non-approved user.

**Applies To:** User

**Acceptance Criteria:**

1. The onboarding login offers a GitHub sign-in. <!-- @impl: landing/src/components/LoginCard.astro::LOGIN.github.href --> <!-- @test: landing/src/__tests__/login-page.test.ts (GitHub is the single primary action and links to the OAuth entry route) -->
2. Users classified as non-approved have requests recorded and redirect to requested state; new records are pending and stored tiers are preserved. Existing records without subscriptionTier are treated as active by the callback; API tier gating remains independent. <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-021 AC2: onboarding preserves $tier and redirects to $destination) --> <!-- @impl: src/routes/github-auth.ts::onboardingAccessRequest --> <!-- @impl: src/lib/user-record.ts::updateUserRecord --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-020 / REQ-AUTH-021: onboarding login + access-request) -->
3. The onboarding access-request branch never runs in SaaS mode or enterprise mode. <!-- @impl: src/routes/github-auth.ts::onboardingAccessRequest --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (SaaS + non-active user → /app/subscribe UNCHANGED, no onboarding emails) --> <!-- @manual: Confirm an existing Enterprise sign-in record bypasses the onboarding request flow. -->
4. Onboarding trusts its app-owned session credential only in session-OIDC mode. <!-- @test: src/__tests__/lib/access-cookie-jwt.test.ts (REQ-AUTH-021 AC4: a valid app cookie cannot authenticate outside session-OIDC mode) --> <!-- @impl: src/lib/access.ts::getUserFromRequest --> <!-- @impl: src/lib/onboarding.ts::isSessionOidcMode --> <!-- @test: src/__tests__/lib/auth-gaps.test.ts (REQ-AUTH-021: valid codeflare_session authenticates in onboarding mode (SAAS inactive)) -->
5. Active-tier middleware applies in onboarding; pending visitors with sessions remain gated out of app APIs. <!-- @impl: src/middleware/auth.ts::requireActiveUser --> <!-- @test: src/__tests__/middleware/auth-saas.test.ts (REQ-AUTH-021: blocks pending users with 403 PENDING in onboarding mode (SAAS inactive)) -->
6. After first recording the request stamp, the callback attempts the administrator notification and user confirmation independently. Either email can fail without blocking the redirect. A request already stamped is not sent again on ordinary retry. <!-- @test: src/__tests__/routes/onboarding-login.test.ts (REQ-AUTH-021 AC6: failed $failed preserves the request, independent email and redirect without retry delivery) --> <!-- @impl: src/routes/github-auth.ts::onboardingAccessRequest --> <!-- @impl: src/lib/email.ts::sendAccessRequestConfirmation --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (onboarding + new non-active user → /login?status=requested, stamps requestedAt, mails admin + user) --> <!-- @test: src/__tests__/routes/onboarding-login.test.ts (onboarding + already-requested user → does NOT re-send and does NOT change requestedAt) -->
7. The onboarding login's enterprise SSO request controls deep-link to the contact form. <!-- @impl: landing/src/components/SsoAccordion.astro::LOGIN.sso.cta.href --> <!-- @impl: landing/src/scripts/contact-controller.ts::pickDeepLinkTopic --> <!-- @test: landing/src/__tests__/login-page.test.ts (every SSO button is a CTA deep-linking to the contact form, never a real auth route) -->

**Constraints:**

- Enterprise SSO controls are contact-form deep links, not identity providers.
- Renewal is limited to eligible session-OIDC responses under [REQ-AUTH-008](#req-auth-008-session-cookie-auto-refresh).
- The GitHub OAuth App callback URL must match the deployment domain.
- Email delivery is best-effort via `sendEmail`.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode), [REQ-AUTH-020](#req-auth-020-onboarding-mode-landing-integrated-login-shell)

**Verification:** Automated: [login-page.test.ts](../../landing/src/__tests__/login-page.test.ts), [login.script.test.ts](../../landing/src/__tests__/login.script.test.ts), [onboarding-login.test.ts](../../src/__tests__/routes/onboarding-login.test.ts), [auth-gaps.test.ts](../../src/__tests__/lib/auth-gaps.test.ts), [auth-saas.test.ts](../../src/__tests__/middleware/auth-saas.test.ts), [onboarding.test.ts](../../src/__tests__/lib/onboarding.test.ts), [access-cookie-jwt.test.ts](../../src/__tests__/lib/access-cookie-jwt.test.ts); Manual: [Enterprise onboarding exclusion](../../documentation/lanes/authentication.md#provisioning-and-onboarding-acceptance)

**Status:** Implemented

---

### REQ-AUTH-022: Session-expiry on resume produces a clean sign-in redirect, never a blank page

**Intent:** When a backgrounded SPA returns (mobile app-switch, tab eviction, bfcache restore) and the session cookie has expired, the app must revalidate promptly and redirect to sign-in cleanly. It must never hang on its loading shell, retain a partially styled document after Access intercepts asset revalidation, render nothing during navigation, or crash to a blank document.

**Applies To:** User

**Acceptance Criteria:**

1. An API 401 on a protected application or administration path hard-navigates to the deployment root and rejects the pending request, so bootstrap settles rather than hanging. <!-- @impl: web-ui/src/api/fetch-helper.ts::baseFetch --> <!-- @impl: web-ui/src/api/fetch-helper.ts::redirectExpiredSession --> <!-- @test: web-ui/src/__tests__/api/fetch-helper-401-redirect.test.ts (REQ-AUTH-022 AC1: 401 on an authed page redirects + throws (never hangs)) -->
2. Bootstrap expiry starts top-level sign-in and replaces the loading shell with a non-empty redirecting state, including when the 401 lacks API-helper metadata. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC2: expired-session 401 shows the redirecting state, not a hung/blank or error page) -->
3. The application root renders a non-empty state for every mode including `redirect`, so a pending hard navigation never shows a blank document. <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC3: $mode root stays nonempty while loading and after mode resolution) --> <!-- @impl: web-ui/src/App.tsx::RootPage --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC3: RootPage renders a non-empty redirect state (no blank document)) -->
4. A top-level error boundary renders a reload control for render failures caught by the boundary. Bootstrap request failures use the separate recovery path in [REQ-AUTH-024](#req-auth-024-bootstrap-service-error-recovery). <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC4: the render-failure Reload control reloads the document and restores the app) --> <!-- @impl: web-ui/src/App.tsx::App --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC4: top-level ErrorBoundary catches a render throw) -->
5. Access 3xx, opaque or status-zero redirects, and HTML login responses on either successful or unsuccessful authenticated API requests settle through the same clean sign-in recovery as an explicit 401. <!-- @impl: web-ui/src/api/fetch-helper.ts::baseFetch --> <!-- @impl: web-ui/src/api/fetch-helper.ts::isHtmlResponse --> <!-- @test: web-ui/src/__tests__/api/fetch-helper-401-redirect.test.ts (REQ-AUTH-022 AC5: Access response shapes navigate the top-level app instead of stranding it ($label)) -->
6. A hidden-to-visible transition or persisted bfcache `pageshow` revalidates the authenticated user once; overlapping resume events are deduplicated, expiry replaces the loaded app with the existing redirecting state, and valid sessions continue unchanged. <!-- @impl: web-ui/src/App.tsx::revalidateAuthAfterResume --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-022 AC6: restored app resume revalidates once and preserves valid sessions) -->
7. The restored application uses the Worker-served fingerprinted-asset caching policy in [REQ-OPS-175](operations.md#req-ops-175-worker-served-build-asset-caching). <!-- @impl: src/index.ts::dispatch --> <!-- @test: src/__tests__/index.test.ts (REQ-AUTH-022 AC7: serves fingerprinted Vite app assets with immutable caching) -->

**Constraints:**

- Redirect uses `location.replace`, not `href`, and leaves no dead page in history.
- API responses declared `text/html` or beginning with an HTML document root are treated as login responses, except HTTP 5xx server errors: HTML server errors retain their original status and surface a safe non-HTML error without an auth-redirect flag or navigation. <!-- @impl: web-ui/src/api/fetch-helper.ts::baseFetch --> <!-- @test: web-ui/src/__tests__/api/fetch-helper-401-redirect.test.ts (REQ-AUTH-022 AC5 / REQ-AUTH-014 AC1: server failures on %s) -->
- Behavior is deployment-mode agnostic (CF Access, SaaS, onboarding); resume revalidation runs only inside the authenticated app shell.
- Resume checks are deduplicated and event listeners are removed with the app lifecycle.
- The redirecting/fallback states are asserted by structure (testids/branch), not by UI copy (mandate #2).

**Priority:** P1

**Dependencies:** [REQ-AUTH-007](#req-auth-007-jit-user-provisioning-in-saas-mode)

**Verification:** Automated: [index.test.ts](../../src/__tests__/index.test.ts), [fetch-helper-401-redirect.test.ts](../../web-ui/src/__tests__/api/fetch-helper-401-redirect.test.ts), [auth-022-resume-redirect.test.tsx](../../web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx)

**Status:** Implemented

---

### REQ-AUTH-024: Bootstrap service-error recovery

**Intent:** Account-loading failures must provide recovery without misreporting a server outage as expired authentication.

**Applies To:** User

**Acceptance Criteria:**

1. In production, bootstrap network and server failures render a recoverable service-error state with Retry, not an expired-session or access-denied state. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (shows a service error and recovers after retry for %s) -->
2. Retry reloads the document and runs account bootstrap again. Successful authentication after recovery restores the application. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (shows a service error and recovers after retry for %s) -->
3. In production, an ordinary forbidden response renders Access denied without mounting the protected application. Pending and blocked entitlement responses route to subscription instead; Access login responses follow the sign-in recovery path. <!-- @test: web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx (redirects a pending SaaS user to /app/subscribe) --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (REQ-AUTH-024 AC3: a blocked %s response navigates to subscription instead of service recovery) --> <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx (keeps a forbidden account separate from a recoverable service failure) -->

**Constraints:**

- Genuine authentication expiry retains the sign-in recovery required by [REQ-AUTH-022](#req-auth-022-session-expiry-on-resume-produces-a-clean-sign-in-redirect-never-a-blank-page).

**Priority:** P1

**Dependencies:** [REQ-AUTH-022](#req-auth-022-session-expiry-on-resume-produces-a-clean-sign-in-redirect-never-a-blank-page)

**Verification:** Automated: [bootstrap and recovery](../../web-ui/src/__tests__/components/auth-022-resume-redirect.test.tsx), [pending entitlement redirect](../../web-ui/src/__tests__/components/auth-007-app-redirect.test.tsx)

**Status:** Implemented

---

## Enterprise account admission and administration

### REQ-ENTERPRISE-010: Access-Gated JIT User Provisioning

**Intent:** In Enterprise Mode users are managed by the customer's Cloudflare Access, not inside Codeflare, so any Access-authenticated user entitled to the deployment must be provisioned automatically on first access — a fresh user lands work-ready with no in-product allowlisting or approval step.

**Applies To:** User

**Acceptance Criteria:**

1. When the Enterprise-mode binding is set and an authenticated request presents a valid Cloudflare Access JWT for an `email` with no existing user record, Codeflare auto-creates a record `{ addedBy: 'enterprise-jit', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' }` keyed by the JWT's IdP-verified `email`. <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-AUTH-006 AC2 / REQ-ENTERPRISE-010 AC1/AC4: $label Access login normalizes identity before group-gated JIT persistence) --> <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
2. Configured Access groups gate provisioning before record creation; users outside every allowed group receive the standard denial. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
3. When the user Access-group setting is unset, a valid Access JWT alone is sufficient to provision; the group gate is delegated to the customer's Access application policy. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
4. Provisioning is idempotent: concurrent first-logins converge on a single record, and an existing record — whether a setup admin or a prior JIT user — is returned unchanged (JIT never overwrites a role or downgrades an admin). <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-AUTH-006 AC2 / REQ-ENTERPRISE-010 AC1/AC4: $label Access login normalizes identity before group-gated JIT persistence) --> <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
5. Enterprise JIT sends no welcome or subscription email; the per-user R2 bucket and scoped token continue to be created lazily on first session start, unchanged. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
6. When the Enterprise-mode binding is unset, an Access-authenticated user with no record still receives 403 with no auto-provisioning, and the authentication path is byte-identical to current behavior. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->

**Constraints:**

- Codeflare trusts a valid Access JWT as proof that the customer's Access policy authorized the user; it does not re-implement IdP authentication.
- `ENTERPRISE_ACCESS_GROUP` is configured during the setup wizard and stored in KV alongside the existing Setup Access configuration; an admin changes it by rerunning Setup.
- The legacy Access verifier returns the IdP-verified `email` as the persisted JIT account key and never returns or persists JWT `sub`.
- An email change at the IdP yields a new account.
- The JIT entry gate checks group membership only while provisioning; existing records skip that check. Separately owned admin and session authorization may perform live identity checks.
- This REQ uses only the deployment's existing Cloudflare Access auth mode; it adds no new identity-provider integration (consistent with this domain's Out of Scope).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](setup.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** Automated: [enterprise-jit-provisioning.test.ts](../../src/__tests__/lib/enterprise-jit-provisioning.test.ts), [jwt.test.ts](../../src/__tests__/lib/jwt.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-014: Admin access via Cloudflare Access groups

**Intent:** An enterprise admin can grant admin (= Setup / user-administration) access to members of one or more named Cloudflare Access groups, parallel to the email-based admin list, so admin rights track the customer's directory instead of a hand-maintained email list. Admin groups govern administration only — they never participate in per-group model routing.

**Applies To:** Admin

**Acceptance Criteria:**

1. When the Enterprise-mode binding is set and admin Access groups are configured, a non-admin user who belongs to **any** configured admin group is elevated to `admin` for the request, granting access to admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup --> <!-- @test: src/__tests__/middleware/auth.test.ts (Auth Middleware) -->
2. A non-admin user who is in none of the configured admin groups still receives `403` from admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @test: src/__tests__/middleware/auth.test.ts (denies a non-admin who is in no configured admin group (403)) -->
3. Admin-group elevation checks run only on admin-gated paths and short-circuit for users already resolved as administrators. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup --> <!-- @test: src/__tests__/middleware/auth.test.ts (Auth Middleware) -->
4. An active user-access gate admits members of either user or admin groups. Admin groups alone never arm the gate, so entry remains open without configured user groups. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
5. Runtime admin-group reads are Enterprise-only; non-Enterprise admin authorization remains byte-identical to its prior behavior. <!-- @manual -->

**Constraints:**

- Elevation lives only on the request's Hono context; no KV `role:'admin'` record is written for a group-admin.
- Revocation is immediate and leaves no durable elevation residue.
- The email-based admin list remains the durable admin source.
- Admin groups grant no model-routing authority; only user Access-group keys may carry routing entries.
- The live get-identity check fails CLOSED (treated as non-member) on any missing token, non-`*.cloudflareaccess.com` domain, or fetch error — an admin gate must never elevate on uncertainty.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-312](setup.md#req-enterprise-312-admin-access-group-configuration)

**Verification:** Automated: [enterprise-jit-provisioning.test.ts](../../src/__tests__/lib/enterprise-jit-provisioning.test.ts), [auth.test.ts](../../src/__tests__/middleware/auth.test.ts); Manual: [Admin group mode isolation acceptance](../../documentation/lanes/authentication.md#admin-group-mode-isolation-acceptance)

**Status:** Implemented

---

## Authentication configuration lifecycle

<a id="req-sec-016-concurrent-cache-deduplication-for-auth-config"></a>
### REQ-SEC-016: Request-independent authentication configuration caching

**Intent:** Authentication configuration caching must avoid repeated reads on warm requests without coupling independent requests to another request's I/O lifetime.

**Applies To:** User

**Acceptance Criteria:**

1. Cache misses read configuration within their own request lifetime; a held earlier read does not stall independent authentication. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (REQ-SEC-016 AC1: a held first request at %s does not stall independent authentication) -->
2. Warm requests reuse only completed configuration snapshots, including during a storage outage. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @test: src/__tests__/security/access-security.test.ts (REQ-SEC-016 AC2: completed configuration remains usable during a storage outage) -->
3. A rejected earlier read cannot poison another request or its completed cache. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (REQ-SEC-016 AC3: a rejected first request does not poison another request or the completed cache) -->
4. Concurrent requests use their own complete domain/audience snapshot without publishing partial configuration. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-SEC-016 AC4: concurrent auth config loads use their own complete domain and audience snapshot) --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (REQ-SEC-001 AC4: a request arriving between domain and audience reads cannot trust an unsigned header) -->
5. Cached configuration expires after five minutes for a populated domain or 30 seconds for negative configuration. <!-- @impl: src/lib/access.ts::loadAuthConfig --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (REQ-SEC-016 AC5: $state cache expires and freshly saved configuration rejects header trust) -->
6. Explicit invalidation forces fresh reads and prevents earlier in-flight work from repopulating the cache or configured-state latch. <!-- @impl: src/lib/access.ts::resetAuthConfigCache --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (REQ-SEC-016 AC6: reset fences a held old configuration from repopulating the cache or configured latch) --> <!-- @test: src/__tests__/lib/auth-config-fetch-dedup.test.ts (REQ-SEC-016 AC6: reset after a completed snapshot makes the saved configuration visible) -->

**Constraints:**

- Completed configuration caching is per-isolate; request-owned I/O promises must never be stored in that shared cache.
- Unit races verify request independence and invalidation; actual Workers request-lifetime enforcement and deployed recovery require integration evidence, not a simulated promise alone.

**Priority:** P0

**Dependencies:** [REQ-AUTH-010](#req-auth-010-auth-bypass-prevention)

**Verification:** Automated: [auth-config-fetch-dedup.test.ts](../../src/__tests__/lib/auth-config-fetch-dedup.test.ts), [access-security.test.ts](../../src/__tests__/security/access-security.test.ts)

**Status:** Implemented

---
