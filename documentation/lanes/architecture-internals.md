# Architecture Internals

Backend library reference, code structure, and refactoring index for Codeflare.

**Audience:** Developers

See [Architecture](architecture.md) for system overview, components, data flow, and design rationale.

## Contents

- [Backend Libraries](#backend-libraries)
- [Code Structure (Pre-Launch Refactoring)](#code-structure-pre-launch-refactoring)
- [Appendix: CF-NNN Code Index](#appendix-cf-nnn-code-index)
- [SaaS UI Components](#saas-ui-components)

---

## Backend Libraries

| File | Purpose |
|------|---------|
| `src/middleware/auth.ts` | Shared authentication middleware. Delegates to `authenticateRequest()` which throws `AuthError`/`ForbiddenError` on failure. Sets `c.get('user')` and `c.get('bucketName')` for downstream handlers. |
| `src/lib/container-helpers.ts` | Consolidated container initialization: `getSessionIdFromQuery()` (from query param), `getContainerId()` (with validation, never fallbacks), `getContainerContext()` (full context for route handlers). |
| `src/lib/error-types.ts` | `AppError` base class with `code`, `statusCode`, `message`, `userMessage`. Specialized: `NotFoundError` (404), `ValidationError` (400), `ContainerError` (500), `AuthError` (401), `ForbiddenError` (403), `SetupError` (400), `RateLimitError` (429), `QuotaExceededError` (402), `CircuitBreakerOpenError` (503). Utilities: `toError(unknown)`, `toErrorMessage(unknown)`. |
| `src/lib/type-guards.ts` | Runtime type validation replacing unsafe type casts (e.g., `isBucketNameResponse()`). |
| `src/lib/constants.ts` | Single source of truth for shared constants: ports (`TERMINAL_SERVER_PORT = 8080`), session ID validation, CORS defaults, rate limit keys/windows, container fetch timeouts, max presets/tabs, protected paths, request ID config, session limits (`getMaxSessions()`). |
| `src/lib/circuit-breaker.ts` | Prevents cascading failures. States: CLOSED (normal), OPEN (fail fast), HALF_OPEN (testing recovery). Wraps `container.fetch()` calls. |
| `src/middleware/rate-limit.ts` | Per-user rate limiting (bucketName from auth, IP fallback). Stores counts in KV. Adds `X-RateLimit-*` headers. |
| `src/lib/logger.ts` | JSON logging with `createLogger(module)`, child loggers with request context. |
| `src/lib/jwt.ts` | RS256 verification against CF Access JWKS (`https://{authDomain}/cdn-cgi/access/certs`). Per-isolate JWKS cache with `resetJWKSCache()`. |
| `src/lib/cache-reset.ts` | Centralized invalidation of CORS + auth config + JWKS caches. Called by setup wizard after configuration changes. |
| `src/lib/cf-api.ts` | Cloudflare API client. `parseCfResponse` checks `Content-Type` header before JSON parsing. When content-type is not `application/json`, attempts `JSON.parse` on the text body as a lenient fallback. Only throws a structured `AppError` with the first 200 chars of the response body if the parse fails. |
| `src/lib/request-helpers.ts` | Shared request handling: `parseJsonBody(c)` (JSON parse with ValidationError on malformed input), `firstZodError(error)` (first Zod issue message with fallback), `validateSessionId(id)` (throws on invalid format), `maskSecret(value)` (shows last 4 chars). |
| `src/lib/kv-keys.ts` | KV key utilities: session/user key helpers, `SETUP_KEYS` const for all 20 `setup:*` configuration keys, `getBaseUrl(kv, requestUrl)`, `listAllKvKeys()`. |
| `src/lib/currency.ts` | `getCurrencyForCountry(country)` - maps a 2-letter ISO country code to a supported currency (chf/usd/eur/gbp). CH/LI -> CHF; GB plus British territories GI/GG/JE/IM -> GBP; European countries (Eurozone, other EU, non-EU European) -> EUR; all others -> USD. Implements [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing). |
| `src/types.ts` | `BillingStatus` union type with `BILLING_STATUS` const and `isBillingStatus()` guard. `ContainerConfigPayload` groups 16 container initialization params into logical sub-objects (R2 creds, LlmKeys, DeployKeys, preferences). |

### Setup Wizard Resilience

**Directory:** `src/routes/setup/`

All Cloudflare API calls in the setup wizard are wrapped in `withSetupRetry()` (defined in `shared.ts`) for transient failure resilience. The wrapper retries up to 2 times (3 total attempts) with exponential backoff (1s, 2s), skipping retry for `CircuitBreakerOpenError`.

**Cross-environment safety:** `resolveManagedAccessApp()` in `access.ts` uses a 4-tier fallback to find existing Access apps: (1) exact domain match, (2) stored app ID from KV, (3) name match + domain validation, (4) `/app/*` suffix + domain validation. Tiers 3 and 4 validate domain to prevent cross-environment collision when multiple environments share a CF account.

**Error propagation:** `listAccessApps()` and `listAccessGroups()` propagate errors through `withSetupRetry` rather than silently returning `[]`. Errors surface as `SetupError` with step details. The frontend `ApiError` carries a `steps` array from `SetupError` JSON responses.

**Stale user removal during reconfiguration:** When `POST /configure` is re-run with a new `allowedUsers` list, users no longer in the list are removed via `cleanupUserData()` (`src/lib/user-cleanup.ts`), wrapped in `runStep('cleanup_stale_users')`. This performs full cleanup identical to `DELETE /api/users/:email`. **Self-removal prevention:** the backend rejects the request if the current authenticated user is not in the submitted admin list. The Zod schema enforces at least 1 admin user.

---

## Code Structure (Pre-Launch Refactoring)

**Container DO extraction:** `src/container/index.ts` split into focused modules:
- `container-env.ts`: env var construction, bucket name application, credential injection, prefs-on-restart
- `container-metrics.ts`: collectMetrics, idle detection, Timekeeper ping, KV status updates (immutable spread, not mutation)
- `index.ts`: thin facade owning DO lifecycle (constructor, fetch, onStart, onStop, alarm). Sub-modules receive state via explicit interface parameters, not class inheritance.

**Session store extraction (CF-013):** `web-ui/src/stores/session.ts` split into focused modules:
- `session-polling.ts`: refreshSessionStatuses, miss counters, start/stop polling. Uses dependency injection via `registerPollingDeps()`.
- `session-usage.ts`: UsageState, warning levels, localStorage cache, `getDismissedQuotaLevel`/`setDismissedQuotaLevel` for per-UTC-month banner dismissal. Self-contained, no circular deps.
- `session.ts`: facade re-exports all members. Public API unchanged.

**Type safety fixes (CF-007):** `countPaidSlots` typed (no more `any[]`). Admin PATCH user uses `updateUserRecord` (not raw `KV.put`). `maxUsers` added to frontend `GetUsersResponseSchema` (no more double cast).

**Validation consolidation (CF-009):** 4 inline `SESSION_ID_PATTERN.test()` in `crud.ts` replaced with `validateSessionId()` from `request-helpers.ts`. Errors flow through global handler with consistent JSON shape.

**Shared config schema (CF-006):** `SetBucketNameBodySchema` in `container-config-schema.ts` - Zod schema for setBucketName payload with `.passthrough()` for flexibility. Deploy credential fields use conditional spread (not explicit `null`).

**ScrambleText consolidation (CF-016):** `ScrambleText.tsx` rewritten as a thin wrapper around `useScrambleText` hook (canonical `requestAnimationFrame` implementation). Single source of truth for scramble animation. Hook accepts `animateOnMount` option to trigger scramble on first render.

---

## Appendix: CF-NNN Code Index

| Code | Description | Source Location |
|------|-------------|-----------------|
| CF-001 | Turnstile token enforcement; rate-limit bypass prevention | src/routes/auth.ts, src/routes/stripe-webhook.ts, src/index.ts |
| CF-002 | Promise dedup for concurrent cold-start KV reads | src/lib/access.ts |
| CF-003 | Deny requests when KV unavailable (security-critical) | src/middleware/rate-limit.ts, src/lib/rate-limit-core.ts |
| CF-004 | Reset tiers to free on subscription.deleted | src/routes/stripe-webhook.ts, src/routes/usage.ts |
| CF-005 | Default undefined tiers to pending (block access) | src/lib/access.ts, src/lib/subscription.ts |
| CF-006 | Explicit null check; use getEffectiveTier | src/routes/billing.ts, src/routes/terminal.ts |
| CF-007 | Fetch tiers before priceId lookup; staleness window | src/routes/billing.ts, src/lib/subscription.ts, src/timekeeper/index.ts |
| CF-008 | Atomic read-merge-write for user KV records | src/lib/user-record.ts |
| CF-009 | Default both undefined tiers to pending | src/lib/subscription.ts |
| CF-010 | Rate-limit webhook; parseUserRecord validation | src/routes/stripe-webhook.ts, src/lib/access.ts |
| CF-011 | Prefer metadata.email over customer_email; typed user records | src/routes/stripe-webhook.ts, src/lib/user-record.ts |
| CF-012 | Decode URI-encoded sequences before path-traversal check | src/routes/storage/validation.ts |
| CF-013 | Session store extraction (facade pattern) | web-ui/src/stores/session.ts, session-polling.ts, session-usage.ts |
| CF-014 | Module-level cache inventory | See [Architecture](architecture.md#module-level-caches) |
| CF-015 | Catch missed subscription.deleted via billing period expiry | src/lib/subscription.ts |
| CF-016 | ScrambleText consolidation to hook-based pattern | web-ui/src/lib/use-scramble-text.ts, web-ui/src/components/ScrambleText.tsx |
| CF-017 | Warn on plaintext credential storage when ENCRYPTION_KEY absent | src/index.ts, src/lib/kv-crypto.ts, src/lib/access.ts |
| CF-018 | billingPeriodEnd enforcement; unlimited tier exemption | src/lib/subscription.ts |
| CF-020 | Timekeeper delta clamping / alarm retry; admin inquiry email; mobile input dispatch | src/lib/email.ts, web-ui/src/lib/terminal-mobile-input.ts |
| CF-021 | Trial always in usage hours (trialDays fallback removed) | web-ui/src/components/SubscribePage.tsx |
| CF-022 | KV rollback on container start failure; separate try/catch for KV reads | src/lib/cors-cache.ts, src/routes/container/lifecycle.ts |
| CF-023 | Check existing subscription before overwriting | src/routes/stripe-webhook.ts |
| CF-024 | Missing webhook handler coverage | src/routes/billing.ts |
| CF-027 | Prices from Stripe via admin-configured stripePriceId | src/lib/subscription.ts |
| CF-029 | Cache invalidation for storage deletes | src/routes/storage/ |
| CF-030 | Idempotency key to prevent duplicate checkout sessions | src/lib/stripe.ts |
| CF-032 | Log warning on unresolved customer (was silently dropped) | src/routes/stripe-webhook.ts |

---

## SaaS UI Components

SolidJS components for the SaaS auth and subscription flow (`web-ui/src/`). These components handle login, tier selection, onboarding, and admin user management.

### LoginPage (`web-ui/src/components/LoginPage.tsx`)

Shown at `/` when `SAAS_MODE=active`. Detects current auth state:
- Active tier -> redirect to `/app/`; pending -> redirect to `/app/subscribe`; blocked -> show blocked message
- If unauthenticated, fetches providers from `/public/auth/providers` and renders GitHub login button

### SubscribePage (`web-ui/src/components/SubscribePage.tsx`)

Shown at `/app/subscribe`. Two-phase layout:

**Phase 1 (home view):** Logo, feature highlights, status area (varies by user state).

**Phase 2 (plan view):** Mode card (Standard/Pro toggle), lifeline rail (5 plan stops: free -> standard -> advanced -> max -> unlimited), detail panel (price, hours, sessions, CTA button). Tier name and price use `useScrambleText` for decrypt animation on selection change.

**Status text by user state:**
| State | Text | Color |
|-------|------|-------|
| Pending | "Not Subscribed" | Orange |
| Active | "Subscribed" | Green + "Continue" link |
| Blocked | "Blocked" | Red |

### RootPage (`web-ui/src/App.tsx`)

Determines deployment mode from backend:
1. Calls `/public/auth/providers` - if providers returned, show LoginPage (SaaS mode)
2. Calls `/public/onboarding-config` - if active, show OnboardingLanding
3. Otherwise, redirect to `/app/` (default mode with CF Access)

### Admin User Management

Admin users always have `unlimited` tier and advanced session mode access (`canUseAdvanced()` returns `true` for admins). Backend rejects tier changes and deletions for admin-role users. `SettingsPanel` re-fetches `/api/user` each time it opens for live tier refresh.

---

## Related Documentation

- [Architecture](architecture.md) - System overview, components, data flow, design rationale
- [API Reference](api-reference.md) - All API endpoints
- [Authentication](authentication.md) - Authentication modes and SaaS billing

---

## Specification Coverage

Partial coverage - this section indexes only REQs whose implementation is described inline here. See [api-reference.md](api-reference.md) and [architecture.md](architecture.md) for the broader REQ backlinks.

- [REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page) - Custom branded login page (LoginPage component)
- [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow) - Enterprise tier contact flow (SubscribePage plan view)
- [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing) - Multi-Currency Pricing
