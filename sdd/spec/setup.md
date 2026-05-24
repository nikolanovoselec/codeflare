# Setup

First-time setup wizard, deployment modes, custom domain configuration, and post-setup reconfiguration.

**Domain owner:** Worker (src/routes/setup/), Cloudflare API integration

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Setup Wizard | A multi-step provisioning endpoint that creates all required Cloudflare resources (R2 credentials, DNS, Access apps, Turnstile) from a single API call |
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

<!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-001 describe -> publicly accessible when setup:complete unset + only CLOUDFLARE_API_TOKEN required + token from env not body + R2/DNS/Access app resources created + status shape -> AC1..AC5) -->
### REQ-SETUP-001: First-time setup requires zero pre-configuration

<!-- @impl: src/routes/setup/index.ts -->
<!-- @impl: src/routes/setup/handlers.ts -->

**Intent:** A freshly deployed Codeflare instance must be configurable through the setup wizard without any prior manual setup of authentication, DNS, or storage.

**Applies To:** Admin

**Acceptance Criteria:**

1. Before setup completes, the setup-configure endpoint is publicly accessible (no authentication required).
2. The deployer needs only a Cloudflare API token configured as a Worker secret; no other pre-configuration is required.
3. The Cloudflare API token is read from a Worker environment binding, not from the request body.
4. The setup wizard provisions all necessary Cloudflare resources (R2 credentials, DNS records, Access applications, Turnstile widgets) from scratch.
5. The setup-status endpoint is always public and returns the configured flag, optional custom domain, and SaaS mode flag.

**Constraints:**

- The pre-setup public window is intentionally open (AD10) to solve the bootstrap problem: authentication cannot be required before it is configured.
- Rate limiting and a short exposure window mitigate the open-endpoint risk.

**Priority:** P0

**Dependencies:** None.

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-002 describe -> Zod validation 400 sync + NDJSON Content-Type + per-step progress + setup: KV prefix + single done:true terminal -> AC1..AC5) -->
### REQ-SETUP-002: Setup wizard configures domain, auth, R2 credentials, and Turnstile

<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @impl: src/routes/setup/account.ts -->
<!-- @impl: src/routes/setup/credentials.ts -->
<!-- @impl: src/routes/setup/custom-domain.ts -->
<!-- @impl: src/routes/setup/access.ts -->
<!-- @impl: src/routes/setup/turnstile.ts -->
<!-- @impl: src/routes/setup/secrets.ts -->
<!-- @impl: src/routes/setup/shared.ts::withSetupRetry -->

**Intent:** A single `POST /api/setup/configure` call provisions all required Cloudflare resources and stores the resulting configuration in Workers KV.

**Applies To:** Admin

**Acceptance Criteria:**

