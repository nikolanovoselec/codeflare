# Plan: GitHub OIDC for SaaS Mode (Replace CF Access)

## Context

CF Access costs $3/user/month beyond 50 users. At 1,400 users = $4,050/month for auth alone.
GitHub OIDC is free, unlimited users, and simplifies onboarding (no CF Access setup step).

**Scope**: SaaS mode only (`SAAS_MODE=active`). CF Access stays for default mode and onboarding.

## Architecture

```
SaaS mode:
  Login button → GET /auth/github/login
    → Set oauth_state cookie (random, 5-min TTL)
    → 302 github.com/login/oauth/authorize?client_id&redirect_uri&scope=user:email&state
    → GitHub authenticates user
    → 302 /auth/github/callback?code&state
    → Worker: validate state (cookie vs query param)
    → Worker: exchange code for access token, fetch email + user ID
    → Worker: sign HMAC-SHA256 JWT → Set-Cookie: codeflare_session
    → 302 /app/subscribe (pending) or /app/ (active)

  Every request:
    → getUserFromRequest() reads codeflare_session cookie
    → Verifies HMAC JWT → returns AccessUser
    → Rest of the stack unchanged (middleware, terminal, routes)

  Cookie refresh (DEFERRED):
    → DEFERRED — users re-login after 1h expiry
    → Cookie refresh middleware to be implemented in a future iteration
    

Default mode:
  → CF Access handles everything (unchanged)
```

## Branch & CI

- **Branch:** `feat/subscription` at `/home/user/workspace/codeflare`
- **CI:** `gh workflow run test.yml/fuzz.yml --ref feat/subscription`
- **Deploy:** `gh workflow run deploy.yml --ref feat/subscription -f environment=integration`
- **TDD enforced** — write tests BEFORE implementation for each phase
- Update TECHNICAL.md with auth architecture changes
- No local builds, DO NOT TOUCH MAIN

---

## Phase 1: Session JWT Module (TDD)

### Tests first: `src/__tests__/lib/session-jwt.test.ts`

```
- signSessionJWT produces valid 3-part base64url JWT
- signSessionJWT includes iat and exp with correct TTL
- verifySessionJWT returns payload for valid token
- verifySessionJWT returns null for expired token
- verifySessionJWT returns null for tampered payload
- verifySessionJWT returns null for tampered signature
- verifySessionJWT returns null for wrong secret
- verifySessionJWT returns null for malformed/empty/non-JWT string
```

### Implementation: `src/lib/session-jwt.ts`

```ts
interface SessionJWTPayload {
  email: string;     // verified GitHub email
  sub: string;       // GitHub user ID (stringified) — primary identity key
  ghLogin: string;   // GitHub username (display only)
  iat: number;
  exp: number;
}

export async function signSessionJWT(
  payload: Omit<SessionJWTPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds?: number  // default 3600
): Promise<string>

export async function verifySessionJWT(
  token: string,
  secret: string
): Promise<SessionJWTPayload | null>

// shouldRefreshJWT — DEFERRED to future iteration
```

- Uses `crypto.subtle.importKey` + `crypto.subtle.sign`/`verify` with `{ name: 'HMAC', hash: 'SHA-256' }`
- Cache imported CryptoKey at module level (same pattern as `src/lib/kv-crypto.ts:14-16`)
- Fixed header: `{"alg":"HS256","typ":"JWT"}`
- Reuse base64url helpers from `src/lib/jwt.ts` or duplicate for isolation

---

## Phase 2: OAuth Routes (TDD)

### Tests first: `src/__tests__/routes/github-auth.test.ts`

```
Login:
- GET /login redirects to github.com with correct client_id, redirect_uri, scope, state
- GET /login sets oauth_state cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=300)
- GET /login returns 500 when OAUTH_CLIENT_ID missing

Callback — happy path:
- GET /callback with valid state cookie + matching query state exchanges code
- GET /callback sets codeflare_session cookie on success
- GET /callback redirects to /app/subscribe for new/pending user
- GET /callback redirects to /app/ for active user
- GET /callback clears oauth_state cookie on success

Callback — error cases:
- GET /callback with ?error=access_denied redirects to /?error=access_denied
- GET /callback with missing state cookie returns 403
- GET /callback with state mismatch returns 403
- GET /callback when GitHub token exchange fails returns 502
- GET /callback when GitHub API returns 500 returns 502
- GET /callback when user has no verified email redirects to /?error=no-verified-email

Logout:
- GET /logout clears codeflare_session cookie (Max-Age=0)
- GET /logout redirects to /
```

