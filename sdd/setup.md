# Setup

First-time setup wizard, deployment modes, custom domain configuration, and post-setup reconfiguration.

**Domain owner:** Worker (src/routes/setup/), Cloudflare API integration

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Setup Wizard | A multi-step `POST /api/setup/configure` endpoint that provisions all Cloudflare resources (R2 credentials, DNS, Access apps, Turnstile) from a single API call |
| Deployment Mode | One of three runtime configurations: Default (CF Access auth), Onboarding (CF Access + public waitlist), or SaaS (GitHub OAuth + self-serve subscriptions) |
| NDJSON Streaming | The progress reporting format used by the setup endpoint -- each line is a self-contained JSON object with step name and status, ending with a `done: true` completion object |

### Out of Scope

- **Multi-region deployment** -- Codeflare deploys to a single Cloudflare Worker. No multi-region failover, geo-routing, or region-aware configuration in the setup wizard.
- **Automated scaling configuration** -- Container instance limits and resource tiers are set via GitHub Actions variables, not through the setup wizard. No auto-scaling policies.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Authentication | Setup wizard creates CF Access applications, groups, and policies; configures GitHub OAuth client in SaaS mode |
| Security | Turnstile CAPTCHA widget provisioned during setup for onboarding and SaaS landing pages; rate limiting on setup endpoints |

---

## REQ-SETUP-001: First-time setup requires zero pre-configuration

**Intent:** A freshly deployed Codeflare instance must be configurable through the setup wizard without any prior manual setup of authentication, DNS, or storage.

**Acceptance Criteria:**
1. When `setup:complete` is not set in KV, the `POST /api/setup/configure` endpoint is publicly accessible (no authentication required).
2. The deployer needs only a Cloudflare API token (provided as a Worker secret via `wrangler secret put`); no other pre-configuration is required.
3. The Cloudflare API token is read from the `CLOUDFLARE_API_TOKEN` environment binding, not from the request body.
4. The setup wizard creates all necessary Cloudflare resources (R2 credentials, DNS records, Access applications, Turnstile widgets) from scratch.
5. `GET /api/setup/status` is always public and returns `{ configured: boolean, customDomain?: string, saasMode: boolean }`.

**Constraints:**
- The pre-setup public window is intentionally open (AD10) to solve the bootstrap problem: authentication cannot be required before it is configured.
- Rate limiting (5/min on `setup-configure`) and short exposure window mitigate the open endpoint risk.

**Applies To:** Admin
**Priority:** P0
**Dependencies:** None
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SETUP-002: Setup wizard configures domain, auth, R2 credentials, and Turnstile

**Intent:** A single `POST /api/setup/configure` call provisions all required Cloudflare resources and stores the resulting configuration in Workers KV.

**Acceptance Criteria:**
1. The request body includes `customDomain` (valid domain), `allowedUsers` (non-empty email array), `adminUsers` (non-empty email array, subset of `allowedUsers`), and optional `allowedOrigins` (domain suffix patterns starting with `.`).
2. All fields are validated by Zod schemas before streaming starts.
3. Setup executes 7 sequential steps, streaming progress via NDJSON:
   - Step 1 (`get_account`): Retrieves account ID from the API token.
   - Step 2 (`derive_r2_credentials`): Derives S3-compatible R2 credentials from the API token (Access Key ID = token ID, Secret = SHA-256 of token value).
   - Step 3 (`set_secrets`): Sets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker secrets.
   - Step 3a (`cleanup_stale_users`): Conditional -- runs on reconfigure when users are removed from the allowlist.
   - Step 4 (`configure_custom_domain`): Resolves zone, creates/updates CNAME DNS record and Worker route.
   - Step 5 (`create_access_app`): Creates/updates CF Access application, groups, and policies (or skips in GitHub OIDC mode).
   - Step 6 (`configure_turnstile`): Conditional -- creates Turnstile widget when onboarding or SaaS mode is active.
   - Step 7 (`finalize`): Writes final KV state and marks setup as complete.
4. All KV keys written by setup use the `setup:` prefix.
5. The response stream ends with exactly one completion object containing `done: true`.

**Constraints:**
- Each Cloudflare API call is wrapped in `withSetupRetry()` (exponential backoff, 3 total attempts, 1s base delay).
- `CircuitBreakerOpenError` is not retried.