1. The request body includes the custom domain, the user allowlist, the admin allowlist (subset of users), and an optional origin allowlist.
2. All fields are validated synchronously before streaming starts; invalid input is rejected with a 400 error.
3. Setup executes 7 sequential steps and streams per-step progress; the per-step contract for each step and its observable effect lives in [REQ-SETUP-012](#req-setup-012-setup-wizard-step-sequence).
4. All persistent state written by setup lives under a dedicated setup namespace.
5. The response stream ends with exactly one terminal completion object.

**Constraints:**

- Each Cloudflare API call uses exponential backoff (3 total attempts, 1s base delay).
- Circuit-breaker open errors are not retried.

**Priority:** P0

**Dependencies:** [REQ-SETUP-001](#req-setup-001-first-time-setup-requires-zero-pre-configuration)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-012 describe -> get_account + derive_r2_credentials + set_secrets PUT R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY + cleanup_stale_users + configure_custom_domain CNAME+route + create_access_app + finalize setup:complete -> AC1..AC7) -->
### REQ-SETUP-012: Setup wizard step sequence

<!-- @impl: src/routes/setup/handlers.ts -->

**Intent:** The setup wizard's 7-step pipeline must run in a fixed order, each step has a stable identifier the NDJSON stream emits, and the per-step observable effect is enforced as a separate contract so a regression in one step does not silently break the next.

**Applies To:** Admin

**Acceptance Criteria:**

1. Step 1 retrieves the Cloudflare account ID from the API token.
2. Step 2 derives R2-compatible credentials deterministically from the API token.
3. Step 3 stores the R2 access credentials as Worker secrets.
4. On reconfigure, stale users removed from the allowlist are cleaned up before continuing.
5. Step 4 configures the custom domain by upserting the DNS record and Worker route.
6. Step 5 upserts the CF Access application, groups, and policies; this step is skipped entirely in SaaS mode.
7. Step 6 provisions a Turnstile widget when onboarding or SaaS mode is active; Step 7 writes final state and marks setup complete.

**Constraints:**

- Step ordering is fixed; steps may not be reordered without a spec change because downstream steps assume their predecessors' writes.

**Priority:** P0

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/onboarding.test.ts (isSaasModeActive describe + deployment mode helpers describe -> SAAS_MODE=active case-insensitive + undefined defaults to CF Access + independence from ONBOARDING_LANDING_PAGE -> AC1..AC4) -->
### REQ-SETUP-003: Three deployment modes

<!-- @impl: src/lib/onboarding.ts -->
<!-- @impl: src/lib/access.ts -->

**Intent:** Codeflare supports three deployment modes that determine authentication strategy and user provisioning.

**Applies To:** Admin

**Acceptance Criteria:**

1. Default mode uses Cloudflare Access authentication with manually allowlisted users via the setup wizard, gated by CF Access policies and a persistent allowlist.
2. Onboarding mode uses CF Access authentication with a public waitlist landing page for unauthenticated visitors; authenticated users are routed into the application.
3. SaaS mode replaces the CF Access interstitial with a branded login page; when GitHub OAuth is configured it uses session credentials for authentication, auto-provisions new users with a pending tier, and manages user state without CF Access groups or policies.
4. Deployment mode is determined at deploy time via Worker bindings (not at runtime from request data).
5. The frontend detects the active mode on load and renders the appropriate initial view: branded login for SaaS, setup wizard if unconfigured, or workspace redirect for default mode.

**Constraints:**

- Stress-test mode must not be active alongside SaaS mode (returns 503).
- SaaS mode without GitHub OAuth configured falls back to CF Access authentication.

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-two-authentication-modes)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 describe -> same token deterministic R2 creds + retry from step 1 with partial KV + setup:complete NOT written on failure + 10020 route-already-exists handled + 10215 secret write auto-deploy retry -> AC1..AC5) -->
### REQ-SETUP-004: Setup is idempotent

<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain -->
<!-- @test: src/__tests__/setup-ac-coverage.test.ts (REQ-SETUP-004 describe -> idempotent setup semantics) + src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-004 describe -> AC1/AC2/AC3/AC4/AC5 create-or-update + retry-resume + Already-Exists handling + latest-version-not-yet-deployed redeploy) -->

**Intent:** Re-running the setup wizard with the same or updated inputs must safely update existing resources without creating duplicates or leaving orphaned state.

**Applies To:** User

**Acceptance Criteria:**

1. Every step uses create-or-update semantics: reads are non-mutating, derived values are deterministic from the token, secrets overwrite, DNS/route/Access/Turnstile provisioning is upsert-shaped.
2. If a previous run partially completed, a retry updates existing resources and continues from the first step.
3. Partial progress from failed runs is retained so the next call can resume. Setup is not marked complete on failure.
4. "Already exists" errors on Worker routes and DNS records are handled by updating the existing resource rather than failing.
5. The "latest version not yet deployed" error class on secret writes triggers an automatic redeploy of the latest Worker version followed by a retry.

**Constraints:**

- A persistent lock prevents concurrent configure runs and is released on completion or failure; staleness has an upper bound.
- The lock check returns an immediate error (with no step progress) if another configure run is already active and not yet stale.

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SETUP-005: Post-setup reconfiguration requires admin auth

<!-- @impl: src/routes/setup/index.ts -->
<!-- @impl: src/lib/access.ts::authenticateRequest -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers describe → post-setup admin gate + GET status public → AC1-AC5) -->

**Intent:** After initial setup is complete, only authenticated administrators can reconfigure the deployment.

**Applies To:** Admin

**Acceptance Criteria:**