### Implementation: `src/routes/github-auth.ts`

New Hono router mounted at `/auth/github`.

**GET /login:**
1. Validate `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + `OAUTH_JWT_SECRET` exist → 500 if missing
2. Generate random state: `crypto.randomUUID()`
3. Set cookie: `oauth_state={state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`
4. Build redirect: `github.com/login/oauth/authorize?client_id&redirect_uri&scope=user:email&state`
5. `redirect_uri` = `https://{custom_domain}/auth/github/callback` (from KV or request origin)

**GET /callback:**
1. Check `?error=` query param → redirect to `/?error={value}` if present
2. Read `oauth_state` cookie + `state` query param → 403 if missing or mismatch
3. Clear `oauth_state` cookie: `Max-Age=0`
4. Exchange code for token: `POST github.com/login/oauth/access_token` (Accept: application/json)
   - Wrap in try/catch → 502 on failure
5. Fetch profile: `GET api.github.com/user` → extract `id`, `login`
   - Wrap in try/catch → 502 on failure
6. Fetch emails: `GET api.github.com/user/emails` → find `primary: true, verified: true`
   - No verified email → redirect to `/?error=no-verified-email`
7. Sign session JWT: `signSessionJWT({ email, sub: String(id), ghLogin: login }, OAUTH_JWT_SECRET)`
8. Set cookie: `codeflare_session={jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`
9. Check user state via KV → redirect to `/app/subscribe` (pending/not found) or `/app/` (active)

**GET /logout:**
1. Clear: `codeflare_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`
2. Redirect to `/`

**GitHub access token is NOT stored** — used only during callback, then discarded.

**Rate limiting:** Apply `createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'github-auth' })` to callback route to prevent code-exchange spam.

---

## Phase 3: Core Auth Changes (TDD)

### Tests first: `src/__tests__/lib/access-saas-oidc.test.ts`

```
- SaaS + valid codeflare_session cookie → authenticated with correct email
- SaaS + missing cookie → not authenticated
- SaaS + expired cookie → not authenticated
- SaaS + tampered cookie → not authenticated
- SaaS + service token (X-Service-Auth) → still works (takes precedence over cookie)
- SaaS + OAUTH_JWT_SECRET missing → throws Error (not silent fallthrough)
- Non-SaaS mode ignores codeflare_session cookie, uses CF Access JWT
- Non-SaaS + CF Access JWT → authenticated (unchanged behavior)
- Cookie refresh (DEFERRED): near-expiry JWT triggers refreshCookie on context
- Cookie refresh (DEFERRED): fresh JWT does NOT trigger refreshCookie
```

### Implementation: `src/lib/access.ts`

Insert after service token check (line 144), before CF Access JWT check (line 147):

```ts
// SaaS mode: verify codeflare_session cookie (HMAC JWT)
if (env && isSaasModeActive(env.SAAS_MODE)) {
  // Fail loud if secrets are missing — never silently fall through to CF Access
  if (!env.OAUTH_JWT_SECRET || !env.OAUTH_CLIENT_ID) {
    throw new AuthError('SaaS mode active but GitHub OIDC secrets not configured');
  }
  const sessionToken = getCookieValue(request.headers.get('Cookie'), 'codeflare_session');
  if (!sessionToken) {
    return { email: '', authenticated: false };
  }
  const payload = await verifySessionJWT(sessionToken, env.OAUTH_JWT_SECRET);
  if (!payload) {
    return { email: '', authenticated: false };
  }
  return { email: normalizeEmail(payload.email), authenticated: true };
}
// Existing CF Access flow continues for non-SaaS mode...
```

### Cookie refresh (DEFERRED): global middleware in `src/index.ts`

Add after the request tracing middleware, before CORS:

```ts
Cookie refresh middleware deferred to future iteration. Current design: 1-hour cookies, users re-login after expiry.

---

## Phase 4: Route & Config Changes

### 4.1 `src/routes/auth-redirects.ts`

```ts
app.get('/login/:provider', async (c) => {
  if (isSaasModeActive(c.env.SAAS_MODE)) return c.redirect('/auth/github/login');
  // existing CF Access redirect...
});

app.get('/logout', async (c) => {
  if (isSaasModeActive(c.env.SAAS_MODE)) return c.redirect('/auth/github/logout');
  // existing CF Access logout...
});
```

### 4.2 `src/index.ts`

Mount new router:
```ts
import githubAuthRoutes from './routes/github-auth';
app.route('/auth/github', githubAuthRoutes);
```

Update `GET /public/auth/providers`:
```ts
if (saas && c.env.OAUTH_CLIENT_ID) {
  return c.json({ providers: [{ id: 'github', type: 'github', name: 'GitHub', loginUrl: '/auth/github/login' }] });
}
```

### 4.3 `src/types.ts`

```ts
OAUTH_CLIENT_ID?: string;      // OAuth App client ID (wrangler.toml var)
OAUTH_CLIENT_SECRET?: string;   // OAuth App client secret (wrangler secret)
OAUTH_JWT_SECRET?: string;             // HMAC signing key for session JWTs (wrangler secret)
```

### 4.4 `src/routes/setup/access.ts`

In `handleCreateAccessApp()`, if `saasMode && env.OAUTH_CLIENT_ID`:
- Skip all CF Access API calls
- Store minimal IdP list: `[{ id: 'github', type: 'github', name: 'GitHub' }]`
- Return success immediately

### 4.5 `web-ui/src/components/LoginPage.tsx`

Provider response now includes `loginUrl` field for SaaS+OIDC mode.
Button href: `provider.loginUrl ?? '/app/'`

### 4.6 `web-ui/src/types.ts`

```ts
export interface AuthProvider {
  id: string; type: string; name: string;
  loginUrl?: string;  // when present, button links here directly
}
```

---

## Phase 5: Documentation

### TECHNICAL.md updates:
- New section: "GitHub OIDC Authentication (SaaS Mode)"
  - Architecture diagram showing the OAuth flow
  - Cookie lifecycle (sign, verify, refresh, clear)
  - Explain dual-mode: CF Access (default) vs GitHub OIDC (SaaS)
- Update Architecture Decisions table:
  - AD: GitHub OIDC replaces CF Access in SaaS mode (cost: $4k/mo at scale)
  - AD: HMAC-SHA256 session JWTs (symmetric, no JWKS needed)
  - AD: Cookie-based state for OAuth CSRF (not KV — eventual consistency risk)
  - AD: GitHub user ID (`sub`) as primary identity (not email — emails can change)
- Update Module-Level Caches table: add session JWT key cache entry

### README.md updates:
- Document OAuth App creation steps
- Document callback URL format: `https://{domain}/auth/github/callback`
- Document required secrets: `OAUTH_CLIENT_SECRET`, `OAUTH_JWT_SECRET`

---

## Phase 6: Deployment Config

### New secrets (wrangler secret put):
- `OAUTH_CLIENT_SECRET` — OAuth App client secret
- `OAUTH_JWT_SECRET` — `openssl rand -base64 32` (256-bit random)

### New var (wrangler.toml or GitHub Actions):
- `OAUTH_CLIENT_ID` — OAuth App client ID (public)

### GitHub OAuth App:
- Create at `github.com/settings/applications/new`
- Application name: Codeflare
- Callback URL: `https://{custom_domain}/auth/github/callback`
- Homepage URL: `https://{custom_domain}`

---

## Files Changed Summary

| File | Change |
|---|---|
| `src/lib/session-jwt.ts` | **NEW** — HMAC JWT sign/verify |
| `src/routes/github-auth.ts` | **NEW** — OAuth login/callback/logout |
| `src/__tests__/lib/session-jwt.test.ts` | **NEW** — JWT unit tests |
| `src/__tests__/routes/github-auth.test.ts` | **NEW** — OAuth route tests |
| `src/__tests__/lib/access-saas-oidc.test.ts` | **NEW** — SaaS auth tests |
| `src/lib/access.ts` | Add SaaS mode branch in `getUserFromRequest()` |
| `src/index.ts` | Mount github-auth, update providers endpoint |
| `src/middleware/auth.ts` | Unchanged (refresh deferred)
| `src/routes/auth-redirects.ts` | SaaS mode branch for login/logout |
| `src/types.ts` | Add OAUTH_CLIENT_ID/SECRET, OAUTH_JWT_SECRET to Env |
| `src/routes/setup/access.ts` | Skip CF Access creation in SaaS+OIDC |
| `web-ui/src/components/LoginPage.tsx` | Use `loginUrl` from provider |
| `web-ui/src/types.ts` | Add `loginUrl?` to AuthProvider |
| `TECHNICAL.md` | Auth architecture docs + ADs |

## Files NOT Changed

- `src/lib/jwt.ts` — stays for CF Access (default mode)
- `src/routes/terminal.ts` — uses `authenticateRequest()`, unchanged
- `src/routes/auth.ts` — uses `requireIdentity`, unchanged
- `src/routes/billing.ts` — uses auth middleware, unchanged
- `src/routes/stripe-webhook.ts` — unauthenticated, unchanged

---

## Security

- **CSRF**: OAuth state stored in HttpOnly cookie (not KV — avoids eventual consistency lag), validated by matching cookie vs query param, cleared on use
- **Cookie**: `codeflare_session` — HttpOnly, Secure, SameSite=Lax, 1h expiry, 1h expiry, re-login on expiry
- **Email**: Only `verified: true` emails from GitHub `/user/emails` API
- **Identity**: GitHub user ID (`sub`) is the primary identity — emails can change
- **No token storage**: GitHub access token used ephemerally during callback only
- **Fail-loud**: Missing `OAUTH_JWT_SECRET`/`OAUTH_CLIENT_ID` in SaaS mode throws AuthError (no silent fallthrough to CF Access)
- **Rate limiting**: Callback endpoint rate-limited (10/min per IP) to prevent code-exchange spam
- **Error handling**: GitHub `?error=access_denied` → clean redirect; GitHub API 5xx → 502

## Risks

- **Email change**: GitHub user changes verified email → next login gets new email, old KV record orphaned. Future mitigation: match on `sub` as secondary lookup key.
- **Private email**: `user:email` scope gets verified email even when hidden.
- **OAUTH_JWT_SECRET rotation**: Deploy new secret → old cookies fail → users re-login. Acceptable for planned rotation.
- **GitHub OAuth App scope**: `user:email` is read-only. No write access to any user data.

---

## Implementation Order

| # | Phase | What | TDD |
|---|-------|------|-----|
| 1 | Phase 1 | `session-jwt.ts` + tests | Tests first |
| 2 | Phase 2 | `github-auth.ts` + tests | Tests first |
| 3 | Phase 3 | `access.ts` + refresh middleware + tests | Tests first |
| 4 | Phase 4 | Route/config/frontend changes | Update existing tests |
| 5 | Phase 5 | TECHNICAL.md + README.md | — |
| 6 | Phase 6 | Create GitHub OAuth App + set secrets | — |
| 7 | — | Push → CI → deploy → E2E test | — |

## Verification

1. **Unit tests**: CI runs all new + existing tests (1500+ tests)
2. **E2E smoke test** (manual on integration):
   - Visit login page → click "Sign in with GitHub"
   - Verify redirect to GitHub → authorize → redirect back
   - Verify cookie set, user provisioned in KV
   - Verify `/api/auth/status` returns authenticated user
   - Verify WebSocket terminal connects
   - Click logout → verify cookie cleared, redirected to login
   - Verify service token auth still works (`X-Service-Auth` header)
3. **Default mode regression**: Deploy without `OAUTH_CLIENT_ID` → verify CF Access flow unchanged