**Applies To:** Admin
**Priority:** P0
**Dependencies:** REQ-SETUP-001
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SETUP-003: Three deployment modes

**Intent:** Codeflare supports three deployment modes that determine authentication strategy and user provisioning.

**Acceptance Criteria:**
1. **Default mode** (no `SAAS_MODE`): Uses Cloudflare Access JWT authentication. Users are manually allowlisted via the setup wizard. CF Access policies + KV allowlist control access.
2. **Onboarding mode** (`ONBOARDING_LANDING_PAGE=active`): Uses CF Access authentication. Adds a public waitlist landing page at `/` for unauthenticated visitors. Authenticated users are routed to `/app/`. Turnstile widget is provisioned for the landing page.
3. **SaaS mode** (`SAAS_MODE=active`): Replaces the CF Access interstitial with a branded login page. When `OAUTH_CLIENT_ID` is configured, uses Direct GitHub OAuth (Worker-managed HMAC-SHA256 session cookies). New users are auto-provisioned with `pending` tier. CF Access groups/policies are not created; the Worker handles user management via KV.
4. `SAAS_MODE` and `ONBOARDING_LANDING_PAGE` are passed to the Worker via `--var` in `deploy.yml`.
5. The frontend detects the mode: if `/public/auth/providers` returns providers, show LoginPage (SaaS); if setup incomplete, show setup; otherwise redirect to `/app/` (default with CF Access).

**Constraints:**
- `STRESS_TEST_MODE` must not be active alongside `SAAS_MODE` (global middleware returns 503).
- SaaS mode without `OAUTH_CLIENT_ID` falls back to CF Access authentication.

**Applies To:** Admin
**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SETUP-004: Setup is idempotent

**Intent:** Re-running the setup wizard with the same or updated inputs must safely update existing resources without creating duplicates or leaving orphaned state.

**Acceptance Criteria:**
1. Every step uses create-or-update semantics: `get_account` is a read, `derive_r2_credentials` derives deterministically from the token, `set_secrets` overwrites, `configure_custom_domain` upserts DNS and routes, `create_access_app` upserts groups/app/policy, `configure_turnstile` upserts widget.
2. If a previous run partially completed, a retry updates existing resources and continues from step 1.
3. Partial progress from failed runs remains in KV. Setup is NOT marked complete on failure, so the next call retries.
4. "Already exists" errors on Worker routes and DNS records are handled by updating the existing resource.
5. Error code 10215 (latest version not deployed) on secret writes triggers auto-deploy of latest Worker version followed by retry.

**Constraints:**
- A KV-based lock (`setup:configuring`) prevents concurrent configure runs. Lock is checked on entry, overridden if stale (>60s), and deleted in `finally`. KV TTL of 300s acts as safety net.
- The lock check returns an immediate error (no step progress) if another configure run is active and less than 60s old.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SETUP-002
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SETUP-005: Post-setup reconfiguration requires admin auth

**Intent:** After initial setup is complete, only authenticated administrators can reconfigure the deployment.

**Acceptance Criteria:**
1. When `setup:complete` is `"true"` in KV, the conditional auth middleware in `src/routes/setup/index.ts` requires valid authentication.
2. The authenticated user must have the `admin` role (enforced by `requireAdmin`).
3. This applies to `POST /api/setup/configure`, `GET /api/setup/detect-token`, and `GET /api/setup/prefill`.
4. `GET /api/setup/status` remains always public (no secrets in response).
5. Authentication is via CF Access JWT or OIDC session cookie, verified by `authMiddleware`.

**Constraints:**
- Admin role is resolved from KV user records, not from CF Access group membership.
- In SaaS mode, admin status is enforced by the Worker, not by CF Access.

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-SETUP-001, REQ-AUTH-005
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SETUP-006: Setup streams progress via NDJSON

**Intent:** The setup configure endpoint must stream real-time progress so the client can display step-by-step status updates.

**Acceptance Criteria:**
1. The response content type is `application/x-ndjson`.
2. Each line is a self-contained JSON object terminated by `\n`.
3. Progress messages include `step` (step name) and `status` (`running`, `success`, or `error`).
4. Error status messages include an `error` field with the error description.
5. Every stream ends with exactly one completion object containing `done: true` and `success: boolean`.
6. Successful completion includes `steps` array, `workersDevUrl`, and `customDomainUrl`.
7. Failed completion includes `steps` array and top-level `error` message.
8. Lock contention produces an immediate `done: true, success: false` with no step progress messages.
9. The client detects completion by parsing until `done === true`, then checks `success`.

**Constraints:**
- The stream is not retryable mid-progress; on failure the client must re-submit the full request.
- The `steps` array in the completion object provides cumulative status of all attempted steps.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SETUP-002
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SETUP-007: Custom domain with DNS validation

**Intent:** The setup wizard must configure a custom domain with proper DNS records and Worker routes, supporting nested subdomains and ccTLDs.

**Acceptance Criteria:**
1. Zone resolution looks up the Cloudflare zone ID by trying progressively shorter domain suffixes (supports ccTLDs like `.co.uk`).
2. A proxied CNAME record is created or updated, pointing the custom domain to `{workerName}.{accountSubdomain}.workers.dev`.
3. A Worker route pattern `{customDomain}/*` is created mapped to the worker script.
4. "Already exists" errors on Worker routes are handled by updating the existing route.
5. The custom domain is stored in KV as `setup:custom_domain` (lowercased).
6. Dynamic origins (custom domains and additional origins configured via setup) are cached in-memory for 5 minutes with KV as source of truth.
7. Post-setup, the workers.dev URL is used only for initial setup; all traffic should go through the custom domain.

**Constraints:**
- DNS changes require the domain's zone to be managed by Cloudflare.
- The CNAME record is Cloudflare-proxied (orange cloud), so the origin IP is hidden.

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-SETUP-002
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SETUP-008: Setup helper endpoints support prefill and detection

**Intent:** The setup UI must be able to pre-populate fields from existing configuration and detect the API token's capabilities.

**Acceptance Criteria:**
1. `GET /api/setup/prefill` reads existing CF Access group membership and KV configuration to prefill the setup form on redeployment.
2. `GET /api/setup/detect-token` validates the API token and returns its capabilities (account info, permissions).
3. Both helper endpoints are subject to the shared `setupRateLimiter` (5/min, key prefix `setup-configure`).
4. Both endpoints require admin auth after setup is complete (same conditional middleware as configure).

**Constraints:**
- Prefill reads from Cloudflare API and KV; it does not modify any state.
- Detection endpoint is a read-only token validation.

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-SETUP-005
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SETUP-009: Subscribe page with tier selection

**Intent:** Users can choose their subscription tier with a clear comparison of features and pricing.

**Applies To:** User

**Acceptance Criteria:**
1. `/app/subscribe` shows available tiers with features, hours, sessions, storage, and pricing.
2. Three-phase wizard (home, plan selection, checkout).
3. Turnstile CAPTCHA on new subscriptions.
4. Mode toggle (Standard/Pro).
5. Free tier activates immediately.
6. Paid tiers redirect to Stripe Checkout.

**Constraints:**
- None

**Priority:** P1
**Dependencies:** REQ-SUB-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SETUP-010: Social-share preview metadata on the public landing page

**Intent:** When the public-facing URL is shared on social platforms or chat apps, the unfurl renders a branded preview card with the product tagline and a 1200×630 preview image so the link communicates what Codeflare is before the visitor clicks.

**Applies To:** User

**Acceptance Criteria:**
1. The home page exposes Open Graph metadata: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`, `og:image:width=1200`, `og:image:height=630`, `og:image:alt`, `og:locale`.
2. Twitter Card metadata is set with `twitter:card="summary_large_image"` plus title, description, image, and image:alt.
3. The preview image is a 1200×630 PNG that includes the Codeflare wordmark, the product tagline, and a CODEFLARE.CH wordmark footer.
4. The `<meta name="description">` matches the `og:description` so search-engine snippets and social-share cards stay in sync.
5. The tagline copy in `og:description` and the meta description follows the brand voice ("Ideas don't care where you are. Neither does your new ephemeral IDE.") and is the canonical external description of the product.

**Constraints:**
- The preview image must remain ≤1MB so platforms cache it inline.
- og:image dimensions are 1200×630 (the dual standard for Open Graph and Twitter `summary_large_image` cards).

**Priority:** P2
**Dependencies:** None
**Verification:** Manual (paste the apex URL into Slack, iMessage, WhatsApp, Signal, and Twitter; confirm the unfurl renders the preview card)
**Status:** Implemented