1. Once setup is marked complete, the setup-route auth middleware requires valid authentication for all configure/detect/prefill endpoints.
2. The authenticated principal must have the admin role.
3. The admin gate applies to the configure endpoint, the token-detection endpoint, and the prefill endpoint.
4. The setup-status endpoint remains always public and never returns secrets.
5. Authentication accepts either Cloudflare Access tokens or Worker-issued session credentials, verified through the shared auth middleware.

**Constraints:**

- Admin role is resolved from the application's user record store, not from CF Access group membership, so the gate behaves identically across deployment modes.
- In SaaS mode the Worker enforces admin status itself; CF Access is not consulted.

**Priority:** P1

**Dependencies:** [REQ-SETUP-001](#req-setup-001-first-time-setup-requires-zero-pre-configuration), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SETUP-006: Setup streams progress via NDJSON

<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers describe → NDJSON stream shape + per-step status → AC1-AC5) -->

**Intent:** The setup configure endpoint must stream real-time progress as NDJSON so the client can display step-by-step status updates while the setup runs.

**Applies To:** User

**Acceptance Criteria:**

1. The response uses NDJSON as its content type.
2. Each line is a self-contained JSON object terminated by a newline.
3. Progress messages identify the step and report one of: running, succeeded, or failed.
4. Failure messages include a human-readable error description.
5. Every stream ends with exactly one terminal completion object that carries the overall success flag.

**Constraints:**

- The stream is not retryable mid-progress; on failure the client must re-submit the full request.
- The exact terminal-completion payload shape and edge-case behavior is specified in [REQ-SETUP-011](#req-setup-011-setup-stream-completion-payload-contract).

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SETUP-011: Setup stream completion payload contract

<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers describe → done:true payload + lock-contention path → AC1-AC4) -->

**Intent:** The terminal `done: true` object in the NDJSON stream must carry enough information for the client to render the final outcome and chain into post-setup flows (success URL display, lock-contention retry guidance, error surfacing).

**Applies To:** User

**Acceptance Criteria:**

1. Successful completion carries the cumulative per-step status list, the workers.dev URL, and the custom-domain URL.
2. Failed completion carries the cumulative per-step status list plus a top-level error description.
3. Lock contention produces an immediate terminal completion with success=false and no intervening step progress messages.
4. Clients detect completion by parsing stream entries until the terminal completion marker, then read the success flag.

**Constraints:**

- The per-step status list in the completion object is cumulative across all attempted steps.

**Priority:** P1

