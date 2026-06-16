# Authentication & Billing

Dual authentication (Cloudflare Access and GitHub OIDC), SaaS mode, and three-tier auth middleware for Codeflare.

**Audience:** Operators, Developers

For security hardening, rate limiting, and encryption at rest, see [Security](security.md).

---

## Contents

- [Authentication Modes](#authentication-modes)
- [User Identity](#user-identity)
- [SaaS Mode](#saas-mode)
- [Environment Variables for SaaS Mode](#environment-variables-for-saas-mode)
- [Common Pitfalls](#common-pitfalls)

## Authentication Modes

Codeflare supports two fundamentally different authentication flows:

| | CF Access (with GitHub as IdP) | Direct GitHub OAuth |
|---|---|---|
| **When** | Default/enterprise, or SaaS without `OAUTH_CLIENT_ID` | SaaS or onboarding mode with `OAUTH_CLIENT_ID` configured (onboarding uses a landing-integrated `/login`) |
| **Auth layer** | Cloudflare Access (external service) | Worker handles auth directly |
| **Login page** | CF Access branded login page | Codeflare login page (`/login`) |
| **GitHub role** | One of several IdPs configured in CF Access dashboard | The sole auth provider, managed by the Worker |
| **OAuth flow** | CF Access -> GitHub -> CF Access issues `CF_Authorization` JWT | Worker -> GitHub -> Worker issues `codeflare_session` JWT |
| **JWT issuer** | Cloudflare (RS256, verified via JWKS) | Worker (HMAC-SHA256, verified via `OAUTH_JWT_SECRET`) |
| **Cookie** | `CF_Authorization` (managed by CF Access) | `codeflare_session` (HttpOnly, Secure, SameSite=Lax, 1h) |
| **Session lifetime** | Managed by CF Access policy | 1h TTL, auto-refreshed when < 15 min remaining |
| **User management** | CF Access groups + email allowlists | Worker KV records, JIT provisioning |
| **Setup wizard** | Creates CF Access app, groups, policies | No CF Access resources created |
| **Cost** | Free for 50 users, $3/user/month after | Free for unlimited users |
| **E2E auth** | `CF_ACCESS_CLIENT_SECRET` (CF Access + service headers) | `OAUTH_E2E_TEST_SECRET` (X-Service-Auth only) |
| **Logout** | `/cdn-cgi/access/logout` (CF Access system endpoint) | `/auth/github/logout` (clears `codeflare_session` cookie) |

The frontend always calls `/auth/logout` - the backend dispatches to the correct logout flow based on mode: any mode that issues a `codeflare_session` (SaaS or onboarding) takes the `/auth/github/logout` path, and only default/enterprise CF Access deployments use the CF Access system endpoint. Onboarding must not be sent to CF Access logout - it rejects the `returnTo` as an invalid redirect URL.

### Auth Resolution Order

`getUserFromRequest()` in `src/lib/access.ts` checks auth methods in this order:

1. **Service token** (`X-Service-Auth` header) - E2E testing, all modes. Constant-time comparison against `SERVICE_AUTH_SECRET`.
2. **Direct GitHub OAuth** (`codeflare_session` cookie) - only when (`SAAS_MODE=active` OR `ONBOARDING_LANDING_PAGE=active`) AND `OAUTH_CLIENT_ID` is set. HMAC-SHA256 JWT verified against `OAUTH_JWT_SECRET`. When this branch is entered, CF Access is never checked.
3. **Cloudflare Access** (`cf-access-jwt-assertion` header or `CF_Authorization` cookie) - all other modes. RS256 JWT verified against CF Access JWKS endpoint.
4. **Pre-setup fallback** (`cf-access-authenticated-user-email` header) - trusted only before setup completes.

### Direct GitHub OAuth Flow

When `SAAS_MODE=active` or `ONBOARDING_LANDING_PAGE=active`, and `OAUTH_CLIENT_ID` is configured, the Worker handles the entire OAuth flow:

```
User clicks "Sign in with GitHub" on /login
  -> GET /auth/github/login
  -> Generate HMAC-signed state token (nonce.iat.sig, signed with OAUTH_JWT_SECRET, 30-min iat window)
  -> 302 to github.com/login/oauth/authorize?client_id=...&scope=user:email&state=<signed>
  -> User authorizes on GitHub
  -> GitHub redirects to /auth/github/callback?code=...&state=...
  -> Worker verifies HMAC signature on state and checks iat is within window
     (stateless - no cookie required, works on iOS WebKit / ITP / private browsing)
  -> Worker exchanges code for access token via GitHub API
  -> Worker fetches verified email from /user + /user/emails
  -> Worker signs HMAC-SHA256 JWT with OAUTH_JWT_SECRET
  -> Set-Cookie: codeflare_session (HttpOnly, Secure, SameSite=Lax, Max-Age=3600)
  -> Redirect to /app/ (active user) or /app/subscribe (pending user)
  -> On state verification failure: redirect to /?error=session-expired
```

- Only `primary: true, verified: true` emails accepted from GitHub API
- Callback rate-limited (10/min per IP)
- Missing `OAUTH_JWT_SECRET` throws `AuthError` (fail-loud - never silently falls through to CF Access)
- Cookie auto-refreshed by middleware when < 15 min remaining

### Connect GitHub (link mode)

"Connect GitHub" is an explicit, additive action - a button in the GitHub panel, separate from login. It is **never** the Codeflare login. Login stays Cloudflare Access (enterprise) or the existing mode; Connect only authorizes Codeflare to act as the user on GitHub. Availability is currently enterprise-only (`githubFeatureEnabled` = `isEnterpriseMode`); broadening the gate is Planned ([REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)).

**Flow** ([REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage)):

```
User clicks "Connect GitHub" in the GitHub panel
  -> GET /api/github/connect (browser-navigated, carries the session cookie)
  -> Sign an HMAC OAuth state BOUND to the caller's bucket (anti-CSRF)
  -> 302 to the provider's authorize URL
  -> User authorizes on GitHub
  -> GitHub redirects to the stable callback GET /auth/github/connect/callback
     (src/routes/github-auth.ts)
  -> Re-derive the caller's identity from the EXISTING session
     (Access email header in enterprise; session JWT in SaaS) -
     no new codeflare_session cookie is minted
  -> Verify the OAuth state against THIS session's bucket: a state minted
     for another user (or the unbound /login flow) is rejected, so an
     attacker's code+state cannot plant their token in this bucket
  -> Exchange code for a token
  -> Persist the token to the existing deploy-keys entry (DeployKeys.githubToken)
```

**Two providers behind one seam (`getGithubProvider`):**

| Provider | Used for | Token behavior |
|---|---|---|
| **GitHub App user-to-server** | Enterprise / EMU | Acts as the user, expires ~8h, refreshable. `getValidGithubToken` refreshes within the skew window and fails closed when an expired App token cannot be refreshed (never returns a stale token). |
| **OAuth App** (existing) | Non-EMU SaaS | Long-lived token. |

A configured GitHub App takes precedence. With neither configured, Connect is unavailable (`503 GITHUB_NOT_CONFIGURED`).

**Provider configuration source.** `getGithubProvider` is async. In **enterprise** mode the provider type + credentials are admin-configured in the Setup wizard and stored in KV (client id plain, client secret encrypted): the resolver reads that config first and only falls back to the deploy-config env vars (`GITHUB_APP_*` / `OAUTH_*`) when KV is unconfigured — so enterprise GitHub works without GitHub-Actions/Cloudflare-secret access. In **non-enterprise** modes the resolver uses the env vars only (unchanged). A stored client secret that cannot be decrypted (no `ENCRYPTION_KEY`) is treated as unconfigured (fails closed). See [REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup) and the [Configuration](configuration.md#github-integration) lane.

**Scopes / permissions:** the OAuth App requests `repo read:org workflow`. The GitHub App's equivalent permissions (Contents R/W, Pull requests R/W, Workflows W, Metadata R) are set at registration. Enterprise GitHub Apps must be **internal** to the customer's enterprise - EMU managed users cannot authorize third-party apps.

**At rest:** the token is encrypted (kv-crypto) and never returned to the browser. Disconnect/offboarding revokes it ([REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation)). For the enterprise egress-injection security model and at-rest detail, see [Security](security.md) rather than duplicating it here.

Connect reuses the OAuth App from [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth) (SaaS login OAuth) in SaaS mode, but is distinct from login.

### CF Access Flow

When `OAUTH_CLIENT_ID` is NOT set, Cloudflare Access handles authentication:

```
User visits protected URL (/app, /api/*, /setup)
  -> CF Access intercepts (302 to CF Access login page)
  -> User picks identity provider (GitHub, Google, etc.)
  -> IdP OAuth flow (managed entirely by CF Access)
  -> CF Access issues CF_Authorization cookie (RS256 JWT)
  -> Request reaches Worker with cf-access-jwt-assertion header
  -> Worker verifies JWT signature via JWKS
  -> Worker extracts email, normalizes, resolves user from KV
```

**Email Normalization:** Trimmed + lowercased before KV lookup, role resolution, and bucket name derivation.

**Enterprise mode:** When `ENTERPRISE_MODE=active`, an authenticated CF Access request enters `resolveOrProvisionEnterpriseUser()` **before** the SaaS path. Existing users (admin or prior JIT) are returned unchanged; unknown emails are JIT-provisioned to `unlimited` tier (subject to an optional access-group gate). The SaaS subscribe/onboarding path is never reached. See [User Provisioning — Enterprise Mode Provisioning](user-provisioning.md#enterprise-mode-provisioning) and [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning).

### CF Access Resources

Created by the setup wizard only when GitHub OAuth is NOT configured:

**Access Application:** One self-hosted app with five destinations: `/app`, `/app/*`, `/api/*`, `/setup`, `/setup/*`.

**Access Groups:** Per-worker groups: `<worker-name>-admins`, `<worker-name>-users`. Setup upserts both, stores IDs in KV. `/api/users` syncs group membership via `syncAccessPolicy()` after user mutations.

When `OAUTH_CLIENT_ID` IS set: no CF Access groups or policies are created.

### E2E Testing Auth

E2E tests authenticate via `X-Service-Auth` header in all modes. The secret comes from:
- **CF Access mode:** `CF_ACCESS_CLIENT_SECRET` environment secret
- **Direct GitHub OAuth mode:** `OAUTH_E2E_TEST_SECRET` environment secret

Both are deployed as `SERVICE_AUTH_SECRET` on the Worker. When neither is set, service auth is disabled.

### Auth Flow

```mermaid
flowchart TD
    A[Request] --> B[Edge routing]
    B --> C[CORS]
    C --> D[Auth Middleware]
    D --> E["getUserFromRequest()"]
    E --> F{Service token?}
    F -->|Yes| G[Return admin user]
    F -->|No| H{SaaS or Onboarding + OIDC?}
    H -->|Yes| I[Verify codeflare_session cookie]
    H -->|No| J[Verify CF Access JWT]
    I --> K[Normalize email]
    J --> K
    K --> L[Resolve user from KV]
    L --> M[Route Handler]
```

---

## User Identity

Each authenticated user is mapped to a unique R2 bucket and a set of scoped credentials.

### Per-User Bucket Naming ([REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket))

`user@example.com` -> `codeflare-user-example-com` (sanitized, max 63 chars).

### Bucket Auto-Creation

**File:** `src/lib/r2-admin.ts` - `createBucketIfNotExists()` via Cloudflare API on first container start.

---

## SaaS Mode

When `SAAS_MODE=active`, Codeflare replaces the Cloudflare Access interstitial with a branded login page. New users are auto-provisioned with `pending` subscription tier and require subscription selection.

### Deployment Modes

| Mode | Auth provider | User provisioning | Access control |
|------|--------------|-------------------|----------------|
| **Default** (no `SAAS_MODE`) | Cloudflare Access (JWT) | Manual allowlist via setup wizard | CF Access policies + KV allowlist |
| **SaaS** (`SAAS_MODE=active`) | Custom login page + CF Access IdP hints | Auto-provisioned on first login | Three-tier middleware + KV subscription tiers |

### Complete SaaS Authentication Flow

> Note: this flow depicts SaaS mode without `OAUTH_CLIENT_ID` (CF Access-backed). When `OAUTH_CLIENT_ID` is set, the Direct GitHub OAuth flow above applies instead and CF Access is bypassed.

```mermaid
flowchart TD
    A["Visitor arrives at domain"] --> B["CF Access intercepts request"]
    B --> D["Redirect to GitHub OAuth"]
    D --> E["User completes GitHub login"]
    E --> F["CF Access mints JWT"]
    F --> G["Redirect to /app/"]
    G --> H["Worker verifies JWT via JWKS"]
    H --> J["Extract user email"]
    J --> K{"User in KV?"}
    K -->|no| L["JIT Provision: new record with pending tier"]
    K -->|yes| M["Load existing subscription tier"]
    L --> N["requireActiveUser check"]
    M --> N
    N -->|tier=pending| O["Redirect to /app/subscribe"]
    N -->|active tier| P["Allow IDE access"]
    N -->|tier=blocked| Q["Show blocked message"]
    O --> S["User selects tier + completes Turnstile"]
    S --> T["POST /api/auth/subscribe"]
    T --> V["Write subscriptionTier to KV"]
    V --> W{"First time?"}
    W -->|yes| X["Redirect to /app/onboarding"]
    X --> P
    W -->|no| P
```

**Key architectural choice:** CF Access handles authentication (identity), while the Worker handles authorization (access control).

### Three-Tier Auth Middleware

SaaS mode uses a layered middleware stack on every request to protected routes (`src/middleware/auth.ts`):

1. **`requireIdentity`** - Resolves the user from whichever credential the mode issues (the `codeflare_session` cookie in SaaS/onboarding OIDC mode, the CF Access JWT in default/enterprise mode). If the user is not in KV, auto-provisions them with `pending` tier. Sets `c.get('user')`. Used for endpoints like `/api/auth/status` and `/api/auth/subscribe`.

2. **`requireActiveUser`** - Authenticates then checks `subscriptionTier ?? accessTier` is an active tier via `isActiveTier()`. Pending users get 403 `{ code: 'PENDING' }` - frontend redirects to `/app/subscribe`. Blocked users get 403 `{ code: 'BLOCKED' }`. In non-SaaS mode, behaves identically to `requireIdentity`.

3. **`requireAdmin`** - Checks `role === 'admin'`. Must be used AFTER `requireIdentity` or `requireActiveUser`.

#### Admin authorization (admin-by-email and admin-by-group)

Admin authorization has two sources:

- **Admin-by-email (durable):** a KV `user:<email>` record with `role: 'admin'`, seeded from the Setup wizard's Admin Users list. `requireAdmin` passes immediately when the resolved user is already `admin`.
- **Admin-by-group (enterprise, live):** in enterprise mode, if the user is not already admin, `requireAdmin` calls `resolveAdminAccessGroup()` to test the user's Cloudflare Access group membership (a single get-identity call) against the Setup-configured `setup:enterprise_admin_access_group`. A match elevates the user to `admin` for that request only (set on the Hono context — no KV record written), so removing them from the group revokes admin access on the next request. The check is confined to `requireAdmin` (never the hot `authenticateRequest` path), is a no-op outside enterprise mode or when no admin groups are configured, and fails closed on any get-identity error. See [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) and [Configuration — Admin Access Group Configuration](configuration.md#admin-access-group-configuration).

Admin groups also widen the JIT entry gate (union of user-access + admin groups) so an admin in no user-access group is not locked out; see [User Provisioning](user-provisioning.md#enterprise-mode-provisioning).

### Root Redirect

- Setup incomplete -> redirect to `/setup`
- Setup complete, default mode -> `/` redirects to `/app/`
- Setup complete, onboarding mode -> authenticated users to `/app/`, unauthenticated to public landing
- Setup complete, SaaS mode -> `/` shows login page with "Sign in with GitHub" button
- Unauthenticated marketing-landing visitors who click Sign in go to `/login` (`APP_LINKS.signIn` in `landing/src/config.ts`), the SPA provider chooser (GitHub, Google, OIDC, one-time-pin). `/app/` is not used as the Sign-in link target because the SPA guard redirects an unauthenticated request back to `/` before the login UI renders.

---

## Environment Variables for SaaS Mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `SAAS_MODE` | unset | Set to `active` to enable custom login, JIT provisioning |
| `SAAS_EXTRA_IDPS` | unset | Comma-separated IdP UUIDs for custom OIDC providers |
| `RESEND_API_KEY` | unset | Resend email API token for notifications |
| `RESEND_EMAIL` | `Codeflare <onboarding@resend.dev>` | From address for notification emails |
| `ONBOARDING_LANDING_PAGE` | unset | Set to `active` to show waitlist page at `/` |

Both `SAAS_MODE` and `ONBOARDING_LANDING_PAGE` are passed to the Worker via `--var` in `deploy.yml`.

---

## Common Pitfalls

1. **Auto-redirect loops:** Early versions auto-redirected pending users from `/app/subscribe` back to themselves on page load after approval. Fixed by removing auto-redirect.

2. **Stale JWT cache:** The Worker cached auth config for 5 minutes. If setup changed during that window, old JWTs would fail verification. Fixed by adding `resetAuthConfigCache()` called after setup completes.

3. **Policy overwrite on reconfigure:** If `syncAccessPolicy()` were called in SaaS mode, it would overwrite `login_method` with group includes. Fixed by not calling sync in SaaS mode.

4. **Concurrent first-login writes:** KV eventual consistency means two simultaneous first-logins may write the same user record twice. This is benign (idempotent) - KV per-key serialization prevents split-brain.

5. **CSRF on state-changing requests:** Added `X-Requested-With` header check on POST/PUT/DELETE in `authenticateRequest()`.

6. **Service token auth for e2e tests:** `X-Service-Auth` header with custom secret for CI/e2e tests that cannot go through CF Access.

---

## Specification Coverage

- [REQ-AUTH-004](../../sdd/spec/authentication.md#req-auth-004-service-token-authentication-for-e2e-testing) - Service token authentication for E2E testing
- [REQ-AUTH-005](../../sdd/spec/authentication.md#req-auth-005-three-tier-authorization-middleware) - Three-tier authorization middleware
- [REQ-AUTH-009](../../sdd/spec/authentication.md#req-auth-009-logout-dispatches-by-mode) - Logout dispatches by mode
- [REQ-AUTH-010](../../sdd/spec/authentication.md#req-auth-010-auth-bypass-prevention) - Auth bypass prevention
- [REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page) - Custom branded login page
- [REQ-AUTH-014](../../sdd/spec/authentication.md#req-auth-014-auth-expiry-detection-mid-session) - Auth expiry detection mid-session
- [REQ-AUTH-015](../../sdd/spec/authentication.md#req-auth-015-guided-onboarding-flow) - Guided onboarding flow
- [REQ-AUTH-016](../../sdd/spec/authentication.md#req-auth-016-header-user-dropdown) - Header user dropdown
- [REQ-AUTH-017](../../sdd/spec/authentication.md#req-auth-017-gravatar-integration) - Gravatar integration
- [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning) - Access-gated JIT provisioning runs before SaaS path in enterprise mode
- [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) - Admin authorization via Cloudflare Access groups (live requireAdmin elevation)
- [REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup) - Enterprise GitHub provider config (admin-configured in Setup, KV-first resolution)

---

## Related Documentation

- [Billing](billing.md) - Subscription tiers, Stripe, Timekeeper DO, paygate
- [User Provisioning](user-provisioning.md) - JIT provisioning, subscribe page, frontend components
- [Security](security.md) - Security model, rate limiting, encryption
- [API Reference](api-reference.md#auth-saas-mode) - Auth API endpoints
- [Configuration](configuration.md#secrets) - Worker secrets
- [Architecture](architecture.md#container-do-container) - Container Durable Object