**Dependencies:** [REQ-SETUP-006](#req-setup-006-setup-streams-progress-via-ndjson)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 describe -> ccTLD zone suffix walk + proxied CNAME + Worker route pattern + 10020 update path + lowercased KV write + cors-cache TTL + workersDevUrl/customDomainUrl in summary -> AC1..AC7) -->
### REQ-SETUP-007: Custom domain with DNS validation

<!-- @impl: src/routes/setup/custom-domain.ts::handleConfigureCustomDomain -->
<!-- @impl: src/lib/cors-cache.ts -->
<!-- @test: src/__tests__/setup-007-custom-domain-ac.test.ts (REQ-SETUP-007 describe -> AC1/AC2/AC3/AC4/AC5/AC7 zone resolution + CNAME + Worker route + Already-Exists + normalized persistence + workers.dev fallback) + src/__tests__/lib/cors-cache.test.ts (cors-cache describe -> AC6 dynamic-origin cache TTL) -->

**Intent:** The setup wizard must configure a custom domain with proper DNS records and Worker routes, supporting nested subdomains and ccTLDs.

**Applies To:** Admin

**Acceptance Criteria:**

1. Zone resolution walks progressively shorter suffixes of the requested hostname so multi-label TLDs are handled correctly.
2. A proxied CNAME record is created or updated, pointing the custom domain at the Worker's default workers.dev hostname.
3. A Worker route covering the custom domain is created and mapped to the deployed Worker script.
4. "Already exists" errors on Worker routes are handled by updating the existing route rather than failing.
5. The custom domain is persisted in normalized (lowercased) form so origin comparisons are deterministic.
6. Dynamic origins (the custom domain plus any additional origins configured via setup) are cached in-memory for a short TTL; the persistent store is the source of truth.
7. After setup completes, the workers.dev hostname is treated as an initialization-only fallback; production traffic flows through the custom domain.

**Constraints:**

- The custom-domain zone must be managed by Cloudflare for DNS provisioning to succeed.
- The CNAME record is Cloudflare-proxied so the origin address is not exposed.

**Priority:** P1

**Dependencies:** [REQ-SETUP-002](#req-setup-002-setup-wizard-configures-domain-auth-r2-credentials-and-turnstile)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SETUP-008: Setup helper endpoints support prefill and detection

<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @impl: src/routes/setup/index.ts -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers describe → prefill + detect-token + shared setupRateLimiter → AC1-AC4) -->

**Intent:** The setup UI must be able to pre-populate fields from existing configuration and detect the API token's capabilities.

**Applies To:** Admin

**Acceptance Criteria:**

1. The prefill endpoint reads existing CF Access group membership and persistent configuration so the setup form repopulates correctly on redeployment.
2. The token-detection endpoint validates the API token and returns its capabilities (account info, permissions).
3. Both helper endpoints share the same rate limiter as the configure endpoint, so they cannot bypass setup-route throttling.
4. Both endpoints require admin auth after setup is complete, using the same conditional gate as the configure endpoint.

**Constraints:**

- Prefill is read-only: it never writes to the Cloudflare API or persistent state.
- Token detection is a read-only validation and never provisions resources.

**Priority:** P1

**Dependencies:** [REQ-SETUP-005](#req-setup-005-post-setup-reconfiguration-requires-admin-auth)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SETUP-009 AC coverage describe -> all 5 tiers visible + three-phase navigation + Turnstile init + Standard/Pro mode toggle + free tier no-Stripe direct subscribe + paid tier Start Trial CTA -> AC1..AC6) -->
### REQ-SETUP-009: Subscribe page with tier selection

<!-- @impl: web-ui/src/components/SubscribePage.tsx -->
<!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (SubscribePage / REQ-SETUP-009 describe + AC coverage block -> AC1/AC2/AC3/AC4/AC5/AC6 tier listing + three-phase wizard + CAPTCHA + mode toggle + free-immediate + paid-handoff) -->

**Intent:** Users can choose their subscription tier with a clear comparison of features and pricing.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe page shows the available tiers with their features, included hours, session limits, storage, and pricing.
2. The flow is a three-phase wizard: overview, plan selection, and checkout.
3. New subscriptions are gated by a CAPTCHA challenge.
4. The page exposes a mode toggle between the two subscription mode families.
5. The free tier activates immediately without an external checkout step.
6. Paid tiers hand off to the external payment provider's hosted checkout.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SETUP-010: Social-share preview metadata on the public landing page

<!-- @impl: web-ui/index.html -->
<!-- @test: web-ui/src/__tests__/setup-010-og-metadata.test.ts (REQ-SETUP-010 describe -> AC1 Open Graph required tags + AC2 Twitter Card + AC3 1200x630 PNG + AC4 description/og:description sync + AC5 brand-voice tagline) -->

<!-- @impl: web-ui/src/components/OnboardingLanding.tsx -->
<!-- @impl: web-ui/index.html -->

**Intent:** When the public-facing URL is shared on social platforms or chat apps, the unfurl renders a branded preview card with the product tagline and a 1200x630 preview image so the link communicates what Codeflare is before the visitor clicks.

**Applies To:** User

**Acceptance Criteria:**

1. The home page exposes Open Graph metadata: `og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`, `og:image:width=1200`, `og:image:height=630`, `og:image:alt`, `og:locale`.
2. Twitter Card metadata is set with `twitter:card="summary_large_image"` plus title, description, image, and image:alt.
3. The preview image is a 1200x630 PNG that includes the Codeflare wordmark, the product tagline, and a CODEFLARE.CH wordmark footer.
4. The `<meta name="description">` matches the `og:description` so search-engine snippets and social-share cards stay in sync.
5. The tagline copy in `og:description` and the meta description follows the brand voice ("Ideas don't care where you are. Neither does your new ephemeral IDE.") and is the canonical external description of the product.

**Constraints:**

- The preview image must remain <=1MB so platforms cache it inline.
- og:image dimensions are 1200x630 (the dual standard for Open Graph and Twitter `summary_large_image` cards).

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented
